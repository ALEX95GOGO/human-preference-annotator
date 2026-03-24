// const API_BASE = "http://localhost:3000/api";
// const API_BASE = "https://human-preference-api.onrender.com/api";
const API_BASE = "https://human-preference-annotator.onrender.com/api";

const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get("token");

if (!token) {
    document.body.innerHTML = "<h2>Invalid or missing token. Access denied.</h2>";
    throw new Error("Missing token");
}

localStorage.setItem("token", token);

const ATTN_TIMEOUT = 10000; // 10s
const PAUSE_SAMPLE_MS = 500;

function logout() {
    localStorage.removeItem("token");
    window.location.href = window.location.pathname;
}

let currentPair = null;
let annotatorId = "";
let presentedTime = null;
let requireRegion = false;
let awaitingRegion = false;
let pendingChoice = null;
let decisionAtMs = null;
let regionTimeoutId = null;

// Pause-sampling lifecycle
let psAbort = null;
let psActive = false;

// 3-step annotation state
const STEPS = { PREF: 0, SURPRISE: 1, ATTENTION: 2 };
const STEP_LABELS = ["Preference", "Surprise", "Attention"];
let step = STEPS.PREF;
let staged = null;

function cancelPauseSampling() {
    try {
        psAbort?.abort();
    } catch (_) {}

    psAbort = null;
    psActive = false;
    awaitingRegion = false;

    document.getElementById("multiOverlay")?.remove();
    document.getElementById("pointOverlay")?.remove();
}

function ensureTopStepperEl() {
    let el = document.getElementById("stepper");
    if (!el) {
        const host = document.getElementById("topbar-center");
        el = document.createElement("div");
        el.id = "stepper";
        el.style.marginTop = "6px";
        host?.appendChild(el);
    }
    return el;
}

function updateTopStepper(activeStepIdx = 0) {
    const el = ensureTopStepperEl();
    if (!el) return;

    const steps = STEP_LABELS.map((label, idx) => {
        const status = idx < activeStepIdx ? "done" : idx === activeStepIdx ? "active" : "todo";
        const circleBg =
            status === "done" ? "#2ecc71" : status === "active" ? "#2980b9" : "#d0d7de";
        const circleColor = status === "todo" ? "#555" : "#fff";
        const border = status === "todo" ? "1px solid #9aa4ae" : "1px solid transparent";
        const connectorColor = idx < activeStepIdx ? "#2ecc71" : "#d0d7de";

        return `
      <div style="position:relative; display:flex; align-items:center; flex:1;">
        <div style="
          width:22px;height:22px;border-radius:999px;
          background:${circleBg}; color:${circleColor};
          display:flex;align-items:center;justify-content:center;
          font:600 12px system-ui; border:${border};
          box-shadow:${status !== "todo" ? "0 0 0 2px rgba(0,0,0,0.06) inset" : "none"};
        ">${idx + 1}</div>
        <div style="margin-left:8px; min-width:88px; font:600 12px system-ui; color:#111;">
          ${label}
        </div>
        ${
            idx < STEP_LABELS.length - 1
                ? `<div style="flex:1;height:2px;background:${connectorColor};margin:0 14px 0 0;border-radius:2px;"></div>`
                : ``
        }
      </div>
    `;
    }).join("");

    el.innerHTML = `
    <div style="display:flex;align-items:center;gap:0; padding:6px 8px;">
      ${steps}
    </div>
  `;
}

function resetStepperForPair() {
    step = STEPS.PREF;
    staged = {
        preference: null,
        decisionAtMs: null,
        surpriseChoice: null,
        surprise: { left: null, right: null }, // keep shape for backend compatibility
        attention: null,
        startedAt: Date.now(),
        stepT0: Date.now(),
        stepDurations: {},
    };

    renderStepUI();
    updateTopStepper(0);
}

function markStepAdvance(nextStep) {
    const now = Date.now();
    staged.stepDurations[step] = (staged.stepDurations[step] || 0) + (now - (staged.stepT0 || now));
    step = nextStep;
    staged.stepT0 = now;
    renderStepUI();
    updateTopStepper(nextStep);
}

function renderStepUI() {
    const notes = document.getElementById("notes");
    const buttons = document.getElementById("buttons");
    const chosen = staged?.preference;

    notes.innerHTML =
        step === STEPS.PREF
            ? `<p id="instructions">Choose the text you prefer (ArrowLeft = Left, ArrowRight = Right, ArrowDown = Can't tell).</p>`
            : step === STEPS.SURPRISE
            ? `<p id="instructions">Rate how <em>surprising</em> the chosen answer felt (1 = not at all, 5 = very). Hotkeys: 1–5, Enter = Next.</p>`
            : `<p id="instructions">Replay in pause-sampling on the <b>${
                  chosen === "left" ? "Left" : "Right"
              }</b> clip. Add <em>multiple</em> points at each stop, then press Space/Enter to continue.</p>`;

    if (step === STEPS.PREF) {
        buttons.innerHTML = `
      <button onclick="handleChoice('left')">Prefer Left</button>
      <button onclick="handleChoice('right')">Prefer Right</button>
      <button onclick="handleChoice('cant_tell')">Can't Tell</button>
    `;
    } else if (step === STEPS.SURPRISE) {
        buttons.innerHTML = `
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        <div>
          <div style="font-weight:600;margin-bottom:4px">Chosen answer</div>
          ${[1, 2, 3, 4, 5]
              .map((v) => `<button data-side="left" data-val="${v}" class="surBtn">${v}</button>`)
              .join(" ")}
          <span id="leftSurVal" style="margin-left:8px; margin-right:18px;">
            ${staged.surprise.left ?? "—"}
          </span>
        </div>

        <div><button id="surpriseNext" disabled>Next</button></div>
      </div>
    `;

        const nextBtn = buttons.querySelector("#surpriseNext");

        const refreshNext = () => {
            nextBtn.disabled = !staged.surprise.left;
        };

        buttons.querySelectorAll(".surBtn").forEach((b) => {
            b.addEventListener("click", () => {
                const val = Number(b.dataset.val);
                staged.surprise.left = val;

                const leftVal = document.getElementById("leftSurVal");
                if (leftVal) leftVal.textContent = val;

                refreshNext();
            });
        });

        nextBtn.addEventListener("click", () => {
            if (!staged.surprise.left) return;
            staged.surpriseChoice = "left";
            markStepAdvance(STEPS.ATTENTION);
        });

        refreshNext();
    } else if (step === STEPS.ATTENTION) {
        const side = staged?.preference;
        const label = side === "left" ? "Left" : "Right";

        buttons.innerHTML = `
      <button id="startPS">Start pause-sampling on ${label}</button>
      <button id="skipPS">Skip (no attention)</button>
    `;

        document.getElementById("startPS").addEventListener("click", () => {
            document.getElementById("startPS").disabled = true;
            document.getElementById("skipPS").disabled = true;

            startPauseSampling(side, (attention) => {
                staged.attention = attention;
                submitStagedAnnotation();
            });
        });

        document.getElementById("skipPS").addEventListener("click", () => {
            staged.attention = null;
            submitStagedAnnotation();
        });
    }
}

function updateProgress(video, bar) {
    if (!video || !bar || !video.duration) return;

    const percentage = (video.currentTime / video.duration) * 100;
    bar.style.width = `${percentage}%`;

    const vidProgressElm = document.getElementById("videoStatus");
    if (vidProgressElm && percentage > 85) {
        vidProgressElm.innerText = "Video Replaying...";
    } else if (vidProgressElm) {
        vidProgressElm.innerText = "\u00A0";
    }
}

function attachProgress(videoId, barId) {
    const video = document.getElementById(videoId);
    const bar = document.getElementById(barId);
    if (!video || !bar) return;
    video.addEventListener("timeupdate", () => updateProgress(video, bar));
}

function showStartOverlay(onStart) {
    let overlay = document.getElementById("startOverlay");

    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "startOverlay";
        overlay.style =
            "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);z-index:9999;cursor:pointer;";
        overlay.innerHTML =
            '<div style="padding:12px 16px;background:#fff;border-radius:8px;font:600 14px system-ui;">Click or press Space to start playback</div>';
        document.body.appendChild(overlay);
    }

    const start = () => {
        overlay.removeEventListener("click", start);
        window.removeEventListener("keydown", onKey);
        overlay.remove();
        onStart();
    };

    const onKey = (e) => {
        if (e.key === " " || e.code === "Space" || e.key === "Spacebar") {
            e.preventDefault();
            start();
        }
    };

    overlay.addEventListener("click", start, { once: true });
    window.addEventListener("keydown", onKey, { once: true });
}

function renderPair(pair) {
    currentPair = pair;
    annotatorId = pair.progress?.annotatorId || "anonymous";
    requireRegion = !!pair._meta?.requireRegion;

    const annotatorEl = document.getElementById("annotatorIdDisplay");
    if (annotatorEl) annotatorEl.innerText = `Annotator ID: ${annotatorId}`;

    const descriptionEl = document.getElementById("description");
    if (descriptionEl) {
        descriptionEl.innerText =
            `Task: ${pair.description}` +
            (pair._meta?.isGold ? "  (GOLD)" : "") +
            (pair._meta?.isRepeat ? "  (REPEAT)" : "");
    }

    const progressEl = document.getElementById("progress");
    if (progressEl && pair.progress) {
        progressEl.innerText = `Progress: ${pair.progress.completed}/${pair.progress.total} pairs`;
    }

    const leftTextEl = document.getElementById("leftText");
    const rightTextEl = document.getElementById("rightText");
    if (leftTextEl) leftTextEl.textContent = pair.left_text || "—";
    if (rightTextEl) rightTextEl.textContent = pair.right_text || "—";

    const leftVideo = document.getElementById("leftVideo");
    const rightVideo = document.getElementById("rightVideo");

    if (!leftVideo || !rightVideo) {
        resetStepperForPair();
        return;
    }

    // keep right side visible if you want both placeholders on screen;
    // hide only the right video element itself if needed in CSS/HTML.
    const rightWrap = rightVideo.parentElement;
    if (rightWrap) rightWrap.style.display = "block";

    try {
        rightVideo.pause();
        rightVideo.removeAttribute("src");
        rightVideo.load();
    } catch (_) {}

    leftVideo.muted = true;
    leftVideo.setAttribute("muted", "");
    leftVideo.setAttribute("playsinline", "");
    leftVideo.autoplay = true;
    leftVideo.preload = "auto";

    rightVideo.muted = true;
    rightVideo.setAttribute("muted", "");
    rightVideo.setAttribute("playsinline", "");
    rightVideo.autoplay = true;
    rightVideo.preload = "auto";

    leftVideo.src = pair.left_clip;
    leftVideo.load();

    const tryAutoplay = async () => {
        try {
            await leftVideo.play();
            presentedTime = new Date();
        } catch (_) {
            showStartOverlay(async () => {
                await Promise.allSettled([leftVideo.play()]);
                presentedTime = new Date();
            });
        }
    };

    const maybeStart = () => {
        if (leftVideo.readyState >= 3) {
            tryAutoplay();
            leftVideo.removeEventListener("canplay", maybeStart);
        }
    };

    leftVideo.addEventListener("canplay", maybeStart);

    leftVideo.loop = true;
    leftVideo.controls = true;
    rightVideo.loop = true;
    rightVideo.controls = true;

    resetStepperForPair();
}

function getNormalisedCoords(evt, el) {
    const rect = el.getBoundingClientRect();
    const clientX = (evt.touches && evt.touches[0]?.clientX) ?? evt.clientX;
    const clientY = (evt.touches && evt.touches[0]?.clientY) ?? evt.clientY;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function showPointOverlay(side, onPick) {
    awaitingRegion = true;

    const video = document.getElementById(side === "left" ? "leftVideo" : "rightVideo");
    if (!video) {
        onPick(null);
        return;
    }

    const wrap = video.parentElement;
    wrap.style.position = wrap.style.position || "relative";

    const overlay = document.createElement("div");
    overlay.id = "pointOverlay";
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.cursor = "crosshair";
    overlay.style.zIndex = "10";
    overlay.style.background = "rgba(0,0,0,0.12)";
    overlay.style.backdropFilter = "blur(0px)";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Pick a point of attention");

    const marker = document.createElement("div");
    marker.style.position = "absolute";
    marker.style.width = "14px";
    marker.style.height = "14px";
    marker.style.transform = "translate(-50%, -50%)";
    marker.style.pointerEvents = "none";
    marker.style.borderRadius = "50%";
    marker.style.border = "2px solid #fff";
    marker.style.boxShadow = "0 1px 2px rgba(0,0,0,.6)";
    overlay.appendChild(marker);

    const hint = document.createElement("div");
    hint.textContent = "Click or tap to mark attention point (Esc to cancel)";
    hint.style.position = "absolute";
    hint.style.left = "50%";
    hint.style.bottom = "8px";
    hint.style.transform = "translateX(-50%)";
    hint.style.padding = "6px 10px";
    hint.style.background = "rgba(0,0,0,0.6)";
    hint.style.color = "#fff";
    hint.style.borderRadius = "6px";
    hint.style.font = "600 12px system-ui";
    overlay.appendChild(hint);

    const move = (evt) => {
        const { x, y } = getNormalisedCoords(evt, wrap);
        marker.style.left = `${x * 100}%`;
        marker.style.top = `${y * 100}%`;
    };

    const pick = (evt) => {
        evt.preventDefault();

        const ping = document.createElement("div");
        ping.style.position = "absolute";
        ping.style.left = marker.style.left;
        ping.style.top = marker.style.top;
        ping.style.width = "0px";
        ping.style.height = "0px";
        ping.style.border = "2px solid #fff";
        ping.style.borderRadius = "50%";
        ping.style.opacity = "0.9";
        ping.style.transform = "translate(-50%, -50%)";
        overlay.appendChild(ping);

        ping.animate(
            [
                { width: "0px", height: "0px", opacity: 0.9 },
                { width: "36px", height: "36px", opacity: 0.0 },
            ],
            { duration: 250, easing: "ease-out" }
        ).onfinish = () => ping.remove();

        cleanup();
        const { x, y } = getNormalisedCoords(evt, wrap);
        onPick({ x, y });
    };

    const cancel = () => {
        cleanup();
        onPick(null);
    };

    const onKey = (evt) => {
        if (evt.key === "Escape") {
            evt.preventDefault();
            cancel();
        }
    };

    overlay.addEventListener("mousemove", move);
    overlay.addEventListener("touchmove", move, { passive: true });
    overlay.addEventListener("click", pick);
    overlay.addEventListener(
        "touchstart",
        (evt) => {
            move(evt);
        },
        { passive: true }
    );
    overlay.addEventListener(
        "touchend",
        (evt) => {
            pick(evt.changedTouches?.[0] ?? evt);
        },
        { passive: false }
    );
    window.addEventListener("keydown", onKey);

    wrap.appendChild(overlay);

    if (regionTimeoutId) clearTimeout(regionTimeoutId);
    regionTimeoutId = setTimeout(() => {
        cancel();
    }, ATTN_TIMEOUT);

    function cleanup() {
        if (regionTimeoutId) {
            clearTimeout(regionTimeoutId);
            regionTimeoutId = null;
        }
        window.removeEventListener("keydown", onKey);
        overlay.remove();
        awaitingRegion = false;
    }
}

function showMultiPointCollector(side, onDone) {
    awaitingRegion = true;

    const video = document.getElementById(side === "left" ? "leftVideo" : "rightVideo");
    if (!video) {
        onDone([]);
        return;
    }

    const wrap = video.parentElement;
    wrap.style.position = wrap.style.position || "relative";

    document.getElementById("multiOverlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "multiOverlay";
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.cursor = "crosshair";
    overlay.style.zIndex = "10";
    overlay.style.background = "rgba(0,0,0,0.10)";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Mark multiple points of interest");

    const bar = document.createElement("div");
    bar.style.position = "absolute";
    bar.style.left = "50%";
    bar.style.bottom = "8px";
    bar.style.transform = "translateX(-50%)";
    bar.style.padding = "6px 10px";
    bar.style.background = "rgba(0,0,0,0.65)";
    bar.style.color = "#fff";
    bar.style.borderRadius = "6px";
    bar.style.font = "600 12px system-ui";
    bar.textContent = "Click to add points | Z=Undo | C=Clear | Space/Enter=Next";
    overlay.appendChild(bar);

    const points = [];
    const markers = [];

    const addMarker = (x, y) => {
        const m = document.createElement("div");
        m.style.position = "absolute";
        m.style.left = `${x * 100}%`;
        m.style.top = `${y * 100}%`;
        m.style.transform = "translate(-50%, -50%)";
        m.style.width = "12px";
        m.style.height = "12px";
        m.style.borderRadius = "50%";
        m.style.border = "2px solid #fff";
        m.style.boxShadow = "0 1px 2px rgba(0,0,0,.6)";
        m.style.pointerEvents = "none";
        overlay.appendChild(m);
        markers.push(m);
    };

    const click = (evt) => {
        const { x, y } = getNormalisedCoords(evt, wrap);
        points.push({ x, y });
        addMarker(x, y);
    };

    const undo = () => {
        points.pop();
        const m = markers.pop();
        if (m) m.remove();
    };

    const clearAll = () => {
        points.length = 0;
        while (markers.length) markers.pop().remove();
    };

    const finish = () => {
        cleanup();
        onDone(points.slice());
    };

    const onKey = (e) => {
        if (e.key === "z" || e.key === "Z") {
            e.preventDefault();
            undo();
        } else if (e.key === "c" || e.key === "C") {
            e.preventDefault();
            clearAll();
        } else if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            finish();
        } else if (e.key === "Escape") {
            e.preventDefault();
            finish();
        }
    };

    overlay.addEventListener("click", click);
    window.addEventListener("keydown", onKey);
    wrap.appendChild(overlay);

    function cleanup() {
        window.removeEventListener("keydown", onKey);
        overlay.remove();
        awaitingRegion = false;
    }
}

function startPauseSampling(side, onDone) {
    const chosenVideo = document.getElementById(side === "left" ? "leftVideo" : "rightVideo");
    const otherVideo = document.getElementById(side === "left" ? "rightVideo" : "leftVideo");

    if (!chosenVideo || !otherVideo) {
        onDone(null);
        return;
    }

    cancelPauseSampling();
    psAbort = new AbortController();
    const { signal } = psAbort;
    psActive = true;

    otherVideo.pause();
    chosenVideo.loop = false;
    chosenVideo.controls = false;
    chosenVideo.currentTime = 0;
    chosenVideo.muted = true;

    const stepMs = Math.max(
        200,
        Number(new URLSearchParams(location.search).get("ps") || PAUSE_SAMPLE_MS)
    );
    const durMs = () => Math.floor((chosenVideo.duration || 0) * 1000);
    const breaks = [];

    for (let t = stepMs; t < durMs() + 50; t += stepMs) {
        breaks.push(t);
    }

    const samples = [];
    let idx = 0;
    let armed = true;

    const ensurePlaying = async () => {
        try {
            await chosenVideo.play();
        } catch (_) {}
    };

    const finish = () => {
        if (!psActive) return;
        psActive = false;

        const attention = {
            type: "pause-sampling",
            side,
            coordSpace: "normalised",
            samples,
            decisionAtMs: staged?.decisionAtMs ?? null,
        };

        cancelPauseSampling();
        onDone(attention);
    };

    const pauseAndCollect = (tsMs) => {
        if (!psActive || signal.aborted) return;

        chosenVideo.pause();
        showMultiPointCollector(side, (points) => {
            if (signal.aborted) return;

            samples.push({ tsMs, points: points || [] });
            idx += 1;

            if (idx >= breaks.length) {
                if (chosenVideo.ended || chosenVideo.duration - chosenVideo.currentTime < 0.05) {
                    finish();
                } else {
                    armed = false;
                    ensurePlaying();
                }
            } else {
                armed = true;
                ensurePlaying();
            }
        });
    };

    const onTime = () => {
        if (!psActive || signal.aborted || !armed || idx >= breaks.length) return;

        const nowMs = Math.floor(chosenVideo.currentTime * 1000);
        const target = breaks[idx];

        if (nowMs >= target) {
            armed = false;
            pauseAndCollect(target);
        }
    };

    chosenVideo.addEventListener("timeupdate", onTime, { signal });
    chosenVideo.addEventListener(
        "ended",
        () => {
            if (!signal.aborted) finish();
        },
        { signal }
    );

    ensurePlaying();
}

function handleChoice(response) {
    const leftVideo = document.getElementById("leftVideo");
    const rightVideo = document.getElementById("rightVideo");
    const chosenVideo = response === "left" ? leftVideo : response === "right" ? rightVideo : null;

    pendingChoice = response;
    decisionAtMs = chosenVideo ? Math.round(chosenVideo.currentTime * 1000) : null;

    if (!staged) resetStepperForPair();

    staged.preference = response;
    staged.decisionAtMs = decisionAtMs;

    if (response === "cant_tell") {
        staged.surprise = { left: null, right: null };
        staged.attention = null;
        submitStagedAnnotation();
        return;
    }

    markStepAdvance(STEPS.SURPRISE);
}

async function loadNextPair() {
    cancelPauseSampling();
    document.getElementById("multiOverlay")?.remove();
    document.getElementById("pointOverlay")?.remove();

    const res = await fetch(`${API_BASE}/clip-pairs?token=${token}`);

    if (!res.ok) {
        if (res.status === 403) {
            document.getElementById("app").innerHTML =
                "<h2>Invalid token. Please check your link or contact the administrator.</h2>";
        } else {
            document.getElementById("app").innerHTML =
                "<h2>Server error. Please try again later.</h2>";
        }
        return;
    }

    const data = await res.json();

    if (!data) {
        document.getElementById("app").innerHTML = "<h2>All annotations complete. Thank you!</h2>";
        return;
    }

    renderPair(data);
}

window.onload = () => {
    loadNextPair();
    attachProgress("leftVideo", "leftProgress");
};

async function submitStagedAnnotation() {
    cancelPauseSampling();

    if (staged) {
        const now = Date.now();
        staged.stepDurations[step] =
            (staged.stepDurations[step] || 0) + (now - (staged.stepT0 || now));
    }

    const response = staged.preference;
    const attention = staged.attention;
    const surprise = staged.surprise;
    const stageDurations = staged.stepDurations;

    const nowDate = new Date();
    const responseTimeMs = presentedTime ? nowDate - presentedTime : undefined;

    await fetch(`${API_BASE}/annotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            token,
            pairId: currentPair.pair_id,
            response,
            surpriseChoice: staged.surpriseChoice,
            left: { url: currentPair.left_clip, surprise: surprise?.left ?? null },
            right: { url: currentPair.right_clip, surprise: surprise?.right ?? null },
            presentedTime,
            responseTimeMs,
            isGold: currentPair._meta?.isGold || false,
            isRepeat: currentPair._meta?.isRepeat || false,
            repeatOf: currentPair._meta?.repeatOf,
            attention,
            stageDurations,
        }),
    });

    loadNextPair();
}

(function setupKeyboardShortcuts() {
    const isTextInput = (el) =>
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

    window.addEventListener(
        "keydown",
        (e) => {
            if (e.repeat) return;
            if (isTextInput(document.activeElement) || e.isComposing) return;
            if (awaitingRegion) return;

            if (step === undefined || step === STEPS.PREF) {
                if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    handleChoice("left");
                } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    handleChoice("right");
                } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    handleChoice("cant_tell");
                }
            } else if (step === STEPS.SURPRISE) {
                const oneMap = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 };

                if (oneMap[e.key] != null) {
                    staged.surprise.left = oneMap[e.key];
                    const s = document.getElementById("leftSurVal");
                    if (s) s.textContent = staged.surprise.left;
                }

                const nextBtn = document.getElementById("surpriseNext");
                const canNext = !!staged.surprise.left;
                if (nextBtn) nextBtn.disabled = !canNext;

                if (e.key === "Enter" && canNext) {
                    e.preventDefault();
                    staged.surpriseChoice = "left";
                    markStepAdvance(STEPS.ATTENTION);
                }
            } else if (step === STEPS.ATTENTION) {
                if (e.key === "x" || e.key === "X") {
                    e.preventDefault();
                    const btn = document.getElementById("startPS");
                    if (btn) btn.click();
                } else if (e.key === "Enter") {
                    const skip = document.getElementById("skipPS");
                    if (skip) {
                        e.preventDefault();
                        skip.click();
                    }
                }
            }
        },
        { passive: false }
    );
})();

# Human Preference Annotator

A lightweight web-based tool for collecting human preference labels on driving behavior. Annotators are shown two short video clips of driving scenarios side by side and asked to choose which one they prefer or indicate if they can't tell.

<p align="center">
  <img src="assets/images/annotate_ui.png">
</p>

Designed for crowdsourced studies or in-lab annotation, with static frontend + serverless-ready backend architecture.

[Test Link](https://jkli-2.github.io/human-preference-annotator/?token=ffb981fe)

[Admin Dashboard](https://jkli-2.github.io/human-preference-annotator/admin/)

---

## Features

- Side-by-side video comparison interface with 3-button annotation UI (left / right / can't tell)
- Configurable video pair list via JSON
- Stores results in MongoDB (or as flat files)
- Local development with optional transition to S3/CDN

---

## Local Setup

```bash
git clone https://github.com/jkli-2/human-preference-annotator.git
cd human-preference-annotator

# Install backend dependencies
cd backend
npm install
# Edit .env with your MongoDB URI

# Start MongoDB daemon
sudo systemctl start mongod

# Start backend server
npm run dev

# To generate token for an annotator, change dir to backend and run
node generate_token.js

# To delete all records, change dir to backend and run
node flush_db.js

# Open frontend (use live-server or VS Code extension, or Python http.server)
cd ../frontend
python3 -m http.server 8000

# To export annotation to JSON, visit
localhost:3000/api/expxort
```

---

## TODO

- play-pause control
- S3 backend
- Driving Clips upload pipeline / API

---

## Note on Driving Clips formatting

- For now, for each video, prepend `videos/` so the backend can find the clips. You can run `scripts/pair_rename.py` to automate this.
- The clip pair JSON file should be named as `backend/data/clip_pairs.json`.
- Future pipeline should include ffmpeg transcode functionality. But for now, to ensure the video playback functions in most browser, after every upload, run the `scripts/vid_conv.sh` (remember to modify the content and the path inside).
- You can remove old clips in the `frontend/videos` except for gold pairs.

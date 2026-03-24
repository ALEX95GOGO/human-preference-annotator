import json
import re
from pathlib import Path


def normalize_video_stem(stem: str) -> str:
    """
    Convert:
      000000_n008-2018-09-18-13-10-39-0400__CAM_FRONT__1537291010612404_prev10
    into:
      n008-2018-09-18-13-10-39-0400__CAM_FRONT__1537291010612404
    """
    stem = re.sub(r"^\d+_", "", stem)      # remove leading numeric prefix
    stem = re.sub(r"_prev\d+$", "", stem)  # remove trailing _prev10 / _prevXX
    return stem


def build_pairs_from_mp4_folder(
    folder="",
    annotation_json="annotations.json",
    output_json="pairs.json",
    clip_prefix="",
    description="clips",
):
    folder_path = Path(folder)
    mp4_files = sorted(folder_path.glob("*.mp4"))

    with open(annotation_json, "r", encoding="utf-8") as f:
        annotations = json.load(f)

    # image stem -> annotation row
    ann_by_stem = {}
    for row in annotations:
        image_path = row.get("image", "")
        image_stem = Path(image_path).stem
        ann_by_stem[image_stem] = row

    pairs = []
    missing = []

    for i, mp4 in enumerate(mp4_files, start=1):
        normalized_stem = normalize_video_stem(mp4.stem)

        if clip_prefix:
            clip_path = f"{clip_prefix.rstrip('/')}/{mp4.name}"
        else:
            clip_path = mp4.name

        ann = ann_by_stem.get(normalized_stem)

        if ann is None:
            missing.append((mp4.name, normalized_stem))
            left_text = ""
            right_text = ""
        else:
            left_text = ann.get("output_1", {}).get("value", "")
            right_text = ann.get("output_2", {}).get("value", "")

            pairs.append(
                {
                    "pair_id": f"{i:06d}",
                    "left_clip": clip_path,
                    "right_clip": clip_path,
                    "left_text": left_text,
                    "right_text": right_text,
                    "description": description,
                }
            )
        with open(output_json, "w", encoding="utf-8") as f:
                json.dump(pairs, f, indent=2, ensure_ascii=False)

        print(f"Saved {len(pairs)} entries to {output_json}")
        print(f"Matched {len(pairs) - len(missing)} / {len(pairs)} files")

    if missing:
        print(f"\nWarning: {len(missing)} mp4 files had no annotation match:")
        for filename, normalized in missing[:20]:
            print(f"  - {filename}  -> normalized as: {normalized}")
        if len(missing) > 20:
            print(f"  ... and {len(missing) - 20} more")


if __name__ == "__main__":
    build_pairs_from_mp4_folder(
        folder="../frontend/videos/front_cam_batch1",
        annotation_json="test.json",
        output_json="pairs.json",
        clip_prefix="videos/front_cam_batch1",
        description="clips",
    )

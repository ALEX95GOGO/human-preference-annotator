import json
from pathlib import Path


def build_pairs_from_mp4_folder(
    folder = '',
    output_json = "pairs.json",
    clip_prefix = '',
    description = "clips",
):
    """
    Build a JSON list where left_clip and right_clip are the same file.

    Parameters
    ----------
    folder : str
        Folder containing .mp4 files.
    output_json : str
        Output JSON filename.
    clip_prefix : str | None
        Optional prefix to prepend in JSON paths, e.g. "videos/early_late_mi_training".
        If None, only the filename is used.
    description : str
        Description field value.
    """
    folder_path = Path(folder)
    mp4_files = sorted(folder_path.glob("*.mp4"))

    pairs = []
    for i, mp4 in enumerate(mp4_files, start=1):
        if clip_prefix:
            clip_path = f"{clip_prefix.rstrip('/')}/{mp4.name}"
        else:
            clip_path = mp4.name

        pairs.append(
            {
                "pair_id": f"{i:06d}",
                "left_clip": clip_path,
                "right_clip": clip_path,
                "description": description,
            }
        )

    with open(output_json, "w", encoding="utf-8") as f:
        json.dump(pairs, f, indent=2)

    print(f"Saved {len(pairs)} entries to {output_json}")


if __name__ == "__main__":
    build_pairs_from_mp4_folder(
        folder="../frontend/videos/front_cam_batch1",
        output_json="pairs.json",
        clip_prefix="videos/front_cam_batch1",
        description="clips",
    )

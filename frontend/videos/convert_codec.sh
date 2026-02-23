SRC="front_cam_video"
DST="front_cam_web"

find "$SRC" -name "*.mp4" -type f | while read -r f; do
  rel="${f#$SRC/}"              # relative path
  out="$DST/$rel"               # output path

  mkdir -p "$(dirname "$out")"

  ffmpeg -i "$f" \
    -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.1 \
    -c:a aac -b:a 128k -movflags +faststart \
    "$out"
done


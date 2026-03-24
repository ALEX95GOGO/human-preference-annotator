SRC="front_cam_batch1"
DST="front_cam_web"

find "$SRC" -type f -name '*.mp4' -exec sh -c '
for f do
  rel="${f#"$0"/}"
  out="$1/$rel"

  mkdir -p "$(dirname "$out")"

  echo "Processing: [$f]"

  ffmpeg -i "$f" \
    -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.1 \
    -c:a aac -b:a 128k -movflags +faststart \
    "$out"
done
' "$SRC" "$DST" {} +


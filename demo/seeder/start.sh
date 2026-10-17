#!/bin/sh
# Generates a random demo file, creates a torrent for it, publishes the magnet link and
# SHA-256 to /seed/out, then runs a tracker and seeds the file forever.
set -eu

SIZE_MB="${DEMO_SIZE_MB:-64}"
NAME="${DEMO_NAME:-demo-file.bin}"
TRACKER="http://seeder:8000/announce"
DATA=/seed/data
OUT=/seed/out
mkdir -p "$DATA" "$OUT"

if [ ! -f "$DATA/$NAME" ]; then
  echo "Generating ${SIZE_MB} MB of random data"
  head -c "$((SIZE_MB * 1024 * 1024))" /dev/urandom > "$DATA/$NAME"
fi

rm -f "$OUT/demo.torrent"
mktorrent -a "$TRACKER" -n "$NAME" -o "$OUT/demo.torrent" "$DATA/$NAME" >/dev/null
sha256sum "$DATA/$NAME" | cut -d' ' -f1 > "$OUT/demo.sha256"
aria2c -S "$OUT/demo.torrent" | sed -n 's/^Magnet URI: //p' > "$OUT/demo.magnet"
echo "Magnet: $(cat "$OUT/demo.magnet")"

bittorrent-tracker --http --port 8000 --quiet &

exec aria2c --dir="$DATA" --check-integrity=true --seed-ratio=0.0 \
  --enable-dht=false --bt-enable-lpd=false --enable-peer-exchange=false \
  --listen-port=6881 --summary-interval=0 --console-log-level=warn \
  "$OUT/demo.torrent"

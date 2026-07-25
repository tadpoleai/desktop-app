#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="hera-panorama-stitch:local"

echo "=== Building $IMAGE ==="
docker build -f "$SCRIPT_DIR/Dockerfile" -t "$IMAGE" "$SCRIPT_DIR"
echo ""
echo "=== docker run --rm $IMAGE --describe ==="
docker run --rm "$IMAGE" --describe | python3 -m json.tool
echo ""
echo "NOTE: this operator uploads via OSS to the hera_insta_stitch Aliyun FC GPU"
echo "service — no local GPU needed, but OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET/"
echo "OSS_BUCKET/OSS_ENDPOINT must be set in the environment. Test with:"
echo "  docker run --rm -e OSS_ACCESS_KEY_ID -e OSS_ACCESS_KEY_SECRET -e OSS_BUCKET -e OSS_ENDPOINT \\"
echo "      -v \$PWD/rec.insv:/data/input.insv:ro -v \$PWD/out:/output $IMAGE \\"
echo "      hera_stitch_remote.py /data/input.insv /output/panorama.mp4 --verbose"

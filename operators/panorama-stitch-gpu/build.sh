#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="hera-panorama-stitch-gpu:local"

echo "=== Building $IMAGE ==="
docker build -f "$SCRIPT_DIR/Dockerfile" -t "$IMAGE" "$SCRIPT_DIR"
echo ""
echo "=== docker run --rm $IMAGE --describe ==="
docker run --rm "$IMAGE" --describe | python3 -m json.tool
echo ""
echo "NOTE: this image needs an NVIDIA GPU + nvidia-container-toolkit + Settings"
echo "'GPU 支持' enabled to actually stitch. Test with:"
echo "  docker run --rm --gpus all -v \$PWD/rec.insv:/data/input.insv:ro -v \$PWD/out:/output $IMAGE \\"
echo "      MediaSDKTest -inputs /data/input.insv -output /output/panorama.mp4 \\"
echo "          -model_root_dir /usr/models -stitch_type optflow -output_size 3840x1920"

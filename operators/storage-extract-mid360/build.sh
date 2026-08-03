#!/usr/bin/env bash
# Stages the prebuilt hera-storage-extract-mid360 binary + its shared libs from
# the recorder repo's build output, then builds the self-describing wrapper image.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RECORDER_BUILD_DIR="${RECORDER_BUILD_DIR:-/home/fred/Code/recorder/build_amd64}"
IMAGE="hera-storage-extract-mid360:local"

mkdir -p "$SCRIPT_DIR/bin"
cp "$RECORDER_BUILD_DIR/storage/hera-storage-extract-mid360" "$SCRIPT_DIR/bin/"
cp "$RECORDER_BUILD_DIR/storage/libhera-storage.so" "$SCRIPT_DIR/bin/"
cp "$RECORDER_BUILD_DIR/device/libhera-device.so" "$SCRIPT_DIR/bin/"
cp "$RECORDER_BUILD_DIR/common/libhera-common.so" "$SCRIPT_DIR/bin/"

echo "=== Building $IMAGE ==="
docker build -f "$SCRIPT_DIR/Dockerfile" -t "$IMAGE" "$SCRIPT_DIR"

echo ""
echo "=== docker run --rm $IMAGE --describe ==="
docker run --rm "$IMAGE" --describe | python3 -m json.tool

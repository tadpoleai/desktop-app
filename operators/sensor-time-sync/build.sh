#!/usr/bin/env bash
# Stages the prebuilt multi_source_synchronizer binary + its hera shared libs,
# then builds the self-describing wrapper image.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYNC_BUILD_DIR="${SYNC_BUILD_DIR:-/home/fred/Code/multi_source_synchronizer/build}"
HERA_LIB_DIR="${HERA_LIB_DIR:-/home/fred/hera_local_install/lib}"
IMAGE="hera-sensor-time-sync:local"

mkdir -p "$SCRIPT_DIR/bin"
cp "$SYNC_BUILD_DIR/multi_source_synchronizer" "$SCRIPT_DIR/bin/"
cp "$HERA_LIB_DIR/libhera-common.so" "$SCRIPT_DIR/bin/"
cp "$HERA_LIB_DIR/libhera-device.so" "$SCRIPT_DIR/bin/"
cp "$HERA_LIB_DIR/libhera-storage.so" "$SCRIPT_DIR/bin/"

echo "=== Building $IMAGE ==="
docker build -f "$SCRIPT_DIR/Dockerfile" -t "$IMAGE" "$SCRIPT_DIR"

echo ""
echo "=== docker run --rm $IMAGE --describe ==="
docker run --rm "$IMAGE" --describe | python3 -m json.tool

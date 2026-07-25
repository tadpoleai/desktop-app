# hera-panorama-stitch-gpu operator image
#
# Runs MediaSDKTest directly against a .insv recording on a local NVIDIA GPU
# — no network, no OSS, no FC service. Same underlying stitch as the
# panorama-stitch (remote FC) operator, just executed on-machine. Requires
# an NVIDIA CUDA GPU + nvidia-container-toolkit; there is no CPU fallback.
#
# Built on top of hera-sdk-python's tools/fc-gpu image, which already
# bundles MediaSDKTest, the MediaSDK runtime, CUDA, and the stitching
# models — this just swaps its HTTP-server entrypoint for the self-describe
# CLI contract Hera operators use. Rebuild that base image (see
# hera-sdk-python/tools/fc-gpu/Dockerfile) when the MediaSDK version changes
# upstream.
#
# ── Build ──────────────────────────────────────────────────────────────────
#   ./build.sh
#
# ── Run (needs nvidia-container-toolkit) ────────────────────────────────────
#   docker run --rm --gpus all \
#       -v $PWD/rec.insv:/data/input.insv:ro -v $PWD/out:/output \
#       hera-panorama-stitch-gpu:local \
#       MediaSDKTest -inputs /data/input.insv -output /output/panorama.mp4 \
#           -model_root_dir /usr/models -stitch_type optflow -output_size 3840x1920

ARG BASE_IMAGE=crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/hera-insta-stitch-fc:v0.1.2
FROM ${BASE_IMAGE}

LABEL org.hera.operator.spec="1"
LABEL org.hera.operator.id="panorama-stitch-gpu"
LABEL org.hera.operator.version="0.1"
LABEL org.hera.operator.manifest.path="/operator.json"

# nvidia-container-toolkit only exposes the "compute,utility" driver capability
# set by default — without "video" too, libnvcuvid.so.1 / libnvidia-encode.so.1
# (NVDEC/NVENC) never get mounted into the container, MediaSDK silently falls
# back to a software codec path, and that fallback deadlocks (observed: process
# sits at 0% GPU util holding driver memory indefinitely, blocked in
# futex_wait_queue_me). Baking this into the image (read by the toolkit at
# container-create time, same mechanism nvidia/cuda's own images use) fixes it
# for every `docker run --gpus all`, including the ones hera-desktop's runner
# issues, without needing extra flags at run time.
ENV NVIDIA_DRIVER_CAPABILITIES=all

COPY operator_self_describe.json /operator.json
COPY entrypoint.sh /hera_entrypoint.sh
RUN chmod +x /hera_entrypoint.sh

ENTRYPOINT ["/hera_entrypoint.sh"]

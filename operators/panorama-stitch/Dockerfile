# hera-panorama-stitch operator image
#
# Thin OSS-mediated client for the hera_insta_stitch Aliyun FC GPU
# function's /stitch-insv-oss route (see
# hera-sdk-python/tools/fc-gpu/server.py) — no local GPU, CUDA, or MediaSDK
# needed. Hera captures write raw dual-fisheye video straight to a sibling
# .insv file (same directory, same basename as the .hera session); this
# operator uploads that .insv to OSS (FC's direct HTTP trigger caps request
# bodies at 32MB, far below real recordings), asks the FC function to pull
# it from OSS and stitch on a cloud GPU instance, then downloads the
# resulting panorama video from OSS.
#
# Requires OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET /
# OSS_ENDPOINT in the container environment at run time — passed through
# from the host process environment by the runner (runner/src/dag.rs),
# never baked into this image or any committed file.
#
# ── Build ──────────────────────────────────────────────────────────────────
#   ./build.sh
#
# ── Run ────────────────────────────────────────────────────────────────────
#   docker run --rm \
#       -e OSS_ACCESS_KEY_ID -e OSS_ACCESS_KEY_SECRET -e OSS_BUCKET -e OSS_ENDPOINT \
#       -v $PWD/rec.insv:/data/input.insv:ro -v $PWD/out:/output \
#       hera-panorama-stitch:local \
#       hera_stitch_remote.py /data/input.insv /output/panorama.mp4 --stitch-type optflow --verbose

FROM python:3.11-alpine

LABEL org.hera.operator.spec="1"
LABEL org.hera.operator.id="panorama-stitch"
LABEL org.hera.operator.version="0.1"
LABEL org.hera.operator.manifest.path="/operator.json"

RUN pip install --no-cache-dir oss2 requests

COPY hera_stitch_remote.py /usr/local/bin/hera_stitch_remote.py
RUN chmod +x /usr/local/bin/hera_stitch_remote.py

COPY operator_self_describe.json /operator.json
COPY entrypoint.sh /hera_entrypoint.sh
RUN chmod +x /hera_entrypoint.sh

ENTRYPOINT ["/hera_entrypoint.sh"]

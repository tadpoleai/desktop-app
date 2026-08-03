# hera-frame-extract operator image
#
# Grabs a single still frame from a stitched panorama.mp4 (output of
# panorama-stitch-gpu) via ffmpeg. Needed because the panorama camera produces
# video, but CalibrationView's left panel (TASK3_激光全景标定工具.md §4) needs
# a single ERP image to select points on. For a static session (flowstate=false,
# camera didn't move) any frame works, hence the default timestamp of 0s.
#
# ── Build ──────────────────────────────────────────────────────────────────
#   ./build.sh

FROM ubuntu:jammy

LABEL org.hera.operator.spec="1"
LABEL org.hera.operator.id="frame-extract"
LABEL org.hera.operator.version="0.1"
LABEL org.hera.operator.manifest.path="/operator.json"

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY operator_self_describe.json /operator.json
COPY entrypoint.sh /hera_entrypoint.sh
RUN chmod +x /hera_entrypoint.sh

ENTRYPOINT ["/hera_entrypoint.sh"]

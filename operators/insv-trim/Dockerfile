# hera-insv-trim operator image
#
# Losslessly trims a .insv (dual-fisheye video) by time range via ffmpeg stream
# copy (-c copy, no re-encode) — lets the calibration panorama pipeline stitch
# only a time window instead of the whole (potentially multi-minute) capture.
#
# Verified locally: ffmpeg reads/copies .insv's 3 streams (2x HEVC fisheye +
# AAC audio) correctly and fast (~95x realtime for a 3s clip). NOT verified:
# whether Insta360's MediaSDKTest (the actual stitcher, GPU-only, can't run on
# this dev machine) tolerates a re-muxed/trimmed file — if stitched output from
# a trimmed input looks wrong, that's why; fall back to a full (untrimmed) run.
#
# ── Build ──────────────────────────────────────────────────────────────────
#   ./build.sh

FROM ubuntu:jammy

LABEL org.hera.operator.spec="1"
LABEL org.hera.operator.id="insv-trim"
LABEL org.hera.operator.version="0.1"
LABEL org.hera.operator.manifest.path="/operator.json"

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY operator_self_describe.json /operator.json
COPY entrypoint.sh /hera_entrypoint.sh
RUN chmod +x /hera_entrypoint.sh

ENTRYPOINT ["/hera_entrypoint.sh"]

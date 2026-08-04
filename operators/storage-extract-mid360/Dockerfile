# hera-storage-extract-mid360 operator image
#
# Wraps the host-built `hera-storage-extract-mid360` binary (from the recorder
# repo's storage/ build target) for the "静止场景跳过 GLIM" branch of the
# laser-panorama calibration tool (TASK3_激光全景标定工具.md §2): exports the
# raw Mid-360 point cloud straight from a .hera session, no reconstruction.
#
# Stopgap: recorder/ doesn't publish a versioned image for this tool yet, so
# build.sh stages a *host-local* amd64 build into bin/ before this Dockerfile
# runs — not portable to another machine/CI until recorder ships a real build.
# See TASK3_激光全景标定工具.md §9 Q2.
#
# ── Build ──────────────────────────────────────────────────────────────────
#   ./build.sh

FROM ubuntu:jammy

LABEL org.hera.operator.spec="1"
LABEL org.hera.operator.id="storage-extract-mid360"
LABEL org.hera.operator.version="0.1"
LABEL org.hera.operator.manifest.path="/operator.json"

RUN apt-get update && apt-get install -y --no-install-recommends libturbojpeg \
    && rm -rf /var/lib/apt/lists/*

COPY bin/hera-storage-extract-mid360 /usr/local/bin/hera-storage-extract-mid360
COPY bin/libhera-storage.so /usr/local/lib/libhera-storage.so
COPY bin/libhera-device.so /usr/local/lib/libhera-device.so
COPY bin/libhera-common.so /usr/local/lib/libhera-common.so
RUN chmod +x /usr/local/bin/hera-storage-extract-mid360 && ldconfig

COPY operator_self_describe.json /operator.json
COPY entrypoint.sh /hera_entrypoint.sh
RUN chmod +x /hera_entrypoint.sh

ENTRYPOINT ["/hera_entrypoint.sh"]

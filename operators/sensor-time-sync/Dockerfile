# hera-sensor-time-sync operator image
#
# Wraps the host-built `multi_source_synchronizer` binary (from the sibling
# multi_source_synchronizer repo): estimates the clock offset between the
# Mid-360 LiDAR/IMU and the Insta360 camera/gyro inside one merged .hera
# session file, via IMU gyro cross-correlation. Output: offset_sec such that
# t_mid = t_insta + offset_sec (see that repo's README.md/PIPELINE.md for the
# full derivation and the required 60s "sync calibration motion" at recording
# start).
#
# Stopgap: multi_source_synchronizer doesn't publish a versioned image yet, so
# build.sh stages a *host-local* amd64 build into bin/ before this Dockerfile
# runs — same pattern as ../storage-extract-mid360.
#
# ── Build ──────────────────────────────────────────────────────────────────
#   ./build.sh

FROM ubuntu:jammy

LABEL org.hera.operator.spec="1"
LABEL org.hera.operator.id="sensor-time-sync"
LABEL org.hera.operator.version="0.1"
LABEL org.hera.operator.manifest.path="/operator.json"

RUN apt-get update && apt-get install -y --no-install-recommends libgflags2.2 libturbojpeg \
    && rm -rf /var/lib/apt/lists/*

COPY bin/multi_source_synchronizer /usr/local/bin/multi_source_synchronizer
COPY bin/libhera-common.so /usr/local/lib/libhera-common.so
COPY bin/libhera-device.so /usr/local/lib/libhera-device.so
COPY bin/libhera-storage.so /usr/local/lib/libhera-storage.so
RUN chmod +x /usr/local/bin/multi_source_synchronizer && ldconfig

COPY operator_self_describe.json /operator.json
COPY entrypoint.sh /hera_entrypoint.sh
RUN chmod +x /hera_entrypoint.sh

ENTRYPOINT ["/hera_entrypoint.sh"]

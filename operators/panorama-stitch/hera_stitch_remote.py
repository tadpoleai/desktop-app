#!/usr/bin/env python3
"""
Thin client for the hera_insta_stitch Aliyun FC GPU function's
/stitch-insv-oss route (see hera-sdk-python/tools/fc-gpu/server.py).

Desktop machines running this operator don't need a local NVIDIA GPU, and
the recording never needs to fit in a single HTTP request body — FC's
direct HTTP trigger caps payloads at 32MB, far below real .insv recordings
(several hundred MB to a few GB) — so this script uploads the .insv
straight to OSS, asks the FC function to pull it from there and stitch, and
downloads the result from OSS.

Usage: hera_stitch_remote.py <input.insv> <output.mp4> [OPTIONS]
  --stitch-type  optflow|template|dynamicstitch|aistitch
  --output-size  WxH
  --flowstate
  --h265
  --colorplus
  --denoise
  --deflicker
  --defringe
  --verbose

Requires OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET / OSS_ENDPOINT
in the environment — never read from a config file or CLI flag, so
credentials never end up in job logs or provenance records.
"""
import argparse
import json
import os
import sys
import time
import uuid

import oss2
import requests

FC_URL = os.environ.get("HERA_STITCH_FC_URL", "https://hera-intitch-fc-uqjbgmbswr.cn-shanghai.fcapp.run")


def env_or_die(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        sys.exit(f"Missing required environment variable: {name}")
    return val


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--stitch-type", default=None)
    ap.add_argument("--output-size", default=None)
    ap.add_argument("--flowstate", action="store_true")
    ap.add_argument("--h265", action="store_true")
    ap.add_argument("--colorplus", action="store_true")
    ap.add_argument("--denoise", action="store_true")
    ap.add_argument("--deflicker", action="store_true")
    ap.add_argument("--defringe", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        sys.exit(f"Input not found: {args.input}")

    ak = env_or_die("OSS_ACCESS_KEY_ID")
    sk = env_or_die("OSS_ACCESS_KEY_SECRET")
    bucket_name = env_or_die("OSS_BUCKET")
    endpoint = env_or_die("OSS_ENDPOINT")

    auth = oss2.Auth(ak, sk)
    bucket = oss2.Bucket(auth, endpoint, bucket_name)

    key = f"hera-desktop/{uuid.uuid4().hex}/{os.path.basename(args.input)}"

    if args.verbose:
        size_mb = os.path.getsize(args.input) / 1e6
        print(f"Uploading {args.input} ({size_mb:.1f} MB) -> oss://{bucket_name}/{key}", file=sys.stderr)
    t0 = time.monotonic()
    bucket.put_object_from_file(key, args.input)
    if args.verbose:
        print(f"  uploaded in {time.monotonic() - t0:.1f}s", file=sys.stderr)

    payload = {"input_bucket": bucket_name, "input_key": key}
    if args.stitch_type:
        payload["stitch_type"] = args.stitch_type
    if args.output_size:
        payload["output_size"] = args.output_size
    for flag in ("flowstate", "h265", "colorplus", "denoise", "deflicker", "defringe", "verbose"):
        if getattr(args, flag):
            payload[flag] = True

    if args.verbose:
        print(f"POST {FC_URL}/stitch-insv-oss  {json.dumps(payload)}", file=sys.stderr)

    t0 = time.monotonic()
    try:
        # Server-side internal timeout is 1800s (HERA_STITCH_TIMEOUT_SEC); give
        # the whole round trip (download + stitch + upload on the FC side)
        # generous headroom past that.
        resp = requests.post(f"{FC_URL}/stitch-insv-oss", json=payload, timeout=3600)
    except requests.RequestException as e:
        sys.exit(f"Request to FC stitch service failed: {e}")

    if resp.status_code != 200:
        sys.exit(f"FC stitch failed (HTTP {resp.status_code}):\n{resp.text}")
    body = resp.json()
    if args.verbose:
        print(f"  stitched in {time.monotonic() - t0:.1f}s -> {body}", file=sys.stderr)

    out_bucket_name = body["output_bucket"]
    out_key = body["output_key"]

    out_dir = os.path.dirname(os.path.abspath(args.output))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    out_bucket = bucket if out_bucket_name == bucket_name else oss2.Bucket(auth, endpoint, out_bucket_name)
    t0 = time.monotonic()
    out_bucket.get_object_to_file(out_key, args.output)
    if args.verbose:
        print(f"  downloaded in {time.monotonic() - t0:.1f}s", file=sys.stderr)

    print(f"Saved panorama: {args.output} ({os.path.getsize(args.output)} bytes)")

    # Best-effort cleanup of the uploaded input — the output stays in OSS
    # (the caller may want it), only the transient upload is scratch space.
    try:
        bucket.delete_object(key)
    except Exception:
        pass


if __name__ == "__main__":
    main()

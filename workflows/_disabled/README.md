Workflows here are intentionally hidden from the Run page — `list_workflows`
only scans `workflows/` directly (non-recursive), so a subdirectory like this
one is invisible to it without any extra filtering logic.

- `panorama_stitch.json` — the Aliyun FC/OSS cloud-compute variant of 全景拼接
  (`operators/panorama-stitch`, still present and functional). Hidden
  2026-07-25 per product decision: default 全景拼接 should use local compute
  only (GPU required, no CPU fallback — see `../panorama_stitch_gpu.json` and
  `operators/panorama-stitch-gpu`). Re-enable the cloud path once user auth
  and a payment/billing system exist to gate the Aliyun compute cost — move
  this file back up to `workflows/` when that's ready.

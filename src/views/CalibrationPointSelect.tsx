import React from "react";
import { api, Artifact, CalibPointPair, Extrinsic, FrameGroup, JobEvent, Pose, RangeImageResult, SolveResult, TrajectoryInfo } from "../api";
import { toast } from "../components/toast";
import { PickCanvas, PickMarker } from "../components/PickCanvas";
import { SphereViewer } from "../components/SphereViewer";

interface Props {
  sessionPath: string;
  panoramaFramePath: string | null;
  /** Already-stitched panorama.mp4 — when present (motion sessions), lets the
   *  left panel re-extract a frame at the current timeline position instead of
   *  staying fixed at the one frame grabbed when stitching finished. Each
   *  re-extract is a container job (~1-3s, ffmpeg seek on the existing video,
   *  no re-stitch), so this is debounced and only ever one in flight. */
  stitchedVideoPath: string | null;
  /** `.session.json`'s `record_start_host_ns` — fallback anchor to convert the
   *  timeline's trajectory-clock `currentTimeSec` into `frame-extract`'s
   *  video-relative `timestamp_s` (`videoTimeSec = currentTimeSec -
   *  recordStartHostNs/1e9`) when `syncOffsetSec` isn't available. Only
   *  accurate to ~1-2s (button-press moment, not either device's actual first
   *  sample, and ignores inter-device clock skew) — superseded by the
   *  syncOffsetSec-based formula below whenever that's present. */
  recordStartHostNs: number | null;
  /** `multi_source_synchronizer`'s measured Mid360<->Insta360 clock offset
   *  (see CalibrationView's "传感器时间同步检测" card; `t_mid = t_insta +
   *  syncOffsetSec`). Combined with `firstMid360HostNs` (loaded below from
   *  rawPointcloudPath) for a precise video-time conversion:
   *  `videoTimeSec = currentTimeSec - firstMid360HostNs/1e9 - syncOffsetSec`.
   *  Derivation: multi_source_synchronizer zeroes its Mid360 axis at that
   *  device's own first IMU sample using `timestamp_device_ns`, not
   *  `timestamp_host_ns` — but assuming negligible clock-rate drift within one
   *  recording, elapsed device-ns and elapsed host-ns agree (the device<->host
   *  fixed offset cancels out in the subtraction), so `firstMid360HostNs`
   *  (host-clock domain, same as `traj_lidar.txt`'s `t`) is a valid substitute
   *  for the tool's actual zero point. Empirically checked against a real
   *  session (0803): traj_lidar.txt's first t and the raw CSV's first
   *  timestamp_host_ns are in the same epoch, ~0.9s apart (plausible GLIM
   *  warm-up lag) — consistent with this model, not independently proven
   *  beyond that one spot check. */
  syncOffsetSec: number | null;
  pointcloudPath: string;
  /** GLIM map directory (`<...>/step_recon/map`, contains per-submap
   *  `<id>/data.txt` + `<id>/points_compact.bin`) — lets the right panel load
   *  only the submaps whose own frame timestamps overlap the current timeline
   *  window, instead of reprojecting the whole session's aggregated
   *  `pointcloudPath` map. Null for static sessions (no GLIM map) or if the
   *  map artifact wasn't found. */
  mapDirPath: string | null;
  /** Raw, per-point-timestamped `storage-extract-mid360 --points` CSV — only
   *  present when GLIM also ran (see CalibrationView.startPipeline). Lets the
   *  right panel switch away from GLIM's whole-session aggregated map (which
   *  reads as cluttered/noisy for any one moment) to a genuine single-instant
   *  slice. Denoising the GLIM map itself is explicitly out of scope. */
  rawPointcloudPath: string | null;
  /** §7: "static" = point cloud is already LiDAR-frame, no trajectory. "motion"
   *  = point cloud is GLIM-world-frame, needs a per-pick pose from `trajectoryPath`. */
  motionState: "static" | "motion";
  /** `<map_dir>/traj_lidar.txt` for motion sessions; null for static (no trajectory)
   *  or if the map artifact couldn't be located. */
  trajectoryPath: string | null;
  onBack: () => void;
}

type PointcloudSource = "glim" | "raw";

function rangeSourceLabel(source: RangeImageResult["source"]): string {
  switch (source) {
    case "raw_time_window": return "原始时间窗";
    case "glim_submaps": return "GLIM 时间窗子图";
    case "glim_whole_map_fallback": return "GLIM 整图（降级）";
    case "glim_whole_map": return "GLIM 整图";
    default: return "点云";
  }
}

interface PointPair {
  seq: number;
  left?: { u: number; v: number };
  right?: { u: number; v: number; x: number; y: number; z: number };
  /** Set once, at whichever side creates this pair — §7: fixed to 0 (session
   *  start) for static, the timeline position (ns) it was picked at for motion. */
  frameTimestampNs: number;
}

// Elevation is auto-fit server-side to the point cloud's actual range (a real
// LiDAR's vertical FOV is much narrower than ±90°, e.g. Mid-360 is roughly
// -7..52deg) — these are just the resolution to render that fitted band at,
// not the angular span itself.
const AZ_BINS = 720;
const EL_BINS = 200;
// Live/follow-the-timeline overlay redraws use a coarse subsample for
// responsiveness — the explicit "生成叠加预览" button always uses full
// resolution (subsample=1) since that's the one gating "保存".
const LIVE_OVERLAY_SUBSAMPLE = 20;
const ZERO_EXTRINSIC: Extrinsic = { tx: 0, ty: 0, tz: 0, roll_deg: 0, pitch_deg: 0, yaw_deg: 0 };
// Mid-360 is a non-repetitive-scan LiDAR — coverage fills in over time, not a
// single sweep, so a short window is inherently sparse. Empirically checked
// against a real session: 0.2s only yields ~40k points against the depth
// image's 720x200=144k bins (well under half, even with perfect angular
// distribution — Mid-360's actual short-window coverage is less uniform than
// that); 0.8s yields ~160k, already past the bin count. Trades a bit of
// instantaneous accuracy (more scene motion can occur within the window) for
// a depth image that isn't mostly empty.
// Two Mid-360 sweeps are usually enough for a selectable image while keeping
// vehicle/body motion smear far below the previous 0.8 s default. Operators
// can still widen it for a sparse/low-reflectivity scene.
const DEFAULT_WINDOW_SEC = 0.2;

function extrinsicEqual(a: Extrinsic, b: Extrinsic): boolean {
  return a.tx === b.tx && a.ty === b.ty && a.tz === b.tz && a.roll_deg === b.roll_deg && a.pitch_deg === b.pitch_deg && a.yaw_deg === b.yaw_deg;
}

export function CalibrationPointSelect({ sessionPath, panoramaFramePath, stitchedVideoPath, recordStartHostNs, syncOffsetSec, pointcloudPath, mapDirPath, rawPointcloudPath, motionState, trajectoryPath, onBack }: Props) {
  const [panoramaUrl, setPanoramaUrl] = React.useState<string | null>(null);
  // Host path of whichever frame panoramaUrl is currently showing — starts at
  // the original (fixed, t=0) stitch job's frame, updated by
  // reextractLeftFrame whenever the timeline-follow re-extract lands a new
  // one. generateOverlay must composite onto *this*, not the original
  // panoramaFramePath prop — otherwise the overlay silently stays pinned to
  // frame 0 forever regardless of where the timeline is, even though the
  // left panel's own display correctly follows it (a real bug: the display
  // and the overlay were reading two different frames).
  const [currentPanoramaFramePath, setCurrentPanoramaFramePath] = React.useState<string | null>(panoramaFramePath);
  const [panoramaError, setPanoramaError] = React.useState<string | null>(null);
  const [followingTimeline, setFollowingTimeline] = React.useState(false);
  const [panoSize, setPanoSize] = React.useState<{ width: number; height: number } | null>(null);
  const [rangeImage, setRangeImage] = React.useState<RangeImageResult | null>(null);
  const [rangeError, setRangeError] = React.useState<string | null>(null);
  const [invertElevation, setInvertElevation] = React.useState(false);
  const [pointcloudSource, setPointcloudSource] = React.useState<PointcloudSource>("glim");
  const [windowSec, setWindowSec] = React.useState(DEFAULT_WINDOW_SEC);
  const [rangeLoading, setRangeLoading] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  // Zero-anchor for the precise video-time conversion (see Props.syncOffsetSec
  // doc) — loaded once from the raw points CSV's first row, cheap (reads only
  // the first two lines regardless of file size).
  const [firstMid360HostNs, setFirstMid360HostNs] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!rawPointcloudPath || motionState !== "motion") { setFirstMid360HostNs(null); return; }
    let cancelled = false;
    api.firstTimestampHostNs(rawPointcloudPath)
      .then((ns) => { if (!cancelled) setFirstMid360HostNs(ns); })
      .catch(() => { if (!cancelled) setFirstMid360HostNs(null); });
    return () => { cancelled = true; };
  }, [rawPointcloudPath, motionState]);
  const [pairs, setPairs] = React.useState<PointPair[]>([]);

  const [trajectoryInfo, setTrajectoryInfo] = React.useState<TrajectoryInfo | null>(null);
  const [trajectoryError, setTrajectoryError] = React.useState<string | null>(null);
  const [currentTimeSec, setCurrentTimeSec] = React.useState(0);
  const [currentPose, setCurrentPose] = React.useState<Pose | null>(null);

  const [extrinsic, setExtrinsic] = React.useState<Extrinsic>(ZERO_EXTRINSIC);
  const [solveResult, setSolveResult] = React.useState<SolveResult | null>(null);
  const [solving, setSolving] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [overlayUrl, setOverlayUrl] = React.useState<string | null>(null);
  const [previewedExtrinsic, setPreviewedExtrinsic] = React.useState<Extrinsic | null>(null);
  // §7 aside: the panorama frame is fixed (captured once, at ~trajectory t_min),
  // so overlaying a point cloud sliced at a *different* trajectory time is
  // technically "wrong" for that frame — but that's exactly the tool for finding
  // the LiDAR<->camera clock offset by eye: drag until the overlay lines up best,
  // that offset IS the two sensors' time delta. So "生成叠加预览" always uses
  // whatever the timeline currently points to, and re-preview is required (this
  // tracks the timestamp it was generated at) if the user moves the slider after.
  const [previewedTimeSec, setPreviewedTimeSec] = React.useState<number | null>(null);
  const [saving, setSaving] = React.useState(false);

  const extrinsicPath = React.useMemo(() => {
    const m = sessionPath.match(/^(.*)\.hera$/i);
    const base = m ? m[1] : sessionPath;
    return `${base}.extrinsic.json`;
  }, [sessionPath]);

  // "glim" = the reconstructed map. Motion: prefer only the GLIM submaps whose
  // own frame timestamps overlap the timeline window (mapDirPath) over
  // reprojecting the *whole session's* aggregated map (pointcloudPath) into
  // LiDAR-frame-at-t — the latter mixes in points from other
  // viewpoints/times, which reads as cluttered/ghosted for a moving scene.
  // Falls back to the whole-map path if mapDirPath isn't available. Static:
  // no timeline, always uses the whole map (pose is null there anyway).
  // "raw" = un-reconstructed storage-extract-mid360 points, already LiDAR-frame
  // — static uses the whole file, motion windows it around `timeSec`.
  async function fetchRangeImage(invert: boolean, source: PointcloudSource, pose: Pose | null, timeSec: number, window: number): Promise<RangeImageResult> {
    if (source === "raw" && rawPointcloudPath) {
      if (motionState === "motion") {
        return api.buildRangeImageWindowed(rawPointcloudPath, timeSec, window, AZ_BINS, EL_BINS, invert);
      }
      return api.buildRangeImage(rawPointcloudPath, AZ_BINS, EL_BINS, invert, null);
    }
    if (motionState === "motion" && mapDirPath && pose) {
      try {
        return await api.buildRangeImageGlimWindowed(mapDirPath, timeSec, window, pose, AZ_BINS, EL_BINS, invert);
      } catch (e) {
        // Preserve the fallback for usability, but make it visible: a whole-map
        // render has very different time semantics and quality characteristics.
        const fallback = await api.buildRangeImage(pointcloudPath, AZ_BINS, EL_BINS, invert, pose);
        return { ...fallback, source: "glim_whole_map_fallback", source_detail: `GLIM 子图时间窗不可用：${String(e)}` };
      }
    }
    return api.buildRangeImage(pointcloudPath, AZ_BINS, EL_BINS, invert, pose);
  }

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const tasks: Promise<unknown>[] = [
      api.readTextFileOpt(extrinsicPath)
        .then((text) => {
          if (cancelled || !text) return;
          try {
            const j = JSON.parse(text);
            const t = j.translation_lidar_to_camera_m, r = j.rotation_lidar_to_camera_euler_xyz_deg;
            if (Array.isArray(t) && Array.isArray(r) && t.length === 3 && r.length === 3) {
              setExtrinsic({ tx: t[0], ty: t[1], tz: t[2], roll_deg: r[0], pitch_deg: r[1], yaw_deg: r[2] });
            }
          } catch { /* malformed/foreign json at that path — ignore, keep zero default */ }
        })
        .catch(() => {}),
    ];
    if (panoramaFramePath) {
      setCurrentPanoramaFramePath(panoramaFramePath);
      tasks.push(
        api.readFileBase64(panoramaFramePath)
          .then((b64) => { if (!cancelled) setPanoramaUrl(`data:image/jpeg;base64,${b64}`); })
          .catch((e) => { if (!cancelled) setPanoramaError(String(e)); })
      );
    }
    if (motionState === "motion" && trajectoryPath) {
      // Motion: hold off the first range-image build until we have the frame's
      // pose — building it unposed first (raw world-frame bins) would just be a
      // throwaway render the user immediately sees replaced.
      tasks.push(
        api.loadTrajectory(trajectoryPath)
          .then(async (info) => {
            if (cancelled) return;
            setTrajectoryInfo(info);
            setCurrentTimeSec(info.t_min);
            const pose = await api.interpolatePose(trajectoryPath, info.t_min);
            if (cancelled) return;
            setCurrentPose(pose);
            const r = await fetchRangeImage(invertElevation, pointcloudSource, pose, info.t_min, windowSec);
            if (!cancelled) setRangeImage(r);
          })
          .catch((e) => { if (!cancelled) setTrajectoryError(String(e)); })
      );
    } else {
      tasks.push(
        fetchRangeImage(invertElevation, pointcloudSource, null, 0, windowSec)
          .then((r) => { if (!cancelled) setRangeImage(r); })
          .catch((e) => { if (!cancelled) setRangeError(String(e)); })
      );
    }
    Promise.all(tasks).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panoramaFramePath, pointcloudPath, extrinsicPath, motionState, trajectoryPath]);

  // Grab the panorama's native pixel size (needed for ERP inverse-projection in
  // solve/overlay) — independent of PickCanvas's own internal image loading.
  React.useEffect(() => {
    if (!panoramaUrl) { setPanoSize(null); return; }
    const img = new Image();
    img.onload = () => setPanoSize({ width: img.naturalWidth, height: img.naturalHeight });
    img.src = panoramaUrl;
  }, [panoramaUrl]);

  async function refreshRangeImage(invert: boolean, source: PointcloudSource, framePose: Pose | null, window: number, timeSec: number) {
    setRangeLoading(true);
    setRangeError(null);
    try {
      const r = await fetchRangeImage(invert, source, framePose, timeSec, window);
      setRangeImage(r);
      // Existing right-side picks were placed against the old (now-stale) pixel
      // layout — their resolved x/y/z stay correct, but the marker would render
      // at the wrong spot on the new image, so clear them rather than leave a
      // confusing mismatch.
      setPairs((prev) => {
        const hadRight = prev.some((p) => p.right);
        if (hadRight) toast.error("深度图已重新生成，右图已选的点已清空，请重新选取");
        return prev.map((p) => ({ ...p, right: undefined })).filter((p) => p.left);
      });
    } catch (e) {
      toast.error(`重新生成深度图失败：${e}`);
    } finally {
      setRangeLoading(false);
    }
  }

  function toggleInvertElevation() {
    const next = !invertElevation;
    setInvertElevation(next);
    void refreshRangeImage(next, pointcloudSource, currentPose, windowSec, currentTimeSec);
  }

  function switchPointcloudSource(source: PointcloudSource) {
    if (source === pointcloudSource) return;
    setPointcloudSource(source);
    void refreshRangeImage(invertElevation, source, currentPose, windowSec, currentTimeSec);
  }

  // Only re-fetch on release, not every keystroke, and only in motion mode
  // (window size is irrelevant otherwise) — applies to both "raw" (windows the
  // per-point CSV) and "glim" (windows which submaps get included).
  const windowTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  function setWindowSecDebounced(next: number) {
    setWindowSec(next);
    if (motionState !== "motion") return;
    if (windowTimer.current) clearTimeout(windowTimer.current);
    windowTimer.current = setTimeout(() => {
      void refreshRangeImage(invertElevation, pointcloudSource, currentPose, next, currentTimeSec);
    }, 400);
  }

  // Debounced: scrubbing fires many times per second, each rebuild re-bins the
  // whole point cloud server-side — only act once the user pauses.
  const scrubTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  function onScrubTimeline(t: number) {
    setCurrentTimeSec(t);
    if (scrubTimer.current) clearTimeout(scrubTimer.current);
    scrubTimer.current = setTimeout(async () => {
      if (!trajectoryPath) return;
      try {
        const pose = await api.interpolatePose(trajectoryPath, t);
        setCurrentPose(pose);
        if (pose) {
          await refreshRangeImage(invertElevation, pointcloudSource, pose, windowSec, t);
          // Once the user has generated an overlay at least once, keep it live
          // as they scrub — this is the actual tool for eyeballing the
          // LiDAR<->camera time offset (drag until it lines up), so it has to
          // visibly track the slider, not just sit frozen until re-clicked.
          if (overlayUrl && panoramaFramePath) {
            await generateOverlay(pose, LIVE_OVERLAY_SUBSAMPLE, false);
          }
        }
      } catch (e) {
        toast.error(`获取该时刻位姿失败：${e}`);
      }
    }, 250);
  }

  // Runs `calib_frame_extract` (single-node, ffmpeg seek on the already-stitched
  // video — no re-stitch) and resolves with its artifacts once the job finishes,
  // by matching job-event `job` ids rather than polling.
  async function runWorkflowAndWait(workflowId: string, inputPath: string, paramOverrides: Record<string, Record<string, unknown>>): Promise<Artifact[]> {
    const jobId = await api.runWorkflow(workflowId, inputPath, paramOverrides);
    return new Promise((resolve, reject) => {
      let unlisten: (() => void) | null = null;
      api.onJobEvent((ev: JobEvent) => {
        if (ev.job !== jobId) return;
        if (ev.type === "job_complete") {
          unlisten?.();
          api.jobArtifacts(jobId).then(resolve, reject);
        } else if (ev.type === "job_failed") {
          unlisten?.();
          reject(new Error(ev.reason ?? "任务失败"));
        }
      }).then((fn) => { unlisten = fn; });
    });
  }

  // Depth-1 pending queue: while a re-extract is in flight, at most one more
  // (the latest) scrub position is remembered and run right after — avoids
  // piling up overlapping container jobs while the user drags the slider.
  const frameJobInFlight = React.useRef(false);
  const pendingFrameTimeSec = React.useRef<number | null>(null);

  async function reextractLeftFrame(videoTimeSec: number) {
    if (!stitchedVideoPath) return;
    if (frameJobInFlight.current) {
      pendingFrameTimeSec.current = videoTimeSec;
      return;
    }
    frameJobInFlight.current = true;
    setFollowingTimeline(true);
    try {
      const artifacts = await runWorkflowAndWait("calib_frame_extract", stitchedVideoPath, { step_frame: { timestamp_s: videoTimeSec } });
      const frame = artifacts.find((a) => a.output_id === "frame");
      if (frame) {
        const b64 = await api.readFileBase64(frame.host_path);
        setPanoramaUrl(`data:image/jpeg;base64,${b64}`);
        setCurrentPanoramaFramePath(frame.host_path);
        setPanoramaError(null);
      }
    } catch (e) {
      toast.error(`跟随时间轴重新抽取全景帧失败：${e}`);
    } finally {
      frameJobInFlight.current = false;
      setFollowingTimeline(false);
      const next = pendingFrameTimeSec.current;
      pendingFrameTimeSec.current = null;
      if (next !== null) void reextractLeftFrame(next);
    }
  }

  // Precise path needs both pieces (measured clock offset + the actual first-
  // sample anchor it's relative to) — falls back to the cruder record-button
  // anchor when either is missing (e.g. sync check was never run).
  const usingPreciseSync = syncOffsetSec !== null && firstMid360HostNs !== null;
  function computeVideoTimeSec(): number {
    if (usingPreciseSync) {
      return currentTimeSec - firstMid360HostNs! / 1e9 - syncOffsetSec!;
    }
    return currentTimeSec - (recordStartHostNs ?? 0) / 1e9;
  }

  // Longer debounce than the 250ms local-op one above — each firing is a real
  // container job (~1-3s), not just a local re-bin, so we want to wait until
  // the user actually pauses on a position before spending that cost.
  const followTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (motionState !== "motion" || !stitchedVideoPath) return;
    if (followTimer.current) clearTimeout(followTimer.current);
    followTimer.current = setTimeout(() => {
      void reextractLeftFrame(computeVideoTimeSec());
    }, 500);
    return () => { if (followTimer.current) clearTimeout(followTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTimeSec, motionState, stitchedVideoPath, recordStartHostNs, syncOffsetSec, firstMid360HostNs]);

  function pickLeft(u: number, v: number) {
    const frameTimestampNs = motionState === "motion" ? Math.round(currentTimeSec * 1e9) : 0;
    setPairs((prev) => {
      const idx = prev.findIndex((p) => !p.left);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], left: { u, v } };
        return copy;
      }
      const seq = prev.length ? Math.max(...prev.map((p) => p.seq)) + 1 : 1;
      return [...prev, { seq, left: { u, v }, frameTimestampNs }];
    });
  }

  function pickRight(u: number, v: number) {
    if (!rangeImage) return;
    const col = Math.floor(u), row = Math.floor(v);
    const idx = row * rangeImage.az_bins + col;
    const x = rangeImage.points[idx * 3], y = rangeImage.points[idx * 3 + 1], z = rangeImage.points[idx * 3 + 2];
    if (x == null || y == null || z == null) {
      toast.error("该位置无点云数据，请换个位置点选");
      return;
    }
    const frameTimestampNs = motionState === "motion" ? Math.round(currentTimeSec * 1e9) : 0;
    setPairs((prev) => {
      const idx2 = prev.findIndex((p) => !p.right);
      if (idx2 >= 0) {
        const copy = [...prev];
        copy[idx2] = { ...copy[idx2], right: { u, v, x, y, z } };
        return copy;
      }
      const seq = prev.length ? Math.max(...prev.map((p) => p.seq)) + 1 : 1;
      return [...prev, { seq, right: { u, v, x, y, z }, frameTimestampNs }];
    });
  }

  function removePair(seq: number) {
    setPairs((prev) => prev.filter((p) => p.seq !== seq));
    setSolveResult(null);
  }

  function setExtrinsicField(key: keyof Extrinsic, value: number) {
    setExtrinsic((prev) => ({ ...prev, [key]: value }));
  }

  const completePairs = pairs.filter((p): p is PointPair & { left: { u: number; v: number }; right: { u: number; v: number; x: number; y: number; z: number } } => !!p.left && !!p.right);
  const completeCount = completePairs.length;

  function checkDistribution(): boolean {
    if (completePairs.length < 3 || !panoSize) return true;
    const us = completePairs.map((p) => p.left.u), vs = completePairs.map((p) => p.left.v);
    const spreadU = Math.max(...us) - Math.min(...us);
    const spreadV = Math.max(...vs) - Math.min(...vs);
    if (spreadU < panoSize.width * 0.1 && spreadV < panoSize.height * 0.1) {
      toast.error("点位过于集中，建议在图像不同区域多选几组");
      return false;
    }
    return true;
  }

  async function runSolve() {
    if (completeCount < 3 || !panoSize) return;
    checkDistribution();
    setSolving(true);
    try {
      // Group by the timestamp each pair was picked at — §7: multi-frame solve
      // isn't implemented yet, so this only actually succeeds when every pair
      // shares one timestamp (all-static, or all picked at the same scrub
      // position); otherwise the backend reports "暂不支持多帧标定".
      const byTs = new Map<number, CalibPointPair[]>();
      for (const p of completePairs) {
        const arr = byTs.get(p.frameTimestampNs) ?? [];
        arr.push({ u: p.left.u, v: p.left.v, x: p.right.x, y: p.right.y, z: p.right.z, frame_timestamp_ns: p.frameTimestampNs });
        byTs.set(p.frameTimestampNs, arr);
      }
      const frames: FrameGroup[] = [];
      for (const [ts, framePairs] of byTs) {
        let framePose: Pose | null = null;
        if (motionState === "motion" && ts !== 0 && trajectoryPath) {
          framePose = await api.interpolatePose(trajectoryPath, ts / 1e9);
        }
        frames.push({ frame_pose: framePose, pairs: framePairs });
      }

      const result = await api.solveExtrinsic(frames, extrinsic, panoSize.width, panoSize.height);
      setSolveResult(result);
      setExtrinsic(result.extrinsic);
      if (!result.converged) toast.error("求解未收敛，结果仅供参考");
    } catch (e) {
      toast.error(`解算失败：${e}`);
    } finally {
      setSolving(false);
    }
  }

  // `official`: full-resolution (subsample=1) generations from the explicit
  // button click mark this as "the preview the user actually looked at" and
  // unlock Save; live follow-the-timeline redraws (coarser, subsample>1) only
  // update what's on screen — they must not silently satisfy the save gate,
  // since a subsampled render can hide a real misalignment.
  async function generateOverlay(pose: Pose | null, subsample: number, official: boolean) {
    const basePath = currentPanoramaFramePath ?? panoramaFramePath;
    if (!basePath) {
      if (official) toast.error("没有全景帧，无法生成叠加预览");
      return;
    }
    if (official) setPreviewing(true);
    try {
      const b64 = await api.projectOverlay(pointcloudPath, extrinsic, basePath, subsample, pose);
      setOverlayUrl(`data:image/jpeg;base64,${b64}`);
      if (official) {
        setPreviewedExtrinsic(extrinsic);
        setPreviewedTimeSec(motionState === "motion" ? currentTimeSec : null);
      }
    } catch (e) {
      if (official) toast.error(`生成叠加预览失败：${e}`);
    } finally {
      if (official) setPreviewing(false);
    }
  }

  function runPreview() {
    return generateOverlay(currentPose, 1, true);
  }

  const previewStale = !previewedExtrinsic
    || !extrinsicEqual(previewedExtrinsic, extrinsic)
    || (motionState === "motion" && previewedTimeSec !== currentTimeSec);
  const canSave = completeCount >= 3 && !!overlayUrl && !previewStale;

  async function runSave() {
    if (!canSave) return;
    setSaving(true);
    try {
      const pointPairs: CalibPointPair[] = completePairs.map((p) => ({ u: p.left.u, v: p.left.v, x: p.right.x, y: p.right.y, z: p.right.z, frame_timestamp_ns: p.frameTimestampNs }));
      const residuals = solveResult?.residuals_deg ?? [];
      const outPath = await api.saveExtrinsic(sessionPath, extrinsic, pointPairs, residuals);
      toast.success(`已保存：${outPath}`);
    } catch (e) {
      toast.error(`保存失败：${e}`);
    } finally {
      setSaving(false);
    }
  }

  const leftMarkers: PickMarker[] = pairs.filter((p) => p.left).map((p) => ({ seq: p.seq, x: p.left!.u, y: p.left!.v, complete: !!p.right }));
  const rightMarkers: PickMarker[] = pairs.filter((p) => p.right).map((p) => ({ seq: p.seq, x: p.right!.u, y: p.right!.v, complete: !!p.left }));

  const nextLeftSeq = pairs.find((p) => !p.left)?.seq ?? (pairs.length ? Math.max(...pairs.map((p) => p.seq)) + 1 : 1);
  const nextRightSeq = pairs.find((p) => !p.right)?.seq ?? (pairs.length ? Math.max(...pairs.map((p) => p.seq)) + 1 : 1);

  const residualBySeq = new Map<number, number>();
  if (solveResult) {
    completePairs.forEach((p, i) => residualBySeq.set(p.seq, solveResult.residuals_deg[i]));
  }

  return (
    <div className="hs-view">
      <div className="hs-view-toolbar">
        <button className="hs-btn hs-btn-sm" onClick={onBack} style={{ marginRight: 10 }}>‹ 返回</button>
        <span className="hs-view-title">双视图选点 + 标定求解</span>
      </div>

      <div className="hs-view-body" style={{ padding: 16 }}>
        {loading && <div style={{ color: "#9a9a9a", fontSize: 12.5, marginBottom: 10 }}>加载全景帧 / 生成深度图…</div>}
        {panoramaError && <div style={{ color: "#cf3a3f", fontSize: 12, marginBottom: 6 }}>全景帧加载失败：{panoramaError}</div>}
        {rangeError && <div style={{ color: "#cf3a3f", fontSize: 12, marginBottom: 6 }}>深度图生成失败：{rangeError}</div>}
        {!panoramaFramePath && (
          <div style={{ color: "#e08a1c", fontSize: 12, marginBottom: 6 }}>
            未生成全景帧（本机无 GPU 或尚未运行拼接）——右侧点云面板与点对列表仍可正常使用，但无法选取左图点位、生成叠加预览或保存。
          </div>
        )}
        {motionState === "motion" && trajectoryError && (
          <div style={{ color: "#e08a1c", fontSize: 12, marginBottom: 6 }}>
            未找到轨迹文件（{trajectoryPath}）——时间轴不可用，右图将显示整段聚合点云。错误：{trajectoryError}
          </div>
        )}

        {motionState === "motion" && trajectoryInfo && (
          <div style={{ background: "#fff", border: "1px solid #e2e2e2", borderRadius: 6, padding: "10px 16px", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "#444" }}>时间轴</span>
              <span className="mono" style={{ fontSize: 11, color: "#666" }}>
                t = {currentTimeSec.toFixed(2)}s（轨迹范围 {trajectoryInfo.t_min.toFixed(2)}–{trajectoryInfo.t_max.toFixed(2)}s，{trajectoryInfo.count} 个位姿点）
              </span>
              {rangeLoading && <span style={{ fontSize: 11, color: "#e08a1c" }}>重新切片中…</span>}
            </div>
            <input
              type="range"
              min={trajectoryInfo.t_min}
              max={trajectoryInfo.t_max}
              step={(trajectoryInfo.t_max - trajectoryInfo.t_min) / 500}
              value={currentTimeSec}
              onChange={(e) => onScrubTimeline(Number(e.target.value))}
              style={{ width: "100%" }}
            />
            <div style={{ fontSize: 10.5, color: "#9a9a9a", marginTop: 4 }}>
              拖动会重新投影右侧点云面板；左侧全景图本身固定为拼接时刻的帧，不会切换到别的帧。点过一次"生成叠加预览"之后，叠加图会跟着时间轴实时更新（低精度快速预览）——如果两个传感器有系统时间差，可以借此手动拖到叠加效果最吻合的位置，找到这个偏移量；找到满意的位置后，仍需再点一次"生成叠加预览"生成高精度版本才能保存。
              选点时建议先把时间轴停在一个位置再选完整批点对，不同时间点选的点混在一起解算会报"暂不支持多帧标定"。
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: "#8a8a8a", marginBottom: 4 }}>
              左：全景 ERP 图 {panoramaUrl && <span className="mono" style={{ color: "#666" }}>· 等待第 {nextLeftSeq} 点</span>}
              {followingTimeline && <span className="mono" style={{ color: "#8a8a8a" }}> · 跟随时间轴重新抽帧中…</span>}
              {motionState === "motion" && stitchedVideoPath && (
                <span
                  className="mono"
                  style={{ color: usingPreciseSync ? "#199a3e" : "#e08a1c" }}
                  title={usingPreciseSync
                    ? "使用「传感器时间同步检测」测得的 offset_sec 做视频时间换算"
                    : "未运行「传感器时间同步检测」，视频时间换算退化为 record_start_host_ns 粗略估计（±1-2s 量级），建议先在上一页运行时间同步检测"}
                >
                  {" "}· {usingPreciseSync ? "时间同步：精确" : "时间同步：粗略估计"}
                </span>
              )}
            </div>
            <PickCanvas imageDataUrl={panoramaUrl} markers={leftMarkers} onPick={pickLeft} emptyLabel={panoramaFramePath ? "加载中…" : "全景帧未生成"} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#8a8a8a", marginBottom: 4, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <span>
                右：点云深度图 {rangeImage && <span className="mono" style={{ color: "#666" }} title={`输入 ${rangeImage.input_point_count.toLocaleString()} 点，有效 ${rangeImage.valid_point_count.toLocaleString()} 点，颜色按 P2–P98 映射：${rangeImage.color_min_range.toFixed(2)}–${rangeImage.color_max_range.toFixed(2)}m`}>· 等待第 {nextRightSeq} 点 · {rangeSourceLabel(rangeImage.source)} · 占用 {(rangeImage.occupancy_ratio * 100).toFixed(1)}% · P2/P50/P98 {rangeImage.range_p02.toFixed(1)}/{rangeImage.range_p50.toFixed(1)}/{rangeImage.range_p98.toFixed(1)} m · 过滤 {rangeImage.filtered_point_count.toLocaleString()} · 俯仰 {rangeImage.el_min_deg.toFixed(0)}°~{rangeImage.el_max_deg.toFixed(0)}°</span>}
              </span>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                {rawPointcloudPath && (
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }} title="GLIM=重建地图（运动场景下按时间窗只取邻近的子地图）；原始时间窗=未经 GLIM 重建、按当前时间附近截取的原始扫描点">
                    <SourceBtn label="GLIM 重建" active={pointcloudSource === "glim"} onClick={() => switchPointcloudSource("glim")} />
                    <SourceBtn label="原始时间窗" active={pointcloudSource === "raw"} onClick={() => switchPointcloudSource("raw")} />
                  </div>
                )}
                {motionState === "motion" && ((pointcloudSource === "raw" && rawPointcloudPath) || (pointcloudSource === "glim" && mapDirPath)) && (
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", userSelect: "none" }}
                    title={pointcloudSource === "raw"
                      ? "以当前时间轴位置为中心，取这个时间窗口内的原始扫描点"
                      : "以当前时间轴位置为中心，只取时间戳落在这个窗口内的 GLIM 子地图（submap），而非整段会话——减少非当前时刻的点造成的杂乱/重影"}
                  >

                    <span>窗口</span>
                    <input
                      type="number"
                      className="hs-input mono"
                      style={{ width: 60, height: 22, padding: "0 4px" }}
                      step={0.1}
                      min={0.02}
                      value={windowSec}
                      onChange={(e) => setWindowSecDebounced(Math.max(0.02, Number(e.target.value) || DEFAULT_WINDOW_SEC))}
                    />
                    <span>s</span>
                  </label>
                )}
                <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", userSelect: "none" }} title="激光雷达倒置安装时，深度图上下会与全景图相反，勾选此项翻转">
                  <input type="checkbox" checked={invertElevation} onChange={toggleInvertElevation} disabled={rangeLoading} style={{ margin: 0 }} />
                  <span>雷达倒置安装（上下翻转）</span>
                </label>
              </div>
            </div>
            {rangeImage?.source === "glim_whole_map_fallback" && (
              <div style={{ color: "#b26a00", fontSize: 11, marginBottom: 4 }} title={rangeImage.source_detail ?? undefined}>
                ⚠ GLIM 时间窗子图不可用，当前显示的是整段会话地图；可能包含其他时刻的重影和动态物体。
              </div>
            )}
            <PickCanvas
              imageDataUrl={rangeImage ? `data:image/png;base64,${rangeImage.image_png_base64}` : null}
              markers={rightMarkers}
              onPick={pickRight}
              pixelated
              emptyLabel={rangeLoading ? "重新生成中…" : "深度图未加载"}
            />
          </div>
        </div>

        {/* ── Param panel ── */}
        <div style={{ background: "#fff", border: "1px solid #e2e2e2", borderRadius: 6, padding: "12px 16px", marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 10, color: "#444" }}>
            外参微调
            {solveResult && (
              <span style={{ fontWeight: 400, fontSize: 11, color: solveResult.converged ? "#199a3e" : "#cf3a3f", marginLeft: 8 }}>
                {solveResult.converged ? "已收敛" : "未收敛"} · {solveResult.iterations} 次迭代 · RMS 残差 {solveResult.rms_residual_deg.toFixed(3)}°
              </span>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8, marginBottom: 10 }}>
            {([["tx", "x (m)"], ["ty", "y (m)"], ["tz", "z (m)"], ["roll_deg", "roll (°)"], ["pitch_deg", "pitch (°)"], ["yaw_deg", "yaw (°)"]] as const).map(([key, label]) => (
              <div key={key} className="hs-input-group">
                <label className="hs-input-label">{label}</label>
                <input
                  className="hs-input mono"
                  type="number"
                  step={key.startsWith("t") ? 0.001 : 0.1}
                  value={extrinsic[key]}
                  onChange={(e) => setExtrinsicField(key, Number(e.target.value) || 0)}
                />
              </div>
            ))}
            <div className="hs-input-group">
              <label className="hs-input-label">时间偏移</label>
              <input className="hs-input mono" value="—" disabled title={motionState === "static" ? "静止场景禁用" : "多帧标定暂不支持，敬请期待"} style={{ opacity: 0.5 }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="hs-btn" onClick={() => { setExtrinsic(ZERO_EXTRINSIC); setSolveResult(null); }}>
              重置默认
            </button>
            <button className="hs-btn hs-btn-primary" onClick={runSolve} disabled={completeCount < 3 || !panoSize || solving}>
              {solving ? "解算中…" : "解算"}
            </button>
            <button className="hs-btn" onClick={runPreview} disabled={!panoramaFramePath || previewing}>
              {previewing ? "生成中…" : "生成叠加预览"}
            </button>
            <button
              className="hs-btn hs-btn-primary"
              onClick={runSave}
              disabled={!canSave || saving}
              title={canSave ? undefined : "需要先生成与当前参数一致的叠加预览才能保存"}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
          {completeCount < 3 && <div style={{ fontSize: 11, color: "#9a9a9a", marginTop: 8 }}>还需至少 {3 - completeCount} 组完整点对才能解算</div>}
          {motionState === "motion" && (
            <div style={{ fontSize: 11, color: "#9a9a9a", marginTop: 8 }}>
              运动场景多帧求解尚未实现——所有点对必须在同一个时间轴位置选取才能解算，否则会报"暂不支持多帧标定"。
            </div>
          )}
          {overlayUrl && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: "#8a8a8a", marginBottom: 4 }}>
                叠加预览{motionState === "motion" && <span className="mono"> · t={currentTimeSec.toFixed(2)}s</span>}
                {previewStale ? (
                  <span style={{ color: "#e08a1c" }}>
                    {" "}· {motionState === "motion" && previewedTimeSec !== currentTimeSec ? "低精度快速预览（跟随时间轴）" : "参数已改动"}，需点"生成叠加预览"取高精度版本才能保存
                  </span>
                ) : (
                  <span style={{ color: "#199a3e" }}> · 高精度版本，可保存</span>
                )}
              </div>
              <SphereViewer
                imageDataUrl={overlayUrl}
                azBins={panoSize?.width ?? 3840}
                elBins={panoSize?.height ?? 1920}
                elMinDeg={-90}
                elMaxDeg={90}
                height={420}
              />
            </div>
          )}
        </div>

        {/* ── Point pair list ── */}
        <div style={{ background: "#fff", border: "1px solid #e2e2e2", borderRadius: 6, padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 12.5, color: "#444" }}>点对列表</span>
            <span style={{ marginLeft: "auto", fontSize: 11.5, color: completeCount >= 3 ? "#199a3e" : "#9a9a9a" }}>
              已配对 {completeCount} 组{completeCount < 3 ? "（最少需要 3 组，建议 4-6 组）" : ""}
            </span>
          </div>
          {pairs.length === 0 ? (
            <div style={{ fontSize: 12, color: "#9a9a9a", padding: "12px 0" }}>在左右两侧图上点击以选取匹配点，编号会自动配对。</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
              <thead>
                <tr style={{ background: "#f7f7f7", textAlign: "left" }}>
                  <th style={thStyle}>#</th>
                  {motionState === "motion" && <th style={thStyle}>帧 (t)</th>}
                  <th style={thStyle}>左图坐标 (u,v)</th>
                  <th style={thStyle}>右图 3D 坐标 (x,y,z)</th>
                  <th style={thStyle}>残差角度</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {pairs.slice().sort((a, b) => a.seq - b.seq).map((p) => {
                  const residual = residualBySeq.get(p.seq);
                  const highResidual = residual != null && residual > 3.0;
                  return (
                    <tr key={p.seq} style={{ borderTop: "1px solid #ececec", background: !p.left || !p.right ? "rgba(224,138,28,.06)" : highResidual ? "rgba(207,58,63,.08)" : undefined }}>
                      <td style={tdStyle}>{p.seq}</td>
                      {motionState === "motion" && (
                        <td style={{ ...tdStyle, fontFamily: "'IBM Plex Mono',monospace" }}>{(p.frameTimestampNs / 1e9).toFixed(2)}s</td>
                      )}
                      <td style={{ ...tdStyle, fontFamily: "'IBM Plex Mono',monospace" }}>
                        {p.left ? `${p.left.u.toFixed(1)}, ${p.left.v.toFixed(1)}` : <span style={{ color: "#e08a1c" }}>待选</span>}
                      </td>
                      <td style={{ ...tdStyle, fontFamily: "'IBM Plex Mono',monospace" }}>
                        {p.right ? `${p.right.x.toFixed(2)}, ${p.right.y.toFixed(2)}, ${p.right.z.toFixed(2)}` : <span style={{ color: "#e08a1c" }}>待选</span>}
                      </td>
                      <td style={{ ...tdStyle, color: highResidual ? "#cf3a3f" : undefined, fontWeight: highResidual ? 600 : undefined }}>
                        {residual != null ? `${residual.toFixed(2)}°` : "—"}
                      </td>
                      <td style={tdStyle}>
                        <button className="hs-btn hs-btn-sm" onClick={() => removePair(p.seq)}>删除</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: "6px 10px", fontSize: 10.5, fontWeight: 600, color: "#8a8a8a", textTransform: "uppercase", letterSpacing: ".3px" };
const tdStyle: React.CSSProperties = { padding: "6px 10px", color: "#333" };

function SourceBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className="hs-btn"
      style={{
        height: 22, fontSize: 10.5, padding: "0 8px",
        background: active ? "var(--hs-green)" : undefined,
        color: active ? "#fff" : undefined,
        borderColor: active ? "var(--hs-green)" : undefined,
      }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

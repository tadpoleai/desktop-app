import React from "react";
import { api, Artifact, HeraSession, JobEvent, MotionCheckResult } from "../api";
import { toast } from "../components/toast";
import { CalibrationPointSelect } from "./CalibrationPointSelect";

interface Props {
  currentSession?: HeraSession | null;
  onRequestSession?: () => void;
}

const DEFAULT_THRESHOLD = 0.005;

type Override = "auto" | "static" | "motion";
type StaticBranch = "skip_glim" | "run_glim";
type KeyframeStrategy = "OVERLAP" | "DISPLACEMENT";
type StepState = "pending" | "running" | "done" | "failed";

interface JobTrack {
  jobId: string;
  label: string;
  stepStates: Record<string, StepState>;
  running: boolean;
  failed: boolean;
  reason?: string;
  artifacts: Artifact[];
  /** Rolling tail of "log" job-events (both stdout+stderr) — the CLI tools
   *  wrapped by some operators (e.g. sensor-time-sync) log their actual
   *  diagnostic ("Alignment failed: ...") to stdout, which `reason` above
   *  (stderr-only, from dag.rs) doesn't capture. */
  logTail?: string[];
}

type JobSlot = "pointcloud" | "panorama" | "rawPointcloud" | "frameReextract" | "timeSync";

export function CalibrationView({ currentSession, onRequestSession }: Props) {
  const [session, setSession] = React.useState<HeraSession | null>(currentSession ?? null);
  const [loading, setLoading] = React.useState(false);

  const [threshold, setThreshold] = React.useState(DEFAULT_THRESHOLD);
  const [motion, setMotion] = React.useState<MotionCheckResult | null>(null);
  const [motionError, setMotionError] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [override, setOverride] = React.useState<Override>("auto");

  const [staticBranch, setStaticBranch] = React.useState<StaticBranch>("skip_glim");
  const [motionKeyframeStrategy, setMotionKeyframeStrategy] = React.useState<KeyframeStrategy>("OVERLAP");
  const [jobs, setJobs] = React.useState<Partial<Record<JobSlot, JobTrack>>>({});
  const [starting, setStarting] = React.useState(false);
  const [stage, setStage] = React.useState<"pipeline" | "select">("pipeline");
  const [reextractTimestamp, setReextractTimestamp] = React.useState(0);

  React.useEffect(() => {
    if (currentSession) setSession(currentSession);
  }, [currentSession]);

  React.useEffect(() => {
    let unlisten: (() => void) | null = null;
    api.onJobEvent(handleJobEvent).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  function handleJobEvent(ev: JobEvent) {
    setJobs((prev) => {
      const slot = (Object.keys(prev) as JobSlot[]).find((k) => prev[k]?.jobId === ev.job);
      if (!slot) return prev;
      const track = prev[slot]!;
      switch (ev.type) {
        case "step_start":
          return { ...prev, [slot]: { ...track, stepStates: { ...track.stepStates, [ev.step!]: "running" } } };
        case "step_complete":
          return { ...prev, [slot]: { ...track, stepStates: { ...track.stepStates, [ev.step!]: "done" } } };
        case "step_failed":
          return { ...prev, [slot]: { ...track, stepStates: { ...track.stepStates, [ev.step!]: "failed" } } };
        case "log":
          return { ...prev, [slot]: { ...track, logTail: [...(track.logTail ?? []), ev.text ?? ""].slice(-30) } };
        case "job_complete":
          api.jobArtifacts(track.jobId).then((artifacts) => {
            setJobs((p) => (p[slot] ? { ...p, [slot]: { ...p[slot]!, running: false, artifacts } } : p));
          });
          return { ...prev, [slot]: { ...track, running: false } };
        case "job_failed":
          return { ...prev, [slot]: { ...track, running: false, failed: true, reason: ev.reason } };
        default:
          return prev;
      }
    });
  }

  const effectiveIsStatic = override === "auto" ? motion?.is_static ?? null : override === "static";

  async function startPipeline() {
    if (!session || effectiveIsStatic === null) return;
    setStarting(true);

    let pcWorkflow: string;
    let pcOverrides: Record<string, Record<string, unknown>> = {};
    if (effectiveIsStatic) {
      if (staticBranch === "skip_glim") {
        pcWorkflow = "calib_static_extract_pointcloud";
      } else {
        pcWorkflow = "reconstruct_pointcloud";
        pcOverrides = { step_recon: { keyframe_strategy: "DISPLACEMENT" } };
      }
    } else {
      pcWorkflow = "reconstruct_pointcloud";
      pcOverrides = { step_recon: { keyframe_strategy: motionKeyframeStrategy } };
    }

    try {
      const jobId = await api.runWorkflow(pcWorkflow, session.path, pcOverrides);
      setJobs((prev) => ({ ...prev, pointcloud: { jobId, label: "点云", stepStates: {}, running: true, failed: false, artifacts: [] } }));
    } catch (e) {
      toast.error(`点云流水线启动失败：${e}`);
    }

    // Whenever GLIM ran (run-GLIM/motion branches), also pull the raw,
    // per-point-timestamped scan alongside the GLIM map — GLIM's map is the
    // *whole session* aggregated/loop-closed into one point cloud, which reads
    // as cluttered/noisy for any single moment; the raw extraction gives an
    // alternative "just this instant" view with no SLAM aggregation. Denoising
    // the GLIM map itself is explicitly out of scope for now — this is the
    // switch-source path, not a preprocessing pass on the GLIM cloud.
    if (pcWorkflow === "reconstruct_pointcloud") {
      try {
        const jobId = await api.runWorkflow("calib_static_extract_pointcloud", session.path, {});
        setJobs((prev) => ({ ...prev, rawPointcloud: { jobId, label: "原始点云（未去噪）", stepStates: {}, running: true, failed: false, artifacts: [] } }));
      } catch (e) {
        toast.error(`原始点云提取启动失败：${e}`);
      }
    }

    if (!session.insv_path) {
      toast.error("会话缺少 .insv 文件，跳过全景拼接");
    } else {
      // calib_panorama_frame's step_stitch is panorama-stitch-gpu (gpu: required) —
      // without this check, starting it on a GPU-less machine doesn't fail fast,
      // it hangs forever (MediaSDK blocks in futex_wait waiting on CUDA init that
      // never completes) and the job just sits at "运行中" with no error. Same
      // guard RunView already applies before letting a GPU-required workflow run.
      const [gpuPresent, cfg] = await Promise.all([api.detectGpu(), api.getConfig()]);
      if (!gpuPresent) {
        toast.error("本机未检测到 NVIDIA GPU，全景拼接（需要本机 GPU）已跳过 — 点云流水线仍会运行");
      } else if (!cfg.runtime.gpu_enabled) {
        toast.error("检测到本机 GPU，但尚未在设置中启用「GPU 支持」，全景拼接已跳过");
      } else {
        try {
          const jobId = await api.runWorkflow("calib_panorama_frame", session.insv_path, {});
          setJobs((prev) => ({ ...prev, panorama: { jobId, label: "全景帧", stepStates: {}, running: true, failed: false, artifacts: [] }, frameReextract: undefined }));
        } catch (e) {
          toast.error(`全景拼接启动失败：${e}`);
        }
      }
    }

    setStarting(false);
  }

  /** Re-extract a frame from an already-stitched panorama.mp4 instead of
   *  re-running the (slow, GPU) stitch — reuses jobs.panorama's "panorama"
   *  video artifact directly. */
  async function runFrameReextract(stitchedVideoPath: string) {
    try {
      const jobId = await api.runWorkflow("calib_frame_extract", stitchedVideoPath, { step_frame: { timestamp_s: reextractTimestamp } });
      setJobs((prev) => ({ ...prev, frameReextract: { jobId, label: "重新抽帧", stepStates: {}, running: true, failed: false, artifacts: [] } }));
    } catch (e) {
      toast.error(`重新抽帧启动失败：${e}`);
    }
  }

  // "detect" = run the sync tool against *this* session's own .hera (only
  // works if this recording itself has the ~60s sync-calibration motion at
  // the start). "manual" = type in an offset_sec measured from a *different*
  // recording — offset_sec is only about the two devices' clock skew within
  // one continuous power-on, not tied to any specific recording's content, so
  // a dedicated short sync-motion clip and the actual scene-capture clip from
  // the same boot session can share one offset_sec. This is the common case:
  // the two are usually not the same recording.
  type OffsetSource = "detect" | "manual";
  const [offsetSource, setOffsetSource] = React.useState<OffsetSource>("detect");
  const [detectedOffsetSec, setDetectedOffsetSec] = React.useState<number | null>(null);
  const [manualOffsetSec, setManualOffsetSec] = React.useState(0);
  const timeSyncOffsetSec = offsetSource === "manual" ? manualOffsetSec : detectedOffsetSec;

  /** Runs multi_source_synchronizer (see operators/sensor-time-sync) on the
   *  session's .hera: cross-correlates the Mid360 IMU and Insta360 gyro
   *  tracks to estimate their clock offset. Needs ~60s of vigorous, irregular
   *  head/body motion at the very start of the recording (the "sync
   *  calibration motion") — without it, alignment legitimately fails, that's
   *  not a tool bug. */
  async function runTimeSync() {
    if (!session) return;
    try {
      const jobId = await api.runWorkflow("calib_time_sync", session.path, {});
      setJobs((prev) => ({ ...prev, timeSync: { jobId, label: "时间同步", stepStates: {}, running: true, failed: false, artifacts: [], logTail: [] } }));
      setDetectedOffsetSec(null);
    } catch (e) {
      toast.error(`时间同步检测启动失败：${e}`);
    }
  }

  React.useEffect(() => {
    const artifact = jobs.timeSync?.artifacts.find((a) => a.output_id === "offset");
    if (!artifact) { setDetectedOffsetSec(null); return; }
    let cancelled = false;
    api.readTextFileOpt(artifact.host_path).then((text) => {
      if (cancelled || !text) return;
      const m = text.match(/offset_sec=(-?[\d.]+)/);
      if (m) setDetectedOffsetSec(parseFloat(m[1]));
    });
    return () => { cancelled = true; };
  }, [jobs.timeSync?.artifacts]);

  async function cancelJob(slot: JobSlot) {
    const track = jobs[slot];
    if (!track) return;
    // cancel_job aborts the backend task and best-effort `docker stop`s the
    // container by name, but neither path emits a job-event — update locally
    // instead of waiting for one that will never arrive.
    try {
      await api.cancelJob(track.jobId);
    } catch (e) {
      toast.error(`取消失败：${e}`);
      return;
    }
    setJobs((prev) => (prev[slot] ? { ...prev, [slot]: { ...prev[slot]!, running: false, failed: true, reason: "已取消" } } : prev));
  }

  React.useEffect(() => {
    // Threshold changed after a check already ran: re-derive is_static locally
    // instead of re-shelling out — the raw std numbers don't change.
    if (motion) {
      setMotion({ ...motion, threshold, is_static: motion.gyro_std.every((s) => s < threshold) && motion.window_std_max < threshold });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threshold]);

  async function openFile() {
    const path = await api.pickFile(["hera"]);
    if (!path) return;
    setLoading(true);
    try {
      const s = await api.openHeraSession(path);
      setSession(s);
      setMotion(null);
      setMotionError(null);
      setOverride("auto");
    } catch (e) {
      toast.error(`打开失败：${e}`);
    } finally {
      setLoading(false);
    }
  }

  async function runCheck() {
    if (!session) return;
    setChecking(true);
    setMotionError(null);
    try {
      const result = await api.checkSessionMotion(session.path, threshold);
      setMotion(result);
    } catch (e) {
      setMotionError(String(e));
    } finally {
      setChecking(false);
    }
  }

  const pointcloudArtifact = jobs.pointcloud?.artifacts.find((a) => a.output_id === "points" || a.output_id === "cloud");
  // The stitched video itself — kept around so "重新抽帧" can target it
  // directly without re-running the (slow, GPU) stitch step.
  const stitchedVideoArtifact = jobs.panorama?.artifacts.find((a) => a.output_id === "panorama");
  // Prefer a frame re-extracted from the existing stitch over the original
  // job's frame, so switching timestamps doesn't require a fresh stitch.
  const panoramaArtifact = jobs.frameReextract?.artifacts.find((a) => a.output_id === "frame") ?? jobs.panorama?.artifacts.find((a) => a.output_id === "frame");
  // glim-recon's own "map" dir output — only present when the pointcloud job
  // went through reconstruct_pointcloud (run-GLIM/motion branches), not the
  // skip-GLIM storage-extract path. §7: motion sessions need this for the
  // timeline (GLIM writes its loop-closed trajectory at <map_dir>/traj_lidar.txt
  // — confirmed from spatial-memory's p2_load_traj.py, not guessed).
  const mapArtifact = jobs.pointcloud?.artifacts.find((a) => a.output_id === "map");
  const trajectoryPath = mapArtifact ? `${mapArtifact.host_path}/traj_lidar.txt` : null;
  // Raw, per-point-timestamped scan — only present when the pointcloud job went
  // through reconstruct_pointcloud (see startPipeline); lets CalibrationPointSelect
  // offer "GLIM map vs. raw single-frame" as a right-panel data source toggle.
  const rawPointcloudArtifact = jobs.rawPointcloud?.artifacts.find((a) => a.output_id === "points");
  // Panorama stitching needs a local GPU (see startPipeline's pre-flight check) —
  // on a GPU-less machine it never produces an artifact. Don't hard-block point
  // selection on it: the point-cloud side (right panel + list + solve/save) is
  // still fully usable without it, only the left ERP panel degrades to a
  // "not available" placeholder.
  const readyForPointSelect = !!pointcloudArtifact;
  // Fallback anchor for converting the trajectory's own clock (traj_lidar.txt's
  // t, large epoch-like seconds) into video-relative time (0 = start of the
  // .insv, what frame-extract's timestamp_s expects) — session.json's
  // record_start_host_ns is in the same host-clock domain (spot-checked
  // against real sessions: the raw point CSV's first timestamp_host_ns was
  // ~1.9-5.7s after this, a plausible sensor-startup delay, not a different
  // epoch). Only used when timeSyncOffsetSec isn't available — see
  // CalibrationPointSelect's Props.syncOffsetSec doc for the more precise path.
  const recordStartHostNs = React.useMemo(() => {
    if (!session?.session_json) return null;
    try {
      const parsed = JSON.parse(session.session_json);
      return typeof parsed.record_start_host_ns === "number" ? parsed.record_start_host_ns : null;
    } catch {
      return null;
    }
  }, [session?.session_json]);

  if (stage === "select" && pointcloudArtifact) {
    return (
      <CalibrationPointSelect
        sessionPath={session!.path}
        pointcloudPath={pointcloudArtifact.host_path}
        mapDirPath={mapArtifact?.host_path ?? null}
        rawPointcloudPath={rawPointcloudArtifact?.host_path ?? null}
        panoramaFramePath={panoramaArtifact?.host_path ?? null}
        stitchedVideoPath={stitchedVideoArtifact?.host_path ?? null}
        recordStartHostNs={recordStartHostNs}
        syncOffsetSec={timeSyncOffsetSec}
        motionState={effectiveIsStatic ? "static" : "motion"}
        trajectoryPath={effectiveIsStatic ? null : trajectoryPath}
        onBack={() => setStage("pipeline")}
      />
    );
  }

  return (
    <div className="hs-view">
      <div className="hs-view-toolbar">
        <span className="hs-view-title">激光-全景相机标定</span>
      </div>

      <div className="hs-view-body" style={{ padding: 20 }}>
        <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 16 }}>

          {/* ── Session picker ── */}
          <div style={{ background: "#fff", border: "1px solid #e2e2e2", borderRadius: 6, padding: 18 }}>
            <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 12, color: "#444" }}>会话</div>
            {!session ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 12.5, color: "#8a8a8a" }}>选择一个含 .hera/.insv/.session.json 的采集会话</span>
                <button className="hs-btn hs-btn-primary" style={{ height: 28, marginLeft: "auto" }} onClick={openFile} disabled={loading}>
                  {loading ? "读取中…" : "打开 .hera 文件"}
                </button>
              </div>
            ) : (
              <div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                  <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: "#232323" }}>{session.stem}</span>
                  <span style={{ fontSize: 11, color: "#9a9a9a" }}>{session.date} {session.time} · {session.operator} · {session.place}</span>
                </div>
                <div style={{ display: "flex", gap: 7, marginBottom: 4 }}>
                  <FileTag ext=".hera" present />
                  <FileTag ext=".insv" present={!!session.insv_path} />
                  <FileTag ext=".session.json" present={!!session.session_json} />
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button className="hs-btn" style={{ height: 26, fontSize: 11.5 }} onClick={openFile} disabled={loading}>
                    换一个会话…
                  </button>
                  {onRequestSession && (
                    <button className="hs-btn" style={{ height: 26, fontSize: 11.5 }} onClick={onRequestSession}>
                      从数据集浏览器选择…
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── Motion check ── */}
          {session && (
            <div style={{ background: "#fff", border: "1px solid #e2e2e2", borderRadius: 6, padding: 18 }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontWeight: 600, fontSize: 12.5, color: "#444" }}>静止 / 运动判断</span>
                <button
                  className="hs-btn hs-btn-primary"
                  style={{ height: 26, fontSize: 11.5, marginLeft: "auto" }}
                  onClick={runCheck}
                  disabled={checking}
                >
                  {checking ? "检测中…" : motion ? "重新检测" : "检测运动状态"}
                </button>
              </div>

              <div className="hs-input-group" style={{ maxWidth: 260, marginBottom: 14 }}>
                <label className="hs-input-label">阈值 REST_STD_THRESHOLD (rad/s)</label>
                <input
                  className="hs-input mono"
                  type="number"
                  step="0.0005"
                  min="0"
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value) || 0)}
                  style={{ width: 140 }}
                />
              </div>

              {motionError && (
                <div style={{ color: "#cf3a3f", fontSize: 12, marginBottom: 10 }}>检测失败：{motionError}</div>
              )}

              {motion && (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                    {(["x", "y", "z"] as const).map((axis, i) => (
                      <StdBar key={axis} label={`gyro_std ${axis}`} value={motion.gyro_std[i]} threshold={motion.threshold} />
                    ))}
                    <StdBar label="滑动窗口 std 最大值" value={motion.window_std_max} threshold={motion.threshold} />
                  </div>

                  <div style={{ fontSize: 11.5, color: "#8a8a8a", marginBottom: 14 }}>
                    {motion.sample_count.toLocaleString()} 个 IMU 采样 · 时长 {motion.duration_s.toFixed(2)} s
                  </div>

                  <div style={{ height: 1, background: "#eee", margin: "4px 0 14px" }} />

                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11.5, color: "#7a7a7a", marginBottom: 6 }}>
                      自动判断：
                      <StatusTag isStatic={motion.is_static} />
                    </div>
                    <label className="hs-input-label" style={{ display: "block", marginBottom: 6 }}>
                      我确认这是静止/运动，忽略自动判断
                    </label>
                    <div style={{ display: "flex", gap: 6 }}>
                      <OverrideBtn label="使用自动判断" active={override === "auto"} onClick={() => setOverride("auto")} />
                      <OverrideBtn label="强制：静止" active={override === "static"} onClick={() => setOverride("static")} />
                      <OverrideBtn label="强制：运动" active={override === "motion"} onClick={() => setOverride("motion")} />
                    </div>
                  </div>

                  <div style={{ marginTop: 12, padding: "10px 12px", background: "#f7f7f7", border: "1px solid #e8e8e8", borderRadius: 5 }}>
                    <span style={{ fontSize: 11.5, color: "#555" }}>最终结果：</span>
                    <StatusTag isStatic={effectiveIsStatic} />
                    {override !== "auto" && (
                      <span style={{ fontSize: 11, color: "#e08a1c", marginLeft: 8 }}>（人工覆盖）</span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Sensor time sync (diagnostic) ── */}
          {session && (
            <div style={{ background: "#fff", border: "1px solid #e2e2e2", borderRadius: 6, padding: 18 }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontWeight: 600, fontSize: 12.5, color: "#444" }}>传感器时间同步检测（可选）</span>
              </div>

              <div style={{ fontSize: 11.5, color: "#8a8a8a", marginBottom: 12, lineHeight: 1.6 }}>
                基于两路 IMU 陀螺仪互相关，估计 Mid-360 与 Insta360 的时钟偏移 offset_sec（t_mid = t_insta + offset_sec）。
                offset_sec 只跟两设备同一次开机内的时钟偏差有关，跟具体哪段录制无关——同一次开机内，专门录的同步标定动作片段和实际标定用的场景录制通常不是同一份数据，可以用前者测出的偏移，供后者使用。
                <br />
                成功后会自动供下方选点阶段左侧全景图的"跟随时间轴"换算使用（比单用 record_start_host_ns 更精确）；不设置时自动退回 record_start_host_ns 的粗略估计（误差量级 ±1-2s），选点页会标出当前用的是哪种。
              </div>

              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                <OverrideBtn label="自动检测（本会话）" active={offsetSource === "detect"} onClick={() => setOffsetSource("detect")} />
                <OverrideBtn label="手动输入（来自其它录制）" active={offsetSource === "manual"} onClick={() => setOffsetSource("manual")} />
              </div>

              {offsetSource === "detect" ? (
                <>
                  <button
                    className="hs-btn hs-btn-primary"
                    style={{ height: 26, fontSize: 11.5, marginBottom: 12 }}
                    onClick={runTimeSync}
                    disabled={jobs.timeSync?.running}
                  >
                    {jobs.timeSync?.running ? "检测中…" : "检测 Mid360↔Insta360 时钟偏移"}
                  </button>
                  {jobs.timeSync && <JobCard track={jobs.timeSync} onCancel={() => cancelJob("timeSync")} />}
                </>
              ) : (
                <div className="hs-input-group" style={{ maxWidth: 260, marginBottom: 12 }}>
                  <label className="hs-input-label">offset_sec（秒，t_mid = t_insta + offset_sec）</label>
                  <input
                    className="hs-input mono"
                    type="number"
                    step="0.001"
                    value={manualOffsetSec}
                    onChange={(e) => setManualOffsetSec(Number(e.target.value) || 0)}
                    style={{ width: 160 }}
                  />
                </div>
              )}

              {timeSyncOffsetSec !== null && (
                <div style={{ marginTop: 10, padding: "10px 12px", background: "#f0f9f0", border: "1px solid rgba(65,205,82,.3)", borderRadius: 5 }}>
                  <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: "#199a3e" }}>
                    offset_sec = {timeSyncOffsetSec.toFixed(6)} s
                  </span>
                  <span style={{ fontSize: 10.5, color: "#8a8a8a", marginLeft: 8 }}>
                    ({offsetSource === "manual" ? "手动输入" : "本会话检测"})
                  </span>
                  <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>
                    t_mid = t_insta + offset_sec · Mid360 时钟
                    {timeSyncOffsetSec > 0 ? "领先" : timeSyncOffsetSec < 0 ? "落后" : "与"} Insta360
                    {timeSyncOffsetSec !== 0 && ` ${Math.abs(timeSyncOffsetSec * 1000).toFixed(0)}ms`}
                  </div>
                </div>
              )}

              {offsetSource === "detect" && jobs.timeSync?.failed && !!jobs.timeSync.logTail?.length && (
                <div
                  className="mono"
                  style={{
                    marginTop: 10, padding: "8px 10px", background: "#fff5f5",
                    border: "1px solid rgba(227,93,93,.3)", borderRadius: 5, fontSize: 10.5,
                    color: "#a33", whiteSpace: "pre-wrap", maxHeight: 140, overflowY: "auto",
                  }}
                >
                  {jobs.timeSync.logTail.join("\n")}
                </div>
              )}
            </div>
          )}

          {/* ── Pipeline: point cloud (branch-dependent) + panorama frame ── */}
          {session && effectiveIsStatic !== null && (
            <div style={{ background: "#fff", border: "1px solid #e2e2e2", borderRadius: 6, padding: 18 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 12, color: "#444" }}>重建 / 拼接流水线</div>

              {effectiveIsStatic ? (
                <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                  <OverrideBtn label="跳过重建（默认）" active={staticBranch === "skip_glim"} onClick={() => setStaticBranch("skip_glim")} />
                  <OverrideBtn label="仍跑 GLIM（DISPLACEMENT 关键帧）" active={staticBranch === "run_glim"} onClick={() => setStaticBranch("run_glim")} />
                </div>
              ) : (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11.5, color: "#7a7a7a", marginBottom: 6 }}>运动场景强制走 GLIM，关键帧策略：</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <OverrideBtn label="OVERLAP（默认）" active={motionKeyframeStrategy === "OVERLAP"} onClick={() => setMotionKeyframeStrategy("OVERLAP")} />
                    <OverrideBtn label="DISPLACEMENT" active={motionKeyframeStrategy === "DISPLACEMENT"} onClick={() => setMotionKeyframeStrategy("DISPLACEMENT")} />
                  </div>
                </div>
              )}

              <button className="hs-btn hs-btn-primary" style={{ height: 28 }} onClick={startPipeline} disabled={starting}>
                {starting ? "启动中…" : "开始重建 / 拼接"}
              </button>

              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
                {jobs.pointcloud && <JobCard track={jobs.pointcloud} onCancel={() => cancelJob("pointcloud")} />}
                {jobs.rawPointcloud && <JobCard track={jobs.rawPointcloud} onCancel={() => cancelJob("rawPointcloud")} />}
                {jobs.panorama && <JobCard track={jobs.panorama} onCancel={() => cancelJob("panorama")} />}
                {jobs.frameReextract && <JobCard track={jobs.frameReextract} onCancel={() => cancelJob("frameReextract")} />}
              </div>

              {stitchedVideoArtifact && !jobs.panorama?.running && (
                <div style={{ marginTop: 14, padding: "10px 12px", background: "#f7f7f7", border: "1px solid #e8e8e8", borderRadius: 5 }}>
                  <div style={{ fontSize: 11, color: "#8a8a8a", marginBottom: 6 }}>
                    重新抽帧（复用已拼接的视频，不重新跑 GPU 拼接）
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      className="hs-input mono" type="number" style={{ width: 110 }}
                      value={reextractTimestamp}
                      onChange={(e) => setReextractTimestamp(Number(e.target.value) || 0)}
                    />
                    <span style={{ fontSize: 11, color: "#9a9a9a" }}>秒</span>
                    <button
                      className="hs-btn"
                      style={{ height: 26, fontSize: 11.5 }}
                      onClick={() => runFrameReextract(stitchedVideoArtifact.host_path)}
                      disabled={jobs.frameReextract?.running}
                    >
                      {jobs.frameReextract?.running ? "抽取中…" : "重新抽帧"}
                    </button>
                  </div>
                </div>
              )}

              {readyForPointSelect && (
                <button className="hs-btn hs-btn-primary" style={{ height: 28, marginTop: 14 }} onClick={() => setStage("select")}>
                  进入选点 →
                </button>
              )}
            </div>
          )}

          {session && (
            <div style={{ fontSize: 11.5, color: "#9a9a9a", lineHeight: 1.7 }}>
              M1-M3 里程碑：会话读取 + 静止判断 + 重建/拼接流水线接入 + 双视图选点。
              后续里程碑将接入标定求解（M4）。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileTag({ ext, present }: { ext: string; present: boolean }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 10.5, padding: "1px 7px", borderRadius: 10,
        background: present ? "rgba(65,205,82,.1)" : "#f0f0f0",
        color: present ? "#199a3e" : "#aaa",
        border: `1px solid ${present ? "rgba(65,205,82,.3)" : "#dcdcdc"}`,
      }}
    >
      {present ? "✓" : "✗"} {ext}
    </span>
  );
}

function StdBar({ label, value, threshold }: { label: string; value: number; threshold: number }) {
  // Full bar width = 3x threshold, so the threshold marker sits at 1/3 — gives
  // headroom to see how far over a moving session actually is.
  const scale = Math.max(threshold * 3, 0.001);
  const pct = Math.min(100, (value / scale) * 100);
  const thresholdPct = Math.min(100, (threshold / scale) * 100);
  const over = value >= threshold;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#666", marginBottom: 3 }}>
        <span className="mono">{label}</span>
        <span className="mono" style={{ color: over ? "#cf3a3f" : "#199a3e", fontWeight: 600 }}>{value.toFixed(5)}</span>
      </div>
      <div style={{ position: "relative", height: 8, background: "#f0f0f0", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, width: `${pct}%`, background: over ? "#e35d5d" : "#41cd52", transition: "width .15s" }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${thresholdPct}%`, width: 2, background: "#232323" }} title="阈值" />
      </div>
    </div>
  );
}

function StatusTag({ isStatic }: { isStatic: boolean | null }) {
  if (isStatic === null) return <span style={{ fontSize: 11.5, color: "#9a9a9a" }}>—</span>;
  return (
    <span
      className="mono"
      style={{
        fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 10, marginLeft: 4,
        background: isStatic ? "rgba(65,205,82,.12)" : "rgba(227,93,93,.12)",
        color: isStatic ? "#199a3e" : "#cf3a3f",
      }}
    >
      {isStatic ? "静止 STATIC" : "运动 MOTION"}
    </span>
  );
}

function JobCard({ track, onCancel }: { track: JobTrack; onCancel: () => void }) {
  const steps = Object.entries(track.stepStates);
  return (
    <div style={{ border: "1px solid #e8e8e8", borderRadius: 5, padding: "10px 12px", background: "#fafafa" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: steps.length ? 6 : 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#444" }}>{track.label}</span>
        <span className="mono" style={{ fontSize: 10.5, color: "#aaa" }}>{track.jobId.slice(0, 8)}</span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {track.running ? (
            <>
              <span style={{ fontSize: 11, color: "#e08a1c" }}>运行中…</span>
              <button className="hs-btn hs-btn-sm" onClick={onCancel}>取消</button>
            </>
          ) : track.failed ? (
            <span style={{ fontSize: 11, color: "#cf3a3f" }}>失败{track.reason ? `：${track.reason}` : ""}</span>
          ) : (
            <span style={{ fontSize: 11, color: "#199a3e" }}>完成</span>
          )}
        </span>
      </div>
      {steps.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: track.artifacts.length ? 6 : 0 }}>
          {steps.map(([step, state]) => <StepDot key={step} step={step} state={state} />)}
        </div>
      )}
      {track.artifacts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {track.artifacts.map((a) => (
            <div key={a.id} className="mono" style={{ fontSize: 10.5, color: "#8a8a8a", wordBreak: "break-all" }}>
              {a.output_id}: {a.host_path}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StepDot({ step, state }: { step: string; state: StepState }) {
  const color = state === "done" ? "#199a3e" : state === "failed" ? "#cf3a3f" : state === "running" ? "#e08a1c" : "#bbb";
  return (
    <span className="mono" style={{ fontSize: 10.5, color, display: "flex", alignItems: "center", gap: 3 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block" }} />
      {step}
    </span>
  );
}

function OverrideBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className="hs-btn"
      style={{
        height: 26, fontSize: 11, padding: "0 10px",
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

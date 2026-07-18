import React from "react";
import { api, Job, Artifact, basename, dirname } from "../api";

interface MapEntry {
  job: Job;
  artifacts: Artifact[];
  plyPath: string | null;
}

export function MemoryView() {
  const [maps, setMaps] = React.useState<MapEntry[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => { loadMaps(); }, []);

  async function loadMaps() {
    setLoading(true);
    try {
      const jobs = await api.listJobs();
      const completed = jobs.filter((j) => j.status === "completed");
      const entries: MapEntry[] = [];
      for (const job of completed) {
        try {
          const arts = await api.jobArtifacts(job.id);
          const ply = arts.find((a) => a.host_path.endsWith(".ply") || a.host_path.endsWith(".pcd") || a.output_id === "map") ?? null;
          entries.push({ job, artifacts: arts, plyPath: ply?.host_path ?? null });
        } catch { /* ignore */ }
      }
      setMaps(entries.filter((e) => e.artifacts.length > 0));
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }

  const inputName = (path: string) => basename(path).replace(/\.hera$/, "");

  return (
    <div className="hs-view">
      <div className="hs-view-toolbar">
        <span className="hs-view-title">空间记忆库</span>
        <span style={{ fontSize: 11, color: "#9a9a9a" }}>
          {loading ? "读取中…" : `${maps.length} 个地图`}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className="hs-btn" onClick={loadMaps}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
            刷新
          </button>
        </div>
      </div>

      <div className="hs-view-body" style={{ padding: 16 }}>
        {loading ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200, color: "#9a9a9a", fontSize: 13 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "hs-spin 1s linear infinite", marginRight: 8 }}>
              <path d="M21 12a9 9 0 1 1-6.2-8.5"/>
            </svg>
            读取任务历史…
          </div>
        ) : maps.length === 0 ? (
          <EmptyMemory />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
            {maps.map((entry) => (
              <MapCard key={entry.job.id} entry={entry} inputName={inputName} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Map card ──────────────────────────────────────────────────────────────────

function MapCard({ entry, inputName }: { entry: MapEntry; inputName: (p: string) => string }) {
  const { job, artifacts, plyPath } = entry;
  const created = new Date(job.started_at).toLocaleString("zh-CN");
  const finished = job.finished_at
    ? new Date(job.finished_at).toLocaleString("zh-CN")
    : null;

  return (
    <div className="hs-panel" style={{ display: "flex", flexDirection: "column" }}>
      {/* Thumbnail */}
      <div style={{
        height: 100,
        background: "linear-gradient(135deg, #0f172a 0%, #1a2744 60%, #0f2d1a 100%)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        position: "relative", padding: 10,
      }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(65,205,82,.5)" strokeWidth="1.2">
          <path d="M3 12l7-7 4 4 4-4 3 3"/>
          <path d="M3 20h18"/>
          <circle cx="7" cy="16" r="1.5" fill="rgba(65,205,82,.5)" stroke="none"/>
          <circle cx="12" cy="14" r="1.5" fill="rgba(65,205,82,.5)" stroke="none"/>
          <circle cx="17" cy="12" r="1.5" fill="rgba(65,205,82,.5)" stroke="none"/>
        </svg>
        <div style={{ position: "absolute", bottom: 7, left: 10, right: 10, display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,.5)", fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace" }}>
            {artifacts.length} 产物
          </span>
          {plyPath && (
            <span style={{ fontSize: 10, color: "rgba(65,205,82,.7)", fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace" }}>
              {basename(plyPath)}
            </span>
          )}
        </div>
      </div>

      {/* Info */}
      <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ fontWeight: 600, fontSize: 12.5, color: "#232323", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {inputName(job.input_path)}
        </div>
        <div style={{ fontSize: 11, color: "#8a8a8a", fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace" }}>
          {finished ?? created}
        </div>
        <div style={{ fontSize: 11, color: "#6d6d6d", marginTop: 2 }}>
          工作流: <span style={{ fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace" }}>{job.workflow_id}</span>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 6, padding: "0 10px 10px" }}>
        {plyPath && (
          <button
            className="hs-btn hs-btn-primary hs-btn-sm"
            onClick={() => api.openPath(plyPath)}
          >
            查看点云
          </button>
        )}
        <button
          className="hs-btn hs-btn-sm"
          onClick={() => api.openPath(dirname(job.input_path))}
        >
          打开目录
        </button>
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyMemory() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, color: "#9a9a9a", padding: 60 }}>
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity={.3}>
        <path d="M3 12l7-7 4 4 4-4 3 3"/>
        <path d="M3 20h18"/>
        <circle cx="7" cy="16" r="2"/><circle cx="12" cy="14" r="2"/><circle cx="17" cy="12" r="2"/>
      </svg>
      <div style={{ fontSize: 15, fontWeight: 600, color: "#6d6d6d" }}>暂无空间记忆</div>
      <div style={{ fontSize: 12.5, textAlign: "center", maxWidth: 320, lineHeight: 1.7 }}>
        完成一次 GLIM 激光重建任务后，结果会自动出现在这里。<br/>
        前往「运行」视图选择会话并执行重建工作流。
      </div>
    </div>
  );
}

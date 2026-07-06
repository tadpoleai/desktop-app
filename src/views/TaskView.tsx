import React from "react";
import { Select, Tooltip } from "antd";
import { api, Job, Artifact } from "../api";

const STATUS_INFO: Record<string, { cls: string; label: string; dot: string }> = {
  success:   { cls: "hs-tag-green",  label: "成功",  dot: "#199a3e" },
  failed:    { cls: "hs-tag-red",    label: "失败",  dot: "#cf3a3f" },
  running:   { cls: "hs-tag-blue",   label: "运行中", dot: "#2f6fd0" },
  cancelled: { cls: "hs-tag-amber",  label: "已取消", dot: "#b7791f" },
};

export function TaskView() {
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  const [artifacts, setArtifacts] = React.useState<Artifact[]>([]);
  const [statusFilter, setStatusFilter] = React.useState<string | null>(null);

  React.useEffect(() => { load(); }, []);

  React.useEffect(() => {
    let unlisten: (() => void) | null = null;
    api.onJobEvent((ev) => {
      if (ev.type === "job_complete" || ev.type === "job_failed") load();
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  async function load() {
    const data = await api.listJobs().catch(() => [] as Job[]);
    setJobs(data);
    if (selectedJobId) {
      const arts = await api.jobArtifacts(selectedJobId).catch(() => [] as Artifact[]);
      setArtifacts(arts);
    }
  }

  async function selectJob(id: string) {
    setSelectedJobId(id);
    const arts = await api.jobArtifacts(id).catch(() => [] as Artifact[]);
    setArtifacts(arts);
  }

  const displayJobs = statusFilter ? jobs.filter((j) => j.status === statusFilter) : jobs;
  const selectedJob = jobs.find((j) => j.id === selectedJobId);

  return (
    <div className="hs-view">
      {/* Toolbar */}
      <div className="hs-view-toolbar">
        <span className="hs-view-title">任务</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <Select
            placeholder="按状态筛选"
            allowClear
            size="small"
            style={{ width: 130 }}
            options={[
              { label: "成功", value: "success" },
              { label: "失败", value: "failed" },
              { label: "运行中", value: "running" },
            ]}
            onChange={(v) => setStatusFilter(v ?? null)}
          />
          <button className="hs-btn hs-btn-icon hs-btn-sm" onClick={load} title="刷新">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
          </button>
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="hs-view-body no-scroll" style={{ display: "flex", minHeight: 0 }}>
        {/* Left: job list */}
        <div style={{ flex: "0 0 340px", borderRight: "1px solid #e4e4e4", overflow: "auto" }}>
          {displayJobs.length === 0 ? (
            <div style={{ padding: "32px 16px", textAlign: "center", color: "#9a9a9a", fontSize: 12 }}>暂无任务</div>
          ) : displayJobs.map((j) => {
            const info = STATUS_INFO[j.status] ?? { cls: "hs-tag-gray", label: j.status, dot: "#c2c2c2" };
            const isSelected = j.id === selectedJobId;
            return (
              <div
                key={j.id}
                onClick={() => selectJob(j.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 16px",
                  borderBottom: "1px solid #f0f0f0",
                  cursor: "pointer",
                  background: isSelected ? "#eef7f0" : "transparent",
                }}
                onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "#f2f7f3"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = isSelected ? "#eef7f0" : "transparent"; }}
              >
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: info.dot, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontFamily: "'IBM Plex Mono', monospace", color: "#333", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {j.workflow_id}
                  </div>
                  <div style={{ fontSize: 11, color: "#9a9a9a", marginTop: 2 }}>
                    {new Date(j.started_at).toLocaleString("zh-CN")}
                  </div>
                </div>
                <span className={`hs-tag ${info.cls}`} style={{ fontSize: 10.5 }}>{info.label}</span>
              </div>
            );
          })}
        </div>

        {/* Right: artifacts */}
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {!selectedJobId ? (
            <div style={{ color: "#9a9a9a", fontSize: 12, padding: "32px 0", textAlign: "center" }}>
              选择左侧任务查看产物
            </div>
          ) : (
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>
                {selectedJob?.workflow_id ?? ""} — 产物
              </div>
              <table className="hs-table">
                <thead>
                  <tr>
                    <th>步骤</th>
                    <th>输出</th>
                    <th>路径</th>
                    <th style={{ width: 150 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {artifacts.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ padding: "24px 8px", textAlign: "center", color: "#9a9a9a", fontSize: 12 }}>
                        暂无产物（任务可能仍在运行）
                      </td>
                    </tr>
                  ) : artifacts.map((a) => {
                    const isDir = !/\.[^/]+$/.test(a.host_path);
                    const dirPath = isDir ? a.host_path : a.host_path.split("/").slice(0, -1).join("/");
                    const isViewable = /\.(ply|pcd|bag|db3)$/i.test(a.host_path);
                    return (
                      <tr key={a.id}>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>{a.step}</td>
                        <td style={{ color: "#555", fontSize: 12 }}>{a.output_id}</td>
                        <td>
                          <Tooltip title={a.host_path} placement="topLeft">
                            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#666" }}>
                              {a.host_path}
                            </span>
                          </Tooltip>
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 5 }}>
                            <button className="hs-btn hs-btn-sm" onClick={() => api.openPath(dirPath)}>
                              文件管理器
                            </button>
                            {isViewable && (
                              <button className="hs-btn hs-btn-sm" onClick={() => api.openPath(a.host_path)}>
                                查看
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

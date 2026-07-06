import React from "react";
import { Tooltip } from "antd";
import { open } from "@tauri-apps/plugin-dialog";
import { api, Dataset } from "../api";
import { toast } from "../components/toast";

const TYPE_TAG: Record<string, { cls: string }> = {
  hera:       { cls: "hs-tag-amber" },
  db3:        { cls: "hs-tag-purple" },
  bag:        { cls: "hs-tag-red" },
  pointcloud: { cls: "hs-tag-green" },
};

export function DataView() {
  const [datasets, setDatasets] = React.useState<Dataset[]>([]);
  const [scanPath, setScanPath] = React.useState("");
  const [scanning, setScanning] = React.useState(false);

  React.useEffect(() => { load(); }, []);

  async function load() {
    try { setDatasets(await api.listDatasets()); } catch { /* ignore */ }
  }

  async function browse() {
    const result = await open({ directory: true });
    if (result) setScanPath(result as string);
  }

  async function scan() {
    if (!scanPath) return;
    setScanning(true);
    try {
      const n = await api.scanDir(scanPath);
      toast.success(`扫描完成，索引了 ${n} 个文件`);
      await load();
    } catch (e: unknown) {
      toast.error(`扫描失败：${e}`);
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="hs-view">
      {/* Toolbar */}
      <div className="hs-view-toolbar">
        <span className="hs-view-title">数据集</span>
        <span style={{ fontSize: 11, color: "#9a9a9a" }}>已索引 {datasets.length} 项</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px", background: "#fff", border: "1px solid #c6c6c6", borderRadius: 4, width: 300 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9a9a9a" strokeWidth="2"><path d="M3 7h5l2-2h4l2 2h5v12H3z"/></svg>
            <input
              value={scanPath}
              onChange={(e) => setScanPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && scan()}
              placeholder="/home/.../Data"
              style={{ border: "none", outline: "none", background: "transparent", fontSize: 12, color: "#333", flex: 1, fontFamily: "'IBM Plex Mono', monospace" }}
            />
          </div>
          <button className="hs-btn" onClick={browse} disabled={scanning}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h5l2-2h4l2 2h5v12H3z"/></svg>
            浏览
          </button>
          <button className="hs-btn" onClick={scan} disabled={scanning || !scanPath}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h10M4 18h6"/></svg>
            {scanning ? "扫描中…" : "扫描"}
          </button>
          <button className="hs-btn hs-btn-icon" onClick={load} title="刷新">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="hs-view-body">
        <table className="hs-table">
          <thead>
            <tr>
              <th>路径</th>
              <th style={{ width: 110 }}>类型</th>
              <th style={{ width: 100 }}>大小</th>
              <th style={{ width: 130 }}>索引时间</th>
              <th style={{ width: 110 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {datasets.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: "32px 16px", textAlign: "center", color: "#9a9a9a" }}>
                  选择一个数据目录并点击「扫描」开始
                </td>
              </tr>
            ) : datasets.map((d) => (
              <tr key={d.id}>
                <td>
                  <Tooltip title={d.path} placement="topLeft">
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#333" }}>
                      {d.path}
                    </span>
                  </Tooltip>
                </td>
                <td>
                  <span className={`hs-tag ${TYPE_TAG[d.file_type]?.cls ?? "hs-tag-gray"}`}>
                    {d.file_type}
                  </span>
                </td>
                <td style={{ color: "#555", fontVariantNumeric: "tabular-nums", fontSize: 12.5 }}>
                  {formatSize(d.size_bytes)}
                </td>
                <td style={{ color: "#8a8a8a", fontSize: 11.5 }}>
                  {new Date(d.indexed_at).toLocaleString("zh-CN")}
                </td>
                <td>
                  <button
                    className="hs-btn hs-btn-sm"
                    onClick={() => {
                      const p = d.path;
                      const isDir = !/\.[^/]+$/.test(p);
                      const dir = isDir ? p : p.split("/").slice(0, -1).join("/");
                      api.openPath(dir);
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h5l2-2h4l2 2h5v12H3z"/></svg>
                    打开目录
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatSize(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

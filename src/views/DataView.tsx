import React from "react";
import { api, Dataset, HeraFileInfo, HeraSession, basename, dirname, parseSessionFilename } from "../api";
import { toast } from "../components/toast";

interface Props {
  onSessionOpen?: (session: HeraSession) => void;
  currentSession?: HeraSession | null;
}

export function DataView({ onSessionOpen, currentSession }: Props) {
  const [datasets, setDatasets]   = React.useState<Dataset[]>([]);
  const [selected, setSelected]   = React.useState<HeraSession | null>(null);
  const [loading, setLoading]     = React.useState(false);

  React.useEffect(() => { loadDatasets(); }, []);

  // Sync selection to global currentSession on first load
  React.useEffect(() => {
    if (currentSession && !selected) setSelected(currentSession);
  }, [currentSession]);

  async function loadDatasets() {
    try { setDatasets(await api.listDatasets()); } catch { /* ignore */ }
  }

  async function openFile() {
    const path = await api.pickFile(["hera"]);
    if (!path) return;
    setLoading(true);
    try {
      const session = await api.openHeraSession(path);
      await loadDatasets();
      selectSession(session);
    } catch (e) {
      toast.error(`打开失败：${e}`);
    } finally {
      setLoading(false);
    }
  }

  async function selectDataset(ds: Dataset) {
    setLoading(true);
    try {
      const session = await api.openHeraSession(ds.path);
      selectSession(session);
    } catch (e) {
      toast.error(`读取失败：${e}`);
    } finally {
      setLoading(false);
    }
  }

  function selectSession(session: HeraSession) {
    setSelected(session);
    onSessionOpen?.(session);
  }

  const heraSessions: Dataset[] = datasets
    .filter((d) => d.file_type === "hera")
    .sort((a, b) => new Date(b.indexed_at).getTime() - new Date(a.indexed_at).getTime());

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── Session list panel ── */}
      <div style={{ width: 260, flexShrink: 0, borderRight: "1px solid var(--hs-border)", display: "flex", flexDirection: "column", background: "#f7f7f7" }}>
        {/* Toolbar */}
        <div style={{ height: 38, borderBottom: "1px solid var(--hs-border)", display: "flex", alignItems: "center", gap: 6, padding: "0 10px", flexShrink: 0 }}>
          <span style={{ fontSize: 10.5, fontWeight: 600, color: "#6d6d6d", textTransform: "uppercase", letterSpacing: ".4px" }}>会话</span>
          <button
            className="hs-btn hs-btn-primary"
            style={{ marginLeft: "auto", height: 26, fontSize: 11.5, padding: "0 10px" }}
            onClick={openFile}
            disabled={loading}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M3 7h5l2-2h4l2 2h5v12H3z"/></svg>
            打开 .hera
          </button>
          <button className="hs-btn hs-btn-icon" onClick={loadDatasets} title="刷新" style={{ height: 26, width: 26 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
          </button>
        </div>

        {/* Session items */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {heraSessions.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "#9a9a9a", fontSize: 12 }}>
              点击「打开 .hera」<br/>或扫描数据目录
            </div>
          ) : heraSessions.map((ds) => {
            const parsed = parseSessionFilename(basename(ds.path).replace(/\.hera$/, ""));
            const isActive = selected?.path === ds.path;
            return (
              <div
                key={ds.id}
                onClick={() => selectDataset(ds)}
                style={{
                  padding: "9px 12px",
                  borderBottom: "1px solid #ebebeb",
                  cursor: "pointer",
                  background: isActive ? "rgba(65,205,82,.08)" : "transparent",
                  borderLeft: isActive ? "3px solid var(--hs-green)" : "3px solid transparent",
                  transition: "background .1s",
                }}
                onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,.04)"; }}
                onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
              >
                <div style={{ fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace", fontSize: 11, color: "#232323", fontWeight: 500, marginBottom: 3 }}>
                  {basename(ds.path).replace(/\.hera$/, "")}
                </div>
                <div style={{ fontSize: 11, color: "#8a8a8a", display: "flex", gap: 5 }}>
                  <span>{parsed.date}</span>
                  <span>·</span>
                  <span>{parsed.operator}</span>
                  <span>·</span>
                  <span>{parsed.place}</span>
                </div>
                <div style={{ marginTop: 4, display: "flex", gap: 4 }}>
                  {ds.size_bytes && (
                    <span className="hs-tag hs-tag-gray" style={{ fontSize: 9.5, padding: "1px 5px" }}>
                      {formatSize(ds.size_bytes)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Session detail ── */}
      <div style={{ flex: 1, overflowY: "auto", background: "#f2f2f2" }}>
        {!selected ? (
          <EmptyState onOpen={openFile} loading={loading} />
        ) : (
          <SessionDetail
            session={selected}
            onOpenInRun={() => onSessionOpen?.(selected)}
          />
        )}
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ onOpen, loading }: { onOpen: () => void; loading: boolean }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, color: "#9a9a9a", padding: 40 }}>
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity={.35}>
        <path d="M3 7h5l2-2h4l2 2h5v12H3z"/><path d="M9 12h6M9 15h4"/>
      </svg>
      <div style={{ fontSize: 15, fontWeight: 600, color: "#6d6d6d" }}>选择或打开会话</div>
      <div style={{ fontSize: 12.5, textAlign: "center", maxWidth: 280, lineHeight: 1.7 }}>
        点击「打开 .hera」选择一个采集会话，或从左侧列表中选择已索引的文件。
      </div>
      <button className="hs-btn hs-btn-primary" style={{ marginTop: 6 }} onClick={onOpen} disabled={loading}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M3 7h5l2-2h4l2 2h5v12H3z"/></svg>
        {loading ? "读取中…" : "打开 .hera 文件"}
      </button>
    </div>
  );
}

// ── Session detail ────────────────────────────────────────────────────────────

function SessionDetail({ session, onOpenInRun }: { session: HeraSession; onOpenInRun?: () => void }) {
  const sessionMeta = session.session_json ? (() => {
    try { return JSON.parse(session.session_json!); } catch { return null; }
  })() : null;

  const [heraInfo, setHeraInfo] = React.useState<HeraFileInfo | null>(null);
  const [heraInfoError, setHeraInfoError] = React.useState<string | null>(null);
  const [heraInfoLoading, setHeraInfoLoading] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setHeraInfo(null);
    setHeraInfoError(null);
    setHeraInfoLoading(true);
    api.heraFileInfo(session.path)
      .then((info) => { if (!cancelled) setHeraInfo(info); })
      .catch((e) => { if (!cancelled) setHeraInfoError(String(e)); })
      .finally(() => { if (!cancelled) setHeraInfoLoading(false); });
    return () => { cancelled = true; };
  }, [session.path]);

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ background: "#fff", borderBottom: "1px solid var(--hs-border)", padding: "14px 18px 12px" }}>
        <div style={{ fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace", fontSize: 13.5, fontWeight: 600, color: "#232323", display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
          {session.stem}
          <span style={{ fontSize: 11, color: "#9a9a9a", fontFamily: "inherit", fontWeight: 400 }}>.hera 采集会话</span>
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          <span style={{ background: "#f0f0f0", border: "1px solid #dcdcdc", borderRadius: 12, padding: "2px 9px", fontSize: 11, color: "#555", fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace" }}>
            {session.date} {session.time}
          </span>
          <span style={{ background: "#f0f0f0", border: "1px solid #dcdcdc", borderRadius: 12, padding: "2px 9px", fontSize: 11, color: "#555", display: "flex", alignItems: "center", gap: 4 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
            {session.operator}
          </span>
          <span style={{ background: "#f0f0f0", border: "1px solid #dcdcdc", borderRadius: 12, padding: "2px 9px", fontSize: 11, color: "#555", display: "flex", alignItems: "center", gap: 4 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"/><circle cx="12" cy="9" r="2"/></svg>
            {session.place}
          </span>
        </div>
      </div>

      {/* Hera header metadata (parsed from the binary file header — see hera-sdk-python) */}
      <Section title="元数据">
        {heraInfoLoading && (
          <div style={{ fontSize: 12, color: "#9a9a9a" }}>解析文件头…</div>
        )}
        {heraInfoError && (
          <div style={{ fontSize: 12, color: "#cf3a3f" }}>解析失败：{heraInfoError}</div>
        )}
        {heraInfo && (
          <>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
              <span className="hs-tag hs-tag-green mono" style={{ fontSize: 11 }}>V{heraInfo.version}</span>
              <span style={{ fontSize: 11, color: "#6d6d6d", fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace" }}>
                {formatNs(heraInfo.timestamp_start_ns)} → {formatNs(heraInfo.timestamp_end_ns)}
              </span>
              <span style={{ fontSize: 11, color: "#6d6d6d", fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace" }}>
                时长 {heraInfo.duration_s.toFixed(3)} s
              </span>
            </div>

            {/* Per-device table */}
            <div style={{ border: "1px solid #e2e2e2", borderRadius: 5, overflow: "hidden", marginBottom: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                <thead>
                  <tr style={{ background: "#f7f7f7", textAlign: "left" }}>
                    <th style={thStyle}>ID</th>
                    <th style={thStyle}>设备</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>消息数</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>数据量</th>
                  </tr>
                </thead>
                <tbody>
                  {heraInfo.devices.map((d) => (
                    <tr key={d.id} style={{ borderTop: "1px solid #ececec" }}>
                      <td style={tdStyle}>{d.id}</td>
                      <td style={{ ...tdStyle, fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace" }}>{d.name}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>{d.message_count.toLocaleString()}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>{formatSize(d.data_bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* extra_info blob */}
            {heraInfo.extra_info != null && (
              <details>
                <summary style={{ cursor: "pointer", fontSize: 11.5, color: "#199a3e", userSelect: "none" }}>
                  附加信息 (extra_info)
                </summary>
                <pre style={{
                  marginTop: 8, padding: 10, background: "#f7f7f7", border: "1px solid #e2e2e2",
                  borderRadius: 5, fontSize: 11, lineHeight: 1.5, maxHeight: 320, overflow: "auto",
                  fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace",
                }}>
                  {JSON.stringify(heraInfo.extra_info, null, 2)}
                </pre>
              </details>
            )}
          </>
        )}
        {sessionMeta?.record_start_host_ns && (
          <div style={{ marginTop: 10, fontSize: 11, color: "#8a8a8a", fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace" }}>
            record_start_host_ns: {sessionMeta.record_start_host_ns}
          </div>
        )}
      </Section>

      {/* Files */}
      <Section title="关联文件">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <FileCard
            icon="H" iconBg="#cffafe" iconColor="#06b6d4"
            ext=".hera" size={session.hera_size}
            present={true} note="陀螺仪 · Livox 点云/IMU"
          />
          <FileCard
            icon="V" iconBg="#ede9fe" iconColor="#8b5cf6"
            ext=".insv" size={session.insv_size}
            present={!!session.insv_path} note="双鱼眼原始视频"
          />
          <FileCard
            icon="J" iconBg="#fef3c7" iconColor="#f59e0b"
            ext=".session.json" size={session.session_json_size}
            present={!!session.session_json} note="record_start_host_ns · mp4_files"
          />
        </div>
      </Section>

      {/* Path */}
      <Section title="文件路径">
        <div style={{ fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace", fontSize: 11.5, color: "#555", wordBreak: "break-all", lineHeight: 1.7 }}>
          {session.path}
        </div>
      </Section>

      {/* Actions */}
      <Section title="操作" noBorder>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="hs-btn hs-btn-primary" onClick={onOpenInRun} style={{ height: 30 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            开始重建…
          </button>
          <button className="hs-btn" style={{ height: 30 }} onClick={() => api.openPath(dirname(session.path))}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h5l2-2h4l2 2h5v12H3z"/></svg>
            打开目录
          </button>
        </div>
      </Section>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Section({ title, children, noBorder }: { title: string; children: React.ReactNode; noBorder?: boolean }) {
  return (
    <div style={{ padding: "14px 18px", borderBottom: noBorder ? "none" : "1px solid #e8e8e8" }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: "#8a8a8a", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function FileCard({ icon, iconBg, iconColor, ext, size, present, note }: {
  icon: string; iconBg: string; iconColor: string;
  ext: string; size: number | null; present: boolean; note: string;
}) {
  return (
    <div style={{ background: "#fff", border: "1px solid var(--hs-border)", borderRadius: 5, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
        <div style={{ width: 18, height: 18, borderRadius: 3, background: present ? iconBg : "#f0f0f0", color: present ? iconColor : "#bbb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10.5, fontWeight: 700, flexShrink: 0 }}>
          {icon}
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace", color: present ? "#232323" : "#aaa" }}>
          {ext}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "#8a8a8a", fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace" }}>
        {size != null ? formatSize(size) : "—"}
      </div>
      <div style={{ fontSize: 10.5, color: present ? "#2ba63d" : "#9a9a9a" }}>
        {present ? `✓ ${note}` : `✗ 未找到`}
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: "6px 10px", fontSize: 10.5, fontWeight: 600, color: "#8a8a8a", textTransform: "uppercase", letterSpacing: ".3px" };
const tdStyle: React.CSSProperties = { padding: "6px 10px", color: "#333" };

/** Nanosecond epoch timestamp -> local date/time string. */
function formatNs(ns: number): string {
  if (!Number.isFinite(ns) || ns <= 0) return "—";
  return new Date(ns / 1e6).toLocaleString();
}

function formatSize(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

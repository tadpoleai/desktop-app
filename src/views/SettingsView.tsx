import React from "react";
import { Switch } from "antd";
import { toast } from "../components/toast";
import { api, AppConfig } from "../api";

interface Props {
  onConfigSaved?: (cfg: AppConfig) => void;
}

export function SettingsView({ onConfigSaved }: Props) {
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [vals, setVals] = React.useState({
    container: "docker",
    gpu_enabled: false,
    output_dir: "",
    data_dir: "",
    glim_config_dir: "",
    pointcloud_viewer: "",
  });

  React.useEffect(() => {
    setLoading(true);
    api.getConfig()
      .then((cfg) => {
        setVals({
          container:        cfg.runtime?.container ?? "docker",
          gpu_enabled:      cfg.runtime?.gpu_enabled ?? false,
          output_dir:       cfg.data?.output_dir ?? "",
          data_dir:         cfg.data?.data_dir ?? "",
          glim_config_dir:  cfg.data?.glim_config_dir ?? "",
          pointcloud_viewer: cfg.viewers?.pointcloud_viewer ?? "",
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function set(key: string, value: unknown) {
    setVals((v) => ({ ...v, [key]: value }));
  }

  async function save() {
    const cfg: AppConfig = {
      runtime: { container: vals.container, gpu_enabled: vals.gpu_enabled },
      data: {
        output_dir:      vals.output_dir || undefined,
        data_dir:        vals.data_dir || undefined,
        glim_config_dir: vals.glim_config_dir || undefined,
      },
      viewers: { pointcloud_viewer: vals.pointcloud_viewer || undefined },
      registry: { db_path: "" },
    };
    setSaving(true);
    try {
      await api.setConfig(cfg);
      onConfigSaved?.(cfg);
      toast.success("设置已保存");
    } catch (e: unknown) {
      toast.error(`保存失败：${e}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="hs-view">
        <div style={{ padding: 32, textAlign: "center", color: "#9a9a9a" }}>加载中…</div>
      </div>
    );
  }

  return (
    <div className="hs-view">
      <div className="hs-view-toolbar">
        <span className="hs-view-title">设置</span>
      </div>

      <div className="hs-view-body" style={{ padding: 20 }}>
        <div style={{ maxWidth: 640, background: "#fff", border: "1px solid #e2e2e2", borderRadius: 6, padding: 18 }}>

          {/* 运行时 */}
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 12, color: "#444" }}>运行时</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 16px", marginBottom: 8 }}>
            <div className="hs-input-group">
              <label className="hs-input-label">
                容器运行时 <span style={{ color: "#b0b0b0" }}>— docker 或 podman</span>
              </label>
              <input
                className="hs-input mono"
                value={vals.container}
                onChange={(e) => set("container", e.target.value)}
                placeholder="docker"
              />
            </div>
            <div className="hs-input-group">
              <label className="hs-input-label">启用 GPU</label>
              <div style={{ height: 28, display: "flex", alignItems: "center" }}>
                <Switch
                  checked={vals.gpu_enabled}
                  onChange={(v) => set("gpu_enabled", v)}
                  size="small"
                />
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: "#eee", margin: "14px 0" }} />

          {/* 目录 */}
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 12, color: "#444" }}>目录</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="hs-input-group">
              <label className="hs-input-label">
                输出目录 <span style={{ color: "#b0b0b0" }}>— 留空则使用 ./hera-output</span>
              </label>
              <input
                className="hs-input mono"
                value={vals.output_dir}
                onChange={(e) => set("output_dir", e.target.value)}
                placeholder="留空使用默认值"
              />
            </div>
            <div className="hs-input-group">
              <label className="hs-input-label">
                数据目录 <span style={{ color: "#b0b0b0" }}>— 默认扫描路径</span>
              </label>
              <input
                className="hs-input mono"
                value={vals.data_dir}
                onChange={(e) => set("data_dir", e.target.value)}
                placeholder="可选"
              />
            </div>
            <div className="hs-input-group">
              <label className="hs-input-label">
                GLIM 配置目录 <span style={{ color: "#b0b0b0" }}>— 留空自动缓存到 ~/.cache/hera</span>
              </label>
              <input
                className="hs-input mono"
                value={vals.glim_config_dir}
                onChange={(e) => set("glim_config_dir", e.target.value)}
                placeholder="留空使用默认值"
              />
            </div>
          </div>

          <div style={{ height: 1, background: "#eee", margin: "14px 0" }} />

          {/* 外部工具 */}
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 12, color: "#444" }}>外部工具</div>
          <div className="hs-input-group" style={{ marginBottom: 16, maxWidth: 280 }}>
            <label className="hs-input-label">
              点云查看器 <span style={{ color: "#b0b0b0" }}>— 如 cloudcompare、meshlab</span>
            </label>
            <input
              className="hs-input mono"
              value={vals.pointcloud_viewer}
              onChange={(e) => set("pointcloud_viewer", e.target.value)}
              placeholder="cloudcompare"
            />
          </div>

          <button className="hs-btn hs-btn-primary" onClick={save} disabled={saving} style={{ height: 30 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5V3h11l5 5v13z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

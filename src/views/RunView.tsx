import React from "react";
import { Form, Input, Select } from "antd";
import { open } from "@tauri-apps/plugin-dialog";
import { api, WorkflowDetail, WorkflowSummary, JobEvent, ParamSchema, NodeDetail } from "../api";
import { toast } from "../components/toast";
import Form2 from "@rjsf/antd";
import validator from "@rjsf/validator-ajv8";
import type { RJSFSchema } from "@rjsf/utils";

type StepState = "pending" | "running" | "done" | "failed";

interface Props {
  onCrumbChange?: (s: string) => void;
}

export function RunView({ onCrumbChange }: Props) {
  const [workflows, setWorkflows] = React.useState<WorkflowSummary[]>([]);
  const [selected, setSelected] = React.useState<WorkflowDetail | null>(null);
  const [inputPath, setInputPath] = React.useState("");
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [stepStates, setStepStates] = React.useState<Record<string, StepState>>({});
  const [running, setRunning] = React.useState(false);
  const [rjsfData, setRjsfData] = React.useState<Record<string, Record<string, unknown>>>({});
  const [nodeVersions, setNodeVersions] = React.useState<Record<string, string>>({});
  const [form] = Form.useForm();

  React.useEffect(() => {
    api.listWorkflows().then(setWorkflows).catch(() => {});
  }, []);

  // Subscribe to job events for step states
  React.useEffect(() => {
    let unlisten: (() => void) | null = null;
    api.onJobEvent(handleEvent).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [jobId]);

  function handleEvent(ev: JobEvent) {
    if (jobId && ev.job !== jobId) return;
    switch (ev.type) {
      case "step_start":
        setStepStates((s) => ({ ...s, [ev.step!]: "running" }));
        break;
      case "step_complete":
        setStepStates((s) => ({ ...s, [ev.step!]: "done" }));
        break;
      case "step_failed":
        setStepStates((s) => ({ ...s, [ev.step!]: "failed" }));
        break;
      case "job_complete":
        setRunning(false);
        break;
      case "job_failed":
        setRunning(false);
        break;
    }
  }

  async function selectWorkflow(id: string) {
    const wf = await api.getWorkflow(id);
    setSelected(wf);
    setInputPath("");
    setJobId(null);
    setStepStates({});
    onCrumbChange?.(wf.name + " › 配置与执行");

    const rjsf: Record<string, Record<string, unknown>> = {};
    const versions: Record<string, string> = {};
    for (const node of wf.nodes) {
      versions[node.id] = node.version ?? "latest";
      if (node.params_schema) {
        const props = (node.params_schema as { properties?: Record<string, { default?: unknown }> }).properties ?? {};
        const defaults: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if ("default" in v) defaults[k] = v.default;
        }
        rjsf[node.id] = { ...defaults, ...node.params };
      }
    }
    setRjsfData(rjsf);
    setNodeVersions(versions);

    const values: Record<string, unknown> = {};
    for (const node of wf.nodes) {
      for (const p of node.param_schema) {
        values[`${node.id}__${p.id}`] = node.params[p.id] ?? p.default;
      }
    }
    form.setFieldsValue(values);
  }

  function goBack() {
    setSelected(null);
    onCrumbChange?.("");
  }

  async function browseInput() {
    if (!selected) return;
    const isDir = selected.input.type === "dir";
    const result = await open({
      directory: isDir,
      multiple: false,
      filters: !isDir && selected.input.ext
        ? [{ name: "Input files", extensions: selected.input.ext.map((e) => e.replace(".", "")) }]
        : undefined,
    });
    if (result) setInputPath(result as string);
  }

  async function startRun() {
    if (!inputPath.trim() || !selected) return;

    const paramOverrides: Record<string, Record<string, unknown>> = {};
    for (const node of selected.nodes) {
      if (node.params_schema) {
        paramOverrides[node.id] = rjsfData[node.id] ?? {};
      } else {
        const values = form.getFieldsValue();
        paramOverrides[node.id] = {};
        for (const p of node.param_schema) {
          const key = `${node.id}__${p.id}`;
          if (key in values) paramOverrides[node.id][p.id] = values[key];
        }
      }
    }

    const initStates: Record<string, StepState> = {};
    for (const node of selected.nodes) initStates[node.id] = "pending";
    setStepStates(initStates);
    setRunning(true);

    try {
      const jid = await api.runWorkflow(selected.id, inputPath.trim(), paramOverrides);
      setJobId(jid);
    } catch (e: unknown) {
      toast.error(`启动失败: ${e}`);
      setRunning(false);
    }
  }

  async function cancelRun() {
    if (jobId) {
      await api.cancelJob(jobId);
      setRunning(false);
    }
  }

  async function onVersionChange(nodeId: string, version: string) {
    setNodeVersions((v) => ({ ...v, [nodeId]: version }));
    if (!selected) return;
    try {
      const manifest = await api.operatorDescribe(
        selected.nodes.find((n) => n.id === nodeId)?.operator ?? nodeId,
        version,
      ) as { params_schema?: { properties?: Record<string, { default?: unknown }> } } | null;
      if (manifest?.params_schema) {
        const props = manifest.params_schema.properties ?? {};
        const defaults: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if ("default" in v) defaults[k] = v.default;
        }
        setRjsfData((d) => ({ ...d, [nodeId]: defaults }));
        setSelected((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            nodes: prev.nodes.map((n) =>
              n.id === nodeId
                ? { ...n, params_schema: manifest.params_schema as Record<string, unknown> }
                : n
            ),
          };
        });
      }
    } catch { /* ignore */ }
  }

  // ── Workflow picker ──
  if (!selected) {
    return (
      <div className="hs-view">
        <div className="hs-view-toolbar">
          <span className="hs-view-title">运行工作流</span>
          <span style={{ fontSize: 12, color: "#9a9a9a" }}>选择一个工作流开始配置并执行</span>
        </div>
        <div className="hs-view-body" style={{ padding: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12, maxWidth: 720 }}>
            {workflows.map((wf) => (
              <WfCard key={wf.id} wf={wf} onPick={() => selectWorkflow(wf.id)} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Config + run ──
  return (
    <div className="hs-view">
      {/* Sub-toolbar */}
      <div className="hs-view-toolbar">
        <button className="hs-btn hs-btn-sm" onClick={goBack}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6"/></svg>
          返回
        </button>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{selected.name}</span>
      </div>

      <div className="hs-view-body" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Input file/dir */}
        <div className="hs-panel">
          <div className="hs-panel-bd" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <div style={{ fontSize: 12, color: "#6d6d6d" }}>{selected.input.label}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="hs-input mono"
                style={{ flex: 1 }}
                value={inputPath}
                onChange={(e) => setInputPath(e.target.value)}
                placeholder="输入路径，或点击右侧浏览…"
              />
              <button className="hs-btn" onClick={browseInput}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h5l2-2h4l2 2h5v12H3z"/></svg>
                浏览
              </button>
            </div>
          </div>
        </div>

        {/* Param forms per node */}
        {selected.nodes.map((node) => (
          <NodeParamCard
            key={node.id}
            node={node}
            version={nodeVersions[node.id] ?? node.version ?? "latest"}
            rjsfFormData={rjsfData[node.id] ?? {}}
            legacyForm={form}
            onVersionChange={(v) => onVersionChange(node.id, v)}
            onRjsfChange={(data) => setRjsfData((d) => ({ ...d, [node.id]: data }))}
          />
        ))}

        {/* Run / Cancel */}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            className="hs-btn hs-btn-primary"
            style={{ height: 32, fontSize: 13 }}
            onClick={startRun}
            disabled={running || !inputPath.trim()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            运行
          </button>
          {running && (
            <>
              <button
                className="hs-btn"
                style={{ borderColor: "#d88", color: "#cf3a3f" }}
                onClick={cancelRun}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                取消
              </button>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#199a3e" }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "hs-spin 1s linear infinite" }}>
                  <path d="M21 12a9 9 0 1 1-6.2-8.5"/>
                </svg>
                正在执行…
              </span>
            </>
          )}
        </div>

        {/* Progress steps */}
        {Object.keys(stepStates).length > 0 && (
          <div className="hs-panel">
            <div className="hs-panel-hd">
              <span style={{ fontSize: 12, color: "#6d6d6d" }}>进度</span>
            </div>
            <div className="hs-panel-bd" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {selected.nodes.map((node) => {
                const state = stepStates[node.id] ?? "pending";
                const stateLabels: Record<string, string> = { pending: "等待", running: "运行中", done: "完成", failed: "失败" };
                const stateColors: Record<string, string> = { pending: "#c2c2c2", running: "#199a3e", done: "#199a3e", failed: "#cf3a3f" };
                return (
                  <div key={node.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: "#f7f7f7", borderRadius: 4 }}>
                    <span className={`hs-dot ${state}`} />
                    <span style={{ fontSize: 12.5, fontFamily: "'IBM Plex Mono', monospace" }}>{node.id}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11.5, color: stateColors[state] }}>{stateLabels[state]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Workflow picker card ──
function WfCard({ wf, onPick }: { wf: WorkflowSummary; onPick: () => void }) {
  const [hovered, setHovered] = React.useState(false);
  return (
    <div
      onClick={onPick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        cursor: "pointer", background: "#fff",
        border: `1px solid ${hovered ? "#41cd52" : "#e0e0e0"}`,
        borderRadius: 8, padding: 16,
        boxShadow: hovered ? "0 2px 10px rgba(65,205,82,.14)" : "none",
        transition: "border-color .12s, box-shadow .12s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
        <span style={{ width: 30, height: 30, borderRadius: 7, background: "rgba(65,205,82,.14)", display: "flex", alignItems: "center", justifyContent: "center", color: "#199a3e" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </span>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{wf.name}</span>
      </div>
      <div style={{ fontSize: 12, color: "#7a7a7a", lineHeight: 1.5, marginBottom: 10 }}>{wf.description}</div>
      {wf.input.ext && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {wf.input.ext.map((e) => (
            <span key={e} className="hs-tag hs-tag-gray mono" style={{ fontSize: 11 }}>{e}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Node param card ──
interface NodeParamCardProps {
  node: NodeDetail;
  version: string;
  rjsfFormData: Record<string, unknown>;
  legacyForm: ReturnType<typeof Form.useForm>[0];
  onVersionChange: (v: string) => void;
  onRjsfChange: (data: Record<string, unknown>) => void;
}

function NodeParamCard({ node, version, rjsfFormData, legacyForm, onVersionChange, onRjsfChange }: NodeParamCardProps) {
  const hasRjsf = !!node.params_schema;

  return (
    <div className="hs-panel">
      <div className="hs-panel-hd">
        <span style={{ fontSize: 12, color: "#6d6d6d" }}>{node.operator} 参数</span>
        <span className="hs-tag hs-tag-green mono">{version}</span>
        {node.available_versions.length > 0 && (
          <Select
            size="small"
            value={version}
            onChange={onVersionChange}
            options={node.available_versions.map((v) => ({ label: v, value: v }))}
            style={{ width: 140, marginLeft: 4 }}
            placeholder="选择版本"
          />
        )}
      </div>
      <div className="hs-panel-bd">
        {hasRjsf ? (
          <Form2
            schema={node.params_schema as RJSFSchema}
            formData={rjsfFormData}
            validator={validator}
            onChange={(e) => onRjsfChange(e.formData as Record<string, unknown>)}
            uiSchema={{ "ui:submitButtonOptions": { norender: true } }}
            liveValidate={false}
          />
        ) : (
          <Form form={legacyForm} layout="vertical" size="small">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "0 16px" }}>
              {node.param_schema.map((p) => (
                <LegacyParamField key={p.id} nodeId={node.id} param={p} form={legacyForm} />
              ))}
            </div>
          </Form>
        )}
      </div>
    </div>
  );
}

function LegacyParamField({ nodeId, param: p, form }: { nodeId: string; param: ParamSchema; form: ReturnType<typeof Form.useForm>[0] }) {
  const name = `${nodeId}__${p.id}`;
  const label = (
    <span style={{ fontSize: 11, color: "#7a7a7a" }}>
      {p.label ?? p.id}
      {p.description && <span style={{ color: "#b0b0b0", fontSize: 10.5, marginLeft: 4 }}>— {p.description}</span>}
    </span>
  );

  if (p.type === "enum") {
    return (
      <Form.Item name={name} label={label}>
        <Select size="small" options={(p.values ?? []).map((v) => ({ label: v, value: v }))} />
      </Form.Item>
    );
  }
  if (p.type === "bool") {
    return (
      <Form.Item name={name} label={label} valuePropName="checked">
        <input type="checkbox" style={{ width: 14, height: 14 }} />
      </Form.Item>
    );
  }
  if (p.type === "number[3]") {
    return (
      <Form.Item label={label} style={{ gridColumn: "span 2" }}>
        <div style={{ display: "flex", gap: 8 }}>
          {[0, 1, 2].map((idx) => (
            <Form.Item key={idx} name={[name, idx]} noStyle>
              <Input size="small" style={{ width: 80, fontFamily: "'IBM Plex Mono', monospace", textAlign: "center" }} />
            </Form.Item>
          ))}
        </div>
      </Form.Item>
    );
  }
  if (p.type === "number") {
    return (
      <Form.Item name={name} label={label}>
        <Input size="small" style={{ fontFamily: "'IBM Plex Mono', monospace" }} />
      </Form.Item>
    );
  }
  return (
    <Form.Item name={name} label={label}>
      <Input size="small" style={{ fontFamily: "'IBM Plex Mono', monospace" }} />
    </Form.Item>
  );
}

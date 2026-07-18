import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";

export interface Dataset {
  id: string;
  path: string;
  file_type: string;
  size_bytes: number | null;
  meta_json: string | null;
  indexed_at: string;
}

/** A fully parsed hera recording session (3-file bundle: .hera + .insv + .session.json). */
export interface HeraSession {
  path: string;
  stem: string;
  /** Parsed from stem: "YYYY-MM-DD" */
  date: string;
  /** Parsed from stem: "HH:MM:SS" */
  time: string;
  /** Parsed from stem: second segment after timestamp */
  operator: string;
  /** Parsed from stem: remaining segments joined with "_" */
  place: string;
  hera_size: number;
  insv_path: string | null;
  insv_size: number | null;
  session_json: string | null;
  session_json_size: number | null;
}

/** Basename of a path, tolerant of both `/` (Unix) and `\` (Windows) separators —
 *  paths come from the Rust backend's `PathBuf` serialization, which is
 *  platform-native and never normalized to `/`. */
export function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Parent directory of a path, tolerant of both `/` and `\` separators. */
export function dirname(path: string): string {
  const parts = path.split(/[/\\]/);
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  parts.pop();
  return parts.join(sep);
}

export function parseSessionFilename(stem: string): Pick<HeraSession, "date" | "time" | "operator" | "place"> {
  const parts = stem.split("_");
  if (parts.length >= 3 && parts[0].length === 14) {
    const ts = parts[0];
    return {
      date: `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`,
      time: `${ts.slice(8,10)}:${ts.slice(10,12)}:${ts.slice(12,14)}`,
      operator: parts[1],
      place: parts.slice(2).join("_"),
    };
  }
  return { date: "?", time: "?", operator: "?", place: stem };
}

export interface HeraDeviceInfo {
  id: number;
  name: string;
  message_count: number;
  data_bytes: number;
}

/** Parsed `.hera` binary file header (version/time range/per-device stats/extra_info). */
export interface HeraFileInfo {
  version: number;
  timestamp_start_ns: number;
  timestamp_end_ns: number;
  duration_s: number;
  devices: HeraDeviceInfo[];
  extra_info: unknown;
}

export interface Job {
  id: string;
  workflow_id: string;
  input_path: string;
  params_json: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
}

export interface Artifact {
  id: string;
  job_id: string;
  step: string;
  output_id: string;
  host_path: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  input: { type: string; ext?: string[]; label: string };
}

export interface ParamSchema {
  id: string;
  type: string;
  label?: string;
  description?: string;
  values?: string[];
  default: unknown;
}

export interface NodeDetail {
  id: string;
  operator: string;
  version: string;
  available_versions: string[];
  params: Record<string, unknown>;
  params_schema?: Record<string, unknown>;
  /** `null` when the operator manifest couldn't be resolved (not yet registered, etc.) — not just possibly-empty. */
  param_schema: ParamSchema[] | null;
}

export interface WorkflowDetail extends WorkflowSummary {
  nodes: NodeDetail[];
  edges: { from_node: string; from_output: string; to_node: string; to_input: string }[];
  workflow_input_to: { node: string; input: string };
}

export interface JobEvent {
  type: string;
  job: string;
  step?: string;
  text?: string;
  is_stderr?: boolean;
  image?: string;
  exit_code?: number;
  reason?: string;
  artifacts?: Artifact[];
}

export interface AppConfig {
  runtime: { container: string; gpu_enabled: boolean };
  data: { data_dir?: string; output_dir?: string; glim_config_dir?: string };
  viewers: { pointcloud_viewer?: string };
  registry: { db_path: string };
}

export interface OfficialOperator {
  id: string;
  name: string;
  description: string;
  imageRef: string;
  latestTag: string;
  /** Full operator manifest JSON. Passed to operator_add to bypass --describe for images
   *  that use ROS entrypoints and don't implement the self-describe protocol. */
  manifest: Record<string, unknown>;
}

export const OFFICIAL_OPERATORS: OfficialOperator[] = [
  {
    id: "glim-recon",
    name: "GLIM 激光重建",
    description: "基于 GLIM 框架的 LiDAR-IMU 点云重建算子，支持 Mid-360 / Livox 传感器",
    imageRef: "crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/glim-runner",
    latestTag: "r0.6",
    manifest: {
      spec: "1",
      id: "glim-recon",
      name: "GLIM 激光重建",
      version: "r0.6",
      gpu: "optional",
      mounts: [
        {
          id: "config",
          host: "",
          container: "/glim/config",
          mode: "rw",
          image_config_path: "/opt/glim_offline/share/glim/config",
        },
      ],
      inputs: [
        { id: "scan", type: "file", ext: [".hera", ".db3"], container: "/data/input" },
      ],
      outputs: [
        { id: "map", type: "dir", container: "/output/map" },
      ],
      params_schema: {
        type: "object",
        properties: {
          window:                  { type: "number",  default: 0.1,        title: "时间窗口(秒)",        description: "点云积累时间窗口（秒）" },
          mode:                    { type: "string",  enum: ["cpu","gpu"],  default: "cpu",               title: "计算模式" },
          imu_topic:               { type: "string",  default: "/lidar/mid360/imu",             title: "IMU Topic",    description: "仅 .db3 输入时使用" },
          points_topic:            { type: "string",  default: "/lidar/mid360/point_cloud2",    title: "点云 Topic",   description: "仅 .db3 输入时使用" },
          t_lidar_imu:             { type: "array",   items: { type: "number" }, minItems: 7, maxItems: 7, default: [0,0,0,0,0,0,1], title: "激光-IMU 外参 (TUM: x y z qx qy qz qw)", description: "Mid-360 同轴安装默认 identity" },
          mounting_rpy:            { type: "array",   items: { type: "number" }, minItems: 3, maxItems: 3, default: [0,0,0], title: "安装角 RPY (度, ZYX)", description: "正置=[0,0,0]；倒置 pitch180=[0,180,0]" },
          imu_acc_noise:           { type: "number",  default: 0.05,       title: "IMU 加速度噪声",      description: "调高可降低 IMU 权重" },
          keyframe_strategy:       { type: "string",  enum: ["OVERLAP","DISPLACEMENT"], default: "OVERLAP", title: "关键帧策略", description: "DISPLACEMENT 适用于静止/短距场景" },
          keyframe_interval_trans: { type: "number",  default: 1.0,        title: "关键帧间距(m)",       description: "DISPLACEMENT 策略下最小位移（米）" },
        },
      },
      params_bindings: {
        window:                  { mode: "arg", flag: "--window" },
        mode:                    { mode: "config_switch_suffix", file: "config.json", parent: "global", keys: ["config_odometry","config_sub_mapping","config_global_mapping"] },
        imu_topic:               { mode: "arg", flag: "--imu-topic",    condition: "input_ext=.db3" },
        points_topic:            { mode: "arg", flag: "--points-topic", condition: "input_ext=.db3" },
        t_lidar_imu:             { mode: "config_patch", file: "config_sensors.json", jsonpath: "$.sensors.T_lidar_imu" },
        mounting_rpy:            { mode: "config_rpy_patch", file: "config_sensors.json", t_field: "$.sensors.T_lidar_imu", rpy_field: "$.sensors.lidar_mounting_rpy" },
        imu_acc_noise:           { mode: "config_patch", file: "config_sensors.json", jsonpath: "$.sensors.imu_acc_noise" },
        keyframe_strategy:       { mode: "config_patch", file: "config_sub_mapping_cpu.json", jsonpath: "$.sub_mapping.keyframe_update_strategy" },
        keyframe_interval_trans: { mode: "config_patch", file: "config_sub_mapping_cpu.json", jsonpath: "$.sub_mapping.keyframe_update_interval_trans" },
      },
      exit_codes_ok: [0, 139],
      command: "glim_offline {in:scan} -c /glim/config -o {out:map} --window {param:window} {?db3:--imu-topic {param:imu_topic} --points-topic {param:points_topic}}",
    },
  },
  {
    id: "hera-convert",
    name: "Hera 格式转换",
    description: "将 .hera 文件转换为 ROS2 .db3 rosbag，用于回放与调试",
    imageRef: "crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/hera-convert",
    latestTag: "latest",
    manifest: {
      spec: "1",
      id: "hera-convert",
      name: "Hera→ROS bag",
      version: "latest",
      gpu: "none",
      mounts: [],
      inputs: [
        { id: "raw", type: "file", ext: [".hera"], container: "/data/input" },
      ],
      outputs: [
        { id: "bag", type: "file", container: "/output/out.db3" },
      ],
      params_schema: {
        type: "object",
        properties: {
          window:       { type: "number",  default: 0.1,                       title: "时间窗口(秒)" },
          imu_topic:    { type: "string",  default: "/lidar/mid360/imu",       title: "IMU Topic" },
          points_topic: { type: "string",  default: "/lidar/mid360/point_cloud2", title: "点云 Topic" },
          verbose:      { type: "boolean", default: false,                      title: "详细输出" },
        },
      },
      params_bindings: {
        window:       { mode: "arg", flag: "--window" },
        imu_topic:    { mode: "arg", flag: "--imu-topic" },
        points_topic: { mode: "arg", flag: "--points-topic" },
        verbose:      { mode: "arg", flag: "-v" },
      },
      command: "hera_to_rosbag {in:raw} -o {out:bag} --window {param:window} --imu-topic {param:imu_topic} --points-topic {param:points_topic} {param:verbose}",
    },
  },
  {
    id: "glim-export-pcd",
    name: "点云导出",
    description: "将 GLIM 重建输出的地图目录导出为点云文件 (.ply/.pcd/.csv)",
    imageRef: "crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/hera-export-pcd",
    latestTag: "latest",
    manifest: {
      spec: "1",
      id: "glim-export-pcd",
      name: "点云导出",
      version: "latest",
      gpu: "none",
      mounts: [],
      inputs: [
        { id: "map", type: "dir", container: "/input/map" },
      ],
      outputs: [
        { id: "cloud", type: "file", container: "/output/map_export.ply" },
      ],
      params_schema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["ply", "pcd", "csv"], default: "ply", title: "输出格式" },
        },
      },
      params_bindings: {
        format: { mode: "arg", flag: "--format" },
      },
      command: "python3 /opt/scripts/export_map_pcd.py /input/map -o {out:cloud} --format {param:format}",
    },
  },
];

export interface OperatorVersionInfo {
  id: string;
  version: string;
  image_ref: string;
  image_digest: string;
  source: string;
  added_at: string;
}

export interface OperatorSummary {
  id: string;
  versions: OperatorVersionInfo[];
}

export const api = {
  listDatasets: () => invoke<Dataset[]>("list_datasets"),
  scanDir: (path: string) => invoke<number>("scan_dir", { path }),

  openHeraSession: async (path: string): Promise<HeraSession> => {
    const raw = await invoke<{
      path: string; stem: string; hera_size: number;
      insv_path: string | null; insv_size: number | null;
      session_json: string | null; session_json_size: number | null;
    }>("open_hera_session", { path });
    return { ...raw, ...parseSessionFilename(raw.stem) };
  },
  heraFileInfo: (path: string) => invoke<HeraFileInfo>("hera_file_info", { path }),
  listWorkflows: () => invoke<WorkflowSummary[]>("list_workflows"),
  getWorkflow: (id: string) => invoke<WorkflowDetail>("get_workflow", { id }),
  runWorkflow: (
    workflowId: string,
    inputPath: string,
    paramOverrides: Record<string, Record<string, unknown>>
  ) => invoke<string>("run_workflow", { workflowId, inputPath, paramOverrides }),
  cancelJob: (jobId: string) => invoke<void>("cancel_job", { jobId }),
  listJobs: () => invoke<Job[]>("list_jobs"),
  jobArtifacts: (jobId: string) => invoke<Artifact[]>("job_artifacts", { jobId }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  getConfig: () => invoke<AppConfig>("get_config"),
  setConfig: (config: AppConfig) => invoke<void>("set_config", { config }),
  onJobEvent: (cb: (e: JobEvent) => void) =>
    listen<JobEvent>("job-event", (e) => cb(e.payload)),

  pickFile: (extensions?: string[]) =>
    dialogOpen({
      multiple: false,
      filters: extensions?.length
        ? [{ name: "Files", extensions }]
        : undefined,
    }) as Promise<string | null>,

  pickFolder: () =>
    dialogOpen({ directory: true, multiple: false }) as Promise<string | null>,

  /** Resolve a tool: absolute path is checked for existence; a bare command
   *  name is looked up on PATH (PATHEXT too, on Windows). */
  resolveTool: (tool: string) => invoke<boolean>("resolve_tool", { tool }),

  jobProvenance: (jobId: string) => invoke<unknown[]>("job_provenance", { jobId }),

  operatorAdd: (imageRef: string, tarPath?: string, manifestJson?: string) =>
    invoke<unknown>("operator_add", { imageRef, tarPath: tarPath ?? null, manifestJson: manifestJson ?? null }),
  operatorList: () => invoke<OperatorSummary[]>("operator_list"),
  operatorDescribe: (id: string, version: string) =>
    invoke<unknown>("operator_describe", { id, version }),
  operatorRemove: (id: string, version: string) =>
    invoke<void>("operator_remove", { id, version }),
};

# 任务书 ②:自描述 + 版本化算子系统(镜像自带契约 · 版本选择 · 自动生成 UI)

> 交给 Claude Code 执行。**建议在任务①(前端组件化 + rjsf 表单)完成后再做**,因为本任务的“按 schema 自动出参数页”落在 rjsf 表单上。
> 目标:把算子从“外部手维护 operator.json”升级为「**镜像自描述 + 版本化**」——丢一个符合约定的镜像进来,应用自省后自动出参数/输入输出页面,并可选版本、可复现。
> 这是把你现有 MVP 提升为**算法插件平台**的关键一步。

---

## 0. 核心理念(先对齐)
- **镜像自描述**:Docker 镜像本身不结构化暴露参数,所以约定一个**镜像自带的契约**:镜像内含 `operator.json` 且提供 `--describe` 入口输出它。应用不再手维护 manifest,而是**向镜像自省**。
- **版本 = image tag**:`operator_id + version` ↔ 具体镜像 tag。选版本 = 选 (tag + 它自带的 manifest)。
- **契约随版本变**:不同版本的 inputs/outputs/params 可能不同——所以 manifest 必须**跟镜像走**,不能全局共用一份。
- **可复现**:每个 job 记录所用算子的确切 tag + digest + 参数,写入 provenance。

> 兼容性:保留对“外部 operator.json 文件”的支持作为回退(未打包自描述的老镜像仍可用),但**自描述优先**。

---

## 1. 镜像自描述约定(operator spec)

### 1.1 镜像需满足
- 镜像内含 `/operator.json`(契约,schema 见 §1.2)。
- 提供标准自省入口(二选一,都实现更稳):
  - **命令式**:`docker run --rm <image> --describe` → 把 `/operator.json` 打到 **stdout**(纯 JSON,无多余日志);
  - **标签式**:`LABEL org.hera.operator.spec="1"` 且 `LABEL org.hera.operator.manifest.path="/operator.json"`,应用可用 `docker create` + `docker cp` 取出,或 `docker inspect` 读 label。
- 约定 `LABEL org.hera.operator.id=<id>` 与 `org.hera.operator.version=<ver>`,便于不运行也能识别。

### 1.2 `operator.json` schema(在任务书原契约上扩展)
```jsonc
{
  "spec": "1",                       // 契约版本
  "id": "glim-recon",
  "name": "GLIM 激光重建",
  "version": "0.7",                  // 与镜像 tag 对应
  "gpu": "none|optional|required",
  "mounts":  [ /* 同原契约:config 等 */ ],
  "inputs":  [ { "id":"scan", "type":"file", "ext":[".hera",".db3"], "container":"/data/input" } ],
  "outputs": [ { "id":"map",  "type":"dir",  "container":"/output/map" } ],
  "params_schema": {                 // 标准 JSON Schema(供 rjsf 直接渲染)
    "type":"object",
    "properties": {
      "window": { "type":"number", "default":0.1, "title":"时间窗口(秒)" },
      "mode":   { "type":"string", "enum":["cpu","gpu"], "default":"cpu", "title":"计算模式" },
      "mounting_rpy": { "type":"array", "items":{"type":"number"}, "minItems":3, "maxItems":3,
                        "default":[0,0,0], "title":"安装角 RPY(度)" }
    }
  },
  "params_bindings": {               // 每个参数如何注入(沿用你 runner 已支持的模式)
    "window":       { "mode":"arg", "flag":"--window" },
    "mode":         { "mode":"config_switch_suffix", "file":"config.json",
                      "keys":["config_odometry","config_sub_mapping","config_global_mapping"] },
    "mounting_rpy": { "mode":"config_rpy_patch", "file":"config_sensors.json", "jsonpath":"$.lidar_mounting_rpy" }
  },
  "exit_codes_ok": [0, 139],         // 保留你 M2 修的 GLIM 清理崩溃兼容
  "command": "glim_offline {in:scan} -c /glim/config -o {out:map} --window {param:window}"
}
```

> 说明:把参数拆成 **`params_schema`(给 UI 渲染)** + **`params_bindings`(给 runner 注入)** 两块。前者是标准 JSON Schema,任务①的 rjsf 直接吃;后者复用你 runner 已实现的 `arg/env/config_patch/config_switch_suffix/config_rpy_patch`。

---

## 2. 算子注册表(Operator Registry)
新增本地注册表(存 `registry.sqlite` 或 `operators.json`),记录每个 (id, version):
- image ref、image **digest**(拉取后固定,保证可复现)、自省得到的 manifest 缓存、来源(本地/ACR/离线 tar)、加入时间。
- 后端命令(新增,先与我确认签名):
  - `operator_add(image_ref)`:拉取(或 `docker load`)→ 运行 `--describe`/读 label 取 manifest → 存注册表。
  - `operator_list()`:列出所有 (id → 可用 versions[])。
  - `operator_describe(id, version)`:返回该版本 manifest(供 UI 渲染)。
  - `operator_remove(id, version)`。
- **离线/内网**:支持从 `docker save` 的 tar 包导入(机器人客户常在内网,必须能离线加装算子)。

---

## 3. 版本感知的工作流与运行器
- **workflow.json** 的每个节点引用 `{operator_id, version}`(version 可为 `latest` 或具体);运行时解析为确切 image tag + digest。
- **runner**:执行前对每个节点 `operator_describe` 取该版本 manifest,再按其 `command`/`params_bindings` 组 `docker run`(逻辑与你现有 runner 一致,只是 manifest 来源改为“按版本取”)。
- **provenance**(扩展你现有 SQLite job 历史):每个 step 记录 operator_id、version、image digest、实际参数值、镜像来源。保证“这个点云是谁、哪个版本、什么参数产出的”可追溯、可复现。

---

## 4. 前端(接任务①)
- **算子管理页(新增)**:列出已注册算子及各自版本;`添加算子`(输入 image ref 或选 tar 包 → 调 `operator_add`);删除;查看 manifest。
- **运行视图升级**:
  - 每个工作流步骤显示**版本下拉**(该算子的可用 versions),默认 latest,可切。
  - 选定版本后 → `operator_describe` 取 `params_schema` → **rjsf 自动渲染该版本的参数表单**(任务①已铺好),并按 inputs 的 `type/ext` **校验用户选的输入文件**。
- **A/B 复跑(可选加分)**:同一输入、两个版本各跑一次,任务视图并排看产物,便于比对(如 r0.6 vs r0.7 的建图质量)。

---

## 5. 迁移与兼容
- 先把现有三个算子(glim-recon / glim-export-pcd / hera-convert)**改造成自描述镜像**:各自加 `/operator.json` + `--describe` 入口 + labels;`params` 拆成 `params_schema` + `params_bindings`。
- runner 支持两种 manifest 来源:**镜像自描述优先**,找不到则回退到 `operators/<id>/operator.json` 外部文件(平滑迁移)。
- 现有 workflow.json 补上 `version` 字段(缺省 latest)。

---

## 6. 里程碑(逐个完成后停下让我确认)
- **M1 自描述约定 + 一个算子**:定 `operator.json` v1 schema(§1.2);给 **glim-recon** 加 `/operator.json` + `--describe` + labels;`docker run --rm <image> --describe` 能吐出正确 JSON。给我看输出。
- **M2 注册表 + 自省**:实现 `operator_add/list/describe/remove`(含 digest、tar 导入);把三个算子都注册进来。
- **M3 版本感知 runner**:runner 改为“按 (id,version) 取 manifest”执行;provenance 记录 version+digest;命令行跑通一次并核对历史记录。
- **M4 前端接入**:算子管理页 + 运行视图版本下拉 + **rjsf 按版本 schema 自动渲染表单** + 输入类型校验。端到端从 UI 选版本跑通。
- **M5(可选)A/B 复跑**:同输入双版本并排比对。

---

## 7. 约束与安全
- **可复现优先**:job 一律记 image **digest**(不只 tag),避免 tag 漂移导致结果不可复现。
- **自省安全**:`--describe` 只读输出 JSON,不得有副作用;取 manifest 失败要有清晰报错,不臆造 schema。
- **离线可用**:注册与运行不得强依赖公网/ACR;支持 tar 包离线加装。
- **契约校验**:`operator_add` 时校验 manifest(必填字段、`params_schema` 合法 JSON Schema、bindings 覆盖所有 params),不合法则拒绝入库并提示。
- **不破坏 MVP**:自描述缺失时回退外部 operator.json,保证现有工作流继续可跑。

## 8. 需要我确认(开工前问我)
1. 是否允许**新增后端命令**(`operator_add/list/describe/remove`)与注册表存储(SQLite 表 or JSON)?
2. 自省入口用**命令式 `--describe`**、**label 式**,还是两者都做(推荐都做,命令式为主)?
3. 三个现有镜像我来重构成自描述,还是由 agent 直接改 Dockerfile/入口脚本(需要我给出各镜像的构建方式)?
4. 是否要 M5 的 A/B 双版本比对?

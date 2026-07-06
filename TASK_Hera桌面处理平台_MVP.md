# 任务书:Hera 桌面数据处理平台 MVP(Tauri 壳 + 本地 DAG 运行器 + 三算子接入)

> 交给 Claude Code 执行。目标:把已有的容器化算法(GLIM 重建、点云导出、hera→ROS bag 转换)
> 用一个**本地优先**的桌面应用组织起来:数据管理 + 预制工作流一键运行 + 任务监控。
> **核心原则:不重写算法。三个算子已是 OCI 镜像/脚本,本任务只做“契约化 + 本地 DAG 运行器 + 桌面壳”。**
> 云端、节点编辑器不在本期范围(见 §10 后续)。

---

## 0. 边界
- **本地运行**:所有算子用本机 `docker` 或 `podman` 跑,输入只读挂载,数据不出本机。
- **复用优先**:算子=现有镜像/脚本 + 一份清单(manifest);壳只负责编排、监控、数据索引。
- **不臆造**:命令模板、挂载路径、config 字段必须对齐用户真实镜像(M1 逐个冒烟验证);拿不准就停下问,不猜。
- **失败隔离**:任一步失败 → 记日志、标红、停止该工作流,不污染其他任务、不伪造产物。

---

## 1. 现有资产(要接的真实东西)

> 以下来自项目文档;确切镜像 tag / 内部路径见 §9 由我确认。

- **GLIM 离线重建**:镜像(如 `glim_offline:latest` 或 ACR 的 `glim/glim-runner:rX`),headless。
  CLI:`glim_offline [OPTIONS] <input>`,`<input>` 可为 `.hera` 或 `.db3`。
  选项:`-c/--config <dir>`、`-o/--output <dir>`、`--imu-topic`、`--points-topic`、`--window <sec>`、`-v`。
  需挂载一个 **config 目录**(含 `config.json` 选 odometry/mapping 模块、`config_sensors.json` 含 `lidar_mounting_rpy`、`config_odometry_cpu/gpu.json`、`config_global_mapping_*` 含 `max_memory_gb`)。
  CPU/GPU 切换 = 改 `config.json` 里 `config_odometry`/`config_sub_mapping`/`config_global_mapping` 的 `_cpu`↔`_gpu` 后缀。
  安装角度 = 改 `config_sensors.json` 的 `lidar_mounting_rpy`(正置 `[0,0,0]`,倒置 `[180,0,0]`)。
  输出:编号子图目录 `map/000000/… graph.bin values.bin`。
- **点云导出**:`scripts/export_map_pcd.py <map_dir> -o out.ply [--format ply|pcd|csv]`(依赖 python3+numpy;可在 glim 镜像内或一个 slim python 镜像内跑)。合并所有子图为世界系点云。
- **hera→ROS bag 转换**:`hera-convert -i <input> [-o <output>.bag -r <remap>.json -v -l]`(ROS1 / Ubuntu 16.04)。`remap.json` 为 TopicName/FrameId 重映射(`"<from>":"<to>"`)。
- **采集端(本期不接,预留)**:`hera-daemon`/`hera-client`(C/S,产 `.hera`);`hera-storage-tool`(打印 `.hera` 元信息,可用于数据管理的元数据来源)。

> **重要事实**:GLIM 直接读 `.hera`,**SLAM 工作流不需要先过 hera-convert**;hera-convert 产的是 ROS1 `.bag`,是给其他工具用的独立算子。因此有两条互相独立的预制工作流(见 §4)。

---

## 2. 核心抽象:算子契约(`operator.json`)

每个算子一份 manifest。运行器只认这个契约,不认具体算法。**先把 schema 定死。**

### 2.1 Schema(字段规范)
```jsonc
{
  "id": "glim-recon",
  "name": "GLIM 激光重建",
  "version": "0.1",
  "image": "<OCI 镜像引用>",
  "gpu": "none | optional | required",
  "mounts": [
    // 除 inputs/outputs 外需要挂载的目录(如 config)。mode=rw 时运行器会把本次 params 的 config_patch 写进去
    { "id": "config", "host": "<用户config目录>", "container": "/glim/config", "mode": "rw" }
  ],
  "inputs":  [ { "id": "scan", "type": "file", "ext": [".hera",".db3"], "container": "/data/input" } ],
  "outputs": [ { "id": "map",  "type": "dir",  "container": "/output/map" } ],
  "params": [
    { "id": "window", "type": "number", "default": 0.1,
      "inject": { "mode": "arg", "flag": "--window" } },
    { "id": "mounting_rpy", "type": "number[3]", "default": [0,0,0],
      "inject": { "mode": "config_patch", "file": "config_sensors.json", "jsonpath": "$.lidar_mounting_rpy" } },
    { "id": "mode", "type": "enum", "values": ["cpu","gpu"], "default": "cpu",
      "inject": { "mode": "config_switch_suffix", "file": "config.json",
                  "keys": ["config_odometry","config_sub_mapping","config_global_mapping"] } }
  ],
  "command": "glim_offline {in:scan} -c /glim/config -o {out:map} --window {param:window}"
}
```

**三种参数注入方式(运行器必须都支持):**
- `arg` — 作为 CLI 参数拼进 `command`;
- `env` — 作为环境变量传入容器;
- `config_patch` / `config_switch_suffix` — **在 `docker run` 之前**,把值写入挂载 config 目录里的对应文件(这正是现有 `index.py::_apply_mounting_rotation` 的做法:先改 `config_sensors.json` 再跑 `glim_offline`)。`config_switch_suffix` 用于把选定键改成 `_cpu`/`_gpu` 后缀版本。

### 2.2 三个算子的 manifest(据 §1 写出,M1 冒烟校准)

**operators/glim-recon/operator.json** — 见 §2.1 示例(即为此算子)。命令中 `.db3` 输入时追加 `--imu-topic/--points-topic`(做成条件 param,仅当输入扩展名为 `.db3` 时注入)。

**operators/glim-export-pcd/operator.json**
```jsonc
{
  "id": "glim-export-pcd", "name": "点云导出", "version": "0.1",
  "image": "<含 python3+numpy 与 export_map_pcd.py 的镜像,可复用 glim 镜像>",
  "gpu": "none",
  "inputs":  [ { "id": "map", "type": "dir",  "container": "/input/map" } ],
  "outputs": [ { "id": "cloud", "type": "file", "container": "/output/map_export.ply" } ],
  "params":  [ { "id": "format", "type": "enum", "values": ["ply","pcd","csv"], "default": "ply",
                 "inject": { "mode": "arg", "flag": "--format" } } ],
  "command": "python3 /opt/scripts/export_map_pcd.py /input/map -o {out:cloud} --format {param:format}"
}
```

**operators/hera-convert/operator.json**
```jsonc
{
  "id": "hera-convert", "name": "Hera→ROS bag", "version": "0.1",
  "image": "<hera-convert 镜像:Ubuntu16.04+ROS1+hera;若无,M1 帮我写 Dockerfile>",
  "gpu": "none",
  "inputs":  [ { "id": "raw", "type": "dir", "container": "/data/input" },
               { "id": "remap", "type": "file", "ext": [".json"], "container": "/data/remap.json", "optional": true } ],
  "outputs": [ { "id": "bag", "type": "file", "container": "/output/out.bag" } ],
  "params":  [ { "id": "verbose", "type": "bool", "default": false, "inject": { "mode": "arg", "flag": "-v" } } ],
  "command": "hera-convert -i /data/input -o {out:bag} {?remap:-r /data/remap.json} {param:verbose}"
}
```

---

## 3. 本地 DAG 运行器(runner)

输入:一个 workflow(§4)+ 用户选的输入文件 + 各算子 params。行为:

1. **解析 DAG**:拓扑排序算子节点;上游 output 通过本地临时目录接到下游 input(`workdir/<job_id>/<step>/`)。
2. **每步执行**:
   - 解析该算子 manifest;把 `{in:*}`/`{out:*}`/`{param:*}`/`{?opt:...}` 填入 `command`;
   - 处理 `config_patch`:把可写 config 目录复制到本 job 的工作副本,按 params 改写(不改用户原始 config);
   - 组 `docker run`(或 `podman run`):`--rm`、挂载(输入 `:ro`,输出/config 可写)、GPU(见 §8)、`--user $(id -u):$(id -g)` 规避 root 产物(见 §8),命令模板;
   - 用子进程执行,**实时把 stdout/stderr 流给壳**(GLIM 会输出进度与 ETA,export 会打印点数),解析退出码。
3. **串联与产物**:每步成功后把 output 路径登记,作为下游 input;全部完成后把最终产物登记进数据管理层(§5)。
4. **失败处理**:非零退出 → 标红、保留日志、停止本工作流,继续不受影响的其他任务。
5. **运行时抽象**:`container.run(...)` 封装 `docker`/`podman`(由配置切换,二者 CLI 基本一致)。

CLI 入口(供 UI 之前先跑通):`hera-run <workflow.json> --input <file> --set glim-recon.window=0.1 --set glim-recon.mode=gpu`。

---

## 4. 预制工作流(`workflows/*.json`)

两条**独立**线性 DAG(先硬编码,不做编辑器):

**workflows/reconstruct_pointcloud.json** — 「激光重建出点云」
```
输入(.hera/.db3) → glim-recon → glim-export-pcd → 输出(.ply/.pcd/.csv)
```
**workflows/hera_to_bag.json** — 「转 ROS bag」
```
输入(.hera 原始目录) → hera-convert → 输出(.bag)
```
workflow.json 描述节点、连线(上游 output id → 下游 input id)、以及每个节点暴露给 UI 的参数默认值。

---

## 5. 桌面壳(Tauri)

**技术**:Tauri(Rust 后端 + Web 前端)。Rust 侧负责调容器、扫描/索引、事件流;前端三视图。

- **数据视图**:扫描用户指定的数据目录 → 索引 `.hera`/`.db3`/`.bag`/点云 及产物,展示元信息。`.hera` 元信息优先调 `hera-storage-tool`(若可用)获取;取不到就退化到文件属性。用本地 `registry.sqlite` 存索引 + provenance(某产物由哪个 workflow/算子/参数产生)。
- **运行视图**:选工作流 → 选输入文件 → **按算子 manifest 的 param schema 自动生成参数表单**(number/enum/bool/number[3])→ Run。
- **任务视图**:运行中/已完成任务列表;点开看**实时日志与进度**;产物给出「打开所在文件夹」「用 CloudCompare/MeshLab 打开」(可配置外部程序),以及「导出到 Isaac(占位)」。

Rust 侧命令建议:`scan_dir`、`list_datasets`、`run_workflow`(spawn 容器、通过 Tauri event 推日志)、`cancel_job`、`open_path`。

---

## 6. 目录结构
```
hera-desktop/
├─ operators/                 # 三个算子的 operator.json(+ 需要时的 Dockerfile)
│  ├─ glim-recon/  glim-export-pcd/  hera-convert/
├─ workflows/                 # reconstruct_pointcloud.json / hera_to_bag.json
├─ runner/                    # 本地 DAG 运行器 + container 抽象(可 Rust 或独立 CLI)
├─ src-tauri/                 # Tauri Rust 后端
├─ src/                       # 前端(数据/运行/任务 三视图)
├─ config.example.toml        # 运行时:docker|podman、GPU、数据目录、外部查看器路径
└─ registry.sqlite            # 数据集与任务索引(运行期生成)
```

---

## 7. 里程碑(逐个完成后停下让我确认)

- **M1 契约 + 冒烟**:定 `operator.json` schema;写三个 manifest;**逐个用手写 `docker run` 跑通**——用我给的样例 `.hera` 验证 glim-recon→export 出 `.ply`,单独验证 hera-convert 出 `.bag`。确认命令模板、挂载路径、config 注入(尤其 `mounting_rpy` 与 cpu/gpu 后缀切换)都对。把每步命令与产物给我看。
- **M2 运行器**:实现 DAG 运行器 + 三种参数注入 + 日志流 + 产物串联;命令行跑通「reconstruct_pointcloud」全流程(`.hera`→map→`.ply`),无 UI。
- **M3 壳骨架 + 任务监控**:Tauri 壳能触发 M2 运行器、实时看日志/进度、产物可在文件管理器打开。
- **M4 数据管理 + 参数表单**:扫描索引 + 元数据 + provenance;运行视图按 manifest 自动生成参数表单;两条预制工作流可选可跑。
- **M5 收尾**:docker/podman 可切、GPU 开关、root 产物规避、外部查看器打开、「导出到 Isaac」占位算子。

---

## 8. 约束与安全(硬性)
- **只读输入**:输入与用户原始 config 一律 `:ro`;config_patch 只改**本 job 的副本**,绝不改用户源文件。
- **产物权限**:容器默认 root 会产出 root 属主文件(项目文档已踩过)——统一用 `--user $(id -u):$(id -g)` 或运行后 `chown`,保证用户可读写。
- **GPU**:`gpu!="none"` 且配置开启时才加 `--gpus all`(docker)/ `--device nvidia.com/gpu=all`(podman);需 nvidia-container-toolkit;**Linux-first**。
- **失败隔离**:单步失败不中断其他任务;所有子进程加超时与清晰错误日志。
- **密钥**:拉私有镜像(ACR)的凭据走 `config`/`.env`,不进代码不进日志。
- **不臆造**:命令/路径/config 字段必须与真实镜像一致;M1 未验证通过前不进 M2。

---

## 9. 需要我确认/提供的项(开工前问我)
1. **三个镜像的确切引用与内部路径**:① GLIM 镜像 tag + config 目录路径 + `glim_offline` 命令形态(`-c` 指向哪);② `export_map_pcd.py` 放在哪个镜像/路径(还是复用 GLIM 镜像);③ `hera-convert` 是否已容器化——若无,M1 帮我写 `Dockerfile`(Ubuntu16.04+ROS1+hera)。
2. **一个样例 `.hera`**,及其传感器 topic/参数(如 Mid-360 的 imu/points topic、是否倒置安装)。
3. **容器运行时**:docker 还是 podman?**有无 GPU**、nvidia-container-toolkit 是否就绪?
4. **桌面框架**:Tauri(默认)还是 Electron?
5. **目标 OS**(默认 Ubuntu Linux)。

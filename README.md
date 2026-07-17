# Hera Desktop

面向 `.hera` 激光/全景采集数据的本地处理桌面应用。基于 [Tauri 2](https://tauri.app/) + React + Rust，用容器化算子（GLIM 重建、格式转换等）编排工作流，在本地跑通「采集 → 重建 → 导出」全流程，并提供会话浏览、任务历史、算子仓库等管理界面。

## 功能

- **会话浏览器**：打开 `.hera` 采集文件，自动关联同名 `.insv` / `.session.json`，展示解析自二进制文件头的真实元数据（版本、起止时间、逐设备消息数/数据量、`extra_info`）。
- **工作流执行**：选择工作流（激光重建出点云 / 转 ROS bag 等）→ 按 JSON Schema 自动渲染参数表单 → 容器化执行 → 实时日志与进度。
- **任务历史**：按工作流查看历史任务、产物路径，支持在文件管理器中打开或用外部查看器打开点云/bag。
- **算子仓库**：从镜像地址 / tar 包添加算子，管理版本，查看 manifest。
- **首选项**：容器运行时（Docker / Podman）、GPU 开关、数据目录等配置。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri 2 |
| 前端 | React 19 + TypeScript + Vite 6 + antd |
| 后端 | Rust（`runner` DAG 编排库 + `hera-run` CLI + `src-tauri` Tauri 命令层）|
| 算子执行 | Docker / Podman 容器 |
| 任务/算子元数据 | SQLite（`registry.sqlite`）|

## 前置依赖

- [Docker](https://docs.docker.com/get-docker/) 或 Podman（并已启动、已登录所需的镜像仓库）
- Node.js ≥ 20，npm
- Rust stable（`rustup`）+ Cargo
- Tauri 2 的系统依赖（Linux 需要 WebKitGTK 等，详见 [Tauri 官方前置条件](https://tauri.app/start/prerequisites/)）

## 开发

```bash
npm install

# 复制配置模板并按实际路径修改（数据目录、GLIM config 目录等）
cp config.example.toml config.toml

# 启动桌面应用（Vite + Tauri，带热重载）
npm run tauri dev
```

首次运行 GLIM 相关算子前，需要提取容器内的 GLIM config 到本地（首次会自动完成，也可手动执行）：

```bash
cargo run -p hera-runner --bin hera-run -- extract-config glim-recon
```

## 构建

```bash
npm run build          # tsc + vite build → dist/
npm run tauri build    # 打包桌面安装包（.deb/.AppImage/.dmg/.msi 等，视平台而定）
```

## 命令行工具（`hera-run`）

`runner` crate 同时提供一个独立于 UI 的 CLI，可脱离桌面应用直接跑工作流：

```bash
cargo run -p hera-runner --bin hera-run -- run reconstruct_pointcloud \
  --input /path/to/scan.hera \
  --set step_recon.mounting_rpy='[0,180,0]'
```

## 项目结构

```
hera-desktop/
├── src/                 # React 前端（视图：DataView/RunView/TaskView/MemoryView/OperatorsView/SettingsView）
├── src-tauri/            # Tauri 应用壳，注册 Tauri 命令
├── runner/               # hera-runner：DAG 编排库 + hera-run CLI
│   └── src/
│       ├── dag.rs         # 工作流执行引擎
│       ├── container.rs   # Docker/Podman 调用
│       ├── docker_diag.rs # 容器运行时错误诊断（未安装/未登录/拉取失败等）
│       ├── hera_format.rs # .hera 二进制文件头解析
│       └── registry.rs    # SQLite 任务/算子元数据
├── operators/             # 算子 manifest（operator.json）
├── workflows/             # 工作流定义（JSON）
└── config.example.toml    # 运行时配置模板
```

## 配置

见 [`config.example.toml`](./config.example.toml)：容器运行时（docker/podman）、GPU 开关、数据/输出目录、GLIM config 目录、可选的私有镜像仓库信息。复制为 `config.toml` 后按需修改，该文件已在 `.gitignore` 中忽略。

## 相关项目

- [`hera-sdk-python`](https://github.com/tadpoleai/hera-sdk-python)：`.hera` 文件的 Python 读写 SDK 与格式参考实现。

## License

内部项目，暂未开源许可。

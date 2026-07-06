# Hera Desktop — 当前状态总结

> 更新时间：2026-07-03

---

## 一、已完成

### M1 — 算子契约 + 冒烟测试

- 3 个算子定义：`glim-recon`、`glim-export-pcd`、`hera-convert`
- 2 个工作流：`reconstruct_pointcloud`（激光建图→点云）、`hera_to_bag`（.hera→ROS2 db3）
- 两种安装方式验证通过：
  - 正置：默认参数或 `keyframe_strategy=DISPLACEMENT`
  - 倒置：`--set "step_recon.mounting_rpy=[0,180,0]"`

### M2 — Runner CLI

- `hera-run` CLI 完整运行，支持 DAG 编排、参数注入、Docker 执行、SQLite 任务历史
- 参数注入模式：`arg`、`env`、`config_patch`、`config_switch_suffix`、`config_rpy_patch`（RPY→四元数）
- 输出目录：`<workspace>/hera-output/<job-uuid>/`，每个 step 独立子目录

**已修复关键 bug：**

| Bug | 修复方式 |
|-----|----------|
| GLIM 需 root 权限 | 去掉 `--user uid:gid`，命令尾部追加 `chown -R` wrapper |
| GLIM 清理阶段崩溃 exit=139 | operator.json 加 `"exit_codes_ok": [0, 139]` |
| .hera 扩展名被 Docker 挂载截断 | `Input::effective_container_path()` 保留宿主机扩展名 |
| `--set` 不支持 JSON 数组 | 先尝试 `serde_json::from_str`，再降级为 string |
| dev 模式输出落入 `src-tauri/` 触发热重载 | `lib.rs` 启动时 `set_current_dir(workspace_root)` |

### M3 — Tauri 桌面 UI

- 应用正常启动（Vite 5173 + Tauri WebKit）
- 工作流端到端跑通，日志实时流式显示在 UI 日志面板
- Tasks 面板"在文件管理器中打开"按钮正常工作

**启动命令（dev）：**
```bash
source ~/.cargo/env
DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 \
  HERA_WORKSPACE=/home/fred/Code/mvp2/hera-desktop \
  npm run tauri dev
```

---

## 二、已知问题 / 未完成

| 问题 | 严重度 | 说明 |
|------|--------|------|
| 文件/目录浏览对话框未接入 | 中 | 运行页和数据页路径只能手动输入，`浏览` 按钮为空实现；需调用 Tauri `dialog` 插件 |
| `hera_to_bag` 未端到端验证 | 中 | operator.json 已修正（命令名 `hera_to_rosbag`、输入类型 file、输出 `.db3`），尚未完整运行一次 |
| `glim-export-pcd` 镜像需本地构建 | 低 | `hera-export-pcd:local` 需用户手动 `docker build`，无自动构建流程 |
| DataView 扫描结果用 `alert()` 弹窗 | 低 | 体验差，应改为 inline 提示 |
| 无设置页 | 低 | `get_config`/`set_config` 后端已实现，前端未接入 |
| 任务历史无过滤 | 低 | Tasks 面板列出所有任务，无状态/时间过滤 |
| dev 须手动传 `HERA_WORKSPACE` | 低 | 无 `.env` 文件或自动检测，每次启动需带环境变量 |

---

## 三、当前 UI 设计

### 整体框架

```
┌──────────────┬─────────────────────────────────────────┐
│  SIDEBAR     │              MAIN CONTENT                │
│  (200px)     │                                          │
│              │                                          │
│  🗄 数据集   │   <当前选中视图>                          │
│  ▶  运行     │                                          │
│  📋 任务     │                                          │
│              │                                          │
└──────────────┴─────────────────────────────────────────┘
```

**主题：** 深色，CSS 变量设计系统：

| 变量 | 值 | 用途 |
|------|----|------|
| `--bg` | `#0f1117` | 页面背景 |
| `--surface` | `#1a1d27` | 卡片/侧边栏面板 |
| `--border` | `#2e3148` | 边框 |
| `--accent` | `#5b8ef0` | 主色蓝（激活/按钮/链接） |
| `--text` | `#e2e4ef` | 正文 |
| `--text-dim` | `#8890b0` | 次要文字/标签 |
| `--success` | `#4ade80` | 成功绿 |
| `--error` | `#f87171` | 错误红 |
| `--warn` | `#fbbf24` | 警告黄 |

**字体：** `Inter`（UI）、`JetBrains Mono / Fira Code`（日志等宽）

**侧边栏：** 固定 200px，顶部品牌名 `HERA`（蓝色小号大写），三个导航按钮带左侧 3px 蓝色激活条，hover 有轻微白色背景。

---

### 数据集视图（DataView）

```
[ 数据集 ]          [ 扫描目录路径_______________ ] [扫描] [刷新]
┌──────────────────────────────────────────────────────────┐
│  路径                  类型      大小      索引时间   操作  │
│  /home/fred/Data/...  [hera]   1.2 GB   07-03 18:30  [打开目录] │
│  /home/fred/Data/...  [db3]    340 MB   07-03 16:00  [打开目录] │
└──────────────────────────────────────────────────────────┘
```

- 类型用彩色圆角 Badge：`.hera`（黄）、`.db3`（紫）、`.bag`（红）、点云（绿）
- 路径列超长截断，title 悬浮显示完整路径
- 扫描通过 `alert()` 弹窗反馈结果条数（待优化）

---

### 运行视图（RunView）

**第一步：选择工作流**

```
┌──────────────────────┐  ┌──────────────────────┐
│  激光重建出点云        │  │  转 ROS bag           │
│  输入 .hera/.db3 文件 │  │  输入 .hera 文件      │
│  经 GLIM 重建后导出…   │  │  转换为 ROS2 .db3 bag │
└──────────────────────┘  └──────────────────────┘
  hover：边框变蓝
```

**第二步：配置参数**

```
[← 返回]  激光重建出点云

┌─────────────────────────────────────────────┐
│  输入扫描文件                                  │
│  [ /home/fred/Data/xxx.hera___________ ] [浏览] │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  glim-recon 参数                              │
│  时间窗口(秒)    计算模式    IMU Topic          │
│  [ 0.1     ]   [ cpu ▼ ]  [ /lidar/... ]    │
│                                               │
│  安装角 RPY (度, ZYX)  — 倒置=[0,180,0]       │
│  [ 0 ] [ 0 ] [ 0 ]                           │
│                                               │
│  IMU 加速度噪声   关键帧策略    关键帧间距(m)    │
│  [ 0.05     ]   [ OVERLAP ▼ ] [ 1.0     ]   │
└─────────────────────────────────────────────┘

[ ▶ 运行 ]   [ ■ 取消 ]（运行中显示）
```

参数表单由 `operator.json` schema 自动渲染：
- `number` → `<input type="number">`
- `enum` → `<select>`
- `bool` → checkbox
- `number[3]` → 3 个并排 80px 数字框
- 每个字段有 `form-label`（灰色小字）+ 可选 `description`（更小灰字跟在 label 后）

**第三步：进度 + 日志**

```
┌─────────────────────────────────────────────┐
│  进度                                         │
│  ●̲ step_recon    ← 蓝色脉冲动画（运行中）      │
│  ○ step_export   ← 灰点（等待）               │
│                                               │
│  ┌─────────────────────────────────────────┐ │
│  │[step_recon] 启动  image=crpi-...        │ │  ← 蓝色 meta 行
│  │[step_recon] 10% (1500/15000)            │ │  ← 白色正常行
│  │[step_recon] FAILED exit=127             │ │  ← 红色 stderr 行
│  └─────────────────────────────────────────┘ │
│    高度固定 300px，等宽字体，自动滚动到底        │
└─────────────────────────────────────────────┘
```

步骤状态点：灰（pending）→ 蓝色闪烁（running）→ 绿（done）→ 红（failed）

---

### 任务视图（TaskView）

```
[ 任务 ]                                              [刷新]

┌──────────────────────┐  ┌────────────────────────────────────┐
│ 工作流    状态   时间 │  │ reconstruct_pointcloud — 产物        │
├──────────────────────┤  ├────────────────────────────────────┤
│ recon   [成功]  18:39│  │ 步骤       输出    路径              │
│ bag     [失败]  18:33│  │ step_recon  map  /…/step_recon/map  │
│ recon   [运行]  18:29│  │                  [在文件管理器中打开] │
└──────────────────────┘  │ step_export bag  /…/map_export.ply  │
  点击行选中               │         [在文件管理器中打开] [查看]  │
  左栏宽 360px             └────────────────────────────────────┘
```

- 状态 Badge：`[成功]`（绿）、`[失败]`（红）、`[运行中]`（蓝）
- `在文件管理器中打开`：调用 `xdg-open`，目录型产物打开自身，文件型产物打开父目录
- `查看` 按钮：仅对 `.ply`、`.pcd`、`.bag` 显示，调用系统默认程序打开

---

### 前端技术栈

| 项目 | 技术 |
|------|------|
| 框架 | Vanilla TypeScript（无 React/Vue） |
| 构建 | Vite 6 |
| 视图组织 | Class-based（`DataView`、`RunView`、`TaskView`） |
| HTML 生成 | innerHTML 字符串模板 |
| 事件绑定 | 手动 `addEventListener` |
| 样式 | 手写 CSS，无 Tailwind/CSS-in-JS |
| 后端通信 | `@tauri-apps/api/core` `invoke` + `listen` |

**文件结构：**
```
src/
├── main.ts          # 布局、导航、视图实例化
├── api.ts           # 所有 Tauri invoke 封装 + 类型定义
├── style.css        # 全局样式
└── views/
    ├── DataView.ts  # 数据集扫描与列表
    ├── RunView.ts   # 工作流选择 → 参数配置 → 执行 + 日志
    └── TaskView.ts  # 任务历史 + 产物查看
```

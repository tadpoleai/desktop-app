# 任务书 ①:Hera Desktop 前端专业化升级(组件库 + 设计系统 + JSON Schema 表单)

> 交给 Claude Code 执行。目标:在**不换框架、不动 Rust 后端**的前提下,把现有 vanilla-TS 前端升级成专业工具级 UI。
> 保留 Tauri;问题在设计层,不在框架层。本任务只改 `src/` 前端与样式,后端 `invoke`/`listen` 接口保持不变。
> **可独立完成,不依赖任务②。** 完成后前端为任务②的“自描述参数表单”打好底座。

---

## 0. 边界与原则
- **不换框架**:继续 Tauri。不引入 Qt/Electron。
- **不动后端契约**:`src-tauri` 的命令(`scan_dir`/`list_datasets`/`run_workflow`/`cancel_job`/`open_path`/`get_config`/`set_config` 等)签名不变;只在前端调用。若确需新增命令,先列出来让我确认。
- **对标专业工具**:VS Code / Linear / Docker Desktop 的密度、状态、克制配色。深色主题保留。
- **渐进式**:一屏一屏迁移,每步应用可运行、可回退;不搞一次性大重写导致长期跑不起来。

---

## 1. 技术选型(先定,再迁移)
- **框架**:引入 **React + TypeScript + Vite**(Vite 已在用)。用 React 是为了接组件库与 JSON Schema 表单;若你更想零运行时,可用 **Svelte**——**默认 React**,除非我另说。
- **组件库(二选一,默认 A)**:
  - A. **Ant Design (antd)**:企业工具审美,开箱即专业,表格/表单/上传/进度/标签等齐全,中文生态好。适合快速拿到“专业感”。
  - B. **shadcn/ui + Tailwind**:更精致可定制、无障碍(Radix),但要自己搭更多。适合想要独特设计语言。
- **参数表单**:**@rjsf/core(react-jsonschema-form)** + 对应主题(antd 用 `@rjsf/antd`)。为任务②的“按 schema 自动渲染”铺路。
- **图标**:Lucide(`lucide-react`)。
- **等宽/日志**:保留 JetBrains Mono / Fira Code。
- 保留现有 CSS 变量设计 token(`--bg/--surface/--border/--accent/...`),映射到组件库主题(antd 用 ConfigProvider theme token;shadcn 用 CSS 变量),**不丢弃你现有配色**。

> 若选 A(antd),用其 dark algorithm + 用你的 token 覆盖主色 `--accent=#5b8ef0`,保证观感延续。

---

## 2. 设计系统(先建全局规范,再做页面)
- **配色**:沿用现有 token,补齐语义色(info/success/warn/error 已有)。
- **字号刻度**:12/13/14/16/20/24;正文 13–14,次要信息 12,标题 16–20。
- **间距刻度**:4/8/12/16/24/32(8pt 栅格),统一 padding/gap。
- **密度**:pro 工具偏紧凑——表格用紧凑行高,表单用 middle size。
- **通用状态组件(必须有)**:空态(Empty + 引导操作)、加载态(Skeleton/Spin)、错误态(带原因 + 重试)、Toast(替换所有 `alert()`)。
- **圆角/边框/阴影**:统一一套,避免每处不同。

---

## 3. 逐屏改造

### 3.1 应用外壳
- 侧边栏保留 200px,品牌 `HERA` + 三导航(数据/运行/任务)。用组件库的 Menu/Layout 重做,激活态保留左侧 3px 蓝条。
- 顶部加一个细 header 区放:当前 workspace 路径、运行时(docker/podman)状态点、设置入口(接 `get_config/set_config`,补上 STATUS 里“无设置页”的缺口)。

### 3.2 数据视图(DataView)
- 用组件库 **Table**:列=路径(超长省略 + tooltip 全路径)/类型 Badge/大小/索引时间/操作。类型 Badge 保留配色(hera 黄、db3 紫、bag 红、点云绿)。
- 顶部:目录输入 + **接入文件/目录选择对话框**(用 Tauri `dialog` 插件,补上 STATUS 里“浏览按钮空实现”的缺口),`扫描`/`刷新`。
- 扫描结果用 **Toast/inline 提示**替换 `alert()`。
- 空态:未扫描时给引导(“选择一个数据目录开始”)。

### 3.3 运行视图(RunView)——本次重点
- **步骤 1 工作流选择**:卡片(标题 + 描述 + 输入类型标签),hover/选中态清晰。
- **步骤 2 参数配置**:
  - 输入文件行:`浏览`接 dialog 插件按扩展名过滤。
  - 参数表单**改用 @rjsf 从 param schema 渲染**(number/enum/bool/number[3] → InputNumber/Select/Checkbox/三连数字框),label + description。**保持与现有 operator.json schema 兼容**;这是任务②自描述表单的落点。
- **步骤 3 进度 + 日志**:
  - 步骤状态点:pending 灰 → running 蓝脉冲 → done 绿 → failed 红(保留)。
  - **日志查看器升级**:等宽、固定高、自动滚底(保留),新增 **虚拟滚动**(长日志不卡)、**级别高亮**(meta 蓝 / normal / stderr 红)、**过滤/搜索**、**复制**、**跟随/暂停跟随**开关。

### 3.4 任务视图(TaskView)
- 左侧任务列表(Table/List):工作流/状态 Badge/时间;**加状态与时间过滤**(补 STATUS 缺口)。
- 右侧产物面板:步骤/输出/路径 + `在文件管理器打开`(xdg-open)/`查看`(仅 .ply/.pcd/.bag/.db3)。
- 点击行选中联动右侧。

### 3.5 设置页(新增)
- 接 `get_config/set_config`:数据目录、运行时(docker/podman)、GPU 开关、外部查看器路径(CloudCompare/MeshLab)、workspace。
- 顺带解决 STATUS 里“dev 须手动传 HERA_WORKSPACE”:前端提供设置项,或让后端支持 `.env`/自动检测(若涉及后端改动,先与我确认再动)。

---

## 4. 文件结构(迁移后)
```
src/
├── main.tsx / App.tsx          # 挂载 + 布局 + 路由(三视图)
├── api.ts                      # 保留:Tauri invoke 封装 + 类型
├── theme.ts                    # 组件库主题 <- 现有 CSS token
├── components/                 # 通用:Empty/Loading/ErrorState/LogViewer/Toast
└── views/  DataView / RunView / TaskView / SettingsView
```

---

## 5. 里程碑(逐个完成后停下让我确认)
- **M1 选型 + 骨架**:装 React+组件库+rjsf+lucide;搭外壳(侧边栏/header)+ 主题接现有 token;三视图空壳可切换。给我看外壳截图。
- **M2 通用组件**:Empty/Loading/ErrorState/**LogViewer(虚拟滚动+高亮+过滤)**/Toast(全局替换 `alert()`)。
- **M3 数据 + 任务视图**:Table 化 + dialog 浏览 + 过滤 + 产物操作。
- **M4 运行视图**:工作流卡片 + **rjsf 参数表单(兼容现有 schema)** + 进度/日志三步流。端到端跑通一次 `reconstruct_pointcloud`。
- **M5 设置页 + 收尾**:接 `get_config/set_config`;解决 workspace 手传;整体密度/间距/空态过一遍。

---

## 6. 约束
- **后端接口不变**:除非先与我确认,不改 `src-tauri` 命令签名。
- **每步可运行可回退**:不制造长期跑不起来的中间态;保留旧文件直到新屏验证通过再删。
- **观感延续**:配色沿用现有 token,不推翻你已有的深色设计语言。
- **无障碍与性能**:长列表/长日志用虚拟滚动;表单可键盘操作。

## 7. 需要我确认(开工前问我)
1. 组件库:antd(默认,快)还是 shadcn/ui+Tailwind(精致定制)?
2. 前端框架:React(默认)还是 Svelte?
3. 是否允许为“文件对话框/设置/workspace 自动检测”**新增少量后端命令**(还是纯前端解决)?

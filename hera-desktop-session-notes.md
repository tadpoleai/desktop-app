# Hera Desktop — 会话记录（2026-07-18）

> 目的：把这次在 Windows 上做的排查/修改整理出来，方便切到 Ubuntu 22.04 继续处理。
> 仓库：`git@github.com:tadpoleai/desktop-app.git`（分支 `master`）

---

## 1. macOS Gatekeeper 未签名问题（尚未处理，待定）

现象：macOS 安装时提示"Apple 无法验证'Hera Desktop'是否包含可能危害 Mac 安全或泄漏隐私的恶意软件"。

根因：`.github/workflows/release.yml` 用 `tauri-action` 构建 macOS universal dmg，但 `src-tauri/tauri.conf.json` 里没有配置任何签名信息，产物是未签名+未公证（notarize）的，Gatekeeper 直接拦截。

两个方向（尚未选定，之前讨论到一半被放下了）：
- **临时方案**：在 README/发布说明里加一段"右键打开"或 `xattr -cr /Applications/Hera\ Desktop.app` 的绕过说明，免费、几分钟能写好，但每个用户都要手动操作一次。
- **正式方案**：需要 Apple Developer Program 账号（$99/年）+ Developer ID Application 证书，在 CI 里配置 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` 等 GitHub Secrets，让 `tauri-action` 在构建时自动签名+公证，用户双击即可正常打开、无警告。

---

## 2. 三个细节 bug（已在 Ubuntu 工作区重新实现，`cargo check` + `tsc --noEmit` 均通过，**尚未 commit / push**）

用户反馈的原话：
1. 所有"打开文件夹"按钮（如"数据集"页的"打开目录"、"运行"页的"文件管理器"）都没有打开正确地址，只打开了默认的文件管理器。
2. "设置"页的"输出目录""数据目录"等应该能通过选择文件路径来设置；"外部工具"应该需要选择应用的地址，如果本地没有安装对应工具应该给予提示。

### 2.1 根因：路径分隔符假设错误

`DataView.tsx` / `MemoryView.tsx` / `TaskView.tsx` 里手写了 `path.split("/").slice(0, -1).join("/")` 之类的逻辑来算父目录/文件名。但 Rust 后端 `PathBuf` 在 Windows 上序列化出来的路径是反斜杠分隔的（`C:\Users\...\file.hera`），`.split("/")` 找不到 `/`，切出来直接是空字符串，传给 `explorer.exe ""` 就只会打开默认位置——这正是症状。

**影响范围比"打开目录"按钮更大**：数据集列表里从文件名解析日期/操作员/地点（`parseSessionFilename`）、文件名展示，在 Windows 上全都受影响（会显示整条路径而不是文件名）。

修复：`src/api.ts` 新增了同时兼容 `/` 和 `\` 的 `dirname()` / `basename()` 工具函数，替换了全部 7 处手写路径分割逻辑：
- `src/api.ts`：新增 `basename()`、`dirname()`
- `src/views/DataView.tsx`：文件名解析、显示、"打开目录"按钮
- `src/views/MemoryView.tsx`：`inputName()`、ply 文件名展示、"打开目录"按钮
- `src/views/TaskView.tsx`：`isDir` 判断、"文件管理器"按钮的 `dirPath`

### 2.2 设置页目录改为可浏览选择

`src/views/SettingsView.tsx`：输出目录 / 数据目录 / GLIM 配置目录 三个输入框旁加了"浏览…"按钮，复用已有的 `api.pickFolder()`（这个函数原来就在 `api.ts` 里，只是没接到设置页 UI 上）。

### 2.3 外部工具（点云查看器）改为可浏览选择 + 未安装提示

- 加了"浏览…"按钮（`api.pickFile()`）选择应用程序路径。
- 新增 Rust 命令 `resolve_tool`（`src-tauri/src/commands.rs`，已在 `lib.rs` 注册）：
  - 如果填的是路径，直接检查文件是否存在；
  - 如果填的是裸命令名（如 `cloudcompare`），按 `PATH`（Windows 上还会看 `PATHEXT`）搜索是否能找到。
  - 前端 `SettingsView.tsx` 在输入变化 400ms 后调用一次，找不到就在输入框下方显示红色提示"未检测到该工具，请确认已安装并且路径正确"。

### 2.4 顺带发现、**未修复**：`pointcloud_viewer` 配置项是死的

全仓库搜索确认：`pointcloud_viewer` 这个配置值除了在 `SettingsView.tsx` 里读写之外，Rust 后端从来没有用它来真正启动查看器——`MemoryView.tsx`"查看点云"、`TaskView.tsx`"查看"按钮，点下去都是走 `api.openPath()`（系统默认的文件管理器/关联程序打开），完全没读取这个配置。

如果要让这个设置项名副其实，需要：
- 新增一个 `open_with(path, app)` Rust 命令，`app` 给定时用 `Command::new(app).arg(path).spawn()`，否则退回现有的 `open_path` 逻辑；
- `MemoryView.tsx` / `TaskView.tsx` 里"查看点云" / "查看"按钮先 `api.getConfig()` 拿 `viewers.pointcloud_viewer`，有值就调用 `open_with`。

这一块本次会话里明确没有做，因为超出用户当时提的两个问题范围，只是记录下来，去 Ubuntu 后可以顺手一起改。

---

## 3. 代码改动现状（已解决：直接在 Ubuntu 上重新实现，跳过同步）

Windows 机器上的改动没有 push，session.diff 也在临时目录里，随时可能丢失，所以没有走"同步"这条路，而是直接选了 §3 原文里的第二个选项：照着 §2 的描述在 Ubuntu 工作区里重新改了一遍。

7 个文件的改动状态（`git status` 结果，与 Windows 机器上完全一致）：

```
 M src-tauri/src/commands.rs
 M src-tauri/src/lib.rs
 M src/api.ts
 M src/views/DataView.tsx
 M src/views/MemoryView.tsx
 M src/views/SettingsView.tsx
 M src/views/TaskView.tsx
```

验证：
- `npx tsc --noEmit` 通过；
- `cargo check`（在 `src-tauri` 下）通过；
- `dirname()`/`basename()` 用 Windows 反斜杠路径 + Unix 路径的真实用例跑过一遍 node 脚本，结果符合预期；
- `resolve_tool` 用一次性 Rust example 验证了四种场景（PATH 上的裸命令名存在/不存在、绝对路径存在/不存在），全部符合预期，example 用完已删除。
- **未做**：没有实机跑 `npm run tauri dev` 截图确认 UI（当前环境是 Wayland 会话，没有 scrot/grim 等截图工具），所以"设置页浏览按钮弹出选择框""红色提示文字实际渲染效果"这类纯 UI 观感还没有肉眼确认过，逻辑层面（调用的 API、状态流转）已核对。

---

## 4. 为什么切到 Ubuntu 能省安装时间

这台 Windows 机器上折腾的过程：
1. 装了 Rust（`rustup`，通过下载 `rustup-init.exe` 完成，`winget` 在这台机器上装什么都是静默失败，退出码 5，原因未知）；
2. 但 Tauri 在 Windows 上编译 Rust 后端还需要 MSVC 链接器（Visual Studio Build Tools 的"使用 C++ 的桌面开发"组件），这个包本身要几 GB，而且安装必须要管理员权限，我这边的命令行会话不是管理员身份，装不了，卡在这一步，最后用户选择改用 Ubuntu 继续。

Ubuntu 22.04 上不会遇到这两个问题：
- Rust：`curl https://sh.rustup.rs -sSf | sh` 一行装完，用户态即可，不需要额外的 C++ 编译器套件（Ubuntu 一般自带或 `build-essential` 一步到位，没有 MSVC 那种"几 GB + 必须管理员"的门槛）；
- 系统依赖：`.github/workflows/release.yml` 里 CI 用的就是 Ubuntu 22.04，包列表是现成的，可以直接抄：

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential curl \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libgtk-3-dev \
  libssl-dev \
  libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

之后在项目根目录：

```bash
npm install
npm run tauri dev
```

`npm run tauri dev` 会依次执行 `beforeDevCommand`（`npm run dev`，即 vite）和编译/启动 Rust 后端（`src-tauri`），跟 Windows 上是同一套流程，只是 Ubuntu 少了 MSVC 这一道坎。

---

## 5. 待办清单（去 Ubuntu 后）

- [ ] 按 §4 装好 apt 依赖 + rustup
- [ ] 决定 §3 的改动怎么带过去（commit+push+pull，还是重新改）
- [ ] `cargo check`（或 `cargo build`）验证 `resolve_tool` 等新增 Rust 代码能编译过
- [ ] `npm run tauri dev` 实机验证三个问题确实修好了：
  - 数据集/运行/记忆库页的"打开目录""文件管理器"按钮能打开正确路径
  - 设置页三个目录的"浏览…"按钮能弹出文件夹选择框，选完能存进配置
  - 点云查看器"浏览…"能选文件；填一个不存在的工具名能看到红色提示
- [ ] 决定是否顺手把 §2.4 的"查看点云/查看"按钮接到 `pointcloud_viewer` 配置上
- [ ] macOS Gatekeeper（§1）选一个方向推进

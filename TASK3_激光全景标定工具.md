# 任务书 ③:激光-全景相机标定工具(CalibrationView)

> 交给 Claude Code 执行。目标:在 hera-desktop 里新增一个标定工作流+视图——选一个含
> `.hera`/`.insv`/`.session.json` 的会话文件夹,自动判断静止/运动、跑激光重建(或跳过)、
> 跑全景拼接,然后在**左右分屏**里分别显示全景ERP图和点云深度图,用户在两侧点选匹配点
> (最少3组),一键解算激光-相机外参,叠加图实时预览确认后写回 `extrinsic.json`。
> **本期只做静止场景的完整实现;运动场景只搭数据模型和界面骨架(时间轴控件+多帧点集
> 管理),求解器留桩不接入**——运动标定是否要在本期一起做求解器,见 §9 开放问题。
> 复用已有算子(`glim-recon`/`panorama-stitch[-gpu]`),不重写它们;新增内容集中在
> 静止判断、标定求解、双视图选点交互三块。

---

## 0. 边界与原则

- **不重写现有算子**:GLIM 重建用现成的 `glim-recon`,全景拼接用
  `panorama-stitch-gpu`(本机GPU)/`panorama-stitch`(远程FC),两者的容器编排、
  日志、产物管理全部复用 `runner` crate 的 `JobRunner`。
- **flowstate 必须锁死为 false**:`workflows/panorama_stitch_gpu.json` 里已经是
  `"flowstate": false`,这是已确认的硬约束(flowstate=true 会让每帧独立做
  陀螺仪水平锁定,破坏"外参对整段会话固定不变"的前提)——本任务新增的标定
  工作流复用这个既有配置,**不得**在 UI 上把这个参数暴露给用户改。
- **自动判断不代替人工拍板**:静止/运动的自动检测结果、标定求解器给出的候选
  外参,都只是"建议",UI 必须留人工确认/覆盖的路径,不能自动写入
  `extrinsic.json` 而不经过人看叠加图确认这一步。这条原则来自实测教训(见
  `spatial-memory` 项目 `STATUS.md`:自动 yaw 打分对某一帧给出过明显错误结果)。
- **不臆造 CLI/字段**:本文档引用的 `hera-storage-extract-mid360` 等工具的参数,
  以 `/home/fred/Code/recorder/build_amd64/storage/` 下 `--help` 输出为准
  (M1 冒烟验证时核对);拿不准就停下问,不猜。

---

## 1. 现有资产(要接的真实东西)

- **GLIM 重建**:`operators/glim-recon`。留意它已经有
  `keyframe_strategy: OVERLAP | DISPLACEMENT`,`DISPLACEMENT` 的
  `description` 就写着"适用于静止/短距场景"——用户判断"静止时是否仍要跑
  GLIM",选"仍要跑"时就用这个策略,不用给 GLIM 本身加新参数。
- **全景拼接**:`operators/panorama-stitch-gpu`(本机)、`operators/panorama-stitch`
  (远程 FC,`hera_stitch_remote.py`)。`workflows/panorama_stitch_gpu.json` 已经
  固定 `stitch_type: optflow`、`flowstate: false`,直接复用这个工作流定义。
- **会话解析**:`src/api.ts` 的 `HeraSession`/`parseSessionFilename` 已经能从
  文件夹扫出 `.hera+.insv+.session.json` 三件套并解析 basename——文件夹选择器
  直接复用这段,不用重写。
- **DAG 执行**:`runner/src/dag.rs` 的 `JobRunner`(`JobEvent::StepStart/Log/
  StepComplete/...`)——新工作流复用这套事件流对接 UI 进度条,不新写一套。
- **静止判断的真实教训**(来自 `spatial-memory/CLAUDE.md` Phase 1 和
  `spatial-memory/STATUS.md` 2026-07-31 的"0731静态采集"记录):**不能只看
  gyro magnitude 阈值(0.02 rad/s)**。实测过一份真静止数据,gyro magnitude
  常年在 0.05-0.06 rad/s(超过阈值),但逐轴标准差只有 0.0008-0.0012——这是
  陀螺零偏(bias),不是真转动。判据必须同时看**方差**,不能只卡 magnitude。
  具体规则见 §2。
- **投影/标定数学的原型**:`spatial-memory` 仓库里已经有三份可以直接移植的
  代码,新工具的核心算法不用从零推:
  - `scripts/p3_project_check.py`:世界系→相机系投影(`cam_rot.inv().apply(...)`)
    + 等距柱状(ERP)投影公式(`lon=atan2(y,x)`, `lat=asin(z/r)`,
    `u=(0.5-lon/2π)·W`, `v=(0.5-lat/π)·H`)——叠加图生成直接照搬这套公式。
  - `scripts/p6_calibrate_static.py`:①`build_range_image`——点云按方位角/
    俯仰角分bin取最近点,得到"深度图",这就是右侧点云面板要显示的内容;
    ②Sobel边缘提取;③网格搜索打分。**网格搜索部分本任务不用**(教训:分辨力
    差,见下),但 `build_range_image` 直接复用,分bin/取最近点这套逻辑挪到
    Rust(或先用现成 Python 脚本验证再决定要不要重写)。
  - `work/phase3/extrinsic.json`:外参落盘的既有 schema
    (`translation_lidar_to_camera_m`/`rotation_lidar_to_camera_euler_xyz_deg`/
    `iteration_log`/`known_caveats`),§6 在此基础上扩展,不另起一套格式。
  - `scripts/p3_bind_pose.py`:GLIM 轨迹按时间戳做位姿 slerp 插值——运动标定
    的时间轴控件(§7)要用同一套插值逻辑取任意时刻的位姿。

---

## 2. 静止判断

- 输入:`hera-storage-extract-mid360 <basename>.hera --imu imu.csv`(或直接读
  IMU 流,不落盘,视 M1 实现方便程度)。
- 判据(逐轴,不是先求 magnitude 再判断):
  ```
  gyro_std[x], gyro_std[y], gyro_std[z] = 该会话陀螺仪三轴标准差
  静止 ⟺ max(gyro_std) < REST_STD_THRESHOLD (默认 0.005 rad/s,可调)
         且不存在明显阶跃(如简单实现:滑动窗口标准差本身的最大值也 < 阈值,
         避免"整体方差小但中间有一段真运动"被漏判)
  ```
- UI 上把 `max(gyro_std)` 数值和阈值线画出来(不只给一个"静止/运动"的布尔
  结论),并给一个手动覆盖开关:"我确认这是静止/运动,忽略自动判断"。
- 判定结果 → 分支:
  - **静止,选"跳过重建"**(默认):直接用 `hera-storage-extract-mid360` 导出
    的原始点云(LiDAR 自身坐标系当世界系,平移/旋转都是单位阵),不跑 GLIM。
  - **静止,选"仍跑GLIM"**:调用 `glim-recon`,`keyframe_strategy` 参数注入
    `DISPLACEMENT`(而不是默认 `OVERLAP`)。
  - **运动**:强制走 GLIM(`OVERLAP` 或用户自选策略),产出轨迹
    `trajectory.csv` 供 §7 时间轴使用。

---

## 3. 标定数学:球面模型下的点对解算

全景相机是等距柱状(ERP)投影,不是针孔模型,**不能**直接调
`cv2.solvePnP`。改成最小化"观测方向 vs 预测方向"夹角误差的非线性最小二乘:

- 用户在左图(全景)选的第 `i` 个点 → 像素 `(u_i,v_i)` → 反解成单位方向向量
  `d_obs_i`(camera 系,ERP 逆投影,公式是 `p3_project_check.py` 投影公式的
  反函数)。
- 用户在右图(点云深度图)选的第 `i` 个点 → 对应的 3D 点 `P_i`(LiDAR 系,
  深度图每个像素本来就存着生成它的那个原始点的 xyz,取出来即可,不需要
  反投影)。
- candidate 外参 `(R,t)`:预测方向 `d_pred_i = normalize(R⁻¹·(P_i - t))`。
- 目标函数:`minimize Σ_i weight_i · angle(d_obs_i, d_pred_i)²`
  (或用 `1 - dot(d_obs_i, d_pred_i)` 近似,数值更稳定,小角度下等价)。
- 优化器:Gauss-Newton/Levenberg-Marquardt,6 自由度(旋转用轴角或四元数
  局部扰动参数化,避免欧拉角万向锁)。**建议直接调库**(Rust `argmin` crate,
  或前期先用 Python `scipy.optimize.least_squares` 出个原型验证可行性,
  §9 开放问题里让你定 Rust 原生实现还是留一个 Python 侧车)。
- 初值:读 `extrinsic.json` 当前值(§6),不是从零开始搜——本来就是"微调"
  场景,不是从随机初值全局搜索。
- **不用网格搜索/边缘打分那套**:`p6_calibrate_static.py` 的自动打分法分辨力
  差(top10 候选参数差异很大但分数接近),那是给"没有人工选点、纯边缘对齐"
  场景兜底用的粗筛法。现在用户会显式点选匹配点,直接解方程,不需要再用那套
  弱信号搜索。
- 最少 3 组点对(3 个方向向量+3 个3D点理论上可解 6DOF,但容易病态/多解);
  UI 建议 4-6 组,并做**点位分布检查**:3 组点如果近似共线,或全部集中在
  ERP 图一个小角落,弹提示("点位过于集中,建议在图像不同区域多选几组")。
- 解算完成后,展示:解出的 `(roll,pitch,yaw,x,y,z)`、**每组点对的残差角度**
  (方便用户定位选歪的点)、以及全量点云投影叠加图(§4 强制人工确认这一步)。

---

## 4. 前端:CalibrationView 交互设计

新增 `src/views/CalibrationView.tsx`,风格与现有 `DataView`/`RunView` 一致
(antd 组件库,`invoke`/`listen` 对接 Tauri 命令,不引入 Three.js/WebGL 重型
依赖——参考 `spatial-memory` 项目"自己写 Canvas 选点,别整 CDN 依赖"的既有
经验,本项目是桌面 Tauri 应用没有 CSP 限制,但 Canvas 2D 已经够用,没必要
上 WebGL)。

**布局**:
```
┌─────────────────────────┬─────────────────────────┐
│  左:全景 ERP 图 (Canvas)  │  右:点云深度图 (Canvas)   │
│  - 缩放/平移              │  - 深度伪彩色 (turbo colormap) │
│  - 点击选点,编号显示        │  - 点击选点,编号显示,自动配对左侧同序号 │
├─────────────────────────┴─────────────────────────┤
│  参数面板:外参xyz(滑块+输入框,默认值来自extrinsic.json,   │
│  限制小范围) / 旋转rpy(同) / 时间偏移(静止场景禁用,置灰)   │
│  [重置默认] [解算] [生成叠加预览] [保存]                    │
├─────────────────────────────────────────────────────┤
│  底部:点对列表(编号/左图坐标/右图3D坐标/残差角度),         │
│  可删除某一组重新选;解算后残差过大的行高亮红色              │
└─────────────────────────────────────────────────────┘
```

- **选点模式**:左右各自维护一个"待配对"点,ui 上明确当前"正在等左边第N点"
  还是"正在等右边第N点",避免点错序号错位配对。
- **参数改动 → 实时预览**:拖动 xyz/rpy 滑块时,用当前参数重新生成叠加图
  (可以只投影一个抽稀子集,比如每50个点取1个,保证交互流畅;"生成叠加预览"
  按钮用全量点云生成最终确认用的高精度版本)。
- **保存前必须看过叠加图**:"保存"按钮在用户至少点过一次"生成叠加预览"
  (全量版本)之前保持禁用,强制走人工确认这一步。

---

## 5. 新增 Tauri 命令(草案,函数名/参数以 M1 实现时定稿)

```rust
// src-tauri/src/commands.rs 新增
check_session_motion(session_path) -> MotionCheckResult { gyro_std: [f32;3], is_static: bool, threshold: f32 }
extract_raw_pointcloud(hera_path) -> PointCloudHandle   // 静止跳过GLIM分支
build_range_image(pointcloud_handle, az_bins, el_bins) -> RangeImageHandle  // 右侧面板数据源,只算一次
project_overlay(pointcloud_handle, extrinsic, panorama_path, subsample) -> image_bytes  // 参数面板实时预览
solve_extrinsic(point_pairs: Vec<PointPair>, initial_extrinsic) -> { extrinsic, residuals: Vec<f32> }
save_extrinsic(session_path, extrinsic, point_pairs, note) -> ()  // 写 extrinsic.json,追加 iteration_log
```

---

## 6. `extrinsic.json` schema 扩展

在 `work/phase3/extrinsic.json`(spatial-memory 项目)已有字段基础上扩展,
**不改字段名/不破坏现有消费方**,只新增:

```jsonc
{
  // ...既有字段(translation_lidar_to_camera_m / rotation_lidar_to_camera_euler_xyz_deg /
  //   iteration_count / iteration_log / known_caveats / status)保持不变...
  "calibrated_by": "calibration-tool",   // 区分"人工肉眼调"还是"工具点选解算"
  "point_pairs_used": 5,
  "residuals_deg": [0.8, 1.2, 0.5, 2.1, 0.9],
  "source_session": "20260731214622_fred_home",
  "motion_state": "static"               // static | motion,motion时额外记 frame_timestamps
}
```

---

## 7. 运动场景:本期只搭骨架,不接求解器

用户要求"预留运动情况下的标定",本期范围:

- **数据模型**:`PointPair` 增加 `frame_timestamp_ns` 字段(静止场景固定为
  会话起始时间,运动场景取用户当前拖到的时间轴位置)。
- **时间轴控件**:`CalibrationView` 顶部加一个时间轴滑块(复用
  `trajectory.csv` 的时间范围),拖动时:①右侧点云面板重新按当前时刻的
  轨迹位姿(`p3_bind_pose.py` 的 slerp 插值逻辑移植)切一帧局部点云;②左侧
  全景图切到对应时间戳最近的那一帧拼接结果。
- **多帧点集管理**:底部点对列表增加"帧"这一列,同一批标定可以来自不同
  时间戳的多组点对。
- **求解器接口预留但不实现**:`solve_extrinsic` 签名设计成接受
  `Vec<(frame_pose, Vec<PointPair>)>`(而不是本期静止场景的单一
  `Vec<PointPair>>`),多帧场景下目标函数是所有帧、所有点对残差之和,
  共享同一个待解的外参——**函数体本期只处理"单帧"这一种输入,多帧输入先
  报"暂不支持,敬请期待",不写一半假通过**。
- 好处:静止场景验证扎实后,运动场景只用补目标函数里的"多帧求和"这一块,
  UI 和数据流不用重做。

---

## 8. 里程碑(逐个完成后停下让我确认)

- **M1 静止判断 + 会话读取**:文件夹选择器复用 `HeraSession` 解析;
  `check_session_motion` 命令跑通,数字对不对(和手算的 gyro std 对一遍)
  给我看。
- **M2 拼接+提取流水线接入**:静止/运动分支都能跑通,产出全景帧+点云,
  复用 `JobRunner` 事件流在 UI 显示进度。
- **M3 双视图选点**:`CalibrationView` 左右分屏、Canvas 选点、点对配对+
  列表管理,先不接解算,能选点、能看到列表就算过。
- **M4 标定求解 + 叠加预览**:`solve_extrinsic` 跑通(先用现成一份点对
  离线验证解出来的外参合理),叠加图实时预览、残差展示、保存流程(含强制
  "先预览再保存"这道闸)。
- **M5 运动场景骨架**:时间轴控件、多帧点对数据模型、`solve_extrinsic`
  的多帧签名(报"暂不支持"占位),不需要求解器真正跑通多帧。

---

## 9. 需要我确认(开工前问我)

1. **标定求解器实现语言**:Rust 原生(`argmin` crate 或手写
   Gauss-Newton,零额外运行时依赖)还是先用 Python 侧车验证数学再决定要不要
   移植(更快出原型,但要接一个 Python 运行时进 Tauri 应用)?我倾向前者,
   但想让你定。
2. **静止场景"跳过GLIM"的点云提取**,是包成一个新容器算子(和现有平台风格
   一致,`hera-storage-extract-mid360` 套个 Dockerfile),还是作为 Tauri 直接
   调本机二进制的特例(更快接入,但这一步就不走 `JobRunner` 那套容器执行/
   日志基础设施了)?
3. `build_range_image`(点云→深度图,§1 提到的核心可视化数据源)要挪到 Rust
   原生实现,还是本期先接一个小的 Python 脚本(`p6_calibrate_static.py` 已有
   现成代码)跑通交互原型,后面再决定要不要重写?
4. M5 的运动场景骨架,是这次一起做,还是单独另开一个任务书(独立里程碑,
   本任务书到 M4 就算完)?

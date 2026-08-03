//! Static-scene laser-panorama extrinsic calibration (TASK3_激光全景标定工具.md
//! §3): given ≥3 matched point pairs (an ERP pixel + a LiDAR-frame 3D point per
//! pair), refine (R,t) by minimizing the angular mismatch between each pair's
//! observed ERP viewing direction and its predicted direction under the
//! candidate extrinsic. Not solvePnP — the panorama is an equirectangular (ERP)
//! projection, not a pinhole camera.
//!
//! Convention — matched exactly to the existing, real calibration artifacts in
//! the `spatial-memory` repo (not invented here, and deliberately NOT the same
//! convention as this repo's own `injector.rs::rpy_deg_to_quat`, which is an
//! unrelated ZYX convention used for GLIM's LiDAR mounting angle):
//!   - `scripts/p3_bind_pose.py`: `T_LIDAR_CAMERA_ROT = Rotation.from_euler
//!     ("xyz", [roll, pitch, yaw], degrees=True)` — scipy lowercase seq is
//!     *intrinsic* rotation, which composes as R = Rx(roll)·Ry(pitch)·Rz(yaw).
//!   - `scripts/p3_project_check.py`: `pts_cam = cam_rot.inv().apply(world -
//!     cam_pos)`, i.e. camera-frame point = R⁻¹·(P_world - t) — for the static
//!     case (no GLIM trajectory, LiDAR frame *is* world frame) this is exactly
//!     task doc §3's `d_pred = normalize(R⁻¹·(P - t))`.
//!   - `scripts/p3_project_check.py::project_equirect`: `lon=atan2(y,x)`,
//!     `lat=asin(z/r)`, `u=(0.5-lon/2π)·W`, `v=(0.5-lat/π)·H`.
//!   - `work/phase3/extrinsic.json`: field names `translation_lidar_to_camera_m`
//!     / `rotation_lidar_to_camera_euler_xyz_deg` — reused as-is in §6.

use nalgebra::{Matrix6, Vector6};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Extrinsic {
    pub tx: f64,
    pub ty: f64,
    pub tz: f64,
    pub roll_deg: f64,
    pub pitch_deg: f64,
    pub yaw_deg: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PointPair {
    /// ERP pixel coordinates (u,v) of the user's click on the panorama.
    pub u: f64,
    pub v: f64,
    /// LiDAR-frame 3D point (x,y,z) at the paired click on the range image.
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// §7: fixed to the session start for static scenes, the scrubbed timeline
    /// position for motion scenes. Not used by the solver yet (single-frame
    /// only, see `solve_extrinsic`) — carried through so the point-pair list
    /// UI can show/group by frame ahead of the motion solver landing.
    #[serde(default)]
    pub frame_timestamp_ns: Option<u64>,
}

/// One timeline frame's worth of point pairs + the LiDAR pose at that frame
/// (`None` for the static case, where the point cloud is already in the
/// LiDAR's own frame and there's no trajectory to place it against).
/// §7: `solve_extrinsic` takes `Vec<FrameGroup>` instead of a bare
/// `Vec<PointPair>` so the motion solver (multi-frame residual sum, sharing
/// one extrinsic across frames) can land later without changing this shape —
/// this milestone only implements the single-frame case.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameGroup {
    pub frame_pose: Option<crate::trajectory::Pose>,
    pub pairs: Vec<PointPair>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SolveResult {
    pub extrinsic: Extrinsic,
    /// Per-pair residual angle in degrees, same order as the input pairs —
    /// lets the UI flag which pair looks mis-picked.
    pub residuals_deg: Vec<f64>,
    pub iterations: usize,
    pub converged: bool,
    pub rms_residual_deg: f64,
}

type Mat3 = [[f64; 3]; 3];

fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

fn mat_transpose(a: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = a[j][i];
        }
    }
    out
}

fn mat_vec(a: &Mat3, v: [f64; 3]) -> [f64; 3] {
    let mut out = [0.0; 3];
    for i in 0..3 {
        out[i] = a[i][0] * v[0] + a[i][1] * v[1] + a[i][2] * v[2];
    }
    out
}

fn rot_x(a: f64) -> Mat3 {
    let (s, c) = a.sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]
}
fn rot_y(a: f64) -> Mat3 {
    let (s, c) = a.sin_cos();
    [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]
}
fn rot_z(a: f64) -> Mat3 {
    let (s, c) = a.sin_cos();
    [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
}

/// R = Rx(roll)·Ry(pitch)·Rz(yaw) — see module doc for why this exact order.
fn rpy_deg_to_matrix(roll_deg: f64, pitch_deg: f64, yaw_deg: f64) -> Mat3 {
    let rx = rot_x(roll_deg.to_radians());
    let ry = rot_y(pitch_deg.to_radians());
    let rz = rot_z(yaw_deg.to_radians());
    mat_mul(&mat_mul(&rx, &ry), &rz)
}

/// Inverse of `rpy_deg_to_matrix` — hand-derived from R = Rx(roll)Ry(pitch)Rz(yaw)
/// expanded to element form: R[0][2]=sin(pitch), R[1][2]=-sin(roll)cos(pitch),
/// R[2][2]=cos(roll)cos(pitch), R[0][0]=cos(pitch)cos(yaw), R[0][1]=-cos(pitch)sin(yaw).
fn matrix_to_rpy_deg(r: &Mat3) -> (f64, f64, f64) {
    let pitch = r[0][2].clamp(-1.0, 1.0).asin();
    let roll = (-r[1][2]).atan2(r[2][2]);
    let yaw = (-r[0][1]).atan2(r[0][0]);
    (roll.to_degrees(), pitch.to_degrees(), yaw.to_degrees())
}

/// Rodrigues' formula: axis-angle vector `w` (radians, |w| = angle) -> rotation matrix.
fn rodrigues(w: [f64; 3]) -> Mat3 {
    let theta = (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt();
    if theta < 1e-12 {
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    }
    let k = [w[0] / theta, w[1] / theta, w[2] / theta];
    let kx: Mat3 = [[0.0, -k[2], k[1]], [k[2], 0.0, -k[0]], [-k[1], k[0], 0.0]];
    let kx2 = mat_mul(&kx, &kx);
    let (s, c) = theta.sin_cos();
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            let ident = if i == j { 1.0 } else { 0.0 };
            out[i][j] = ident + s * kx[i][j] + (1.0 - c) * kx2[i][j];
        }
    }
    out
}

fn normalize(v: [f64; 3]) -> [f64; 3] {
    let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if n < 1e-12 {
        return [0.0, 0.0, 1.0];
    }
    [v[0] / n, v[1] / n, v[2] / n]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Inverse of the forward ERP projection in `p3_project_check.py::project_equirect`
/// (`lon=atan2(y,x)`, `lat=asin(z/r)`, `u=(0.5-lon/2π)·W`, `v=(0.5-lat/π)·H`):
/// pixel -> unit direction in camera frame.
pub fn erp_pixel_to_direction(u: f64, v: f64, width: f64, height: f64) -> [f64; 3] {
    let lon = (0.5 - u / width) * 2.0 * std::f64::consts::PI;
    let lat = (0.5 - v / height) * std::f64::consts::PI;
    let (sin_lat, cos_lat) = lat.sin_cos();
    let (sin_lon, cos_lon) = lon.sin_cos();
    [cos_lat * cos_lon, cos_lat * sin_lon, sin_lat]
}

/// Forward ERP projection (camera-frame unit/non-unit direction -> pixel),
/// exactly `project_equirect` in `p3_project_check.py`.
pub fn direction_to_erp_pixel(d: [f64; 3], width: f64, height: f64) -> (f64, f64) {
    let r = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt().max(1e-9);
    let lon = d[1].atan2(d[0]);
    let lat = (d[2] / r).clamp(-1.0, 1.0).asin();
    let u = (0.5 - lon / (2.0 * std::f64::consts::PI)) * width;
    let v = (0.5 - lat / std::f64::consts::PI) * height;
    (u, v)
}

/// d_pred = normalize(R⁻¹·(P - t)) — R⁻¹ = Rᵀ since R is orthonormal.
fn predicted_direction(ext: &Extrinsic, p: [f64; 3]) -> [f64; 3] {
    let r = rpy_deg_to_matrix(ext.roll_deg, ext.pitch_deg, ext.yaw_deg);
    let r_inv = mat_transpose(&r);
    let rel = [p[0] - ext.tx, p[1] - ext.ty, p[2] - ext.tz];
    normalize(mat_vec(&r_inv, rel))
}

fn residual_angle_deg(obs: [f64; 3], pred: [f64; 3]) -> f64 {
    dot(obs, pred).clamp(-1.0, 1.0).acos().to_degrees()
}

/// `1 - dot(obs,pred)` — the doc's suggested stable small-angle proxy for
/// angle², used as the actual least-squares residual (residual_angle_deg above
/// is for *reporting*, not for the optimizer).
fn residual_scalar(obs: [f64; 3], pred: [f64; 3]) -> f64 {
    1.0 - dot(obs, pred)
}

fn cost(ext: &Extrinsic, obs_dirs: &[[f64; 3]], points: &[[f64; 3]]) -> f64 {
    obs_dirs
        .iter()
        .zip(points)
        .map(|(obs, p)| {
            let r = residual_scalar(*obs, predicted_direction(ext, *p));
            r * r
        })
        .sum()
}

/// Apply a 6-vector local update `[dwx,dwy,dwz,dtx,dty,dtz]` on top of `ext`:
/// rotation perturbed on the manifold via Rodrigues exp map (avoids gimbal
/// lock — task doc §3 explicitly asks for this instead of raw Euler deltas),
/// translation is a plain additive update.
fn apply_update(ext: &Extrinsic, dx: &Vector6<f64>) -> Extrinsic {
    let r = rpy_deg_to_matrix(ext.roll_deg, ext.pitch_deg, ext.yaw_deg);
    let dw = [dx[0], dx[1], dx[2]];
    let r_new = mat_mul(&r, &rodrigues(dw));
    let (roll, pitch, yaw) = matrix_to_rpy_deg(&r_new);
    Extrinsic {
        tx: ext.tx + dx[3],
        ty: ext.ty + dx[4],
        tz: ext.tz + dx[5],
        roll_deg: roll,
        pitch_deg: pitch,
        yaw_deg: yaw,
    }
}

const MAX_ITERS: usize = 100;
const JAC_EPS: f64 = 1e-6;
const CONVERGE_STEP_NORM: f64 = 1e-10;

/// §7/§8 (M5): accepts `frames` shaped for the future multi-frame motion
/// solver (target objective = sum of residuals across all frames' pairs,
/// sharing one extrinsic), but this milestone only implements the single-frame
/// case — multiple frames report "not supported" rather than a half-correct
/// partial implementation (task doc is explicit about this: "不写一半假通过").
pub fn solve_extrinsic(
    frames: &[FrameGroup],
    initial: Extrinsic,
    erp_width: f64,
    erp_height: f64,
) -> anyhow::Result<SolveResult> {
    if frames.len() > 1 {
        anyhow::bail!("暂不支持多帧标定，敬请期待（当前 {} 帧）", frames.len());
    }
    let pairs: &[PointPair] = frames.first().map(|f| f.pairs.as_slice()).unwrap_or(&[]);
    if pairs.len() < 3 {
        anyhow::bail!("需要至少 3 组点对才能解算（当前 {} 组）", pairs.len());
    }

    let obs_dirs: Vec<[f64; 3]> = pairs
        .iter()
        .map(|p| erp_pixel_to_direction(p.u, p.v, erp_width, erp_height))
        .collect();
    let points: Vec<[f64; 3]> = pairs.iter().map(|p| [p.x, p.y, p.z]).collect();
    let n = pairs.len();

    let mut ext = initial;
    let mut lambda = 1e-3_f64;
    let mut cur_cost = cost(&ext, &obs_dirs, &points);
    let mut converged = false;
    let mut iters_used = 0;

    for iter in 0..MAX_ITERS {
        iters_used = iter + 1;

        // Residual vector at current linearization point.
        let r0: Vec<f64> = obs_dirs
            .iter()
            .zip(&points)
            .map(|(obs, p)| residual_scalar(*obs, predicted_direction(&ext, *p)))
            .collect();

        // Numerical (central-difference) Jacobian, N x 6.
        let mut jac = vec![[0.0_f64; 6]; n];
        for j in 0..6 {
            let mut dplus = Vector6::zeros();
            dplus[j] = JAC_EPS;
            let mut dminus = Vector6::zeros();
            dminus[j] = -JAC_EPS;
            let ext_plus = apply_update(&ext, &dplus);
            let ext_minus = apply_update(&ext, &dminus);
            for i in 0..n {
                let rp = residual_scalar(obs_dirs[i], predicted_direction(&ext_plus, points[i]));
                let rm = residual_scalar(obs_dirs[i], predicted_direction(&ext_minus, points[i]));
                jac[i][j] = (rp - rm) / (2.0 * JAC_EPS);
            }
        }

        // Normal equations: (JᵀJ + λ·diag(JᵀJ)) dx = -Jᵀr
        let mut jtj = Matrix6::<f64>::zeros();
        let mut jtr = Vector6::<f64>::zeros();
        for i in 0..n {
            for a in 0..6 {
                jtr[a] += jac[i][a] * r0[i];
                for b in 0..6 {
                    jtj[(a, b)] += jac[i][a] * jac[i][b];
                }
            }
        }

        let mut solved = false;
        let mut dx = Vector6::zeros();
        // Try increasing damping until the damped system is solvable and the
        // step actually reduces cost (standard LM trust-region behavior).
        for _ in 0..20 {
            let mut lhs = jtj;
            for a in 0..6 {
                lhs[(a, a)] += lambda * jtj[(a, a)].max(1e-12);
            }
            let rhs = -jtr;
            if let Some(step) = lhs.lu().solve(&rhs) {
                let ext_trial = apply_update(&ext, &step);
                let trial_cost = cost(&ext_trial, &obs_dirs, &points);
                if trial_cost.is_finite() && trial_cost <= cur_cost {
                    dx = step;
                    ext = ext_trial;
                    cur_cost = trial_cost;
                    lambda = (lambda / 3.0).max(1e-12);
                    solved = true;
                    break;
                }
            }
            lambda *= 4.0;
            if lambda > 1e10 {
                break;
            }
        }

        if !solved {
            // Damping maxed out without an improving step — converged (or stuck).
            converged = true;
            break;
        }
        if dx.norm() < CONVERGE_STEP_NORM {
            converged = true;
            break;
        }
    }

    let residuals_deg: Vec<f64> = obs_dirs
        .iter()
        .zip(&points)
        .map(|(obs, p)| residual_angle_deg(*obs, predicted_direction(&ext, *p)))
        .collect();
    let rms_residual_deg = (residuals_deg.iter().map(|d| d * d).sum::<f64>() / n as f64).sqrt();

    Ok(SolveResult { extrinsic: ext, residuals_deg, iterations: iters_used, converged, rms_residual_deg })
}

// ── Overlay preview ──────────────────────────────────────────────────────────

/// Projects (a subsample of) `points` through `extrinsic` onto `base` (the ERP
/// panorama frame), colored by range, for human confirmation before saving —
/// task doc §0/§4: the solver's output is only ever a suggestion, this is the
/// forced "look at it" step before `extrinsic.json` gets written.
pub fn project_overlay(
    points: &[[f32; 3]],
    extrinsic: Extrinsic,
    base: &image::RgbImage,
    subsample: usize,
) -> image::RgbImage {
    let mut img = base.clone();
    let (width, height) = (img.width() as f64, img.height() as f64);
    let step = subsample.max(1);

    for p in points.iter().step_by(step) {
        let p64 = [p[0] as f64, p[1] as f64, p[2] as f64];
        let rel = [p64[0] - extrinsic.tx, p64[1] - extrinsic.ty, p64[2] - extrinsic.tz];
        let range = (rel[0] * rel[0] + rel[1] * rel[1] + rel[2] * rel[2]).sqrt();
        if !range.is_finite() || range <= 1e-3 {
            continue;
        }
        let r = rpy_deg_to_matrix(extrinsic.roll_deg, extrinsic.pitch_deg, extrinsic.yaw_deg);
        let d_cam = mat_vec(&mat_transpose(&r), rel);
        let (u, v) = direction_to_erp_pixel(d_cam, width, height);
        if u < 0.0 || u >= width || v < 0.0 || v >= height {
            continue;
        }
        let t = (range / 8.0).clamp(0.0, 1.0);
        let color = range_color(t);
        for dx in -1..=1i32 {
            for dy in -1..=1i32 {
                let px = (u as i32 + dx).clamp(0, width as i32 - 1) as u32;
                let py = (v as i32 + dy).clamp(0, height as i32 - 1) as u32;
                img.put_pixel(px, py, image::Rgb(color));
            }
        }
    }
    img
}

/// Same jet-style stops as `rangeimage.rs::colormap`, reused here so the
/// overlay's near/far color language matches the depth-image panel.
fn range_color(t: f64) -> [u8; 3] {
    const STOPS: [(f64, [u8; 3]); 5] = [
        (0.00, [37, 24, 92]),
        (0.25, [33, 144, 214]),
        (0.50, [70, 199, 120]),
        (0.75, [247, 217, 60]),
        (1.00, [214, 39, 40]),
    ];
    let t = t.clamp(0.0, 1.0);
    for w in STOPS.windows(2) {
        let (t0, c0) = w[0];
        let (t1, c1) = w[1];
        if t <= t1 {
            let f = if t1 > t0 { (t - t0) / (t1 - t0) } else { 0.0 };
            return [
                lerp8(c0[0], c1[0], f),
                lerp8(c0[1], c1[1], f),
                lerp8(c0[2], c1[2], f),
            ];
        }
    }
    STOPS[4].1
}

fn lerp8(a: u8, b: u8, f: f64) -> u8 {
    (a as f64 + (b as f64 - a as f64) * f).round().clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn euler_matrix_round_trip() {
        // Includes a case near the real spatial-memory-confirmed value (yaw~90)
        // and cases away from the pitch=+/-90 gimbal-lock boundary (matrix_to_rpy_deg's
        // atan2 extraction is only well-defined there, same as every other Euler
        // convention — not a bug specific to this one).
        let cases = [
            (0.0, 0.0, 0.0),
            (0.0, 0.0, 90.0),
            (2.0, -1.5, 91.0),
            (10.0, 20.0, 30.0),
            (-45.0, 60.0, -170.0),
            (5.0, -80.0, 45.0),
        ];
        for (roll, pitch, yaw) in cases {
            let m = rpy_deg_to_matrix(roll, pitch, yaw);
            let (r2, p2, y2) = matrix_to_rpy_deg(&m);
            assert!((r2 - roll).abs() < 1e-8, "roll: {r2} vs {roll}");
            assert!((p2 - pitch).abs() < 1e-8, "pitch: {p2} vs {pitch}");
            assert!((y2 - yaw).abs() < 1e-8, "yaw: {y2} vs {yaw}");
        }
    }

    /// Matches p3_project_check.py's `project_equirect`: at lon=0 (straight ahead,
    /// +X), lat=0, the pixel should be exactly image center per `u=(0.5-0)·W`.
    #[test]
    fn erp_projection_forward_center() {
        let (u, v) = direction_to_erp_pixel([1.0, 0.0, 0.0], 3840.0, 1920.0);
        assert!((u - 1920.0).abs() < 1e-9);
        assert!((v - 960.0).abs() < 1e-9);
    }

    #[test]
    fn erp_projection_round_trip() {
        for (u, v) in [(0.0, 0.0), (1920.0, 960.0), (3839.0, 1.0), (100.0, 1919.0), (2500.0, 300.0)] {
            let d = erp_pixel_to_direction(u, v, 3840.0, 1920.0);
            let (u2, v2) = direction_to_erp_pixel(d, 3840.0, 1920.0);
            assert!((u2 - u).abs() < 1e-6, "u: {u2} vs {u}");
            assert!((v2 - v).abs() < 1e-6, "v: {v2} vs {v}");
        }
    }

    /// Core correctness check: fabricate a known extrinsic, forward-project a
    /// handful of non-degenerate 3D points through it to get "what the user
    /// would have clicked" ERP pixels, then confirm solve_extrinsic recovers the
    /// known extrinsic from a deliberately perturbed initial guess — mirrors the
    /// doc's real usage pattern (§3: initial value is the *current* extrinsic.json,
    /// solve is a local refinement, not a from-scratch search).
    #[test]
    fn solve_recovers_known_extrinsic() {
        let truth = Extrinsic { tx: 0.02, ty: -0.01, tz: 0.16, roll_deg: 2.0, pitch_deg: -1.5, yaw_deg: 91.0 };
        let width = 3840.0;
        let height = 1920.0;

        // Spread across azimuth/elevation/range — not collinear, not clustered
        // (the doc explicitly flags clustered points as poorly-conditioned).
        let lidar_points: Vec<[f64; 3]> = vec![
            [3.0, 1.0, 0.2],
            [-2.0, 2.5, -0.5],
            [1.5, -3.0, 1.0],
            [-1.0, -2.0, -1.2],
            [4.0, -0.5, 0.8],
            [0.5, 3.5, -0.3],
        ];

        let pairs: Vec<PointPair> = lidar_points
            .iter()
            .map(|p| {
                let d_true = predicted_direction(&truth, *p);
                let (u, v) = direction_to_erp_pixel(d_true, width, height);
                PointPair { u, v, x: p[0], y: p[1], z: p[2], frame_timestamp_ns: None }
            })
            .collect();
        let frames = vec![FrameGroup { frame_pose: None, pairs: pairs.clone() }];

        // Sanity: at the exact ground truth, residuals must already be ~0 (the
        // pair's pixel was generated by forward-projecting through `truth` in
        // the first place — 1e-4 deg headroom accounts for going through
        // trig functions twice, pixel space and back, not an expected bug
        // margin). If this fails, the bug is in predicted_direction/erp
        // projection consistency, not in the optimizer.
        for pair in &pairs {
            let obs = erp_pixel_to_direction(pair.u, pair.v, width, height);
            let pred = predicted_direction(&truth, [pair.x, pair.y, pair.z]);
            assert!(residual_angle_deg(obs, pred) < 1e-4);
        }

        let initial = Extrinsic { tx: 0.0, ty: 0.0, tz: 0.10, roll_deg: 0.0, pitch_deg: 0.0, yaw_deg: 80.0 };
        let result = solve_extrinsic(&frames, initial, width, height).expect("solve failed");

        assert!(result.converged, "did not converge");
        assert!(result.rms_residual_deg < 1e-3, "rms residual too high: {}", result.rms_residual_deg);
        assert!((result.extrinsic.tx - truth.tx).abs() < 1e-4, "tx: {} vs {}", result.extrinsic.tx, truth.tx);
        assert!((result.extrinsic.ty - truth.ty).abs() < 1e-4, "ty: {} vs {}", result.extrinsic.ty, truth.ty);
        assert!((result.extrinsic.tz - truth.tz).abs() < 1e-4, "tz: {} vs {}", result.extrinsic.tz, truth.tz);
        assert!((result.extrinsic.roll_deg - truth.roll_deg).abs() < 1e-2, "roll: {} vs {}", result.extrinsic.roll_deg, truth.roll_deg);
        assert!((result.extrinsic.pitch_deg - truth.pitch_deg).abs() < 1e-2, "pitch: {} vs {}", result.extrinsic.pitch_deg, truth.pitch_deg);
        assert!((result.extrinsic.yaw_deg - truth.yaw_deg).abs() < 1e-2, "yaw: {} vs {}", result.extrinsic.yaw_deg, truth.yaw_deg);
    }

    #[test]
    fn solve_rejects_fewer_than_three_pairs() {
        let pairs = vec![
            PointPair { u: 100.0, v: 100.0, x: 1.0, y: 0.0, z: 0.0, frame_timestamp_ns: None },
            PointPair { u: 200.0, v: 200.0, x: 0.0, y: 1.0, z: 0.0, frame_timestamp_ns: None },
        ];
        let frames = vec![FrameGroup { frame_pose: None, pairs }];
        let initial = Extrinsic { tx: 0.0, ty: 0.0, tz: 0.0, roll_deg: 0.0, pitch_deg: 0.0, yaw_deg: 0.0 };
        assert!(solve_extrinsic(&frames, initial, 3840.0, 1920.0).is_err());
    }

    #[test]
    fn solve_rejects_more_than_one_frame() {
        let pair = PointPair { u: 100.0, v: 100.0, x: 1.0, y: 0.0, z: 0.0, frame_timestamp_ns: Some(0) };
        let frames = vec![
            FrameGroup { frame_pose: None, pairs: vec![pair, pair, pair] },
            FrameGroup { frame_pose: None, pairs: vec![pair, pair, pair] },
        ];
        let initial = Extrinsic { tx: 0.0, ty: 0.0, tz: 0.0, roll_deg: 0.0, pitch_deg: 0.0, yaw_deg: 0.0 };
        let err = solve_extrinsic(&frames, initial, 3840.0, 1920.0).unwrap_err();
        assert!(err.to_string().contains("暂不支持"), "unexpected error: {err}");
    }
}

//! GLIM trajectory loading + pose interpolation for the motion-scene skeleton
//! (TASK3_激光全景标定工具.md §7). Ported from `p3_bind_pose.py`'s
//! `interpolate_pose` (position: linear, attitude: slerp).
//!
//! File location/format confirmed from `p2_load_traj.py`'s own doc comment
//! (not guessed): GLIM's map output directory (= glim-recon's `map` artifact)
//! writes the globally-optimized, loop-closed trajectory directly at
//! `<map_dir>/traj_lidar.txt`, TUM format (`t x y z qx qy qz qw`,
//! whitespace-separated, `#`-prefixed comment lines), timestamp in seconds.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Pose {
    pub pos: [f64; 3],
    /// [x, y, z, w]
    pub quat_xyzw: [f64; 4],
}

#[derive(Debug, Clone, Copy)]
pub struct TrajectoryPoint {
    pub t: f64,
    pub pose: Pose,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrajectoryInfo {
    pub t_min: f64,
    pub t_max: f64,
    pub count: usize,
}

pub fn load_trajectory(path: &Path) -> anyhow::Result<Vec<TrajectoryPoint>> {
    let text = std::fs::read_to_string(path)?;
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 8 {
            continue;
        }
        let vals: Vec<f64> = parts[..8]
            .iter()
            .map(|s| s.parse::<f64>())
            .collect::<Result<_, _>>()?;
        out.push(TrajectoryPoint {
            t: vals[0],
            pose: Pose {
                pos: [vals[1], vals[2], vals[3]],
                quat_xyzw: [vals[4], vals[5], vals[6], vals[7]],
            },
        });
    }
    out.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    if out.is_empty() {
        anyhow::bail!("trajectory file has no valid pose rows: {}", path.display());
    }
    Ok(out)
}

pub fn trajectory_info(traj: &[TrajectoryPoint]) -> TrajectoryInfo {
    TrajectoryInfo {
        t_min: traj.first().map(|p| p.t).unwrap_or(0.0),
        t_max: traj.last().map(|p| p.t).unwrap_or(0.0),
        count: traj.len(),
    }
}

fn quat_normalize(q: [f64; 4]) -> [f64; 4] {
    let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if n < 1e-12 {
        return [0.0, 0.0, 0.0, 1.0];
    }
    [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

/// Spherical linear interpolation, shortest-path (negates `b` if the dot
/// product is negative — otherwise slerp can take the long way around and
/// even produce a discontinuous jump between adjacent trajectory poses).
fn slerp(a: [f64; 4], b: [f64; 4], t: f64) -> [f64; 4] {
    let a = quat_normalize(a);
    let mut b = quat_normalize(b);
    let mut dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if dot < 0.0 {
        b = [-b[0], -b[1], -b[2], -b[3]];
        dot = -dot;
    }
    dot = dot.clamp(-1.0, 1.0);

    if dot > 0.9995 {
        // Nearly identical rotations: linear interpolation + normalize is
        // numerically safer than slerp's sin(theta) blowing up near theta=0.
        let out = [
            a[0] + t * (b[0] - a[0]),
            a[1] + t * (b[1] - a[1]),
            a[2] + t * (b[2] - a[2]),
            a[3] + t * (b[3] - a[3]),
        ];
        return quat_normalize(out);
    }

    let theta_0 = dot.acos();
    let theta = theta_0 * t;
    let (sin_theta, sin_theta_0) = (theta.sin(), theta_0.sin());
    let s0 = (theta_0 - theta).sin() / sin_theta_0;
    let s1 = sin_theta / sin_theta_0;
    [
        s0 * a[0] + s1 * b[0],
        s0 * a[1] + s1 * b[1],
        s0 * a[2] + s1 * b[2],
        s0 * a[3] + s1 * b[3],
    ]
}

/// Mirrors `p3_bind_pose.py::interpolate_pose`: linear position + slerp
/// attitude between the two bracketing trajectory samples. `None` if
/// `t_query` falls outside `[traj[0].t, traj[last].t]` (matches the Python
/// raising instead of silently extrapolating).
pub fn interpolate_pose(traj: &[TrajectoryPoint], t_query: f64) -> Option<Pose> {
    if traj.len() < 2 || t_query < traj[0].t || t_query > traj[traj.len() - 1].t {
        return None;
    }
    // traj is sorted by t (load_trajectory guarantees this) — find the last
    // index whose t <= t_query.
    let i = match traj.binary_search_by(|p| p.t.partial_cmp(&t_query).unwrap()) {
        Ok(exact) => exact.min(traj.len() - 2),
        Err(insert_at) => insert_at.saturating_sub(1).min(traj.len() - 2),
    };
    let (p0, p1) = (&traj[i], &traj[i + 1]);
    let span = (p1.t - p0.t).max(1e-12);
    let alpha = ((t_query - p0.t) / span).clamp(0.0, 1.0);

    let pos = [
        p0.pose.pos[0] + (p1.pose.pos[0] - p0.pose.pos[0]) * alpha,
        p0.pose.pos[1] + (p1.pose.pos[1] - p0.pose.pos[1]) * alpha,
        p0.pose.pos[2] + (p1.pose.pos[2] - p0.pose.pos[2]) * alpha,
    ];
    let quat_xyzw = slerp(p0.pose.quat_xyzw, p1.pose.quat_xyzw, alpha);
    Some(Pose { pos, quat_xyzw })
}

fn quat_rotate(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let [qx, qy, qz, qw] = q;
    let [vx, vy, vz] = v;
    let tx = 2.0 * (qy * vz - qz * vy);
    let ty = 2.0 * (qz * vx - qx * vz);
    let tz = 2.0 * (qx * vy - qy * vx);
    [
        vx + qw * tx + (qy * tz - qz * ty),
        vy + qw * ty + (qz * tx - qx * tz),
        vz + qw * tz + (qx * ty - qy * tx),
    ]
}

fn quat_conjugate(q: [f64; 4]) -> [f64; 4] {
    [-q[0], -q[1], -q[2], q[3]]
}

/// World-frame points -> the LiDAR's own frame at `pose` (P_lidar = R⁻¹·(P_world
/// - pos)), same relation `p3_project_check.py` uses for world->camera. Used to
/// re-render the point-cloud panel "as the LiDAR saw it" at a scrubbed timeline
/// position, from the single aggregated GLIM map (no per-point timestamps
/// available to do a true instant-by-instant slice).
pub fn world_to_frame(points: &[[f32; 3]], pose: &Pose) -> Vec<[f32; 3]> {
    let q_inv = quat_conjugate(pose.quat_xyzw);
    points
        .iter()
        .map(|p| {
            let rel = [
                p[0] as f64 - pose.pos[0],
                p[1] as f64 - pose.pos[1],
                p[2] as f64 - pose.pos[2],
            ];
            let out = quat_rotate(q_inv, rel);
            [out[0] as f32, out[1] as f32, out[2] as f32]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn traj_line(t: f64, x: f64, qz: f64, qw: f64) -> TrajectoryPoint {
        TrajectoryPoint { t, pose: Pose { pos: [x, 0.0, 0.0], quat_xyzw: [0.0, 0.0, qz, qw] } }
    }

    #[test]
    fn parses_tum_format_and_skips_comments() {
        let dir = std::env::temp_dir().join(format!("traj_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("traj_lidar.txt");
        std::fs::write(&path, "# comment\n0.0 1.0 2.0 3.0 0.0 0.0 0.0 1.0\n\n1.0 4.0 5.0 6.0 0.0 0.0 0.7071 0.7071\n").unwrap();
        let traj = load_trajectory(&path).unwrap();
        assert_eq!(traj.len(), 2);
        assert_eq!(traj[0].t, 0.0);
        assert_eq!(traj[0].pose.pos, [1.0, 2.0, 3.0]);
        assert_eq!(traj[1].t, 1.0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn interpolate_returns_none_outside_range() {
        let traj = vec![traj_line(0.0, 0.0, 0.0, 1.0), traj_line(1.0, 1.0, 0.0, 1.0)];
        assert!(interpolate_pose(&traj, -0.1).is_none());
        assert!(interpolate_pose(&traj, 1.1).is_none());
    }

    #[test]
    fn interpolate_position_is_linear() {
        let traj = vec![traj_line(0.0, 0.0, 0.0, 1.0), traj_line(10.0, 10.0, 0.0, 1.0)];
        let p = interpolate_pose(&traj, 2.5).unwrap();
        assert!((p.pos[0] - 2.5).abs() < 1e-9);
    }

    #[test]
    fn slerp_endpoints_match_inputs() {
        // 0deg and 90deg-about-Z quaternions
        let q0 = [0.0, 0.0, 0.0, 1.0];
        let q1 = [0.0, 0.0, std::f64::consts::FRAC_1_SQRT_2, std::f64::consts::FRAC_1_SQRT_2];
        let s0 = slerp(q0, q1, 0.0);
        let s1 = slerp(q0, q1, 1.0);
        for i in 0..4 {
            assert!((s0[i] - q0[i]).abs() < 1e-9, "t=0 mismatch at {i}: {} vs {}", s0[i], q0[i]);
            assert!((s1[i] - q1[i]).abs() < 1e-9, "t=1 mismatch at {i}: {} vs {}", s1[i], q1[i]);
        }
    }

    #[test]
    fn slerp_takes_shortest_path() {
        // q1 and -q1 represent the same rotation; slerping toward either must
        // give the same interpolated *rotation* (allowing for the double-cover
        // sign ambiguity) — verify via angle-to-q0, not raw component equality.
        let q0 = [0.0, 0.0, 0.0, 1.0];
        let q1 = [0.0, 0.0, 0.7071, 0.7071];
        let q1_neg = [0.0, 0.0, -0.7071, -0.7071];
        let a = slerp(q0, q1, 0.5);
        let b = slerp(q0, q1_neg, 0.5);
        let dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]).abs();
        assert!(dot > 0.9999, "shortest-path slerp diverged: dot={dot}");
    }

    #[test]
    fn world_to_frame_identity_pose_is_noop() {
        let pose = Pose { pos: [0.0, 0.0, 0.0], quat_xyzw: [0.0, 0.0, 0.0, 1.0] };
        let pts = [[1.0f32, 2.0, 3.0], [-1.0, 0.5, 0.0]];
        let out = world_to_frame(&pts, &pose);
        for (a, b) in pts.iter().zip(out.iter()) {
            assert!((a[0] - b[0]).abs() < 1e-5 && (a[1] - b[1]).abs() < 1e-5 && (a[2] - b[2]).abs() < 1e-5);
        }
    }

    #[test]
    fn world_to_frame_undoes_translation() {
        let pose = Pose { pos: [5.0, 0.0, 0.0], quat_xyzw: [0.0, 0.0, 0.0, 1.0] };
        let pts = [[5.0f32, 0.0, 0.0]]; // world point == pose position -> should land at origin
        let out = world_to_frame(&pts, &pose);
        assert!(out[0][0].abs() < 1e-5 && out[0][1].abs() < 1e-5 && out[0][2].abs() < 1e-5);
    }
}

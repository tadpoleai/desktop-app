//! Loads a GLIM map directory's per-submap point clouds, filtered by time
//! window — an alternative to `glim-export-pcd`'s whole-session `map_export.ply`
//! for the calibration point-select right panel: reprojecting the *entire*
//! session's aggregated map into "LiDAR frame at time t" mixes in points
//! captured from other viewpoints/times, which reads as cluttered/ghosted for
//! a moving scene. Filtering to just the submap(s) whose own frame timestamps
//! overlap the requested window cuts most of that out — coarser than
//! per-point filtering (a submap can span many seconds/hundreds of frames),
//! but the format doesn't carry per-point timestamps, only per-frame ones
//! inside each submap's `data.txt` (see below).
//!
//! Reverse-engineered from a real GLIM map directory's actual output — GLIM
//! doesn't publish a spec for this. Two things confirmed empirically:
//!   - `<id>/points_compact.bin` is a flat array of little-endian f32 [x,y,z]
//!     triplets, in the submap's own *local* ("origin") frame: `file_size / 12`
//!     matches exactly the point count `glim-export-pcd`'s own log reports for
//!     that submap.
//!   - `<id>/data.txt` is a custom text format (not JSON) with a
//!     `T_world_origin:` matrix (submap-local -> world, 4 lines of 4 floats
//!     right after the label line) and repeated `frame_N` blocks, each with
//!     its own `stamp: <seconds>` line (host-clock domain, same as
//!     `traj_lidar.txt`'s `t` — same file also has `T_world_lidar` per frame,
//!     which is where `traj_lidar.txt` presumably comes from, though that's
//!     not independently re-derived here).
//! Submaps whose `data.txt` doesn't parse as expected are skipped rather than
//! failing the whole request — defensive against GLIM version/config
//! variations this wasn't tested against.

use std::path::{Path, PathBuf};

struct SubmapMeta {
    t_world_origin: [[f64; 4]; 4],
    stamp_min: f64,
    stamp_max: f64,
}

fn identity() -> [[f64; 4]; 4] {
    let mut m = [[0.0; 4]; 4];
    for (i, row) in m.iter_mut().enumerate() {
        row[i] = 1.0;
    }
    m
}

fn parse_submap_data_txt(path: &Path) -> anyhow::Result<SubmapMeta> {
    let text = std::fs::read_to_string(path)?;
    let lines: Vec<&str> = text.lines().collect();

    let mut t_world_origin = identity();
    let label_idx = lines
        .iter()
        .position(|l| l.trim_end() == "T_world_origin:")
        .ok_or_else(|| anyhow::anyhow!("{}: no T_world_origin: line", path.display()))?;
    for r in 0..4 {
        let row_line = lines
            .get(label_idx + 1 + r)
            .ok_or_else(|| anyhow::anyhow!("{}: T_world_origin missing row {}", path.display(), r))?;
        let vals: Vec<f64> = row_line
            .split_whitespace()
            .map(|s| s.parse::<f64>())
            .collect::<Result<_, _>>()
            .map_err(|e| anyhow::anyhow!("{}: bad T_world_origin row {}: {}", path.display(), r, e))?;
        if vals.len() != 4 {
            anyhow::bail!("{}: T_world_origin row {} has {} values, expected 4", path.display(), r, vals.len());
        }
        t_world_origin[r] = [vals[0], vals[1], vals[2], vals[3]];
    }

    let mut stamp_min = f64::INFINITY;
    let mut stamp_max = f64::NEG_INFINITY;
    for line in &lines {
        if let Some(rest) = line.trim_start().strip_prefix("stamp:") {
            if let Ok(v) = rest.trim().parse::<f64>() {
                if v < stamp_min {
                    stamp_min = v;
                }
                if v > stamp_max {
                    stamp_max = v;
                }
            }
        }
    }
    if !stamp_min.is_finite() {
        anyhow::bail!("{}: no 'stamp:' lines found", path.display());
    }

    Ok(SubmapMeta { t_world_origin, stamp_min, stamp_max })
}

fn read_points_compact(path: &Path) -> anyhow::Result<Vec<[f32; 3]>> {
    let bytes = std::fs::read(path)?;
    if bytes.len() % 12 != 0 {
        anyhow::bail!("{}: size {} is not a multiple of 12 (3x f32)", path.display(), bytes.len());
    }
    let mut out = Vec::with_capacity(bytes.len() / 12);
    for chunk in bytes.chunks_exact(12) {
        let x = f32::from_le_bytes(chunk[0..4].try_into().unwrap());
        let y = f32::from_le_bytes(chunk[4..8].try_into().unwrap());
        let z = f32::from_le_bytes(chunk[8..12].try_into().unwrap());
        out.push([x, y, z]);
    }
    Ok(out)
}

fn transform_point(m: &[[f64; 4]; 4], p: [f32; 3]) -> [f32; 3] {
    let (x, y, z) = (p[0] as f64, p[1] as f64, p[2] as f64);
    [
        (m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3]) as f32,
        (m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3]) as f32,
        (m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3]) as f32,
    ]
}

/// Loads only the submaps in `map_dir` whose frame-timestamp range overlaps
/// `[t_center_sec - window_sec/2, t_center_sec + window_sec/2]`, transformed
/// to world frame. Submap directories are `map_dir/<all-digit-name>/`.
pub fn load_glim_points_windowed(map_dir: &Path, t_center_sec: f64, window_sec: f64) -> anyhow::Result<Vec<[f32; 3]>> {
    let half = (window_sec.max(0.0) / 2.0).max(0.0);
    let t_min = t_center_sec - half;
    let t_max = t_center_sec + half;

    let mut submap_dirs: Vec<PathBuf> = std::fs::read_dir(map_dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
                .unwrap_or(false)
        })
        .collect();
    submap_dirs.sort();

    let mut out = Vec::new();
    for dir in &submap_dirs {
        let data_path = dir.join("data.txt");
        let meta = match parse_submap_data_txt(&data_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.stamp_max < t_min || meta.stamp_min > t_max {
            continue;
        }
        let points_path = dir.join("points_compact.bin");
        if !points_path.exists() {
            continue;
        }
        let local_points = read_points_compact(&points_path)?;
        out.extend(local_points.into_iter().map(|p| transform_point(&meta.t_world_origin, p)));
    }

    if out.is_empty() {
        anyhow::bail!(
            "time window [{:.3}, {:.3}]s (center={:.3}s) matched no GLIM submaps — try a wider window or a different timeline position",
            t_min,
            t_max,
            t_center_sec
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_submap(dir: &Path, id: &str, t_world_origin: [[f64; 4]; 4], stamps: &[f64], points: &[[f32; 3]]) {
        let sub = dir.join(id);
        std::fs::create_dir_all(&sub).unwrap();

        let mut data = String::new();
        data.push_str("id: 0\n");
        data.push_str("T_world_origin: \n");
        for row in &t_world_origin {
            data.push_str(&format!("{} {} {} {}\n", row[0], row[1], row[2], row[3]));
        }
        data.push_str("T_lidar_imu: \n1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n");
        for (i, stamp) in stamps.iter().enumerate() {
            data.push_str(&format!("frame_{i}\nid: {i}\nstamp: {stamp}\nv_world_imu: 0 0 0\n"));
        }
        std::fs::write(sub.join("data.txt"), data).unwrap();

        let mut bytes = Vec::new();
        for p in points {
            bytes.extend_from_slice(&p[0].to_le_bytes());
            bytes.extend_from_slice(&p[1].to_le_bytes());
            bytes.extend_from_slice(&p[2].to_le_bytes());
        }
        std::fs::write(sub.join("points_compact.bin"), bytes).unwrap();
    }

    #[test]
    fn filters_by_submap_time_range_and_transforms_to_world() {
        let dir = std::env::temp_dir().join(format!("hera_test_submap_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();

        // Submap 0: t in [100, 110], identity transform, one point at origin-local (1,0,0).
        write_submap(&dir, "000000", identity(), &[100.0, 105.0, 110.0], &[[1.0, 0.0, 0.0]]);

        // Submap 1: t in [200, 210], translated by (10,0,0), one point at local (1,0,0)
        // -> world (11,0,0).
        let mut translated = identity();
        translated[0][3] = 10.0;
        write_submap(&dir, "000001", translated, &[200.0, 205.0, 210.0], &[[1.0, 0.0, 0.0]]);

        // Query centered on submap 1's range only.
        let pts = load_glim_points_windowed(&dir, 205.0, 20.0).unwrap();
        assert_eq!(pts.len(), 1);
        assert!((pts[0][0] - 11.0).abs() < 1e-4, "expected world x=11, got {}", pts[0][0]);

        // Query centered on submap 0's range only.
        let pts = load_glim_points_windowed(&dir, 105.0, 20.0).unwrap();
        assert_eq!(pts.len(), 1);
        assert!((pts[0][0] - 1.0).abs() < 1e-4, "expected world x=1, got {}", pts[0][0]);

        // Wide enough window to catch both.
        let pts = load_glim_points_windowed(&dir, 150.0, 300.0).unwrap();
        assert_eq!(pts.len(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn errors_when_window_matches_no_submap() {
        let dir = std::env::temp_dir().join(format!("hera_test_submap_empty_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        write_submap(&dir, "000000", identity(), &[100.0, 110.0], &[[1.0, 0.0, 0.0]]);

        let res = load_glim_points_windowed(&dir, 500.0, 10.0);
        assert!(res.is_err());

        std::fs::remove_dir_all(&dir).ok();
    }
}

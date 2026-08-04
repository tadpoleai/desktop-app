//! Point cloud → range image (TASK3_激光全景标定工具.md §1/§3): bins points by
//! azimuth/elevation and keeps the nearest point per bin (a LiDAR "depth image"),
//! then false-colors it by range for the right-hand selection panel. Each pixel
//! also carries the source 3D point so a click resolves straight back to a
//! LiDAR-frame coordinate — no reprojection needed at pick time.
//!
//! `build_range_image` mirrors `p6_calibrate_static.py`'s bin/nearest-point logic
//! (see task doc §1); the "point cloud → xyz list" loaders below are new, needed
//! because unlike the Python prototype this reads directly off disk in two
//! possible formats: the raw CSV from `storage-extract-mid360` (skip-GLIM branch)
//! and the `.ply` GLIM exports (`glim-export-pcd`, run-GLIM/motion branches).

use serde::Serialize;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct RangeImageResult {
    pub az_bins: u32,
    pub el_bins: u32,
    /// PNG, base64-encoded (no `data:image/png;base64,` prefix).
    pub image_png_base64: String,
    /// Row-major (row = elevation bin, col = azimuth bin) x,y,z triplets in the
    /// point cloud's own frame; empty bins are NaN. len == az_bins*el_bins*3.
    pub points: Vec<f32>,
    pub min_range: f32,
    pub max_range: f32,
    /// Robust range statistics. The rendered color scale uses p02..p98 rather
    /// than raw min..max so a handful of near/far outliers cannot flatten the
    /// contrast of the useful scene.
    pub range_p02: f32,
    pub range_p50: f32,
    pub range_p98: f32,
    pub color_min_range: f32,
    pub color_max_range: f32,
    /// Number of source points before/after finite + distance filtering.
    pub input_point_count: usize,
    pub valid_point_count: usize,
    pub filtered_point_count: usize,
    pub point_count: usize,
    pub occupancy_ratio: f32,
    /// Elevation range this image's rows actually span, degrees — see
    /// `build_range_image` doc: auto-fit to the data, not the full ±90°.
    pub el_min_deg: f32,
    pub el_max_deg: f32,
    /// Filled by the Tauri command that knows which source produced the data.
    pub source: String,
    pub source_detail: Option<String>,
}

const MIN_VALID_RANGE_M: f32 = 0.3;
const MAX_VALID_RANGE_M: f32 = 200.0;

fn percentile(sorted: &[f32], q: f32) -> f32 {
    debug_assert!(!sorted.is_empty());
    let pos = q.clamp(0.0, 1.0) * (sorted.len() - 1) as f32;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    let f = pos - lo as f32;
    sorted[lo] + (sorted[hi] - sorted[lo]) * f
}

/// Row mapping auto-fits elevation to the point cloud's own min/max (+ a small
/// margin) instead of the full theoretical ±90° — a real LiDAR's vertical FOV is
/// much narrower than that (Mid-360: roughly -7°..+52°, biased upward, not
/// centered on the horizon), so binning the full sphere wasted most of the
/// image height on rows that could never have data (reported as "视图深度图分辨率
/// 很低,下半部分全灰" — that gray wasn't a bug in the data, it was empty-by-
/// construction bins for elevations the sensor never sees).
pub fn build_range_image(
    points: &[[f32; 3]],
    az_bins: u32,
    el_bins: u32,
    invert_elevation: bool,
) -> anyhow::Result<RangeImageResult> {
    if az_bins == 0 || el_bins == 0 {
        anyhow::bail!("az_bins/el_bins must be > 0");
    }

    let input_point_count = points.len();
    let mut valid_points = Vec::with_capacity(points.len());
    let mut elevations = Vec::with_capacity(points.len());
    let mut ranges = Vec::with_capacity(points.len());
    for p in points {
        let r = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
        if !r.is_finite() || !(MIN_VALID_RANGE_M..=MAX_VALID_RANGE_M).contains(&r) {
            continue;
        }
        let el = (p[2] / r).clamp(-1.0, 1.0).asin();
        valid_points.push(*p);
        elevations.push(el);
        ranges.push(r);
    }
    if valid_points.is_empty() {
        anyhow::bail!("no valid points after filtering (expected range {MIN_VALID_RANGE_M}..={MAX_VALID_RANGE_M}m)");
    }
    elevations.sort_by(f32::total_cmp);
    ranges.sort_by(f32::total_cmp);
    // Robust bounds: isolated flying points no longer stretch the useful FOV
    // or consume the complete color scale.
    let mut el_min = percentile(&elevations, 0.01);
    let mut el_max = percentile(&elevations, 0.99);
    let range_p02 = percentile(&ranges, 0.02);
    let range_p50 = percentile(&ranges, 0.50);
    let range_p98 = percentile(&ranges, 0.98);
    let pad = ((el_max - el_min) * 0.05).max(0.001_f32.to_radians());
    el_min = (el_min - pad).max(-std::f32::consts::FRAC_PI_2);
    el_max = (el_max + pad).min(std::f32::consts::FRAC_PI_2);
    let el_span = (el_max - el_min).max(1e-6);

    let n_bins = (az_bins as usize) * (el_bins as usize);
    let mut best_range = vec![f32::INFINITY; n_bins];
    let mut best_point = vec![[f32::NAN; 3]; n_bins];

    for p in &valid_points {
        let r = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
        if !r.is_finite() || r <= 1e-6 {
            continue;
        }
        let az = p[1].atan2(p[0]); // [-pi, pi]
        let el = (p[2] / r).clamp(-1.0, 1.0).asin();
        if el < el_min || el > el_max {
            continue;
        }

        let col = (((az + std::f32::consts::PI) / (2.0 * std::f32::consts::PI)) * az_bins as f32)
            .floor()
            .clamp(0.0, az_bins as f32 - 1.0) as usize;
        // Row 0 = top = highest elevation (el_max), matching the ERP top-is-up
        // convention elsewhere in this project, just fit to [el_min, el_max]
        // instead of the full ±90°. `invert_elevation` flips which end sits at
        // the top — for a physically upside-down-mounted LiDAR (e.g. Mid-360
        // mounted inverted), the raw sensor-frame Z axis points toward the
        // physical floor, so without this the depth image renders bottom-up
        // relative to the (correctly-oriented) panorama next to it.
        let row_frac = if invert_elevation {
            (el - el_min) / el_span
        } else {
            (el_max - el) / el_span
        };
        let row = (row_frac * el_bins as f32)
            .floor()
            .clamp(0.0, el_bins as f32 - 1.0) as usize;

        let idx = row * az_bins as usize + col;
        if r < best_range[idx] {
            best_range[idx] = r;
            best_point[idx] = *p;
        }
    }

    let mut min_range = f32::INFINITY;
    let mut max_range = 0.0f32;
    let mut point_count = 0usize;
    for r in &best_range {
        if r.is_finite() {
            point_count += 1;
            if *r < min_range {
                min_range = *r;
            }
            if *r > max_range {
                max_range = *r;
            }
        }
    }
    if point_count == 0 {
        anyhow::bail!("no points fell into any bin (empty or all-invalid point cloud)");
    }

    let mut img = image::RgbImage::new(az_bins, el_bins);
    let color_min_range = range_p02;
    let color_max_range = range_p98.max(range_p02 + 1e-6);
    let span = color_max_range - color_min_range;
    for row in 0..el_bins as usize {
        for col in 0..az_bins as usize {
            let idx = row * az_bins as usize + col;
            let rgb = if best_range[idx].is_finite() {
                let t = (best_range[idx] - color_min_range) / span;
                colormap(t)
            } else {
                // Neutral mid-gray, deliberately far from the colormap's dark
                // blue-purple near-range end so "no return" doesn't read as "close".
                [96, 96, 100]
            };
            img.put_pixel(col as u32, row as u32, image::Rgb(rgb));
        }
    }

    let mut png_bytes = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
        encoder.write_image(img.as_raw(), az_bins, el_bins, image::ExtendedColorType::Rgb8)?;
    }
    let image_png_base64 = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(&png_bytes)
    };

    let mut points_out = vec![f32::NAN; n_bins * 3];
    for (idx, p) in best_point.iter().enumerate() {
        points_out[idx * 3] = p[0];
        points_out[idx * 3 + 1] = p[1];
        points_out[idx * 3 + 2] = p[2];
    }

    Ok(RangeImageResult {
        az_bins,
        el_bins,
        image_png_base64,
        points: points_out,
        min_range,
        max_range,
        range_p02,
        range_p50,
        range_p98,
        color_min_range,
        color_max_range,
        input_point_count,
        valid_point_count: valid_points.len(),
        filtered_point_count: input_point_count - valid_points.len(),
        point_count,
        occupancy_ratio: point_count as f32 / n_bins as f32,
        el_min_deg: el_min.to_degrees(),
        el_max_deg: el_max.to_degrees(),
        source: "pointcloud".to_string(),
        source_detail: None,
    })
}

/// Jet-style 5-stop false-color gradient (dark blue → cyan → green → yellow →
/// red). Visually plays the same role as the "turbo colormap" mentioned in the
/// task doc, but these are hand-picked, hand-verified stops rather than a
/// transcription of Google's turbo LUT (not confident enough in that exact
/// polynomial from memory to bake it in silently) — swap in the real turbo LUT
/// later if exact colorimetric parity ever matters.
fn colormap(t: f32) -> [u8; 3] {
    const STOPS: [(f32, [u8; 3]); 5] = [
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
            return [lerp(c0[0], c1[0], f), lerp(c0[1], c1[1], f), lerp(c0[2], c1[2], f)];
        }
    }
    STOPS[4].1
}

fn lerp(a: u8, b: u8, f: f32) -> u8 {
    (a as f32 + (b as f32 - a as f32) * f).round().clamp(0.0, 255.0) as u8
}

// ── Point cloud loading ──────────────────────────────────────────────────────

pub fn load_points_xyz(path: &Path) -> anyhow::Result<Vec<[f32; 3]>> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "csv" => load_csv_xyz(path),
        "ply" => load_ply_xyz(path),
        _ => anyhow::bail!("unsupported point cloud format: .{ext} (支持 .csv / .ply)"),
    }
}

fn load_csv_xyz(path: &Path) -> anyhow::Result<Vec<[f32; 3]>> {
    let text = std::fs::read_to_string(path)?;
    let mut lines = text.lines();
    let header = lines
        .next()
        .ok_or_else(|| anyhow::anyhow!("empty point cloud csv"))?;
    let cols: Vec<&str> = header.split(',').map(|c| c.trim()).collect();
    let find = |names: &[&str]| -> Option<usize> {
        names
            .iter()
            .find_map(|n| cols.iter().position(|c| c.eq_ignore_ascii_case(n)))
    };
    let xi = find(&["x_m", "x"]).ok_or_else(|| anyhow::anyhow!("csv missing x column"))?;
    let yi = find(&["y_m", "y"]).ok_or_else(|| anyhow::anyhow!("csv missing y column"))?;
    let zi = find(&["z_m", "z"]).ok_or_else(|| anyhow::anyhow!("csv missing z column"))?;

    let mut out = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split(',').collect();
        let x: f32 = fields[xi].trim().parse()?;
        let y: f32 = fields[yi].trim().parse()?;
        let z: f32 = fields[zi].trim().parse()?;
        out.push([x, y, z]);
    }
    Ok(out)
}

/// Same CSV (raw `storage-extract-mid360 --points` output, per-point
/// `timestamp_host_ns`) as `load_csv_xyz`, but restricted to a time window
/// around `t_center_sec` — for a motion session this gives a genuine "what did
/// the LiDAR see in ~this instant" slice: raw, no GLIM aggregation/drift, as
/// an alternative to the GLIM world-map view (task doc feedback: the GLIM map
/// reads as cluttered because it's the *whole session* merged into one cloud).
///
/// Uses `timestamp_host_ns`, not `timestamp_device_ns`, to align with
/// `traj_lidar.txt`'s clock — matched to `p3_bind_pose.py`'s own convention
/// (`t_query = frame["abs_host_ns"] / 1e9`, i.e. host clock, seconds). Not
/// independently verified against a real motion-session `traj_lidar.txt` yet —
/// flag if the windowed slice looks offset from where the timeline says it
/// should be.
pub fn load_csv_xyz_windowed(path: &Path, t_center_sec: f64, window_sec: f64) -> anyhow::Result<Vec<[f32; 3]>> {
    use std::io::BufRead;
    // Real sessions are commonly 1–2 GB. Streaming avoids duplicating the
    // entire file as one String on every timeline refresh. Rows are emitted in
    // timestamp order by storage-extract-mid360, so stop as soon as the upper
    // edge of the requested window has been passed.
    let file = std::fs::File::open(path)?;
    let mut lines = std::io::BufReader::new(file).lines();
    let header = lines
        .next()
        .ok_or_else(|| anyhow::anyhow!("empty point cloud csv"))??;
    let cols: Vec<&str> = header.split(',').map(|c| c.trim()).collect();
    let find = |names: &[&str]| -> Option<usize> {
        names
            .iter()
            .find_map(|n| cols.iter().position(|c| c.eq_ignore_ascii_case(n)))
    };
    let xi = find(&["x_m", "x"]).ok_or_else(|| anyhow::anyhow!("csv missing x column"))?;
    let yi = find(&["y_m", "y"]).ok_or_else(|| anyhow::anyhow!("csv missing y column"))?;
    let zi = find(&["z_m", "z"]).ok_or_else(|| anyhow::anyhow!("csv missing z column"))?;
    let ti = find(&["timestamp_host_ns"])
        .ok_or_else(|| anyhow::anyhow!("csv missing timestamp_host_ns column"))?;

    let half_window_ns = (window_sec.max(0.0) / 2.0) * 1e9;
    let t_center_ns = t_center_sec * 1e9;
    let t_min_ns = t_center_ns - half_window_ns;
    let t_max_ns = t_center_ns + half_window_ns;

    let mut out = Vec::new();
    for line in lines {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split(',').collect();
        let t_ns: f64 = fields[ti].trim().parse()?;
        if t_ns > t_max_ns {
            break;
        }
        if t_ns < t_min_ns {
            continue;
        }
        let x: f32 = fields[xi].trim().parse()?;
        let y: f32 = fields[yi].trim().parse()?;
        let z: f32 = fields[zi].trim().parse()?;
        out.push([x, y, z]);
    }
    if out.is_empty() {
        anyhow::bail!(
            "time window [{:.3}, {:.3}]s (center={:.3}s) contains no points — try a wider window or a different timeline position",
            t_min_ns / 1e9,
            t_max_ns / 1e9,
            t_center_sec
        );
    }
    Ok(out)
}

/// First data row's `timestamp_host_ns` from a raw `storage-extract-mid360
/// --points` CSV — the actual first Mid360 sample's host-clock time, used as
/// the zero-anchor for `multi_source_synchronizer`'s Mid360 axis (see
/// calib.rs module docs / CalibrationView.tsx's video-time conversion).
/// Reads only the first two lines, not the whole file — this CSV can be
/// hundreds of MB for a real session.
pub fn first_row_timestamp_host_ns(path: &Path) -> anyhow::Result<u64> {
    use std::io::BufRead;
    let file = std::fs::File::open(path)?;
    let mut lines = std::io::BufReader::new(file).lines();
    let header = lines
        .next()
        .ok_or_else(|| anyhow::anyhow!("empty point cloud csv"))??;
    let cols: Vec<&str> = header.split(',').map(|c| c.trim()).collect();
    let ti = cols
        .iter()
        .position(|c| c.eq_ignore_ascii_case("timestamp_host_ns"))
        .ok_or_else(|| anyhow::anyhow!("csv missing timestamp_host_ns column"))?;
    let first_data = lines
        .next()
        .ok_or_else(|| anyhow::anyhow!("point cloud csv has no data rows"))??;
    let fields: Vec<&str> = first_data.split(',').collect();
    let ns: u64 = fields
        .get(ti)
        .ok_or_else(|| anyhow::anyhow!("csv row missing timestamp_host_ns field"))?
        .trim()
        .parse()?;
    Ok(ns)
}

struct PlyProperty {
    name: String,
    ty: String,
}

fn ply_type_size(ty: &str) -> Option<usize> {
    Some(match ty {
        "char" | "int8" | "uchar" | "uint8" => 1,
        "short" | "int16" | "ushort" | "uint16" => 2,
        "int" | "int32" | "uint" | "uint32" | "float" | "float32" => 4,
        "double" | "float64" => 8,
        _ => return None,
    })
}

fn read_ply_scalar(bytes: &[u8], ty: &str, little: bool) -> f32 {
    match ty {
        "float" | "float32" => {
            let b: [u8; 4] = bytes[..4].try_into().unwrap();
            if little { f32::from_le_bytes(b) } else { f32::from_be_bytes(b) }
        }
        "double" | "float64" => {
            let b: [u8; 8] = bytes[..8].try_into().unwrap();
            (if little { f64::from_le_bytes(b) } else { f64::from_be_bytes(b) }) as f32
        }
        _ => 0.0, // x/y/z as an integer type would be unusual for a point cloud export.
    }
}

/// Supports ASCII and binary_little_endian/big_endian PLY, x/y/z located by
/// property name (not assumed to be the first three properties).
fn load_ply_xyz(path: &Path) -> anyhow::Result<Vec<[f32; 3]>> {
    let mut f = std::fs::File::open(path)?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;

    let header_end = find_subslice(&buf, b"end_header\n")
        .ok_or_else(|| anyhow::anyhow!("not a valid PLY file (no end_header)"))?
        + b"end_header\n".len();
    let header_text = std::str::from_utf8(&buf[..header_end])?;

    let mut format = String::new();
    let mut vertex_count = 0usize;
    let mut properties: Vec<PlyProperty> = Vec::new();
    let mut in_vertex_element = false;
    for line in header_text.lines() {
        let mut it = line.split_whitespace();
        match it.next() {
            Some("format") => format = it.next().unwrap_or("").to_string(),
            Some("element") => {
                let name = it.next().unwrap_or("");
                in_vertex_element = name == "vertex";
                if in_vertex_element {
                    vertex_count = it.next().unwrap_or("0").parse().unwrap_or(0);
                }
            }
            Some("property") if in_vertex_element => {
                let ty = it.next().unwrap_or("").to_string();
                let name = it.next().unwrap_or("").to_string();
                properties.push(PlyProperty { name, ty });
            }
            _ => {}
        }
    }

    let xi = properties
        .iter()
        .position(|p| p.name == "x")
        .ok_or_else(|| anyhow::anyhow!("ply vertex missing x property"))?;
    let yi = properties
        .iter()
        .position(|p| p.name == "y")
        .ok_or_else(|| anyhow::anyhow!("ply vertex missing y property"))?;
    let zi = properties
        .iter()
        .position(|p| p.name == "z")
        .ok_or_else(|| anyhow::anyhow!("ply vertex missing z property"))?;

    let mut out = Vec::with_capacity(vertex_count);
    let body = &buf[header_end..];

    if format.starts_with("ascii") {
        let text = std::str::from_utf8(body)?;
        for line in text.lines().take(vertex_count) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() <= xi.max(yi).max(zi) {
                continue;
            }
            out.push([fields[xi].parse()?, fields[yi].parse()?, fields[zi].parse()?]);
        }
    } else if format.starts_with("binary_little_endian") || format.starts_with("binary_big_endian") {
        let little = format.starts_with("binary_little_endian");
        let sizes: Vec<usize> = properties
            .iter()
            .map(|p| {
                ply_type_size(&p.ty)
                    .ok_or_else(|| anyhow::anyhow!("unsupported ply property type: {}", p.ty))
            })
            .collect::<anyhow::Result<_>>()?;
        let offsets: Vec<usize> = sizes
            .iter()
            .scan(0usize, |acc, sz| {
                let o = *acc;
                *acc += sz;
                Some(o)
            })
            .collect();
        let stride: usize = sizes.iter().sum();
        if stride == 0 {
            anyhow::bail!("ply vertex has no properties");
        }

        for i in 0..vertex_count {
            let rec_start = i * stride;
            if rec_start + stride > body.len() {
                break;
            }
            let rec = &body[rec_start..rec_start + stride];
            let x = read_ply_scalar(&rec[offsets[xi]..], &properties[xi].ty, little);
            let y = read_ply_scalar(&rec[offsets[yi]..], &properties[yi].ty, little);
            let z = read_ply_scalar(&rec[offsets[zi]..], &properties[zi].ty, little);
            out.push([x, y, z]);
        }
    } else {
        anyhow::bail!("unsupported ply format: {format}");
    }

    Ok(out)
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windowed_csv_filters_by_host_timestamp() {
        let dir = std::env::temp_dir().join(format!("windowed_csv_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("points.csv");
        // t=0.0s, 1.0s, 2.0s (as timestamp_host_ns) — window around 1.0s±0.3s
        // should keep only the middle row.
        std::fs::write(
            &path,
            "timestamp_device_ns,timestamp_host_ns,x_m,y_m,z_m,reflectivity,tag,data_type\n\
             1,0,1.0,0.0,0.0,10,0,1\n\
             2,1000000000,2.0,0.0,0.0,10,0,1\n\
             3,2000000000,3.0,0.0,0.0,10,0,1\n",
        )
        .unwrap();

        let pts = load_csv_xyz_windowed(&path, 1.0, 0.6).unwrap();
        assert_eq!(pts, vec![[2.0, 0.0, 0.0]]);

        let pts_wide = load_csv_xyz_windowed(&path, 1.0, 3.0).unwrap();
        assert_eq!(pts_wide.len(), 3);

        assert!(load_csv_xyz_windowed(&path, 100.0, 0.1).is_err(), "empty window should error, not silently return nothing");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Points confined to a Mid-360-like narrow, upward-biased elevation band
    /// (-7°..+52°) should produce an image whose rows are fit to roughly that
    /// band, not wasted across the full ±90° — this is the exact bug reported:
    /// "深度图分辨率很低，下半部分全灰".
    #[test]
    fn elevation_auto_fits_to_data_not_full_sphere() {
        // Dense-enough sampling across a Mid-360-like narrow, upward-biased
        // elevation band (-7°..+52°) and full azimuth that, once elevation is
        // correctly fit to the data, should fill most of a modestly-sized bin
        // grid — not the ~1% you'd get by construction from sparse synthetic
        // points regardless of the fix.
        let az_bins = 72u32; // 5 deg/bin
        let el_bins = 20u32; // ~3 deg/bin over the ~59deg band
        let mut points = Vec::new();
        for az_i in 0..120 {
            for el_i in 0..30 {
                let az_deg = az_i as f32 * 3.0;
                let el_deg = -7.0 + el_i as f32 * (59.0 / 30.0);
                let az = az_deg.to_radians();
                let el = el_deg.to_radians();
                let r = 3.0_f32;
                let x = r * el.cos() * az.cos();
                let y = r * el.cos() * az.sin();
                let z = r * el.sin();
                points.push([x, y, z]);
            }
        }

        let result = build_range_image(&points, az_bins, el_bins, false).expect("build failed");

        // Fit range should hug [-7, 52] deg, not span anywhere near the full
        // [-90, 90] the old fixed binning always used.
        assert!(result.el_min_deg > -15.0 && result.el_min_deg < -5.0, "el_min_deg={}", result.el_min_deg);
        assert!(result.el_max_deg > 48.0 && result.el_max_deg < 60.0, "el_max_deg={}", result.el_max_deg);
        assert!(result.el_max_deg - result.el_min_deg < 70.0, "span too wide: {}", result.el_max_deg - result.el_min_deg);

        // With rows fit tightly to the data, most bins should actually have
        // content (unlike the old full-sphere binning where the vast majority
        // of the image was empty-by-construction for a ~59deg-FOV sensor).
        let nonempty_fraction = result.point_count as f32 / (result.az_bins * result.el_bins) as f32;
        assert!(nonempty_fraction > 0.5, "nonempty_fraction={nonempty_fraction} — still mostly wasted");
    }

    #[test]
    fn build_range_image_rejects_empty_input() {
        assert!(build_range_image(&[], 10, 10, false).is_err());
    }

    #[test]
    fn robust_percentiles_ignore_extreme_range_outliers() {
        let mut points = Vec::new();
        for i in 0..100 {
            // Cover only half the azimuth range so the far outlier lands in
            // its own bin and remains visible in raw min/max diagnostics.
            let az = (i as f32 * 1.8).to_radians();
            let r = 10.0 + (i % 5) as f32;
            points.push([r * az.cos(), r * az.sin(), 0.0]);
        }
        // Both survive the physical range filter, but neither should define
        // the display scale for the useful 10..14m scene.
        points.push([0.31, 0.0, 0.0]);
        points.push([0.0, -199.0, 0.0]);

        let result = build_range_image(&points, 72, 8, false).unwrap();
        assert!(result.min_range < 1.0);
        assert!(result.max_range > 100.0);
        assert!(result.color_min_range > 5.0, "{}", result.color_min_range);
        assert!(result.color_max_range < 20.0, "{}", result.color_max_range);
        assert_eq!(result.input_point_count, 102);
        assert_eq!(result.valid_point_count, 102);
    }

    #[test]
    fn reports_distance_filter_diagnostics() {
        let points = [[0.1, 0.0, 0.0], [2.0, 0.0, 0.0], [250.0, 0.0, 0.0]];
        let result = build_range_image(&points, 8, 4, false).unwrap();
        assert_eq!(result.input_point_count, 3);
        assert_eq!(result.valid_point_count, 1);
        assert_eq!(result.filtered_point_count, 2);
        assert!(result.occupancy_ratio > 0.0 && result.occupancy_ratio <= 1.0);
    }

    /// `invert_elevation` must actually flip which row a given point lands in
    /// (top<->bottom), for an upside-down-mounted sensor — not just be a no-op
    /// flag. Two points at opposite elevation extremes should swap rows.
    #[test]
    fn invert_elevation_flips_row_order() {
        let high = [0.0_f32, 3.0, 3.0 * 30.0_f32.to_radians().tan()]; // el=+30deg-ish
        let low = [0.0_f32, 3.0, -3.0 * 30.0_f32.to_radians().tan()]; // el=-30deg-ish
        let points = vec![high, low];

        let normal = build_range_image(&points, 4, 10, false).unwrap();
        let inverted = build_range_image(&points, 4, 10, true).unwrap();

        fn find_row(img: &RangeImageResult, target: [f32; 3]) -> usize {
            for row in 0..img.el_bins as usize {
                for col in 0..img.az_bins as usize {
                    let idx = row * img.az_bins as usize + col;
                    let (x, y, z) = (img.points[idx * 3], img.points[idx * 3 + 1], img.points[idx * 3 + 2]);
                    if x == target[0] && y == target[1] && z == target[2] {
                        return row;
                    }
                }
            }
            panic!("point not found in image");
        }

        let normal_high_row = find_row(&normal, high);
        let normal_low_row = find_row(&normal, low);
        let inverted_high_row = find_row(&inverted, high);
        let inverted_low_row = find_row(&inverted, low);

        assert!(normal_high_row < normal_low_row, "normal: high should be above low");
        assert!(inverted_high_row > inverted_low_row, "inverted: high should be below low");
    }

    #[test]
    fn first_row_timestamp_host_ns_reads_first_data_row_only() {
        let dir = std::env::temp_dir().join(format!("hera_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("points.csv");
        std::fs::write(
            &path,
            "timestamp_device_ns,timestamp_host_ns,x_m,y_m,z_m,reflectivity,tag,data_type\n\
             106181728460,1785732494886151808,0.0,0.0,0.0,0,0,1\n\
             106181828460,1785732494986151808,0.1,0.1,0.1,1,16,1\n",
        )
        .unwrap();

        let ns = first_row_timestamp_host_ns(&path).unwrap();
        assert_eq!(ns, 1785732494886151808);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn first_row_timestamp_host_ns_rejects_empty_csv() {
        let dir = std::env::temp_dir().join(format!("hera_test_empty_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("points.csv");
        std::fs::write(&path, "timestamp_device_ns,timestamp_host_ns,x_m,y_m,z_m\n").unwrap();

        assert!(first_row_timestamp_host_ns(&path).is_err());

        std::fs::remove_dir_all(&dir).ok();
    }
}

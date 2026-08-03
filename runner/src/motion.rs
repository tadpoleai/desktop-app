//! Static-vs-motion judgment for a `.hera` session, from its Mid-360 gyro stream.
//!
//! Ref TASK3_激光全景标定工具.md §2: magnitude alone is not a valid rest test — a
//! genuinely static session can sit at gyro magnitude ~0.05-0.06 rad/s purely from
//! zero-offset/bias, while true per-axis std stays ~0.001. So the judgment looks at
//! per-axis std, both over the whole session and over a sliding window (to catch a
//! short real rotation buried inside an otherwise-still recording, which a
//! whole-session average would dilute away).

use serde::Serialize;
use std::path::Path;
use std::process::Command;

pub const DEFAULT_REST_STD_THRESHOLD: f64 = 0.005;
const WINDOW_SAMPLES: usize = 100;

#[derive(Debug, Clone, Serialize)]
pub struct MotionCheckResult {
    pub gyro_std: [f64; 3],
    pub window_std_max: f64,
    pub is_static: bool,
    pub threshold: f64,
    pub sample_count: usize,
    pub duration_s: f64,
}

/// Shell out to `hera-storage-extract-mid360 <hera_path> --imu <out_csv>`.
pub fn extract_imu_csv(tool_path: &Path, hera_path: &Path, out_csv: &Path) -> anyhow::Result<()> {
    let output = Command::new(tool_path)
        .arg(hera_path)
        .arg("--imu")
        .arg(out_csv)
        .output()?;
    if !output.status.success() {
        anyhow::bail!(
            "hera-storage-extract-mid360 exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
    if !out_csv.exists() {
        anyhow::bail!(
            "hera-storage-extract-mid360 reported success but did not produce {}",
            out_csv.display()
        );
    }
    Ok(())
}

struct ImuSample {
    timestamp_device_ns: u64,
    gyro: [f64; 3],
}

/// Parses the CSV produced by `hera-storage-extract-mid360 --imu`, columns
/// `timestamp_device_ns,timestamp_host_ns,gyro_x,gyro_y,gyro_z,acc_x,acc_y,acc_z`
/// (order not assumed — resolved by header name).
fn parse_imu_csv(path: &Path) -> anyhow::Result<Vec<ImuSample>> {
    let text = std::fs::read_to_string(path)?;
    let mut lines = text.lines();
    let header = lines
        .next()
        .ok_or_else(|| anyhow::anyhow!("empty IMU csv: {}", path.display()))?;
    let cols: Vec<&str> = header.split(',').collect();
    let idx = |name: &str| -> anyhow::Result<usize> {
        cols.iter()
            .position(|c| c.trim() == name)
            .ok_or_else(|| anyhow::anyhow!("IMU csv missing column '{name}'"))
    };
    let ts_idx = idx("timestamp_device_ns")?;
    let gx_idx = idx("gyro_x")?;
    let gy_idx = idx("gyro_y")?;
    let gz_idx = idx("gyro_z")?;

    let mut samples = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split(',').collect();
        samples.push(ImuSample {
            timestamp_device_ns: fields[ts_idx].trim().parse()?,
            gyro: [
                fields[gx_idx].trim().parse()?,
                fields[gy_idx].trim().parse()?,
                fields[gz_idx].trim().parse()?,
            ],
        });
    }
    Ok(samples)
}

fn population_std(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
    var.sqrt()
}

pub fn check_motion(imu_csv_path: &Path, threshold: f64) -> anyhow::Result<MotionCheckResult> {
    let samples = parse_imu_csv(imu_csv_path)?;
    if samples.is_empty() {
        anyhow::bail!("IMU csv has no samples: {}", imu_csv_path.display());
    }

    let mut gyro_std = [0.0; 3];
    for (axis, std) in gyro_std.iter_mut().enumerate() {
        let vals: Vec<f64> = samples.iter().map(|s| s.gyro[axis]).collect();
        *std = population_std(&vals);
    }
    let max_axis_std = gyro_std.iter().cloned().fold(0.0_f64, f64::max);

    let window_std_max = if samples.len() >= WINDOW_SAMPLES {
        let mut max = 0.0_f64;
        for window in samples.windows(WINDOW_SAMPLES) {
            for axis in 0..3 {
                let vals: Vec<f64> = window.iter().map(|s| s.gyro[axis]).collect();
                max = max.max(population_std(&vals));
            }
        }
        max
    } else {
        max_axis_std
    };

    let duration_s = (samples[samples.len() - 1]
        .timestamp_device_ns
        .saturating_sub(samples[0].timestamp_device_ns)) as f64
        / 1e9;

    Ok(MotionCheckResult {
        gyro_std,
        window_std_max,
        is_static: max_axis_std < threshold && window_std_max < threshold,
        threshold,
        sample_count: samples.len(),
        duration_s,
    })
}

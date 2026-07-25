/// Whether a real, working NVIDIA GPU is present. `nvidia-smi` only exits 0 when
/// the driver is actually loaded and can see a device — this catches "driver
/// installed but no GPU attached" too, not just "binary exists on PATH".
pub fn detect_nvidia_gpu() -> bool {
    std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

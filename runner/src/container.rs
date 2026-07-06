use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub struct ContainerRuntime {
    pub binary: String,
    pub gpu_enabled: bool,
}

impl ContainerRuntime {
    pub fn new(binary: impl Into<String>, gpu_enabled: bool) -> Self {
        Self {
            binary: binary.into(),
            gpu_enabled,
        }
    }

    pub fn detect() -> Self {
        if which_exists("docker") {
            Self::new("docker", false)
        } else if which_exists("podman") {
            Self::new("podman", false)
        } else {
            Self::new("docker", false)
        }
    }

    /// Run a container as root; appends a chown step for writable output paths so host user
    /// owns the output files (avoids root-owned artifacts from ROS-based images whose
    /// entrypoint sources /root/... files and cannot run as non-root).
    pub async fn run(
        &self,
        image: &str,
        gpu: bool,
        mounts: &[MountArg],
        env_vars: &HashMap<String, String>,
        command: &str,
    ) -> anyhow::Result<(i32, mpsc::Receiver<LogLine>)> {
        let uid = get_current_uid();
        let gid = get_current_gid();

        let mut args: Vec<String> = vec!["run".into(), "--rm".into()];

        // Run as root inside the container; we chown output in the wrapped command below.
        // Cannot use --user here because GLIM's entrypoint sources /root/ros2_ws/... (root-only).

        if gpu && self.gpu_enabled {
            if self.binary == "podman" {
                args.extend(["--device".into(), "nvidia.com/gpu=all".into()]);
            } else {
                args.extend(["--gpus".into(), "all".into()]);
            }
        }

        for m in mounts {
            args.extend([
                "-v".into(),
                format!("{}:{}:{}", m.host, m.container, if m.writable { "rw" } else { "ro" }),
            ]);
        }

        for (k, v) in env_vars {
            args.extend(["-e".into(), format!("{}={}", k, v)]);
        }

        // Build output paths to chown after the main command
        let rw_paths: Vec<&str> = mounts
            .iter()
            .filter(|m| m.writable)
            .map(|m| m.container.as_str())
            .collect();

        // Wrap command: run it, then chown all rw mounts to the host user.
        // `|| true` on the chown so a missing dir (optional outputs) doesn't hide the real exit code.
        let chown_cmd = if rw_paths.is_empty() {
            String::new()
        } else {
            format!(
                "; _rc=$?; chown -R {}:{} {} 2>/dev/null || true; exit $_rc",
                uid,
                gid,
                rw_paths.join(" ")
            )
        };
        let wrapped = format!("{}{}", command, chown_cmd);

        args.push(image.into());
        args.extend(["sh".into(), "-c".into(), wrapped.clone()]);

        tracing::debug!("docker run: {} {}", self.binary, args.join(" "));

        let mut child = Command::new(&self.binary)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");

        let (tx, rx) = mpsc::channel::<LogLine>(1024);
        let tx2 = tx.clone();

        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx.send(LogLine { stream: Stream::Stdout, text: line }).await;
            }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx2.send(LogLine { stream: Stream::Stderr, text: line }).await;
            }
        });

        let exit_code = child.wait().await?.code().unwrap_or(-1);
        Ok((exit_code, rx))
    }
}

#[derive(Debug, Clone)]
pub struct MountArg {
    pub host: String,
    pub container: String,
    pub writable: bool,
}

impl MountArg {
    pub fn ro(host: impl Into<String>, container: impl Into<String>) -> Self {
        Self { host: host.into(), container: container.into(), writable: false }
    }
    pub fn rw(host: impl Into<String>, container: impl Into<String>) -> Self {
        Self { host: host.into(), container: container.into(), writable: true }
    }
}

#[derive(Debug, Clone)]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone)]
pub struct LogLine {
    pub stream: Stream,
    pub text: String,
}

fn which_exists(cmd: &str) -> bool {
    std::process::Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn get_current_uid() -> u32 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("Uid:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|n| n.parse().ok())
        })
        .unwrap_or(1000)
}

fn get_current_gid() -> u32 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("Gid:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|n| n.parse().ok())
        })
        .unwrap_or(1000)
}

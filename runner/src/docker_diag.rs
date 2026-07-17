//! Turn raw docker/podman CLI failures into short, actionable Chinese messages.
//!
//! The container CLI's own error text is inconsistent across Docker Desktop
//! (Windows/macOS), Docker Engine (Linux) and podman, and is written for
//! people who already know what a daemon socket is. We pattern-match the
//! common cases (not installed, daemon not running, no permission, not
//! logged in, image/tag missing, network unreachable) and always keep the
//! raw text attached so nothing is hidden when the guess is wrong.

/// Classify a process spawn failure — most commonly "binary not found",
/// i.e. Docker/Podman isn't installed or isn't on PATH.
pub fn friendly_spawn_error(binary: &str, err: &std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::NotFound {
        return format!(
            "未检测到 {binary}，请先安装并启动 Docker Desktop（Windows / macOS）\
             或 Docker Engine（Linux），然后重试。\n\
             下载地址：https://docs.docker.com/get-docker/\n\
             原始错误：{err}"
        );
    }
    format!("启动 {binary} 失败：{err}")
}

/// Classify a non-zero-exit docker/podman command's stderr text.
/// `context` is a short human description of what we were trying to do,
/// e.g. "镜像拉取失败 (docker pull)".
pub fn friendly_docker_error(context: &str, raw: &str) -> String {
    let raw = raw.trim();
    let lower = raw.to_lowercase();

    let hint = if lower.contains("cannot connect to the docker daemon")
        || lower.contains("is the docker daemon running")
        || lower.contains("docker daemon is not running")
        || lower.contains("error during connect")
        || (lower.contains("pipe/dockerdesktoplinuxengine"))
    {
        Some(
            "Docker 服务未启动。请启动 Docker Desktop（Windows / macOS），\
             或在 Linux 上执行 `sudo systemctl start docker`，然后重试。",
        )
    } else if lower.contains("permission denied") && lower.contains("docker.sock") {
        Some(
            "当前用户没有访问 Docker 的权限。请将用户加入 docker 用户组\
             （`sudo usermod -aG docker $USER`）并重新登录，或以管理员身份运行。",
        )
    } else if lower.contains("pull access denied")
        || lower.contains("requires 'docker login'")
        || lower.contains("unauthorized")
        || lower.contains("authentication required")
        || lower.contains("not authorized")
    {
        Some(
            "没有权限拉取该镜像，通常是尚未登录镜像仓库，或账号无权访问该镜像。\
             请先执行 `docker login <镜像仓库地址>` 登录后重试。",
        )
    } else if lower.contains("manifest unknown")
        || (lower.contains("manifest for") && lower.contains("not found"))
        || lower.contains("repository does not exist")
    {
        Some("镜像或版本号不存在，请检查镜像名称和 tag 是否正确。")
    } else if lower.contains("no such host")
        || lower.contains("i/o timeout")
        || lower.contains("tls handshake timeout")
        || lower.contains("dial tcp")
        || lower.contains("network is unreachable")
    {
        Some("无法连接镜像仓库，请检查网络连接或代理设置后重试。")
    } else if lower.contains("no space left on device") {
        Some("磁盘空间不足，请清理磁盘（例如 `docker system prune`）后重试。")
    } else {
        None
    };

    match hint {
        Some(h) => format!("{context}：{h}\n原始错误：{raw}"),
        None => format!("{context}：{raw}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pull_access_denied_reported_by_user() {
        // Exact string reported from a real Windows run against Aliyun ACR.
        let raw = "Error response from daemon: pull access denied for \
                    crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/glim-runner, \
                    repository does not exist or may require 'docker login'";
        let msg = friendly_docker_error("镜像拉取失败 (docker pull)", raw);
        assert!(msg.contains("docker login"), "should tell the user to log in: {msg}");
        assert!(msg.contains(raw), "should retain the raw error for debugging: {msg}");
    }

    #[test]
    fn pull_access_denied_real_docker_hub_output() {
        // Captured live from `docker pull` against a nonexistent Docker Hub repo —
        // confirms the classifier matches real CLI phrasing, not just the pasted report.
        let raw = "Error response from daemon: pull access denied for \
                    hera-desktop-test-nonexistent/definitely-not-real, \
                    repository does not exist or may require 'docker login'";
        let msg = friendly_docker_error("镜像拉取失败 (docker pull)", raw);
        assert!(msg.contains("docker login"));
    }

    #[test]
    fn daemon_not_running() {
        let raw = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. \
                    Is the docker daemon running?";
        let msg = friendly_docker_error("镜像拉取失败 (docker pull)", raw);
        assert!(msg.contains("未启动"), "should tell the user the daemon isn't running: {msg}");
    }

    #[test]
    fn windows_daemon_not_running() {
        let raw = "error during connect: this error may indicate that the docker daemon is not running: \
                    Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.24/...\"";
        let msg = friendly_docker_error("镜像拉取失败 (docker pull)", raw);
        assert!(msg.contains("未启动"), "should catch Windows Docker Desktop phrasing: {msg}");
    }

    #[test]
    fn binary_not_found_reports_install_hint() {
        let err = std::io::Error::from(std::io::ErrorKind::NotFound);
        let msg = friendly_spawn_error("docker", &err);
        assert!(msg.contains("未检测到 docker"));
        assert!(msg.contains("docs.docker.com"));
    }

    #[test]
    fn unrecognized_error_falls_back_to_raw_text_verbatim() {
        let raw = "some future docker CLI error we haven't special-cased yet";
        let msg = friendly_docker_error("操作失败", raw);
        assert!(msg.contains(raw), "must never swallow unrecognized errors: {msg}");
    }
}

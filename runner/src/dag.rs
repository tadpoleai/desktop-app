use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::config::AppConfig;
use crate::container::{ContainerRuntime, MountArg};
use crate::injector::StepContext;
use crate::manifest::{GpuMode, IoType, Operator};
use crate::registry::Registry;
use crate::workflow::{Workflow, WorkflowNode};

#[derive(Debug, Clone)]
pub enum JobEvent {
    StepStart { step: String, image: String },
    Log { step: String, text: String, is_stderr: bool },
    StepComplete { step: String },
    StepFailed { step: String, exit_code: i32, reason: String },
    JobComplete { artifacts: Vec<Artifact> },
    JobFailed { step: String, reason: String },
}

#[derive(Debug, Clone)]
pub struct Artifact {
    pub id: String,
    pub step: String,
    pub output_id: String,
    pub host_path: String,
}

pub struct JobRunner {
    pub job_id: String,
    config: AppConfig,
    runtime: ContainerRuntime,
    operators_dir: PathBuf,
}

impl JobRunner {
    pub fn new(config: AppConfig, operators_dir: impl Into<PathBuf>) -> Self {
        let runtime = ContainerRuntime::new(&config.runtime.container, config.runtime.gpu_enabled);
        Self {
            job_id: Uuid::new_v4().to_string(),
            config,
            runtime,
            operators_dir: operators_dir.into(),
        }
    }

    /// Execute a workflow. Events are sent over the returned channel.
    pub async fn run_workflow(
        &self,
        workflow: &Workflow,
        user_input_path: &Path,
        param_overrides: &HashMap<String, HashMap<String, serde_json::Value>>,
    ) -> mpsc::Receiver<JobEvent> {
        let (tx, rx) = mpsc::channel::<JobEvent>(256);

        let job_dir = self.config.output_dir().join(&self.job_id);
        let operators_dir = self.operators_dir.clone();
        let runtime = self.runtime.clone();
        let config = self.config.clone();
        let workflow = workflow.clone();
        let user_input_path = user_input_path.to_path_buf();
        let param_overrides = param_overrides.clone();
        let job_id = self.job_id.clone();

        tokio::spawn(async move {
            if let Err(e) = run_workflow_inner(
                &job_id,
                &job_dir,
                &operators_dir,
                &runtime,
                &config,
                &workflow,
                &user_input_path,
                &param_overrides,
                &tx,
            )
            .await
            {
                let _ = tx
                    .send(JobEvent::JobFailed {
                        step: "runner".into(),
                        reason: e.to_string(),
                    })
                    .await;
            }
        });

        rx
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_workflow_inner(
    job_id: &str,
    job_dir: &Path,
    operators_dir: &Path,
    runtime: &ContainerRuntime,
    config: &AppConfig,
    workflow: &Workflow,
    user_input_path: &Path,
    param_overrides: &HashMap<String, HashMap<String, serde_json::Value>>,
    tx: &mpsc::Sender<JobEvent>,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(job_dir)?;
    // Docker bind mounts require absolute paths
    let job_dir = job_dir
        .canonicalize()
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default().join(job_dir));

    let sorted = workflow.topo_sorted_nodes();

    // Map step_id -> resolved output host paths
    let mut step_outputs: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut all_artifacts: Vec<Artifact> = Vec::new();

    for node in sorted {
        let (op, image_ref, image_digest, resolved_version) = load_operator_for_step(
            &config.registry.db_path,
            operators_dir,
            &node.operator,
            node.version.as_deref(),
        )?;
        let step_dir = job_dir.join(&node.id);
        std::fs::create_dir_all(&step_dir)?;

        // Resolve inputs
        let inputs = resolve_inputs(
            workflow,
            node,
            user_input_path,
            &step_outputs,
            &op,
            &step_dir,
        )?;

        // Resolve outputs (host side)
        let outputs = resolve_outputs(&op, &step_dir);

        // Merge param overrides
        let mut params = node.params.clone();
        if let Some(overrides) = param_overrides.get(&node.id) {
            for (k, v) in overrides {
                params.insert(k.clone(), v.clone());
            }
        }

        // Prepare job-local config copy if operator has rw config mount
        let job_config_dir = prepare_config_dir(config, &op, &step_dir)?;

        let ctx = StepContext {
            op: &op,
            inputs: inputs.clone(),
            outputs: outputs.clone(),
            params,
            job_config_dir: job_config_dir.clone().map(|p| p.to_string_lossy().to_string()),
        };

        // Apply config patches before running
        ctx.apply_config_patches()?;

        let env = ctx.env_vars();
        let command = ctx.expand_command()?;

        // Build mount list
        let mounts: Vec<MountArg> = build_mounts(&op, &inputs, &outputs, &job_config_dir);

        let _ = tx
            .send(JobEvent::StepStart {
                step: node.id.clone(),
                image: op.image.clone(),
            })
            .await;

        let needs_gpu = matches!(op.gpu, GpuMode::Required)
            || (matches!(op.gpu, GpuMode::Optional) && config.runtime.gpu_enabled);

        let (exit_code, mut log_rx) = runtime
            .run(&op.image, needs_gpu, &mounts, &env, &command)
            .await?;

        let mut stderr_tail: Vec<String> = Vec::new();
        while let Some(line) = log_rx.recv().await {
            let is_stderr = matches!(line.stream, crate::container::Stream::Stderr);
            if is_stderr {
                stderr_tail.push(line.text.clone());
                if stderr_tail.len() > 40 {
                    stderr_tail.remove(0);
                }
            }
            let _ = tx
                .send(JobEvent::Log {
                    step: node.id.clone(),
                    text: line.text,
                    is_stderr,
                })
                .await;
        }

        if !op.exit_codes_ok.contains(&exit_code) {
            let reason = if stderr_tail.is_empty() {
                format!("步骤 {} 执行失败（退出码 {}），请查看日志了解详情。", node.id, exit_code)
            } else {
                crate::docker_diag::friendly_docker_error(
                    &format!("步骤 {} 执行失败（退出码 {}）", node.id, exit_code),
                    &stderr_tail.join("\n"),
                )
            };
            let _ = tx
                .send(JobEvent::StepFailed {
                    step: node.id.clone(),
                    exit_code,
                    reason: reason.clone(),
                })
                .await;
            return Err(anyhow::anyhow!(reason));
        }

        let _ = tx.send(JobEvent::StepComplete { step: node.id.clone() }).await;

        // Record provenance
        if let Ok(reg) = Registry::open(Path::new(&config.registry.db_path)) {
            let params_str = serde_json::to_string(&node.params).unwrap_or_default();
            let _ = reg.record_step_provenance(
                job_id,
                &node.id,
                &node.operator,
                &resolved_version,
                &image_ref,
                &image_digest,
                &params_str,
            );
        }

        // Register outputs
        step_outputs.insert(node.id.clone(), outputs.clone());
        for (out_id, host_path) in &outputs {
            all_artifacts.push(Artifact {
                id: format!("{}/{}/{}", job_id, node.id, out_id),
                step: node.id.clone(),
                output_id: out_id.clone(),
                host_path: host_path.clone(),
            });
        }
    }

    let _ = tx.send(JobEvent::JobComplete { artifacts: all_artifacts }).await;
    Ok(())
}

/// Load operator manifest: registry-first, then fallback to operators/<id>/operator.json.
/// Returns (Operator, image_ref, image_digest, resolved_version).
fn load_operator_for_step(
    db_path: &str,
    operators_dir: &Path,
    id: &str,
    version: Option<&str>,
) -> anyhow::Result<(Operator, String, String, String)> {
    let ver = version.unwrap_or("latest");

    // 1. Try registry lookup
    if let Ok(reg) = Registry::open(Path::new(db_path)) {
        if let Ok(Some((manifest_json, image_ref, image_digest, resolved_ver))) =
            reg.resolve_operator(id, ver)
        {
            let mut op: Operator = Operator::from_json_str(&manifest_json)
                .map_err(|e| anyhow::anyhow!("registry manifest parse error for {id}: {e}"))?;
            // Self-describe manifests omit 'image'; fill from registry
            if op.image.is_empty() {
                op.image = image_ref.clone();
            }
            tracing::debug!(
                "Loaded operator {id}@{resolved_ver} from registry (image={image_ref})"
            );
            return Ok((op, image_ref, image_digest, resolved_ver));
        }
    }

    // 2. Fallback: operators/<id>/operator.json (external file, has 'image' field)
    let path = operators_dir.join(id).join("operator.json");
    let op = Operator::load(&path)?;
    let image_ref = op.image.clone();
    let version_str = op.version.clone();
    tracing::debug!("Loaded operator {id} from file (image={image_ref})");
    Ok((op, image_ref, "unknown".to_string(), version_str))
}

fn resolve_inputs(
    workflow: &Workflow,
    node: &WorkflowNode,
    user_input_path: &Path,
    step_outputs: &HashMap<String, HashMap<String, String>>,
    _op: &Operator,
    _step_dir: &Path,
) -> anyhow::Result<HashMap<String, String>> {
    let mut inputs: HashMap<String, String> = HashMap::new();

    // Check if this node receives the workflow-level user input
    if workflow.workflow_input_to.node == node.id {
        let input_id = &workflow.workflow_input_to.input;
        inputs.insert(input_id.clone(), user_input_path.to_string_lossy().to_string());
    }

    // Resolve inputs from upstream edges
    for edge in &workflow.edges {
        if edge.to_node == node.id {
            if let Some(upstream_outputs) = step_outputs.get(&edge.from_node) {
                if let Some(host_path) = upstream_outputs.get(&edge.from_output) {
                    inputs.insert(edge.to_input.clone(), host_path.clone());
                }
            }
        }
    }

    Ok(inputs)
}

fn resolve_outputs(op: &Operator, step_dir: &Path) -> HashMap<String, String> {
    let mut outputs = HashMap::new();
    for out in &op.outputs {
        // Derive host path from container path basename
        let name = Path::new(&out.container)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&out.id);
        let host_path = step_dir.join(name);
        outputs.insert(out.id.clone(), host_path.to_string_lossy().to_string());
    }
    outputs
}

fn prepare_config_dir(
    config: &AppConfig,
    op: &Operator,
    step_dir: &Path,
) -> anyhow::Result<Option<PathBuf>> {
    let rw_mount = match op.mounts.iter().find(|m| m.mode == "rw") {
        Some(m) => m,
        None => return Ok(None),
    };

    // Priority 1: explicit glim_config_dir in config
    let source = if let Some(d) = config.glim_config_dir() {
        d
    } else if let Some(image_path) = &rw_mount.image_config_path {
        // Priority 2: auto-extract from image and cache
        let cache = config.config_cache_dir().join(&op.id).join("config");
        if !cache.exists() {
            tracing::info!(
                "Config cache not found for {}, extracting from image {} ...",
                op.id, op.image
            );
            extract_config_from_image(&op.image, image_path, &cache)?;
            tracing::info!("Config extracted to {}", cache.display());
        }
        cache
    } else {
        return Err(anyhow::anyhow!(
            "Operator '{}' needs a writable config directory but glim_config_dir is not set \
             and no image_config_path is defined in the mount. \
             Set [data] glim_config_dir in config.toml.",
            op.id
        ));
    };

    // Copy to a per-job directory so patches don't affect the source
    let dest = step_dir.join("config");
    copy_dir_all(&source, &dest)?;
    Ok(Some(dest))
}

/// Extract a directory from a container image to a local path using docker create/cp/rm.
pub fn extract_config_from_image(
    image: &str,
    container_path: &str,
    dest: &Path,
) -> anyhow::Result<()> {
    use std::process::Command;

    std::fs::create_dir_all(dest)?;

    let container_name = format!("hera-cfg-{}", uuid::Uuid::new_v4().simple());

    let create = Command::new("docker")
        .args(["create", "--name", &container_name, image, "true"])
        .output()
        .map_err(|e| anyhow::anyhow!(crate::docker_diag::friendly_spawn_error("docker", &e)))?;
    if !create.status.success() {
        return Err(anyhow::anyhow!(crate::docker_diag::friendly_docker_error(
            "提取算子配置失败 (docker create)",
            &String::from_utf8_lossy(&create.stderr),
        )));
    }

    // docker cp <container>:/path/. <dest> copies contents (not the dir itself)
    let src_spec = format!(
        "{}:{}/.",
        container_name,
        container_path.trim_end_matches('/')
    );
    let cp = Command::new("docker")
        .args(["cp", &src_spec, &dest.to_string_lossy()])
        .output();

    // Always remove the temporary container
    let _ = Command::new("docker")
        .args(["rm", &container_name])
        .output();

    let cp = cp.map_err(|e| anyhow::anyhow!(crate::docker_diag::friendly_spawn_error("docker", &e)))?;
    if !cp.status.success() {
        return Err(anyhow::anyhow!(crate::docker_diag::friendly_docker_error(
            "提取算子配置失败 (docker cp)",
            &String::from_utf8_lossy(&cp.stderr),
        )));
    }
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            std::fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn build_mounts(
    op: &Operator,
    inputs: &HashMap<String, String>,
    outputs: &HashMap<String, String>,
    job_config_dir: &Option<PathBuf>,
) -> Vec<MountArg> {
    let mut mounts: Vec<MountArg> = Vec::new();

    // Input mounts (ro) — use effective container path so file extensions are preserved
    for inp in &op.inputs {
        if let Some(host) = inputs.get(&inp.id) {
            let container = inp.effective_container_path(host);
            mounts.push(MountArg::ro(host, container));
        }
    }

    // Output mounts (rw) — ensure host dir exists
    for out in &op.outputs {
        if let Some(host) = outputs.get(&out.id) {
            let host_path = Path::new(host);
            match out.io_type {
                IoType::Dir => {
                    let _ = std::fs::create_dir_all(host_path);
                    mounts.push(MountArg::rw(host, &out.container));
                }
                IoType::File => {
                    if let Some(parent) = host_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    // Mount the parent dir, not the file itself
                    let parent = host_path
                        .parent()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| ".".to_string());
                    let container_parent = Path::new(&out.container)
                        .parent()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| "/output".to_string());
                    mounts.push(MountArg::rw(parent, container_parent));
                }
            }
        }
    }

    // Config mount (rw copy)
    if let Some(cfg_dir) = job_config_dir {
        for m in &op.mounts {
            if m.mode == "rw" {
                mounts.push(MountArg::rw(
                    cfg_dir.to_string_lossy().to_string(),
                    &m.container,
                ));
            } else {
                mounts.push(MountArg::ro(
                    cfg_dir.to_string_lossy().to_string(),
                    &m.container,
                ));
            }
        }
    }

    mounts
}

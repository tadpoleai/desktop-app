use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;
use hera_runner::config::AppConfig;
use hera_runner::registry::{ArtifactRow, DatasetRow, JobRow, OperatorSummaryRow, StepProvenanceRow};
use hera_runner::workflow::Workflow;
use hera_runner::{JobEvent, JobRunner};

// ── Datasets ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_datasets(state: State<AppState>) -> Result<Vec<DatasetRow>, String> {
    state
        .registry
        .lock()
        .unwrap()
        .list_datasets()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn scan_dir(path: String, state: State<AppState>) -> Result<usize, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("path does not exist: {}", path));
    }
    let reg = state.registry.lock().unwrap();
    let mut count = 0;
    for entry in walkdir::WalkDir::new(&p).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let ext = entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            let file_type = match ext {
                "hera" => "hera",
                "db3" => "db3",
                "bag" => "bag",
                "ply" | "pcd" | "csv" => "pointcloud",
                _ => continue,
            };
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            reg.upsert_dataset(
                &entry.path().to_string_lossy(),
                file_type,
                size,
                None,
            )
            .map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    Ok(count)
}

// ── Workflows ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_workflows(state: State<AppState>) -> Result<Vec<serde_json::Value>, String> {
    let dir = &state.workflows_dir;
    let mut result = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            if entry.path().extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(wf) = Workflow::load(&entry.path()) {
                    result.push(serde_json::json!({
                        "id": wf.id,
                        "name": wf.name,
                        "description": wf.description,
                        "input": wf.input,
                    }));
                }
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn get_workflow(id: String, state: State<AppState>) -> Result<serde_json::Value, String> {
    let path = state.workflows_dir.join(format!("{}.json", id));
    let wf = Workflow::load(&path).map_err(|e| e.to_string())?;

    let reg = state.registry.lock().unwrap();

    let mut nodes_with_params: Vec<serde_json::Value> = Vec::new();
    for node in &wf.nodes {
        // Gather available versions from registry
        let available_versions: Vec<String> = reg
            .operator_list()
            .unwrap_or_default()
            .into_iter()
            .find(|op| op.id == node.operator)
            .map(|op| op.versions.into_iter().map(|v| v.version).collect())
            .unwrap_or_default();

        let pinned_version = node.version.clone().unwrap_or_else(|| "latest".to_string());

        // Resolve params_schema from registry (preferred) or file fallback
        let (params_schema, param_schema_legacy) = {
            let from_registry = reg
                .resolve_operator(&node.operator, &pinned_version)
                .ok()
                .flatten()
                .and_then(|(manifest_json, ..)| {
                    serde_json::from_str::<serde_json::Value>(&manifest_json).ok()
                });

            if let Some(manifest) = from_registry {
                let schema = manifest.get("params_schema").cloned();
                // Also synthesize legacy param_schema array for backwards-compat
                let legacy = {
                    let op_path = state.operators_dir.join(&node.operator).join("operator.json");
                    hera_runner::manifest::Operator::load(&op_path)
                        .map(|op| serde_json::to_value(&op.params).unwrap_or(serde_json::Value::Null))
                        .unwrap_or(serde_json::Value::Null)
                };
                (schema, legacy)
            } else {
                let op_path = state.operators_dir.join(&node.operator).join("operator.json");
                let legacy = hera_runner::manifest::Operator::load(&op_path)
                    .map(|op| serde_json::to_value(&op.params).unwrap_or(serde_json::Value::Null))
                    .unwrap_or(serde_json::Value::Null);
                (None, legacy)
            }
        };

        nodes_with_params.push(serde_json::json!({
            "id": node.id,
            "operator": node.operator,
            "version": pinned_version,
            "available_versions": available_versions,
            "params": node.params,
            "params_schema": params_schema,
            "param_schema": param_schema_legacy,
        }));
    }

    Ok(serde_json::json!({
        "id": wf.id,
        "name": wf.name,
        "description": wf.description,
        "input": wf.input,
        "nodes": nodes_with_params,
        "edges": wf.edges,
        "workflow_input_to": wf.workflow_input_to,
    }))
}

// ── Job execution ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn run_workflow(
    workflow_id: String,
    input_path: String,
    param_overrides: HashMap<String, HashMap<String, serde_json::Value>>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let wf_path = state
        .workflows_dir
        .join(format!("{}.json", workflow_id));
    let wf = Workflow::load(&wf_path).map_err(|e| e.to_string())?;

    let config = state.config.lock().unwrap().clone();
    let operators_dir = state.operators_dir.clone();

    let runner = JobRunner::new(config.clone(), operators_dir);
    let job_id = runner.job_id.clone();

    {
        let reg = state.registry.lock().unwrap();
        reg.start_job(
            &job_id,
            &workflow_id,
            &input_path,
            &serde_json::to_string(&param_overrides).unwrap_or_default(),
        )
        .map_err(|e| e.to_string())?;
    }

    let app2 = app.clone();
    let jid2 = job_id.clone();
    let reg_path = config.registry.db_path.clone();

    let handle = tokio::spawn(async move {
        let input = PathBuf::from(&input_path);
        let mut rx = runner.run_workflow(&wf, &input, &param_overrides).await;
        let mut success = false;

        while let Some(event) = rx.recv().await {
            let payload = match &event {
                JobEvent::StepStart { step, image } => serde_json::json!({
                    "type": "step_start", "job": jid2, "step": step, "image": image
                }),
                JobEvent::Log { step, text, is_stderr } => serde_json::json!({
                    "type": "log", "job": jid2, "step": step, "text": text, "is_stderr": is_stderr
                }),
                JobEvent::StepComplete { step } => serde_json::json!({
                    "type": "step_complete", "job": jid2, "step": step
                }),
                JobEvent::StepFailed { step, exit_code, reason } => serde_json::json!({
                    "type": "step_failed", "job": jid2, "step": step, "exit_code": exit_code, "reason": reason
                }),
                JobEvent::JobComplete { artifacts } => {
                    success = true;
                    serde_json::json!({
                        "type": "job_complete", "job": jid2,
                        "artifacts": artifacts.iter().map(|a| serde_json::json!({
                            "id": a.id, "step": a.step, "output_id": a.output_id, "host_path": a.host_path
                        })).collect::<Vec<_>>()
                    })
                }
                JobEvent::JobFailed { step, reason } => serde_json::json!({
                    "type": "job_failed", "job": jid2, "step": step, "reason": reason
                }),
            };

            // Persist artifacts
            if let JobEvent::JobComplete { artifacts } = &event {
                if let Ok(reg) = hera_runner::registry::Registry::open(Path::new(&reg_path)) {
                    for a in artifacts {
                        let _ = reg.insert_artifact(&a.id, &jid2, &a.step, &a.output_id, &a.host_path);
                    }
                }
            }

            let _ = app2.emit("job-event", payload);
        }

        if let Ok(reg) = hera_runner::registry::Registry::open(Path::new(&reg_path)) {
            let _ = reg.finish_job(&jid2, success);
        }
    });

    state.active_jobs.lock().unwrap().insert(job_id.clone(), handle);
    Ok(job_id)
}

#[tauri::command]
pub fn cancel_job(job_id: String, state: State<AppState>) -> Result<(), String> {
    let mut jobs = state.active_jobs.lock().unwrap();
    if let Some(handle) = jobs.remove(&job_id) {
        handle.abort();
        Ok(())
    } else {
        Err(format!("job not found: {}", job_id))
    }
}

// ── Job history ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_jobs(state: State<AppState>) -> Result<Vec<JobRow>, String> {
    state
        .registry
        .lock()
        .unwrap()
        .list_jobs()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn job_artifacts(job_id: String, state: State<AppState>) -> Result<Vec<ArtifactRow>, String> {
    state
        .registry
        .lock()
        .unwrap()
        .job_artifacts(&job_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn job_provenance(
    job_id: String,
    state: State<AppState>,
) -> Result<Vec<StepProvenanceRow>, String> {
    state
        .registry
        .lock()
        .unwrap()
        .job_provenance(&job_id)
        .map_err(|e| e.to_string())
}

// ── Hera session ─────────────────────────────────────────────────────────────

/// Open a .hera file: stat it, find the adjacent .insv and .session.json,
/// read the session.json content, upsert the hera file into the dataset registry.
#[tauri::command]
pub fn open_hera_session(
    path: String,
    state: State<AppState>,
) -> Result<serde_json::Value, String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("file not found: {}", path));
    }

    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let dir = p.parent().unwrap_or_else(|| Path::new("."));

    let hera_size = p.metadata().map(|m| m.len()).unwrap_or(0);

    let insv_path = dir.join(format!("{}.insv", stem));
    let insv_size: Option<u64> = insv_path.metadata().ok().map(|m| m.len());
    let insv_path_str: Option<String> = if insv_path.exists() {
        Some(insv_path.to_string_lossy().to_string())
    } else {
        None
    };

    let session_json_path = dir.join(format!("{}.session.json", stem));
    let session_json: Option<String> = std::fs::read_to_string(&session_json_path).ok();
    let session_json_size: Option<u64> = session_json_path.metadata().ok().map(|m| m.len());

    {
        let reg = state.registry.lock().unwrap();
        let _ = reg.upsert_dataset(&path, "hera", hera_size, None);
    }

    Ok(serde_json::json!({
        "path": path,
        "stem": stem,
        "hera_size": hera_size,
        "insv_path": insv_path_str,
        "insv_size": insv_size,
        "session_json": session_json,
        "session_json_size": session_json_size,
    }))
}

/// Parse the `.hera` binary header (magic/version, timestamp range, per-device
/// message/byte counts, and the V4 `extra_info` JSON blob). Header-only read —
/// packet data is never touched, so this is cheap regardless of file size.
#[tauri::command]
pub fn hera_file_info(path: String) -> Result<serde_json::Value, String> {
    let p = std::path::PathBuf::from(&path);
    let header = hera_runner::hera_format::read_header(&p).map_err(|e| e.to_string())?;
    let duration_s = (header.timestamp_end_ns.saturating_sub(header.timestamp_start_ns)) as f64 / 1e9;
    Ok(serde_json::json!({
        "version": header.version,
        "timestamp_start_ns": header.timestamp_start_ns,
        "timestamp_end_ns": header.timestamp_end_ns,
        "duration_s": duration_s,
        "devices": header.devices,
        "extra_info": header.extra_info,
    }))
}

// ── File system ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Config ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_config(state: State<AppState>) -> Result<AppConfig, String> {
    Ok(state.config.lock().unwrap().clone())
}

#[tauri::command]
pub fn set_config(config: AppConfig, state: State<AppState>) -> Result<(), String> {
    *state.config.lock().unwrap() = config;
    Ok(())
}

// ── Operator registry ─────────────────────────────────────────────────────────

/// Add an operator from an image ref (pulled from registry) or a tar file.
///
/// If `manifest_json` is provided it is used directly — the `--describe` container
/// call is skipped.  This is necessary for images whose entrypoint does not
/// implement the `--describe` protocol (e.g. ROS images with /ros_entrypoint.sh).
/// The `version` field inside the manifest is automatically overwritten with the
/// tag portion of `resolved_ref` so that registry entries stay consistent with the
/// pulled image tag.
///
/// Sequence: [load tar | pull] → [--describe | use manifest_json] → inspect digest → validate → register.
#[tauri::command]
pub async fn operator_add(
    image_ref: String,
    tar_path: Option<String>,
    manifest_json: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let container = {
        let cfg = state.config.lock().unwrap();
        cfg.runtime.container.clone()
    };

    // 1. Load from tar if provided
    let resolved_ref = if let Some(tar) = &tar_path {
        let out = tokio::process::Command::new(&container)
            .args(["load", "-i", tar])
            .output()
            .await
            .map_err(|e| hera_runner::docker_diag::friendly_spawn_error(&container, &e))?;
        if !out.status.success() {
            return Err(hera_runner::docker_diag::friendly_docker_error(
                "镜像导入失败 (docker load)",
                &String::from_utf8_lossy(&out.stderr),
            ));
        }
        // Parse "Loaded image: <ref>" from stdout
        let stdout = String::from_utf8_lossy(&out.stdout);
        stdout
            .lines()
            .find(|l| l.starts_with("Loaded image:"))
            .and_then(|l| l.strip_prefix("Loaded image:"))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| image_ref.clone())
    } else {
        // Pull from registry (no-op if already local)
        let pull = tokio::process::Command::new(&container)
            .args(["pull", &image_ref])
            .output()
            .await
            .map_err(|e| hera_runner::docker_diag::friendly_spawn_error(&container, &e))?;
        if !pull.status.success() {
            return Err(hera_runner::docker_diag::friendly_docker_error(
                "镜像拉取失败 (docker pull)",
                &String::from_utf8_lossy(&pull.stderr),
            ));
        }
        image_ref.clone()
    };

    // 2. Obtain manifest — either from the caller or via --describe
    let manifest: serde_json::Value = if let Some(provided) = manifest_json {
        // Caller supplied the manifest (e.g. official operators with ROS entrypoints
        // that don't support --describe).  Auto-sync the version field to the image tag.
        let mut m: serde_json::Value = serde_json::from_str(&provided)
            .map_err(|e| format!("provided manifest JSON parse error: {e}"))?;
        let tag = resolved_ref
            .rsplit(':')
            .next()
            .filter(|t| !t.contains('/'))
            .unwrap_or("latest");
        m["version"] = serde_json::Value::String(tag.to_string());
        m
    } else {
        // Ask the container to self-describe.
        let describe = tokio::process::Command::new(&container)
            .args(["run", "--rm", &resolved_ref, "--describe"])
            .output()
            .await
            .map_err(|e| hera_runner::docker_diag::friendly_spawn_error(&container, &e))?;
        if !describe.status.success() {
            return Err(format!(
                "{}\n提示：如果该镜像不支持 --describe 协议，请直接提供 manifest JSON。",
                hera_runner::docker_diag::friendly_docker_error(
                    "获取算子描述失败 (docker run --describe)",
                    &String::from_utf8_lossy(&describe.stderr),
                ),
            ));
        }
        let manifest_str = String::from_utf8_lossy(&describe.stdout);
        serde_json::from_str(&manifest_str)
            .map_err(|e| format!("manifest JSON parse error: {e}\noutput: {manifest_str}"))?
    };

    // 3. Validate required fields
    validate_manifest(&manifest)?;

    let op_id = manifest["id"].as_str().unwrap().to_string();
    let op_version = manifest["version"].as_str().unwrap().to_string();
    let manifest_str = serde_json::to_string(&manifest).unwrap();

    // 4. Get image digest (ImageID = sha256 of config, always available locally)
    let inspect = tokio::process::Command::new(&container)
        .args(["inspect", "--format", "{{.Id}}", &resolved_ref])
        .output()
        .await
        .map_err(|e| hera_runner::docker_diag::friendly_spawn_error(&container, &e))?;
    let digest = String::from_utf8_lossy(&inspect.stdout).trim().to_string();

    // 5. Register
    let source = if tar_path.is_some() { "tar" } else { "registry" };
    {
        let reg = state.registry.lock().unwrap();
        reg.operator_register(&op_id, &op_version, &resolved_ref, &digest, &manifest_str, source)
            .map_err(|e| e.to_string())?;
    }

    Ok(manifest)
}

fn validate_manifest(m: &serde_json::Value) -> Result<(), String> {
    for field in &["spec", "id", "name", "version", "command"] {
        if m.get(field).and_then(|v| v.as_str()).is_none() {
            return Err(format!("manifest missing required string field: {field}"));
        }
    }
    if m.get("inputs").and_then(|v| v.as_array()).map(|a| a.is_empty()).unwrap_or(true) {
        return Err("manifest 'inputs' must be a non-empty array".to_string());
    }
    if m.get("outputs").and_then(|v| v.as_array()).map(|a| a.is_empty()).unwrap_or(true) {
        return Err("manifest 'outputs' must be a non-empty array".to_string());
    }
    if let Some(schema) = m.get("params_schema") {
        if !schema.is_object() {
            return Err("manifest 'params_schema' must be a JSON object".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn operator_list(state: State<AppState>) -> Result<Vec<OperatorSummaryRow>, String> {
    state
        .registry
        .lock()
        .unwrap()
        .operator_list()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn operator_describe(
    id: String,
    version: String,
    state: State<AppState>,
) -> Result<Option<serde_json::Value>, String> {
    state
        .registry
        .lock()
        .unwrap()
        .operator_describe(&id, &version)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn operator_remove(
    id: String,
    version: String,
    state: State<AppState>,
) -> Result<(), String> {
    state
        .registry
        .lock()
        .unwrap()
        .operator_remove(&id, &version)
        .map_err(|e| e.to_string())
}

mod commands;
mod state;

use std::path::PathBuf;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir().unwrap();
            std::fs::create_dir_all(&app_dir).ok();

            let config_path = app_dir.join("config.toml");
            let cfg = if config_path.exists() {
                hera_runner::config::AppConfig::load(&config_path).unwrap_or_default()
            } else {
                hera_runner::config::AppConfig::default()
            };

            // workflows/operators: in a bundled install they live in resource_dir/{workflows,operators}
            // (packed by tauri, see bundle.resources in tauri.conf.json). In dev mode
            // (HERA_WORKSPACE set, or operators/ found on disk) use the source tree.
            let workspace_root = resolve_workspace_root();
            std::env::set_current_dir(&workspace_root).ok();

            let resource_dir = app.path().resource_dir().ok();

            // Prefer bundled resource_dir/workflows (production .deb/.AppImage/.exe),
            // fall back to workspace_root/workflows (dev / HERA_WORKSPACE).
            let workflows_dir = resource_dir
                .as_ref()
                .map(|r| r.join("workflows"))
                .filter(|p| p.exists())
                .unwrap_or_else(|| workspace_root.join("workflows"));

            // Same precedence for operator manifests — without this, bundled installs have
            // no filesystem fallback when an operator isn't yet registered in the (empty,
            // freshly-created) local registry, and workflow config panels render blank.
            let operators_dir = resource_dir
                .as_ref()
                .map(|r| r.join("operators"))
                .filter(|p| p.exists())
                .unwrap_or_else(|| workspace_root.join("operators"));

            let db_path = app_dir.join("registry.sqlite");
            let registry = hera_runner::registry::Registry::open(&db_path)
                .expect("failed to open registry");

            // Persist the absolute db path into config so the runner can open it too
            let mut cfg = cfg;
            cfg.registry.db_path = db_path.to_string_lossy().to_string();

            app.manage(state::AppState {
                config: std::sync::Mutex::new(cfg),
                operators_dir,
                workflows_dir,
                registry: std::sync::Mutex::new(registry),
                active_jobs: std::sync::Mutex::new(std::collections::HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_datasets,
            commands::scan_dir,
            commands::list_workflows,
            commands::get_workflow,
            commands::run_workflow,
            commands::cancel_job,
            commands::list_jobs,
            commands::job_artifacts,
            commands::open_path,
            commands::resolve_tool,
            commands::get_config,
            commands::set_config,
            commands::operator_add,
            commands::operator_list,
            commands::operator_describe,
            commands::operator_remove,
            commands::job_provenance,
            commands::open_hera_session,
            commands::hera_file_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Walk up from the binary location to find the workspace root (contains `operators/`).
/// Falls back to the current working directory.
fn resolve_workspace_root() -> PathBuf {
    // Prefer HERA_WORKSPACE env var (set by tauri dev or launch scripts)
    if let Ok(ws) = std::env::var("HERA_WORKSPACE") {
        return PathBuf::from(ws);
    }
    // Walk up from current exe looking for operators/ directory
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        for _ in 0..8 {
            if dir.join("operators").exists() {
                return dir;
            }
            if let Some(parent) = dir.parent() {
                dir = parent.to_path_buf();
            } else {
                break;
            }
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

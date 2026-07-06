use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::task::JoinHandle;

pub struct AppState {
    pub config: Mutex<hera_runner::config::AppConfig>,
    pub operators_dir: PathBuf,
    pub workflows_dir: PathBuf,
    pub registry: Mutex<hera_runner::registry::Registry>,
    pub active_jobs: Mutex<HashMap<String, JoinHandle<()>>>,
}

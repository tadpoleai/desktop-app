use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RuntimeConfig {
    #[serde(default = "default_docker")]
    pub container: String,
    #[serde(default)]
    pub gpu_enabled: bool,
}

fn default_docker() -> String {
    "docker".to_string()
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self { container: default_docker(), gpu_enabled: false }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct DataConfig {
    pub data_dir: Option<String>,
    pub output_dir: Option<String>,
    /// Explicit path to GLIM config directory (with config.json, config_sensors.json, …).
    /// If unset, runner auto-extracts from the GLIM image on first run and caches in config_cache_dir.
    pub glim_config_dir: Option<String>,
    /// Where to cache auto-extracted operator configs. Default: ~/.cache/hera
    pub config_cache_dir: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ViewersConfig {
    pub pointcloud_viewer: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryConfig {
    #[serde(default = "default_db_path")]
    pub db_path: String,
}

fn default_db_path() -> String {
    "./registry.sqlite".to_string()
}

impl Default for RegistryConfig {
    fn default() -> Self {
        Self {
            db_path: default_db_path(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub runtime: RuntimeConfig,
    #[serde(default)]
    pub data: DataConfig,
    #[serde(default)]
    pub viewers: ViewersConfig,
    #[serde(default)]
    pub registry: RegistryConfig,
}

impl AppConfig {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let s = std::fs::read_to_string(path)?;
        let cfg: Self = toml::from_str(&s)?;
        Ok(cfg)
    }

    pub fn output_dir(&self) -> PathBuf {
        self.data
            .output_dir
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("./hera-output"))
    }

    pub fn glim_config_dir(&self) -> Option<PathBuf> {
        self.data.glim_config_dir.as_deref().map(PathBuf::from)
    }

    /// Default: ~/.cache/hera  (auto-extracted operator configs are stored here)
    pub fn config_cache_dir(&self) -> PathBuf {
        self.data
            .config_cache_dir
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs_next::cache_dir()
                    .unwrap_or_else(|| PathBuf::from("/tmp"))
                    .join("hera")
            })
    }
}

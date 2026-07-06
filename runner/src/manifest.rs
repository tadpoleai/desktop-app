use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuMode {
    None,
    Optional,
    Required,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Mount {
    pub id: String,
    /// Host path hint (informational). Actual path resolved by runner from config.
    #[serde(default)]
    pub host: String,
    pub container: String,
    #[serde(default = "default_ro")]
    pub mode: String,
    /// Path inside the image to extract config from on first use (when host path not configured).
    #[serde(default)]
    pub image_config_path: Option<String>,
}

fn default_ro() -> String {
    "ro".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IoType {
    File,
    Dir,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Input {
    pub id: String,
    #[serde(rename = "type")]
    pub io_type: IoType,
    #[serde(default)]
    pub ext: Vec<String>,
    pub container: String,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Output {
    pub id: String,
    #[serde(rename = "type")]
    pub io_type: IoType,
    pub container: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum InjectMode {
    Arg {
        flag: String,
        #[serde(default)]
        condition: Option<String>,
    },
    Env {
        var: String,
    },
    ConfigPatch {
        file: String,
        jsonpath: String,
    },
    ConfigSwitchSuffix {
        file: String,
        /// Optional parent key to navigate into before switching (e.g. "global")
        #[serde(default)]
        parent: Option<String>,
        keys: Vec<String>,
    },
    /// Convert [roll, pitch, yaw] degrees (ZYX) to quaternion, compose with the existing
    /// T_lidar_imu in `file`, write the combined result back, and also store the raw RPY
    /// at `rpy_field` for human reference (GLIM ignores unknown fields).
    ConfigRpyPatch {
        file: String,
        /// JSONPath to the 7-element T_lidar_imu field, e.g. "$.sensors.T_lidar_imu"
        t_field: String,
        /// JSONPath where the raw RPY degrees are stored for reference
        rpy_field: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParamType {
    Number,
    #[serde(rename = "number[3]")]
    NumberArray3,
    String,
    Bool,
    Enum,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Param {
    pub id: String,
    #[serde(rename = "type")]
    pub param_type: ParamType,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub values: Vec<String>,
    pub default: serde_json::Value,
    pub inject: InjectMode,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Operator {
    pub id: String,
    pub name: String,
    pub version: String,
    /// Image ref (tag). Absent in self-describe manifests — filled by the registry lookup.
    #[serde(default)]
    pub image: String,
    pub gpu: GpuMode,
    #[serde(default)]
    pub mounts: Vec<Mount>,
    pub inputs: Vec<Input>,
    pub outputs: Vec<Output>,
    #[serde(default)]
    pub params: Vec<Param>,
    pub command: String,
    /// Exit codes that should be treated as success (default: [0]).
    #[serde(default = "default_ok_codes")]
    pub exit_codes_ok: Vec<i32>,
}

fn default_ok_codes() -> Vec<i32> {
    vec![0]
}

impl Input {
    /// Compute the actual container path by preserving the host file extension.
    /// e.g. host=scan.hera, container=/data/input → /data/input.hera
    pub fn effective_container_path(&self, host_path: &str) -> String {
        match self.io_type {
            IoType::File => {
                let ext = Path::new(host_path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                if ext.is_empty() || self.container.contains('.') {
                    self.container.clone()
                } else {
                    format!("{}.{}", self.container, ext)
                }
            }
            IoType::Dir => self.container.clone(),
        }
    }
}

impl Operator {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let s = std::fs::read_to_string(path)?;
        Self::from_json_str(&s)
    }

    /// Parse from JSON string (used for both file loading and registry manifest).
    pub fn from_json_str(s: &str) -> anyhow::Result<Self> {
        let raw: serde_json::Value = serde_json::from_str(s)?;
        let mut op: Self = serde_json::from_value(raw.clone())?;
        // If params array is absent, synthesize it from params_schema + params_bindings
        if op.params.is_empty() {
            op.params = synthesize_params(&raw);
        }
        Ok(op)
    }

    pub fn param(&self, id: &str) -> Option<&Param> {
        self.params.iter().find(|p| p.id == id)
    }

    pub fn input(&self, id: &str) -> Option<&Input> {
        self.inputs.iter().find(|i| i.id == id)
    }

    pub fn output(&self, id: &str) -> Option<&Output> {
        self.outputs.iter().find(|o| o.id == id)
    }
}

/// Build a Vec<Param> from params_schema (JSON Schema) + params_bindings (inject map).
/// This lets self-describe manifests omit the legacy `params` array.
fn synthesize_params(raw: &serde_json::Value) -> Vec<Param> {
    let bindings = match raw
        .get("params_bindings")
        .and_then(|v| v.as_object())
    {
        Some(b) => b,
        None => return Vec::new(),
    };
    let props = raw
        .get("params_schema")
        .and_then(|s| s.get("properties"))
        .and_then(|p| p.as_object());

    let mut params = Vec::new();
    for (key, binding_val) in bindings {
        let inject: InjectMode = match serde_json::from_value(binding_val.clone()) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let prop = props.and_then(|p| p.get(key));
        let default = prop
            .and_then(|p| p.get("default"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let label = prop
            .and_then(|p| p.get("title"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let description = prop
            .and_then(|p| p.get("description"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let values: Vec<String> = prop
            .and_then(|p| p.get("enum"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        // Infer ParamType from JSON Schema type + shape
        let param_type = match prop {
            Some(p) => {
                let typ = p.get("type").and_then(|v| v.as_str()).unwrap_or("string");
                match typ {
                    "number" | "integer" => {
                        if p.get("maxItems").and_then(|v| v.as_u64()) == Some(3) {
                            ParamType::NumberArray3
                        } else if p.get("maxItems").and_then(|v| v.as_u64()) == Some(7) {
                            // 7-element array: treat as string (serialised as JSON)
                            ParamType::String
                        } else {
                            ParamType::Number
                        }
                    }
                    "boolean" => ParamType::Bool,
                    "array" => ParamType::NumberArray3,
                    _ => {
                        if !values.is_empty() {
                            ParamType::Enum
                        } else {
                            ParamType::String
                        }
                    }
                }
            }
            None => ParamType::String,
        };

        params.push(Param {
            id: key.clone(),
            param_type,
            label,
            description,
            values,
            default,
            inject,
        });
    }
    params
}

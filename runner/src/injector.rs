use std::collections::HashMap;
use std::path::Path;

use crate::manifest::{InjectMode, Operator, ParamType};

/// Resolved values for a single operator step: actual host paths + param values.
pub struct StepContext<'a> {
    pub op: &'a Operator,
    /// input_id -> host path
    pub inputs: HashMap<String, String>,
    /// output_id -> host path
    pub outputs: HashMap<String, String>,
    /// param_id -> JSON value (overrides operator default)
    pub params: HashMap<String, serde_json::Value>,
    /// host path for the job-local config copy (rw, used for config_patch)
    pub job_config_dir: Option<String>,
}

impl<'a> StepContext<'a> {
    fn param_value(&self, id: &str) -> serde_json::Value {
        self.params
            .get(id)
            .cloned()
            .unwrap_or_else(|| {
                self.op
                    .param(id)
                    .map(|p| p.default.clone())
                    .unwrap_or(serde_json::Value::Null)
            })
    }

    /// Apply all config_patch / config_switch_suffix params to the job config copy.
    pub fn apply_config_patches(&self) -> anyhow::Result<()> {
        let config_dir = match &self.job_config_dir {
            Some(d) => d.clone(),
            None => return Ok(()),
        };

        for param in &self.op.params {
            let value = self.param_value(&param.id);
            match &param.inject {
                InjectMode::ConfigPatch { file, jsonpath } => {
                    let file_path = Path::new(&config_dir).join(file);
                    patch_json_file(&file_path, jsonpath, &value)?;
                }
                InjectMode::ConfigSwitchSuffix { file, parent, keys } => {
                    let suffix = match value.as_str() {
                        Some(s) => format!("_{}", s),
                        None => continue,
                    };
                    let file_path = Path::new(&config_dir).join(file);
                    switch_suffix_in_json(&file_path, parent.as_deref(), keys, &suffix)?;
                }
                InjectMode::ConfigRpyPatch { file, t_field, rpy_field } => {
                    let rpy: Vec<f64> = match value.as_array() {
                        Some(a) => a.iter().filter_map(|v| v.as_f64()).collect(),
                        None => continue,
                    };
                    if rpy.len() != 3 { continue; }
                    let file_path = Path::new(&config_dir).join(file);
                    apply_mounting_rpy(&file_path, t_field, rpy_field, rpy[0], rpy[1], rpy[2])?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Collect environment variables from `env` params.
    pub fn env_vars(&self) -> HashMap<String, String> {
        let mut env = HashMap::new();
        for param in &self.op.params {
            if let InjectMode::Env { var } = &param.inject {
                let v = self.param_value(&param.id);
                env.insert(var.clone(), json_to_cli_string(&v));
            }
        }
        env
    }

    /// Expand the operator command template into a full shell command string.
    pub fn expand_command(&self) -> anyhow::Result<String> {
        let mut cmd = self.op.command.clone();

        // Detect input extension for conditional injection
        let input_ext = self
            .inputs
            .values()
            .next()
            .and_then(|p| Path::new(p).extension())
            .and_then(|e| e.to_str())
            .map(|e| format!(".{}", e))
            .unwrap_or_default();

        // Replace {in:id} with effective container path (preserves file extension)
        for input in &self.op.inputs {
            let placeholder = format!("{{in:{}}}", input.id);
            let host = self.inputs.get(&input.id).map(|s| s.as_str()).unwrap_or("");
            let container = input.effective_container_path(host);
            cmd = cmd.replace(&placeholder, &container);
        }

        // Replace {out:id}
        for output in &self.op.outputs {
            let placeholder = format!("{{out:{}}}", output.id);
            cmd = cmd.replace(&placeholder, &output.container);
        }

        // Replace {param:id}
        for param in &self.op.params {
            let value = self.param_value(&param.id);
            match &param.inject {
                InjectMode::Arg { flag, condition } => {
                    let should_inject = match condition {
                        Some(cond) if cond.starts_with("input_ext=") => {
                            let ext = cond.trim_start_matches("input_ext=");
                            input_ext == ext
                        }
                        None => true,
                        _ => true,
                    };
                    let placeholder = format!("{{param:{}}}", param.id);
                    if should_inject {
                        let cli = param_to_cli(&param.param_type, flag, &value);
                        cmd = cmd.replace(&placeholder, &cli);
                    } else {
                        cmd = cmd.replace(&placeholder, "");
                    }
                }
                _ => {
                    let placeholder = format!("{{param:{}}}", param.id);
                    cmd = cmd.replace(&placeholder, "");
                }
            }
        }

        // Handle {?db3:...} conditional block
        let is_db3 = input_ext == ".db3";
        cmd = replace_conditional_block(&cmd, "db3", is_db3);

        // Handle {?remap:...}
        let has_remap = self.inputs.contains_key("remap");
        cmd = replace_conditional_block(&cmd, "remap", has_remap);

        let cmd = cmd.split_whitespace().collect::<Vec<_>>().join(" ");
        Ok(cmd)
    }
}

fn replace_conditional_block(cmd: &str, condition: &str, active: bool) -> String {
    let open = format!("{{?{}:", condition);
    let mut result = cmd.to_string();
    while let Some(start) = result.find(&open) {
        if let Some(end) = result[start..].find('}') {
            let block = &result[start + open.len()..start + end];
            let replacement = if active { block.to_string() } else { String::new() };
            result.replace_range(start..start + end + 1, &replacement);
        } else {
            break;
        }
    }
    result
}

fn param_to_cli(ptype: &ParamType, flag: &str, value: &serde_json::Value) -> String {
    match ptype {
        // Bool: expand to the flag itself (or empty). The command template puts {param:id} where the
        // flag should appear, e.g. `hera-convert ... {param:verbose}` → `-v` or ``
        ParamType::Bool => {
            if value.as_bool().unwrap_or(false) { flag.to_string() } else { String::new() }
        }
        // number[3]: space-separated values only. Flag is already in the template if needed.
        ParamType::NumberArray3 => {
            if let Some(arr) = value.as_array() {
                arr.iter().map(|v| json_to_cli_string(v)).collect::<Vec<_>>().join(" ")
            } else {
                String::new()
            }
        }
        // All other types: just the value. The command template already includes the flag, e.g.
        // `--window {param:window}` → `--window 0.1`
        _ => json_to_cli_string(value),
    }
}

fn json_to_cli_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

// ── JSONC handling ────────────────────────────────────────────────────────────

/// Strip `//` line comments and `/* */` block comments from a JSONC string,
/// preserving newlines so line numbers stay aligned.
fn strip_jsonc(s: &str) -> String {
    let bytes = s.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0;
    let mut in_string = false;

    while i < len {
        if in_string {
            if bytes[i] == b'\\' && i + 1 < len {
                out.push(bytes[i]);
                out.push(bytes[i + 1]);
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                in_string = false;
            }
            out.push(bytes[i]);
            i += 1;
        } else if bytes[i] == b'"' {
            in_string = true;
            out.push(bytes[i]);
            i += 1;
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            // Line comment: skip to \n (keep the \n)
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            // Block comment: skip to */; preserve \n for line numbers
            i += 2;
            while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                if bytes[i] == b'\n' {
                    out.push(b'\n');
                }
                i += 1;
            }
            if i + 1 < len {
                i += 2; // consume */
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn patch_json_file(path: &Path, jsonpath: &str, value: &serde_json::Value) -> anyhow::Result<()> {
    let raw = std::fs::read_to_string(path)?;
    let clean = strip_jsonc(&raw);
    let mut doc: serde_json::Value = serde_json::from_str(&clean)
        .map_err(|e| anyhow::anyhow!("Failed to parse {} after stripping comments: {}", path.display(), e))?;
    set_jsonpath(&mut doc, jsonpath, value.clone())?;
    let out = serde_json::to_string_pretty(&doc)?;
    std::fs::write(path, out)?;
    Ok(())
}

/// Minimal jsonpath setter: supports $.key and $.nested.key
fn set_jsonpath(
    doc: &mut serde_json::Value,
    jsonpath: &str,
    value: serde_json::Value,
) -> anyhow::Result<()> {
    let path = jsonpath.trim_start_matches("$.");
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = doc;
    for (i, part) in parts.iter().enumerate() {
        if i == parts.len() - 1 {
            if let Some(obj) = current.as_object_mut() {
                obj.insert(part.to_string(), value);
                return Ok(());
            }
        } else {
            current = current
                .as_object_mut()
                .and_then(|o| o.get_mut(*part))
                .ok_or_else(|| anyhow::anyhow!("jsonpath key not found: {}", part))?;
        }
    }
    Ok(())
}

// ── Mounting RPY handling ─────────────────────────────────────────────────────

/// Apply a mounting rotation (roll/pitch/yaw degrees, ZYX convention) on top of the
/// existing T_lidar_imu in `path`.  Writes back:
///   - T_lidar_imu = combined 7-element TUM [tx ty tz qx qy qz qw]
///   - `rpy_field`  = raw [roll, pitch, yaw] for human reference (GLIM ignores it)
fn apply_mounting_rpy(
    path: &Path,
    t_field: &str,
    rpy_field: &str,
    roll_deg: f64,
    pitch_deg: f64,
    yaw_deg: f64,
) -> anyhow::Result<()> {
    let raw = std::fs::read_to_string(path)?;
    let clean = strip_jsonc(&raw);
    let mut doc: serde_json::Value = serde_json::from_str(&clean)
        .map_err(|e| anyhow::anyhow!("Failed to parse {}: {}", path.display(), e))?;

    // Read current T_lidar_imu; default to identity if absent or malformed
    let current: Vec<f64> = get_jsonpath_array(&doc, t_field)
        .unwrap_or_else(|| vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]);

    let tx = current.get(0).copied().unwrap_or(0.0);
    let ty = current.get(1).copied().unwrap_or(0.0);
    let tz = current.get(2).copied().unwrap_or(0.0);
    // TUM quaternion order: qx qy qz qw
    let q_base = [
        current.get(3).copied().unwrap_or(0.0),
        current.get(4).copied().unwrap_or(0.0),
        current.get(5).copied().unwrap_or(0.0),
        current.get(6).copied().unwrap_or(1.0),
    ];

    // Convert RPY degrees (ZYX) → quaternion [qx qy qz qw]
    let q_mount = rpy_deg_to_quat(roll_deg, pitch_deg, yaw_deg);

    // Compose: q_effective = q_mount * q_base
    // (mounting rotation applied on top of base calibration)
    let q_eff = quat_mul(q_mount, q_base);

    let new_t = serde_json::json!([tx, ty, tz, q_eff[0], q_eff[1], q_eff[2], q_eff[3]]);
    let rpy_val = serde_json::json!([roll_deg, pitch_deg, yaw_deg]);

    set_jsonpath(&mut doc, t_field, new_t)?;
    set_jsonpath(&mut doc, rpy_field, rpy_val)?;

    std::fs::write(path, serde_json::to_string_pretty(&doc)?)?;
    Ok(())
}

/// ZYX Euler angles (degrees) → quaternion [qx, qy, qz, qw]
fn rpy_deg_to_quat(roll_deg: f64, pitch_deg: f64, yaw_deg: f64) -> [f64; 4] {
    let r = roll_deg.to_radians() / 2.0;
    let p = pitch_deg.to_radians() / 2.0;
    let y = yaw_deg.to_radians() / 2.0;

    let cr = r.cos(); let sr = r.sin();
    let cp = p.cos(); let sp = p.sin();
    let cy = y.cos(); let sy = y.sin();

    // ZYX: q = q_yaw * q_pitch * q_roll
    [
        sr * cp * cy - cr * sp * sy,  // qx
        cr * sp * cy + sr * cp * sy,  // qy
        cr * cp * sy - sr * sp * cy,  // qz
        cr * cp * cy + sr * sp * sy,  // qw
    ]
}

/// Quaternion multiply q1 * q2, both [qx, qy, qz, qw]
fn quat_mul(q1: [f64; 4], q2: [f64; 4]) -> [f64; 4] {
    let [x1, y1, z1, w1] = q1;
    let [x2, y2, z2, w2] = q2;
    [
        w1*x2 + x1*w2 + y1*z2 - z1*y2,
        w1*y2 - x1*z2 + y1*w2 + z1*x2,
        w1*z2 + x1*y2 - y1*x2 + z1*w2,
        w1*w2 - x1*x2 - y1*y2 - z1*z2,
    ]
}

/// Read a dot-separated JSONPath (e.g. "$.sensors.T_lidar_imu") and return it as Vec<f64>
fn get_jsonpath_array(doc: &serde_json::Value, jsonpath: &str) -> Option<Vec<f64>> {
    let path = jsonpath.trim_start_matches("$.");
    let mut cur = doc;
    for part in path.split('.') {
        cur = cur.as_object()?.get(part)?;
    }
    let arr = cur.as_array()?;
    let vals: Vec<f64> = arr.iter().filter_map(|v| v.as_f64()).collect();
    if vals.len() == arr.len() { Some(vals) } else { None }
}

/// Switch _cpu/_gpu suffix on specific keys inside a JSONC file.
/// `parent` optionally names an intermediate object key (e.g. "global").
fn switch_suffix_in_json(
    path: &Path,
    parent: Option<&str>,
    keys: &[String],
    suffix: &str,
) -> anyhow::Result<()> {
    let raw = std::fs::read_to_string(path)?;
    let clean = strip_jsonc(&raw);
    let mut doc: serde_json::Value = serde_json::from_str(&clean)
        .map_err(|e| anyhow::anyhow!("Failed to parse {} after stripping comments: {}", path.display(), e))?;

    let obj = if let Some(pk) = parent {
        doc.as_object_mut()
            .and_then(|o| o.get_mut(pk))
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| anyhow::anyhow!("parent key '{}' not found in {}", pk, path.display()))?
    } else {
        doc.as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("root of {} is not an object", path.display()))?
    };

    for key in keys {
        if let Some(val) = obj.get_mut(key) {
            if let Some(s) = val.as_str() {
                // Strip any existing _cpu / _gpu suffix before the .json extension
                let s = s.to_string();
                let base = s
                    .trim_end_matches(".json")
                    .trim_end_matches("_cpu")
                    .trim_end_matches("_gpu");
                *val = serde_json::Value::String(format!("{}{}.json", base, suffix));
            }
        }
    }

    let out = serde_json::to_string_pretty(&doc)?;
    std::fs::write(path, out)?;
    Ok(())
}

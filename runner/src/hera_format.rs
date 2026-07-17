//! Parser for the `.hera` binary sensor recording file header.
//!
//! Mirrors `hera-sdk-python`'s `hera/_format.py::_read_header`. Only the
//! fixed-size header + device table + (V4) extra_info JSON blob are read —
//! packet data is never touched, so this is cheap even for multi-GB files.
//!
//! Wire format:
//!   V3: [16-byte magic] [variable-length header] [packets...]
//!   V4: [16-byte magic] [header within 4 MiB reserved region] [packets at 4 MiB offset...]

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use serde::Serialize;

const MAGIC_V3: &[u8; 16] = b"HERA_STORAGE_V3\0";
const MAGIC_V4: &[u8; 16] = b"HERA_STORAGE_V4\0";

/// V4: packet data starts after this reserved header region.
const RESERVED_LENGTH: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    pub id: usize,
    pub name: String,
    pub message_count: u32,
    pub data_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HeraFileHeader {
    pub version: u8,
    pub timestamp_start_ns: u64,
    pub timestamp_end_ns: u64,
    pub devices: Vec<DeviceInfo>,
    pub extra_info: serde_json::Value,
    pub data_offset: u64,
}

fn read_u32(f: &mut File) -> io::Result<u32> {
    let mut buf = [0u8; 4];
    f.read_exact(&mut buf)?;
    Ok(u32::from_le_bytes(buf))
}

fn read_u64(f: &mut File) -> io::Result<u64> {
    let mut buf = [0u8; 8];
    f.read_exact(&mut buf)?;
    Ok(u64::from_le_bytes(buf))
}

/// Read and parse the header of a `.hera` file.
pub fn read_header(path: &Path) -> anyhow::Result<HeraFileHeader> {
    let mut f = File::open(path)?;

    let mut magic = [0u8; 16];
    f.read_exact(&mut magic)?;
    let version = if &magic == MAGIC_V3 {
        3u8
    } else if &magic == MAGIC_V4 {
        4u8
    } else {
        anyhow::bail!("not a .hera file (unexpected magic: {:?})", magic);
    };

    let timestamp_start_ns = read_u64(&mut f)?;
    let timestamp_end_ns = read_u64(&mut f)?;
    let device_num = read_u32(&mut f)? as usize;

    let mut msg_nums = Vec::with_capacity(device_num);
    for _ in 0..device_num {
        msg_nums.push(read_u32(&mut f)?);
    }

    let mut data_sizes = Vec::with_capacity(device_num);
    for _ in 0..device_num {
        data_sizes.push(read_u64(&mut f)?);
    }

    let mut names = Vec::with_capacity(device_num);
    for _ in 0..device_num {
        let n_len = read_u32(&mut f)? as usize;
        let mut buf = vec![0u8; n_len];
        f.read_exact(&mut buf)?;
        names.push(String::from_utf8_lossy(&buf).into_owned());
    }

    let mut extra_info = serde_json::Value::Null;
    let data_offset;
    if version == 4 {
        let extra_size = read_u32(&mut f)? as usize;
        if extra_size > 0 {
            let mut raw = vec![0u8; extra_size];
            f.read_exact(&mut raw)?;
            extra_info = serde_json::from_slice(&raw).unwrap_or(serde_json::Value::Null);
        }
        data_offset = RESERVED_LENGTH;
    } else {
        data_offset = {
            use std::io::Seek;
            f.stream_position()?
        };
    }

    let devices = (0..device_num)
        .map(|i| DeviceInfo {
            id: i,
            name: names[i].clone(),
            message_count: msg_nums[i],
            data_bytes: data_sizes[i],
        })
        .collect();

    Ok(HeraFileHeader {
        version,
        timestamp_start_ns,
        timestamp_end_ns,
        devices,
        extra_info,
        data_offset,
    })
}

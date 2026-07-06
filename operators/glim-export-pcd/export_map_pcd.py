#!/usr/bin/env python3
"""
Export a glim_offline map to a single PCD/PLY/CSV point cloud.

Usage:
  python3 export_map_pcd.py <map_dir> [-o output.ply] [--format ply|pcd|csv]
  python3 export_map_pcd.py /home/fred/Data/results_db3/map -o /tmp/map.ply
  python3 export_map_pcd.py /home/fred/Data/results_db3/map -o /tmp/map.pcd --format pcd

The glim map format:
  <map_dir>/
    000000/
      data.txt          -- T_world_origin (3x4 submap→world pose)
      points_compact.bin  -- float32 4*N (x,y,z,w columns), points in submap frame
      intensities_compact.bin  -- float32 N
    000001/ ...
"""

import argparse
import glob
import struct
import os
import re
import sys

import numpy as np


def read_T_world_origin(data_txt: str) -> np.ndarray:
    """Parse T_world_origin from data.txt.  Returns 4x4 homogeneous matrix."""
    with open(data_txt) as f:
        lines = f.readlines()

    # Find the line with "T_world_origin:" and read the next 4 rows
    for i, line in enumerate(lines):
        if line.strip().startswith("T_world_origin:"):
            rows = []
            for j in range(i + 1, min(i + 6, len(lines))):
                vals = list(map(float, lines[j].split()))
                if len(vals) == 4:
                    rows.append(vals)
                if len(rows) == 4:
                    break
            if len(rows) == 4:
                return np.array(rows)
            elif len(rows) == 3:
                T = np.eye(4)
                T[:3, :] = np.array(rows)
                return T

    raise ValueError(f"T_world_origin not found in {data_txt}")


def read_points_compact(bin_path: str) -> np.ndarray:
    """Read points_compact.bin → (N, 3) float32 array.
    gtsam_points PointCloudCPU::save_compact writes 3 float32 per point (x, y, z),
    NOT 4 — the homogeneous w component is dropped at save time.
    """
    data = np.fromfile(bin_path, dtype=np.float32)
    n_total = data.size
    if n_total % 3 != 0:
        raise ValueError(f"points_compact.bin has {n_total} floats (not divisible by 3)")
    N = n_total // 3
    return data.reshape(N, 3)


def read_intensities(bin_path: str, N: int) -> np.ndarray:
    """Read intensities_compact.bin → (N,) float32 array, or zeros on failure."""
    try:
        data = np.fromfile(bin_path, dtype=np.float32)
        if data.size == N:
            return data
    except Exception:
        pass
    return np.zeros(N, dtype=np.float32)


def collect_submaps(map_dir: str):
    """Yield (T_world_origin, points_local, intensities) for each submap."""
    dirs = sorted(glob.glob(os.path.join(map_dir, "[0-9]*")))
    if not dirs:
        sys.exit(f"No submap directories found in {map_dir}")

    for d in dirs:
        data_txt = os.path.join(d, "data.txt")
        pts_bin  = os.path.join(d, "points_compact.bin")
        int_bin  = os.path.join(d, "intensities_compact.bin")

        if not os.path.exists(pts_bin):
            print(f"  skip {d}: no points_compact.bin")
            continue

        T = read_T_world_origin(data_txt)
        pts = read_points_compact(pts_bin)
        ints = read_intensities(int_bin, len(pts))
        yield T, pts, ints


def transform_points(T: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Apply 4x4 transform T to (N,3) points → (N,3)."""
    pts_h = np.hstack([pts, np.ones((len(pts), 1), dtype=np.float32)])  # (N,4)
    return (T @ pts_h.T).T[:, :3]


def export_ply(path: str, xyz: np.ndarray, intensity: np.ndarray) -> None:
    N = len(xyz)
    with open(path, "wb") as f:
        header = (
            "ply\n"
            "format binary_little_endian 1.0\n"
            f"element vertex {N}\n"
            "property float x\n"
            "property float y\n"
            "property float z\n"
            "property float intensity\n"
            "end_header\n"
        )
        f.write(header.encode())
        data = np.hstack([xyz.astype(np.float32), intensity.reshape(-1, 1).astype(np.float32)])
        f.write(data.tobytes())
    print(f"Saved PLY: {path}  ({N:,} points)")


def export_pcd(path: str, xyz: np.ndarray, intensity: np.ndarray) -> None:
    N = len(xyz)
    with open(path, "wb") as f:
        header = (
            "# .PCD v0.7 - Point Cloud Data\n"
            "VERSION 0.7\n"
            "FIELDS x y z intensity\n"
            "SIZE 4 4 4 4\n"
            "TYPE F F F F\n"
            "COUNT 1 1 1 1\n"
            f"WIDTH {N}\n"
            "HEIGHT 1\n"
            "VIEWPOINT 0 0 0 1 0 0 0\n"
            f"POINTS {N}\n"
            "DATA binary\n"
        )
        f.write(header.encode())
        data = np.hstack([xyz.astype(np.float32), intensity.reshape(-1, 1).astype(np.float32)])
        f.write(data.tobytes())
    print(f"Saved PCD: {path}  ({N:,} points)")


def export_csv(path: str, xyz: np.ndarray, intensity: np.ndarray) -> None:
    N = len(xyz)
    combined = np.hstack([xyz.astype(np.float32), intensity.reshape(-1, 1).astype(np.float32)])
    np.savetxt(path, combined, delimiter=",", header="x,y,z,intensity", comments="", fmt="%.4f")
    print(f"Saved CSV: {path}  ({N:,} points)")


def main():
    ap = argparse.ArgumentParser(description="Export glim map to point cloud file")
    ap.add_argument("map_dir", help="Path to glim map output directory")
    ap.add_argument("-o", "--output", default="map_export.ply",
                    help="Output file path (default: map_export.ply)")
    ap.add_argument("--format", choices=["ply", "pcd", "csv"], default=None,
                    help="Output format (inferred from -o extension if not set)")
    args = ap.parse_args()

    fmt = args.format
    if fmt is None:
        ext = os.path.splitext(args.output)[1].lower()
        fmt = {"ply": "ply", ".ply": "ply", ".pcd": "pcd", ".csv": "csv"}.get(ext, "ply")

    print(f"Reading map from: {args.map_dir}")
    all_xyz = []
    all_int = []
    for T, pts_local, ints in collect_submaps(args.map_dir):
        pts_world = transform_points(T, pts_local)
        all_xyz.append(pts_world)
        all_int.append(ints)
        print(f"  submap: {len(pts_local):,} pts  →  world frame accumulated {sum(len(x) for x in all_xyz):,} pts")

    if not all_xyz:
        sys.exit("No points found.")

    xyz = np.vstack(all_xyz).astype(np.float32)
    intensity = np.concatenate(all_int).astype(np.float32)
    print(f"Total: {len(xyz):,} points across {len(all_xyz)} submaps")

    if fmt == "ply":
        export_ply(args.output, xyz, intensity)
    elif fmt == "pcd":
        export_pcd(args.output, xyz, intensity)
    elif fmt == "csv":
        export_csv(args.output, xyz, intensity)


if __name__ == "__main__":
    main()

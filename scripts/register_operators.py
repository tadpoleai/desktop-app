#!/usr/bin/env python3
"""Register all three Hera operators into the local SQLite registry.

Usage:
    python3 scripts/register_operators.py [db_path]

Default db_path: ~/.local/share/hera-desktop/registry.sqlite
"""
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone

OPERATORS = [
    ("hera-glim-recon:r0.5",    "registry"),
    ("hera-hera-convert:latest", "registry"),
    ("hera-export-pcd:local",    "local"),
]

DB = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
    "~/.local/share/hera-desktop/registry.sqlite"
)
DOCKER = os.environ.get("DOCKER", "docker")


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS operator_versions (
            id            TEXT NOT NULL,
            version       TEXT NOT NULL,
            image_ref     TEXT NOT NULL,
            image_digest  TEXT NOT NULL,
            manifest_json TEXT NOT NULL,
            source        TEXT NOT NULL,
            added_at      TEXT NOT NULL,
            PRIMARY KEY (id, version)
        );
        CREATE TABLE IF NOT EXISTS step_provenance (
            job_id        TEXT NOT NULL,
            step          TEXT NOT NULL,
            operator_id   TEXT NOT NULL,
            version       TEXT NOT NULL,
            image_ref     TEXT NOT NULL,
            image_digest  TEXT NOT NULL,
            params_json   TEXT NOT NULL,
            PRIMARY KEY (job_id, step)
        );
    """)
    conn.commit()


def register(conn: sqlite3.Connection, image_ref: str, source: str) -> bool:
    print(f"\n--- Registering: {image_ref} ---")

    # --describe
    try:
        out = subprocess.check_output(
            [DOCKER, "run", "--rm", image_ref, "--describe"],
            stderr=subprocess.DEVNULL,
            timeout=60,
        )
    except subprocess.CalledProcessError as e:
        print(f"  SKIP: --describe failed (exit {e.returncode})")
        return False
    except Exception as e:
        print(f"  SKIP: {e}")
        return False

    try:
        manifest = json.loads(out)
    except json.JSONDecodeError as e:
        print(f"  SKIP: manifest JSON parse error: {e}")
        return False

    op_id = manifest.get("id")
    op_version = manifest.get("version")
    if not op_id or not op_version:
        print("  SKIP: manifest missing 'id' or 'version'")
        return False

    # digest
    try:
        digest = subprocess.check_output(
            [DOCKER, "inspect", "--format", "{{.Id}}", image_ref],
            stderr=subprocess.DEVNULL,
            timeout=10,
        ).decode().strip()
    except Exception:
        digest = "unknown"

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn.execute("""
        INSERT INTO operator_versions (id, version, image_ref, image_digest, manifest_json, source, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, version) DO UPDATE SET
            image_ref=excluded.image_ref, image_digest=excluded.image_digest,
            manifest_json=excluded.manifest_json, source=excluded.source, added_at=excluded.added_at
    """, (op_id, op_version, image_ref, digest, json.dumps(manifest, ensure_ascii=False), source, now))
    conn.commit()
    print(f"  OK: {op_id}@{op_version}  digest={digest[:19]}…")
    return True


def main() -> None:
    print(f"=== Hera Operator Registration ===")
    print(f"DB: {DB}")
    os.makedirs(os.path.dirname(os.path.abspath(DB)), exist_ok=True)
    conn = sqlite3.connect(DB)
    ensure_schema(conn)

    for image_ref, source in OPERATORS:
        try:
            register(conn, image_ref, source)
        except Exception as e:
            print(f"  ERROR: {e}")

    print("\n=== Registered operators ===")
    rows = conn.execute(
        "SELECT id, version, image_ref, source, added_at FROM operator_versions ORDER BY id, added_at"
    ).fetchall()
    for r in rows:
        print(f"  {r[0]}@{r[1]}  [{r[3]}]  {r[2]}  {r[4]}")
    if not rows:
        print("  (empty)")

    conn.close()


if __name__ == "__main__":
    main()

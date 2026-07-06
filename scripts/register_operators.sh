#!/bin/bash
# Register all three operators into the Hera SQLite registry via the hera-run CLI.
# Usage: bash scripts/register_operators.sh [db_path]
# Default db_path: ~/.local/share/hera-desktop/registry.sqlite
set -euo pipefail

DB="${1:-$HOME/.local/share/hera-desktop/registry.sqlite}"
DOCKER="${DOCKER:-docker}"
WORKSPACE="$(cd "$(dirname "$0")/.." && pwd)"

register_operator() {
    local image_ref="$1"
    local source="${2:-registry}"
    echo ""
    echo "--- Registering: $image_ref ---"

    # Run --describe
    local manifest
    manifest="$($DOCKER run --rm "$image_ref" --describe 2>/dev/null)" || {
        echo "  SKIP: --describe failed for $image_ref"
        return 1
    }

    local op_id op_version
    op_id="$(echo "$manifest" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['id'])")"
    op_version="$(echo "$manifest" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['version'])")"

    # Get image digest
    local digest
    digest="$($DOCKER inspect --format '{{.Id}}' "$image_ref" 2>/dev/null || echo 'unknown')"

    # Insert into SQLite
    local now
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    local manifest_escaped
    manifest_escaped="${manifest//\'/\'\'}"

    python3 - <<PYEOF
import sqlite3, sys, json, os

db = os.path.expanduser("$DB")
os.makedirs(os.path.dirname(db), exist_ok=True)
conn = sqlite3.connect(db)
conn.execute("""
    CREATE TABLE IF NOT EXISTS operator_versions (
        id            TEXT NOT NULL,
        version       TEXT NOT NULL,
        image_ref     TEXT NOT NULL,
        image_digest  TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        source        TEXT NOT NULL,
        added_at      TEXT NOT NULL,
        PRIMARY KEY (id, version)
    )
""")
manifest_json = """$manifest"""
conn.execute("""
    INSERT INTO operator_versions (id, version, image_ref, image_digest, manifest_json, source, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, version) DO UPDATE SET
        image_ref=excluded.image_ref, image_digest=excluded.image_digest,
        manifest_json=excluded.manifest_json, source=excluded.source, added_at=excluded.added_at
""", ("$op_id", "$op_version", "$image_ref", "$digest", manifest_json, "$source", "$now"))
conn.commit()
conn.close()
print(f"  OK: registered {\"$op_id\"}@{\"$op_version\"}")
PYEOF
}

echo "=== Hera Operator Registration ==="
echo "DB: $DB"

register_operator "hera-glim-recon:r0.5"      "registry" || true
register_operator "hera-hera-convert:latest"   "registry" || true
register_operator "hera-export-pcd:local"      "local"    || true

echo ""
echo "=== Registered operators ==="
python3 - <<PYEOF
import sqlite3, os, json
db = os.path.expanduser("$DB")
if not os.path.exists(db):
    print("  (database not found)")
    exit()
conn = sqlite3.connect(db)
try:
    rows = conn.execute("SELECT id, version, image_ref, source, added_at FROM operator_versions ORDER BY id, added_at").fetchall()
    for r in rows:
        print(f"  {r[0]}@{r[1]}  [{r[3]}]  {r[2]}  {r[4]}")
    if not rows:
        print("  (empty)")
except Exception as e:
    print(f"  Error: {e}")
conn.close()
PYEOF

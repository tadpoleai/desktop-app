use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

pub struct Registry {
    conn: Connection,
}

impl Registry {
    pub fn open(db_path: &Path) -> Result<Self> {
        let conn = Connection::open(db_path)?;
        let reg = Self { conn };
        reg.init()?;
        Ok(reg)
    }

    fn init(&self) -> Result<()> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS datasets (
                id          TEXT PRIMARY KEY,
                path        TEXT NOT NULL UNIQUE,
                file_type   TEXT NOT NULL,
                size_bytes  INTEGER,
                meta_json   TEXT,
                indexed_at  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
                id          TEXT PRIMARY KEY,
                workflow_id TEXT NOT NULL,
                input_path  TEXT NOT NULL,
                params_json TEXT,
                status      TEXT NOT NULL,
                started_at  TEXT NOT NULL,
                finished_at TEXT
            );
            CREATE TABLE IF NOT EXISTS artifacts (
                id          TEXT PRIMARY KEY,
                job_id      TEXT NOT NULL,
                step        TEXT NOT NULL,
                output_id   TEXT NOT NULL,
                host_path   TEXT NOT NULL,
                FOREIGN KEY(job_id) REFERENCES jobs(id)
            );
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
            ",
        )?;
        Ok(())
    }

    /// Resolve operator manifest from the registry.
    /// version="latest" → picks the most-recently-added version for that id.
    /// Returns (manifest_json, image_ref, image_digest, resolved_version).
    pub fn resolve_operator(
        &self,
        id: &str,
        version: &str,
    ) -> Result<Option<(String, String, String, String)>> {
        let sql = if version == "latest" {
            "SELECT manifest_json, image_ref, image_digest, version
             FROM operator_versions WHERE id=?1
             ORDER BY added_at DESC LIMIT 1"
        } else {
            "SELECT manifest_json, image_ref, image_digest, version
             FROM operator_versions WHERE id=?1 AND version=?2
             LIMIT 1"
        };

        let mut stmt = self.conn.prepare(sql)?;
        let result = if version == "latest" {
            stmt.query_row(params![id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
        } else {
            stmt.query_row(params![id, version], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
        }
        .optional()?;

        Ok(result)
    }

    pub fn record_step_provenance(
        &self,
        job_id: &str,
        step: &str,
        operator_id: &str,
        version: &str,
        image_ref: &str,
        image_digest: &str,
        params_json: &str,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO step_provenance
             (job_id, step, operator_id, version, image_ref, image_digest, params_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![job_id, step, operator_id, version, image_ref, image_digest, params_json],
        )?;
        Ok(())
    }

    pub fn job_provenance(&self, job_id: &str) -> Result<Vec<StepProvenanceRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT job_id, step, operator_id, version, image_ref, image_digest, params_json
             FROM step_provenance WHERE job_id=?1 ORDER BY step",
        )?;
        let rows = stmt.query_map(params![job_id], |row| {
            Ok(StepProvenanceRow {
                job_id: row.get(0)?,
                step: row.get(1)?,
                operator_id: row.get(2)?,
                version: row.get(3)?,
                image_ref: row.get(4)?,
                image_digest: row.get(5)?,
                params_json: row.get(6)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn operator_register(
        &self,
        id: &str,
        version: &str,
        image_ref: &str,
        image_digest: &str,
        manifest_json: &str,
        source: &str,
    ) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO operator_versions (id, version, image_ref, image_digest, manifest_json, source, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id, version) DO UPDATE SET
               image_ref=excluded.image_ref, image_digest=excluded.image_digest,
               manifest_json=excluded.manifest_json, source=excluded.source,
               added_at=excluded.added_at",
            params![id, version, image_ref, image_digest, manifest_json, source, now],
        )?;
        Ok(())
    }

    pub fn operator_list(&self) -> Result<Vec<OperatorSummaryRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, version, image_ref, image_digest, source, added_at
             FROM operator_versions ORDER BY id, added_at DESC",
        )?;
        let rows: Vec<OperatorVersionRow> = stmt
            .query_map([], |row| {
                Ok(OperatorVersionRow {
                    id: row.get(0)?,
                    version: row.get(1)?,
                    image_ref: row.get(2)?,
                    image_digest: row.get(3)?,
                    source: row.get(4)?,
                    added_at: row.get(5)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut map: std::collections::HashMap<String, OperatorSummaryRow> =
            std::collections::HashMap::new();
        for row in rows {
            let entry = map.entry(row.id.clone()).or_insert_with(|| OperatorSummaryRow {
                id: row.id.clone(),
                versions: Vec::new(),
            });
            entry.versions.push(row);
        }
        let mut result: Vec<OperatorSummaryRow> = map.into_values().collect();
        result.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(result)
    }

    pub fn operator_describe(&self, id: &str, version: &str) -> Result<Option<serde_json::Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT manifest_json FROM operator_versions WHERE id=?1 AND version=?2",
        )?;
        let result = stmt
            .query_row(params![id, version], |row| row.get::<_, String>(0))
            .optional()?;
        match result {
            Some(json) => Ok(Some(serde_json::from_str(&json)?)),
            None => Ok(None),
        }
    }

    pub fn operator_remove(&self, id: &str, version: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM operator_versions WHERE id=?1 AND version=?2",
            params![id, version],
        )?;
        Ok(())
    }

    pub fn upsert_dataset(&self, path: &str, file_type: &str, size: u64, meta: Option<&str>) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO datasets (id, path, file_type, size_bytes, meta_json, indexed_at)
             VALUES (lower(hex(randomblob(8))), ?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET file_type=excluded.file_type,
               size_bytes=excluded.size_bytes, meta_json=excluded.meta_json,
               indexed_at=excluded.indexed_at",
            params![path, file_type, size as i64, meta, now],
        )?;
        Ok(())
    }

    pub fn start_job(&self, id: &str, workflow_id: &str, input_path: &str, params_json: &str) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO jobs (id, workflow_id, input_path, params_json, status, started_at)
             VALUES (?1, ?2, ?3, ?4, 'running', ?5)",
            params![id, workflow_id, input_path, params_json, now],
        )?;
        Ok(())
    }

    pub fn finish_job(&self, id: &str, success: bool) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let status = if success { "success" } else { "failed" };
        self.conn.execute(
            "UPDATE jobs SET status=?1, finished_at=?2 WHERE id=?3",
            params![status, now, id],
        )?;
        Ok(())
    }

    pub fn insert_artifact(&self, id: &str, job_id: &str, step: &str, output_id: &str, host_path: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO artifacts (id, job_id, step, output_id, host_path) VALUES (?1,?2,?3,?4,?5)",
            params![id, job_id, step, output_id, host_path],
        )?;
        Ok(())
    }

    pub fn list_datasets(&self) -> Result<Vec<DatasetRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, file_type, size_bytes, meta_json, indexed_at FROM datasets ORDER BY indexed_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(DatasetRow {
                id: row.get(0)?,
                path: row.get(1)?,
                file_type: row.get(2)?,
                size_bytes: row.get(3)?,
                meta_json: row.get(4)?,
                indexed_at: row.get(5)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn list_jobs(&self) -> Result<Vec<JobRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workflow_id, input_path, params_json, status, started_at, finished_at
             FROM jobs ORDER BY started_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(JobRow {
                id: row.get(0)?,
                workflow_id: row.get(1)?,
                input_path: row.get(2)?,
                params_json: row.get(3)?,
                status: row.get(4)?,
                started_at: row.get(5)?,
                finished_at: row.get(6)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn job_artifacts(&self, job_id: &str) -> Result<Vec<ArtifactRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, job_id, step, output_id, host_path FROM artifacts WHERE job_id=?1",
        )?;
        let rows = stmt.query_map(params![job_id], |row| {
            Ok(ArtifactRow {
                id: row.get(0)?,
                job_id: row.get(1)?,
                step: row.get(2)?,
                output_id: row.get(3)?,
                host_path: row.get(4)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

#[derive(Debug, serde::Serialize)]
pub struct DatasetRow {
    pub id: String,
    pub path: String,
    pub file_type: String,
    pub size_bytes: Option<i64>,
    pub meta_json: Option<String>,
    pub indexed_at: String,
}

#[derive(Debug, serde::Serialize)]
pub struct JobRow {
    pub id: String,
    pub workflow_id: String,
    pub input_path: String,
    pub params_json: Option<String>,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct ArtifactRow {
    pub id: String,
    pub job_id: String,
    pub step: String,
    pub output_id: String,
    pub host_path: String,
}

#[derive(Debug, serde::Serialize)]
pub struct OperatorVersionRow {
    pub id: String,
    pub version: String,
    pub image_ref: String,
    pub image_digest: String,
    pub source: String,
    pub added_at: String,
}

#[derive(Debug, serde::Serialize)]
pub struct OperatorSummaryRow {
    pub id: String,
    pub versions: Vec<OperatorVersionRow>,
}

#[derive(Debug, serde::Serialize)]
pub struct StepProvenanceRow {
    pub job_id: String,
    pub step: String,
    pub operator_id: String,
    pub version: String,
    pub image_ref: String,
    pub image_digest: String,
    pub params_json: String,
}

//! Durable plan, approval and job ledger. A model cannot grant approval.

use crate::{plan, OutputFormat, Plan, SourceDescriptor, TaskSpec, TileScheme};
use chrono::{DateTime, Utc};
use geod_core::imagery::{self, HttpSource, ImageryRequest, Manifest};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};
use uuid::Uuid;

const DB_VERSION: i64 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerError {
    pub code: &'static str,
    pub message: String,
}

impl LedgerError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for LedgerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for LedgerError {}

impl From<rusqlite::Error> for LedgerError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new("STORAGE_ERROR", error.to_string())
    }
}

impl From<serde_json::Error> for LedgerError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("STORAGE_ERROR", error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredPlan {
    pub plan_id: String,
    pub plan: Plan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub approval_id: String,
    pub plan_id: String,
    pub plan_hash: String,
    pub actor: String,
    pub confirmation_ui_version: String,
    pub approved_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisteredSource {
    pub descriptor: SourceDescriptor,
    pub endpoint: HttpSource,
    pub permission_confirmed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Downloading,
    Paused,
    Processing,
    Verifying,
    Completed,
    Partial,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    pub job_id: String,
    pub plan_id: String,
    pub approval_id: String,
    pub plan_hash: String,
    pub idempotency_key: String,
    pub state: JobState,
    pub version: u64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobEvent {
    pub job_id: String,
    pub seq: u64,
    pub occurred_at: DateTime<Utc>,
    pub state: JobState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_tiles: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tiles: Option<u64>,
}

pub struct TaskStore {
    conn: Connection,
    db_path: PathBuf,
}

impl TaskStore {
    pub fn open(path: &Path) -> Result<Self, LedgerError> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > DB_VERSION {
            return Err(LedgerError::new(
                "STORAGE_VERSION_NEWER",
                "A newer GeoD Agent database requires an app update",
            ));
        }
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        if version == 0 {
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE plans (
                   plan_id TEXT PRIMARY KEY,
                   plan_hash TEXT NOT NULL,
                   body TEXT NOT NULL
                 );
                 CREATE TABLE approvals (
                   approval_id TEXT PRIMARY KEY,
                   plan_id TEXT NOT NULL REFERENCES plans(plan_id),
                   plan_hash TEXT NOT NULL,
                   actor TEXT NOT NULL,
                   confirmation_ui_version TEXT NOT NULL,
                   approved_at TEXT NOT NULL
                 );
                 CREATE TABLE jobs (
                   job_id TEXT PRIMARY KEY,
                   plan_id TEXT NOT NULL REFERENCES plans(plan_id),
                   approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(approval_id),
                   plan_hash TEXT NOT NULL,
                   idempotency_key TEXT NOT NULL UNIQUE,
                   state TEXT NOT NULL,
                   version INTEGER NOT NULL,
                   created_at TEXT NOT NULL
                 );
                 CREATE TABLE job_events (
                   job_id TEXT NOT NULL REFERENCES jobs(job_id),
                   seq INTEGER NOT NULL,
                   body TEXT NOT NULL,
                   PRIMARY KEY(job_id, seq)
                 );
                 CREATE TABLE sources (
                   source_id TEXT PRIMARY KEY,
                   body TEXT NOT NULL
                 );
                 PRAGMA user_version=2;
                 COMMIT;",
            )?;
        } else if version == 1 {
            let backup = path.with_extension(format!("pre-v2-{}.sqlite", Uuid::new_v4()));
            conn.execute("VACUUM INTO ?1", [backup.to_string_lossy().as_ref()])?;
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE sources (source_id TEXT PRIMARY KEY, body TEXT NOT NULL);
                 PRAGMA user_version=2;
                 COMMIT;",
            )?;
        }
        let db_path = std::fs::canonicalize(path)
            .map_err(|error| LedgerError::new("STORAGE_ERROR", error.to_string()))?;
        Ok(Self { conn, db_path })
    }

    /// Register a credential-free tile source after an explicit user license
    /// acknowledgement. Keep this command outside the model tool set.
    pub fn save_source(
        &mut self,
        endpoint: HttpSource,
        min_zoom: u8,
        max_zoom: u8,
        permission_acknowledged: bool,
        now: DateTime<Utc>,
    ) -> Result<SourceDescriptor, LedgerError> {
        if !permission_acknowledged {
            return Err(LedgerError::new(
                "SOURCE_UNAUTHORIZED",
                "Confirm source license and bulk download permission",
            ));
        }
        endpoint
            .validate()
            .map_err(|e| LedgerError::new(e.code, e.message))?;
        if endpoint.id.len() > 160
            || !endpoint
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            || min_zoom > max_zoom
            || max_zoom > geod_core::tile::MAX_ZOOM
            || endpoint.min_interval_ms > 60_000
        {
            return Err(LedgerError::new(
                "INVALID_SOURCE",
                "Invalid source ID, zoom range, or request interval",
            ));
        }
        let descriptor = SourceDescriptor {
            schema_version: crate::SchemaVersion::V0_1,
            id: endpoint.id.clone(),
            display_name: endpoint.name.clone(),
            attribution: endpoint.attribution.clone(),
            license: endpoint.license.clone(),
            bulk_download_allowed: true,
            scheme: match endpoint.scheme {
                imagery::TileScheme::XYZ => TileScheme::XYZ,
                imagery::TileScheme::TMS => TileScheme::TMS,
            },
            tile_size: endpoint.tile_size,
            min_zoom,
            max_zoom,
            config_revision: endpoint.configuration_revision(),
            credential_ref_version: None,
        };
        let entry = RegisteredSource {
            descriptor: descriptor.clone(),
            endpoint,
            permission_confirmed_at: now,
        };
        self.conn.execute(
            "INSERT INTO sources(source_id, body) VALUES (?1, ?2)
             ON CONFLICT(source_id) DO UPDATE SET body=excluded.body",
            params![descriptor.id, serde_json::to_string(&entry)?],
        )?;
        Ok(descriptor)
    }

    pub fn list_sources(&self) -> Result<Vec<SourceDescriptor>, LedgerError> {
        let mut statement = self
            .conn
            .prepare("SELECT body FROM sources ORDER BY source_id")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let entry: RegisteredSource = serde_json::from_str(&row?)?;
            Ok(entry.descriptor)
        })
        .collect()
    }

    pub fn get_registered_source(
        &self,
        source_id: &str,
    ) -> Result<Option<RegisteredSource>, LedgerError> {
        self.conn
            .query_row(
                "SELECT body FROM sources WHERE source_id=?1",
                [source_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|body| serde_json::from_str(&body).map_err(Into::into))
            .transpose()
    }

    pub fn create_plan(
        &mut self,
        spec: TaskSpec,
        source: &SourceDescriptor,
        now: DateTime<Utc>,
    ) -> Result<StoredPlan, LedgerError> {
        let plan = plan(spec, source, now).map_err(|e| LedgerError::new(e.code, e.message))?;
        let stored = StoredPlan {
            plan_id: Uuid::new_v4().to_string(),
            plan,
        };
        self.conn.execute(
            "INSERT INTO plans(plan_id, plan_hash, body) VALUES (?1, ?2, ?3)",
            params![
                stored.plan_id,
                stored.plan.plan_hash,
                serde_json::to_string(&stored.plan)?
            ],
        )?;
        Ok(stored)
    }

    pub fn get_plan(&self, plan_id: &str) -> Result<Option<StoredPlan>, LedgerError> {
        self.conn
            .query_row(
                "SELECT body FROM plans WHERE plan_id=?1",
                [plan_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|body| {
                Ok(StoredPlan {
                    plan_id: plan_id.into(),
                    plan: serde_json::from_str(&body)?,
                })
            })
            .transpose()
    }

    /// Call only from a user-initiated confirmation UI, never from model tools.
    pub fn grant_approval(
        &mut self,
        plan_id: &str,
        plan_hash: &str,
        actor: &str,
        confirmation_ui_version: &str,
        now: DateTime<Utc>,
    ) -> Result<Approval, LedgerError> {
        if actor.trim().is_empty() || confirmation_ui_version.trim().is_empty() {
            return Err(LedgerError::new(
                "APPROVAL_REQUIRED",
                "A confirmed local user and UI version are required",
            ));
        }
        let stored = self
            .get_plan(plan_id)?
            .ok_or_else(|| LedgerError::new("PLAN_NOT_FOUND", "Plan was not found"))?;
        if stored.plan.plan_hash != plan_hash || now >= stored.plan.expires_at {
            return Err(LedgerError::new(
                "PLAN_STALE",
                "The plan changed or expired; review it again",
            ));
        }
        let approval = Approval {
            approval_id: Uuid::new_v4().to_string(),
            plan_id: plan_id.into(),
            plan_hash: plan_hash.into(),
            actor: actor.into(),
            confirmation_ui_version: confirmation_ui_version.into(),
            approved_at: now,
        };
        self.conn.execute(
            "INSERT INTO approvals(approval_id, plan_id, plan_hash, actor, confirmation_ui_version, approved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![approval.approval_id, approval.plan_id, approval.plan_hash, approval.actor,
                approval.confirmation_ui_version, approval.approved_at.to_rfc3339()],
        )?;
        Ok(approval)
    }

    pub fn start_job(
        &mut self,
        plan_id: &str,
        plan_hash: &str,
        approval_id: &str,
        idempotency_key: &str,
        current_source: &SourceDescriptor,
        now: DateTime<Utc>,
    ) -> Result<Job, LedgerError> {
        if idempotency_key.trim().is_empty() || idempotency_key.len() > 128 {
            return Err(LedgerError::new(
                "INVALID_SPEC",
                "Idempotency key must contain 1 to 128 characters",
            ));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT job_id FROM jobs WHERE idempotency_key=?1",
                [idempotency_key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(job_id) = existing {
            let job = read_job(&tx, &job_id)?.expect("indexed job must exist");
            if job.plan_id == plan_id && job.plan_hash == plan_hash {
                return Ok(job);
            }
            return Err(LedgerError::new(
                "JOB_STATE_CONFLICT",
                "Idempotency key belongs to another request",
            ));
        }
        let existing_plan_job = tx
            .query_row(
                "SELECT job_id FROM jobs WHERE plan_id=?1 ORDER BY created_at LIMIT 1",
                [plan_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(job_id) = existing_plan_job {
            let job = read_job(&tx, &job_id)?.expect("indexed job must exist");
            if job.plan_hash == plan_hash {
                return Ok(job);
            }
            return Err(LedgerError::new(
                "PLAN_STALE",
                "Plan hash does not match the existing job",
            ));
        }
        let body: String = tx
            .query_row(
                "SELECT body FROM plans WHERE plan_id=?1",
                [plan_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| LedgerError::new("PLAN_NOT_FOUND", "Plan was not found"))?;
        let stored: Plan = serde_json::from_str(&body)?;
        if stored.plan_hash != plan_hash || now >= stored.expires_at {
            return Err(LedgerError::new(
                "PLAN_STALE",
                "The plan changed or expired; review it again",
            ));
        }
        let refreshed = plan(stored.spec.clone(), current_source, now)
            .map_err(|e| LedgerError::new(e.code, e.message))?;
        if refreshed.plan_hash != plan_hash {
            return Err(LedgerError::new(
                "PLAN_STALE",
                "Source settings changed; review a new plan",
            ));
        }
        let approved = tx
            .query_row(
                "SELECT plan_id, plan_hash FROM approvals WHERE approval_id=?1",
                [approval_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if !approved.is_some_and(|(id, hash)| id == plan_id && hash == plan_hash) {
            return Err(LedgerError::new(
                "APPROVAL_REQUIRED",
                "This exact plan needs local user approval",
            ));
        }
        let job = Job {
            job_id: Uuid::new_v4().to_string(),
            plan_id: plan_id.into(),
            approval_id: approval_id.into(),
            plan_hash: plan_hash.into(),
            idempotency_key: idempotency_key.into(),
            state: JobState::Queued,
            version: 1,
            created_at: now,
        };
        let event = JobEvent {
            job_id: job.job_id.clone(),
            seq: 1,
            occurred_at: now,
            state: JobState::Queued,
            error_code: None,
            completed_tiles: None,
            total_tiles: None,
        };
        let insert = tx.execute(
            "INSERT INTO jobs(job_id, plan_id, approval_id, plan_hash, idempotency_key, state, version, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![job.job_id, job.plan_id, job.approval_id, job.plan_hash,
                job.idempotency_key, "queued", 1, job.created_at.to_rfc3339()],
        );
        if let Err(error) = insert {
            if matches!(&error, rusqlite::Error::SqliteFailure(err, _) if err.code == rusqlite::ErrorCode::ConstraintViolation)
            {
                return Err(LedgerError::new(
                    "JOB_STATE_CONFLICT",
                    "Approval has already started a job",
                ));
            }
            return Err(error.into());
        }
        tx.execute(
            "INSERT INTO job_events(job_id, seq, body) VALUES (?1, ?2, ?3)",
            params![job.job_id, 1, serde_json::to_string(&event)?],
        )?;
        tx.commit()?;
        Ok(job)
    }

    pub fn get_job(&self, job_id: &str) -> Result<Option<Job>, LedgerError> {
        read_job(&self.conn, job_id)
    }

    pub fn job_for_plan(&self, plan_id: &str) -> Result<Option<Job>, LedgerError> {
        let job_id = self
            .conn
            .query_row(
                "SELECT job_id FROM jobs WHERE plan_id=?1 ORDER BY created_at LIMIT 1",
                [plan_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        job_id
            .map(|job_id| read_job(&self.conn, &job_id))
            .transpose()
            .map(Option::flatten)
    }

    pub fn inspect_job_artifact(&self, job_id: &str) -> Result<Manifest, LedgerError> {
        let job = self
            .get_job(job_id)?
            .ok_or_else(|| LedgerError::new("JOB_NOT_FOUND", "Job was not found"))?;
        if !matches!(job.state, JobState::Completed | JobState::Partial) {
            return Err(LedgerError::new(
                "ARTIFACT_NOT_READY",
                "Job has no completed artifact to inspect",
            ));
        }
        let plan = self
            .get_plan(&job.plan_id)?
            .ok_or_else(|| LedgerError::new("PLAN_NOT_FOUND", "Plan was not found"))?;
        let manifest = imagery::inspect_bundle(&PathBuf::from(plan.plan.spec.output_directory))
            .map_err(|error| LedgerError::new(error.code, error.message))?;
        if manifest.id != format!("geod-agent-job-{job_id}") {
            return Err(LedgerError::new(
                "ARTIFACT_OWNERSHIP",
                "Artifact belongs to another job",
            ));
        }
        Ok(manifest)
    }

    /// Cancel a job left without an active worker, such as after app restart.
    /// Active workers use a cancellation flag and transition themselves.
    pub fn cancel_inactive_job(&mut self, job_id: &str) -> Result<Job, LedgerError> {
        let job = self
            .get_job(job_id)?
            .ok_or_else(|| LedgerError::new("JOB_NOT_FOUND", "Job was not found"))?;
        match job.state {
            JobState::Queued | JobState::Downloading | JobState::Paused => {
                self.transition(job_id, job.state, JobState::Cancelled, None, Utc::now())
            }
            _ => Err(LedgerError::new(
                "JOB_STATE_CONFLICT",
                "Job cannot be cancelled in this state",
            )),
        }
    }

    pub fn pause_inactive_job(&mut self, job_id: &str) -> Result<Job, LedgerError> {
        let job = self
            .get_job(job_id)?
            .ok_or_else(|| LedgerError::new("JOB_NOT_FOUND", "Job was not found"))?;
        match job.state {
            JobState::Queued | JobState::Downloading => {
                self.transition(job_id, job.state, JobState::Paused, None, Utc::now())
            }
            _ => Err(LedgerError::new(
                "JOB_STATE_CONFLICT",
                "Job cannot be paused in this state",
            )),
        }
    }

    pub fn resume_paused_job(&mut self, job_id: &str) -> Result<Job, LedgerError> {
        self.transition(job_id, JobState::Paused, JobState::Queued, None, Utc::now())
    }

    /// Retry transient failures or insufficient disk space after the user frees
    /// capacity, under the same approval and job ID. The tile cache remains
    /// bound to this job's plan hash and source revision.
    pub fn retry_failed_job(&mut self, job_id: &str) -> Result<Job, LedgerError> {
        let job = self
            .get_job(job_id)?
            .ok_or_else(|| LedgerError::new("JOB_NOT_FOUND", "Job was not found"))?;
        if job.state != JobState::Failed {
            return Err(LedgerError::new(
                "JOB_STATE_CONFLICT",
                "Only a failed job can be retried",
            ));
        }
        let latest: String = self.conn.query_row(
            "SELECT body FROM job_events WHERE job_id=?1 ORDER BY seq DESC LIMIT 1",
            [job_id],
            |row| row.get(0),
        )?;
        let event: JobEvent = serde_json::from_str(&latest)?;
        if !matches!(
            event.error_code.as_deref(),
            Some(
                "SOURCE_NETWORK"
                    | "SOURCE_RATE_LIMITED"
                    | "SOURCE_TEMPORARY"
                    | "TIMEOUT"
                    | "DISK_INSUFFICIENT"
            )
        ) {
            return Err(LedgerError::new(
                "JOB_NOT_RETRYABLE",
                "This failure needs a new plan or a corrected source",
            ));
        }
        self.transition(job_id, JobState::Failed, JobState::Queued, None, Utc::now())
    }

    pub fn list_jobs(&self, limit: u32) -> Result<Vec<Job>, LedgerError> {
        let mut statement = self
            .conn
            .prepare("SELECT job_id FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?1")?;
        let ids = statement.query_map([limit.clamp(1, 200)], |row| row.get::<_, String>(0))?;
        ids.map(|id| {
            let id = id?;
            read_job(&self.conn, &id)?
                .ok_or_else(|| LedgerError::new("STORAGE_ERROR", "Listed job disappeared"))
        })
        .collect()
    }

    pub fn events_after(
        &self,
        job_id: &str,
        after_seq: u64,
        limit: u32,
    ) -> Result<Vec<JobEvent>, LedgerError> {
        let mut statement = self.conn.prepare(
            "SELECT body FROM job_events WHERE job_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![job_id, after_seq, limit.clamp(1, 1000)], |row| {
                row.get::<_, String>(0)
            })?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    fn transition(
        &mut self,
        job_id: &str,
        expected: JobState,
        next: JobState,
        error_code: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<Job, LedgerError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_job(&tx, job_id)?
            .ok_or_else(|| LedgerError::new("JOB_NOT_FOUND", "Job was not found"))?;
        if current.state != expected {
            return Err(LedgerError::new(
                "JOB_STATE_CONFLICT",
                "Job state changed; reload it",
            ));
        }
        let seq = current.version + 1;
        let state = serde_json::to_value(next)?
            .as_str()
            .expect("state serializes as a string")
            .to_owned();
        tx.execute(
            "UPDATE jobs SET state=?1, version=?2 WHERE job_id=?3 AND version=?4",
            params![state, seq, job_id, current.version],
        )?;
        let event = JobEvent {
            job_id: job_id.into(),
            seq,
            occurred_at: now,
            state: next,
            error_code: error_code.map(str::to_owned),
            completed_tiles: None,
            total_tiles: None,
        };
        tx.execute(
            "INSERT INTO job_events(job_id, seq, body) VALUES (?1, ?2, ?3)",
            params![job_id, seq, serde_json::to_string(&event)?],
        )?;
        tx.commit()?;
        self.get_job(job_id)?
            .ok_or_else(|| LedgerError::new("STORAGE_ERROR", "Job disappeared after state update"))
    }

    fn record_progress(
        &mut self,
        job_id: &str,
        completed: u64,
        total: u64,
    ) -> Result<(), LedgerError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let job = read_job(&tx, job_id)?
            .ok_or_else(|| LedgerError::new("JOB_NOT_FOUND", "Job was not found"))?;
        if job.state != JobState::Downloading || completed > total {
            return Err(LedgerError::new(
                "JOB_STATE_CONFLICT",
                "Progress cannot be recorded",
            ));
        }
        let seq = job.version + 1;
        tx.execute(
            "UPDATE jobs SET version=?1 WHERE job_id=?2 AND version=?3",
            params![seq, job_id, job.version],
        )?;
        let event = JobEvent {
            job_id: job_id.into(),
            seq,
            occurred_at: Utc::now(),
            state: JobState::Downloading,
            error_code: None,
            completed_tiles: Some(completed),
            total_tiles: Some(total),
        };
        tx.execute(
            "INSERT INTO job_events(job_id,seq,body) VALUES (?1,?2,?3)",
            params![job_id, seq, serde_json::to_string(&event)?],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Execute a previously approved job on this computer. The endpoint must
    /// come from the same trusted registry as its public descriptor.
    pub async fn run_job(
        &mut self,
        job_id: &str,
        current_source: &SourceDescriptor,
        endpoint: &HttpSource,
        now: DateTime<Utc>,
    ) -> Result<Manifest, LedgerError> {
        let cancelled = AtomicBool::new(false);
        self.run_job_with_cancel(job_id, current_source, endpoint, now, &cancelled)
            .await
    }

    pub async fn run_job_with_cancel(
        &mut self,
        job_id: &str,
        current_source: &SourceDescriptor,
        endpoint: &HttpSource,
        now: DateTime<Utc>,
        cancelled: &AtomicBool,
    ) -> Result<Manifest, LedgerError> {
        let paused = AtomicBool::new(false);
        self.run_job_with_control(job_id, current_source, endpoint, now, cancelled, &paused)
            .await
    }

    pub async fn run_job_with_control(
        &mut self,
        job_id: &str,
        current_source: &SourceDescriptor,
        endpoint: &HttpSource,
        now: DateTime<Utc>,
        cancelled: &AtomicBool,
        paused: &AtomicBool,
    ) -> Result<Manifest, LedgerError> {
        let mut job = self
            .get_job(job_id)?
            .ok_or_else(|| LedgerError::new("JOB_NOT_FOUND", "Job was not found"))?;
        if !matches!(job.state, JobState::Queued | JobState::Downloading) {
            return Err(LedgerError::new(
                "JOB_STATE_CONFLICT",
                "Job is not runnable",
            ));
        }
        let stored = self
            .get_plan(&job.plan_id)?
            .ok_or_else(|| LedgerError::new("PLAN_NOT_FOUND", "Plan was not found"))?;
        let refreshed = match plan(stored.plan.spec.clone(), current_source, now) {
            Ok(value) => value,
            Err(error) => {
                self.transition(
                    job_id,
                    job.state,
                    JobState::Failed,
                    Some(error.code),
                    Utc::now(),
                )?;
                return Err(LedgerError::new(error.code, error.message));
            }
        };
        let scheme_matches = matches!(
            (current_source.scheme, endpoint.scheme),
            (TileScheme::XYZ, imagery::TileScheme::XYZ)
                | (TileScheme::TMS, imagery::TileScheme::TMS)
        );
        if refreshed.plan_hash != job.plan_hash
            || endpoint.id != current_source.id
            || endpoint.name != current_source.display_name
            || endpoint.attribution != current_source.attribution
            || endpoint.license != current_source.license
            || endpoint.tile_size != current_source.tile_size
            || endpoint.configuration_revision() != current_source.config_revision
            || !scheme_matches
        {
            self.transition(
                job_id,
                job.state,
                JobState::Failed,
                Some("PLAN_STALE"),
                Utc::now(),
            )?;
            return Err(LedgerError::new(
                "PLAN_STALE",
                "Source or approved plan changed before execution",
            ));
        }
        let destination = PathBuf::from(&stored.plan.spec.output_directory);
        let cache_parent = self
            .db_path
            .parent()
            .ok_or_else(|| LedgerError::new("STORAGE_ERROR", "Database has no parent"))?
            .join("tile-cache");
        std::fs::create_dir_all(&cache_parent)
            .map_err(|error| LedgerError::new("STORAGE_ERROR", error.to_string()))?;
        let cache = imagery::TileCacheConfig {
            root: cache_parent.join(job_id),
            plan_hash: job.plan_hash.clone(),
            job_id: job_id.to_string(),
        };
        let request = ImageryRequest {
            name: endpoint.name.clone(),
            bounds: stored.plan.spec.bounds,
            boundary: stored.plan.spec.boundary.clone(),
            grids: stored.plan.tile_grids.iter().map(Into::into).collect(),
            output_geotiff: stored
                .plan
                .spec
                .output_formats
                .contains(&OutputFormat::GeoTiff),
            output_mbtiles: stored
                .plan
                .spec
                .output_formats
                .contains(&OutputFormat::Mbtiles),
            max_tiles: stored.plan.spec.limits.max_tiles,
            max_decoded_rgba_bytes: stored.plan.spec.limits.max_decoded_rgba_bytes,
            destination: destination.clone(),
            deadline: Duration::from_secs(1800),
        };
        if job.state == JobState::Queued {
            job = self.transition(job_id, JobState::Queued, JobState::Downloading, None, now)?;
        }
        let result = if destination.exists() {
            imagery::inspect_bundle(&destination).and_then(|manifest| {
                if manifest.id != format!("geod-agent-job-{job_id}") {
                    return Err(geod_core::imagery::CoreError::new(
                        "OUTPUT_CONFLICT",
                        "Output belongs to another job",
                    ));
                }
                Ok(manifest)
            })
        } else {
            imagery::fetch_bundle_with_cache_control(
                &request,
                endpoint,
                cancelled,
                paused,
                &cache,
                |completed, total| {
                    if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                        return Err(geod_core::imagery::CoreError::new(
                            "CANCELLED",
                            "Download cancelled",
                        ));
                    }
                    if completed <= 10 || completed % 16 == 0 || completed == total {
                        self.record_progress(job_id, completed, total)
                            .map_err(|error| {
                                geod_core::imagery::CoreError::new(error.code, error.message)
                            })?;
                    }
                    if paused.load(std::sync::atomic::Ordering::Relaxed) {
                        return Err(geod_core::imagery::CoreError::new(
                            "PAUSED",
                            "Download paused after saving the tile checkpoint",
                        ));
                    }
                    Ok(())
                },
            )
            .await
        };
        match result {
            Ok(_) => {
                self.transition(job_id, job.state, JobState::Verifying, None, Utc::now())?;
                match imagery::inspect_bundle(&destination) {
                    Ok(manifest) => {
                        self.transition(
                            job_id,
                            JobState::Verifying,
                            JobState::Completed,
                            None,
                            Utc::now(),
                        )?;
                        if let (Ok(parent), Ok(root)) = (
                            std::fs::canonicalize(&cache_parent),
                            std::fs::canonicalize(&cache.root),
                        ) {
                            if root.parent() == Some(parent.as_path()) {
                                let _ = std::fs::remove_dir_all(root);
                            }
                        }
                        Ok(manifest)
                    }
                    Err(error) => {
                        self.transition(
                            job_id,
                            JobState::Verifying,
                            JobState::Failed,
                            Some(error.code),
                            Utc::now(),
                        )?;
                        Err(LedgerError::new(error.code, error.message))
                    }
                }
            }
            Err(error) => {
                let next = match error.code {
                    "CANCELLED" => JobState::Cancelled,
                    "PAUSED" => JobState::Paused,
                    _ => JobState::Failed,
                };
                self.transition(job_id, job.state, next, Some(error.code), Utc::now())?;
                Err(LedgerError::new(error.code, error.message))
            }
        }
    }
}

fn read_job(conn: &Connection, job_id: &str) -> Result<Option<Job>, LedgerError> {
    let row = conn
        .query_row(
            "SELECT plan_id, approval_id, plan_hash, idempotency_key, state, version, created_at
             FROM jobs WHERE job_id=?1",
            [job_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, u64>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(plan_id, approval_id, plan_hash, idempotency_key, state, version, created_at)| {
            Ok(Job {
                job_id: job_id.into(),
                plan_id,
                approval_id,
                plan_hash,
                idempotency_key,
                state: serde_json::from_value(serde_json::Value::String(state))?,
                version,
                created_at: DateTime::parse_from_rfc3339(&created_at)
                    .map_err(|e| LedgerError::new("STORAGE_ERROR", e.to_string()))?
                    .with_timezone(&Utc),
            })
        },
    )
    .transpose()
}

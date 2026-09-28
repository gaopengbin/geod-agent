//! Durable plan, approval and queued-job ledger. Execution is added by a worker;
//! no download is started just because a model asks for one.

use crate::{plan, Plan, SourceDescriptor, TaskSpec};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use uuid::Uuid;

const DB_VERSION: i64 = 1;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Downloading,
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
}

pub struct TaskStore {
    conn: Connection,
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
                 PRAGMA user_version=1;
                 COMMIT;",
            )?;
        }
        Ok(Self { conn })
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
            if job.plan_id == plan_id
                && job.plan_hash == plan_hash
                && job.approval_id == approval_id
            {
                return Ok(job);
            }
            return Err(LedgerError::new(
                "JOB_STATE_CONFLICT",
                "Idempotency key belongs to another request",
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

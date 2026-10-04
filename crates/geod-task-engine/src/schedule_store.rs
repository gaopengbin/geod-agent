//! Durable imagery schedules. Due claims are atomic; unfinished occurrences never overlap.
use crate::{
    ledger::{LedgerError, TaskStore},
    TaskSpec,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub schedule_id: String,
    pub owner_id: String,
    pub conversation_id: String,
    pub name: String,
    #[serde(default)]
    pub template_plan_id: Option<String>,
    pub template: TaskSpec,
    pub enabled: bool,
    pub next_run_at: DateTime<Utc>,
    pub repeat_seconds: Option<u32>,
    pub max_retries: u8,
    pub created_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRun {
    pub run_id: String,
    pub schedule_id: String,
    pub scheduled_at: DateTime<Utc>,
    pub state: String,
    pub attempt: u8,
    pub next_attempt_at: DateTime<Utc>,
    pub lease_until: DateTime<Utc>,
    #[serde(default)]
    pub lease_owner: Option<String>,
    pub plan_id: Option<String>,
    pub job_id: Option<String>,
    pub error_code: Option<String>,
    pub finished_at: Option<DateTime<Utc>>,
}
impl ScheduleRun {
    pub fn terminal(&self) -> bool {
        matches!(self.state.as_str(), "succeeded" | "failed" | "cancelled")
    }
}
impl TaskStore {
    pub fn create_schedule(
        &mut self,
        owner: &str,
        conversation: &str,
        key: &str,
        name: &str,
        template_plan_id: Option<&str>,
        template: TaskSpec,
        next: DateTime<Utc>,
        repeat: Option<u32>,
        retries: u8,
        now: DateTime<Utc>,
    ) -> Result<Schedule, LedgerError> {
        if !owner.is_empty() && !key.is_empty() && key.len() <= 200 {
            let id = format!(
                "schedule-{:x}",
                Sha256::digest(format!("{owner}:{conversation}:{key}").as_bytes())
            );
            if let Some(saved) = self.get_schedule(owner, &id)? {
                return Ok(saved);
            }
        }
        if owner.is_empty()
            || !(8..=80).contains(&conversation.len())
            || !conversation
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || key.is_empty()
            || key.len() > 200
            || name.trim().is_empty()
            || name.chars().count() > 120
            || name.chars().any(char::is_control)
            || repeat.is_some_and(|s| !(60..=31_536_000).contains(&s))
            || retries > 3
            || next < now
            || next > now + chrono::Duration::days(366)
        {
            return Err(LedgerError::new(
                "SCHEDULE_INVALID",
                "Invalid schedule name, time, interval or retry count",
            ));
        }
        let id = format!(
            "schedule-{:x}",
            Sha256::digest(format!("{owner}:{conversation}:{key}").as_bytes())
        );
        if let Some(saved) = self.get_schedule(owner, &id)? {
            return Ok(saved);
        }
        let schedule = Schedule {
            schedule_id: id,
            owner_id: owner.into(),
            conversation_id: conversation.into(),
            name: name.trim().into(),
            template_plan_id: template_plan_id.map(str::to_owned),
            template,
            enabled: true,
            next_run_at: next,
            repeat_seconds: repeat,
            max_retries: retries,
            created_at: now,
        };
        self.conn.execute("INSERT OR IGNORE INTO schedules(schedule_id,owner_id,conversation_id,enabled,next_run_at,body) VALUES (?1,?2,?3,1,?4,?5)",params![schedule.schedule_id,owner,conversation,next.timestamp(),serde_json::to_string(&schedule)?])?;
        self.get_schedule(owner, &schedule.schedule_id)?
            .ok_or_else(|| LedgerError::new("STORAGE_ERROR", "Schedule save failed"))
    }
    pub fn get_schedule(&self, owner: &str, id: &str) -> Result<Option<Schedule>, LedgerError> {
        let body: Option<String> = self
            .conn
            .query_row(
                "SELECT body FROM schedules WHERE schedule_id=?1 AND owner_id=?2",
                params![id, owner],
                |r| r.get(0),
            )
            .optional()?;
        body.map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }
    pub fn list_schedules(
        &self,
        owner: &str,
        conversation: &str,
    ) -> Result<Vec<Schedule>, LedgerError> {
        let mut statement=self.conn.prepare("SELECT body FROM schedules WHERE owner_id=?1 AND conversation_id=?2 ORDER BY next_run_at,schedule_id LIMIT 100")?;
        let rows = statement.query_map(params![owner, conversation], |r| r.get::<_, String>(0))?;
        rows.map(|s| Ok(serde_json::from_str(&s?)?)).collect()
    }
    pub fn set_schedule_enabled(
        &mut self,
        owner: &str,
        id: &str,
        enabled: bool,
        next: Option<DateTime<Utc>>,
        now: DateTime<Utc>,
    ) -> Result<Schedule, LedgerError> {
        let mut saved = self
            .get_schedule(owner, id)?
            .ok_or_else(|| LedgerError::new("SCHEDULE_NOT_FOUND", "Schedule was not found"))?;
        if let Some(next) = next {
            if next < now || next > now + chrono::Duration::days(366) {
                return Err(LedgerError::new(
                    "SCHEDULE_INVALID",
                    "Next run time is invalid",
                ));
            }
            saved.next_run_at = next;
        }
        if enabled && saved.next_run_at < now && saved.repeat_seconds.is_none() {
            return Err(LedgerError::new(
                "SCHEDULE_INVALID",
                "A completed one-time schedule needs a new run time",
            ));
        }
        saved.enabled = enabled;
        self.conn.execute("UPDATE schedules SET enabled=?1,next_run_at=?2,body=?3 WHERE schedule_id=?4 AND owner_id=?5",params![enabled,saved.next_run_at.timestamp(),serde_json::to_string(&saved)?,id,owner])?;
        Ok(saved)
    }
    /// Coalesce missed intervals to one occurrence. Pause affects future occurrences only.
    pub fn claim_due_schedules(
        &mut self,
        owner: &str,
        now: DateTime<Utc>,
    ) -> Result<Vec<(Schedule, ScheduleRun)>, LedgerError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut statement=tx.prepare("SELECT s.body FROM schedules s WHERE owner_id=?1 AND enabled=1 AND next_run_at<=?2 AND NOT EXISTS (SELECT 1 FROM schedule_runs r WHERE r.schedule_id=s.schedule_id AND r.state NOT IN ('succeeded','failed','cancelled')) ORDER BY next_run_at LIMIT 10")?;
        let bodies = statement
            .query_map(params![owner, now.timestamp()], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let mut claimed = Vec::new();
        for body in bodies {
            let mut schedule: Schedule = serde_json::from_str(&body)?;
            let run = ScheduleRun {
                run_id: Uuid::new_v4().to_string(),
                schedule_id: schedule.schedule_id.clone(),
                scheduled_at: schedule.next_run_at,
                state: "queued".into(),
                attempt: 0,
                next_attempt_at: now,
                lease_until: now,
                lease_owner: None,
                plan_id: None,
                job_id: None,
                error_code: None,
                finished_at: None,
            };
            tx.execute("INSERT INTO schedule_runs(run_id,schedule_id,scheduled_at,state,body) VALUES (?1,?2,?3,?4,?5)",params![run.run_id,run.schedule_id,run.scheduled_at.timestamp(),run.state,serde_json::to_string(&run)?])?;
            if let Some(interval) = schedule.repeat_seconds {
                let steps =
                    (now.timestamp() - schedule.next_run_at.timestamp()) / i64::from(interval) + 1;
                schedule.next_run_at += chrono::Duration::seconds(steps * i64::from(interval));
            } else {
                schedule.enabled = false;
            }
            tx.execute(
                "UPDATE schedules SET enabled=?1,next_run_at=?2,body=?3 WHERE schedule_id=?4",
                params![
                    schedule.enabled,
                    schedule.next_run_at.timestamp(),
                    serde_json::to_string(&schedule)?,
                    schedule.schedule_id
                ],
            )?;
            claimed.push((schedule, run));
        }
        tx.commit()?;
        Ok(claimed)
    }
    pub fn list_schedule_runs(
        &self,
        owner: &str,
        conversation: Option<&str>,
        unfinished_only: bool,
    ) -> Result<Vec<ScheduleRun>, LedgerError> {
        let mut statement=self.conn.prepare("SELECT r.body FROM schedule_runs r JOIN schedules s ON s.schedule_id=r.schedule_id WHERE s.owner_id=?1 AND (?2 IS NULL OR s.conversation_id=?2) AND (?3=0 OR r.state NOT IN ('succeeded','failed','cancelled')) ORDER BY r.scheduled_at DESC LIMIT 100")?;
        let rows = statement.query_map(params![owner, conversation, unfinished_only], |r| {
            r.get::<_, String>(0)
        })?;
        rows.map(|s| Ok(serde_json::from_str(&s?)?)).collect()
    }
    /// SQLite compare-and-swap keeps concurrent runtimes from executing the same occurrence.
    pub fn lease_schedule_run(
        &mut self,
        id: &str,
        worker: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<ScheduleRun>, LedgerError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let body:Option<String>=tx.query_row("SELECT body FROM schedule_runs WHERE run_id=?1 AND state NOT IN ('succeeded','failed','cancelled')",[id],|r|r.get(0)).optional()?;
        let Some(body) = body else { return Ok(None) };
        let mut run: ScheduleRun = serde_json::from_str(&body)?;
        if (run.lease_owner.as_deref() != Some(worker) && run.lease_until > now)
            || run.next_attempt_at > now
        {
            return Ok(None);
        };
        run.lease_owner = Some(worker.into());
        run.lease_until = now + chrono::Duration::seconds(15);
        tx.execute(
            "UPDATE schedule_runs SET body=?1 WHERE run_id=?2",
            params![serde_json::to_string(&run)?, id],
        )?;
        tx.commit()?;
        Ok(Some(run))
    }
    pub fn save_schedule_run(&mut self, run: &ScheduleRun) -> Result<(), LedgerError> {
        if !matches!(
            run.state.as_str(),
            "queued"
                | "running"
                | "waiting_confirmation"
                | "paused"
                | "retrying"
                | "succeeded"
                | "failed"
                | "cancelled"
        ) {
            return Err(LedgerError::new("SCHEDULE_INVALID", "Invalid run state"));
        }
        self.conn.execute("UPDATE schedule_runs SET state=?1,body=?2 WHERE run_id=?3 AND state NOT IN ('succeeded','failed','cancelled') AND json_extract(body,'$.leaseOwner') IS ?4",params![run.state,serde_json::to_string(run)?,run.run_id,run.lease_owner])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_lease_and_cancellation_reject_stale_writers() {
        let t = tempfile::tempdir().unwrap();
        let db = t.path().join("db");
        let now = Utc::now();
        let mut a = TaskStore::open(&db).unwrap();
        let s = a
            .create_schedule(
                "owner",
                "conversation-1",
                "restart",
                "地区",
                None,
                template(),
                now,
                None,
                2,
                now,
            )
            .unwrap();
        let claimed = a.claim_due_schedules("owner", now).unwrap().remove(0).1;
        let mut stale = a
            .lease_schedule_run(&claimed.run_id, "old", now)
            .unwrap()
            .unwrap();
        let mut recovered = a
            .lease_schedule_run(&claimed.run_id, "new", now + chrono::Duration::seconds(16))
            .unwrap()
            .unwrap();
        stale.state = "succeeded".into();
        a.save_schedule_run(&stale).unwrap();
        assert_eq!(
            a.list_schedule_runs("owner", None, false).unwrap()[0].state,
            "queued"
        );
        recovered.state = "cancelled".into();
        a.save_schedule_run(&recovered).unwrap();
        recovered.state = "running".into();
        a.save_schedule_run(&recovered).unwrap();
        assert_eq!(
            a.list_schedule_runs("owner", None, false).unwrap()[0].state,
            "cancelled"
        );
        assert_eq!(
            a.create_schedule(
                "owner",
                "conversation-1",
                "restart",
                "地区",
                None,
                template(),
                now,
                None,
                2,
                now + chrono::Duration::minutes(2)
            )
            .unwrap()
            .schedule_id,
            s.schedule_id
        );
    }
    fn template() -> TaskSpec {
        serde_json::from_value(serde_json::json!({"schemaVersion":"0.1","kind":"imagery","sourceId":"test","bounds":[116.1,39.6,116.3,39.8],"zoomLevels":[8],"outputFormats":["geotiff"],"outputDirectory":std::env::temp_dir().join("schedule-template").to_string_lossy(),"limits":{"maxTiles":4096,"maxDecodedRgbaBytes":536870912}})).unwrap()
    }
    #[test]
    fn persisted_claims_coalesce_and_never_overlap() {
        let t = tempfile::tempdir().unwrap();
        let db = t.path().join("tasks.sqlite");
        let now = Utc::now();
        let mut a = TaskStore::open(&db).unwrap();
        let schedule = a
            .create_schedule(
                "owner",
                "conversation-1",
                "key",
                "地区影像",
                None,
                template(),
                now,
                Some(60),
                2,
                now,
            )
            .unwrap();
        assert_eq!(
            schedule.schedule_id,
            a.create_schedule(
                "owner",
                "conversation-1",
                "key",
                "地区影像",
                None,
                template(),
                now,
                Some(60),
                2,
                now
            )
            .unwrap()
            .schedule_id
        );
        drop(a);
        let mut a = TaskStore::open(&db).unwrap();
        let claimed = a
            .claim_due_schedules("owner", now + chrono::Duration::minutes(5))
            .unwrap();
        assert_eq!(claimed.len(), 1);
        let mut b = TaskStore::open(&db).unwrap();
        assert!(b
            .claim_due_schedules("owner", now + chrono::Duration::minutes(10))
            .unwrap()
            .is_empty());
        let mut run = a
            .lease_schedule_run(
                &claimed[0].1.run_id,
                "runtime-a",
                now + chrono::Duration::minutes(5),
            )
            .unwrap()
            .unwrap();
        assert!(b
            .lease_schedule_run(&run.run_id, "runtime-b", now + chrono::Duration::minutes(5))
            .unwrap()
            .is_none());
        assert!(b
            .list_schedule_runs("other", None, false)
            .unwrap()
            .is_empty());
        run.state = "succeeded".into();
        a.save_schedule_run(&run).unwrap();
        assert_eq!(
            b.claim_due_schedules("owner", now + chrono::Duration::minutes(10))
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn paused_schedules_and_completed_once_do_not_fire() {
        let t = tempfile::tempdir().unwrap();
        let now = Utc::now();
        let mut a = TaskStore::open(&t.path().join("db")).unwrap();
        let s = a
            .create_schedule(
                "owner",
                "conversation-1",
                "key",
                "地区",
                None,
                template(),
                now,
                None,
                0,
                now,
            )
            .unwrap();
        a.set_schedule_enabled("owner", &s.schedule_id, false, None, now)
            .unwrap();
        assert!(a.claim_due_schedules("owner", now).unwrap().is_empty());
        a.set_schedule_enabled("owner", &s.schedule_id, true, None, now)
            .unwrap();
        let mut r = a.claim_due_schedules("owner", now).unwrap().remove(0).1;
        r.state = "succeeded".into();
        a.save_schedule_run(&r).unwrap();
        assert!(a
            .claim_due_schedules("owner", now + chrono::Duration::days(2))
            .unwrap()
            .is_empty());
        assert!(a.get_schedule("other", &s.schedule_id).unwrap().is_none());
    }
}

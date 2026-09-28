use chrono::{TimeZone, Utc};
use geod_task_engine::{
    ledger::{JobState, TaskStore},
    OutputFormat, ResourceLimits, SchemaVersion, SourceDescriptor, TaskKind, TaskSpec, TileScheme,
};

fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 28, 10, 0, 0).unwrap()
}

fn source() -> SourceDescriptor {
    SourceDescriptor {
        schema_version: SchemaVersion::V0_1,
        id: "synthetic".into(),
        display_name: "Synthetic fixture".into(),
        attribution: "Generated test pixels".into(),
        license: "Synthetic test data".into(),
        bulk_download_allowed: true,
        scheme: TileScheme::XYZ,
        tile_size: 256,
        min_zoom: 0,
        max_zoom: 22,
        config_revision: "v1".into(),
        credential_ref_version: None,
    }
}

fn spec() -> TaskSpec {
    TaskSpec {
        schema_version: SchemaVersion::V0_1,
        kind: TaskKind::Imagery,
        source_id: "synthetic".into(),
        bounds: [-1.0, 1.0, 1.0, 2.0],
        zoom_levels: vec![1],
        output_formats: vec![OutputFormat::GeoTiff],
        output_directory: std::env::temp_dir()
            .join("geod-ledger-test")
            .to_string_lossy()
            .into_owned(),
        limits: ResourceLimits {
            max_tiles: 16,
            max_decoded_rgba_bytes: 16 * 1024 * 1024,
        },
    }
}

#[test]
fn approval_and_idempotent_queue_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("jobs.sqlite");
    let mut store = TaskStore::open(&path).unwrap();
    let stored = store.create_plan(spec(), &source(), now()).unwrap();
    let approval = store
        .grant_approval(
            &stored.plan_id,
            &stored.plan.plan_hash,
            "local-user",
            "workspace-0.1",
            now(),
        )
        .unwrap();
    let job = store
        .start_job(
            &stored.plan_id,
            &stored.plan.plan_hash,
            &approval.approval_id,
            "request-1",
            &source(),
            now(),
        )
        .unwrap();
    assert_eq!(job.state, JobState::Queued);
    assert_eq!(job.version, 1);
    assert_eq!(store.events_after(&job.job_id, 0, 10).unwrap()[0].seq, 1);
    assert!(store.events_after(&job.job_id, 1, 10).unwrap().is_empty());
    drop(store);

    let mut reopened = TaskStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .get_plan(&stored.plan_id)
            .unwrap()
            .unwrap()
            .plan
            .plan_hash,
        stored.plan.plan_hash
    );
    assert_eq!(reopened.get_job(&job.job_id).unwrap(), Some(job.clone()));
    let same = reopened
        .start_job(
            &stored.plan_id,
            &stored.plan.plan_hash,
            &approval.approval_id,
            "request-1",
            &source(),
            now(),
        )
        .unwrap();
    assert_eq!(same.job_id, job.job_id);
    assert_eq!(reopened.events_after(&job.job_id, 0, 10).unwrap().len(), 1);
    assert_eq!(
        reopened
            .start_job(
                &stored.plan_id,
                &stored.plan.plan_hash,
                &approval.approval_id,
                "request-2",
                &source(),
                now()
            )
            .unwrap_err()
            .code,
        "JOB_STATE_CONFLICT"
    );
}

#[test]
fn stale_source_or_hash_cannot_consume_approval() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(&dir.path().join("jobs.sqlite")).unwrap();
    let stored = store.create_plan(spec(), &source(), now()).unwrap();
    let approval = store
        .grant_approval(
            &stored.plan_id,
            &stored.plan.plan_hash,
            "local-user",
            "workspace-0.1",
            now(),
        )
        .unwrap();
    let mut changed = source();
    changed.config_revision = "v2".into();
    assert_eq!(
        store
            .start_job(
                &stored.plan_id,
                &stored.plan.plan_hash,
                &approval.approval_id,
                "request-1",
                &changed,
                now()
            )
            .unwrap_err()
            .code,
        "PLAN_STALE"
    );
    assert_eq!(
        store
            .start_job(
                &stored.plan_id,
                "wrong-hash",
                &approval.approval_id,
                "request-1",
                &source(),
                now()
            )
            .unwrap_err()
            .code,
        "PLAN_STALE"
    );
    assert_eq!(
        store
            .start_job(
                &stored.plan_id,
                &stored.plan.plan_hash,
                "not-approved",
                "request-1",
                &source(),
                now()
            )
            .unwrap_err()
            .code,
        "APPROVAL_REQUIRED"
    );
    assert!(store.get_job("not-created").unwrap().is_none());
}

#[test]
fn expired_plan_requires_new_review() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(&dir.path().join("jobs.sqlite")).unwrap();
    let stored = store.create_plan(spec(), &source(), now()).unwrap();
    let approval = store
        .grant_approval(
            &stored.plan_id,
            &stored.plan.plan_hash,
            "local-user",
            "workspace-0.1",
            now(),
        )
        .unwrap();
    let later = now() + chrono::Duration::minutes(31);
    assert_eq!(
        store
            .start_job(
                &stored.plan_id,
                &stored.plan.plan_hash,
                &approval.approval_id,
                "request-1",
                &source(),
                later
            )
            .unwrap_err()
            .code,
        "PLAN_STALE"
    );
    assert_eq!(
        store
            .grant_approval(
                &stored.plan_id,
                &stored.plan.plan_hash,
                "local-user",
                "workspace-0.1",
                later
            )
            .unwrap_err()
            .code,
        "PLAN_STALE"
    );
}

#[test]
fn newer_database_is_not_written() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("jobs.sqlite");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA user_version=99").unwrap();
    drop(conn);
    assert_eq!(
        TaskStore::open(&path).err().unwrap().code,
        "STORAGE_VERSION_NEWER"
    );
}

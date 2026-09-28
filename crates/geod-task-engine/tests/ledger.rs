use chrono::{TimeZone, Utc};
use geod_core::imagery::{HttpSource, NetworkPolicy, TileScheme as HttpTileScheme};
use geod_task_engine::{
    ledger::{JobEvent, JobState, TaskStore},
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
fn transient_failure_requeues_same_approved_job_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("jobs.sqlite");
    let mut store = TaskStore::open(&path).unwrap();
    let planned = store.create_plan(spec(), &source(), now()).unwrap();
    let approval = store
        .grant_approval(
            &planned.plan_id,
            &planned.plan.plan_hash,
            "local-user",
            "test-ui",
            now(),
        )
        .unwrap();
    let job = store
        .start_job(
            &planned.plan_id,
            &planned.plan.plan_hash,
            &approval.approval_id,
            "request-1",
            &source(),
            now(),
        )
        .unwrap();
    drop(store);

    // Simulate a persisted worker failure while the process is down.
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute(
        "UPDATE jobs SET state='failed', version=2 WHERE job_id=?1",
        [&job.job_id],
    )
    .unwrap();
    let failure = JobEvent {
        job_id: job.job_id.clone(),
        seq: 2,
        occurred_at: now(),
        state: JobState::Failed,
        error_code: Some("SOURCE_NETWORK".into()),
        completed_tiles: None,
        total_tiles: None,
    };
    conn.execute(
        "INSERT INTO job_events(job_id,seq,body) VALUES (?1,2,?2)",
        (&job.job_id, serde_json::to_string(&failure).unwrap()),
    )
    .unwrap();
    drop(conn);

    let mut reopened = TaskStore::open(&path).unwrap();
    let retried = reopened.retry_failed_job(&job.job_id).unwrap();
    assert_eq!(retried.job_id, job.job_id);
    assert_eq!(retried.approval_id, approval.approval_id);
    assert_eq!(retried.plan_hash, planned.plan.plan_hash);
    assert_eq!(retried.state, JobState::Queued);
    assert_eq!(
        reopened
            .events_after(&job.job_id, 0, 10)
            .unwrap()
            .iter()
            .map(|e| e.state)
            .collect::<Vec<_>>(),
        [JobState::Queued, JobState::Failed, JobState::Queued]
    );
    assert_eq!(
        reopened.retry_failed_job(&job.job_id).unwrap_err().code,
        "JOB_STATE_CONFLICT"
    );

    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute(
        "UPDATE jobs SET state='failed', version=4 WHERE job_id=?1",
        [&job.job_id],
    )
    .unwrap();
    let stale = JobEvent {
        seq: 4,
        error_code: Some("PLAN_STALE".into()),
        ..failure
    };
    conn.execute(
        "INSERT INTO job_events(job_id,seq,body) VALUES (?1,4,?2)",
        (&job.job_id, serde_json::to_string(&stale).unwrap()),
    )
    .unwrap();
    assert_eq!(
        reopened.retry_failed_job(&job.job_id).unwrap_err().code,
        "JOB_NOT_RETRYABLE"
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

fn endpoint() -> HttpSource {
    HttpSource {
        id: "authorized-example".into(),
        name: "Authorized example".into(),
        attribution: "Example owner".into(),
        license: "Owner permits bulk use".into(),
        url_template: "https://example.org/tiles/{z}/{x}/{y}.png".into(),
        scheme: HttpTileScheme::XYZ,
        tile_size: 256,
        network_policy: NetworkPolicy::PublicHttps,
        min_interval_ms: 200,
    }
}

#[test]
fn source_registration_requires_acknowledgement_and_persists_revision() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("jobs.sqlite");
    let mut store = TaskStore::open(&path).unwrap();
    assert_eq!(
        store
            .save_source(endpoint(), 0, 18, false, now())
            .unwrap_err()
            .code,
        "SOURCE_UNAUTHORIZED"
    );
    let descriptor = store.save_source(endpoint(), 0, 18, true, now()).unwrap();
    assert_eq!(
        descriptor.config_revision,
        endpoint().configuration_revision()
    );
    assert_eq!(store.list_sources().unwrap().len(), 1);
    drop(store);

    let mut reopened = TaskStore::open(&path).unwrap();
    let saved = reopened
        .get_registered_source("authorized-example")
        .unwrap()
        .unwrap();
    assert_eq!(saved.endpoint.url_template, endpoint().url_template);
    assert_eq!(saved.descriptor.config_revision, descriptor.config_revision);
    let mut edited = endpoint();
    edited.url_template = "https://example.org/new/{z}/{x}/{y}.png".into();
    let revised = reopened.save_source(edited, 0, 18, true, now()).unwrap();
    assert_ne!(revised.config_revision, descriptor.config_revision);
    assert_eq!(reopened.list_sources().unwrap().len(), 1);
}

#[test]
fn source_registration_rejects_inline_query_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(&dir.path().join("jobs.sqlite")).unwrap();
    let mut source = endpoint();
    source.url_template.push_str("?key=secret");
    assert_eq!(
        store
            .save_source(source, 0, 18, true, now())
            .unwrap_err()
            .code,
        "INVALID_SOURCE"
    );
}

#[test]
fn version_one_migration_saves_a_consistent_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("jobs.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('kept'); PRAGMA user_version=1;").unwrap();
    drop(old);
    let mut store = TaskStore::open(&path).unwrap();
    store.save_source(endpoint(), 0, 18, true, now()).unwrap();
    drop(store);
    let backups: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains("pre-v2")
                .then_some(path)
        })
        .collect();
    assert_eq!(backups.len(), 1);
    let backup = rusqlite::Connection::open(&backups[0]).unwrap();
    let version: i64 = backup
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    let marker: String = backup
        .query_row("SELECT value FROM marker", [], |row| row.get(0))
        .unwrap();
    assert_eq!((version, marker.as_str()), (1, "kept"));
}

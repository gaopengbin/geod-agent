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
    SourceDescriptor { elevation_encoding: None, schema_version: SchemaVersion::V0_1,
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

#[test]
fn expired_pending_plan_is_revalidated_in_place_before_approval() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("revalidate.sqlite");
    let mut store = TaskStore::open(&path).unwrap();
    let original = store.create_plan(spec(), &source(), now()).unwrap();
    let later = now() + chrono::Duration::hours(12);
    assert_eq!(store.grant_approval(&original.plan_id, &original.plan.plan_hash,
        "local-user", "test-ui", later).unwrap_err().code, "PLAN_STALE");
    let refreshed = store.revalidate_plan(&original.plan_id, &original.plan.plan_hash, &source(), later).unwrap();
    let mut expected = original.clone();
    expected.plan.expires_at = later + chrono::Duration::minutes(30);
    assert_eq!(refreshed, expected);
    assert_eq!(store.revalidate_plan(&original.plan_id, &original.plan.plan_hash, &source(), later).unwrap(), refreshed);
    drop(store);
    let mut store = TaskStore::open(&path).unwrap();
    assert_eq!(store.get_plan(&original.plan_id).unwrap(), Some(refreshed));
    let approval = store.grant_approval(&original.plan_id, &original.plan.plan_hash,
        "local-user", "test-ui", later).unwrap();
    let job = store.start_job(&original.plan_id, &original.plan.plan_hash, &approval.approval_id,
        "renewed-start", &source(), later).unwrap();
    assert_eq!(job.plan_id, original.plan_id);
    assert_eq!(job.plan_hash, original.plan.plan_hash);
    assert_eq!(job.state, JobState::Queued);
    assert_eq!(store.list_jobs(10).unwrap().len(), 1);
}

#[test]
fn revalidation_rejects_changed_inputs_and_never_changes_an_existing_job_plan() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(&dir.path().join("revalidate.sqlite")).unwrap();
    let original = store.create_plan(spec(), &source(), now()).unwrap();
    let later = now() + chrono::Duration::hours(12);
    let mut changed_source = source();
    changed_source.config_revision = "v2".into();
    assert_eq!(store.revalidate_plan(&original.plan_id, &original.plan.plan_hash, &changed_source, later).unwrap_err().code, "PLAN_STALE");
    assert_eq!(store.revalidate_plan(&original.plan_id, "wrong-hash", &source(), later).unwrap_err().code, "PLAN_STALE");
    assert_eq!(store.get_plan(&original.plan_id).unwrap(), Some(original.clone()));
    assert!(store.job_for_plan(&original.plan_id).unwrap().is_none());
    let approval = store.grant_approval(&original.plan_id, &original.plan.plan_hash,
        "local-user", "test-ui", now()).unwrap();
    let job = store.start_job(&original.plan_id, &original.plan.plan_hash, &approval.approval_id,
        "existing-job", &source(), now()).unwrap();
    assert_eq!(store.revalidate_plan(&original.plan_id, &original.plan.plan_hash, &source(), later).unwrap_err().code, "JOB_STATE_CONFLICT");
    assert_eq!(store.get_plan(&original.plan_id).unwrap(), Some(original));
    assert_eq!(store.get_job(&job.job_id).unwrap(), Some(job));
}

fn spec() -> TaskSpec {
    TaskSpec {
        schema_version: SchemaVersion::V0_1,
        kind: TaskKind::Imagery,
        source_id: "synthetic".into(),
        bounds: [-1.0, 1.0, 1.0, 2.0],
        boundary: None,
        zoom_levels: vec![1],
        output_formats: vec![OutputFormat::GeoTiff],
        export_options: None,
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
fn model_tool_plan_replay_keeps_the_original_output_and_approval_target() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tool-plans.sqlite");
    let key = "generation-12345678:call_12345678";
    let mut store = TaskStore::open(&path).unwrap();
    assert!(store.get_plan_for_tool_execution(key).unwrap().is_none());

    let first = store
        .create_plan_for_tool_execution(key, spec(), &source(), now())
        .unwrap();
    let approval = store
        .grant_approval(
            &first.plan_id,
            &first.plan.plan_hash,
            "local-user",
            "workspace-0.1",
            now(),
        )
        .unwrap();
    drop(store);

    let mut reopened = TaskStore::open(&path).unwrap();
    assert_eq!(
        reopened.get_plan_for_tool_execution(key).unwrap(),
        Some(first.clone())
    );
    let mut changed = spec();
    changed.output_directory = dir
        .path()
        .join("different-output")
        .to_string_lossy()
        .into_owned();
    let replay = reopened
        .create_plan_for_tool_execution(key, changed.clone(), &source(), now())
        .unwrap();
    assert_eq!(replay, first);
    assert_eq!(approval.plan_id, replay.plan_id);
    let other_call = reopened
        .create_plan_for_tool_execution(
            "generation-12345678:call_87654321",
            changed,
            &source(),
            now(),
        )
        .unwrap();
    assert_ne!(other_call.plan_id, first.plan_id);
    assert_ne!(
        other_call.plan.spec.output_directory,
        first.plan.spec.output_directory
    );
    assert_eq!(
        reopened
            .get_plan_for_tool_execution("bad id")
            .unwrap_err()
            .code,
        "INVALID_TOOL_EXECUTION_ID"
    );
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
    assert!(store.job_for_plan(&stored.plan_id).unwrap().is_none());
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
    assert_eq!(
        reopened.job_for_plan(&stored.plan_id).unwrap(),
        Some(job.clone())
    );
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
    let repeated = reopened
        .start_job(
            &stored.plan_id,
            &stored.plan.plan_hash,
            &approval.approval_id,
            "request-2",
            &source(),
            now(),
        )
        .unwrap();
    assert_eq!(repeated.job_id, job.job_id);
    let second_approval = reopened
        .grant_approval(
            &stored.plan_id,
            &stored.plan.plan_hash,
            "local-user",
            "workspace-0.1",
            now(),
        )
        .unwrap();
    let recovered = reopened
        .start_job(
            &stored.plan_id,
            &stored.plan.plan_hash,
            &second_approval.approval_id,
            "request-3",
            &source(),
            now(),
        )
        .unwrap();
    assert_eq!(recovered.job_id, job.job_id);
    assert_eq!(reopened.list_jobs(10).unwrap().len(), 1);
    assert_eq!(reopened.events_after(&job.job_id, 0, 10).unwrap().len(), 1);
    let mut other_spec = spec();
    other_spec.output_directory = dir
        .path()
        .join("other-output")
        .to_string_lossy()
        .into_owned();
    let other_plan = reopened.create_plan(other_spec, &source(), now()).unwrap();
    let other_approval = reopened
        .grant_approval(
            &other_plan.plan_id,
            &other_plan.plan.plan_hash,
            "local-user",
            "workspace-0.1",
            now(),
        )
        .unwrap();
    assert_eq!(
        reopened
            .start_job(
                &other_plan.plan_id,
                &other_plan.plan.plan_hash,
                &other_approval.approval_id,
                "request-1",
                &source(),
                now(),
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
        processing_stage: None,
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
    let disk_full = JobEvent {
        seq: 4,
        error_code: Some("DISK_INSUFFICIENT".into()),
        ..failure.clone()
    };
    conn.execute(
        "INSERT INTO job_events(job_id,seq,body) VALUES (?1,4,?2)",
        (&job.job_id, serde_json::to_string(&disk_full).unwrap()),
    )
    .unwrap();
    let retried_after_freeing_space = reopened.retry_failed_job(&job.job_id).unwrap();
    assert_eq!(retried_after_freeing_space.job_id, job.job_id);
    assert_eq!(retried_after_freeing_space.state, JobState::Queued);

    conn.execute(
        "UPDATE jobs SET state='failed', version=6 WHERE job_id=?1",
        [&job.job_id],
    )
    .unwrap();
    let stale = JobEvent {
        seq: 6,
        error_code: Some("PLAN_STALE".into()),
        ..failure
    };
    conn.execute(
        "INSERT INTO job_events(job_id,seq,body) VALUES (?1,6,?2)",
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
    HttpSource { subdomains: Vec::new(), coordinate_system: None, elevation_encoding: None, id: "authorized-example".into(),
        name: "Authorized example".into(),
        attribution: "Example owner".into(),
        license: "Owner permits bulk use".into(),
        url_template: "https://example.org/tiles/{z}/{x}/{y}.png".into(),
        scheme: HttpTileScheme::XYZ,
        tile_size: 256,
        network_policy: NetworkPolicy::PublicHttps,
        min_interval_ms: 200, authentication: None, runtime_token: None,
    }
}

#[test]
fn source_configuration_persists_without_permission_gate_and_protects_existing_ids() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("jobs.sqlite");
    let mut store = TaskStore::open(&path).unwrap();
    let descriptor = store.save_source(endpoint(), 0, 18, false, now()).unwrap();
    assert_eq!(store.save_source(endpoint(), 0, 18, false, now()).unwrap().config_revision, descriptor.config_revision);
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
    assert_eq!(reopened.save_source(edited.clone(), 0, 18, false, now()).unwrap_err().code, "SOURCE_EXISTS");
    assert_eq!(reopened.get_registered_source("authorized-example").unwrap().unwrap().endpoint.url_template, endpoint().url_template);
    let revised = reopened.save_source(edited, 0, 18, true, now()).unwrap();
    assert_ne!(revised.config_revision, descriptor.config_revision);
    assert_eq!(reopened.list_sources().unwrap().len(), 1);
}

#[test]
fn optional_source_metadata_does_not_block_configuration_or_planning() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(&dir.path().join("jobs.sqlite")).unwrap();
    let mut source = endpoint();
    source.attribution.clear(); source.license.clear();
    let saved = store.save_source(source, 0, 18, false, now()).unwrap();
    assert!(saved.attribution.is_empty() && saved.license.is_empty());
    let mut task = spec(); task.source_id = saved.id.clone();
    assert!(store.create_plan_for_tool_execution("optional-meta:plan", task, &saved, now()).is_ok());
    let old = serde_json::json!({"descriptor":saved,"endpoint":endpoint(),"permissionConfirmedAt":now()});
    let parsed: geod_task_engine::ledger::RegisteredSource = serde_json::from_value(old).unwrap();
    assert_eq!(parsed.configured_at, now());
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
        "SOURCE_TOKEN_IN_URL"
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

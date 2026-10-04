//! Optional diagnosis against a temporary SQLite backup, never the user's live ledger.
use chrono::Utc;
use geod_task_engine::ledger::{JobState, TaskStore};
use std::path::PathBuf;

#[test]
#[ignore = "requires GEOD_TEST_DB_COPY pointing to a temporary database backup"]
fn real_expired_pending_plans_keep_their_identity_and_can_be_approved() {
    let path = PathBuf::from(std::env::var("GEOD_TEST_DB_COPY").expect("temporary backup path required"));
    assert!(path.canonicalize().unwrap().starts_with(std::env::temp_dir().canonicalize().unwrap()),
        "Only a database copy in the temporary directory may be used");
    let ids: Vec<String> = {
        let conn = rusqlite::Connection::open(&path).unwrap();
        let mut query = conn.prepare("SELECT plan_id FROM plans WHERE NOT EXISTS(SELECT 1 FROM jobs WHERE jobs.plan_id=plans.plan_id) ORDER BY rowid DESC LIMIT 3").unwrap();
        query.query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
    };
    assert!(!ids.is_empty());
    let mut store = TaskStore::open(&path).unwrap();
    for id in ids {
        let original = store.get_plan(&id).unwrap().unwrap();
        let source = store.get_registered_source(&original.plan.spec.source_id).unwrap().unwrap();
        let now = Utc::now();
        assert!(original.plan.expires_at < now);
        let refreshed = store.revalidate_plan(&id, &original.plan.plan_hash, &source.descriptor, now).unwrap();
        let mut expected = original.clone();
        expected.plan.expires_at = refreshed.plan.expires_at;
        assert_eq!(refreshed, expected);
        assert!(refreshed.plan.expires_at > now);
        let approval = store.grant_approval(&id, &original.plan.plan_hash, "fixture-user", "snapshot-test", now).unwrap();
        let job = store.start_job(&id, &original.plan.plan_hash, &approval.approval_id, &format!("snapshot-{id}"), &source.descriptor, now).unwrap();
        assert_eq!(job.plan_id, id);
        assert_eq!(job.state, JobState::Queued);
        println!("Revalidated {} tiles: original ID, hash, geometry and destination unchanged; approval and queue succeeded in the copy", original.plan.total_tiles);
    }
}

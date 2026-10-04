//! Read-only diagnostic for a persisted plan; prints comparisons, never credentials.
use geod_task_engine::{ledger::TaskStore, plan};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let store = TaskStore::open(std::path::Path::new(&args[1])).unwrap();
    let stored = store.get_plan(&args[2]).unwrap().unwrap();
    let source = store.get_registered_source(&stored.plan.spec.source_id).unwrap().unwrap();
    let refreshed = plan(stored.plan.spec.clone(), &source.descriptor, chrono::Utc::now()).unwrap();
    println!("{}", serde_json::json!({
        "planHashMatches": refreshed.plan_hash == stored.plan.plan_hash,
        "specMatches": refreshed.spec == stored.plan.spec,
        "tileGridsMatch": refreshed.tile_grids == stored.plan.tile_grids,
        "sourceFingerprintMatches": refreshed.source_fingerprint == stored.plan.source_fingerprint,
        "sourceRevisionMatches": source.endpoint.configuration_revision() == source.descriptor.config_revision,
        "nameMatches": source.endpoint.name == source.descriptor.display_name,
        "idMatches": source.endpoint.id == source.descriptor.id,
        "attributionMatches": source.endpoint.attribution == source.descriptor.attribution,
        "licenseMatches": source.endpoint.license == source.descriptor.license,
        "tileSizeMatches": source.endpoint.tile_size == source.descriptor.tile_size,
    }));
}

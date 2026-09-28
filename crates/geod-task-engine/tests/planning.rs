use chrono::{TimeZone, Utc};
use geod_task_engine::{
    plan, OutputFormat, ResourceLimits, SchemaVersion, SourceDescriptor, TaskKind, TaskSpec,
    TileScheme,
};

fn source() -> SourceDescriptor {
    SourceDescriptor {
        schema_version: SchemaVersion::V0_1,
        id: "synthetic-xyz".into(),
        display_name: "Synthetic XYZ fixture".into(),
        attribution: "Generated pixels for tests".into(),
        license: "Synthetic test data".into(),
        bulk_download_allowed: true,
        scheme: TileScheme::XYZ,
        tile_size: 256,
        min_zoom: 0,
        max_zoom: 22,
        config_revision: "fixture-v1".into(),
        credential_ref_version: None,
    }
}

fn spec() -> TaskSpec {
    TaskSpec {
        schema_version: SchemaVersion::V0_1,
        kind: TaskKind::Imagery,
        source_id: "synthetic-xyz".into(),
        bounds: [-1.0, 1.0, 1.0, 2.0],
        zoom_levels: vec![1],
        output_formats: vec![OutputFormat::GeoTiff],
        output_directory: std::env::temp_dir()
            .join("geod-agent-fixture")
            .to_string_lossy()
            .into_owned(),
        limits: ResourceLimits {
            max_tiles: 16,
            max_decoded_rgba_bytes: 16 * 1024 * 1024,
        },
    }
}

fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 28, 0, 0, 0).unwrap()
}

#[test]
fn plans_legacy_grid_and_normalizes_sets() {
    let mut request = spec();
    request.zoom_levels = vec![1, 0, 1];
    request.output_formats = vec![
        OutputFormat::Mbtiles,
        OutputFormat::GeoTiff,
        OutputFormat::Mbtiles,
    ];
    let planned = plan(request, &source(), now()).unwrap();
    assert_eq!(planned.spec.zoom_levels, [0, 1]);
    assert_eq!(planned.total_tiles, 3);
    assert_eq!(planned.tile_grids[1].tile_count, 2);
    assert_eq!(planned.tile_grids[1].pixel_width, 512);
    assert_eq!(planned.decoded_rgba_bytes, 3 * 256 * 256 * 4);
    assert_eq!(
        planned.expires_at.timestamp() - planned.created_at.timestamp(),
        1800
    );
    assert_eq!(planned.plan_hash.len(), 64);
}

#[test]
fn plan_hash_is_stable_and_sensitive_to_effective_changes() {
    let base = plan(spec(), &source(), now()).unwrap();
    let same_later = plan(spec(), &source(), now() + chrono::Duration::minutes(1)).unwrap();
    assert_eq!(base.plan_hash, same_later.plan_hash);

    let mut reordered = spec();
    reordered.zoom_levels = vec![1, 1];
    reordered.output_formats = vec![OutputFormat::GeoTiff, OutputFormat::GeoTiff];
    assert_eq!(
        base.plan_hash,
        plan(reordered, &source(), now()).unwrap().plan_hash
    );

    let mut changed = spec();
    changed.output_directory.push_str("-changed");
    assert_ne!(
        base.plan_hash,
        plan(changed, &source(), now()).unwrap().plan_hash
    );

    let mut changed_source = source();
    changed_source.config_revision = "fixture-v2".into();
    assert_ne!(
        base.plan_hash,
        plan(spec(), &changed_source, now()).unwrap().plan_hash
    );

    changed_source = source();
    changed_source.credential_ref_version = Some("rotated".into());
    assert_ne!(
        base.plan_hash,
        plan(spec(), &changed_source, now()).unwrap().plan_hash
    );

    let mut changed = spec();
    changed.bounds[0] -= 0.001;
    assert_ne!(
        base.plan_hash,
        plan(changed, &source(), now()).unwrap().plan_hash
    );
}

#[test]
fn denies_unlicensed_or_mismatched_sources() {
    let mut denied = source();
    denied.bulk_download_allowed = false;
    assert_eq!(
        plan(spec(), &denied, now()).unwrap_err().code,
        "SOURCE_UNAUTHORIZED"
    );
    denied = source();
    denied.id = "other".into();
    assert_eq!(
        plan(spec(), &denied, now()).unwrap_err().code,
        "SOURCE_UNAUTHORIZED"
    );
}

#[test]
fn rejects_oversized_work_and_bad_bounds_before_any_io() {
    let mut request = spec();
    request.zoom_levels = vec![22];
    assert_eq!(
        plan(request, &source(), now()).unwrap_err().code,
        "RESOURCE_LIMIT"
    );

    let mut request = spec();
    request.bounds = [1.0, 1.0, -1.0, 2.0];
    assert_eq!(
        plan(request, &source(), now()).unwrap_err().code,
        "INVALID_SPEC"
    );

    let mut request = spec();
    request.limits.max_decoded_rgba_bytes = 1;
    assert_eq!(
        plan(request, &source(), now()).unwrap_err().code,
        "RESOURCE_LIMIT"
    );
}

#[test]
fn rejects_traversal_and_unknown_json_fields() {
    let mut request = spec();
    request.output_directory = std::env::temp_dir()
        .join("..")
        .join("unexpected")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        plan(request, &source(), now()).unwrap_err().code,
        "INVALID_SPEC"
    );
    let mut value = serde_json::to_value(spec()).unwrap();
    value["unrecognizedModelArgument"] = serde_json::json!(true);
    assert!(serde_json::from_value::<TaskSpec>(value).is_err());
}

#[test]
fn a_512_pixel_source_scales_decoded_budget() {
    let mut large = source();
    large.tile_size = 512;
    let planned = plan(spec(), &large, now()).unwrap();
    assert_eq!(planned.total_tiles, 2);
    assert_eq!(planned.decoded_rgba_bytes, 2 * 512 * 512 * 4);
}

#[test]
fn checked_in_contracts_match_rust_types() {
    for (saved, generated) in [
        (
            include_str!("../../../contracts/0.1/task-spec.schema.json"),
            geod_task_engine::task_spec_schema(),
        ),
        (
            include_str!("../../../contracts/0.1/source-descriptor.schema.json"),
            geod_task_engine::source_descriptor_schema(),
        ),
        (
            include_str!("../../../contracts/0.1/plan.schema.json"),
            geod_task_engine::plan_schema(),
        ),
    ] {
        let saved: serde_json::Value = serde_json::from_str(saved).unwrap();
        assert_eq!(saved, serde_json::to_value(generated).unwrap());
    }
}

#[test]
fn fixture_parses_and_preserves_legacy_grid() {
    let mut fixture: TaskSpec = serde_json::from_str(include_str!(
        "../../../contracts/0.1/fixtures/legacy-grid-task.json"
    ))
    .unwrap();
    fixture.output_directory = spec().output_directory;
    let source: SourceDescriptor = serde_json::from_str(include_str!(
        "../../../contracts/0.1/fixtures/synthetic-source.json"
    ))
    .unwrap();
    let planned = plan(fixture, &source, now()).unwrap();
    assert_eq!(planned.total_tiles, 2);
    assert_eq!(
        (planned.tile_grids[0].x_min, planned.tile_grids[0].x_max),
        (0, 1)
    );
}

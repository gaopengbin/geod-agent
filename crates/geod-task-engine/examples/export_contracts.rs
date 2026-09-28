use geod_task_engine::{plan_schema, source_descriptor_schema, task_spec_schema};
use std::{fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/0.1");
    fs::create_dir_all(&root)?;
    for (name, schema) in [
        ("task-spec.schema.json", task_spec_schema()),
        ("source-descriptor.schema.json", source_descriptor_schema()),
        ("plan.schema.json", plan_schema()),
    ] {
        fs::write(
            root.join(name),
            format!("{}\n", serde_json::to_string_pretty(&schema)?),
        )?;
    }
    Ok(())
}

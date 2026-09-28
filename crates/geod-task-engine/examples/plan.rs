use geod_task_engine::{plan, SourceDescriptor, TaskSpec};
use std::{env, fs, process};

fn read_json<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    if bytes.len() > 1024 * 1024 {
        return Err(format!("{path}: JSON exceeds 1 MiB"));
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("{path}: {e}"))
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: cargo run --example plan -- <task-spec.json> <source-descriptor.json>");
        process::exit(2);
    }
    let outcome = (|| {
        let task: TaskSpec = read_json(&args[1])?;
        let source: SourceDescriptor = read_json(&args[2])?;
        plan(task, &source, chrono::Utc::now()).map_err(|e| format!("{}: {}", e.code, e.message))
    })();
    match outcome {
        Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap()),
        Err(error) => {
            eprintln!("{error}");
            process::exit(1);
        }
    }
}

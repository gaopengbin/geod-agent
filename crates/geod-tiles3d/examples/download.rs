use geod_tiles3d::{download, inspect, CancellationToken, DownloadRequest};
#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        return Err(
            "Usage: download <tileset URL> <new output directory> [west,south,east,north]".into(),
        );
    }
    let mut request = DownloadRequest::new(&args[1], &args[2]);
    if let Some(value) = args.get(3) {
        let v: Vec<f64> = value
            .split(',')
            .map(|v| v.parse::<f64>().map_err(|e| e.to_string()))
            .collect::<Result<_, _>>()?;
        request.bounds = Some(v.try_into().map_err(|_| "Expected four bounds")?);
    }
    request.proxy = std::env::var("GEOD_TILES_PROXY").ok();
    let bundle = download(request, CancellationToken::new(), |p| {
        eprintln!(
            "{}: {}/{} files, {} bytes",
            p.stage, p.completed, p.discovered, p.bytes
        )
    })
    .await?;
    inspect(std::path::Path::new(&args[2]))?;
    println!("{}", serde_json::to_string_pretty(&bundle).unwrap());
    Ok(())
}

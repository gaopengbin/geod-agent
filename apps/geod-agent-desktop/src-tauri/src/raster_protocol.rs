use std::{collections::HashMap, fs::File, io::{Read, Seek, SeekFrom}, path::{Path, PathBuf}, sync::Mutex};
use tauri::http::{Request, Response};

/// Only files already verified by artifact_raster are registered here.
#[derive(Default)]
pub struct RasterFiles(Mutex<HashMap<String, PathBuf>>);
impl RasterFiles {
    pub fn register(&self, id: String, path: PathBuf) { self.0.lock().unwrap().insert(id, path); }
    pub fn respond(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let origin = request.headers().get("origin").and_then(|v| v.to_str().ok()).unwrap_or("http://tauri.localhost").to_owned();
        let path = self.0.lock().unwrap().get(request.uri().path().trim_start_matches('/')).cloned();
        let response = if request.method() == "OPTIONS" { Response::builder().status(204).body(Vec::new()).unwrap() }
        else if request.method() != "GET" { Response::builder().status(405).body(Vec::new()).unwrap() }
        else if let Some(path) = path { read_range(&path, request.headers().get("range").and_then(|v|v.to_str().ok())) }
        else { Response::builder().status(404).body(Vec::new()).unwrap() };
        let (mut parts, body) = response.into_parts();
        parts.headers.insert("access-control-allow-origin", origin.parse().unwrap());
        parts.headers.insert("access-control-allow-headers", "range".parse().unwrap());
        parts.headers.insert("access-control-expose-headers", "content-range,content-length,accept-ranges".parse().unwrap());
        Response::from_parts(parts, body)
    }
}

fn read_range(path: &Path, range: Option<&str>) -> Response<Vec<u8>> {
    let read = || -> Result<Response<Vec<u8>>, std::io::Error> {
        let mut file = File::open(path)?;
        let size = file.metadata()?.len();
        let selected = range.and_then(|raw|raw.strip_prefix("bytes=")).and_then(|raw|raw.split_once('-')).and_then(|(start,end)| {
            let start = start.parse::<u64>().ok()?;
            let end = if end.is_empty() {size.saturating_sub(1)} else {end.parse::<u64>().ok()?.min(size.saturating_sub(1))};
            (start <= end && start < size).then_some((start,end))
        });
        if range.is_some() && selected.is_none() { return Ok(Response::builder().status(416).header("Content-Range",format!("bytes */{size}")).body(Vec::new()).unwrap()); }
        let (start,end) = selected.unwrap_or((0,size.saturating_sub(1)));
        let length = if size == 0 {0} else {end-start+1};
        file.seek(SeekFrom::Start(start))?;
        let mut bytes=vec![0;length as usize];file.read_exact(&mut bytes)?;
        let mut response=Response::builder().status(if selected.is_some(){206}else{200})
            .header("Content-Type","image/tiff").header("Accept-Ranges","bytes").header("Content-Length",length);
        if selected.is_some() { response=response.header("Content-Range",format!("bytes {start}-{end}/{size}")); }
        Ok(response.body(bytes).unwrap())
    };
    read().unwrap_or_else(|_|Response::builder().status(500).body(Vec::new()).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_are_complete_and_only_registered_files_are_readable() {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("raster.tif");
        let bytes:Vec<u8>=(0..2_200_000).map(|n|(n%251) as u8).collect();std::fs::write(&path,&bytes).unwrap();
        let files=RasterFiles::default();files.register("verified".into(),path);
        let result=files.respond(Request::builder().uri("http://geod-raster.localhost/verified").header("Range","bytes=37-2100036").body(Vec::new()).unwrap());
        assert_eq!(result.status(),206);assert_eq!(result.body(),&bytes[37..2100037]);
        assert_eq!(result.headers()["Content-Range"],"bytes 37-2100036/2200000");
        let denied=files.respond(Request::builder().uri("http://geod-raster.localhost/unregistered").body(Vec::new()).unwrap());assert_eq!(denied.status(),404);
    }
    #[test]
    fn invalid_and_end_ranges_are_handled() {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("raster.tif");std::fs::write(&path,b"0123456789").unwrap();
        for range in ["bytes=10-20","bytes=8-3","bytes=0-1,4-5","nonsense"] { assert_eq!(read_range(&path,Some(range)).status(),416); }
        assert_eq!(read_range(&path,Some("bytes=7-")).body(),b"789");
        assert_eq!(read_range(&path,Some("bytes=7-99")).body(),b"789");
    }
}

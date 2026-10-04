//! Content-addressed, source-revision-scoped cache shared by independent jobs.
use super::*;
pub(super) struct SharedTileCache { root:PathBuf, conn:Connection }
impl SharedTileCache {
    pub(super) fn open(job_root:&Path,source:&HttpSource,overlays:&[OverlaySourceRef]) -> Result<Self,CoreError> {
        let revision=if overlays.is_empty() {source.configuration_revision()} else {
            format!("{:x}",Sha256::digest(serde_json::to_vec(&(source.configuration_revision(),overlays)).map_err(io_error)?))
        };
        let root=job_root.parent().ok_or_else(||CoreError::new("INVALID_CACHE","Cache has no parent"))?.join("shared").join(revision);
        fs::create_dir_all(root.join("blobs")).map_err(io_error)?;
        let conn=Connection::open(root.join("index.sqlite")).map_err(io_error)?;
        conn.busy_timeout(Duration::from_secs(5)).map_err(io_error)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS tiles(zoom INTEGER,x INTEGER,y INTEGER,hash TEXT NOT NULL,bytes INTEGER NOT NULL,saved_at TEXT NOT NULL,PRIMARY KEY(zoom,x,y));").map_err(io_error)?;
        Ok(Self {root,conn})
    }
    pub(super) fn load(&self,z:u8,x:u32,y:u32,size:u16,allow_stale:bool) -> Result<Option<DownloadedTile>,CoreError> {
        let entry:Option<(String,u64,String)>=self.conn.query_row("SELECT hash,bytes,saved_at FROM tiles WHERE zoom=?1 AND x=?2 AND y=?3",params![z,x,y],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(io_error)?;
        let Some((hash,len,saved))=entry else {return Ok(None);};
        if hash.len()!=64 || !hash.bytes().all(|v|v.is_ascii_hexdigit()) {return Ok(None);}
        // A mutable current map is refreshed after seven days. Per-job resume
        // checkpoints remain stable; history sources have distinct revisions.
        if !allow_stale && chrono::DateTime::parse_from_rfc3339(&saved).map_or(true,|t|Utc::now().signed_duration_since(t).num_days()>=7) {return Ok(None);}
        let bytes=fs::read(self.root.join("blobs").join(&hash)).unwrap_or_default();
        if bytes.len() as u64!=len || bytes.len()>MAX_TILE_BYTES || format!("{:x}",Sha256::digest(&bytes))!=hash {return Ok(None);}
        let image=match image::load_from_memory(&bytes) {Ok(image) if image.width()==u32::from(size) && image.height()==u32::from(size)=>image.to_rgba8(),_=>return Ok(None)};
        Ok(Some(DownloadedTile {image,bytes}))
    }
    pub(super) fn save(&self,z:u8,x:u32,y:u32,bytes:&[u8]) -> Result<(),CoreError> {
        let hash=format!("{:x}",Sha256::digest(bytes));let target=self.root.join("blobs").join(&hash);
        // A corrupt file may already occupy its content-addressed name. Keep a
        // valid concurrent writer's bytes, but atomically replace bad contents.
        if fs::read(&target).map_or(true, |stored| stored.as_slice()!=bytes) {
            let mut temporary=tempfile::NamedTempFile::new_in(self.root.join("blobs")).map_err(io_error)?;
            use std::io::Write;temporary.write_all(bytes).map_err(io_error)?;
            temporary.as_file().sync_all().map_err(io_error)?;
            temporary.persist(&target).map_err(io_error)?;
        }
        self.conn.execute("INSERT OR REPLACE INTO tiles VALUES(?1,?2,?3,?4,?5,?6)",params![z,x,y,hash,bytes.len(),Utc::now().to_rfc3339()]).map_err(io_error)?;
        Ok(())
    }
}

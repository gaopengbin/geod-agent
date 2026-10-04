//! Inspect and migrate GeoD Agent tile checkpoints without deleting originals.
//! No URL guessing: the caller supplies the ledger-bound source and plan.
use crate::imagery::{CoreError, HttpSource, OverlaySourceRef};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}, time::Duration};

const MAX_TILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInventory {
    pub job_caches: Vec<JobCacheSummary>,
    pub shared_caches: Vec<SharedCacheSummary>,
    pub total_bytes: u64,
    pub unreadable_entries: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCacheSummary {
    pub job_id: String,
    pub tile_count: u64,
    pub bytes: u64,
    pub source_revision: Option<String>,
    pub binding_present: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedCacheSummary {
    pub revision: String,
    pub tile_count: u64,
    pub bytes: u64,
    pub expired_tiles: u64,
}
#[derive(Clone, Debug)]
pub struct MigrationJob {
    pub job_id: String,
    pub plan_hash: String,
    pub source: HttpSource,
    pub overlays: Vec<OverlaySourceRef>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheProgress {
    pub phase: String,
    pub total: u64,
    pub checked: u64,
    pub migrated: u64,
    pub skipped: u64,
    pub invalid: u64,
    pub bytes: u64,
    pub current_job: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheLocation { pub directory: String, pub previous_directory: Option<String> }

/// The location is an execution preference, so it does not change plan hashes.
pub fn cache_root_for_database(db_path: &Path) -> Result<PathBuf, CoreError> {
    let parent = db_path.parent().ok_or_else(||fail("数据库目录无效"))?;
    let settings = parent.join("cache-location.json");
    if !settings.exists() { return Ok(parent.join("tile-cache")); }
    let location: CacheLocation=serde_json::from_slice(&fs::read(settings).map_err(fail)?).map_err(fail)?;
    let root=PathBuf::from(location.directory);
    if !root.is_absolute() || root.components().any(|p| matches!(p,std::path::Component::ParentDir)) { return Err(fail("缓存设置路径无效")); }
    if root.exists() { checked_root(&root)?; }
    Ok(root)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelocationPreflight {
    pub source_path: String, pub target_path: String,
    pub file_count: u64, pub bytes: u64, pub available_bytes: u64,
    pub blockers: Vec<String>,
}
fn collect_files(root: &Path, directory: &Path, files: &mut Vec<(PathBuf,u64)>) -> Result<(),CoreError> {
    let directory=checked_root(directory)?;
    if !directory.starts_with(root) { return Err(fail("缓存路径超出目录")); }
    for entry in fs::read_dir(directory).map_err(fail)? {
        let entry=entry.map_err(fail)?;
        let meta=fs::symlink_metadata(entry.path()).map_err(fail)?;
        if meta.file_type().is_symlink() { return Err(fail("缓存目录含链接，不能迁移")); }
        if meta.is_dir() { collect_files(root,&entry.path(),files)?; }
        else if meta.is_file() { files.push((entry.path().strip_prefix(root).map_err(fail)?.to_path_buf(),meta.len())); }
        else { return Err(fail("缓存目录包含非普通文件")); }
        if files.len()>5_000_000 { return Err(fail("缓存文件超过单次迁移上限")); }
    }
    Ok(())
}
fn canonical_target(target: &Path) -> Result<PathBuf,CoreError> {
    if !target.is_absolute() || target.components().any(|p|matches!(p,std::path::Component::ParentDir)) { return Err(fail("目标必须是绝对路径")); }
    let name=target.file_name().ok_or_else(||fail("目标不能是磁盘根目录"))?;
    let parent=checked_root(target.parent().ok_or_else(||fail("目标父目录无效"))?)?;
    Ok(parent.join(name))
}
pub fn relocation_preflight(db_path: &Path, target: &Path) -> Result<RelocationPreflight,CoreError> {
    let source=cache_root_for_database(db_path)?;
    let target=canonical_target(target)?;
    let mut blockers=Vec::new();
    let mut files=Vec::new();
    let source=if source.exists(){checked_root(&source)?}else{source};
    if target==source || target.starts_with(&source) || source.starts_with(&target) { blockers.push("目标不能与当前目录相同或互相包含".into()); }
    if target.exists() { blockers.push("目标目录已经存在，请选择新的目录名称".into()); }
    if source.exists() { collect_files(&source,&source,&mut files)?; }
    let bytes=files.iter().map(|(_,n)|*n).sum::<u64>();
    let available_bytes=fs4::available_space(target.parent().ok_or_else(||fail("目标父目录无效"))?).map_err(fail)?;
    if available_bytes<bytes.saturating_add(32*1024*1024) { blockers.push("目标磁盘空间不足，需要缓存大小及 32 MB 余量".into()); }
    Ok(RelocationPreflight { source_path:source.to_string_lossy().into_owned(),target_path:target.to_string_lossy().into_owned(),file_count:files.len() as u64,bytes,available_bytes,blockers })
}
/// Copy into an owned staging directory, hash both sides, then commit a new
/// location. On any failure the old directory remains the active one.
pub fn relocate(db_path: &Path, target: &Path, cancel: &AtomicBool, mut notify: impl FnMut(&CacheProgress)) -> Result<CacheProgress,CoreError> {
    let check=relocation_preflight(db_path,target)?;
    if !check.blockers.is_empty() { return Err(fail(check.blockers.join("；"))); }
    let source=PathBuf::from(check.source_path);let target=PathBuf::from(check.target_path);
    let parent=target.parent().ok_or_else(||fail("目标父目录无效"))?;
    let stage=parent.join(format!(".geod-cache-move-{}",uuid::Uuid::new_v4()));
    fs::create_dir(&stage).map_err(fail)?;
    let mut progress=CacheProgress { phase:"relocating".into(),total:check.file_count,..Default::default() };
    let result=(|| {
        let mut files=Vec::new();
        if source.exists(){collect_files(&source,&source,&mut files)?;}
        if files.len() as u64!=check.file_count || files.iter().map(|(_,n)|*n).sum::<u64>()!=check.bytes {return Err(fail("缓存内容已变化，请重新预检"));}
        for (relative,expected_len) in files {
            cancellation(cancel)?;
            let input_path=contained_file(&source,&source.join(&relative))?;
            let metadata=fs::metadata(&input_path).map_err(fail)?;
            let output_path=stage.join(&relative);
            fs::create_dir_all(output_path.parent().ok_or_else(||fail("输出目录无效"))?).map_err(fail)?;
            let mut input=fs::File::open(input_path).map_err(fail)?;
            let mut output=fs::OpenOptions::new().write(true).create_new(true).open(&output_path).map_err(fail)?;
            let mut hash=Sha256::new();let mut copied=0;let mut buffer=vec![0u8;1024*1024];
            loop { cancellation(cancel)?;let count=input.read(&mut buffer).map_err(fail)?;if count==0{break;} output.write_all(&buffer[..count]).map_err(fail)?;hash.update(&buffer[..count]);copied+=count as u64;progress.bytes+=count as u64;notify(&progress); }
            output.sync_all().map_err(fail)?;
            output.set_times(fs::FileTimes::new().set_modified(metadata.modified().map_err(fail)?)).map_err(fail)?;drop(output);
            if copied!=expected_len || input.metadata().map_err(fail)?.modified().map_err(fail)?!=metadata.modified().map_err(fail)? {return Err(fail("复制过程中源缓存变化，未切换目录"));}
            let mut verify=fs::File::open(output_path).map_err(fail)?;let mut check_hash=Sha256::new();
            loop {cancellation(cancel)?;let count=verify.read(&mut buffer).map_err(fail)?;if count==0{break;}check_hash.update(&buffer[..count]);}
            if hash.finalize()!=check_hash.finalize(){return Err(fail("复制文件哈希校验失败"));}
            progress.checked+=1;progress.migrated+=1;notify(&progress);
        }
        cancellation(cancel)?;
        // No running cache users are allowed by the native access gate. SQLite
        // main/WAL files were copied as one stable snapshot; open them to check.
        for entry in inventory(&stage)?.job_caches {
            let db=open_read(&stage.join(entry.job_id).join("tiles.sqlite"))?;
            let verdict:String=db.query_row("PRAGMA quick_check",[],|r|r.get(0)).map_err(fail)?;
            if verdict!="ok"{return Err(fail("目标缓存数据库校验失败"));}
        }
        let final_inventory=inventory(&stage)?;
        if final_inventory.unreadable_entries>0{return Err(fail("目标存在不可读缓存数据库，未切换目录"));}
        for entry in final_inventory.shared_caches {
            let db=open_read(&stage.join("shared").join(entry.revision).join("index.sqlite"))?;
            let verdict:String=db.query_row("PRAGMA quick_check",[],|r|r.get(0)).map_err(fail)?;
            if verdict!="ok"{return Err(fail("目标共享缓存数据库校验失败"));}
        }
        cancellation(cancel)?;progress.phase="switching".into();notify(&progress);
        fs::rename(&stage,&target).map_err(fail)?;
        let settings_parent=db_path.parent().ok_or_else(||fail("数据库目录无效"))?;
        let mut settings=tempfile::NamedTempFile::new_in(settings_parent).map_err(fail)?;
        serde_json::to_writer(&mut settings,&CacheLocation {directory:target.to_string_lossy().into_owned(),previous_directory:Some(source.to_string_lossy().into_owned())}).map_err(fail)?;
        settings.as_file().sync_all().map_err(fail)?;
        settings.persist(settings_parent.join("cache-location.json")).map_err(fail)?;
        progress.phase="completed".into();notify(&progress);Ok(progress.clone())
    })();
    if result.is_err() && stage.exists() {
        // This random directory was created exclusively by this invocation.
        if let Ok(actual)=fs::canonicalize(&stage) {if actual.parent()==Some(parent) {let _=fs::remove_dir_all(actual);}}
    }
    result
}

fn fail(message: impl ToString) -> CoreError { CoreError::new("CACHE_ERROR", message.to_string()) }
fn valid_hash(value: &str) -> bool { value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()) }
fn open_read(path: &Path) -> Result<Connection, CoreError> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(fail)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(fail)?;
    Ok(db)
}
fn checked_root(path: &Path) -> Result<PathBuf, CoreError> {
    if !path.is_absolute() || path.components().any(|p| matches!(p, std::path::Component::ParentDir)) {
        return Err(fail("缓存目录必须是绝对路径"));
    }
    let meta = fs::symlink_metadata(path).map_err(fail)?;
    if !meta.is_dir() || meta.file_type().is_symlink() { return Err(fail("缓存目录不能是链接")); }
    fs::canonicalize(path).map_err(fail)
}
fn contained_file(root: &Path, path: &Path) -> Result<PathBuf, CoreError> {
    let meta = fs::symlink_metadata(path).map_err(fail)?;
    if !meta.is_file() || meta.file_type().is_symlink() { return Err(fail("缓存文件不能是链接")); }
    let actual = fs::canonicalize(path).map_err(fail)?;
    if !actual.starts_with(root) { return Err(fail("缓存文件超出目录")); }
    Ok(actual)
}
fn physical_bytes(root: &Path, path: &Path) -> Result<u64, CoreError> {
    // Only known cache layout levels are walked, never arbitrary links.
    let path = checked_root(path)?;
    if !path.starts_with(root) { return Err(fail("缓存目录超出根目录")); }
    let mut total = 0u64;
    for entry in fs::read_dir(&path).map_err(fail)? {
        let entry = entry.map_err(fail)?;
        let meta = fs::symlink_metadata(entry.path()).map_err(fail)?;
        if meta.file_type().is_symlink() { return Err(fail("缓存包含链接")); }
        if meta.is_file() { total = total.saturating_add(meta.len()); }
        else if entry.file_name() == "blobs" { total = total.saturating_add(physical_bytes(root, &entry.path())?); }
    }
    Ok(total)
}
fn binding(db: &Connection) -> Result<Option<String>, CoreError> {
    db.query_row("SELECT value FROM metadata WHERE key='binding'", [], |r| r.get(0)).optional().map_err(fail)
}

pub fn inventory(cache_parent: &Path) -> Result<CacheInventory, CoreError> {
    if !cache_parent.exists() { return Ok(CacheInventory::default()); }
    let root = checked_root(cache_parent)?;
    let mut result = CacheInventory::default();
    for entry in fs::read_dir(&root).map_err(fail)? {
        let entry = entry.map_err(fail)?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if uuid::Uuid::parse_str(&id).is_err() { continue; }
        let read = || -> Result<JobCacheSummary, CoreError> {
            let folder = checked_root(&entry.path())?;
            if !folder.starts_with(&root) { return Err(fail("缓存路径无效")); }
            let db = open_read(&contained_file(&root, &folder.join("tiles.sqlite"))?)?;
            let count = db.query_row("SELECT count(*) FROM tiles", [], |r| r.get(0)).map_err(fail)?;
            let binding = binding(&db)?;
            let source_revision = binding.as_deref().and_then(|s| s.split(':').nth(1)).filter(|s| valid_hash(s)).map(str::to_string);
            Ok(JobCacheSummary { job_id: id.clone(), tile_count: count, bytes: physical_bytes(&root, &folder)?, source_revision, binding_present: binding.is_some() })
        };
        match read() { Ok(entry) => { result.total_bytes += entry.bytes; result.job_caches.push(entry); }, Err(_) => result.unreadable_entries += 1 }
    }
    let shared = root.join("shared");
    if shared.exists() {
        let shared = checked_root(&shared)?;
        if !shared.starts_with(&root) { return Err(fail("共享缓存路径无效")); }
        for entry in fs::read_dir(shared).map_err(fail)? {
            let entry = entry.map_err(fail)?;
            let revision = entry.file_name().to_string_lossy().into_owned();
            if !valid_hash(&revision) { continue; }
            let read = || -> Result<SharedCacheSummary, CoreError> {
                let folder = checked_root(&entry.path())?;
                let db = open_read(&contained_file(&root, &folder.join("index.sqlite"))?)?;
                let (tile_count, expired_tiles) = db.query_row("SELECT count(*), coalesce(sum(CASE WHEN julianday(saved_at) IS NULL OR julianday(saved_at) <= julianday('now', '-7 days') THEN 1 ELSE 0 END),0) FROM tiles", [], |r| Ok((r.get(0)?, r.get(1)?))).map_err(fail)?;
                Ok(SharedCacheSummary { revision: revision.clone(), tile_count, bytes: physical_bytes(&root, &folder)?, expired_tiles })
            };
            match read() { Ok(entry) => { result.total_bytes += entry.bytes; result.shared_caches.push(entry); }, Err(_) => result.unreadable_entries += 1 }
        }
    }
    result.job_caches.sort_by(|a,b| a.job_id.cmp(&b.job_id));
    result.shared_caches.sort_by(|a,b| a.revision.cmp(&b.revision));
    Ok(result)
}

fn warn(progress: &mut CacheProgress, text: String) {
    progress.invalid += 1;
    if progress.warnings.len() < 20 { progress.warnings.push(text); }
}
fn cancellation(cancel: &AtomicBool) -> Result<(), CoreError> {
    if cancel.load(Ordering::Relaxed) { Err(CoreError::new("CANCELLED", "缓存操作已取消")) } else { Ok(()) }
}
fn validated_tile(root: &Path, path: &Path, hash: &str, expected_bytes: u64, tile_size: Option<u16>) -> Result<Vec<u8>, CoreError> {
    if !valid_hash(hash) || expected_bytes == 0 || expected_bytes > MAX_TILE_BYTES { return Err(fail("瓦片索引的哈希或大小无效")); }
    let path = contained_file(root, path)?;
    if fs::metadata(&path).map_err(fail)?.len() != expected_bytes { return Err(fail("瓦片大小不匹配")); }
    let bytes = fs::read(path).map_err(fail)?;
    if bytes.len() as u64 != expected_bytes || format!("{:x}",Sha256::digest(&bytes)) != hash { return Err(fail("瓦片 SHA-256 不匹配")); }
    let reader = image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format().map_err(fail)?;
    let (width, height) = reader.into_dimensions().map_err(fail)?;
    let size = tile_size.map(u32::from).unwrap_or(width);
    if size == 0 || size > 4096 || width != size || height != size { return Err(fail("瓦片像素尺寸不匹配")); }
    // The decoder verifies the whole image after checking dimensions, bounding memory.
    image::load_from_memory(&bytes).map_err(fail)?;
    Ok(bytes)
}
fn shared_revision(job: &MigrationJob) -> Result<String, CoreError> {
    if job.overlays.is_empty() { Ok(job.source.configuration_revision()) }
    else { Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(&(job.source.configuration_revision(), &job.overlays)).map_err(fail)?))) }
}
fn expected_binding(job: &MigrationJob) -> Result<String, CoreError> {
    let base = format!("{}:{}", job.plan_hash, job.source.configuration_revision());
    if job.overlays.is_empty() { Ok(base) }
    else { Ok(format!("{base}:{:x}",Sha256::digest(serde_json::to_vec(&job.overlays).map_err(fail)?))) }
}

/// Verify old checkpoints and optionally publish into the source-revision cache.
/// Invalid files are reported and preserved; valid files are copied atomically.
pub fn migrate_jobs(cache_parent: &Path, jobs: &[MigrationJob], cancel: &AtomicBool, mut notify: impl FnMut(&CacheProgress)) -> Result<CacheProgress, CoreError> {
    if !cache_parent.exists() { return Ok(CacheProgress { phase: "completed".into(), ..Default::default() }); }
    let root = checked_root(cache_parent)?;
    let mut progress = CacheProgress { phase: "migrating".into(), ..Default::default() };
    for job in jobs {
        cancellation(cancel)?;
        if uuid::Uuid::parse_str(&job.job_id).is_err() || !valid_hash(&job.plan_hash) { return Err(fail("任务绑定无效")); }
        let folder = root.join(&job.job_id);
        if !folder.exists() { continue; }
        let folder = checked_root(&folder)?;
        if !folder.starts_with(&root) { return Err(fail("任务缓存超出目录")); }
        let db = open_read(&contained_file(&root, &folder.join("tiles.sqlite"))?)?;
        if binding(&db)?.as_deref() != Some(expected_binding(job)?.as_str()) {
            warn(&mut progress, format!("{}：计划或图源版本已改变，未迁移", job.job_id)); notify(&progress); continue;
        }
        progress.total += db.query_row("SELECT count(*) FROM tiles", [], |r| r.get::<_,u64>(0)).map_err(fail)?;
        progress.current_job = Some(job.job_id.clone());
        let shared_parent = root.join("shared");
        fs::create_dir_all(&shared_parent).map_err(fail)?;
        let shared_parent = checked_root(&shared_parent)?;
        if !shared_parent.starts_with(&root) { return Err(fail("共享缓存超出目录")); }
        let shared = shared_parent.join(shared_revision(job)?);
        fs::create_dir_all(&shared).map_err(fail)?;
        let shared = checked_root(&shared)?;
        if !shared.starts_with(&root) { return Err(fail("共享缓存超出目录")); }
        fs::create_dir_all(shared.join("blobs")).map_err(fail)?;
        let blobs = checked_root(&shared.join("blobs"))?;
        if !blobs.starts_with(&root) { return Err(fail("共享缓存文件超出目录")); }
        let index_path = shared.join("index.sqlite");
        if index_path.exists() { contained_file(&root, &index_path)?; }
        let target = Connection::open(index_path).map_err(fail)?;
        target.busy_timeout(Duration::from_secs(5)).map_err(fail)?;
        target.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS tiles(zoom INTEGER,x INTEGER,y INTEGER,hash TEXT NOT NULL,bytes INTEGER NOT NULL,saved_at TEXT NOT NULL,PRIMARY KEY(zoom,x,y));").map_err(fail)?;
        let mut statement = db.prepare("SELECT zoom,x,y,bytes,sha256 FROM tiles ORDER BY zoom,x,y").map_err(fail)?;
        let rows = statement.query_map([], |r| Ok((r.get::<_,u8>(0)?,r.get::<_,u32>(1)?,r.get::<_,u32>(2)?,r.get::<_,u64>(3)?,r.get::<_,String>(4)?))).map_err(fail)?;
        for row in rows {
            cancellation(cancel)?;
            let (z,x,y,len,hash) = row.map_err(fail)?;
            progress.checked += 1;
            if z > 30 || u64::from(x) >= (1u64 << z) || u64::from(y) >= (1u64 << z) {
                warn(&mut progress, format!("{}：无效瓦片坐标 {z}/{x}/{y}",job.job_id)); notify(&progress); continue;
            }
            let path = folder.join(format!("z{z}-x{x}-y{y}.png"));
            let bytes = match validated_tile(&root, &path, &hash, len, Some(job.source.tile_size)) {
                Ok(bytes) => bytes, Err(error) => { warn(&mut progress, format!("{} {z}/{x}/{y}：{}",job.job_id,error.message)); notify(&progress); continue; }
            };
            // mtime is the best retained retrieval bound of old checkpoint files.
            // Never mark old data as fetched now; don't overwrite a newer shared row.
            let stamp: DateTime<Utc> = fs::metadata(&path).map_err(fail)?.modified().map_err(fail)?.into();
            let previous: Option<(String,u64,String)> = target.query_row("SELECT hash,bytes,saved_at FROM tiles WHERE zoom=?1 AND x=?2 AND y=?3",params![z,x,y],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(fail)?;
            if let Some((old_hash,old_len,old_stamp)) = previous {
                let same_or_newer = old_hash == hash || DateTime::parse_from_rfc3339(&old_stamp).map(|s| s >= stamp).unwrap_or(false);
                if same_or_newer && validated_tile(&root,&blobs.join(&old_hash),&old_hash,old_len,Some(job.source.tile_size)).is_ok() {
                    progress.skipped += 1; notify(&progress); continue;
                }
            }
            let destination = blobs.join(&hash);
            if destination.exists() && validated_tile(&root,&destination,&hash,len,Some(job.source.tile_size)).is_err() {
                // A corrupt content-addressed blob can be replaced only after the new bytes verify.
                contained_file(&root,&destination)?;
                fs::remove_file(&destination).map_err(fail)?;
            }
            if !destination.exists() {
                let mut temporary = tempfile::NamedTempFile::new_in(&blobs).map_err(fail)?;
                temporary.write_all(&bytes).map_err(fail)?; temporary.as_file().sync_all().map_err(fail)?;
                temporary.persist_noclobber(&destination).map_err(fail)?;
            }
            target.execute("INSERT OR REPLACE INTO tiles VALUES(?1,?2,?3,?4,?5,?6)",params![z,x,y,hash,len,stamp.to_rfc3339()]).map_err(fail)?;
            progress.migrated += 1; progress.bytes += len; notify(&progress);
        }
    }
    progress.phase = "completed".into(); progress.current_job = None; notify(&progress); Ok(progress)
}

pub fn verify(cache_parent: &Path, cancel: &AtomicBool, mut notify: impl FnMut(&CacheProgress)) -> Result<CacheProgress, CoreError> {
    let inventory = inventory(cache_parent)?;
    let mut progress = CacheProgress { phase: "verifying".into(), total: inventory.job_caches.iter().map(|v|v.tile_count).sum::<u64>() + inventory.shared_caches.iter().map(|v|v.tile_count).sum::<u64>(), invalid: inventory.unreadable_entries, ..Default::default() };
    if !cache_parent.exists() { progress.phase="completed".into(); return Ok(progress); }
    let root = checked_root(cache_parent)?;
    for (id,shared) in inventory.job_caches.iter().map(|v|(v.job_id.clone(),false)).chain(inventory.shared_caches.iter().map(|v|(v.revision.clone(),true))) {
        cancellation(cancel)?;
        progress.current_job = Some(id.clone());
        let folder = if shared { root.join("shared").join(&id) } else { root.join(&id) };
        let db = open_read(&contained_file(&root,&folder.join(if shared {"index.sqlite"} else {"tiles.sqlite"}))?)?;
        let mut statement=db.prepare(if shared {"SELECT zoom,x,y,bytes,hash FROM tiles"} else {"SELECT zoom,x,y,bytes,sha256 FROM tiles"}).map_err(fail)?;
        let rows = statement.query_map([],|r|Ok((r.get::<_,u8>(0)?,r.get::<_,u32>(1)?,r.get::<_,u32>(2)?,r.get::<_,u64>(3)?,r.get::<_,String>(4)?))).map_err(fail)?;
        for row in rows {
            cancellation(cancel)?;
            let (z,x,y,len,hash)=row.map_err(fail)?; progress.checked+=1;
            let path=if shared {folder.join("blobs").join(&hash)} else {folder.join(format!("z{z}-x{x}-y{y}.png"))};
            match validated_tile(&root,&path,&hash,len,None) { Ok(_)=>progress.bytes+=len, Err(error)=>warn(&mut progress,format!("{} {z}/{x}/{y}：{}",id,error.message)) }
            notify(&progress);
        }
    }
    progress.phase="completed".into();progress.current_job=None;notify(&progress);Ok(progress)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root:&Path)->MigrationJob {
        let job=MigrationJob{job_id:uuid::Uuid::new_v4().to_string(),plan_hash:"a".repeat(64),source:serde_json::from_value(serde_json::json!({"id":"cache-test","name":"Cache test","attribution":"","license":"","urlTemplate":"https://example.com/{z}/{x}/{y}.png","scheme":"XYZ","tileSize":256,"networkPolicy":"PublicHttps","minIntervalMs":0})).unwrap(),overlays:vec![]};
        let folder=root.join(&job.job_id);fs::create_dir_all(&folder).unwrap();
        let db=Connection::open(folder.join("tiles.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE tiles(zoom INTEGER,x INTEGER,y INTEGER,bytes INTEGER,sha256 TEXT,PRIMARY KEY(zoom,x,y));").unwrap();
        db.execute("INSERT INTO metadata VALUES('binding',?1)",[expected_binding(&job).unwrap()]).unwrap();
        put(&folder,&db,0,256,[20,40,80,255]);job
    }
    fn put(folder:&Path,db:&Connection,x:u32,size:u32,color:[u8;4]) {
        let image=image::RgbaImage::from_pixel(size,size,image::Rgba(color));
        let mut encoded=std::io::Cursor::new(Vec::new());image.write_to(&mut encoded,image::ImageFormat::Png).unwrap();
        let bytes=encoded.into_inner();let hash=format!("{:x}",Sha256::digest(&bytes));
        let path=folder.join(format!("z2-x{x}-y1.png"));fs::write(&path,&bytes).unwrap();
        fs::File::options().write(true).open(path).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::SystemTime::now()-Duration::from_secs(86400*10))).unwrap();
        db.execute("INSERT INTO tiles VALUES(2,?1,1,?2,?3)",params![x,bytes.len(),hash]).unwrap();
    }
    #[test]
    fn migration_validates_binding_pixels_hash_and_preserves_timestamp() {
        let temp=tempfile::tempdir().unwrap();let job=fixture(temp.path());let folder=temp.path().join(&job.job_id);
        let db=Connection::open(folder.join("tiles.sqlite")).unwrap();
        put(&folder,&db,1,128,[0,0,0,255]);put(&folder,&db,2,256,[2,4,6,255]);
        fs::write(folder.join("z2-x2-y1.png"),b"broken").unwrap();drop(db);
        let result=migrate_jobs(temp.path(),&[job.clone()],&AtomicBool::new(false),|_|{}).unwrap();
        assert_eq!((result.checked,result.migrated,result.invalid),(3,1,2));
        assert!(folder.join("z2-x0-y1.png").exists());
        let shared=temp.path().join("shared").join(shared_revision(&job).unwrap());let db=Connection::open(shared.join("index.sqlite")).unwrap();
        let first:String=db.query_row("SELECT saved_at FROM tiles",[],|r|r.get(0)).unwrap();
        assert!(Utc::now().signed_duration_since(DateTime::parse_from_rfc3339(&first).unwrap()).num_days()>=9);
        let repeated=migrate_jobs(temp.path(),&[job.clone()],&AtomicBool::new(false),|_|{}).unwrap();assert_eq!((repeated.migrated,repeated.skipped),(0,1));
        assert_eq!(first,db.query_row::<String,_,_>("SELECT saved_at FROM tiles",[],|r|r.get(0)).unwrap());
        let mut other=job.clone();other.source.url_template="https://other.example.com/{z}/{x}/{y}.png".into();
        let rejected=migrate_jobs(temp.path(),&[other.clone()],&AtomicBool::new(false),|_|{}).unwrap();assert_eq!(rejected.invalid,1);assert!(!temp.path().join("shared").join(shared_revision(&other).unwrap()).exists());
        let stats=inventory(temp.path()).unwrap();assert_eq!((stats.job_caches.len(),stats.shared_caches[0].tile_count,stats.shared_caches[0].expired_tiles),(1,1,1));
        let checked=verify(temp.path(),&AtomicBool::new(false),|_|{}).unwrap();assert_eq!((checked.checked,checked.invalid),(4,1)); // wrong dimensions cannot be bound without the source record
    }
    #[test]
    fn overlays_have_separate_revision_and_binding() {
        let temp=tempfile::tempdir().unwrap();let mut job=fixture(temp.path());let original=shared_revision(&job).unwrap();
        job.overlays.push(OverlaySourceRef{source_id:"labels".into(),config_revision:"b".repeat(64)});
        assert_ne!(original,shared_revision(&job).unwrap());
        assert_eq!(migrate_jobs(temp.path(),&[job],&AtomicBool::new(false),|_|{}).unwrap().invalid,1);
    }
    #[test]
    fn relocation_copies_verifies_switches_and_keeps_source() {
        let temp=tempfile::tempdir().unwrap();let db=temp.path().join("state.sqlite");let root=temp.path().join("tile-cache");let job=fixture(&root);
        migrate_jobs(&root,&[job.clone()],&AtomicBool::new(false),|_|{}).unwrap();
        let target=temp.path().join("new-cache");let preflight=relocation_preflight(&db,&target).unwrap();assert!(preflight.blockers.is_empty());assert!(preflight.bytes>0);
        let result=relocate(&db,&target,&AtomicBool::new(false),|_|{}).unwrap();assert_eq!(result.checked,preflight.file_count);assert_eq!(cache_root_for_database(&db).unwrap(),fs::canonicalize(&target).unwrap());
        assert!(root.join(&job.job_id).join("tiles.sqlite").exists());assert!(target.join(&job.job_id).join("tiles.sqlite").exists());
        assert_eq!(inventory(&root).unwrap().shared_caches[0].expired_tiles,inventory(&target).unwrap().shared_caches[0].expired_tiles);
        assert!(!relocation_preflight(&db,&target.join("inside")).unwrap().blockers.is_empty());
    }
    #[test]
    fn cancelled_relocation_keeps_original_and_never_switches() {
        let temp=tempfile::tempdir().unwrap();let db=temp.path().join("state.sqlite");let root=temp.path().join("tile-cache");fixture(&root);
        let cancel=AtomicBool::new(false);let target=temp.path().join("cancelled-copy");
        let err=relocate(&db,&target,&cancel,|_|cancel.store(true,Ordering::Release)).unwrap_err();assert_eq!(err.code,"CANCELLED");
        assert_eq!(cache_root_for_database(&db).unwrap(),root);assert!(!target.exists());
        assert!(fs::read_dir(temp.path()).unwrap().all(|e|!e.unwrap().file_name().to_string_lossy().starts_with(".geod-cache-move-")));
    }
}

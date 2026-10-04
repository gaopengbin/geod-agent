//! Consistent local record snapshots for upgrades; workspace data stays in place.
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::{Path, PathBuf}, time::Duration};

fn failure(message: &str) -> Value { json!({"code":"UPDATE_BACKUP","message":message}) }
pub(crate) fn validate_ui(value: &Value) -> Result<(), Value> {
    let entries=value["entries"].as_array().ok_or_else(||failure("会话备份格式不可读。"))?;
    if value["schemaVersion"]!=1 || entries.len()>20000 || serde_json::to_vec(value).map_err(|_|failure("会话备份格式不可读。"))?.len()>256*1024*1024 {
        return Err(failure("会话备份格式不可读或过大。"));
    }
    for entry in entries {
        let pair=entry.as_array().filter(|pair|pair.len()==2).ok_or_else(||failure("会话备份格式不可读。"))?;
        if !pair[0].as_str().is_some_and(|key|key.starts_with("geod")&&key.len()<512) || !pair[1].is_string() {return Err(failure("会话备份包含无效记录。"));}
    }
    Ok(())
}
fn digest(path: &Path) -> Result<String,Value> {
    let mut file=fs::File::open(path).map_err(|_|failure("本机备份文件不可读。"))?;let mut hash=Sha256::new();let mut bytes=[0u8;64*1024];
    loop {let count=file.read(&mut bytes).map_err(|_|failure("本机备份文件不可读。"))?;if count==0 {break;}hash.update(&bytes[..count]);}
    Ok(format!("{:x}",hash.finalize()))
}
fn walk(root:&Path, directory:&Path, files:&mut Vec<PathBuf>) -> Result<(),Value> {
    if !directory.exists(){return Ok(());}
    let canonical=root.canonicalize().map_err(|_|failure("本机记录目录不可读。"))?;
    for entry in fs::read_dir(directory).map_err(|_|failure("本机记录目录不可读。"))? {
        let entry=entry.map_err(|_|failure("本机记录目录不可读。"))?;let kind=entry.file_type().map_err(|_|failure("本机记录目录不可读。"))?;let path=entry.path();
        if kind.is_symlink(){continue;}
        if !path.canonicalize().map_err(|_|failure("本机记录目录不可读。"))?.starts_with(&canonical){return Err(failure("本机记录目录越出了应用范围。"));}
        if kind.is_dir(){
            if ["node_modules","tmp","cache",".cache",".git"].contains(&entry.file_name().to_string_lossy().as_ref()) || (!path.starts_with(root.join("plugin-packages")) && ["skills","plugins"].contains(&entry.file_name().to_string_lossy().as_ref())){continue;}
            walk(root,&path,files)?;
        }else if kind.is_file(){
            let name=entry.file_name();let name=name.to_string_lossy();let extension=path.extension().and_then(|value|value.to_str()).unwrap_or("");
            let attachment=path.starts_with(root.join("chat-attachments"))&&["json","text","transcript","attachment"].contains(&extension);
            let image=path.starts_with(root.join("chat-images"))&&["json","image","preview"].contains(&extension);
            let protected_client_tls=extension=="client-tls"&&(path.starts_with(root.join("data-inputs"))||path.starts_with(root.join("sql-inputs")));
            if attachment || image || protected_client_tls || path.starts_with(root.join("plugin-packages")) || path.starts_with(root.join("plugin-data")) || (extension=="sqlite"&&!name.starts_with("logs_")) || extension=="jsonl" || name=="geod-threads.json" || name=="connections.json" || extension=="pem" {files.push(path);}
        }
    }
    Ok(())
}
pub(crate) fn create(root:&Path,version:&str,ui_state:Value) -> Result<Value,Value> {
    validate_ui(&ui_state)?;
    let mut files=Vec::new();
    for name in ["agent-tasks.sqlite","agent-ai-schedules.sqlite","agent-memory.sqlite","codex-runtime/execution-receipts.sqlite","ai-channels/channels.sqlite","agent-tasks/tasks.sqlite"] {
        let file=root.join(name);if file.is_file(){files.push(file);}
    }
    for entry in fs::read_dir(root).map_err(|_|failure("本机记录目录不可读。"))? {
        let entry=entry.map_err(|_|failure("本机记录目录不可读。"))?;let name=entry.file_name();let name=name.to_string_lossy();
        if entry.file_type().map_err(|_|failure("本机记录目录不可读。"))?.is_file() && (name.starts_with("workspace-")&&name.ends_with(".json") || ["desktop-settings.json","agent-services.json","agent-extensions.json","network-settings.json"].contains(&name.as_ref())){files.push(entry.path());}
    }
    for directory in ["codex-runtime","data-inputs","sql-inputs","online-inputs","chat-attachments","chat-images","plugin-packages","plugin-data"] {walk(root,&root.join(directory),&mut files)?;}
    files.sort();files.dedup();
    let name=format!("{}-{}",chrono::Utc::now().format("%Y%m%d-%H%M%S"),&uuid::Uuid::new_v4().simple().to_string()[..8]);
    let parent=root.join("upgrade-backups");let stage=parent.join(format!(".{name}.partial"));let target=parent.join(&name);
    fs::create_dir_all(stage.join("records")).map_err(|_|failure("无法创建本机备份。"))?;
    let result=(|| {
        let mut records=Vec::new();let mut total=0u64;
        for (index,source) in files.iter().enumerate() {
            let sqlite=source.extension().is_some_and(|extension|extension=="sqlite");
            // Flat destinations avoid SQLite's long Windows path limit.
            let file=format!("records/{index:05}.{}",if sqlite{"sqlite"}else{"record"});let destination=stage.join(&file);
            if sqlite {
                let database=Connection::open_with_flags(source,OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_|failure("本机账本备份失败。"))?;
                database.busy_timeout(Duration::from_secs(5)).map_err(|_|failure("本机账本备份失败。"))?;
                database.execute("VACUUM INTO ?1",[destination.to_string_lossy().as_ref()]).map_err(|_|failure("本机账本备份失败。"))?;
                let copied=Connection::open_with_flags(&destination,OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_|failure("本机账本备份校验失败。"))?;
                let integrity:String=copied.query_row("PRAGMA quick_check",[],|row|row.get(0)).map_err(|_|failure("本机账本备份校验失败。"))?;
                if integrity!="ok" {return Err(failure("本机账本备份校验失败。"));}
            }else {fs::copy(source,&destination).map_err(|_|failure("本机设置备份失败。"))?;}
            let bytes=fs::metadata(&destination).map_err(|_|failure("本机备份校验失败。"))?.len();total+=bytes;
            let relative=source.strip_prefix(root).map_err(|_|failure("本机记录路径无效。"))?.to_string_lossy().replace('\\',"/");
            records.push(json!({"path":relative,"file":file,"kind":if sqlite{"sqlite"}else{"record"},"bytes":bytes,"sha256":digest(&destination)?}));
        }
        let ui_file=stage.join("ui-state.json");fs::write(&ui_file,serde_json::to_vec(&ui_state).map_err(|_|failure("会话备份失败。"))?).map_err(|_|failure("会话备份失败。"))?;
        let ui_bytes=fs::metadata(&ui_file).map_err(|_|failure("会话备份校验失败。"))?.len();total+=ui_bytes;
        let manifest=json!({"schemaVersion":1,"fromVersion":version,"createdAt":chrono::Utc::now().to_rfc3339(),"scope":"native-ledgers-settings-engine-history-ui-and-chat-attachments","records":records,"uiState":{"file":"ui-state.json","bytes":ui_bytes,"sha256":digest(&ui_file)?},"workspaceFilesIncluded":false,"chatAttachmentsIncluded":true,"credentials":"references-and-system-protected-client-tls-same-windows-user"});
        fs::write(stage.join("manifest.json"),serde_json::to_vec_pretty(&manifest).unwrap()).map_err(|_|failure("本机备份清单保存失败。"))?;
        fs::rename(&stage,&target).map_err(|_|failure("本机备份保存失败。"))?;
        Ok(json!({"path":target,"records":records.len(),"bytes":total,"includesConversations":true,"verified":true}))
    })();
    if result.is_err() {let _=fs::remove_dir_all(&stage);}
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_keeps_committed_wal_history_and_full_ui_records_without_rewriting_sources(){
        let folder=tempfile::tempdir().unwrap();let root=folder.path();let db=Connection::open(root.join("agent-tasks.sqlite")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('real committed WAL record');").unwrap();
        let settings=br#"{"permission":"fullAccess","directory":"C:/workspace"}"#;fs::write(root.join("workspace-test.json"),settings).unwrap();
        let home=root.join("codex-runtime/account-test/conversation-test/sessions/2026/10/04");fs::create_dir_all(&home).unwrap();let history=b"actual model and command history\n";fs::write(home.join("rollout-test.jsonl"),history).unwrap();
        let documents=root.join("chat-attachments/owner-chat");fs::create_dir_all(&documents).unwrap();fs::write(documents.join("fixture.attachment"),b"original user document").unwrap();fs::write(documents.join("fixture.text"),b"actual extracted content").unwrap();
        fs::write(documents.join("fixture.transcript"),b"original machine transcript before user correction").unwrap();
        let plugin=root.join("plugin-packages/fixture/skills/reference");fs::create_dir_all(&plugin).unwrap();fs::write(plugin.join("lookup.txt"),b"installed plugin resource").unwrap();
        let plugin_data=root.join("plugin-data/fixture");fs::create_dir_all(&plugin_data).unwrap();fs::write(plugin_data.join("events.jsonl"),b"actual plugin lifecycle event\n").unwrap();
        let cache=root.join("cache/plugin-marketplace-staging/fixture");fs::create_dir_all(&cache).unwrap();fs::write(cache.join("temporary.txt"),b"uninstalled preview").unwrap();
        let images=root.join("chat-images/owner");fs::create_dir_all(&images).unwrap();fs::write(images.join("fixture.image"),b"original user image").unwrap();
        let tls=root.join("sql-inputs/owner/certificates");fs::create_dir_all(&tls).unwrap();let protected=b"opaque system-protected client certificate and key";fs::write(tls.join("fixture.client-tls"),protected).unwrap();
        let ui=json!({"schemaVersion":1,"entries":[["geod-agent-conversations-0.1:owner","41 retained conversations"]]});
        let result=create(root,"0.2.0",ui.clone()).unwrap();let backup=PathBuf::from(result["path"].as_str().unwrap());let manifest:Value=serde_json::from_slice(&fs::read(backup.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["workspaceFilesIncluded"],false);assert_eq!(manifest["chatAttachmentsIncluded"],true);assert_eq!(manifest["records"].as_array().unwrap().len(),10);
        let automation=manifest["records"].as_array().unwrap().iter().find(|record|record["path"]=="plugin-data/fixture/events.jsonl").unwrap();
        assert_eq!(fs::read(backup.join(automation["file"].as_str().unwrap())).unwrap(),b"actual plugin lifecycle event\n");
        let resource=manifest["records"].as_array().unwrap().iter().find(|record|record["path"]=="plugin-packages/fixture/skills/reference/lookup.txt").unwrap();
        assert_eq!(fs::read(backup.join(resource["file"].as_str().unwrap())).unwrap(),b"installed plugin resource");
        let identity=manifest["records"].as_array().unwrap().iter().find(|record|record["path"]=="sql-inputs/owner/certificates/fixture.client-tls").unwrap();assert_eq!(fs::read(backup.join(identity["file"].as_str().unwrap())).unwrap(),protected);
        assert!(!manifest["records"].as_array().unwrap().iter().any(|record|record["path"].as_str().unwrap().starts_with("cache/")));
        let machine=manifest["records"].as_array().unwrap().iter().find(|record|record["path"]=="chat-attachments/owner-chat/fixture.transcript").unwrap();
        assert_eq!(fs::read(backup.join(machine["file"].as_str().unwrap())).unwrap(),b"original machine transcript before user correction");
        let record=manifest["records"].as_array().unwrap().iter().find(|record|record["path"]=="agent-tasks.sqlite").unwrap();let snapshot=Connection::open(backup.join(record["file"].as_str().unwrap())).unwrap();
        assert_eq!(snapshot.query_row("SELECT value FROM fixture",[],|row|row.get::<_,String>(0)).unwrap(),"real committed WAL record");
        assert_eq!(serde_json::from_slice::<Value>(&fs::read(backup.join("ui-state.json")).unwrap()).unwrap(),ui);
        assert_eq!(fs::read(root.join("workspace-test.json")).unwrap(),settings);assert_eq!(fs::read(home.join("rollout-test.jsonl")).unwrap(),history);
        for record in manifest["records"].as_array().unwrap(){assert_eq!(digest(&backup.join(record["file"].as_str().unwrap())).unwrap(),record["sha256"].as_str().unwrap());}
    }
    #[test]
    fn rejected_ui_or_broken_database_leaves_no_published_partial_backup(){
        let folder=tempfile::tempdir().unwrap();let root=folder.path();let bad=json!({"schemaVersion":1,"entries":[["unrelated-secret","not GeoD UI state"]]});assert!(create(root,"0.2.0",bad).is_err());assert!(!root.join("upgrade-backups").exists());
        fs::write(root.join("agent-tasks.sqlite"),b"not a database").unwrap();assert!(create(root,"0.2.0",json!({"schemaVersion":1,"entries":[]})).is_err());assert_eq!(fs::read_dir(root.join("upgrade-backups")).unwrap().count(),0);
    }
}

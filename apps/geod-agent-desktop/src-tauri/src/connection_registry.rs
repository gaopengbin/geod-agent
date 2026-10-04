//! Account-scoped connection metadata shared by the desktop and independent worker.
use crate::{workspace_error,AppError};
use serde::{de::DeserializeOwned,Serialize};
use std::{fs,io::Write,path::Path};

pub(crate) fn load<T:DeserializeOwned>(root:&Path)->Result<Vec<T>,AppError>{
    match fs::read(root.join("connections.json")){
        Ok(bytes) if bytes.len()<=4*1024*1024=>serde_json::from_slice(&bytes).map_err(|_|workspace_error("INPUT_STORAGE_FAILED","连接配置无效")),
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(vec![]),
        _=>Err(workspace_error("INPUT_STORAGE_FAILED","连接配置不可读或过大")),
    }
}
pub(crate) fn update<T:DeserializeOwned+Serialize>(root:&Path,change:impl FnOnce(&mut Vec<T>)->Result<(),AppError>)->Result<(),AppError>{
    let lock=fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(root.join("connections.lock")).map_err(|_|workspace_error("INPUT_STORAGE_FAILED","连接配置暂时不可写"))?;
    fs2::FileExt::lock_exclusive(&lock).map_err(|_|workspace_error("INPUT_STORAGE_FAILED","连接配置暂时不可写"))?;
    let mut values=load(root)?;change(&mut values)?;
    let bytes=serde_json::to_vec(&values).map_err(|_|workspace_error("INPUT_STORAGE_FAILED","连接配置无效"))?;
    if bytes.len()>4*1024*1024{return Err(workspace_error("INPUT_STORAGE_FAILED","连接配置过大"));}
    let temporary=root.join(format!("connections-{}.tmp",uuid::Uuid::new_v4()));
    let result=(||{
        let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(&bytes)?;file.sync_all()?;drop(file);
        fs::rename(&temporary,root.join("connections.json"))
    })();
    if result.is_err(){let _=fs::remove_file(&temporary);return Err(workspace_error("INPUT_STORAGE_FAILED","连接配置保存失败"));}
    Ok(())
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn concurrent_updates_do_not_lose_connections(){
        let temporary=tempfile::tempdir().unwrap();let root=temporary.path().to_path_buf();
        let handles:Vec<_>=(0..8).map(|n|{let root=root.clone();std::thread::spawn(move||update::<u32>(&root,|values|{values.push(n);Ok(())}).unwrap())}).collect();
        for h in handles{h.join().unwrap();}let mut values=load::<u32>(&root).unwrap();values.sort();assert_eq!(values,(0..8).collect::<Vec<_>>());
    }
}

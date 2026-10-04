//! Explicit user preferences. Account/workspace scope is derived natively, never from model arguments.
use crate::{read_workspace, services, workspace_error, AppError, AppState};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub id: String,
    pub scope: String,
    pub title: String,
    pub content: String,
    pub enabled: bool,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Draft {
    pub id: Option<String>,
    pub expected_revision: Option<u64>,
    pub scope: String,
    pub title: String,
    pub content: String,
    pub enabled: bool,
}

fn storage(_: rusqlite::Error) -> AppError {
    workspace_error("MEMORY_STORAGE", "无法读写偏好与记忆")
}
fn database(path: &Path) -> Result<Connection, AppError> {
    let db = Connection::open(path).map_err(storage)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(storage)?;
    db.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS agent_memory (
          owner TEXT NOT NULL, id TEXT NOT NULL, workspace TEXT NOT NULL,
          title TEXT NOT NULL, content TEXT NOT NULL, enabled INTEGER NOT NULL,
          revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(owner,id));
        CREATE INDEX IF NOT EXISTS agent_memory_scope ON agent_memory(owner,workspace,updated_at);")
        .map_err(storage)?;
    Ok(db)
}
fn workspace_key(root: &Path) -> Result<String, AppError> {
    let path = std::fs::canonicalize(root)
        .map_err(|_| workspace_error("WORKSPACE_INVALID", "当前工作区无法访问"))?;
    if !path.is_dir() {
        return Err(workspace_error("WORKSPACE_INVALID", "当前工作区不是文件夹"));
    }
    let text = path.to_string_lossy().into_owned();
    Ok(if cfg!(windows) { text.to_lowercase() } else { text })
}
fn context(app: &AppHandle, conversation: &str) -> Result<(std::path::PathBuf, String, String), AppError> {
    let state = app.state::<AppState>();
    let services = app.state::<services::ServiceState>();
    let owner = services::current_user_id(&services).map_err(|e| workspace_error(e.code, e.message))?;
    let workspace = read_workspace(app, &state, &services, conversation)?;
    Ok((state.workspace_dir.join("agent-memory.sqlite"), owner, workspace_key(Path::new(&workspace.directory))?))
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: r.get(0)?, scope: if r.get::<_, String>(1)?.is_empty() { "account" } else { "workspace" }.into(),
        title: r.get(2)?, content: r.get(3)?, enabled: r.get(4)?, revision: r.get(5)?,
        created_at: r.get(6)?, updated_at: r.get(7)?,
    })
}
fn entries(db: &Connection, owner: &str, workspace: &str) -> Result<Vec<Entry>, AppError> {
    let mut query = db.prepare("SELECT id,workspace,title,content,enabled,revision,created_at,updated_at
        FROM agent_memory WHERE owner=?1 AND (workspace='' OR workspace=?2)
        ORDER BY CASE WHEN workspace='' THEN 1 ELSE 0 END,updated_at DESC,id").map_err(storage)?;
    let values = query.query_map(params![owner, workspace], row).map_err(storage)?.collect::<Result<Vec<_>, _>>().map_err(storage)?;
    Ok(values)
}
fn save(db: &mut Connection, owner: &str, workspace: &str, draft: Draft) -> Result<Entry, AppError> {
    let target = match draft.scope.as_str() {
        "account" => "", "workspace" => workspace,
        _ => return Err(workspace_error("MEMORY_INVALID", "请选择账号或工作区范围")),
    };
    let title = draft.title.trim();
    let content = draft.content.trim();
    if title.is_empty() || title.chars().count() > 120 || content.is_empty()
        || content.chars().count() > 4000 || content.contains('\0') {
        return Err(workspace_error("MEMORY_INVALID", "标题限 120 字，内容限 4000 字，均不能为空"));
    }
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
    let now = Utc::now().to_rfc3339();
    let (id, revision, created_at) = if let Some(id) = draft.id {
        let previous: Option<(String, u64, String)> = transaction.query_row(
            "SELECT workspace,revision,created_at FROM agent_memory WHERE owner=?1 AND id=?2 AND (workspace='' OR workspace=?3)",
            params![owner, id, workspace], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).optional().map_err(storage)?;
        let (_, revision, created_at) = previous.ok_or_else(|| workspace_error("MEMORY_NOT_FOUND", "未找到当前范围内的记忆"))?;
        if draft.expected_revision != Some(revision) {
            return Err(workspace_error("MEMORY_CONFLICT", "这条记忆已被修改，请重新读取后保存"));
        }
        (id, revision + 1, created_at)
    } else {
        if draft.expected_revision.is_some() { return Err(workspace_error("MEMORY_INVALID", "新记忆不使用修订版本")); }
        let count: usize = transaction.query_row("SELECT COUNT(*) FROM agent_memory WHERE owner=?1", [owner], |r| r.get(0)).map_err(storage)?;
        if count >= 1000 { return Err(workspace_error("MEMORY_CAPACITY", "记忆已达 1000 条，请整理后继续添加")); }
        (Uuid::new_v4().to_string(), 1, now.clone())
    };
    transaction.execute("INSERT INTO agent_memory(owner,id,workspace,title,content,enabled,revision,created_at,updated_at)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
        ON CONFLICT(owner,id) DO UPDATE SET workspace=excluded.workspace,title=excluded.title,
          content=excluded.content,enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at",
        params![owner, id, target, title, content, draft.enabled, revision, created_at, now]).map_err(storage)?;
    transaction.commit().map_err(storage)?;
    Ok(Entry { id, scope: draft.scope, title: title.into(), content: content.into(), enabled: draft.enabled, revision, created_at, updated_at: now })
}
fn remove(db: &mut Connection, owner: &str, workspace: &str, id: &str, revision: u64) -> Result<(), AppError> {
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
    let current: Option<u64> = transaction.query_row("SELECT revision FROM agent_memory WHERE owner=?1 AND id=?2 AND (workspace='' OR workspace=?3)",
        params![owner, id, workspace], |r| r.get(0)).optional().map_err(storage)?;
    let current = current.ok_or_else(|| workspace_error("MEMORY_NOT_FOUND", "未找到当前范围内的记忆"))?;
    if current != revision { return Err(workspace_error("MEMORY_CONFLICT", "这条记忆已被修改，请重新读取后删除")); }
    transaction.execute("DELETE FROM agent_memory WHERE owner=?1 AND id=?2 AND revision=?3", params![owner, id, revision]).map_err(storage)?;
    transaction.commit().map_err(storage)
}

#[tauri::command]
pub(crate) fn agent_memory_list(app: AppHandle, conversation_id: String, query: Option<String>, offset: Option<usize>) -> Result<Value, AppError> {
    let (path, owner, workspace) = context(&app, &conversation_id)?;
    let query = query.unwrap_or_default().to_lowercase();
    if query.chars().count() > 120 { return Err(workspace_error("MEMORY_INVALID", "搜索内容过长")); }
    let all: Vec<_> = entries(&database(&path)?, &owner, &workspace)?.into_iter()
        .filter(|e| query.is_empty() || format!("{}\n{}", e.title, e.content).to_lowercase().contains(&query)).collect();
    let offset = offset.unwrap_or(0);
    if offset > all.len() { return Err(workspace_error("MEMORY_INVALID", "读取位置超出范围")); }
    Ok(json!({"entries":all.iter().skip(offset).take(50).collect::<Vec<_>>(),"total":all.len(),
        "nextOffset":(offset+50<all.len()).then_some(offset+50)}))
}
#[tauri::command]
pub(crate) fn agent_memory_save(app: AppHandle, conversation_id: String, draft: Draft) -> Result<Entry, AppError> {
    let (path, owner, workspace) = context(&app, &conversation_id)?;
    save(&mut database(&path)?, &owner, &workspace, draft)
}
#[tauri::command]
pub(crate) fn agent_memory_remove(app: AppHandle, conversation_id: String, id: String, expected_revision: u64) -> Result<Value, AppError> {
    let (path, owner, workspace) = context(&app, &conversation_id)?;
    remove(&mut database(&path)?, &owner, &workspace, &id, expected_revision)?;
    Ok(json!({"removed":true,"id":id}))
}

pub(crate) fn prompt(app: &AppHandle, conversation: &str) -> Result<Value, AppError> {
    let (path, owner, workspace) = context(app, conversation)?;
    let all: Vec<_> = entries(&database(&path)?, &owner, &workspace)?.into_iter().filter(|e| e.enabled).collect();
    let mut included = Vec::new(); let mut length = 0;
    for entry in &all {
        let size = serde_json::to_string(entry).map_err(|_| workspace_error("MEMORY_INVALID", "记忆内容无效"))?.chars().count();
        if length + size <= 16000 { included.push(entry); length += size; }
    }
    Ok(json!({"entries":included,"omitted":all.len()-included.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn draft(title: &str, scope: &str) -> Draft {
        Draft { id: None, expected_revision: None, title: title.into(), content: "默认按行政区裁剪".into(), scope: scope.into(), enabled: true }
    }
    #[test]
    fn account_and_workspace_isolation_revision_and_restart() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("memory.sqlite");
        let mut db = database(&path).unwrap();
        let a = save(&mut db, "one", "workspace-a", draft("输出偏好", "workspace")).unwrap();
        let global = save(&mut db, "one", "workspace-a", draft("语言", "account")).unwrap();
        assert!(entries(&db, "two", "workspace-a").unwrap().is_empty());
        assert_eq!(entries(&db, "one", "workspace-b").unwrap().len(), 1);
        let mut edit = draft("更新偏好", "workspace"); edit.id = Some(a.id.clone()); edit.expected_revision = Some(1);
        assert_eq!(save(&mut db, "one", "workspace-b", edit).unwrap_err().code, "MEMORY_NOT_FOUND");
        let mut edit = draft("更新偏好", "workspace"); edit.id = Some(a.id.clone()); edit.expected_revision = Some(1);
        let next = save(&mut db, "one", "workspace-a", edit).unwrap(); assert_eq!(next.revision, 2);
        assert_eq!(remove(&mut db, "one", "workspace-a", &a.id, 1).unwrap_err().code, "MEMORY_CONFLICT");
        drop(db); let mut db = database(&path).unwrap();
        assert_eq!(entries(&db, "one", "workspace-a").unwrap()[0].revision, 2);
        remove(&mut db, "one", "workspace-a", &a.id, 2).unwrap();
        assert_eq!(entries(&db, "one", "workspace-a").unwrap()[0].id, global.id);
    }
}

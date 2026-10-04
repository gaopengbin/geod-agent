//! Immutable, conversation-scoped input ranges. Plans retain their own snapshot.
use crate::ledger::{LedgerError, TaskStore};
use chrono::{DateTime, Utc};
use geod_core::boundary::BoundaryGeometry;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoundarySummary {
    pub boundary_id: String,
    pub name: String,
    pub bounds: [f64; 4],
    pub polygon_count: usize,
    pub input_ids: Vec<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredBoundary {
    #[serde(flatten)]
    pub summary: BoundarySummary,
    pub geometry: BoundaryGeometry,
}

impl TaskStore {
    pub fn save_boundary(&self, conversation_id: &str, name: &str, geometry: BoundaryGeometry) -> Result<StoredBoundary, LedgerError> {
        self.save_boundary_inputs(conversation_id, name, geometry, Vec::new())
    }

    fn save_boundary_inputs(&self, conversation_id: &str, name: &str, mut geometry: BoundaryGeometry, input_ids: Vec<String>) -> Result<StoredBoundary, LedgerError> {
        if !(8..=80).contains(&conversation_id.len()) || !conversation_id.bytes().all(|b|b.is_ascii_alphanumeric() || matches!(b,b'-'|b'_')) || name.trim().is_empty() || name.chars().count() > 240 || name.chars().any(char::is_control) {
            return Err(LedgerError::new("INVALID_BOUNDARY", "A conversation ID and a nonempty range name are required"));
        }
        let bounds = geometry.normalize().map_err(|cause| LedgerError::new("INVALID_BOUNDARY", cause.0))?;
        let identity = serde_json::to_vec(&(conversation_id, name.trim(), &geometry, &input_ids))?;
        let boundary_id = format!("range-{:x}", Sha256::digest(identity));
        let stored = StoredBoundary { summary: BoundarySummary {
            boundary_id: boundary_id.clone(), name: name.trim().into(), bounds,
            polygon_count: geometry.polygons.len(), input_ids, created_at: Utc::now(),
        }, geometry };
        self.conn.execute("INSERT OR IGNORE INTO boundaries(boundary_id, conversation_id, body) VALUES (?1, ?2, ?3)", params![boundary_id, conversation_id, serde_json::to_string(&stored)?])?;
        self.get_boundary(conversation_id, &boundary_id)?.ok_or_else(|| LedgerError::new("STORAGE_ERROR", "Saved range could not be read back"))
    }

    pub fn get_boundary(&self, conversation_id: &str, boundary_id: &str) -> Result<Option<StoredBoundary>, LedgerError> {
        let body: Option<String> = self.conn.query_row("SELECT body FROM boundaries WHERE conversation_id=?1 AND boundary_id=?2", params![conversation_id, boundary_id], |row| row.get(0)).optional()?;
        body.map(|text| serde_json::from_str(&text).map_err(Into::into)).transpose()
    }

    pub fn list_boundaries(&self, conversation_id: &str) -> Result<Vec<BoundarySummary>, LedgerError> {
        let mut statement = self.conn.prepare("SELECT body FROM boundaries WHERE conversation_id=?1 ORDER BY rowid")?;
        let rows = statement.query_map([conversation_id], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str::<StoredBoundary>(&row?)?.summary)).collect()
    }

    /// Multipolygon union for clipping: retain all members and holes, without
    /// simplification or a destructive dissolve. Overlaps are masked as a union.
    pub fn combine_boundaries(&self, conversation_id: &str, boundary_ids: &[String], name: Option<&str>) -> Result<StoredBoundary, LedgerError> {
        let mut ids = boundary_ids.to_vec();
        ids.sort(); ids.dedup();
        if ids.is_empty() { return Err(LedgerError::new("INVALID_BOUNDARY_SELECTION", "Choose at least one saved range")); }
        let mut polygons = Vec::new();
        let mut names = Vec::new();
        for id in &ids {
            let item = self.get_boundary(conversation_id, id)?.ok_or_else(|| LedgerError::new("BOUNDARY_NOT_IN_CONVERSATION", "A selected range is missing or belongs to another conversation"))?;
            names.push(item.summary.name);
            polygons.extend(item.geometry.polygons);
        }
        let title = name.map(str::to_owned).unwrap_or_else(|| {
            let mut title = names.iter().map(|value| {
                let file = value.rsplit(['/', '\\']).next().unwrap_or(value);
                let base = file.strip_suffix(".geojson").or_else(||file.strip_suffix(".json")).unwrap_or(file);
                base.rsplit_once("-AreaCity-").filter(|(_,date)|date.len()==8 && date.bytes().all(|c|c.is_ascii_digit())).map(|(region,_)|region).unwrap_or(base)
            }).collect::<Vec<_>>().join("、");
            if title.chars().count() > 200 { title = format!("{}等 {} 个范围", title.chars().take(160).collect::<String>(), ids.len()); }
            title
        });
        self.save_boundary_inputs(conversation_id, &title, BoundaryGeometry { polygons }, ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn square(x: f64) -> BoundaryGeometry {
        BoundaryGeometry { polygons: vec![vec![vec![[x, 30.0], [x+1.0, 30.0], [x+1.0, 31.0], [x, 31.0], [x, 30.0]]]] }
    }
    #[test]
    fn persistence_deduplication_and_conversation_isolation() {
        let temp = tempfile::tempdir().unwrap(); let path = temp.path().join("tasks.sqlite");
        let first = uuid::Uuid::new_v4().to_string(); let other = uuid::Uuid::new_v4().to_string();
        let stored = {
            let store = TaskStore::open(&path).unwrap();
            let saved = store.save_boundary(&first, "驻马店市", square(113.0)).unwrap();
            assert_eq!(saved, store.save_boundary(&first, "驻马店市", square(113.0)).unwrap());
            assert_eq!(store.list_boundaries(&first).unwrap().len(), 1);
            assert!(store.get_boundary(&other, &saved.summary.boundary_id).unwrap().is_none()); saved
        };
        let store = TaskStore::open(&path).unwrap();
        assert_eq!(store.get_boundary(&first, &stored.summary.boundary_id).unwrap().unwrap(), stored);
    }
    #[test]
    fn merging_preserves_holes_and_sources_without_replacing_inputs() {
        let temp = tempfile::tempdir().unwrap(); let store = TaskStore::open(&temp.path().join("tasks.sqlite")).unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let mut geometry = square(113.0);
        geometry.polygons[0].push(vec![[113.2,30.2],[113.4,30.2],[113.4,30.4],[113.2,30.4],[113.2,30.2]]);
        let a = store.save_boundary(&conversation, "驻马店市", geometry).unwrap();
        let b = store.save_boundary(&conversation, "信阳市", square(114.0)).unwrap();
        let ids = vec![a.summary.boundary_id.clone(), b.summary.boundary_id.clone(), a.summary.boundary_id.clone()];
        let merged = store.combine_boundaries(&conversation, &ids, Some("驻马店及信阳")).unwrap();
        assert_eq!(merged.summary.bounds, [113.0,30.0,115.0,31.0]);
        assert_eq!(merged.summary.polygon_count, 2);
        assert_eq!(merged.geometry.polygons.iter().filter(|p|p.len()==2).count(), 1);
        assert_eq!(merged.summary.input_ids.len(), 2);
        assert_eq!(store.list_boundaries(&conversation).unwrap().len(), 3);
        assert_eq!(store.get_boundary(&conversation, &a.summary.boundary_id).unwrap().unwrap(), a);
        assert!(store.combine_boundaries(&uuid::Uuid::new_v4().to_string(), &ids, None).is_err());
    }
    #[test]
    fn invalid_selection_is_atomic() {
        let temp = tempfile::tempdir().unwrap(); let store = TaskStore::open(&temp.path().join("tasks.sqlite")).unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let a = store.save_boundary(&conversation, "A", square(110.0)).unwrap();
        assert!(store.combine_boundaries(&conversation, &[a.summary.boundary_id, "missing".into()], None).is_err());
        assert_eq!(store.list_boundaries(&conversation).unwrap().len(), 1);
    }
    #[test]
    fn version_two_upgrade_preserves_records_and_creates_readable_backup() {
        let temp = tempfile::tempdir().unwrap(); let path = temp.path().join("tasks.sqlite");
        {
            let store = TaskStore::open(&path).unwrap();
            store.conn.execute_batch("DROP TABLE schedule_runs; DROP TABLE schedules; DROP TABLE boundaries; PRAGMA user_version=2; INSERT INTO sources(source_id,body) VALUES ('migration-marker','preserve-me');").unwrap();
        }
        let store = TaskStore::open(&path).unwrap();
        assert_eq!(store.conn.query_row("SELECT body FROM sources WHERE source_id='migration-marker'",[],|row|row.get::<_,String>(0)).unwrap(),"preserve-me");
        assert_eq!(store.conn.query_row("PRAGMA user_version",[],|row|row.get::<_,i64>(0)).unwrap(),4);
        let backups: Vec<_> = std::fs::read_dir(temp.path()).unwrap().filter_map(Result::ok).filter(|entry|entry.file_name().to_string_lossy().contains("pre-v3-")).collect();
        assert_eq!(backups.len(),1);
        let backup = rusqlite::Connection::open(backups[0].path()).unwrap();
        assert_eq!(backup.query_row("PRAGMA user_version",[],|row|row.get::<_,i64>(0)).unwrap(),2);
        assert_eq!(backup.query_row("SELECT body FROM sources WHERE source_id='migration-marker'",[],|row|row.get::<_,String>(0)).unwrap(),"preserve-me");
    }
}

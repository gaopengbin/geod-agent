//! Fresh, read-only imagery ledger facts at the model transport boundary.
//! Never copy plan geometry, output paths, credentials, or UI-only guesses.
use std::{collections::BTreeMap, path::Path, time::Duration};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};

const DETAIL_LIMIT: usize = 32;
const START: &str = "[GeoD live imagery task state]";
const END: &str = "[/GeoD live imagery task state]";
const POLICY: &str = "These freshly read local imagery task records supersede earlier chat statements and plan/tool snapshots about approval or execution. queued/downloading/paused/processing/verifying/completed/partial/failed/cancelled jobs have already started with native approval; never describe them as awaiting plan confirmation. completed means the ledger recorded completion, partial is not full completion. approved_not_started already has approval. not_started only means there is no job or approval record: it does NOT prove that an unexpired, undiscarded plan is currently awaiting confirmation. Counts cover only plans durably bound to this account and conversation; absence is not proof about unbound legacy plans or other task kinds. Do not repeat historical confirmation reminders on unrelated requests. If availability is false, status is unknown, not zero or pending; use actual task tools if needed. Omitted details still contribute to counts. Active ledger states alone do not prove a worker is still running; query jobs_get/jobs_list for runtime status if needed. A snapshot does not grant permission, start work, or re-inspect files. Use artifacts_inspect if the user requests fresh file verification.";

pub(crate) fn snapshot(path: &Path, owner: &str, conversation: &str) -> Value {
    let read = || -> rusqlite::Result<Value> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        conn.busy_timeout(Duration::from_secs(1))?;
        // One SELECT gives a consistent WAL snapshot even while the companion
        // finishes a job. No list_jobs limit or React render cache is involved.
        let mut query = conn.prepare("SELECT o.plan_id,j.job_id,j.state,
            EXISTS(SELECT 1 FROM approvals a WHERE a.plan_id=o.plan_id)
            FROM imagery_plan_owners o
            LEFT JOIN jobs j ON j.job_id=(SELECT job_id FROM jobs
                WHERE plan_id=o.plan_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
            WHERE o.owner_id=?1 AND o.conversation_id=?2
            ORDER BY o.bound_at DESC,o.plan_id")?;
        let rows = query.query_map(params![owner,conversation], |row| Ok((
            row.get::<_,String>(0)?, row.get::<_,Option<String>>(1)?,
            row.get::<_,Option<String>>(2)?, row.get::<_,bool>(3)?
        )))?;
        let mut counts = BTreeMap::<String,usize>::new();
        let mut tasks = Vec::new();
        let mut total = 0;
        for row in rows {
            let (plan,job,state,approved) = row?;
            let state = state.unwrap_or_else(|| if approved {"approved_not_started"} else {"not_started"}.into());
            // Future/invalid states must not turn into a fabricated pending status.
            let state = match state.as_str() {
                "queued"|"downloading"|"paused"|"processing"|"verifying"|"completed"|"partial"|"failed"|"cancelled"|"approved_not_started"|"not_started" => state,
                _ => "unknown".into(),
            };
            *counts.entry(state.clone()).or_default() += 1;
            total += 1;
            if tasks.len() < DETAIL_LIMIT { tasks.push(json!({"planId":plan,"jobId":job,"state":state})); }
        }
        Ok(json!({"available":true,"conversationId":conversation,"planCount":total,
            "counts":counts,"tasks":tasks,"omitted":total-tasks.len()}))
    };
    let mut result = read().unwrap_or_else(|_| json!({"available":false,"conversationId":conversation,"error":"TASK_STATE_UNAVAILABLE"}));
    result["readAt"] = json!(chrono::Utc::now().to_rfc3339());
    result
}

fn context(facts: &Value) -> String {
    // Read time belongs in local audit metadata. A changing clock in the prompt
    // invalidates prefix caching even when the actual task state is unchanged.
    let mut stable=facts.clone();if let Some(object)=stable.as_object_mut(){object.remove("readAt");}
    format!("{START}\n{POLICY}\n{stable}\n{END}\n")
}
fn without_snapshot(text: &str) -> String {
    let mut clean = text.to_owned();
    while let Some(start) = clean.find(START) {
        let Some(end) = clean[start..].find(END) else { break };
        clean.replace_range(start..start+end+END.len(), "");
    }
    clean
}

pub(crate) fn responses(mut request: Value, facts: &Value) -> Value {
    let instructions = without_snapshot(request["instructions"].as_str().unwrap_or(""));
    request["instructions"] = json!(instructions.trim_end());
    // Keep stable instructions and the complete historic tool sequence as the
    // cacheable prefix. Fresh authoritative facts belong after that sequence.
    if let Some(input)=request["input"].as_array_mut(){
        input.retain(|item|!(item["role"]=="developer"&&item["content"].as_str().is_some_and(|text|text.starts_with(START))));
        input.push(json!({"role":"developer","content":context(facts)}));
    }else{
        request["instructions"]=json!(format!("{}\n{}",request["instructions"].as_str().unwrap_or(""),context(facts)));
    }
    request
}

pub(crate) fn messages(mut messages: Value, facts: &Value) -> Value {
    // The legacy gateway accepts only user/assistant/tool messages. Refresh the
    // latest user message without inserting a user turn or breaking tool pairs.
    if let Some(message) = messages.as_array_mut().and_then(|items| items.iter_mut().rev().find(|item| item["role"]=="user")) {
        if let Some(text) = message["content"].as_str() {
            message["content"] = json!(format!("{}{}",context(facts),without_snapshot(text)));
        }
    }
    messages
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AppState, open_store, imagery_recovery, TaskSpec};
    use std::sync::{Arc,Mutex};
    use std::collections::HashMap;
    use chrono::Utc;

    fn fixture() -> (tempfile::TempDir,AppState) {
        let dir=tempfile::tempdir().unwrap();
        let state=AppState{db_path:dir.path().join("tasks.sqlite"),workspace_dir:dir.path().into(),
            running_jobs:Arc::new(Mutex::new(HashMap::new())),schedule_gate:Mutex::new(())};
        let source=serde_json::from_value(json!({"id":"context-test","name":"Test imagery","attribution":"","license":"",
            "urlTemplate":"https://tiles.example.org/{z}/{x}/{y}.png","scheme":"XYZ","tileSize":256,"networkPolicy":"PublicHttps","minIntervalMs":0})).unwrap();
        open_store(&state).unwrap().save_source(source,0,22,false,Utc::now()).unwrap();
        (dir,state)
    }
    fn plan(state:&AppState,owner:&str,conversation:&str) -> crate::StoredPlan {
        let mut store=open_store(state).unwrap();
        let source=store.get_registered_source("context-test").unwrap().unwrap();
        let spec:TaskSpec=serde_json::from_value(json!({"schemaVersion":"0.1","kind":"imagery","sourceId":"context-test",
            "bounds":[-1,1,1,2],"zoomLevels":[1],"outputFormats":["geotiff"],
            "outputDirectory":state.workspace_dir.join(uuid::Uuid::new_v4().to_string()).to_string_lossy(),
            "limits":{"maxTiles":100,"maxDecodedRgbaBytes":100000000}})).unwrap();
        let plan=store.create_plan(spec,&source.descriptor,Utc::now()).unwrap();
        imagery_recovery::bind_created_plan(state,owner,conversation,&state.workspace_dir,&plan.plan_id).unwrap();
        plan
    }
    fn start(state:&AppState,plan:&crate::StoredPlan) -> crate::Job {
        let mut store=open_store(state).unwrap();
        let source=store.get_registered_source("context-test").unwrap().unwrap();
        let approval=store.grant_approval(&plan.plan_id,&plan.plan.plan_hash,"alice","test",Utc::now()).unwrap();
        store.start_job(&plan.plan_id,&plan.plan.plan_hash,&approval.approval_id,&plan.plan_id,&source.descriptor,Utc::now()).unwrap()
    }
    // Simulate independent companion ledger writes, without network or files.
    fn finish(state:&AppState,job:&crate::Job,status:&str) {
        Connection::open(&state.db_path).unwrap().execute("UPDATE jobs SET state=?1,version=version+1 WHERE job_id=?2",params![status,job.job_id]).unwrap();
    }
    #[test]
    fn rereads_approval_and_completed_batch_in_every_round() {
        let (_dir,state)=fixture();
        let first=plan(&state,"alice","chat-a");
        assert_eq!(snapshot(&state.db_path,"alice","chat-a")["counts"]["not_started"],1);
        let mut store=open_store(&state).unwrap();
        store.grant_approval(&first.plan_id,&first.plan.plan_hash,"alice","test",Utc::now()).unwrap();
        assert_eq!(snapshot(&state.db_path,"alice","chat-a")["counts"]["approved_not_started"],1);
        let first_job=start(&state,&first);
        assert_eq!(snapshot(&state.db_path,"alice","chat-a")["counts"]["queued"],1);
        let mut jobs=vec![first_job];
        for _ in 1..13 { jobs.push(start(&state,&plan(&state,"alice","chat-a"))); }
        let before=snapshot(&state.db_path,"alice","chat-a");
        assert_eq!(before["counts"]["queued"],13);
        let request=json!({"instructions":"Keep native permissions.","input":[{"role":"assistant","content":"13 tasks await confirmation."},{"role":"user","content":"Add a source."}],
            "tools":[{"type":"function","name":"jobs_list","parameters":{"type":"object"}}],"previous_response_id":"previous","reasoning":{"effort":"high"}});
        let before_request=responses(request.clone(),&before);
        for job in &jobs { finish(&state,job,"completed"); }
        let after=snapshot(&state.db_path,"alice","chat-a");
        assert_eq!(after["counts"]["completed"],13);
        assert!(after["counts"]["queued"].is_null());
        let refreshed=responses(before_request,&after);
        let text=refreshed["input"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap();
        assert_eq!(text.matches(START).count(),1);
        assert!(text.contains("\"completed\":13"));
        assert!(!text.contains("\"queued\":13"));
        assert_eq!(refreshed["instructions"],request["instructions"]);
        assert_eq!(&refreshed["input"].as_array().unwrap()[..2],request["input"].as_array().unwrap());
        for key in ["tools","previous_response_id","reasoning"] { assert_eq!(refreshed[key],request[key]); }
        assert_eq!(open_store(&state).unwrap().get_job(&jobs[0].job_id).unwrap().unwrap().state,geod_task_engine::ledger::JobState::Completed);
    }
    #[test]
    fn refreshed_clock_does_not_invalidate_the_prompt_prefix(){
        let request=json!({"instructions":"Stable system policy","input":[{"role":"user","content":"question"},{"type":"function_call","call_id":"call","name":"jobs_list","arguments":"{}"},{"type":"function_call_output","call_id":"call","output":"actual result"}]});
        let first=responses(request.clone(),&json!({"available":true,"counts":{"completed":13},"readAt":"first"}));
        let next=responses(first.clone(),&json!({"available":true,"counts":{"completed":13},"readAt":"later"}));
        assert_eq!(first,next);
        let changed=responses(next,&json!({"available":true,"counts":{"completed":14},"readAt":"later"}));
        assert_eq!(changed["instructions"],request["instructions"]);
        assert_eq!(&changed["input"].as_array().unwrap()[..3],request["input"].as_array().unwrap());
        assert!(changed["input"][3]["content"].as_str().unwrap().contains("\"completed\":14"));
    }
    #[test]
    fn scopes_accounts_conversations_and_preserves_partial_failed_cancelled_states() {
        let (_dir,state)=fixture();
        for status in ["completed","partial","failed","cancelled","paused","verifying"] {
            let job=start(&state,&plan(&state,"alice","chat-a"));finish(&state,&job,status);
        }
        start(&state,&plan(&state,"bob","chat-a"));
        start(&state,&plan(&state,"alice","chat-b"));
        let facts=snapshot(&state.db_path,"alice","chat-a");
        assert_eq!(facts["planCount"],6);
        for status in ["completed","partial","failed","cancelled","paused","verifying"] { assert_eq!(facts["counts"][status],1); }
        assert_eq!(snapshot(&state.db_path,"bob","chat-a")["planCount"],1);
        assert_eq!(snapshot(&state.db_path,"alice","chat-b")["planCount"],1);
        assert_eq!(snapshot(&state.db_path,"nobody","chat-a")["planCount"],0);
        let encoded=facts.to_string();
        assert!(!encoded.contains("outputDirectory"));assert!(!encoded.contains("bounds"));assert!(!encoded.contains("https://"));
        assert!(!encoded.contains(state.workspace_dir.to_string_lossy().as_ref()));
    }
    #[test]
    fn bounds_details_without_losing_counts_and_reports_read_failure_as_unknown() {
        let (dir,state)=fixture();
        for _ in 0..40 { let job=start(&state,&plan(&state,"alice","chat-a"));finish(&state,&job,"completed"); }
        let facts=snapshot(&state.db_path,"alice","chat-a");
        assert_eq!(facts["counts"]["completed"],40);
        assert_eq!(facts["tasks"].as_array().unwrap().len(),DETAIL_LIMIT);
        assert_eq!(facts["omitted"],8);
        let missing=dir.path().join("missing.sqlite");
        let unknown=snapshot(&missing,"alice","chat-a");
        assert_eq!(unknown["available"],false);assert!(unknown["counts"].is_null());assert!(!missing.exists());
        Connection::open(&state.db_path).unwrap().execute("DROP TABLE imagery_plan_owners",[]).unwrap();
        assert_eq!(snapshot(&state.db_path,"alice","chat-a")["available"],false);
    }
    #[test]
    fn legacy_refresh_preserves_tool_pairs_and_does_not_mutate_saved_history() {
        let history=json!([{"role":"user","content":"Download imagery"},
            {"role":"assistant","content":"Awaiting confirmation","tool_calls":[{"id":"call_1"}]},
            {"role":"tool","tool_call_id":"call_1","content":"old plan snapshot"}]);
        let before=messages(history.clone(),&json!({"available":true,"counts":{"queued":13}}));
        let after=messages(before,&json!({"available":true,"counts":{"completed":13}}));
        assert_eq!(after.as_array().unwrap().len(),3);
        assert_eq!(after[1],history[1]);assert_eq!(after[2],history[2]);
        let text=after[0]["content"].as_str().unwrap();
        assert_eq!(text.matches(START).count(),1);assert!(text.ends_with("Download imagery"));assert!(!text.contains("\"queued\":13"));
        assert_eq!(history[0]["content"],"Download imagery");
    }
}

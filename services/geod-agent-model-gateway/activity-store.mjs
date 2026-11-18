import Database from 'better-sqlite3';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failureDetails=new Set(['authentication','balance','payment_required','rate_limit','context_limit','image_unsupported','tools_invalid','messages_invalid','parameters_invalid','permission','provider_unavailable','tool_contract','stream_parse','timeout','config','unknown']);
export function validateActivity(body,now=Date.now()) {
  if(!body||Object.keys(body).sort().join(',')!=='accountId,events,schema_version'||body.schema_version!==1||typeof body.accountId!=='string'||!Array.isArray(body.events)||!body.events.length||body.events.length>20)throw Error('INVALID_ACTIVITY');
  return body.events.map(e=>{
    const diagnosticReasons=['consent_disabled','no_download_observed','queued','reported','transport_auth','transport_network','transport_schema','transport_other','collector_unavailable'];
    const detailKeys=['failure_detail','failure_http_status'];
    if(!e||Object.keys(e).filter(key=>!detailKeys.includes(key)).sort().join(',')!=='event_id,input_tokens,kind,occurred_at,output_tokens,reason,state,usage_known'||!uuid.test(e.event_id)||!['app_session','app_first_seen','personal_model','download_status'].includes(e.kind)||!['started','completed','failed','interrupted'].includes(e.state)||!(e.kind==='download_status'?diagnosticReasons:['none','network','auth','rate_limit','context','provider','unknown']).includes(e.reason)||typeof e.usage_known!=='boolean')throw Error('INVALID_ACTIVITY');
    if(detailKeys.some(key=>Object.hasOwn(e,key))&&(
      e.kind!=='personal_model'||e.state!=='failed'||!failureDetails.has(e.failure_detail)||
      (e.failure_http_status!=null&&(!Number.isInteger(e.failure_http_status)||e.failure_http_status<100||e.failure_http_status>599))
    ))throw Error('INVALID_ACTIVITY');
    const at=Date.parse(e.occurred_at);
    if(typeof e.occurred_at!=='string'||!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(e.occurred_at)||!Number.isFinite(at)||at<now-90*86400000||at>now+300000)throw Error('INVALID_ACTIVITY');
    for(const n of [e.input_tokens,e.output_tokens])if(n!==null&&(!Number.isSafeInteger(n)||n<0||n>1e12))throw Error('INVALID_ACTIVITY');
    if(['app_session','app_first_seen'].includes(e.kind)&&(e.state!=='started'||e.reason!=='none'||e.usage_known||e.input_tokens!==null||e.output_tokens!==null))throw Error('INVALID_ACTIVITY');
    if(e.kind==='download_status'&&(e.usage_known||e.input_tokens!==null||e.output_tokens!==null||e.state!==(e.reason==='reported'?'completed':e.reason.startsWith('transport_')||e.reason==='collector_unavailable'?'failed':'started')))throw Error('INVALID_ACTIVITY');
    if(!e.usage_known&&(e.input_tokens!==null||e.output_tokens!==null))throw Error('INVALID_ACTIVITY');
    if(e.usage_known&&(e.input_tokens===null||e.output_tokens===null))throw Error('INVALID_ACTIVITY');
    return {...e,occurred_at:new Date(at).toISOString()};
  });
}
export function openActivityStore(path){
  const db=new Database(path);db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS agent_activity_events(user_id TEXT NOT NULL,event_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,usage_known INTEGER NOT NULL,occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,PRIMARY KEY(user_id,event_id)); CREATE INDEX IF NOT EXISTS agent_activity_time ON agent_activity_events(occurred_at);`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS agent_first_seen_once ON agent_activity_events(user_id,kind) WHERE kind='app_first_seen'");
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS agent_personal_model_failures(
    user_id TEXT NOT NULL,event_id TEXT NOT NULL,failure_detail TEXT NOT NULL,failure_http_status INTEGER,
    PRIMARY KEY(user_id,event_id),
    FOREIGN KEY(user_id,event_id) REFERENCES agent_activity_events(user_id,event_id) ON DELETE CASCADE
  )`);
  const insert=db.prepare('INSERT OR IGNORE INTO agent_activity_events VALUES(?,?,?,?,?,?,?,?,?,?)');
  const insertFailure=db.prepare('INSERT INTO agent_personal_model_failures VALUES(?,?,?,?) ON CONFLICT(user_id,event_id) DO NOTHING');
  const removeExpired=db.prepare('DELETE FROM agent_activity_events WHERE received_at < ?');
  // An older gateway can expire its events without cascading to this new table.
  db.exec('DELETE FROM agent_personal_model_failures WHERE NOT EXISTS (SELECT 1 FROM agent_activity_events e WHERE e.user_id=agent_personal_model_failures.user_id AND e.event_id=agent_personal_model_failures.event_id)');
  const record=db.transaction((owner,events)=>{
    let accepted=0;
    const at=new Date().toISOString();
    for(const e of events){
      const fresh=insert.run(owner,e.event_id,e.kind,e.state,e.reason,e.input_tokens,e.output_tokens,+e.usage_known,e.occurred_at,at).changes;
      accepted+=fresh;
      if(fresh&&e.failure_detail)insertFailure.run(owner,e.event_id,e.failure_detail,e.failure_http_status??null);
    }
    removeExpired.run(new Date(Date.now()-90*86400000).toISOString());
    return {accepted,duplicates:events.length-accepted};
  });
  return {record,close:()=>db.close()};
}

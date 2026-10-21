import Database from 'better-sqlite3';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateActivity(body,now=Date.now()) {
  if(!body||Object.keys(body).sort().join(',')!=='accountId,events,schema_version'||body.schema_version!==1||typeof body.accountId!=='string'||!Array.isArray(body.events)||!body.events.length||body.events.length>20)throw Error('INVALID_ACTIVITY');
  return body.events.map(e=>{
    if(!e||Object.keys(e).sort().join(',')!=='event_id,input_tokens,kind,occurred_at,output_tokens,reason,state,usage_known'||!uuid.test(e.event_id)||!['app_session','app_first_seen','personal_model'].includes(e.kind)||!['started','completed','failed','interrupted'].includes(e.state)||!['none','network','auth','rate_limit','context','provider','unknown'].includes(e.reason)||typeof e.usage_known!=='boolean')throw Error('INVALID_ACTIVITY');
    const at=Date.parse(e.occurred_at);
    if(typeof e.occurred_at!=='string'||!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(e.occurred_at)||!Number.isFinite(at)||at<now-90*86400000||at>now+300000)throw Error('INVALID_ACTIVITY');
    for(const n of [e.input_tokens,e.output_tokens])if(n!==null&&(!Number.isSafeInteger(n)||n<0||n>1e12))throw Error('INVALID_ACTIVITY');
    if(['app_session','app_first_seen'].includes(e.kind)&&(e.state!=='started'||e.reason!=='none'||e.usage_known||e.input_tokens!==null||e.output_tokens!==null))throw Error('INVALID_ACTIVITY');
    if(!e.usage_known&&(e.input_tokens!==null||e.output_tokens!==null))throw Error('INVALID_ACTIVITY');
    if(e.usage_known&&(e.input_tokens===null||e.output_tokens===null))throw Error('INVALID_ACTIVITY');
    return {...e,occurred_at:new Date(at).toISOString()};
  });
}
export function openActivityStore(path){
  const db=new Database(path);db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS agent_activity_events(user_id TEXT NOT NULL,event_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,usage_known INTEGER NOT NULL,occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,PRIMARY KEY(user_id,event_id)); CREATE INDEX IF NOT EXISTS agent_activity_time ON agent_activity_events(occurred_at);`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS agent_first_seen_once ON agent_activity_events(user_id,kind) WHERE kind='app_first_seen'");
  const insert=db.prepare('INSERT OR IGNORE INTO agent_activity_events VALUES(?,?,?,?,?,?,?,?,?,?)');
  const record=db.transaction((owner,events)=>{let accepted=0;const at=new Date().toISOString();for(const e of events)accepted+=insert.run(owner,e.event_id,e.kind,e.state,e.reason,e.input_tokens,e.output_tokens,+e.usage_known,e.occurred_at,at).changes;db.prepare('DELETE FROM agent_activity_events WHERE received_at < ?').run(new Date(Date.now()-90*86400000).toISOString());return {accepted,duplicates:events.length-accepted};});
  return {record,close:()=>db.close()};
}

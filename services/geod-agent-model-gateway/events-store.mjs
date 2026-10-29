import Database from 'better-sqlite3';
import {validateDownloadDiagnostic} from './download-diagnostic.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states = new Set(['started', 'completed', 'partial', 'failed', 'cancelled']);
const durations = new Set(['unknown', 'under_10s', '10-60s', '1-5m', '5-30m', '30m+']);
const reasons = new Set(['none', 'cancelled', 'network', 'auth', 'disk', 'permission', 'missing_tiles', 'provider', 'processing', 'verification', 'backend', 'unknown']);
export function validateEvents(body, now = Date.now()) {
  if (!body || Object.keys(body).sort().join(',') !== 'accountId,events,schema_version' || body.schema_version !== 1 ||
      typeof body.accountId !== 'string' || !Array.isArray(body.events) || !body.events.length || body.events.length > 20) throw new Error('INVALID_EVENTS');
  return body.events.map(event => {
    const at = Date.parse(event?.occurred_at);
    if (!event || Object.keys(event).some(key=>!['attempt_id','duration','event_id','occurred_at','reason','state','download_kind','client_version','diagnostic','diagnostic_status'].includes(key)) ||
        !uuid.test(event.event_id) || !uuid.test(event.attempt_id) || !states.has(event.state) || !durations.has(event.duration) || !reasons.has(event.reason) ||
        typeof event.occurred_at !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(event.occurred_at) || !Number.isFinite(at) || at < now - 90 * 86400000 || at > now + 300000) throw new Error('INVALID_EVENTS');
    if(event.download_kind!=null&&!['imagery','vector','online','tiles3d','raster','unknown'].includes(event.download_kind))throw new Error('INVALID_EVENTS');
    if(event.client_version!=null&&(typeof event.client_version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(event.client_version)||event.client_version.length>32))throw new Error('INVALID_EVENTS');
    let diagnostic;
    if(Object.hasOwn(event,'diagnostic')){if(!event.client_version)throw Error('INVALID_EVENTS');try{diagnostic=validateDownloadDiagnostic(event.diagnostic);}catch{throw Error('INVALID_EVENTS');}}
    if(event.diagnostic_status!=null&&(!['available','not_available','consent_pending','consent_disabled','not_authorized_at_event'].includes(event.diagnostic_status)||(event.diagnostic_status==='available')!==(diagnostic!==null&&diagnostic!==undefined)))throw Error('INVALID_EVENTS');
    return { ...event, ...(diagnostic!==undefined?{diagnostic}:{}), occurred_at: new Date(at).toISOString() };
  });
}
export function openEventStore(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS agent_events (
    user_id TEXT NOT NULL, event_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    state TEXT NOT NULL, duration TEXT NOT NULL, reason TEXT NOT NULL,
    occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
    PRIMARY KEY(user_id,event_id), UNIQUE(user_id,attempt_id,state)
  ); CREATE INDEX IF NOT EXISTS agent_events_time ON agent_events(occurred_at);
  CREATE TABLE IF NOT EXISTS agent_event_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  db.prepare("INSERT OR IGNORE INTO agent_event_metadata VALUES ('started_at',?)").run(new Date().toISOString());
  if(!db.prepare('PRAGMA table_info(agent_events)').all().some(row=>row.name==='download_kind'))db.exec('ALTER TABLE agent_events ADD COLUMN download_kind TEXT');
  for(const name of ['diagnostic_json','client_version','diagnostic_status'])if(!db.prepare('PRAGMA table_info(agent_events)').all().some(row=>row.name===name))db.exec(`ALTER TABLE agent_events ADD COLUMN ${name} TEXT`);
  db.exec('CREATE TABLE IF NOT EXISTS agent_telemetry_internal_users(user_id TEXT PRIMARY KEY,reason TEXT NOT NULL,created_at TEXT NOT NULL)');
  const insert = db.prepare('INSERT OR IGNORE INTO agent_events(user_id,event_id,attempt_id,state,duration,reason,occurred_at,received_at,download_kind,diagnostic_json,client_version,diagnostic_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const record = db.transaction((userId, events) => {
    const at = new Date().toISOString(); let accepted = 0;
    let diagnosticAccepted=0,diagnosticDuplicates=0;
    for (const event of events){
      const changes=insert.run(userId, event.event_id, event.attempt_id, event.state, event.duration, event.reason, event.occurred_at, at,event.download_kind??null,event.diagnostic==null?null:JSON.stringify(event.diagnostic),event.client_version??null,event.diagnostic_status??null).changes;
      accepted+=changes;
      if(event.diagnostic){if(changes)diagnosticAccepted++;else if(db.prepare('SELECT diagnostic_json FROM agent_events WHERE user_id=? AND attempt_id=? AND state=?').get(userId,event.attempt_id,event.state)?.diagnostic_json)diagnosticDuplicates++;}
    }
    db.prepare("DELETE FROM agent_events WHERE received_at < ?").run(new Date(Date.now() - 90 * 86400000).toISOString());
    return { accepted, duplicates: events.length - accepted,...(events.some(e=>e.client_version)?{diagnostics:{accepted:diagnosticAccepted,duplicates:diagnosticDuplicates}}:{}) };
  });
  return { record, close: () => db.close() };
}

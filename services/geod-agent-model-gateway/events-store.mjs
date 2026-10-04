import Database from 'better-sqlite3';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states = new Set(['started', 'completed', 'partial', 'failed', 'cancelled']);
const durations = new Set(['unknown', 'under_10s', '10-60s', '1-5m', '5-30m', '30m+']);
const reasons = new Set(['none', 'cancelled', 'network', 'auth', 'disk', 'permission', 'missing_tiles', 'unknown']);
export function validateEvents(body, now = Date.now()) {
  if (!body || Object.keys(body).sort().join(',') !== 'accountId,events,schema_version' || body.schema_version !== 1 ||
      typeof body.accountId !== 'string' || !Array.isArray(body.events) || !body.events.length || body.events.length > 20) throw new Error('INVALID_EVENTS');
  return body.events.map(event => {
    const at = Date.parse(event?.occurred_at);
    if (!event || Object.keys(event).sort().join(',') !== 'attempt_id,duration,event_id,occurred_at,reason,state' ||
        !uuid.test(event.event_id) || !uuid.test(event.attempt_id) || !states.has(event.state) || !durations.has(event.duration) || !reasons.has(event.reason) ||
        typeof event.occurred_at !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(event.occurred_at) || !Number.isFinite(at) || at < now - 90 * 86400000 || at > now + 300000) throw new Error('INVALID_EVENTS');
    return { ...event, occurred_at: new Date(at).toISOString() };
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
  const insert = db.prepare('INSERT OR IGNORE INTO agent_events VALUES (?,?,?,?,?,?,?,?)');
  const record = db.transaction((userId, events) => {
    const at = new Date().toISOString(); let accepted = 0;
    for (const event of events) accepted += insert.run(userId, event.event_id, event.attempt_id, event.state, event.duration, event.reason, event.occurred_at, at).changes;
    db.prepare("DELETE FROM agent_events WHERE received_at < ?").run(new Date(Date.now() - 90 * 86400000).toISOString());
    return { accepted, duplicates: events.length - accepted };
  });
  return { record, close: () => db.close() };
}

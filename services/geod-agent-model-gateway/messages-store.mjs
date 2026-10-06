import Database from 'better-sqlite3';

export class MessageError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const version = value => typeof value === 'string' && /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})(?:-[A-Za-z0-9.-]{1,60})?$/.test(value);
function compare(a, b) {
  const left = a.split('-')[0].split('.').map(Number), right = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
function text(value, limit) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['zh', 'en'].includes(key))) throw new MessageError('INVALID_MESSAGE_TEXT');
  if (typeof value.zh !== 'string' || !value.zh.trim() || value.zh.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value.zh)) throw new MessageError('INVALID_MESSAGE_TEXT');
  if (value.en != null && (typeof value.en !== 'string' || !value.en.trim() || value.en.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value.en))) throw new MessageError('INVALID_MESSAGE_TEXT');
  return { zh: value.zh.trim(), ...(value.en ? { en: value.en.trim() } : {}) };
}
function date(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new MessageError('INVALID_MESSAGE_DATE');
  return new Date(value).toISOString();
}
export function validateAnnouncement(value) {
  const allowed = ['id', 'title', 'body', 'priority', 'audienceAccountId', 'startsAt', 'expiresAt', 'minimumVersion', 'maximumVersion', 'action'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || !identifier(value.id)) throw new MessageError('INVALID_MESSAGE');
  const title = text(value.title, 160), body = text(value.body, 8000);
  const priority = value.priority ?? 'normal';
  if (!['normal', 'important'].includes(priority)) throw new MessageError('INVALID_MESSAGE_PRIORITY');
  const audienceAccountId = value.audienceAccountId ?? null;
  if (audienceAccountId !== null && (typeof audienceAccountId !== 'string' || !audienceAccountId.length || audienceAccountId.length > 160 || /[\x00-\x1f]/.test(audienceAccountId))) throw new MessageError('INVALID_MESSAGE_AUDIENCE');
  const startsAt = date(value.startsAt), expiresAt = date(value.expiresAt);
  if (startsAt && expiresAt && expiresAt <= startsAt) throw new MessageError('INVALID_MESSAGE_DATE');
  const minimumVersion = value.minimumVersion ?? null, maximumVersion = value.maximumVersion ?? null;
  if (minimumVersion !== null && !version(minimumVersion) || maximumVersion !== null && !version(maximumVersion) || minimumVersion && maximumVersion && compare(minimumVersion, maximumVersion) > 0) throw new MessageError('INVALID_MESSAGE_VERSION');
  let action = null;
  if (value.action != null) {
    const item = value.action;
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['kind', 'label', 'url'].includes(key)) || !['update', 'link'].includes(item.kind)) throw new MessageError('INVALID_MESSAGE_ACTION');
    action = { kind: item.kind, label: text(item.label, 80) };
    if (item.kind === 'link') {
      let url;
      try { url = new URL(item.url); } catch { throw new MessageError('INVALID_MESSAGE_ACTION'); }
      if (url.protocol !== 'https:' || url.username || url.password || item.url.length > 2000) throw new MessageError('INVALID_MESSAGE_ACTION');
      action.url = url.href;
    } else if (item.url != null) throw new MessageError('INVALID_MESSAGE_ACTION');
  }
  return { id: value.id, title, body, priority, audienceAccountId, startsAt, expiresAt, minimumVersion, maximumVersion, action };
}
export function openMessageStore(path, { clock = () => new Date() } = {}) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS agent_announcements (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL,
    payload TEXT NOT NULL, published_at TEXT, updated_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS agent_message_reads (
    user_id TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL, read_at TEXT NOT NULL,
    PRIMARY KEY(user_id,message_id,revision)
  );`);
  const now = () => clock().toISOString();
  function visible(userId, clientVersion) {
    if (!version(clientVersion)) throw new MessageError('INVALID_CLIENT_VERSION');
    const at = now();
    return db.prepare(`SELECT a.*, r.read_at FROM agent_announcements a LEFT JOIN agent_message_reads r
      ON r.message_id=a.id AND r.revision=a.revision AND r.user_id=? WHERE a.state='published'
      ORDER BY a.published_at DESC, a.id DESC`).all(userId).map(row => ({ row, item: JSON.parse(row.payload) })).filter(({ item }) =>
        (!item.audienceAccountId || item.audienceAccountId === userId) && (!item.startsAt || item.startsAt <= at) &&
        (!item.expiresAt || item.expiresAt > at) && (!item.minimumVersion || compare(clientVersion, item.minimumVersion) >= 0) &&
        (!item.maximumVersion || compare(clientVersion, item.maximumVersion) <= 0));
  }
  const put = db.transaction((input, publish = false) => {
    const item = validateAnnouncement(input), previous = db.prepare('SELECT revision FROM agent_announcements WHERE id=?').get(item.id);
    const revision = (previous?.revision ?? 0) + 1, at = now();
    db.prepare(`INSERT INTO agent_announcements VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      revision=excluded.revision,state=excluded.state,payload=excluded.payload,published_at=excluded.published_at,updated_at=excluded.updated_at`)
      .run(item.id, revision, publish ? 'published' : 'draft', JSON.stringify(item), publish ? at : null, at);
    return { id: item.id, revision, state: publish ? 'published' : 'draft' };
  });
  return {
    put,
    publish(id) {
      if (!identifier(id)) throw new MessageError('INVALID_MESSAGE_ID');
      const at = now();
      const changes = db.prepare("UPDATE agent_announcements SET state='published',published_at=?,updated_at=? WHERE id=? AND state='draft'").run(at, at, id).changes;
      if (!changes) throw new MessageError('MESSAGE_DRAFT_NOT_FOUND', 404);
      return { id, state: 'published' };
    },
    retract(id) {
      if (!identifier(id)) throw new MessageError('INVALID_MESSAGE_ID');
      if (!db.prepare("UPDATE agent_announcements SET state='retracted',updated_at=? WHERE id=?").run(now(), id).changes) throw new MessageError('MESSAGE_NOT_FOUND', 404);
      return { id, state: 'retracted' };
    },
    list(userId, clientVersion) {
      const values = visible(userId, clientVersion).slice(0, 100);
      return { schemaVersion: 1, accountId: userId, checkedAt: now(), unreadCount: values.filter(value => !value.row.read_at).length,
        items: values.map(({ row, item }) => ({ id: item.id, revision: row.revision, title: item.title, body: item.body,
          priority: item.priority, action: item.action, publishedAt: row.published_at, expiresAt: item.expiresAt, readAt: row.read_at ?? null })) };
    },
    markRead: db.transaction((userId, clientVersion, ids) => {
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => !identifier(id))) throw new MessageError('INVALID_MESSAGE_IDS');
      const available = visible(userId, clientVersion), wanted = new Set(ids), at = now();
      const insert = db.prepare('INSERT OR IGNORE INTO agent_message_reads VALUES (?,?,?,?)');
      let accepted = 0;
      for (const { row } of available) if (wanted.has(row.id)) accepted += insert.run(userId, row.id, row.revision, at).changes;
      return { accountId: userId, accepted };
    }),
    adminList: () => db.prepare('SELECT id,revision,state,published_at AS publishedAt,updated_at AS updatedAt FROM agent_announcements ORDER BY updated_at DESC LIMIT 100').all(),
    close: () => db.close(),
  };
}

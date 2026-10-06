import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openMessageStore } from './messages-store.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { db: { type: 'string' }, file: { type: 'string' }, id: { type: 'string' }, publish: { type: 'boolean', default: false } } });
const command = positionals[0];
if (!values.db || !['put', 'publish', 'retract', 'list'].includes(command)) throw new Error('Usage: node messages-admin.mjs --db <ledger.sqlite> put --file <announcement.json> [--publish] | publish --id <id> | retract --id <id> | list');
const store = openMessageStore(resolve(values.db));
try {
  const result = command === 'put' ? store.put(JSON.parse(readFileSync(values.file, 'utf8')), values.publish)
    : command === 'publish' ? store.publish(values.id) : command === 'retract' ? store.retract(values.id) : store.adminList();
  console.log(JSON.stringify(result));
} finally { store.close(); }

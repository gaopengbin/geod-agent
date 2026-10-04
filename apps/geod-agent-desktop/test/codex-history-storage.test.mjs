import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareSqliteHome} from '../src-tauri/codex-host.mjs';

test('moving Codex SQLite storage preserves real history and does not overwrite later turns',()=>{
  const root=mkdtempSync(join(tmpdir(),'geod-history-db-'));
  try {
    const home=join(root,'original'),destination=join(root,'short');mkdirSync(home);
    const source=join(home,'thread_history_1.sqlite'),original=new DatabaseSync(source);
    original.exec("PRAGMA journal_mode=WAL; CREATE TABLE messages(id INTEGER PRIMARY KEY,content TEXT); INSERT INTO messages(content) VALUES('actual saved turn');");original.close();
    // Codex can leave an empty DB when the previous path could not open a WAL.
    writeFileSync(join(home,'queue_1.sqlite'),'');
    prepareSqliteHome(home,destination);
    const migrated=new DatabaseSync(join(destination,'thread_history_1.sqlite'));
    assert.equal(migrated.prepare('SELECT content FROM messages').get().content,'actual saved turn');
    migrated.exec("INSERT INTO messages(content) VALUES('new turn after restart');");migrated.close();
    prepareSqliteHome(home,destination);
    const reopened=new DatabaseSync(join(destination,'thread_history_1.sqlite'));
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM messages').get().count,2);reopened.close();
    const preserved=new DatabaseSync(source,{readOnly:true});assert.equal(preserved.prepare('SELECT COUNT(*) AS count FROM messages').get().count,1);preserved.close();
    assert(!existsSync(join(destination,'queue_1.sqlite')));
  }finally{rmSync(root,{recursive:true,force:true});}
});

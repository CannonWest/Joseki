import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { Database } from '../src/db/database';
import {
  LATEST_VERSION,
  migrate,
  migrations,
  schemaVersion,
  type Migration
} from '../src/db/migrations';

/** A database file in its own temp directory, and the way to be rid of it. */
function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joseki-migrate-'));
  return {
    file: path.join(dir, name),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function indexesOn(file: string, table: string): string[] {
  const db = new BetterSqlite3(file, { readonly: true });
  const names = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
    .all(table)
    .map((row) => (row as { name: string }).name);
  db.close();
  return names;
}

test('a fresh database opens fully migrated, and opening it again applies nothing', () => {
  const { file, cleanup } = tempDb('fresh.db');

  const first = new Database(file);
  assert.equal(first.schema.from, 0);
  assert.equal(first.schema.to, LATEST_VERSION);
  assert.deepEqual(
    first.schema.applied.map((m) => m.version),
    migrations.map((m) => m.version)
  );
  first.close();

  const again = new Database(file);
  assert.deepEqual(again.schema, { from: LATEST_VERSION, to: LATEST_VERSION, applied: [] });
  again.close();

  cleanup();
});

test('a database from before versioning is brought all the way forward', () => {
  const { file, cleanup } = tempDb('older.db');
  // The shape a database had when schema changes were still made in place:
  // no version stamp, and none of the columns added since.
  const older = new BetterSqlite3(file);
  older.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL,
      content TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    INSERT INTO messages (id, conversation_id, parent_id, role, content, created_at)
      VALUES ('u1', 'c1', NULL, 'user', 'hello', 1);
  `);
  assert.equal(schemaVersion(older), 0);
  older.close();

  const db = new Database(file);
  assert.equal(db.schema.from, 0);
  assert.equal(db.schema.to, LATEST_VERSION);
  // The row that was there before is still there afterwards.
  assert.equal(db.getMessage('u1')?.content, 'hello');
  db.close();

  const inspect = new BetterSqlite3(file, { readonly: true });
  const columns = (inspect.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>)
    .map((column) => column.name);
  inspect.close();
  assert.ok(columns.includes('reasoning_details'));
  assert.ok(columns.includes('provider'));

  cleanup();
});

test('the run history has the index its queries read through', () => {
  const { file, cleanup } = tempDb('indexed.db');
  new Database(file).close();

  // Reopening a run filters traces by execution_id and reads them in
  // timestamp order; the runs list rolls them up by the same column.
  assert.ok(indexesOn(file, 'execution_traces').includes('idx_traces_execution'));

  cleanup();
});

test('a migration that throws rolls back, and the version names the last step that finished', () => {
  const db = new BetterSqlite3(':memory:');
  db.exec('CREATE TABLE t (a TEXT)');

  const list: Migration[] = [
    { version: 1, name: 'adds b', up: (d) => d.exec('ALTER TABLE t ADD COLUMN b TEXT') },
    {
      version: 2,
      name: 'adds c, then changes its mind',
      up: (d) => {
        d.exec('ALTER TABLE t ADD COLUMN c TEXT');
        throw new Error('nope');
      }
    }
  ];

  assert.throws(() => migrate(db, list), /nope/);

  const columns = (db.prepare('PRAGMA table_info(t)').all() as Array<{ name: string }>)
    .map((column) => column.name);
  assert.deepEqual(columns, ['a', 'b'], 'the step that threw left nothing behind');
  assert.equal(schemaVersion(db), 1, 'the step that finished still counts');

  // Fixing the broken step and running again picks up where it stopped.
  list[1].up = (d) => d.exec('ALTER TABLE t ADD COLUMN c TEXT');
  assert.deepEqual(migrate(db, list).applied.map((m) => m.version), [2]);
  assert.equal(schemaVersion(db), 2);
  db.close();
});

test('migrations must be whole numbers in ascending order', () => {
  const db = new BetterSqlite3(':memory:');
  const step = (version: number): Migration => ({ version, name: `v${version}`, up: () => {} });

  assert.throws(() => migrate(db, [step(2), step(1)]), /ascending order/);
  assert.throws(() => migrate(db, [step(1), step(1)]), /ascending order/);
  assert.throws(() => migrate(db, [step(1.5)]), /ascending order/);
  assert.doesNotThrow(() => migrate(db, [step(1), step(2)]));
  assert.equal(schemaVersion(db), 2);
  db.close();

  // And the list that ships is one of the good ones — the rule is worth
  // nothing if the roster it guards was never held to it.
  const shipped = migrations.map((m) => m.version);
  assert.deepEqual(shipped, [...shipped].sort((a, b) => a - b));
  assert.equal(new Set(shipped).size, shipped.length);
  assert.equal(LATEST_VERSION, shipped[shipped.length - 1]);
});

test('a run recorded before v3 still reads, with the new columns empty', () => {
  const { file, cleanup } = tempDb('pre-v3.db');

  // The traces table as it stood before v3, holding a branch's run. Opening
  // it through Database is what a real upgrade does: initTables leaves the
  // existing table alone, then the migrations bring it up.
  const older = new BetterSqlite3(file);
  older.exec(`
    CREATE TABLE execution_traces (
      id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, node_id TEXT NOT NULL,
      input TEXT NOT NULL, output TEXT NOT NULL, token_usage TEXT, cost REAL,
      latency_ms INTEGER, status TEXT NOT NULL, error TEXT, timestamp INTEGER NOT NULL
    );
    INSERT INTO execution_traces
      (id, execution_id, node_id, input, output, token_usage, cost, latency_ms, status, timestamp)
      VALUES ('t1', 'run-old', 'branch', 'null', '"true"', '{}', 0, 0, 'success', 1);
  `);
  older.close();

  const db = new Database(file);
  assert.equal(db.schema.to, LATEST_VERSION);

  const [trace] = db.getExecutionTraces('run-old');
  assert.equal(trace.nodeId, 'branch');
  assert.equal(trace.output, 'true', 'what it recorded is untouched');
  // Missing rather than wrong: the run happened before either was written.
  assert.equal(trace.detail, undefined);
  assert.equal(trace.model, undefined);
  db.close();

  cleanup();
});

test('v3 gives the traces table somewhere to put a decision and a model', () => {
  const { file, cleanup } = tempDb('v3.db');
  new Database(file).close();

  const inspect = new BetterSqlite3(file, { readonly: true });
  const columns = (inspect.prepare('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>)
    .map((column) => column.name);
  inspect.close();

  assert.ok(columns.includes('detail'));
  assert.ok(columns.includes('model'), 'model was on the type but never had a column');

  cleanup();
});

import type DatabaseBetter from 'better-sqlite3';
import { EXAMPLES_FOLDER, shippedExamples } from '@joseki/shared';

/**
 * Schema changes, in the order they happened.
 *
 * Version 0 is the schema `Database.initTables` creates — every table a fresh
 * database starts with. That baseline is frozen: a change to the shape of an
 * existing table is a migration here, never an edit to a `CREATE TABLE`,
 * because an edit only reaches databases that do not exist yet. A table
 * that is retired goes the other way: the migration that drops it reaches
 * every database, and the baseline stops making it, so a fresh one is not
 * built a table only to tear it down.
 *
 * SQLite's own `user_version` header field records how far a database has
 * come, so this needs no table of its own and a database carries its version
 * wherever it is copied.
 */
export interface Migration {
  /** 1, 2, 3 … Append only; a number that has shipped never changes meaning. */
  version: number;
  /** What it does, for the line `db:migrate` prints. */
  name: string;
  up(db: DatabaseBetter.Database): void;
}

/** Adds a column unless the table already has it. */
export function addColumn(
  db: DatabaseBetter.Database,
  table: string,
  column: string,
  definition: string
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'messages: the columns the table grew after it first shipped',
    up(db) {
      // These reached older databases through an ad-hoc check that ran on
      // every connection. They are steps forward from one shape to another,
      // which is what a migration is, so this is where they belong.
      addColumn(db, 'messages', 'reasoning_details', 'TEXT');
      addColumn(db, 'messages', 'provider', 'TEXT');
    }
  },
  {
    version: 2,
    name: 'execution_traces: index by run, in the order a run reads them',
    up(db) {
      // Every read of the run history filters on execution_id — reopening a
      // run, and the rollups behind the runs list — and the traces of a run
      // are read in timestamp order. Neither had an index to work from.
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_traces_execution
           ON execution_traces(execution_id, timestamp)`
      );
    }
  },
  {
    version: 3,
    name: 'execution_traces: what a node decided, and the model that ran it',
    up(db) {
      // A run's log is rebuilt from its traces, so why a run went the way it
      // did has to be written down as it happens — a branch's condition and
      // the handle it chose, and for a node that never ran, the nodes whose
      // arrows into it died.
      addColumn(db, 'execution_traces', 'detail', 'TEXT');
      // `model` has been on the trace type and emitted live since the
      // beginning; the insert never wrote it and the read never looked for
      // it, so reopening a run lost which model ran each node. Traces
      // recorded before this stay null — that is missing, not wrong.
      addColumn(db, 'execution_traces', 'model', 'TEXT');
    }
  },
  {
    version: 4,
    name: 'workflows: folders, with the shipped examples in one called Examples',
    up(db) {
      // A workflow names the folder it is in by path; the root is '' and is
      // never a row. A folder is a row, so an empty one exists until it is
      // deleted, the way an empty directory does.
      addColumn(db, 'workflows', 'folder', "TEXT NOT NULL DEFAULT ''");
      db.exec(
        `CREATE TABLE IF NOT EXISTS folders (
           path TEXT PRIMARY KEY,
           created_at INTEGER NOT NULL
         )`
      );
      // A listing reads one folder, most recently edited first.
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_workflows_folder
           ON workflows(folder, updated_at)`
      );

      // The shipped examples move into an Examples folder. Until now the one
      // example was seeded whenever the table was empty, which put it at the
      // root of every database; this is the one time it is put somewhere on
      // its own. An example that is not there — deleted, or the newer one —
      // is added, and one that is there keeps whatever edits it carries.
      // Seeding lives here rather than in the baseline: the v0 table has no
      // folder column, so a fresh database cannot take an example before
      // this step has run.
      const now = Date.now();
      db.prepare('INSERT OR IGNORE INTO folders (path, created_at) VALUES (?, ?)').run(EXAMPLES_FOLDER, now);
      const exists = db.prepare('SELECT 1 FROM workflows WHERE id = ?');
      const move = db.prepare('UPDATE workflows SET folder = ? WHERE id = ?');
      const insert = db.prepare(
        `INSERT INTO workflows (id, name, nodes, edges, variables, created_at, updated_at, folder)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const example of shippedExamples()) {
        if (exists.get(example.id)) {
          move.run(EXAMPLES_FOLDER, example.id);
        } else {
          insert.run(
            example.id,
            example.name,
            JSON.stringify(example.nodes),
            JSON.stringify(example.edges),
            JSON.stringify(example.variables),
            example.createdAt,
            example.updatedAt,
            EXAMPLES_FOLDER
          );
        }
      }
    }
  },
  {
    version: 5,
    name: 'drop the tables nothing reads: model_configs and conversation_trees',
    up(db) {
      // model_configs was a hand-kept list of four pre-OpenRouter models and
      // their prices, seeded into every fresh database and read by nothing:
      // the gateway's catalog is the only model list, and it prices each
      // call itself. conversation_trees never held a row — the messages
      // table's parent_id took its place — and until now it was dropped ad
      // hoc on every open rather than once, here, where schema changes go.
      db.exec('DROP TABLE IF EXISTS model_configs');
      db.exec('DROP TABLE IF EXISTS conversation_trees');
    }
  },
  {
    version: 6,
    name: 'execution_traces: a prompt node\'s thinking trace',
    up(db) {
      // Chat has carried this since messages grew reasoning_details (v1); a
      // workflow's prompt nodes call the same gateway and can reason too, but
      // had nowhere to keep it. Traces recorded before this stay null — that
      // is missing, not wrong, the same as an old trace's model.
      addColumn(db, 'execution_traces', 'reasoning', 'TEXT');
    }
  }
];

/** The version a fully migrated database is at. */
export const LATEST_VERSION = migrations.length ? migrations[migrations.length - 1].version : 0;

export interface MigrationResult {
  /** The version the database was at when it was opened. */
  from: number;
  /** Where it ended up — LATEST_VERSION unless a migration threw. */
  to: number;
  /** What ran, in order. Empty when the database was already up to date. */
  applied: Migration[];
}

/** How far this database has been brought. */
export function schemaVersion(db: DatabaseBetter.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Brings the database up to LATEST_VERSION, and does nothing to one already
 * there. Each migration and the version stamp that records it land in one
 * transaction, so a database is never left half-migrated: a step that throws
 * rolls back and the version still names the last step that finished.
 */
export function migrate(db: DatabaseBetter.Database, list: Migration[] = migrations): MigrationResult {
  assertWellFormed(list);

  const from = schemaVersion(db);
  const pending = list.filter((migration) => migration.version > from);

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }

  return { from, to: schemaVersion(db), applied: pending };
}

/** A list that is out of order or repeats a version would migrate unevenly. */
function assertWellFormed(list: Migration[]): void {
  let previous = 0;
  for (const migration of list) {
    if (!Number.isInteger(migration.version) || migration.version <= previous) {
      throw new Error(
        `Migrations must be whole numbers in ascending order: ${migration.version} follows ${previous}`
      );
    }
    previous = migration.version;
  }
}

import path from 'path';
import { Database } from './database';

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../data/joseki.db');

console.log('Migrating database at:', dbPath);

// Opening the database migrates it — the server and db:init get the same
// treatment, so this command is how you watch it happen and check the result.
const db = new Database(dbPath);
const { from, to, applied } = db.schema;

if (applied.length === 0) {
  console.log(`Already at schema version ${to}; nothing to apply.`);
} else {
  for (const migration of applied) {
    console.log(`  ${migration.version}. ${migration.name}`);
  }
  console.log(`Schema version ${from} -> ${to}.`);
}

db.close();

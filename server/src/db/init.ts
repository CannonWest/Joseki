import { Database } from './database';
import path from 'path';

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../data/convchain.db');

console.log('Initializing database at:', dbPath);

const db = new Database(dbPath);
console.log('Database initialized successfully!');

// Close connection
db.close();
console.log('Database connection closed.');

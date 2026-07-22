import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, '../db/schema.sql');

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const sql = await fs.readFile(schemaPath, 'utf8');
  await pool.query(sql);
  console.log('Database migration completed.');
} finally {
  await pool.end();
}

import { readdir, readFile } from 'node:fs/promises';
import { createPool, transaction } from './db.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const pool = createPool(process.env.DATABASE_URL);
try {
  const dir = new URL('../db/', import.meta.url);
  // Files are idempotent; applying in name order keeps 001 compatible with databases created before 002.
  const files = (await readdir(dir)).filter(f => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  await transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('olist-schema'))");
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      await db.query(await readFile(new URL(file, dir), 'utf8'));
      await db.query('INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT DO NOTHING', [file]);
    }
  });
  console.log(`Migrations applied: ${files.join(', ')}`);
} finally { await pool.end(); }

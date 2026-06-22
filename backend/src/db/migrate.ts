/**
 * Lightweight forward-only SQL migration runner.
 *
 * Applies numbered `.sql` files from the `backend/migrations` directory in
 * lexical order, tracking what has already run in a `_migrations` table so the
 * runner is idempotent. Each migration file is executed inside its own
 * transaction; a failure rolls back that file and aborts the run. (Req 15.3)
 *
 * The database connection string is read from the validated application
 * configuration (`DATABASE_URL`). Secrets/config come from environment
 * variables only. (Req 15.1, 15.2, 16.3)
 *
 * Usage:
 *   npm run migrate            # apply all pending migrations
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { loadConfig } from '../config/env.js';

const { Client } = pg;

/** Absolute path to the `backend/migrations` directory. */
function migrationsDir(): string {
  // This module lives at <root>/src/db/migrate.ts (tsx) or
  // <root>/dist/db/migrate.js (built). Both resolve to <root>/migrations.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'migrations');
}

/** Discover migration files (e.g. `0001_initial_schema.sql`) sorted by name. */
export async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
}

const MIGRATIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

/**
 * Apply all pending migrations against the given client.
 *
 * Returns the names of migrations that were applied during this run (empty if
 * the database was already up to date). Exported for testing and reuse.
 */
export async function runMigrations(client: pg.Client, dir: string): Promise<string[]> {
  await client.query(MIGRATIONS_TABLE_DDL);

  const applied = new Set<string>(
    (await client.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name),
  );

  const files = await listMigrationFiles(dir);
  const pending = files.filter((name) => !applied.has(name));

  const ran: string[] = [];
  for (const name of pending) {
    const sql = await readFile(join(dir, name), 'utf8');
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      ran.push(name);
      console.log(`[migrate] applied ${name}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration failed: ${name}\n${(err as Error).message}`);
    }
  }

  return ran;
}

/** CLI entrypoint: connect using DATABASE_URL and apply pending migrations. */
async function main(): Promise<void> {
  const { config } = loadConfig();
  const dir = migrationsDir();
  const client = new Client({ connectionString: config.databaseUrl });

  await client.connect();
  try {
    const ran = await runMigrations(client, dir);
    if (ran.length === 0) {
      console.log('[migrate] database is up to date; nothing to apply');
    } else {
      console.log(`[migrate] applied ${ran.length} migration(s)`);
    }
  } finally {
    await client.end();
  }
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[migrate] failed:', (err as Error).message);
    process.exitCode = 1;
  });
}

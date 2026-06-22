/**
 * PostgreSQL connection pool.
 *
 * Exposes a shared `pg.Pool` configured from the validated application
 * configuration (`DATABASE_URL`, loaded from environment variables only —
 * Req 15.1, 15.2, 16.3) and a minimal {@link Queryable} interface that the
 * repository layer depends on. Depending on the narrow `Queryable` interface
 * (rather than the concrete `pg.Pool`/`pg.Client`) lets tests inject an
 * in-memory fake client without a live database.
 */

import pg from 'pg';

import { loadConfig } from '../config/env.js';

const { Pool } = pg;

/** Shape of a single `query` result the repositories rely on. */
export interface QueryResult<R> {
  rows: R[];
  rowCount?: number | null;
}

/**
 * Minimal query surface shared by `pg.Pool`, `pg.Client`, and test doubles.
 * Repositories accept this so they can run against a real pool in production
 * and an in-memory fake during unit tests.
 */
export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

let pool: pg.Pool | undefined;

/**
 * Return the process-wide connection pool, creating it on first use from the
 * configured `DATABASE_URL`. Subsequent calls return the same instance.
 */
export function getPool(): pg.Pool {
  if (pool === undefined) {
    const { config } = loadConfig();
    pool = new Pool({ connectionString: config.databaseUrl });
  }
  return pool;
}

/** Close the shared pool (used on graceful shutdown and in tests). */
export async function closePool(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
  }
}

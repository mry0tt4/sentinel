import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { listMigrationFiles, runMigrations } from './migrate.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const REQUIRED_TABLES = [
  'markets',
  'policies',
  'risk_snapshots',
  'incidents',
  'actions',
  'walrus_blobs',
  'environment_checks',
] as const;

/**
 * Minimal in-memory test double for pg.Client that records every query and
 * answers the `_migrations` SELECT. Lets us assert the runner's orchestration
 * (ordering, applied-set skipping, transaction boundaries) without a live DB.
 */
class FakeClient {
  public readonly calls: { text: string; values?: unknown[] }[] = [];
  constructor(private readonly alreadyApplied: string[] = []) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(text: string, values?: unknown[]): Promise<any> {
    this.calls.push({ text, values });
    if (text.includes('SELECT name FROM _migrations')) {
      return { rows: this.alreadyApplied.map((name) => ({ name })) };
    }
    return { rows: [] };
  }
}

describe('listMigrationFiles', () => {
  it('returns only .sql files sorted lexically, including the initial schema', async () => {
    const files = await listMigrationFiles(MIGRATIONS_DIR);
    expect(files).toContain('0001_initial_schema.sql');
    expect(files.every((f) => f.endsWith('.sql'))).toBe(true);
    expect([...files]).toEqual([...files].sort((a, b) => a.localeCompare(b)));
  });
});

describe('runMigrations', () => {
  it('applies all pending migrations inside transactions', async () => {
    const client = new FakeClient([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ran = await runMigrations(client as any, MIGRATIONS_DIR);

    expect(ran).toContain('0001_initial_schema.sql');
    const texts = client.calls.map((c) => c.text);
    expect(texts).toContain('BEGIN');
    expect(texts).toContain('COMMIT');
    expect(
      client.calls.some((c) => c.text.includes('INSERT INTO _migrations')),
    ).toBe(true);
  });

  it('skips migrations that have already been applied', async () => {
    // Mark every current migration as applied so there is genuinely nothing
    // pending — robust to new migrations being added over time.
    const applied = await listMigrationFiles(MIGRATIONS_DIR);
    const client = new FakeClient(applied);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ran = await runMigrations(client as any, MIGRATIONS_DIR);

    expect(ran).toEqual([]);
    expect(ran).not.toContain('0001_initial_schema.sql');
    expect(client.calls.some((c) => c.text === 'BEGIN')).toBe(false);
  });
});

describe('initial schema migration content', () => {
  it('creates all seven required tables', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '0001_initial_schema.sql'), 'utf8');
    for (const table of REQUIRED_TABLES) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }
  });

  it('preserves the key CHECK constraints from the design', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '0001_initial_schema.sql'), 'utf8');
    expect(sql).toContain('CHECK (risk_score BETWEEN 0 AND 100)');
    expect(sql).toContain('CHECK (attempt_count <= 5)');
    expect(sql).toContain("market_type IN ('lending','perps','stablecoin','demo')");
    expect(sql).toContain("status IN ('Normal','Warning','Guarded','Paused','Revoked')");
    expect(sql).toContain("actor_type IN ('agent','dao','admin')");
    expect(sql).toContain("data_source IN ('live','simulated')");
    expect(sql).toContain("outcome IN ('pass','fail')");
  });
});

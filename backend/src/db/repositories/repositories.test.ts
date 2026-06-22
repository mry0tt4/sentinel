import { describe, expect, it } from 'vitest';

import type { QueryResult, Queryable } from '../pool.js';

import { createRepositories } from './index.js';

/**
 * In-memory test double for the `Queryable` surface. Records every query
 * (text + bind values) so we can assert repositories build correct
 * *parameterized* SQL, and returns a configurable canned row so we can assert
 * row -> type mapping. No live database required (mirrors task 5.1's
 * FakeClient).
 */
class FakeDb implements Queryable {
  public readonly calls: { text: string; values?: readonly unknown[] }[] = [];
  /** Rows returned for the next query; defaults to a single empty object. */
  public nextRows: unknown[] = [{}];

  async query<R = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    return { rows: this.nextRows as R[], rowCount: this.nextRows.length };
  }

  get last(): { text: string; values?: readonly unknown[] } {
    return this.calls[this.calls.length - 1];
  }
}

/** Assert a statement is parameterized: every bind value has a `$n` slot and
 * the SQL contains no obvious interpolated literal beyond placeholders. */
function expectParameterized(text: string, values: readonly unknown[] | undefined): void {
  const count = values?.length ?? 0;
  for (let i = 1; i <= count; i++) {
    expect(text).toContain(`$${i}`);
  }
  // No accidental extra placeholder beyond the supplied values.
  expect(text).not.toContain(`$${count + 1}`);
}

describe('MarketsRepository', () => {
  it('builds a parameterized INSERT ... RETURNING * and maps the row', async () => {
    const db = new FakeDb();
    db.nextRows = [{ id: 'm1', name: 'Demo', status: 'Normal' }];
    const repos = createRepositories(db);

    const row = await repos.markets.create({
      on_chain_id: '0xabc',
      market_type: 'demo',
      name: 'Demo',
      status: 'Normal',
      freshness_threshold_ms: 30_000,
    });

    expect(db.last.text).toMatch(/^INSERT INTO markets \(/);
    expect(db.last.text).toContain('RETURNING *');
    // `id` was undefined -> omitted so the DB default applies.
    expect(db.last.text).not.toMatch(/\(id,/);
    expect(db.last.values).toEqual(['0xabc', 'demo', 'Demo', 'Normal', 30_000]);
    expectParameterized(db.last.text, db.last.values);
    expect(row).toEqual({ id: 'm1', name: 'Demo', status: 'Normal' });
  });

  it('getById issues a parameterized SELECT and returns null when empty', async () => {
    const db = new FakeDb();
    db.nextRows = [];
    const repos = createRepositories(db);

    const row = await repos.markets.getById('m1');
    expect(db.last.text).toBe('SELECT * FROM markets WHERE id = $1');
    expect(db.last.values).toEqual(['m1']);
    expect(row).toBeNull();
  });

  it('updateStatus binds status and id in order', async () => {
    const db = new FakeDb();
    const repos = createRepositories(db);
    await repos.markets.updateStatus('m1', 'Paused');
    expect(db.last.text).toContain('UPDATE markets SET status = $1 WHERE id = $2');
    expect(db.last.values).toEqual(['Paused', 'm1']);
  });
});

describe('PoliciesRepository', () => {
  it('omits undefined optional columns from the INSERT', async () => {
    const db = new FakeDb();
    const repos = createRepositories(db);

    await repos.policies.create({
      market_id: 'm1',
      on_chain_policy_id: '0xpolicy',
      owner_address: '0xowner',
      dao_address: '0xdao',
      allowed_actions: ['pause_new_borrows'],
      max_ltv_delta_bps: 500,
      max_margin_delta_bps: 300,
      pause_duration_limit_ms: 86_400_000,
      cooldown_ms: 60_000,
      risk_thresholds: { warning: 60 },
    });

    expect(db.last.text).toContain('INSERT INTO policies');
    // guardian_cap_id / override_cap_id were undefined -> not listed.
    expect(db.last.text).not.toContain('guardian_cap_id');
    // The array and JSONB values are passed as bind params, not interpolated.
    expect(db.last.values).toContain('0xpolicy');
    expect(db.last.values).toContainEqual(['pause_new_borrows']);
    expect(db.last.values).toContainEqual({ warning: 60 });
    expectParameterized(db.last.text, db.last.values);
  });

  it('updateThresholds binds thresholds, version, and id in order', async () => {
    const db = new FakeDb();
    const repos = createRepositories(db);
    await repos.policies.updateThresholds('p1', { warning: 70 }, 2);
    expect(db.last.text).toContain('SET risk_thresholds = $1, version = $2');
    expect(db.last.values).toEqual([{ warning: 70 }, 2, 'p1']);
  });

  it('listByMarketId filters by market_id', async () => {
    const db = new FakeDb();
    db.nextRows = [{ id: 'p1' }, { id: 'p2' }];
    const repos = createRepositories(db);
    const rows = await repos.policies.listByMarketId('m1');
    expect(db.last.text).toContain('WHERE market_id = $1');
    expect(db.last.values).toEqual(['m1']);
    expect(rows).toHaveLength(2);
  });
});

describe('RiskSnapshotsRepository', () => {
  it('getLatestByMarket orders by created_at DESC LIMIT 1', async () => {
    const db = new FakeDb();
    db.nextRows = [{ id: 's1', risk_score: 42 }];
    const repos = createRepositories(db);

    const row = await repos.riskSnapshots.getLatestByMarket('m1');
    expect(db.last.text).toContain('ORDER BY created_at DESC LIMIT 1');
    expect(db.last.values).toEqual(['m1']);
    expect(row).toEqual({ id: 's1', risk_score: 42 });
  });

  it('listByMarket binds market and limit', async () => {
    const db = new FakeDb();
    const repos = createRepositories(db);
    await repos.riskSnapshots.listByMarket('m1', 25);
    expect(db.last.text).toContain('WHERE market_id = $1 ORDER BY created_at DESC LIMIT $2');
    expect(db.last.values).toEqual(['m1', 25]);
  });
});

describe('IncidentsRepository', () => {
  it('close sets ended_at and COALESCEs summary', async () => {
    const db = new FakeDb();
    const repos = createRepositories(db);
    const when = new Date('2024-01-01T00:00:00Z');
    await repos.incidents.close('i1', when, 'resolved');
    expect(db.last.text).toContain('SET ended_at = $1, summary = COALESCE($2, summary)');
    expect(db.last.values).toEqual([when, 'resolved', 'i1']);
  });

  it('listOpen filters ended_at IS NULL', async () => {
    const db = new FakeDb();
    const repos = createRepositories(db);
    await repos.incidents.listOpen('m1');
    expect(db.last.text).toContain('ended_at IS NULL');
    expect(db.last.values).toEqual(['m1']);
  });
});

describe('ActionsRepository', () => {
  it('markReversed sets reversal fields and binds in order', async () => {
    const db = new FakeDb();
    const repos = createRepositories(db);
    await repos.actions.markReversed('a1', '0xdao', '0xdigest');
    expect(db.last.text).toContain('SET is_reversed = true, reversed_by = $1, reversal_tx_digest = $2');
    expect(db.last.values).toEqual(['0xdao', '0xdigest', 'a1']);
  });

  it('listByIncident orders ascending for timeline replay', async () => {
    const db = new FakeDb();
    const repos = createRepositories(db);
    await repos.actions.listByIncident('i1');
    expect(db.last.text).toContain('WHERE incident_id = $1 ORDER BY timestamp_ms ASC');
    expect(db.last.values).toEqual(['i1']);
  });

  it('create binds the timestamp_ms value as a parameter', async () => {
    const db = new FakeDb();
    const repos = createRepositories(db);
    await repos.actions.create({
      policy_id: 'p1',
      market_id: 'm1',
      actor: '0xagent',
      actor_type: 'agent',
      action_type: 'pause_new_borrows',
      timestamp_ms: 1_700_000_000_000,
    });
    expect(db.last.text).toContain('INSERT INTO actions');
    expect(db.last.values).toContain(1_700_000_000_000);
    expectParameterized(db.last.text, db.last.values);
  });
});

describe('WalrusBlobsRepository', () => {
  it('create performs an upsert keyed on blob_id', async () => {
    const db = new FakeDb();
    db.nextRows = [{ blob_id: 'b1', status: 'pending_upload' }];
    const repos = createRepositories(db);

    const row = await repos.walrusBlobs.create({
      blob_id: 'b1',
      status: 'pending_upload',
    });
    expect(db.last.text).toContain('INSERT INTO walrus_blobs');
    expect(db.last.text).toContain('ON CONFLICT (blob_id) DO UPDATE');
    // Defaults applied for the optional columns.
    expect(db.last.values).toEqual(['b1', null, null, 'pending_upload', null, 0, null, null]);
    expect(row).toEqual({ blob_id: 'b1', status: 'pending_upload' });
  });

  it('recordAttempt increments attempt_count and sets status', async () => {
    const db = new FakeDb();
    const repos = createRepositories(db);
    const when = new Date('2024-01-01T00:00:00Z');
    await repos.walrusBlobs.recordAttempt('b1', 'retrying', when);
    expect(db.last.text).toContain('attempt_count = attempt_count + 1');
    expect(db.last.values).toEqual([when, 'retrying', 'b1']);
  });

  it('linkToAction sets linked_on_chain status', async () => {
    const db = new FakeDb();
    const repos = createRepositories(db);
    await repos.walrusBlobs.linkToAction('b1', 'a1', '0xhash');
    expect(db.last.text).toContain("status = 'linked_on_chain'");
    expect(db.last.values).toEqual(['a1', '0xhash', 'b1']);
  });
});

describe('EnvironmentChecksRepository', () => {
  it('append builds a parameterized INSERT, omitting the defaulted id', async () => {
    const db = new FakeDb();
    db.nextRows = [{ id: 'e1', check_type: 'rpc_chain_id', outcome: 'pass' }];
    const repos = createRepositories(db);

    const row = await repos.environmentChecks.append({
      check_type: 'rpc_chain_id',
      outcome: 'pass',
      detail: 'chain id matches',
    });
    expect(db.last.text).toContain('INSERT INTO environment_checks');
    expect(db.last.values).toEqual(['rpc_chain_id', 'pass', 'chain id matches']);
    expect(row.outcome).toBe('pass');
  });

  it('latestByType returns null when no checks exist', async () => {
    const db = new FakeDb();
    db.nextRows = [];
    const repos = createRepositories(db);
    const row = await repos.environmentChecks.latestByType('digest_origin');
    expect(db.last.text).toContain('ORDER BY checked_at DESC LIMIT 1');
    expect(row).toBeNull();
  });
});

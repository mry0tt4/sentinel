// Feature: sentinel-risk-guardian, Property 29: Indexer reconciles to chain state after restart

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type {
  ActionInsert,
  ActionRow,
  MarketRow,
  MarketStatus,
  PolicyRow,
  WalrusBlobRow,
  WalrusStatus,
} from '../db/types.js';

import { InMemoryCheckpointStore } from './checkpointStore.js';
import { ProtocolStateIndexer, type IndexerDeps } from './indexer.js';
import type {
  EventCursor,
  EventPage,
  EventQuery,
  IndexerActionsRepo,
  IndexerMarketsRepo,
  IndexerPoliciesRepo,
  IndexerWalrusRepo,
  RawIndexedEvent,
  SuiEventSource,
} from './types.js';

// ---------------------------------------------------------------------------
// Fakes — replicated from indexer.test.ts (no live RPC, no live DB).
// ---------------------------------------------------------------------------

/**
 * Deterministic in-memory event source with real cursor semantics: reading
 * with a cursor returns the events *after* it, mirroring `queryEvents`.
 */
class FakeEventSource implements SuiEventSource {
  constructor(private readonly events: RawIndexedEvent[]) {}

  async queryEvents(query: EventQuery): Promise<EventPage> {
    const limit = query.limit ?? 50;

    let start = 0;
    if (query.cursor) {
      const idx = this.events.findIndex(
        (e) =>
          e.id.txDigest === query.cursor!.txDigest &&
          e.id.eventSeq === query.cursor!.eventSeq,
      );
      start = idx === -1 ? 0 : idx + 1;
    }

    const slice = this.events.slice(start, start + limit);
    const end = start + slice.length;
    const last = slice[slice.length - 1];
    const nextCursor: EventCursor | null = last ? { ...last.id } : query.cursor ?? null;
    return {
      data: slice,
      nextCursor,
      hasNextPage: end < this.events.length,
    };
  }
}

class FakeActionsRepo implements IndexerActionsRepo {
  public rows: ActionRow[] = [];
  public createCalls = 0;
  private seq = 0;

  async getByTxDigest(txDigest: string): Promise<ActionRow | null> {
    return this.rows.find((r) => r.tx_digest === txDigest) ?? null;
  }

  async create(input: ActionInsert): Promise<ActionRow> {
    this.createCalls += 1;
    this.seq += 1;
    const row: ActionRow = {
      id: input.id ?? `action-${this.seq}`,
      policy_id: input.policy_id,
      market_id: input.market_id,
      incident_id: input.incident_id ?? null,
      actor: input.actor,
      actor_type: input.actor_type,
      risk_score: input.risk_score ?? null,
      action_type: input.action_type,
      old_value: input.old_value ?? null,
      new_value: input.new_value ?? null,
      walrus_evidence_blob_id: input.walrus_evidence_blob_id ?? null,
      evidence_hash: input.evidence_hash ?? null,
      tx_digest: input.tx_digest ?? null,
      is_reversed: input.is_reversed ?? false,
      reversed_by: input.reversed_by ?? null,
      reversal_tx_digest: input.reversal_tx_digest ?? null,
      override_reason: input.override_reason ?? null,
      timestamp_ms: String(input.timestamp_ms),
      created_at: new Date(),
    };
    this.rows.push(row);
    return row;
  }
}

class FakeWalrusRepo implements IndexerWalrusRepo {
  public blobs = new Map<string, WalrusBlobRow>();

  seed(blobId: string, status: WalrusStatus = 'uploaded'): void {
    this.blobs.set(blobId, {
      blob_id: blobId,
      action_id: null,
      market_id: null,
      status,
      evidence_hash: null,
      attempt_count: 0,
      last_attempt_at: null,
      payload: null,
      created_at: new Date(),
    });
  }

  async getById(blobId: string): Promise<WalrusBlobRow | null> {
    return this.blobs.get(blobId) ?? null;
  }

  async linkToAction(
    blobId: string,
    actionId: string,
    evidenceHash: string,
  ): Promise<WalrusBlobRow | null> {
    const existing = this.blobs.get(blobId);
    if (!existing) {
      return null;
    }
    const updated: WalrusBlobRow = {
      ...existing,
      action_id: actionId,
      evidence_hash: evidenceHash,
      status: 'linked_on_chain',
    };
    this.blobs.set(blobId, updated);
    return updated;
  }
}

class FakeMarketsRepo implements IndexerMarketsRepo {
  public byOnChain = new Map<string, MarketRow>();
  public byId = new Map<string, MarketRow>();

  seed(id: string, onChainId: string): void {
    const row: MarketRow = {
      id,
      on_chain_id: onChainId,
      market_type: 'demo',
      name: id,
      status: 'Normal',
      freshness_threshold_ms: '30000',
      created_at: new Date(),
    };
    this.byOnChain.set(onChainId, row);
    this.byId.set(id, row);
  }

  async getByOnChainId(onChainId: string): Promise<MarketRow | null> {
    return this.byOnChain.get(onChainId) ?? null;
  }

  async updateStatus(id: string, status: MarketStatus): Promise<MarketRow | null> {
    const row = this.byId.get(id);
    if (!row) {
      return null;
    }
    const updated = { ...row, status };
    this.byId.set(id, updated);
    this.byOnChain.set(row.on_chain_id, updated);
    return updated;
  }
}

class FakePoliciesRepo implements IndexerPoliciesRepo {
  public byOnChain = new Map<string, PolicyRow>();
  public byId = new Map<string, PolicyRow>();

  seed(id: string, onChainPolicyId: string, marketId: string, owner = '0xowner'): void {
    const row: PolicyRow = {
      id,
      market_id: marketId,
      on_chain_policy_id: onChainPolicyId,
      guardian_cap_id: '0xguardian',
      override_cap_id: '0xoverride',
      owner_address: owner,
      dao_address: '0xdao',
      allowed_actions: ['pause_new_borrows'],
      max_ltv_delta_bps: 500,
      max_margin_delta_bps: 300,
      pause_duration_limit_ms: '86400000',
      cooldown_ms: '60000',
      risk_thresholds: { warning: 60 },
      is_revoked: false,
      is_paused: false,
      version: 1,
      walrus_config_blob_id: null,
      created_at: new Date(),
    };
    this.byOnChain.set(onChainPolicyId, row);
    this.byId.set(id, row);
  }

  async getByOnChainPolicyId(onChainPolicyId: string): Promise<PolicyRow | null> {
    return this.byOnChain.get(onChainPolicyId) ?? null;
  }

  async setRevoked(id: string, isRevoked: boolean): Promise<PolicyRow | null> {
    const row = this.byId.get(id);
    if (!row) {
      return null;
    }
    const updated = { ...row, is_revoked: isRevoked };
    this.byId.set(id, updated);
    this.byOnChain.set(row.on_chain_policy_id, updated);
    return updated;
  }
}

const PKG = '0xpkg';

/** Build a RiskActionExecuted raw event with a distinct tx digest per seq. */
function executedEvent(seq: number): RawIndexedEvent {
  return {
    id: { txDigest: `0xtx${seq}`, eventSeq: '0' },
    type: `${PKG}::sentinel_policy::RiskActionExecuted`,
    sender: '0xagent',
    timestampMs: String(1_700_000_000_000 + seq),
    parsedJson: {
      policy_id: '0xpolicy',
      market_id: '0xmarket',
      action_type: 0,
      risk_score: 85,
      old_value: '0',
      new_value: '1',
      evidence_blob_id: 'blob-1',
      evidence_hash: '0xabcdef',
    },
  };
}

/**
 * Build a fresh set of shared, durable collaborators (repositories +
 * checkpoint store) that survive across the simulated restart boundary. Only
 * the event source is swapped per-run, mirroring a process restart that keeps
 * its database + persisted checkpoint but reconnects to the chain afresh.
 */
function makeSharedState(): {
  actions: FakeActionsRepo;
  walrus: FakeWalrusRepo;
  markets: FakeMarketsRepo;
  policies: FakePoliciesRepo;
  checkpoints: InMemoryCheckpointStore;
} {
  const actions = new FakeActionsRepo();
  const walrus = new FakeWalrusRepo();
  const markets = new FakeMarketsRepo();
  const policies = new FakePoliciesRepo();
  const checkpoints = new InMemoryCheckpointStore();

  markets.seed('m1', '0xmarket');
  policies.seed('p1', '0xpolicy', 'm1');
  walrus.seed('blob-1');

  return { actions, walrus, markets, policies, checkpoints };
}

function depsWithSource(
  shared: ReturnType<typeof makeSharedState>,
  source: SuiEventSource,
): IndexerDeps {
  return {
    source,
    checkpoints: shared.checkpoints,
    actions: shared.actions,
    walrus: shared.walrus,
    markets: shared.markets,
    policies: shared.policies,
  };
}

// ---------------------------------------------------------------------------
// Property 29.
// ---------------------------------------------------------------------------

describe('Property 29: Indexer reconciles to chain state after restart', () => {
  // **Validates: Requirements 17.6**
  it('persisted action set exactly matches the on-chain executed-event set across a restart boundary', async () => {
    await fc.assert(
      fc.asyncProperty(
        // total seeded on-chain actions (small fixed-ish set)
        fc.integer({ min: 1, max: 12 }),
        // how many of those events are visible during the FIRST run
        fc.integer({ min: 0, max: 12 }),
        // small page sizes so the drain crosses page boundaries
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        async (total, firstRaw, pageSizeA, pageSizeB) => {
          // The restart boundary can fall anywhere from before the first event
          // to after the last one.
          const firstCount = Math.min(firstRaw, total);

          // Fixed seeded on-chain ActionLog set with distinct tx digests.
          const events = Array.from({ length: total }, (_, i) => executedEvent(i + 1));

          const shared = makeSharedState();

          // --- First run: only `firstCount` events available on chain. ---
          const sourceA = new FakeEventSource(events.slice(0, firstCount));
          const indexerA = new ProtocolStateIndexer(
            depsWithSource(shared, sourceA),
            { pageSize: pageSizeA },
          );

          // --- Restart boundary: fresh indexer + fresh source exposing the
          // full set, sharing the SAME persisted checkpoint + repositories. ---
          const sourceB = new FakeEventSource(events);
          const indexerB = new ProtocolStateIndexer(
            depsWithSource(shared, sourceB),
            { pageSize: pageSizeB },
          );

          await indexerA.runOnce();
          await indexerB.runOnce();

          const expectedDigests = events.map((e) => e.id.txDigest).sort();
          const persistedDigests = shared.actions.rows
            .map((r) => r.tx_digest)
            .sort();

          // No missing records: every on-chain digest is persisted.
          // No duplicates: the row count equals the distinct on-chain count.
          const unique = new Set(persistedDigests);

          return (
            persistedDigests.length === expectedDigests.length &&
            unique.size === expectedDigests.length &&
            JSON.stringify(persistedDigests) === JSON.stringify(expectedDigests)
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('reconciles a small fixed seeded set with a mid-stream restart (concrete example)', async () => {
    const events = Array.from({ length: 6 }, (_, i) => executedEvent(i + 1));
    const shared = makeSharedState();

    // First run sees only the first 3 events, page size 2 (crosses pages).
    const indexerA = new ProtocolStateIndexer(
      depsWithSource(shared, new FakeEventSource(events.slice(0, 3))),
      { pageSize: 2 },
    );
    const resultA = await indexerA.runOnce();
    expect(resultA.processed).toBe(3);

    // Restart: fresh indexer + full source, shared checkpoint + repos.
    const indexerB = new ProtocolStateIndexer(
      depsWithSource(shared, new FakeEventSource(events)),
      { pageSize: 2 },
    );
    const resultB = await indexerB.runOnce();
    expect(resultB.processed).toBe(3); // only the 3 new events reprocessed

    const expectedDigests = events.map((e) => e.id.txDigest).sort();
    const persistedDigests = shared.actions.rows.map((r) => r.tx_digest).sort();
    expect(persistedDigests).toEqual(expectedDigests);
    expect(shared.actions.rows).toHaveLength(events.length);
    // No duplicate create calls — one row per distinct digest.
    expect(shared.actions.createCalls).toBe(events.length);
  });
});

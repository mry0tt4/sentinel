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
import type { ServerMessage } from '../ws/messages.js';
import type { MessagePublisher } from '../ws/subscriptionRegistry.js';

// ---------------------------------------------------------------------------
// Fakes — no live RPC, no live DB.
// ---------------------------------------------------------------------------

/**
 * Deterministic in-memory event source with real cursor semantics: reading
 * with a cursor returns the events *after* it, mirroring `queryEvents`.
 */
class FakeEventSource implements SuiEventSource {
  public calls = 0;
  constructor(private readonly events: RawIndexedEvent[]) {}

  async queryEvents(query: EventQuery): Promise<EventPage> {
    this.calls += 1;
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

class FakePoliciesRepo implements IndexerPoliciesRepo {  public byOnChain = new Map<string, PolicyRow>();
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

/** Captures every server message published, so broadcasts are observable. */
class FakePublisher implements MessagePublisher {
  public readonly published: ServerMessage[] = [];

  publish(message: ServerMessage): void {
    this.published.push(message);
  }
}

// ---------------------------------------------------------------------------
// Event builders.
// ---------------------------------------------------------------------------
const PKG = '0xpkg';

function executedEvent(
  seq: number,
  overrides: Partial<{
    digest: string;
    blobId: string;
    actionType: number;
    riskScore: number;
  }> = {},
): RawIndexedEvent {
  const digest = overrides.digest ?? `0xtx${seq}`;
  return {
    id: { txDigest: digest, eventSeq: '0' },
    type: `${PKG}::sentinel_policy::RiskActionExecuted`,
    sender: '0xagent',
    timestampMs: String(1_700_000_000_000 + seq),
    parsedJson: {
      policy_id: '0xpolicy',
      market_id: '0xmarket',
      action_type: overrides.actionType ?? 0,
      risk_score: overrides.riskScore ?? 85,
      old_value: '0',
      new_value: '1',
      evidence_blob_id: overrides.blobId ?? 'blob-1',
      evidence_hash: '0xabcdef',
    },
  };
}

function revokedEvent(seq: number): RawIndexedEvent {
  return {
    id: { txDigest: `0xtx${seq}`, eventSeq: '0' },
    type: `${PKG}::sentinel_policy::GuardianRevoked`,
    sender: '0xdao',
    timestampMs: String(1_700_000_000_000 + seq),
    parsedJson: {
      policy_id: '0xpolicy',
      guardian_cap_id: '0xguardian',
      dao_address: '0xdao',
    },
  };
}

interface Harness {
  deps: IndexerDeps;
  source: FakeEventSource;
  actions: FakeActionsRepo;
  walrus: FakeWalrusRepo;
  markets: FakeMarketsRepo;
  policies: FakePoliciesRepo;
  checkpoints: InMemoryCheckpointStore;
  publisher: FakePublisher;
}

function makeHarness(events: RawIndexedEvent[], seededBlobs: string[] = []): Harness {
  const source = new FakeEventSource(events);
  const actions = new FakeActionsRepo();
  const walrus = new FakeWalrusRepo();
  const markets = new FakeMarketsRepo();
  const policies = new FakePoliciesRepo();
  const checkpoints = new InMemoryCheckpointStore();
  const publisher = new FakePublisher();

  markets.seed('m1', '0xmarket');
  policies.seed('p1', '0xpolicy', 'm1');
  for (const b of seededBlobs) {
    walrus.seed(b);
  }

  return {
    deps: { source, checkpoints, actions, walrus, markets, policies, publisher },
    source,
    actions,
    walrus,
    markets,
    policies,
    checkpoints,
    publisher,
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('ProtocolStateIndexer', () => {
  it('persists RiskActionExecuted events as actions rows mirroring the ActionLog', async () => {
    const h = makeHarness([executedEvent(1), executedEvent(2)], ['blob-1']);
    const indexer = new ProtocolStateIndexer(h.deps);

    const result = await indexer.runOnce();

    expect(result.processed).toBe(2);
    expect(result.actionsPersisted).toBe(2);
    expect(h.actions.rows).toHaveLength(2);

    const first = h.actions.rows[0]!;
    expect(first.policy_id).toBe('p1');
    expect(first.market_id).toBe('m1');
    expect(first.actor).toBe('0xowner');
    expect(first.actor_type).toBe('agent');
    expect(first.action_type).toBe('pause_new_borrows');
    expect(first.risk_score).toBe(85);
    expect(first.tx_digest).toBe('0xtx1');
    expect(first.walrus_evidence_blob_id).toBe('blob-1');
    expect(first.evidence_hash).toBe('0xabcdef');
    expect(first.timestamp_ms).toBe('1700000000001');
  });

  it('flips a linked Walrus evidence blob to linked_on_chain for an executed action', async () => {
    const h = makeHarness([executedEvent(1, { blobId: 'blob-xyz' })], ['blob-xyz']);
    const indexer = new ProtocolStateIndexer(h.deps);

    const result = await indexer.runOnce();

    expect(result.evidenceLinked).toBe(1);
    const blob = await h.walrus.getById('blob-xyz');
    expect(blob?.status).toBe('linked_on_chain');
    expect(blob?.action_id).toBe(h.actions.rows[0]!.id);
    expect(blob?.evidence_hash).toBe('0xabcdef');
  });

  it('does not link evidence when the blob id is unknown to the store', async () => {
    const h = makeHarness([executedEvent(1, { blobId: 'missing-blob' })], []);
    const indexer = new ProtocolStateIndexer(h.deps);

    const result = await indexer.runOnce();

    expect(result.actionsPersisted).toBe(1);
    expect(result.evidenceLinked).toBe(0);
  });

  it('applies GuardianRevoked by revoking the policy and flipping the market to Revoked', async () => {
    const h = makeHarness([revokedEvent(1)]);
    const indexer = new ProtocolStateIndexer(h.deps);

    const result = await indexer.runOnce();

    expect(result.revocations).toBe(1);
    expect(h.policies.byId.get('p1')?.is_revoked).toBe(true);
    expect(h.markets.byId.get('m1')?.status).toBe('Revoked');
  });

  it('broadcasts a guardian_revoked message for the market on revoke success (Req 12.2, 11.8)', async () => {
    const h = makeHarness([revokedEvent(1)]);
    const indexer = new ProtocolStateIndexer(h.deps);

    await indexer.runOnce();

    expect(h.publisher.published).toHaveLength(1);
    const message = h.publisher.published[0]!;
    expect(message.type).toBe('guardian_revoked');
    if (message.type === 'guardian_revoked') {
      // Scoped to the OFF-CHAIN market id the dashboard subscribes with.
      expect(message.marketId).toBe('m1');
      // Carries the confirmed-revocation time as an ISO 8601 string.
      expect(message.at).toBe(new Date(1_700_000_000_001).toISOString());
    }
  });

  it('does not re-broadcast guardian_revoked for an already-revoked policy (Req 12.6)', async () => {
    const h = makeHarness([revokedEvent(1)]);
    // Pre-revoke the policy as if a prior revocation had already been applied.
    await h.policies.setRevoked('p1', true);

    const indexer = new ProtocolStateIndexer(h.deps);
    await indexer.runOnce();

    // The market is still (re)affirmed Revoked, but no duplicate broadcast.
    expect(h.markets.byId.get('m1')?.status).toBe('Revoked');
    expect(h.publisher.published).toHaveLength(0);
  });

  it('applies GuardianRevoked without a publisher injected (broadcast is optional)', async () => {
    const h = makeHarness([revokedEvent(1)]);
    const { publisher: _omit, ...depsWithoutPublisher } = h.deps;
    const indexer = new ProtocolStateIndexer(depsWithoutPublisher);

    const result = await indexer.runOnce();

    expect(result.revocations).toBe(1);
    expect(h.markets.byId.get('m1')?.status).toBe('Revoked');
  });

  it('advances and persists the checkpoint as each event is processed', async () => {
    const h = makeHarness([executedEvent(1), executedEvent(2), executedEvent(3)], ['blob-1']);
    const indexer = new ProtocolStateIndexer(h.deps);

    const result = await indexer.runOnce();

    expect(result.checkpoint.processedCount).toBe(3);
    expect(result.checkpoint.lastTxDigest).toBe('0xtx3');
    expect(result.checkpoint.cursor).toEqual({ txDigest: '0xtx3', eventSeq: '0' });

    const persisted = await h.checkpoints.load('sentinel_policy_indexer');
    expect(persisted?.lastTxDigest).toBe('0xtx3');
    expect(persisted?.processedCount).toBe(3);
  });

  it('resumes from the saved checkpoint after a restart and does not reprocess seen events', async () => {
    const events = [executedEvent(1), executedEvent(2), executedEvent(3)];

    // First run: only the first two events are available on chain.
    const h = makeHarness(events.slice(0, 2), ['blob-1']);
    const first = new ProtocolStateIndexer(h.deps);
    const firstResult = await first.runOnce();
    expect(firstResult.processed).toBe(2);
    expect(h.actions.createCalls).toBe(2);

    // Simulate a restart: a brand-new indexer instance + new source that now
    // exposes all three events, but sharing the SAME persisted checkpoint and
    // repositories. It must resume after event 2, processing only event 3.
    const restartedSource = new FakeEventSource(events);
    const restarted = new ProtocolStateIndexer(
      { ...h.deps, source: restartedSource },
      {},
    );
    const secondResult = await restarted.runOnce();

    expect(secondResult.processed).toBe(1);
    expect(secondResult.checkpoint.processedCount).toBe(3);
    expect(secondResult.checkpoint.lastTxDigest).toBe('0xtx3');

    // No duplicate action rows: 3 distinct digests, 3 create calls total.
    expect(h.actions.createCalls).toBe(3);
    const digests = h.actions.rows.map((r) => r.tx_digest).sort();
    expect(digests).toEqual(['0xtx1', '0xtx2', '0xtx3']);
  });

  it('reconciles the persisted action set to the full source event set after restart', async () => {
    const events = [executedEvent(1), executedEvent(2), executedEvent(3), executedEvent(4)];
    const h = makeHarness(events, ['blob-1']);

    // Process in two separate runs that span a restart boundary, using a small
    // page size so the drain crosses multiple pages.
    const idxA = new ProtocolStateIndexer(h.deps, { pageSize: 2 });
    await idxA.runOnce();

    const idxB = new ProtocolStateIndexer(
      { ...h.deps, source: new FakeEventSource(events) },
      { pageSize: 2 },
    );
    await idxB.runOnce();

    // Persisted actions reconcile exactly to the on-chain executed-event set.
    const expectedDigests = events.map((e) => e.id.txDigest).sort();
    const actualDigests = h.actions.rows.map((r) => r.tx_digest).sort();
    expect(actualDigests).toEqual(expectedDigests);
    expect(h.actions.rows).toHaveLength(events.length);
  });

  it('deduplicates an already-mirrored digest on overlapping replay', async () => {
    const h = makeHarness([executedEvent(1)], ['blob-1']);

    // Pre-seed the action as if a prior run had persisted it but the checkpoint
    // was lost (cursor null), forcing a replay from the start.
    await h.actions.create({
      policy_id: 'p1',
      market_id: 'm1',
      actor: '0xowner',
      actor_type: 'agent',
      action_type: 'pause_new_borrows',
      tx_digest: '0xtx1',
      timestamp_ms: 1,
    });

    const indexer = new ProtocolStateIndexer(h.deps);
    const result = await indexer.runOnce();

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.actionsPersisted).toBe(0);
    expect(h.actions.rows).toHaveLength(1);
  });

  it('ignores unknown event types without persisting, still advancing the checkpoint', async () => {
    const unknown: RawIndexedEvent = {
      id: { txDigest: '0xother', eventSeq: '0' },
      type: `${PKG}::sentinel_demo_market::SomethingElse`,
      parsedJson: {},
      timestampMs: '1700000000000',
    };
    const h = makeHarness([unknown]);
    const indexer = new ProtocolStateIndexer(h.deps);

    const result = await indexer.runOnce();

    expect(result.processed).toBe(1);
    expect(result.actionsPersisted).toBe(0);
    expect(h.actions.rows).toHaveLength(0);
    expect(result.checkpoint.lastTxDigest).toBe('0xother');
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { WalrusBlobInsert, WalrusBlobRow, WalrusStatus } from '../db/types.js';
import { EvidenceService } from './evidenceService.js';
import type { EvidenceBundle } from './types.js';
import {
  EVIDENCE_STATUSES,
  EvidenceUploader,
  EvidenceUploadError,
  MAX_UPLOAD_ATTEMPTS,
  MIN_RETRY_INTERVAL_MS,
  isEvidenceStatus,
  type Clock,
  type DelayFn,
  type EvidenceBlobStore,
} from './uploadManager.js';
import type { WalrusClient } from './walrusClient.js';
import { WalrusStoreError } from './walrusClient.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * In-memory store that mirrors `WalrusBlobsRepository` semantics: upsert on
 * `create`, increment attempt_count on `recordAttempt`, set status on
 * `updateStatus`. No database, no mocks of real functionality.
 */
class FakeBlobStore implements EvidenceBlobStore {
  readonly rows = new Map<string, WalrusBlobRow>();

  async create(input: WalrusBlobInsert): Promise<WalrusBlobRow> {
    const existing = this.rows.get(input.blob_id);
    const row: WalrusBlobRow = {
      blob_id: input.blob_id,
      action_id: input.action_id ?? null,
      market_id: input.market_id ?? null,
      status: input.status,
      evidence_hash: input.evidence_hash ?? null,
      attempt_count: input.attempt_count ?? 0,
      last_attempt_at:
        input.last_attempt_at != null ? new Date(input.last_attempt_at) : null,
      payload: input.payload ?? null,
      created_at: existing?.created_at ?? new Date(),
    };
    this.rows.set(input.blob_id, row);
    return row;
  }

  async recordAttempt(
    blobId: string,
    status: WalrusStatus,
    attemptAt: Date | string,
  ): Promise<WalrusBlobRow | null> {
    const row = this.rows.get(blobId);
    if (row === undefined) {
      return null;
    }
    const updated: WalrusBlobRow = {
      ...row,
      attempt_count: row.attempt_count + 1,
      last_attempt_at: new Date(attemptAt),
      status,
    };
    this.rows.set(blobId, updated);
    return updated;
  }

  async updateStatus(blobId: string, status: WalrusStatus): Promise<WalrusBlobRow | null> {
    const row = this.rows.get(blobId);
    if (row === undefined) {
      return null;
    }
    const updated: WalrusBlobRow = { ...row, status };
    this.rows.set(blobId, updated);
    return updated;
  }

  async getById(blobId: string): Promise<WalrusBlobRow | null> {
    return this.rows.get(blobId) ?? null;
  }

  async rekey(fromBlobId: string, toBlobId: string): Promise<WalrusBlobRow | null> {
    if (fromBlobId === toBlobId) {
      return this.rows.get(toBlobId) ?? null;
    }
    const existing = this.rows.get(toBlobId);
    if (existing !== undefined) {
      this.rows.delete(fromBlobId);
      return existing;
    }
    const row = this.rows.get(fromBlobId);
    if (row === undefined) {
      return null;
    }
    this.rows.delete(fromBlobId);
    const moved: WalrusBlobRow = { ...row, blob_id: toBlobId };
    this.rows.set(toBlobId, moved);
    return moved;
  }

  async linkToAction(
    blobId: string,
    actionId: string,
    evidenceHash: string,
  ): Promise<WalrusBlobRow | null> {
    const row = this.rows.get(blobId);
    if (row === undefined) {
      return null;
    }
    const updated: WalrusBlobRow = {
      ...row,
      action_id: actionId,
      evidence_hash: evidenceHash,
      status: 'linked_on_chain',
    };
    this.rows.set(blobId, updated);
    return updated;
  }

  /** The single tracking row created by an upload (tests create exactly one). */
  only(): WalrusBlobRow {
    const all = [...this.rows.values()];
    if (all.length !== 1) {
      throw new Error(`expected exactly one row, found ${all.length}`);
    }
    return all[0]!;
  }
}

/** Walrus client whose attempts succeed/fail according to a scripted queue. */
class ScriptedWalrusClient implements WalrusClient {
  calls = 0;
  constructor(
    private readonly outcomes: Array<{ ok: true; blobId: string } | { ok: false }>,
  ) {}

  async store(): Promise<{ blobId: string }> {
    const outcome = this.outcomes[this.calls] ?? { ok: false };
    this.calls += 1;
    if (outcome.ok) {
      return { blobId: outcome.blobId };
    }
    throw new WalrusStoreError('scripted failure');
  }
}

function fixedClock(ms: number): Clock {
  return { now: () => ms };
}

function bundleFixture(): EvidenceBundle {
  return {
    schemaVersion: '1.0',
    marketId: 'market-1',
    policyId: 'policy-1',
    timestampMs: 1_700_000_000_000,
    dataSource: 'live',
    scenarioId: null,
    prices: { price: '1850.25', confidence: '0.5', oracleTimestampMs: 1_700_000_000_000, freshnessMs: 0 },
    liquidity: { depth: '250000', spread: '18', imbalance: '-0.35' },
    exposureSnapshot: { utilization: '0.82', exposure: '4200000' },
    riskModelVersion: 'risk-model@1.2.3',
    promptConfigVersion: 'prompt@4.5.6',
    featureVector: {
      oraclePrice: 1850.25,
      oracleConfidence: 0.5,
      oracleTimestampMs: 1_700_000_000_000,
      nowMs: 1_700_000_000_000,
      freshnessThresholdMs: 10_000,
      priceChange1mPct: -1.2,
      priceChange5mPct: -3.4,
      priceChange15mPct: -5.6,
      realizedVolatilityPct: 12.5,
      liquidityDepth: 250_000,
      spreadBps: 18,
      imbalance: -0.35,
      utilization: 0.82,
      exposure: 4_200_000,
      currentMaxLtvBps: 7_500,
      borrowPaused: false,
      guardedMode: false,
      policyActive: true,
      guardianRevoked: false,
      priorActionsCount: 1,
      priorOverridesCount: 0,
      historicalEvidenceRefs: [],
    },
    riskScore: 82,
    riskClasses: ['high utilization'],
    recommendedAction: 'reduce_max_ltv',
    executedAction: 'reduce_max_ltv',
    aiExplanation: 'Utilization warrants an LTV reduction.',
    deterministicRuleOutputs: [{ rule: 'utilization_high', fired: true, value: '0.82' }],
    agentSigner: '0xAGENT',
    txDigest: null,
    priorActionIds: [],
    rawDataHash: 'deadbeef',
  };
}

/** A delay fn that records requested intervals without waiting. */
function recordingDelay(): { fn: DelayFn; intervals: number[] } {
  const intervals: number[] = [];
  const fn: DelayFn = async (ms) => {
    intervals.push(ms);
  };
  return { fn, intervals };
}

// ---------------------------------------------------------------------------
// Status set invariants
// ---------------------------------------------------------------------------

describe('evidence status set', () => {
  it('enumerates exactly the six allowed statuses', () => {
    expect([...EVIDENCE_STATUSES].sort()).toEqual(
      [
        'failed_upload',
        'linked_on_chain',
        'pending_upload',
        'private_encrypted',
        'retrying',
        'uploaded',
      ].sort(),
    );
  });

  it('isEvidenceStatus accepts allowed values and rejects others', () => {
    for (const s of EVIDENCE_STATUSES) {
      expect(isEvidenceStatus(s)).toBe(true);
    }
    expect(isEvidenceStatus('bogus')).toBe(false);
    expect(isEvidenceStatus(undefined)).toBe(false);
    expect(isEvidenceStatus(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('EvidenceUploader.upload — success', () => {
  it('first attempt succeeds → status uploaded, returns blobId + evidenceHash', async () => {
    const store = new FakeBlobStore();
    const walrus = new ScriptedWalrusClient([{ ok: true, blobId: 'BLOB_OK' }]);
    const { fn: delay, intervals } = recordingDelay();
    const uploader = new EvidenceUploader({ store, walrus, delay, clock: fixedClock(1_000) });

    const result = await uploader.upload(bundleFixture());

    expect(result.blobId).toBe('BLOB_OK');
    expect(result.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(walrus.calls).toBe(1);
    expect(intervals).toEqual([]); // no retry delay on first-attempt success
    expect(store.only().status).toBe('uploaded');
    expect(store.only().payload).not.toBeNull(); // bundle preserved
  });

  it('transient failures then success → uploaded, with ≥5s spacing between attempts', async () => {
    const store = new FakeBlobStore();
    const walrus = new ScriptedWalrusClient([
      { ok: false },
      { ok: false },
      { ok: true, blobId: 'BLOB_LATE' },
    ]);
    const { fn: delay, intervals } = recordingDelay();
    const uploader = new EvidenceUploader({ store, walrus, delay, clock: fixedClock(2_000) });

    const result = await uploader.upload(bundleFixture());

    expect(result.blobId).toBe('BLOB_LATE');
    expect(walrus.calls).toBe(3);
    // Two retries → two delays, each at least 5s apart.
    expect(intervals).toHaveLength(2);
    for (const ms of intervals) {
      expect(ms).toBeGreaterThanOrEqual(MIN_RETRY_INTERVAL_MS);
    }
    const row = store.only();
    expect(row.status).toBe('uploaded');
    expect(row.attempt_count).toBe(2); // two failed attempts recorded
  });
});

// ---------------------------------------------------------------------------
// Exhaustion path
// ---------------------------------------------------------------------------

describe('EvidenceUploader.upload — bounded retry exhaustion', () => {
  it('all 5 attempts fail → failed_upload, payload preserved, attempt_count 5, error thrown', async () => {
    const store = new FakeBlobStore();
    const walrus = new ScriptedWalrusClient(Array(MAX_UPLOAD_ATTEMPTS).fill({ ok: false }));
    const { fn: delay, intervals } = recordingDelay();
    const uploader = new EvidenceUploader({ store, walrus, delay, clock: fixedClock(3_000) });
    const bundle = bundleFixture();

    await expect(uploader.upload(bundle)).rejects.toBeInstanceOf(EvidenceUploadError);

    // Exactly 5 attempts, never more.
    expect(walrus.calls).toBe(MAX_UPLOAD_ATTEMPTS);
    // 5 attempts → 4 inter-attempt delays, each ≥5s.
    expect(intervals).toHaveLength(MAX_UPLOAD_ATTEMPTS - 1);
    for (const ms of intervals) {
      expect(ms).toBeGreaterThanOrEqual(MIN_RETRY_INTERVAL_MS);
    }

    const row = store.only();
    expect(row.status).toBe('failed_upload');
    expect(row.attempt_count).toBe(MAX_UPLOAD_ATTEMPTS);
    expect(row.payload).not.toBeNull(); // unuploaded bundle preserved (Req 10.7)
    expect(isEvidenceStatus(row.status)).toBe(true);
  });

  it('the thrown error carries the tracking record id, hash, and attempt count', async () => {
    const store = new FakeBlobStore();
    const walrus = new ScriptedWalrusClient(Array(MAX_UPLOAD_ATTEMPTS).fill({ ok: false }));
    const uploader = new EvidenceUploader({ store, walrus, delay: async () => {} });

    const err = await uploader.upload(bundleFixture()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvidenceUploadError);
    const uploadErr = err as EvidenceUploadError;
    expect(uploadErr.attempts).toBe(MAX_UPLOAD_ATTEMPTS);
    expect(uploadErr.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.getById(uploadErr.recordId)).not.toBeNull();
  });

  it('clamps a sub-5s configured interval up to the 5s floor', async () => {
    const store = new FakeBlobStore();
    const walrus = new ScriptedWalrusClient([{ ok: false }, { ok: true, blobId: 'B' }]);
    const { fn: delay, intervals } = recordingDelay();
    const uploader = new EvidenceUploader({ store, walrus, delay, retryIntervalMs: 10 });

    await uploader.upload(bundleFixture());

    expect(intervals).toEqual([MIN_RETRY_INTERVAL_MS]);
  });
});

// ---------------------------------------------------------------------------
// Status lifecycle observability
// ---------------------------------------------------------------------------

describe('EvidenceUploader — status is always one of the allowed set', () => {
  it('records only valid statuses across a failing-then-succeeding run', async () => {
    const store = new FakeBlobStore();
    const seen = new Set<string>();
    // Spy create/recordAttempt/updateStatus to capture every status written.
    const wrapped: EvidenceBlobStore = {
      create: async (i) => {
        seen.add(i.status);
        return store.create(i);
      },
      recordAttempt: async (id, status, at) => {
        seen.add(status);
        return store.recordAttempt(id, status, at);
      },
      updateStatus: async (id, status) => {
        seen.add(status);
        return store.updateStatus(id, status);
      },
      getById: (id) => store.getById(id),
      rekey: (from, to) => store.rekey(from, to),
      linkToAction: (id, actionId, hash) => store.linkToAction(id, actionId, hash),
    };
    const walrus = new ScriptedWalrusClient([{ ok: false }, { ok: true, blobId: 'B' }]);
    const uploader = new EvidenceUploader({ store: wrapped, walrus, delay: async () => {} });

    await uploader.upload(bundleFixture());

    for (const s of seen) {
      expect(isEvidenceStatus(s)).toBe(true);
    }
    expect(seen).toContain('pending_upload');
    expect(seen).toContain('retrying');
    expect(seen).toContain('uploaded');
  });

  it('getStatus returns the persisted status and null for unknown records', async () => {
    const store = new FakeBlobStore();
    const walrus = new ScriptedWalrusClient([{ ok: true, blobId: 'B' }]);
    const uploader = new EvidenceUploader({ store, walrus, delay: async () => {} });

    await uploader.upload(bundleFixture());
    const recordId = store.only().blob_id;

    expect(await uploader.getStatus(recordId)).toBe('uploaded');
    expect(await uploader.getStatus('does-not-exist')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EvidenceService delegation
// ---------------------------------------------------------------------------

describe('EvidenceService upload delegation', () => {
  it('delegates upload to the configured uploader', async () => {
    const store = new FakeBlobStore();
    const walrus = new ScriptedWalrusClient([{ ok: true, blobId: 'SVC_BLOB' }]);
    const service = new EvidenceService({ store, walrus, delay: async () => {} });

    const result = await service.upload(bundleFixture());

    expect(result.blobId).toBe('SVC_BLOB');
    expect(store.only().status).toBe('uploaded');
  });

  it('throws when upload is called without upload dependencies', async () => {
    const service = new EvidenceService();
    await expect(service.upload(bundleFixture())).rejects.toThrow(/without upload dependencies/);
  });
});

// ---------------------------------------------------------------------------
// Real timer wiring (sanity: default delay actually waits via setTimeout)
// ---------------------------------------------------------------------------

describe('EvidenceUploader — default delay uses real timers', () => {
  it('uses setTimeout-based delay when none is injected', async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeBlobStore();
      const walrus = new ScriptedWalrusClient([{ ok: false }, { ok: true, blobId: 'B' }]);
      const uploader = new EvidenceUploader({ store, walrus });

      const promise = uploader.upload(bundleFixture());
      // Advance past the 5s retry interval so the second attempt runs.
      await vi.advanceTimersByTimeAsync(MIN_RETRY_INTERVAL_MS);
      const result = await promise;

      expect(result.blobId).toBe('B');
    } finally {
      vi.useRealTimers();
    }
  });
});

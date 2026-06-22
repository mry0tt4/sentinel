// Feature: sentinel-risk-guardian, Property 21: Upload retry is bounded
//
// Property 21: Upload retry is bounded.
// At most MAX_UPLOAD_ATTEMPTS (5) attempts, each at least MIN_RETRY_INTERVAL_MS
// (5s) apart. After the 5th failed attempt the persisted status is exactly
// `failed_upload` with the bundle payload preserved for reprocessing. A success
// within the first 5 attempts resolves to `uploaded`.
//
// **Validates: Requirements 10.6, 10.7, 17.4**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { WalrusBlobInsert, WalrusBlobRow, WalrusStatus } from '../db/types.js';
import type { EvidenceBundle } from './types.js';
import {
  EvidenceUploader,
  EvidenceUploadError,
  MAX_UPLOAD_ATTEMPTS,
  MIN_RETRY_INTERVAL_MS,
  type Clock,
  type DelayFn,
  type EvidenceBlobStore,
} from './uploadManager.js';
import type { WalrusClient } from './walrusClient.js';
import { WalrusStoreError } from './walrusClient.js';

// ---------------------------------------------------------------------------
// Test doubles (mirrors uploadManager.test.ts — no DB, no real waits, no mocks)
// ---------------------------------------------------------------------------

/** In-memory store mirroring WalrusBlobsRepository semantics. */
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

  /** The single tracking row created by an upload. */
  only(): WalrusBlobRow {
    const all = [...this.rows.values()];
    if (all.length !== 1) {
      throw new Error(`expected exactly one row, found ${all.length}`);
    }
    return all[0]!;
  }
}

/**
 * Walrus client that fails the first `leadingFailures` attempts, then (if
 * `eventualSuccess`) succeeds, otherwise keeps failing. Counts every call so
 * the test can assert the attempt bound is never exceeded.
 */
class FailingThenWalrusClient implements WalrusClient {
  calls = 0;
  constructor(
    private readonly leadingFailures: number,
    private readonly eventualSuccess: boolean,
  ) {}

  async store(): Promise<{ blobId: string }> {
    const attemptIndex = this.calls; // 0-based
    this.calls += 1;
    if (attemptIndex < this.leadingFailures || !this.eventualSuccess) {
      throw new WalrusStoreError(`scripted failure #${attemptIndex + 1}`);
    }
    return { blobId: `BLOB_${attemptIndex}` };
  }
}

function fixedClock(ms: number): Clock {
  return { now: () => ms };
}

/** A delay fn that records requested intervals without waiting. */
function recordingDelay(): { fn: DelayFn; intervals: number[] } {
  const intervals: number[] = [];
  const fn: DelayFn = async (ms) => {
    intervals.push(ms);
  };
  return { fn, intervals };
}

function bundleFixture(): EvidenceBundle {
  return {
    schemaVersion: '1.0',
    marketId: 'market-1',
    policyId: 'policy-1',
    timestampMs: 1_700_000_000_000,
    dataSource: 'live',
    scenarioId: null,
    prices: {
      price: '1850.25',
      confidence: '0.5',
      oracleTimestampMs: 1_700_000_000_000,
      freshnessMs: 0,
    },
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

// ---------------------------------------------------------------------------
// Property 21
// ---------------------------------------------------------------------------

describe('Property 21: Upload retry is bounded', () => {
  it('bounds attempts to 5, spaces them ≥5s, and ends uploaded or failed_upload', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 0..8 leading failures so we cover both "success within the
        // first 5 attempts" and "failure count ≥ 5" (and the boundary at 5).
        fc.integer({ min: 0, max: 8 }),
        fc.boolean(),
        async (leadingFailures, eventualSuccess) => {
          const store = new FakeBlobStore();
          const walrus = new FailingThenWalrusClient(leadingFailures, eventualSuccess);
          const { fn: delay, intervals } = recordingDelay();
          const uploader = new EvidenceUploader({
            store,
            walrus,
            delay,
            clock: fixedClock(1_000),
          });

          // A success is reached only if it lands within the bounded attempts.
          const willSucceed = eventualSuccess && leadingFailures < MAX_UPLOAD_ATTEMPTS;

          let result: { blobId: string } | undefined;
          let thrown: unknown;
          try {
            result = await uploader.upload(bundleFixture());
          } catch (err) {
            thrown = err;
          }

          // --- Invariant A: attempts never exceed the bound, regardless of how
          // many failures were scripted. (Req 10.6)
          expect(walrus.calls).toBeLessThanOrEqual(MAX_UPLOAD_ATTEMPTS);

          // --- Invariant B: every inter-attempt delay is ≥5s. (Req 10.6)
          for (const ms of intervals) {
            expect(ms).toBeGreaterThanOrEqual(MIN_RETRY_INTERVAL_MS);
          }
          // One delay precedes each retry → exactly (attempts - 1) delays.
          expect(intervals).toHaveLength(Math.max(0, walrus.calls - 1));

          const row = store.only();

          if (willSucceed) {
            // --- Success branch: resolves with a blobId, status uploaded.
            expect(thrown).toBeUndefined();
            expect(result?.blobId).toBeTruthy();
            expect(walrus.calls).toBe(leadingFailures + 1);
            expect(row.status).toBe('uploaded');
          } else {
            // --- Exhaustion branch: all 5 attempts fail. (Req 10.7, 17.4)
            expect(result).toBeUndefined();
            expect(thrown).toBeInstanceOf(EvidenceUploadError);
            expect((thrown as EvidenceUploadError).attempts).toBe(MAX_UPLOAD_ATTEMPTS);

            // Exactly 5 attempts, never more.
            expect(walrus.calls).toBe(MAX_UPLOAD_ATTEMPTS);
            // Final persisted status is exactly `failed_upload`.
            expect(row.status).toBe('failed_upload');
            // attempt_count is 5.
            expect(row.attempt_count).toBe(MAX_UPLOAD_ATTEMPTS);
            // Bundle payload preserved (non-null) for reprocessing.
            expect(row.payload).not.toBeNull();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

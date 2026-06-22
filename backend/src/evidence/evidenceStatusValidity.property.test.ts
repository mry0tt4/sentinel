// Feature: sentinel-risk-guardian, Property 19: Evidence has exactly one valid status
//
// For any upload scenario — an arbitrary sequence of Walrus store outcomes
// (success/failure at each attempt, including all-fail, first-success, and
// mid-success) — EvidenceUploader drives the lifecycle so that EVERY status
// value ever persisted (via create / recordAttempt / updateStatus) is EXACTLY
// ONE member of EVIDENCE_STATUSES. Each persisted status is a single non-empty
// string in the allowed set, never undefined and never a multi-value. The FINAL
// persisted status is likewise exactly one valid value: `uploaded` on eventual
// success, `failed_upload` on exhaustion.
//
// Validates: Requirements 10.3

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { WalrusBlobInsert, WalrusBlobRow, WalrusStatus } from '../db/types.js';
import type { EvidenceBundle } from './types.js';
import {
  EVIDENCE_STATUSES,
  EvidenceUploader,
  EvidenceUploadError,
  MAX_UPLOAD_ATTEMPTS,
  isEvidenceStatus,
  type EvidenceBlobStore,
} from './uploadManager.js';
import type { WalrusClient } from './walrusClient.js';
import { WalrusStoreError } from './walrusClient.js';

// ---------------------------------------------------------------------------
// Test doubles
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
      last_attempt_at: input.last_attempt_at != null ? new Date(input.last_attempt_at) : null,
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
}

/**
 * Wraps a store so that EVERY status written through any lifecycle method is
 * captured (in write order) for inspection. The underlying behaviour is
 * unchanged — this is observation, not mocking of real functionality.
 */
function recordingStore(inner: EvidenceBlobStore): {
  store: EvidenceBlobStore;
  written: WalrusStatus[];
} {
  const written: WalrusStatus[] = [];
  const store: EvidenceBlobStore = {
    create: async (input) => {
      written.push(input.status);
      return inner.create(input);
    },
    recordAttempt: async (id, status, at) => {
      written.push(status);
      return inner.recordAttempt(id, status, at);
    },
    updateStatus: async (id, status) => {
      written.push(status);
      return inner.updateStatus(id, status);
    },
    getById: (id) => inner.getById(id),
    rekey: (from, to) => inner.rekey(from, to),
  };
  return { store, written };
}

/** Walrus client whose attempts succeed/fail according to a scripted queue. */
class ScriptedWalrusClient implements WalrusClient {
  calls = 0;
  constructor(private readonly outcomes: boolean[]) {}

  async store(): Promise<{ blobId: string }> {
    // Default to failure once the script is exhausted (defensive; the script
    // always covers MAX_UPLOAD_ATTEMPTS).
    const ok = this.outcomes[this.calls] ?? false;
    this.calls += 1;
    if (ok) {
      return { blobId: `BLOB_${this.calls}` };
    }
    throw new WalrusStoreError('scripted failure');
  }
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

const allowed: ReadonlySet<string> = new Set(EVIDENCE_STATUSES);

/** Assert a persisted status is exactly one valid member of the allowed set. */
function assertExactlyOneValidStatus(status: WalrusStatus): void {
  // A single string value...
  expect(typeof status).toBe('string');
  // ...never empty/undefined...
  expect(status).not.toBeUndefined();
  expect((status as string).length).toBeGreaterThan(0);
  // ...recognized by the type guard...
  expect(isEvidenceStatus(status)).toBe(true);
  // ...and present in the allowed set exactly once.
  expect(allowed.has(status)).toBe(true);
  expect(EVIDENCE_STATUSES.filter((s) => s === status)).toHaveLength(1);
}

/**
 * An outcome sequence of length MAX_UPLOAD_ATTEMPTS where each attempt is a
 * boolean (true = success). This covers all-fail, first-success, mid-success,
 * and last-attempt-success scenarios.
 */
const outcomeSequenceArbitrary = fc.array(fc.boolean(), {
  minLength: MAX_UPLOAD_ATTEMPTS,
  maxLength: MAX_UPLOAD_ATTEMPTS,
});

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

describe('Property 19: Evidence has exactly one valid status', () => {
  it('every persisted status (and the final status) is exactly one valid member of the set', async () => {
    await fc.assert(
      fc.asyncProperty(outcomeSequenceArbitrary, async (outcomes) => {
        const inner = new FakeBlobStore();
        const { store, written } = recordingStore(inner);
        const walrus = new ScriptedWalrusClient(outcomes);
        const uploader = new EvidenceUploader({
          store,
          walrus,
          delay: async () => {}, // no real waiting
          clock: { now: () => 1_000 },
        });

        // The first `true` in the sequence (if any) determines success.
        const firstSuccessIndex = outcomes.indexOf(true);
        const willSucceed = firstSuccessIndex !== -1;

        let threw = false;
        try {
          const result = await uploader.upload(bundleFixture());
          expect(result.blobId).toMatch(/^BLOB_\d+$/);
          expect(result.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
        } catch (err) {
          threw = true;
          expect(err).toBeInstanceOf(EvidenceUploadError);
        }

        // Outcome matches the script: success iff some attempt succeeded.
        expect(threw).toBe(!willSucceed);

        // At least one status was persisted (the initial pending_upload).
        expect(written.length).toBeGreaterThan(0);

        // INVARIANT: every status ever written is exactly one valid member.
        for (const status of written) {
          assertExactlyOneValidStatus(status);
        }

        // The first persisted status is always pending_upload.
        expect(written[0]).toBe('pending_upload');

        // The FINAL persisted status is exactly one valid value, and matches
        // the scenario outcome.
        const finalWritten = written[written.length - 1]!;
        assertExactlyOneValidStatus(finalWritten);
        expect(finalWritten).toBe(willSucceed ? 'uploaded' : 'failed_upload');

        // The persisted row's status agrees and is exactly one valid value.
        const rows = [...inner.rows.values()];
        expect(rows).toHaveLength(1);
        const persisted = rows[0]!.status;
        assertExactlyOneValidStatus(persisted);
        expect(persisted).toBe(willSucceed ? 'uploaded' : 'failed_upload');
      }),
      { numRuns: 200 },
    );
  });
});

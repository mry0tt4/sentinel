/**
 * Live integration test for the Walrus evidence upload round-trip (Req 10.2).
 *
 * Unlike `uploadManager.test.ts`, which drives the retry/status lifecycle with
 * an in-memory fake Walrus client, this suite stores a *real* Evidence_Bundle
 * on the public Walrus Testnet publisher via {@link HttpWalrusClient} +
 * {@link EvidenceUploader} and asserts the documented Req 10.2 contract: a
 * non-empty Walrus Blob_ID and a 64-hex SHA-256 evidence hash are returned
 * within 30 seconds of the upload being initiated.
 *
 * Live network tests are flaky in CI and fail when offline, so this suite is
 * guarded two ways (mirroring `oracleAdapter.integration.test.ts`):
 *   1. Opt-in: it only runs when `RUN_INTEGRATION=1` (or `true`) is set. A
 *      default `npm test` run skips it entirely and never fails offline.
 *   2. Even when opted in, a pre-flight connectivity probe skips the live
 *      assertions gracefully if the Walrus publisher is unreachable, so a flaky
 *      network degrades to a skip rather than a hard failure.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WalrusBlobInsert, WalrusBlobRow, WalrusStatus } from '../db/types.js';
import { EvidenceUploader, type EvidenceBlobStore } from './uploadManager.js';
import type { EvidenceBundle } from './types.js';
import { HttpWalrusClient } from './walrusClient.js';

/**
 * Walrus Testnet publisher URL. Read from env config (`WALRUS_PUBLISHER_URL`,
 * the same var `loadConfig` requires) and fall back to the public Testnet
 * publisher documented in `.env.example`.
 */
const WALRUS_PUBLISHER_URL =
  process.env.WALRUS_PUBLISHER_URL ?? 'https://publisher.walrus-testnet.walrus.space';

/** Opt-in flag: live network writes only happen when explicitly requested. */
const RUN_INTEGRATION =
  process.env.RUN_INTEGRATION === '1' || process.env.RUN_INTEGRATION === 'true';

/**
 * The Req 10.2 budget: a ready bundle must be stored on Walrus within 30s of
 * the upload being initiated.
 */
const ROUND_TRIP_BUDGET_MS = 30_000;

/**
 * Per-test timeout. A little larger than the 30s budget so the assertion that
 * the round trip is `< 30s` is what fails on a slow upload — not a Vitest
 * timeout that would mask the real result.
 */
const LIVE_TEST_TIMEOUT_MS = ROUND_TRIP_BUDGET_MS + 10_000;

/** Per-request timeout for the pre-flight connectivity probe (ms). */
const PROBE_TIMEOUT_MS = 15_000;

/** Tracks whether the pre-flight probe found the Walrus publisher reachable. */
let publisherReachable = false;

/**
 * Minimal in-memory {@link EvidenceBlobStore}. The round-trip test only needs
 * lifecycle persistence to succeed; it asserts against the returned Blob_ID and
 * evidence hash, not the store. Mirrors `WalrusBlobsRepository` semantics with
 * no database and no mocks of real functionality.
 */
class InMemoryBlobStore implements EvidenceBlobStore {
  private readonly rows = new Map<string, WalrusBlobRow>();

  async create(input: WalrusBlobInsert): Promise<WalrusBlobRow> {
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
      created_at: new Date(),
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
}

/**
 * Build a small, valid Evidence_Bundle. A unique `timestampMs`/`txDigest` per
 * call keeps each upload's bytes distinct, exercising the publisher's
 * `newlyCreated` path rather than always hitting `alreadyCertified`.
 */
function smallBundle(seed: number): EvidenceBundle {
  const ts = 1_700_000_000_000 + seed;
  return {
    schemaVersion: '1.0',
    marketId: `market-${seed}`,
    policyId: 'policy-itest',
    timestampMs: ts,
    dataSource: 'simulated',
    scenarioId: `walrus-round-trip-${seed}`,
    prices: { price: '1850.25', confidence: '0.5', oracleTimestampMs: ts, freshnessMs: 0 },
    liquidity: { depth: '250000', spread: '18', imbalance: '-0.35' },
    exposureSnapshot: { utilization: '0.82', exposure: '4200000' },
    riskModelVersion: 'risk-model@itest',
    promptConfigVersion: 'prompt@itest',
    featureVector: {
      oraclePrice: 1850.25,
      oracleConfidence: 0.5,
      oracleTimestampMs: ts,
      nowMs: ts,
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
    aiExplanation: 'Integration test bundle for Walrus round-trip timing.',
    deterministicRuleOutputs: [{ rule: 'utilization_high', fired: true, value: '0.82' }],
    agentSigner: '0xAGENT',
    txDigest: `itest-${seed}`,
    priorActionIds: [],
    rawDataHash: 'placeholder',
  };
}

/**
 * Probe the Walrus publisher once before the suite. The publisher accepts
 * blob PUTs at `/v1/blobs`; storing a tiny payload here both confirms
 * reachability and warms the path. Any failure (offline / DNS / non-OK) flips
 * the suite to skip mode rather than letting the real assertions error out.
 */
async function probeWalrusPublisher(): Promise<boolean> {
  if (typeof globalThis.fetch !== 'function') {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${WALRUS_PUBLISHER_URL.replace(/\/+$/, '')}/v1/blobs`, {
      method: 'PUT',
      body: new TextEncoder().encode(`sentinel-probe-${Date.now()}`),
      headers: { 'content-type': 'application/octet-stream' },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  if (RUN_INTEGRATION) {
    publisherReachable = await probeWalrusPublisher();
    if (!publisherReachable) {
      // eslint-disable-next-line no-console
      console.warn(
        `[walrusUpload.integration] Walrus publisher unreachable (${WALRUS_PUBLISHER_URL}) — skipping live uploads.`,
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      '[walrusUpload.integration] RUN_INTEGRATION not set — skipping live Walrus uploads. ' +
        'Set RUN_INTEGRATION=1 to enable.',
    );
  }
}, PROBE_TIMEOUT_MS + 1_000);

afterAll(() => {
  if (RUN_INTEGRATION && publisherReachable) {
    // eslint-disable-next-line no-console
    console.info('[walrusUpload.integration] Live Walrus uploads completed.');
  }
});

describe('Walrus evidence upload round-trip (integration, Req 10.2)', () => {
  // 1–2 small bundles uploaded live. `it.runIf` keeps these as clean skips
  // (not failures) when the suite is not opted in.
  for (const seed of [1, 2]) {
    it.runIf(RUN_INTEGRATION)(
      `uploads small bundle #${seed} and returns a Blob_ID + 64-hex hash within 30s`,
      async () => {
        if (!publisherReachable) {
          // Graceful skip at runtime if the pre-flight probe failed.
          return;
        }

        const walrus = new HttpWalrusClient({ publisherUrl: WALRUS_PUBLISHER_URL });
        const store = new InMemoryBlobStore();
        const uploader = new EvidenceUploader({ walrus, store });

        const start = Date.now();
        const { blobId, evidenceHash } = await uploader.upload(smallBundle(seed));
        const elapsedMs = Date.now() - start;

        // Req 10.2: a non-empty Walrus Blob_ID is returned.
        expect(typeof blobId).toBe('string');
        expect(blobId.length).toBeGreaterThan(0);
        // The evidence hash is a SHA-256 hex digest.
        expect(evidenceHash).toMatch(/^[0-9a-f]{64}$/);
        // Req 10.2: the round trip completes within 30 seconds.
        expect(elapsedMs).toBeLessThan(ROUND_TRIP_BUDGET_MS);
      },
      LIVE_TEST_TIMEOUT_MS,
    );
  }

  // Always-present guard so the file is never an empty suite in default runs.
  it('is opt-in and never fails a default offline test run', () => {
    expect(typeof RUN_INTEGRATION).toBe('boolean');
    expect(WALRUS_PUBLISHER_URL).toMatch(/^https?:\/\//);
  });
});

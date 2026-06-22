// Feature: sentinel-risk-guardian, Property 22: Secrets are never present in non-private evidence
//
// Three complementary facets of the secret-exclusion / encryption guarantee:
//
//  (a) REJECTION — For an arbitrary bundle AUGMENTED with a secret-looking key
//      (any FORBIDDEN_KEY_SUBSTRINGS base, with arbitrary separator/case/affix
//      variants, placed at the top level, nested in an object, or inside an
//      array), the shared guard refuses to persist it into a NON-private status:
//      `assertNoSecrets` throws, and the upload path (which produces
//      `pending_upload`/`uploaded` records) throws BEFORE writing anything to
//      the store. So a secret can never appear in `uploaded` /
//      `linked_on_chain` / `pending_upload`.
//
//  (b) CLEAN PASS — For arbitrary CLEAN bundles (no secret keys), the guard
//      passes, the upload reaches `uploaded`, and no forbidden secret substring
//      appears anywhere in the serialized non-private bundle.
//
//  (c) ENCRYPTION — When policy designates certain fields sensitive,
//      `encryptSensitiveFields` encrypts EXACTLY those present fields (their
//      plaintext no longer appears in the serialized bundle), lists them in
//      `sensitiveFieldsEncrypted`, and reports status `private_encrypted`.
//
// Validates: Requirements 10.8, 10.9, 16.1

import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { WalrusBlobInsert, WalrusBlobRow, WalrusStatus } from '../db/types.js';
import { EvidenceService } from './evidenceService.js';
import { assertNoSecrets, containsSecretKey, findSecretKey, FORBIDDEN_KEY_SUBSTRINGS } from './secretGuard.js';
import { encryptSensitiveFields } from './sensitiveFields.js';
import type { EvidenceBundle } from './types.js';
import {
  isEvidenceStatus,
  type EvidenceBlobStore,
} from './uploadManager.js';
import type { WalrusClient } from './walrusClient.js';

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
    if (row === undefined) return null;
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
    if (row === undefined) return null;
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
    if (row === undefined) return null;
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

/** Walrus client that always succeeds; lets the clean-path upload reach `uploaded`. */
const okWalrus: WalrusClient = {
  async store() {
    return { blobId: 'BLOB' };
  },
};

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A "safe" string: a readable prefix plus a hex suffix. Because every member of
 * FORBIDDEN_KEY_SUBSTRINGS contains at least one non-hex letter, a hex suffix
 * can never accidentally embed a forbidden substring, and the fixed prefixes
 * below are all secret-free — so clean bundles stay genuinely clean.
 */
function safeStringArb(prefix: string): fc.Arbitrary<string> {
  return fc.hexaString({ minLength: 1, maxLength: 12 }).map((h) => `${prefix}-${h}`);
}

/**
 * A secret-looking object key: a forbidden base substring with arbitrary
 * casing, surrounding affix words, and separator style. Whatever the variant,
 * its normalized form (lowercased, separators stripped) still contains the
 * normalized base, so the guard MUST detect it.
 */
const secretKeyArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...FORBIDDEN_KEY_SUBSTRINGS),
    fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }),
    fc.constantFrom('', 'user', 'agent', 'my', 'wallet', 'X'),
    fc.constantFrom('', 'Value', 'Field', '1', 'Hex'),
    fc.constantFrom('', '_', '-', ' '),
  )
  .map(([base, caseFlags, pre, post, sep]) => {
    const cased = base
      .split('')
      .map((ch, i) => (caseFlags[i % caseFlags.length] ? ch.toUpperCase() : ch))
      .join('');
    return `${pre}${sep}${cased}${sep}${post}`;
  });

/** Where to inject a secret key within a bundle. The guard walks recursively. */
const injectionSiteArb = fc.constantFrom('top', 'nested-object', 'array-element');

/** Build a representative clean EvidenceBundle from safe, varied parts. */
function makeBundle(parts: {
  marketId: string;
  policyId: string;
  agentSigner: string;
  aiExplanation: string;
  riskModelVersion: string;
  promptConfigVersion: string;
  riskScore: number;
  timestampMs: number;
  dataSource: 'live' | 'simulated';
  txDigest: string | null;
}): EvidenceBundle {
  return {
    schemaVersion: '1.0',
    marketId: parts.marketId,
    policyId: parts.policyId,
    timestampMs: parts.timestampMs,
    dataSource: parts.dataSource,
    scenarioId: parts.dataSource === 'simulated' ? 'scenario-1' : null,
    prices: {
      price: '1850.25',
      confidence: '0.5',
      oracleTimestampMs: 1_700_000_000_000,
      freshnessMs: 0,
    },
    liquidity: { depth: '250000', spread: '18', imbalance: '-0.35' },
    exposureSnapshot: { utilization: '0.82', exposure: '4200000' },
    riskModelVersion: parts.riskModelVersion,
    promptConfigVersion: parts.promptConfigVersion,
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
    riskScore: parts.riskScore,
    riskClasses: ['high utilization'],
    recommendedAction: 'reduce_max_ltv',
    executedAction: 'reduce_max_ltv',
    aiExplanation: parts.aiExplanation,
    deterministicRuleOutputs: [{ rule: 'utilization_high', fired: true, value: '0.82' }],
    agentSigner: parts.agentSigner,
    txDigest: parts.txDigest,
    priorActionIds: [],
    rawDataHash: createHash('sha256').update(parts.marketId, 'utf8').digest('hex'),
  };
}

/** Arbitrary clean bundle, with all string content drawn from safe alphabets. */
const cleanBundleArb: fc.Arbitrary<EvidenceBundle> = fc
  .record({
    marketId: safeStringArb('market'),
    policyId: safeStringArb('policy'),
    agentSigner: fc.hexaString({ minLength: 4, maxLength: 40 }).map((h) => `0x${h}`),
    aiExplanation: safeStringArb('explanation'),
    riskModelVersion: safeStringArb('riskmodel'),
    promptConfigVersion: safeStringArb('promptcfg'),
    riskScore: fc.integer({ min: 0, max: 100 }),
    timestampMs: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
    dataSource: fc.constantFrom<'live' | 'simulated'>('live', 'simulated'),
    txDigest: fc.option(fc.hexaString({ minLength: 4, maxLength: 32 }).map((h) => `DIGEST${h}`), {
      nil: null,
    }),
  })
  .map(makeBundle);

/** Top-level bundle string fields a policy may designate sensitive. */
const SENSITIVE_CANDIDATE_FIELDS = [
  'marketId',
  'policyId',
  'agentSigner',
  'aiExplanation',
  'riskModelVersion',
  'promptConfigVersion',
] as const;

// ---------------------------------------------------------------------------
// (a) Secret-bearing bundles are REJECTED from non-private persistence
// ---------------------------------------------------------------------------

describe('Property 22 (a): secret-bearing bundles are rejected before non-private persistence', () => {
  it('assertNoSecrets throws and upload never persists a secret-augmented bundle', async () => {
    await fc.assert(
      fc.asyncProperty(
        cleanBundleArb,
        secretKeyArb,
        safeStringArb('leak'),
        injectionSiteArb,
        async (clean, secretKey, secretValue, site) => {
          // Pre-condition: the base bundle is genuinely clean.
          expect(containsSecretKey(clean)).toBe(false);

          // Inject the secret-looking key at the chosen site.
          let tainted: EvidenceBundle;
          if (site === 'nested-object') {
            tainted = {
              ...clean,
              prices: { ...clean.prices, [secretKey]: secretValue } as never,
            };
          } else if (site === 'array-element') {
            tainted = {
              ...clean,
              deterministicRuleOutputs: [
                ...clean.deterministicRuleOutputs,
                { rule: 'x', fired: true, value: '0', [secretKey]: secretValue } as never,
              ],
            };
          } else {
            tainted = { ...clean, [secretKey]: secretValue } as EvidenceBundle;
          }

          // The guard detects the secret...
          expect(containsSecretKey(tainted)).toBe(true);
          expect(findSecretKey(tainted)).not.toBeNull();
          expect(() => assertNoSecrets(tainted)).toThrow(/secret field/);

          // ...and the non-private upload path rejects it WITHOUT persisting.
          const store = new FakeBlobStore();
          const service = new EvidenceService({ store, walrus: okWalrus });
          await expect(service.upload(tainted)).rejects.toThrow(/secret field/);
          expect(store.rows.size).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// (b) Clean bundles pass and carry no secret substring into non-private storage
// ---------------------------------------------------------------------------

describe('Property 22 (b): clean bundles pass the guard and contain no secret substrings', () => {
  it('upload reaches uploaded status and the serialized bundle has no forbidden substring', async () => {
    await fc.assert(
      fc.asyncProperty(cleanBundleArb, async (clean) => {
        // Guard passes for a clean bundle.
        expect(() => assertNoSecrets(clean)).not.toThrow();
        expect(containsSecretKey(clean)).toBe(false);

        const store = new FakeBlobStore();
        const service = new EvidenceService({ store, walrus: okWalrus });

        const result = await service.upload(clean);
        expect(result.blobId).toBe('BLOB');
        expect(result.evidenceHash).toMatch(/^[0-9a-f]{64}$/);

        // The persisted (non-private) record landed on `uploaded`.
        const rows = [...store.rows.values()];
        expect(rows).toHaveLength(1);
        const persisted = rows[0]!;
        expect(persisted.status).toBe('uploaded');
        expect(isEvidenceStatus(persisted.status)).toBe(true);

        // No forbidden secret substring appears anywhere in the serialized bytes.
        const serialized = service.serialize(clean).toLowerCase();
        for (const bad of FORBIDDEN_KEY_SUBSTRINGS) {
          expect(serialized).not.toContain(bad);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// (c) Designated sensitive fields are encrypted under private_encrypted status
// ---------------------------------------------------------------------------

describe('Property 22 (c): designated sensitive fields are encrypted, listed, and private_encrypted', () => {
  it('encrypts exactly the designated present fields and removes their plaintext', () => {
    fc.assert(
      fc.property(
        cleanBundleArb,
        fc.subarray([...SENSITIVE_CANDIDATE_FIELDS], { minLength: 0 }),
        (clean, designated) => {
          const originals = new Map<string, unknown>();
          for (const f of designated) {
            originals.set(f, (clean as unknown as Record<string, unknown>)[f]);
          }

          const result = encryptSensitiveFields(clean, designated);

          // Status is always the private lifecycle state. (Req 10.9)
          expect(result.status).toBe('private_encrypted');
          expect(isEvidenceStatus(result.status)).toBe(true);

          // Exactly the designated (present, non-reserved) fields were encrypted.
          const expectedFields = [...new Set(designated)];
          expect([...result.encryptedFields].sort()).toEqual([...expectedFields].sort());
          expect([...(result.bundle.sensitiveFieldsEncrypted ?? [])].sort()).toEqual(
            [...expectedFields].sort(),
          );

          const out = result.bundle as unknown as Record<string, unknown>;
          const serialized = new EvidenceService().serialize(result.bundle);

          for (const f of expectedFields) {
            // Value replaced by opaque ciphertext; plaintext gone.
            const original = originals.get(f) as string;
            expect(out[f]).toMatch(/^enc:[0-9a-f]{64}$/);
            expect(out[f]).not.toBe(original);
            expect(serialized).not.toContain(original);
          }

          // Input bundle never mutated.
          for (const f of expectedFields) {
            expect((clean as unknown as Record<string, unknown>)[f]).toBe(originals.get(f));
          }

          // Non-designated candidate fields are untouched.
          for (const f of SENSITIVE_CANDIDATE_FIELDS) {
            if (!expectedFields.includes(f)) {
              expect(out[f]).toBe((clean as unknown as Record<string, unknown>)[f]);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

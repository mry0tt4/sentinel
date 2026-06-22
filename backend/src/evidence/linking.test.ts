/**
 * Unit tests for task 9.6: linking, immutability, secret exclusion, and
 * sensitive-field encryption.
 *
 * Covers EvidenceService/EvidenceUploader.link + assertMutable, the shared
 * secret-exclusion guard, and encryptSensitiveFields. Property tests for
 * linked immutability (9.7) and secret exclusion (9.8) live separately.
 *
 * Validates: Requirements 10.4, 10.5, 10.8, 10.9, 10.10
 */

import { describe, expect, it, vi } from 'vitest';

import type { WalrusBlobInsert, WalrusBlobRow, WalrusStatus } from '../db/types.js';
import { EvidenceService } from './evidenceService.js';
import { assertNoSecrets, containsSecretKey, findSecretKey } from './secretGuard.js';
import {
  defaultDeterministicEncrypt,
  encryptSensitiveFields,
} from './sensitiveFields.js';
import type { EvidenceBundle } from './types.js';
import {
  EVIDENCE_STATUSES,
  EvidenceImmutableError,
  EvidenceLinkError,
  isEvidenceStatus,
  type EvidenceBlobStore,
  type OnChainHashRecorder,
} from './uploadManager.js';
import type { WalrusClient } from './walrusClient.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

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

const noopWalrus: WalrusClient = {
  async store() {
    return { blobId: 'BLOB' };
  },
};

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

/** Seed an `uploaded` tracking row ready to be linked. */
async function seedUploaded(store: FakeBlobStore, blobId = 'BLOB_1'): Promise<void> {
  await store.create({
    blob_id: blobId,
    status: 'uploaded',
    evidence_hash: 'hash-abc',
    attempt_count: 1,
    payload: bundleFixture() as unknown as WalrusBlobInsert['payload'],
  });
}

// ---------------------------------------------------------------------------
// link — success (Req 10.4)
// ---------------------------------------------------------------------------

describe('EvidenceService.link — success', () => {
  it('records the hash on-chain and sets status linked_on_chain', async () => {
    const store = new FakeBlobStore();
    await seedUploaded(store);
    const recordOnChain = vi.fn<OnChainHashRecorder>(async () => {});
    const service = new EvidenceService({ store, walrus: noopWalrus, recordOnChain });

    await service.link('BLOB_1', 'action-1', 'hash-xyz');

    expect(recordOnChain).toHaveBeenCalledOnce();
    expect(recordOnChain).toHaveBeenCalledWith({
      blobId: 'BLOB_1',
      actionLogId: 'action-1',
      evidenceHash: 'hash-xyz',
    });
    const row = (await store.getById('BLOB_1'))!;
    expect(row.status).toBe('linked_on_chain');
    expect(row.action_id).toBe('action-1');
    expect(row.evidence_hash).toBe('hash-xyz');
    expect(isEvidenceStatus(row.status)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// link — on-chain failure (Req 10.5)
// ---------------------------------------------------------------------------

describe('EvidenceService.link — on-chain recording failure', () => {
  it('retains the blob id, sets failed_upload, and throws EvidenceLinkError', async () => {
    const store = new FakeBlobStore();
    await seedUploaded(store);
    const recordOnChain = vi.fn<OnChainHashRecorder>(async () => {
      throw new Error('chain submit failed');
    });
    const service = new EvidenceService({ store, walrus: noopWalrus, recordOnChain });

    await expect(service.link('BLOB_1', 'action-1', 'hash-xyz')).rejects.toBeInstanceOf(
      EvidenceLinkError,
    );

    const row = (await store.getById('BLOB_1'))!;
    expect(row).not.toBeNull(); // blob id retained
    expect(row.status).toBe('failed_upload');
    expect(row.action_id).toBeNull(); // not linked
    expect(isEvidenceStatus(row.status)).toBe(true);
  });

  it('throws when no on-chain recorder is configured', async () => {
    const store = new FakeBlobStore();
    await seedUploaded(store);
    const service = new EvidenceService({ store, walrus: noopWalrus });

    await expect(service.link('BLOB_1', 'action-1', 'h')).rejects.toThrow(/on-chain recorder/);
  });

  it('throws for an unknown record', async () => {
    const store = new FakeBlobStore();
    const service = new EvidenceService({
      store,
      walrus: noopWalrus,
      recordOnChain: async () => {},
    });

    await expect(service.link('missing', 'action-1', 'h')).rejects.toThrow(/unknown evidence/);
  });
});

// ---------------------------------------------------------------------------
// assertMutable / immutability (Req 10.10)
// ---------------------------------------------------------------------------

describe('EvidenceService.assertMutable', () => {
  it('throws EvidenceImmutableError for linked_on_chain evidence, leaving it unchanged', async () => {
    const store = new FakeBlobStore();
    await seedUploaded(store);
    const service = new EvidenceService({
      store,
      walrus: noopWalrus,
      recordOnChain: async () => {},
    });
    await service.link('BLOB_1', 'action-1', 'hash-xyz');
    const before = { ...(await store.getById('BLOB_1'))! };

    await expect(service.assertMutable('BLOB_1')).rejects.toBeInstanceOf(EvidenceImmutableError);

    expect(await store.getById('BLOB_1')).toEqual(before); // unchanged
  });

  it('allows mutation for non-linked statuses', async () => {
    const store = new FakeBlobStore();
    const service = new EvidenceService({ store, walrus: noopWalrus });

    for (const status of EVIDENCE_STATUSES) {
      if (status === 'linked_on_chain') continue;
      await store.create({ blob_id: `b-${status}`, status });
      await expect(service.assertMutable(`b-${status}`)).resolves.toBeUndefined();
    }
  });

  it('allows mutation for an unknown record (nothing to protect)', async () => {
    const store = new FakeBlobStore();
    const service = new EvidenceService({ store, walrus: noopWalrus });
    await expect(service.assertMutable('nope')).resolves.toBeUndefined();
  });

  it('re-linking already-linked evidence is rejected as immutable', async () => {
    const store = new FakeBlobStore();
    await seedUploaded(store);
    const service = new EvidenceService({
      store,
      walrus: noopWalrus,
      recordOnChain: async () => {},
    });
    await service.link('BLOB_1', 'action-1', 'hash-xyz');

    await expect(service.link('BLOB_1', 'action-2', 'hash-2')).rejects.toBeInstanceOf(
      EvidenceImmutableError,
    );
    const row = (await store.getById('BLOB_1'))!;
    expect(row.action_id).toBe('action-1'); // original link unchanged
    expect(row.evidence_hash).toBe('hash-xyz');
  });
});

// ---------------------------------------------------------------------------
// Secret exclusion (Req 10.8)
// ---------------------------------------------------------------------------

describe('secret exclusion guard', () => {
  it('detects forbidden secret-bearing keys in nested structures', () => {
    expect(findSecretKey({ a: { b: { privateKey: '0xdead' } } })).toBe('privateKey');
    expect(containsSecretKey({ list: [{ mnemonic: 'x y z' }] })).toBe(true);
    expect(containsSecretKey({ apiKey: 'k' })).toBe(true);
    expect(containsSecretKey({ agentSigner: '0xAGENT', riskScore: 82 })).toBe(false);
  });

  it('assertNoSecrets passes a clean bundle and throws on a secret-bearing one', () => {
    expect(() => assertNoSecrets(bundleFixture())).not.toThrow();
    const tainted = { ...bundleFixture(), privateKey: '0xsecret' };
    expect(() => assertNoSecrets(tainted)).toThrow(/secret field/);
  });

  it('upload rejects a secret-bearing bundle before persisting (non-private path)', async () => {
    const store = new FakeBlobStore();
    const service = new EvidenceService({ store, walrus: noopWalrus });
    const tainted = { ...bundleFixture(), signerKey: '0xLEAK' } as unknown as EvidenceBundle;

    await expect(service.upload(tainted)).rejects.toThrow(/secret field/);
    expect(store.rows.size).toBe(0); // nothing persisted
  });

  it('link rejects when the stored payload contains a secret', async () => {
    const store = new FakeBlobStore();
    await store.create({
      blob_id: 'BLOB_TAINTED',
      status: 'uploaded',
      payload: { ...bundleFixture(), password: 'p' } as unknown as WalrusBlobInsert['payload'],
    });
    const recordOnChain = vi.fn<OnChainHashRecorder>(async () => {});
    const service = new EvidenceService({ store, walrus: noopWalrus, recordOnChain });

    await expect(service.link('BLOB_TAINTED', 'action-1', 'h')).rejects.toThrow(/secret field/);
    expect(recordOnChain).not.toHaveBeenCalled(); // never reached the chain
  });
});

// ---------------------------------------------------------------------------
// Sensitive-field encryption (Req 10.9)
// ---------------------------------------------------------------------------

describe('encryptSensitiveFields', () => {
  it('encrypts designated fields, lists them, and targets private_encrypted', () => {
    const bundle = bundleFixture();
    const result = encryptSensitiveFields(bundle, ['agentSigner', 'aiExplanation']);

    expect(result.status).toBe('private_encrypted');
    expect(isEvidenceStatus(result.status)).toBe(true);
    expect(result.encryptedFields.sort()).toEqual(['agentSigner', 'aiExplanation']);
    expect(result.bundle.sensitiveFieldsEncrypted?.sort()).toEqual([
      'agentSigner',
      'aiExplanation',
    ]);
    // Designated values are replaced by opaque ciphertext (no plaintext leak).
    expect(result.bundle.agentSigner).toMatch(/^enc:[0-9a-f]{64}$/);
    expect(result.bundle.aiExplanation).toMatch(/^enc:[0-9a-f]{64}$/);
    expect(result.bundle.agentSigner).not.toBe('0xAGENT');
    // Non-designated fields are untouched.
    expect(result.bundle.riskScore).toBe(82);
    expect(result.bundle.marketId).toBe('market-1');
  });

  it('does not mutate the input bundle', () => {
    const bundle = bundleFixture();
    encryptSensitiveFields(bundle, ['agentSigner']);
    expect(bundle.agentSigner).toBe('0xAGENT');
    expect(bundle.sensitiveFieldsEncrypted).toBeUndefined();
  });

  it('ignores absent and reserved field names', () => {
    const bundle = bundleFixture();
    const result = encryptSensitiveFields(bundle, [
      'doesNotExist',
      'rawDataHash',
      'sensitiveFieldsEncrypted',
    ]);
    expect(result.encryptedFields).toEqual([]);
    expect(result.bundle.rawDataHash).toBe('deadbeef'); // reserved, not encrypted
  });

  it('uses an injectable encryptor when provided', () => {
    const bundle = bundleFixture();
    const result = encryptSensitiveFields(bundle, ['agentSigner'], (name, value) =>
      `CIPHER(${name}:${String(value)})`,
    );
    expect(result.bundle.agentSigner).toBe('CIPHER(agentSigner:0xAGENT)');
  });

  it('default encryptor is deterministic for equal inputs', () => {
    const a = defaultDeterministicEncrypt('agentSigner', '0xAGENT');
    const b = defaultDeterministicEncrypt('agentSigner', '0xAGENT');
    const c = defaultDeterministicEncrypt('agentSigner', '0xOTHER');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('EvidenceService.encryptSensitiveFields delegates to the helper', () => {
    const service = new EvidenceService();
    const result = service.encryptSensitiveFields(bundleFixture(), ['agentSigner']);
    expect(result.status).toBe('private_encrypted');
    expect(result.encryptedFields).toEqual(['agentSigner']);
  });
});

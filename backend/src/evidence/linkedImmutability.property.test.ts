// Feature: sentinel-risk-guardian, Property 20: Linked evidence is immutable
//
// For ANY Evidence_Bundle whose status is `linked_on_chain`, any request to
// modify or delete it SHALL be rejected, leaving the stored bundle and the
// recorded evidence hash unchanged. For records in every OTHER status (and for
// unknown records), modify/delete is permitted (assertMutable returns).
//
// This property generates an evidence record in each possible status (from
// EVIDENCE_STATUSES) with random bundle/hash content, and asserts:
//   1. assertMutable throws EvidenceImmutableError IFF status === 'linked_on_chain',
//      and never throws for any other status.
//   2. A modify/delete attempt guarded by assertMutable is, for a
//      linked_on_chain record, rejected — and the stored bundle payload + the
//      recorded evidence hash are byte-for-byte identical before and after.
//   3. For non-linked statuses the guarded modify/delete is allowed to proceed.
//
// Validates: Requirements 10.10

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { WalrusBlobInsert, WalrusBlobRow, WalrusStatus } from '../db/types.js';
import { EvidenceService } from './evidenceService.js';
import {
  EVIDENCE_STATUSES,
  EvidenceImmutableError,
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

/**
 * A guarded modify/delete: it consults `assertMutable` first and ONLY mutates
 * the store when the record is mutable. This models the real call sites that
 * must respect immutability. (Req 10.10)
 *
 * Returns `'applied'` when the mutation went through, or rethrows the
 * EvidenceImmutableError when the record is protected.
 */
async function guardedModify(
  service: EvidenceService,
  store: FakeBlobStore,
  blobId: string,
  mutator: (row: WalrusBlobRow) => WalrusBlobRow,
): Promise<'applied'> {
  await service.assertMutable(blobId); // throws for linked_on_chain
  const row = store.rows.get(blobId);
  if (row !== undefined) {
    store.rows.set(blobId, mutator(row));
  }
  return 'applied';
}

async function guardedDelete(
  service: EvidenceService,
  store: FakeBlobStore,
  blobId: string,
): Promise<'applied'> {
  await service.assertMutable(blobId); // throws for linked_on_chain
  store.rows.delete(blobId);
  return 'applied';
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Any one of the exhaustive, valid evidence statuses. */
const statusArbitrary = fc.constantFrom<WalrusStatus>(...EVIDENCE_STATUSES);

/** A random, JSON-serializable bundle payload + an evidence hash to record. */
const recordContentArbitrary = fc.record({
  blobId: fc.string({ minLength: 1, maxLength: 24 }),
  evidenceHash: fc.hexaString({ minLength: 1, maxLength: 64 }),
  // Random but realistic bundle-ish payload content.
  payload: fc.record({
    schemaVersion: fc.constant('1.0'),
    marketId: fc.string({ minLength: 1, maxLength: 16 }),
    riskScore: fc.integer({ min: 0, max: 100 }),
    aiExplanation: fc.string({ maxLength: 64 }),
    agentSigner: fc.string({ minLength: 1, maxLength: 16 }),
    rawDataHash: fc.hexaString({ minLength: 1, maxLength: 64 }),
  }),
});

/** Stable snapshot of the immutability-relevant content of a stored row. */
function snapshot(row: WalrusBlobRow | undefined): string {
  if (row === undefined) return '<<deleted>>';
  return JSON.stringify({
    status: row.status,
    evidence_hash: row.evidence_hash,
    payload: row.payload,
    action_id: row.action_id,
  });
}

// ---------------------------------------------------------------------------
// Property 20
// ---------------------------------------------------------------------------

describe('Property 20: Linked evidence is immutable', () => {
  it('assertMutable throws IFF status is linked_on_chain, and never for any other status', async () => {
    await fc.assert(
      fc.asyncProperty(statusArbitrary, recordContentArbitrary, async (status, content) => {
        const store = new FakeBlobStore();
        const service = new EvidenceService({ store, walrus: noopWalrus });

        await store.create({
          blob_id: content.blobId,
          status,
          evidence_hash: content.evidenceHash,
          payload: content.payload as unknown as WalrusBlobInsert['payload'],
        });

        const isLinked = status === 'linked_on_chain';

        if (isLinked) {
          await expect(service.assertMutable(content.blobId)).rejects.toBeInstanceOf(
            EvidenceImmutableError,
          );
        } else {
          await expect(service.assertMutable(content.blobId)).resolves.toBeUndefined();
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a guarded modify/delete on linked_on_chain is rejected and leaves bundle + hash unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(statusArbitrary, recordContentArbitrary, async (status, content) => {
        const store = new FakeBlobStore();
        const service = new EvidenceService({ store, walrus: noopWalrus });

        await store.create({
          blob_id: content.blobId,
          status,
          evidence_hash: content.evidenceHash,
          payload: content.payload as unknown as WalrusBlobInsert['payload'],
        });

        const before = snapshot(store.rows.get(content.blobId));
        const isLinked = status === 'linked_on_chain';

        // --- Guarded MODIFY ----------------------------------------------
        const modifyAttempt = guardedModify(service, store, content.blobId, (row) => ({
          ...row,
          evidence_hash: 'TAMPERED_HASH',
          payload: { tampered: true } as unknown as WalrusBlobRow['payload'],
          status: 'failed_upload',
        }));

        if (isLinked) {
          await expect(modifyAttempt).rejects.toBeInstanceOf(EvidenceImmutableError);
          // Bundle + recorded hash unchanged after a rejected modify.
          expect(snapshot(store.rows.get(content.blobId))).toBe(before);
        } else {
          await expect(modifyAttempt).resolves.toBe('applied');
          // For non-linked records the mutation is allowed (precondition for
          // the "IFF" — only linked records are protected).
          expect(snapshot(store.rows.get(content.blobId))).not.toBe(before);
        }

        // --- Guarded DELETE ----------------------------------------------
        // Re-seed a fresh record to isolate the delete check.
        const delStore = new FakeBlobStore();
        const delService = new EvidenceService({ store: delStore, walrus: noopWalrus });
        await delStore.create({
          blob_id: content.blobId,
          status,
          evidence_hash: content.evidenceHash,
          payload: content.payload as unknown as WalrusBlobInsert['payload'],
        });
        const delBefore = snapshot(delStore.rows.get(content.blobId));

        const deleteAttempt = guardedDelete(delService, delStore, content.blobId);

        if (isLinked) {
          await expect(deleteAttempt).rejects.toBeInstanceOf(EvidenceImmutableError);
          // Record still present and unchanged after a rejected delete.
          expect(delStore.rows.has(content.blobId)).toBe(true);
          expect(snapshot(delStore.rows.get(content.blobId))).toBe(delBefore);
        } else {
          await expect(deleteAttempt).resolves.toBe('applied');
          expect(delStore.rows.has(content.blobId)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});

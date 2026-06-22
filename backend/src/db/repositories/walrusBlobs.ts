/**
 * Repository for the `walrus_blobs` table (evidence lifecycle tracking). All
 * queries are parameterized. (Requirement 15.3)
 *
 * The table's primary key is the Walrus `blob_id` (TEXT), so `create` performs
 * an idempotent upsert keyed on `blob_id`.
 */

import type { Queryable } from '../pool.js';
import { requireRow } from '../sql.js';
import type { WalrusBlobInsert, WalrusBlobRow, WalrusStatus } from '../types.js';

export class WalrusBlobsRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Insert (or upsert on `blob_id`) an evidence-blob record and return the
   * persisted row. Re-running with the same `blob_id` refreshes the mutable
   * tracking fields without creating a duplicate.
   */
  async create(input: WalrusBlobInsert): Promise<WalrusBlobRow> {
    const res = await this.db.query<WalrusBlobRow>(
      `INSERT INTO walrus_blobs
         (blob_id, action_id, market_id, status, evidence_hash,
          attempt_count, last_attempt_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (blob_id) DO UPDATE SET
         action_id = EXCLUDED.action_id,
         market_id = EXCLUDED.market_id,
         status = EXCLUDED.status,
         evidence_hash = EXCLUDED.evidence_hash,
         attempt_count = EXCLUDED.attempt_count,
         last_attempt_at = EXCLUDED.last_attempt_at,
         payload = EXCLUDED.payload
       RETURNING *`,
      [
        input.blob_id,
        input.action_id ?? null,
        input.market_id ?? null,
        input.status,
        input.evidence_hash ?? null,
        input.attempt_count ?? 0,
        input.last_attempt_at ?? null,
        input.payload ?? null,
      ],
    );
    return requireRow(res.rows, 'walrusBlobs.create');
  }

  /** Fetch a blob record by its blob id, or `null`. */
  async getById(blobId: string): Promise<WalrusBlobRow | null> {
    const res = await this.db.query<WalrusBlobRow>(
      'SELECT * FROM walrus_blobs WHERE blob_id = $1',
      [blobId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Re-key a provisional tracking row to the real Walrus blob id once an upload
   * succeeds. If a row already exists under `toBlobId` (content-addressed
   * re-run), the provisional row is dropped and the existing row is returned so
   * the caller can re-use/re-link it.
   */
  async rekey(fromBlobId: string, toBlobId: string): Promise<WalrusBlobRow | null> {
    if (fromBlobId === toBlobId) {
      return this.getById(toBlobId);
    }
    const existing = await this.getById(toBlobId);
    if (existing !== null) {
      await this.db.query('DELETE FROM walrus_blobs WHERE blob_id = $1', [fromBlobId]);
      return existing;
    }
    const res = await this.db.query<WalrusBlobRow>(
      'UPDATE walrus_blobs SET blob_id = $1 WHERE blob_id = $2 RETURNING *',
      [toBlobId, fromBlobId],
    );
    return res.rows[0] ?? null;
  }

  /** List blob records in a given status, oldest first. */
  async listByStatus(status: WalrusStatus): Promise<WalrusBlobRow[]> {
    const res = await this.db.query<WalrusBlobRow>(
      'SELECT * FROM walrus_blobs WHERE status = $1 ORDER BY created_at ASC',
      [status],
    );
    return res.rows;
  }

  /** Update only the lifecycle status and return the updated row (or `null`). */
  async updateStatus(blobId: string, status: WalrusStatus): Promise<WalrusBlobRow | null> {
    const res = await this.db.query<WalrusBlobRow>(
      'UPDATE walrus_blobs SET status = $1 WHERE blob_id = $2 RETURNING *',
      [status, blobId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Atomically increment `attempt_count`, set `last_attempt_at`, and move to a
   * status (e.g. `retrying` or `failed_upload`). The `attempt_count <= 5` CHECK
   * constraint enforces the bounded-retry rule at the storage layer.
   */
  async recordAttempt(
    blobId: string,
    status: WalrusStatus,
    attemptAt: Date | string,
  ): Promise<WalrusBlobRow | null> {
    const res = await this.db.query<WalrusBlobRow>(
      `UPDATE walrus_blobs
         SET attempt_count = attempt_count + 1,
             last_attempt_at = $1,
             status = $2
       WHERE blob_id = $3
       RETURNING *`,
      [attemptAt, status, blobId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Link a blob to an executed action and mark it `linked_on_chain`, recording
   * the on-chain evidence hash. Returns the updated row (or `null`).
   */
  async linkToAction(
    blobId: string,
    actionId: string,
    evidenceHash: string,
  ): Promise<WalrusBlobRow | null> {
    const res = await this.db.query<WalrusBlobRow>(
      `UPDATE walrus_blobs
         SET action_id = $1, evidence_hash = $2, status = 'linked_on_chain'
       WHERE blob_id = $3
       RETURNING *`,
      [actionId, evidenceHash, blobId],
    );
    return res.rows[0] ?? null;
  }
}

/**
 * Checkpoint store implementations.
 *
 * {@link InMemoryCheckpointStore} is the default used in tests and early
 * scaffolding. A durable Redis- or Postgres-backed store can implement the
 * same {@link CheckpointStore} port later without touching the indexer.
 */

import type { CheckpointStore, IndexerCheckpoint } from './types.js';

/** Process-local, non-durable checkpoint store keyed by indexer name. */
export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly store = new Map<string, IndexerCheckpoint>();

  async load(key: string): Promise<IndexerCheckpoint | null> {
    return this.store.get(key) ?? null;
  }

  async save(key: string, checkpoint: IndexerCheckpoint): Promise<void> {
    // Defensive copy so later mutations by the caller cannot corrupt state.
    this.store.set(key, {
      cursor:
        checkpoint.cursor === null
          ? null
          : { txDigest: checkpoint.cursor.txDigest, eventSeq: checkpoint.cursor.eventSeq },
      lastTxDigest: checkpoint.lastTxDigest,
      processedCount: checkpoint.processedCount,
      updatedAt: checkpoint.updatedAt,
    });
  }
}

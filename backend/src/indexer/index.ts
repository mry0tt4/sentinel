/**
 * Protocol State Indexer — public surface.
 *
 * Subscribes to `sentinel_policy`/`sentinel_demo_market` events, persists their
 * off-chain mirrors, links Walrus evidence, and recovers from the last
 * persisted checkpoint after a restart. (Req 3.7, 17.6, 17.7, 17.8)
 */

export * from './types.js';
export { parseEvent } from './parseEvent.js';
export { InMemoryCheckpointStore } from './checkpointStore.js';
export {
  ProtocolStateIndexer,
  DEFAULT_CHECKPOINT_KEY,
  DEFAULT_PAGE_SIZE,
  type IndexerDeps,
  type IndexerOptions,
  type IndexRunResult,
} from './indexer.js';
export {
  SuiClientEventSource,
  type SuiQueryEventsClient,
  type SuiEventSourceConfig,
  type ModuleRef,
} from './suiEventSource.js';

import type { AddressInfo } from 'node:net';

import { startBackend, type BackendHandle } from './bootstrap.js';
import { createProductionComposition, type Composition } from './composition.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { createApp } from './server.js';

/**
 * Backend entry point.
 *
 * Loads configuration from environment variables, builds the production
 * composition root (task 21.1) that wires the full risk-control loop — workers
 * → Risk Engine → Action Executor → Evidence Service → on-chain policy →
 * indexer → WebSocket → frontend — and runs the startup sequence: the Network
 * Guard verifies the configured RPC endpoint reports the Sui Testnet chain id
 * FIRST, and only on success is the HTTP server created, the WebSocket server
 * attached, the indexer's restart-recovery polling started, and the background
 * workers started. On mismatch or an unverifiable endpoint the process exits
 * with a non-zero code and no partial initialization. (Req 1.3, 1.4, 3.7, 9.4,
 * 9.5, 17.7, 17.8)
 */
async function main(): Promise<void> {
  const { config, secrets } = loadConfig();

  // Build the composition root. No infra connection is opened here.
  const { composition, networkGuard } = createProductionComposition(config, secrets);

  await startBackend({
    config,
    networkGuard,
    startServer: (cfg) => startComposedServer(cfg, composition),
  });
}

/**
 * Production server starter wired to the composition root. Builds the Express
 * app with the composed repositories + action services, binds it, attaches the
 * shared WebSocket server, starts the indexer's restart-recovery polling, and
 * starts the background workers. The returned handle stops everything cleanly.
 */
function startComposedServer(config: AppConfig, composition: Composition): Promise<BackendHandle> {
  const app = createApp(config, {
    repositories: composition.repositories,
    actionServices: composition.actionServices,
    incidentSummarizer: composition.incidentSummarizer,
    protocolReserve: composition.protocolReserve,
  });

  return new Promise<BackendHandle>((resolve) => {
    const server = app.listen(config.port, () => {
      const { port } = server.address() as AddressInfo;

      // Bind the WebSocket transport to the same port and share the registry
      // used by the loop + indexer as the live push surface. (Req 3.7)
      const ws = composition.attachWebSocket(server);

      // Start the indexer's restart-recovery polling: it resumes from the last
      // persisted checkpoint and broadcasts on new events. (Req 17.6, 17.7, 17.8)
      const indexerPoll = startIndexerPolling(composition);

      // Start the oracle + liquidity workers feeding the loop. (Req 6.1, 3.7)
      composition.startWorkers();

      // Sync real on-chain demo-market state (utilization + exposure). (Req 5.2)
      const marketSync = composition.startMarketStateSync?.();

      // eslint-disable-next-line no-console
      console.log(`Sentinel backend listening on port ${port} (${config.nodeEnv}) with live loop`);

      resolve({
        close: async () => {
          composition.stopWorkers();
          marketSync?.stop();
          indexerPoll.stop();
          await ws.close();
          await new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
  });
}

/** A running indexer poll loop with a stop handle. */
interface IndexerPollHandle {
  stop(): void;
}

const DEFAULT_INDEXER_POLL_INTERVAL_MS = 5_000;

/**
 * Drive {@link Composition.indexer} on an interval, draining all available
 * on-chain events each tick. Overlapping drains are prevented by a guard so a
 * slow drain never stacks up. Errors are logged and the loop continues so a
 * transient RPC hiccup cannot kill indexing.
 */
function startIndexerPolling(composition: Composition): IndexerPollHandle {
  let running = false;
  const handle = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    composition.indexer
      .runOnce()
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('Indexer drain failed:', err);
      })
      .finally(() => {
        running = false;
      });
  }, DEFAULT_INDEXER_POLL_INTERVAL_MS);

  return {
    stop: () => clearInterval(handle),
  };
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Sentinel backend failed to start:', err);
  process.exit(1);
});

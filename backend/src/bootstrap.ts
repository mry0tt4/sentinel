import type { AddressInfo } from 'node:net';

import type { AppConfig } from './config/env.js';
import { createApp } from './server.js';

/**
 * Backend startup sequence (testable, dependency-injected).
 *
 * The Network Guard's startup check MUST run FIRST and MUST gate every other
 * piece of initialization: only if the configured RPC endpoint reports the Sui
 * Testnet chain identifier (within the guard's timeout) does the backend create
 * and start the HTTP server. If the check rejects — because the chain id does
 * not match (NETWORK_MISMATCH) or cannot be verified within 10s
 * (NETWORK_UNVERIFIABLE) — the error propagates and the server is never created
 * or started, so there is no partial initialization. (Req 1.3, 1.4)
 *
 * Dependencies are injected so the sequence can run with a real
 * {@link NetworkGuard}/`SuiClient` in production and with in-memory fakes/spies
 * in tests that assert the no-partial-initialization guarantee.
 */

/** A started backend, exposing a way to shut it down cleanly. */
export interface BackendHandle {
  /** Stop accepting connections and release resources. */
  close(): Promise<void>;
}

/**
 * Narrow surface of the Network Guard the startup sequence depends on. The
 * concrete {@link NetworkGuard} satisfies this; tests can pass a fake.
 */
export interface StartupNetworkGuard {
  /** Resolves when the RPC chain id matches testnet; rejects otherwise. */
  verifyRpcChainIdAtStartup(): Promise<void>;
}

export interface BootstrapDeps {
  config: AppConfig;
  networkGuard: StartupNetworkGuard;
  /**
   * Creates and starts the HTTP server, resolving once it is listening. This
   * is invoked ONLY after the network check resolves — if verification fails
   * it is never called, guaranteeing no partial initialization. Defaults to
   * {@link defaultStartServer}.
   */
  startServer?: (config: AppConfig) => Promise<BackendHandle>;
}

/**
 * Run the backend startup sequence. Verifies the network FIRST, then (and only
 * then) starts the server. Any startup failure rejects without starting the
 * server.
 */
export async function startBackend(deps: BootstrapDeps): Promise<BackendHandle> {
  // Network verification runs FIRST. If it rejects (mismatch/unverifiable) the
  // error propagates and the server is never created or started — no partial
  // initialization. (Req 1.3, 1.4)
  await deps.networkGuard.verifyRpcChainIdAtStartup();

  const startServer = deps.startServer ?? defaultStartServer;
  return startServer(deps.config);
}

/**
 * Production server starter: builds the Express app and binds it to the
 * configured port, resolving with a handle once it is listening.
 */
export function defaultStartServer(config: AppConfig): Promise<BackendHandle> {
  const app = createApp(config);
  return new Promise<BackendHandle>((resolve) => {
    const server = app.listen(config.port, () => {
      const { port } = server.address() as AddressInfo;
      // eslint-disable-next-line no-console
      console.log(`Sentinel backend listening on port ${port} (${config.nodeEnv})`);
      resolve({
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

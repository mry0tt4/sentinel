// Feature: sentinel-risk-guardian, Property 25: Backend refuses startup on network mismatch
import { describe, expect, it, vi } from 'vitest';

import { startBackend, type BackendHandle } from './bootstrap.js';
import type {
  EnvCheckRecorder,
  SuiChainClient,
} from './network/networkGuard.js';
import { NetworkGuard, NetworkVerificationError } from './network/networkGuard.js';
import type { AppConfig } from './config/env.js';
import type { EnvironmentCheckInsert, EnvironmentCheckRow } from './db/types.js';

const TESTNET_CHAIN_ID = '4c78adac';

const baseConfig: AppConfig = {
  nodeEnv: 'test',
  port: 0,
  suiRpcUrl: 'https://fullnode.testnet.sui.io:443',
  suiTestnetChainId: TESTNET_CHAIN_ID,
  packageIds: { policy: '', demoMarket: '', adapters: '' },
  walrusPublisherUrl: 'https://publisher.walrus-testnet.walrus.space',
  walrusAggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
  databaseUrl: 'postgresql://localhost:5432/sentinel',
  redisUrl: 'redis://localhost:6379',
  rateLimitMax: 120,
  rateLimitWindowMs: 60_000,
  llm: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
};

/** In-memory audit recorder; never touches a real database. */
function makeRecorder(): EnvCheckRecorder {
  return {
    append: vi.fn(
      async (input: EnvironmentCheckInsert): Promise<EnvironmentCheckRow> => ({
        id: 'test-id',
        check_type: input.check_type,
        outcome: input.outcome,
        detail: input.detail ?? null,
        checked_at: new Date(),
      }),
    ),
  };
}

/** Build a real NetworkGuard over a fake RPC client returning `chainId`. */
function guardReturningChainId(chainId: string): NetworkGuard {
  const client: SuiChainClient = {
    getChainIdentifier: vi.fn(async () => chainId),
    getTransactionBlock: vi.fn(async () => ({})),
  };
  return new NetworkGuard(client, makeRecorder(), {
    suiTestnetChainId: TESTNET_CHAIN_ID,
    packageIds: baseConfig.packageIds,
  });
}

/** Build a NetworkGuard whose RPC chain-id call never resolves (timeout path). */
function guardThatHangs(): NetworkGuard {
  const client: SuiChainClient = {
    getChainIdentifier: vi.fn(() => new Promise<string>(() => {})),
    getTransactionBlock: vi.fn(async () => ({})),
  };
  return new NetworkGuard(
    client,
    makeRecorder(),
    { suiTestnetChainId: TESTNET_CHAIN_ID, packageIds: baseConfig.packageIds },
    { chainIdTimeoutMs: 10 },
  );
}

/** Spy server starter that records invocation and returns a closeable handle. */
function makeStartServerSpy(): (config: AppConfig) => Promise<BackendHandle> {
  return vi.fn(async (): Promise<BackendHandle> => ({ close: async () => {} }));
}

describe('startBackend (Property 25: backend refuses startup on network mismatch)', () => {
  it('rejects with NETWORK_MISMATCH and never starts the server on a wrong chain id', async () => {
    const networkGuard = guardReturningChainId('deadbeef');
    const startServer = makeStartServerSpy();

    const error = await startBackend({ config: baseConfig, networkGuard, startServer }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(NetworkVerificationError);
    expect((error as NetworkVerificationError).code).toBe('NETWORK_MISMATCH');
    // No partial initialization: the server was never created/started.
    expect(startServer).not.toHaveBeenCalled();
  });

  it('rejects with NETWORK_UNVERIFIABLE and never starts the server on an unverifiable endpoint', async () => {
    const networkGuard = guardThatHangs();
    const startServer = makeStartServerSpy();

    const error = await startBackend({ config: baseConfig, networkGuard, startServer }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(NetworkVerificationError);
    expect((error as NetworkVerificationError).code).toBe('NETWORK_UNVERIFIABLE');
    // No partial initialization: the server was never created/started.
    expect(startServer).not.toHaveBeenCalled();
  });

  it('starts the server only after the chain id matches Sui Testnet', async () => {
    const networkGuard = guardReturningChainId(TESTNET_CHAIN_ID);
    const startServer = makeStartServerSpy();

    const handle = await startBackend({ config: baseConfig, networkGuard, startServer });

    expect(startServer).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledWith(baseConfig);
    expect(typeof handle.close).toBe('function');
  });
});

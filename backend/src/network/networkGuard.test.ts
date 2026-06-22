import { describe, expect, it } from 'vitest';

import {
  NetworkGuard,
  NetworkVerificationError,
  type EnvCheckRecorder,
  type NetworkGuardConfig,
  type SuiChainClient,
} from './networkGuard.js';
import type {
  EnvCheckOutcome,
  EnvCheckType,
  EnvironmentCheckInsert,
  EnvironmentCheckRow,
} from '../db/types.js';

const TESTNET_CHAIN_ID = '4c78adac';

const baseConfig: NetworkGuardConfig = {
  suiTestnetChainId: TESTNET_CHAIN_ID,
  packageIds: {
    policy: '0xpolicy',
    demoMarket: '0xdemo',
    adapters: '0xadapters',
  },
};

/**
 * In-memory {@link EnvCheckRecorder} that captures every appended check so
 * tests can assert that each verification was recorded with the right type and
 * outcome. Mimics the Postgres-backed repository's `append` contract: it fills
 * in an id and an ISO 8601 UTC `checked_at` timestamp.
 */
class FakeRecorder implements EnvCheckRecorder {
  readonly records: EnvironmentCheckRow[] = [];
  private seq = 0;

  async append(input: EnvironmentCheckInsert): Promise<EnvironmentCheckRow> {
    const row: EnvironmentCheckRow = {
      id: input.id ?? `check-${++this.seq}`,
      check_type: input.check_type,
      outcome: input.outcome,
      detail: input.detail ?? null,
      checked_at: new Date(),
    };
    this.records.push(row);
    return row;
  }

  outcomesFor(type: EnvCheckType): EnvCheckOutcome[] {
    return this.records.filter((r) => r.check_type === type).map((r) => r.outcome);
  }
}

/** Configurable fake Sui RPC client. */
class FakeSuiClient implements SuiChainClient {
  constructor(
    private readonly opts: {
      chainId?: string;
      chainIdDelayMs?: number;
      chainIdError?: Error;
      txExists?: boolean;
    } = {},
  ) {}

  async getChainIdentifier(): Promise<string> {
    if (this.opts.chainIdError) {
      throw this.opts.chainIdError;
    }
    if (this.opts.chainIdDelayMs && this.opts.chainIdDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.opts.chainIdDelayMs));
    }
    return this.opts.chainId ?? TESTNET_CHAIN_ID;
  }

  async getTransactionBlock(_input: { digest: string }): Promise<unknown> {
    if (this.opts.txExists === false) {
      throw new Error('transaction not found');
    }
    return { digest: 'ok' };
  }
}

function makeGuard(
  client: SuiChainClient,
  recorder: EnvCheckRecorder,
  chainIdTimeoutMs = 50,
): NetworkGuard {
  return new NetworkGuard(client, recorder, baseConfig, { chainIdTimeoutMs });
}

describe('NetworkGuard.verifyRpcChainIdAtStartup', () => {
  it('passes and records a pass when the RPC chain id matches Sui Testnet', async () => {
    const recorder = new FakeRecorder();
    const guard = makeGuard(new FakeSuiClient({ chainId: TESTNET_CHAIN_ID }), recorder);

    await expect(guard.verifyRpcChainIdAtStartup()).resolves.toBeUndefined();
    expect(recorder.outcomesFor('rpc_chain_id')).toEqual(['pass']);
  });

  it('throws NETWORK_MISMATCH and records a fail when the chain id is not testnet', async () => {
    const recorder = new FakeRecorder();
    const guard = makeGuard(new FakeSuiClient({ chainId: 'mainnet99' }), recorder);

    await expect(guard.verifyRpcChainIdAtStartup()).rejects.toMatchObject({
      name: 'NetworkVerificationError',
      code: 'NETWORK_MISMATCH',
    });
    expect(recorder.outcomesFor('rpc_chain_id')).toEqual(['fail']);
  });

  it('throws NETWORK_UNVERIFIABLE and records a fail when the endpoint is unreachable', async () => {
    const recorder = new FakeRecorder();
    const guard = makeGuard(
      new FakeSuiClient({ chainIdError: new Error('ECONNREFUSED') }),
      recorder,
    );

    await expect(guard.verifyRpcChainIdAtStartup()).rejects.toMatchObject({
      code: 'NETWORK_UNVERIFIABLE',
    });
    expect(recorder.outcomesFor('rpc_chain_id')).toEqual(['fail']);
  });

  it('throws NETWORK_UNVERIFIABLE and records a fail when verification exceeds the timeout', async () => {
    const recorder = new FakeRecorder();
    // Chain id resolves long after the 20ms timeout deadline.
    const guard = makeGuard(
      new FakeSuiClient({ chainId: TESTNET_CHAIN_ID, chainIdDelayMs: 200 }),
      recorder,
      20,
    );

    await expect(guard.verifyRpcChainIdAtStartup()).rejects.toBeInstanceOf(
      NetworkVerificationError,
    );
    await expect(
      guard.verifyRpcChainIdAtStartup().catch((e) => (e as NetworkVerificationError).code),
    ).resolves.toBe('NETWORK_UNVERIFIABLE');
    expect(recorder.outcomesFor('rpc_chain_id')).toEqual(['fail', 'fail']);
  });
});

describe('NetworkGuard.verifySubmissionTarget', () => {
  it('passes and records a pass for a configured package on testnet', async () => {
    const recorder = new FakeRecorder();
    const guard = makeGuard(new FakeSuiClient({ chainId: TESTNET_CHAIN_ID }), recorder);

    await expect(guard.verifySubmissionTarget('0xpolicy')).resolves.toBeUndefined();
    expect(recorder.outcomesFor('submission_target')).toEqual(['pass']);
  });

  it('passes for each of the configured package ids', async () => {
    const recorder = new FakeRecorder();
    const guard = makeGuard(new FakeSuiClient({ chainId: TESTNET_CHAIN_ID }), recorder);

    await guard.verifySubmissionTarget('0xpolicy');
    await guard.verifySubmissionTarget('0xdemo');
    await guard.verifySubmissionTarget('0xadapters');

    expect(recorder.outcomesFor('submission_target')).toEqual(['pass', 'pass', 'pass']);
  });

  it('throws SUBMISSION_TARGET_MISMATCH and records a fail for an unknown package id', async () => {
    const recorder = new FakeRecorder();
    const guard = makeGuard(new FakeSuiClient({ chainId: TESTNET_CHAIN_ID }), recorder);

    await expect(guard.verifySubmissionTarget('0xnot-configured')).rejects.toMatchObject({
      code: 'SUBMISSION_TARGET_MISMATCH',
    });
    expect(recorder.outcomesFor('submission_target')).toEqual(['fail']);
  });

  it('throws SUBMISSION_TARGET_MISMATCH and records a fail when the chain id is not testnet', async () => {
    const recorder = new FakeRecorder();
    const guard = makeGuard(new FakeSuiClient({ chainId: 'mainnet99' }), recorder);

    await expect(guard.verifySubmissionTarget('0xpolicy')).rejects.toMatchObject({
      code: 'SUBMISSION_TARGET_MISMATCH',
    });
    expect(recorder.outcomesFor('submission_target')).toEqual(['fail']);
  });
});

describe('NetworkGuard.verifyDigestOrigin', () => {
  it('returns true and records a pass when chain id matches and the tx resolves', async () => {
    const recorder = new FakeRecorder();
    const guard = makeGuard(
      new FakeSuiClient({ chainId: TESTNET_CHAIN_ID, txExists: true }),
      recorder,
    );

    await expect(guard.verifyDigestOrigin('digest123')).resolves.toBe(true);
    expect(recorder.outcomesFor('digest_origin')).toEqual(['pass']);
  });

  it('returns false (no throw) and records a fail when the chain id is not testnet', async () => {
    const recorder = new FakeRecorder();
    const guard = makeGuard(new FakeSuiClient({ chainId: 'mainnet99' }), recorder);

    await expect(guard.verifyDigestOrigin('digest123')).resolves.toBe(false);
    expect(recorder.outcomesFor('digest_origin')).toEqual(['fail']);
  });

  it('returns false and records a fail when the transaction cannot be resolved', async () => {
    const recorder = new FakeRecorder();
    const guard = makeGuard(
      new FakeSuiClient({ chainId: TESTNET_CHAIN_ID, txExists: false }),
      recorder,
    );

    await expect(guard.verifyDigestOrigin('missing-digest')).resolves.toBe(false);
    expect(recorder.outcomesFor('digest_origin')).toEqual(['fail']);
  });

  it('returns false and records a fail when chain id verification times out', async () => {
    const recorder = new FakeRecorder();
    const guard = makeGuard(
      new FakeSuiClient({ chainId: TESTNET_CHAIN_ID, chainIdDelayMs: 200 }),
      recorder,
      20,
    );

    await expect(guard.verifyDigestOrigin('digest123')).resolves.toBe(false);
    expect(recorder.outcomesFor('digest_origin')).toEqual(['fail']);
  });
});

describe('NetworkGuard.recordCheck', () => {
  it('appends a record with the given type, outcome, and detail', async () => {
    const recorder = new FakeRecorder();
    const guard = makeGuard(new FakeSuiClient(), recorder);

    await guard.recordCheck('wallet_network', 'pass', 'wallet on testnet');

    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]).toMatchObject({
      check_type: 'wallet_network',
      outcome: 'pass',
      detail: 'wallet on testnet',
    });
    // Postgres fills checked_at with an ISO 8601 UTC instant (Date here).
    expect(recorder.records[0]?.checked_at).toBeInstanceOf(Date);
  });

  it('records a null detail when none is provided', async () => {
    const recorder = new FakeRecorder();
    const guard = makeGuard(new FakeSuiClient(), recorder);

    await guard.recordCheck('rpc_chain_id', 'fail');

    expect(recorder.records[0]?.detail).toBeNull();
  });
});

describe('NetworkGuard records every verification', () => {
  it('writes exactly one environment_checks row per verification call (pass and fail paths)', async () => {
    const recorder = new FakeRecorder();

    // Pass paths.
    await makeGuard(new FakeSuiClient({ chainId: TESTNET_CHAIN_ID }), recorder)
      .verifyRpcChainIdAtStartup();
    await makeGuard(new FakeSuiClient({ chainId: TESTNET_CHAIN_ID }), recorder)
      .verifySubmissionTarget('0xpolicy');
    await makeGuard(
      new FakeSuiClient({ chainId: TESTNET_CHAIN_ID, txExists: true }),
      recorder,
    ).verifyDigestOrigin('d');

    // Fail paths.
    await makeGuard(new FakeSuiClient({ chainId: 'wrong' }), recorder)
      .verifyRpcChainIdAtStartup()
      .catch(() => undefined);
    await makeGuard(new FakeSuiClient({ chainId: 'wrong' }), recorder)
      .verifySubmissionTarget('0xpolicy')
      .catch(() => undefined);
    await makeGuard(new FakeSuiClient({ chainId: 'wrong' }), recorder).verifyDigestOrigin('d');

    // 6 verifications -> 6 recorded checks, none skipped.
    expect(recorder.records).toHaveLength(6);
    expect(recorder.outcomesFor('rpc_chain_id')).toEqual(['pass', 'fail']);
    expect(recorder.outcomesFor('submission_target')).toEqual(['pass', 'fail']);
    expect(recorder.outcomesFor('digest_origin')).toEqual(['pass', 'fail']);
  });
});

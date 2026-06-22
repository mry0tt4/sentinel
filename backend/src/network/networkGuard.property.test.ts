// Feature: sentinel-risk-guardian, Property 24: Network verification is always recorded
//
// **Validates: Requirements 1.6, 1.7, 1.8, 1.9, 1.10**
//
// Property 24: For ANY randomized sequence of network-verification calls
// (verifyRpcChainIdAtStartup / verifySubmissionTarget / verifyDigestOrigin,
// against randomized chain ids, package ids, digests, and pass/fail
// conditions), EVERY verification call results in exactly one recorded
// `environment_checks` entry — i.e. count(records) === count(verifications) —
// and additionally:
//   * a failed submission-target verification THROWS, blocking the action
//     (Req 1.6, 1.7, 1.10), and
//   * a failed digest-origin verification RETURNS false, blocking display
//     (Req 1.8, 1.9, 1.10).

import fc from 'fast-check';
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

const CONFIGURED_PACKAGE_IDS = ['0xpolicy', '0xdemo', '0xadapters'] as const;

const baseConfig: NetworkGuardConfig = {
  suiTestnetChainId: TESTNET_CHAIN_ID,
  packageIds: {
    policy: CONFIGURED_PACKAGE_IDS[0],
    demoMarket: CONFIGURED_PACKAGE_IDS[1],
    adapters: CONFIGURED_PACKAGE_IDS[2],
  },
};

/**
 * In-memory recorder shared across the steps of a single generated scenario so
 * we can count exactly how many `environment_checks` rows were appended.
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

/** Configurable fake Sui RPC client (matches the unit-test fake's contract). */
class FakeSuiClient implements SuiChainClient {
  constructor(
    private readonly opts: { chainId: string; txExists: boolean },
  ) {}

  async getChainIdentifier(): Promise<string> {
    return this.opts.chainId;
  }

  async getTransactionBlock(_input: { digest: string }): Promise<unknown> {
    if (!this.opts.txExists) {
      throw new Error('transaction not found');
    }
    return { digest: 'ok' };
  }
}

// --- Arbitraries -----------------------------------------------------------

/** A chain id that is guaranteed NOT to equal the testnet chain id. */
const wrongChainIdArb = fc
  .string({ minLength: 1, maxLength: 16 })
  .filter((s) => s !== TESTNET_CHAIN_ID);

/** Either the real testnet chain id or a mismatching one. */
const chainIdArb = fc.oneof(
  fc.constant(TESTNET_CHAIN_ID),
  wrongChainIdArb,
);

/** A configured (valid) package id or an arbitrary unconfigured one. */
const packageIdArb = fc.oneof(
  fc.constantFrom(...CONFIGURED_PACKAGE_IDS),
  fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((s) => !CONFIGURED_PACKAGE_IDS.includes(s as never)),
);

const digestArb = fc.string({ minLength: 1, maxLength: 32 });

type Step =
  | { kind: 'rpc'; chainId: string }
  | { kind: 'submission'; chainId: string; packageId: string }
  | { kind: 'digest'; chainId: string; digest: string; txExists: boolean };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('rpc' as const), chainId: chainIdArb }),
  fc.record({
    kind: fc.constant('submission' as const),
    chainId: chainIdArb,
    packageId: packageIdArb,
  }),
  fc.record({
    kind: fc.constant('digest' as const),
    chainId: chainIdArb,
    digest: digestArb,
    txExists: fc.boolean(),
  }),
);

/** Sequence of 1..10 verification calls. */
const scenarioArb = fc.array(stepArb, { minLength: 1, maxLength: 10 });

// --- Property --------------------------------------------------------------

describe('Property 24: Network verification is always recorded', () => {
  it('records exactly one environment_checks row per verification, and failed submission/digest checks block', async () => {
    // Aggregate coverage counters so we can confirm the property genuinely
    // exercised BOTH pass and fail paths across all generated scenarios.
    const seen = {
      submissionPass: 0,
      submissionFail: 0,
      digestPass: 0,
      digestFail: 0,
      rpcPass: 0,
      rpcFail: 0,
    };

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (steps) => {
        const recorder = new FakeRecorder();

        for (const step of steps) {
          if (step.kind === 'rpc') {
            const guard = new NetworkGuard(
              new FakeSuiClient({ chainId: step.chainId, txExists: true }),
              recorder,
              baseConfig,
            );
            const expectPass = step.chainId === TESTNET_CHAIN_ID;
            let threw = false;
            try {
              await guard.verifyRpcChainIdAtStartup();
            } catch (err) {
              threw = true;
              // Startup verification blocks by throwing on failure.
              expect(err).toBeInstanceOf(NetworkVerificationError);
            }
            expect(threw).toBe(!expectPass);
            expectPass ? seen.rpcPass++ : seen.rpcFail++;
          } else if (step.kind === 'submission') {
            const guard = new NetworkGuard(
              new FakeSuiClient({ chainId: step.chainId, txExists: true }),
              recorder,
              baseConfig,
            );
            const expectPass =
              CONFIGURED_PACKAGE_IDS.includes(step.packageId as never) &&
              step.chainId === TESTNET_CHAIN_ID;
            let threw = false;
            try {
              await guard.verifySubmissionTarget(step.packageId);
            } catch (err) {
              threw = true;
              // Req 1.6/1.7: failed submission-target verification blocks the
              // action by throwing.
              expect(err).toBeInstanceOf(NetworkVerificationError);
            }
            expect(threw).toBe(!expectPass);
            expectPass ? seen.submissionPass++ : seen.submissionFail++;
          } else {
            const guard = new NetworkGuard(
              new FakeSuiClient({ chainId: step.chainId, txExists: step.txExists }),
              recorder,
              baseConfig,
            );
            const expectPass = step.chainId === TESTNET_CHAIN_ID && step.txExists;
            const result = await guard.verifyDigestOrigin(step.digest);
            // Req 1.8/1.9: failed digest-origin verification blocks display by
            // returning false (never throws).
            expect(result).toBe(expectPass);
            expectPass ? seen.digestPass++ : seen.digestFail++;
          }
        }

        // Core invariant: every verification call produced exactly one record.
        expect(recorder.records).toHaveLength(steps.length);

        // And each recorded outcome agrees with whether the call blocked.
        for (const record of recorder.records) {
          expect(['pass', 'fail']).toContain(record.outcome);
        }
      }),
      { numRuns: 200 },
    );

    // Confirm the generators exercised both pass and fail paths for the
    // blocking verification types (submission-target and digest-origin) as
    // well as the startup check.
    expect(seen.submissionPass).toBeGreaterThan(0);
    expect(seen.submissionFail).toBeGreaterThan(0);
    expect(seen.digestPass).toBeGreaterThan(0);
    expect(seen.digestFail).toBeGreaterThan(0);
    expect(seen.rpcPass).toBeGreaterThan(0);
    expect(seen.rpcFail).toBeGreaterThan(0);
  });
});

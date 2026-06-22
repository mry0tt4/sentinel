/**
 * Network Guard — testnet-only enforcement (cross-cutting).
 *
 * Sentinel targets **Sui Testnet only**. The Network Guard verifies the active
 * network at three points and records every verification result to the
 * `environment_checks` audit trail:
 *
 *  1. At startup — the configured RPC endpoint's chain identifier must match
 *     the known Sui Testnet chain id, verified within a hard 10s timeout. On
 *     mismatch *or* unverifiable endpoint the backend refuses to start with no
 *     partial initialization. (Req 1.1, 1.3, 1.4)
 *  2. Before every submission — the target package id must be a configured
 *     testnet package and the RPC chain id must still match testnet, else the
 *     submission is refused. (Req 1.6, 1.7)
 *  3. Before a tx digest is displayed — the transaction must be resolvable on
 *     the testnet RPC, else display is blocked. (Req 1.8, 1.9)
 *
 * Every check — pass or fail — is written to `environment_checks` with an
 * ISO 8601 UTC timestamp (the column default), the verification type, and the
 * outcome. (Req 1.10)
 *
 * Dependencies (the RPC client and the audit recorder) are injected as narrow
 * interfaces so the guard can run against a real `SuiClient`/Postgres-backed
 * repository in production and against in-memory fakes in unit tests.
 */

import type {
  EnvCheckType,
  EnvCheckOutcome,
  EnvironmentCheckInsert,
  EnvironmentCheckRow,
} from '../db/types.js';

/**
 * Minimal subset of `@mysten/sui`'s `SuiClient` the guard depends on. A real
 * `SuiClient` is structurally assignable to this interface, while tests can
 * supply a lightweight fake that returns matching/mismatching/hanging chain
 * ids and resolvable/unresolvable digests.
 */
export interface SuiChainClient {
  /** Returns the chain identifier (first 4 bytes of the genesis checkpoint). */
  getChainIdentifier(): Promise<string>;
  /** Resolves the transaction for a digest; rejects if it does not exist. */
  getTransactionBlock(input: { digest: string }): Promise<unknown>;
}

/**
 * Minimal surface of the {@link EnvironmentChecksRepository} the guard needs.
 * The concrete repository satisfies this; tests can pass a fake.
 */
export interface EnvCheckRecorder {
  append(input: EnvironmentCheckInsert): Promise<EnvironmentCheckRow>;
}

/** Configuration the guard needs to know what "testnet" means. */
export interface NetworkGuardConfig {
  /** The known Sui Testnet chain identifier to compare against. (Req 1.3) */
  suiTestnetChainId: string;
  /** The configured testnet package ids that submissions may target. (Req 1.6) */
  packageIds: {
    policy: string;
    demoMarket: string;
    adapters: string;
  };
}

/** Tunable behaviour; defaults match the requirements (10s startup timeout). */
export interface NetworkGuardOptions {
  /**
   * Max time to verify the RPC chain identifier before treating the endpoint
   * as unverifiable. Defaults to 10_000ms per Req 1.4. Injectable so tests can
   * exercise the timeout path quickly.
   */
  chainIdTimeoutMs?: number;
}

/** Reason codes distinguishing the network-failure modes for callers. */
export type NetworkErrorCode =
  | 'NETWORK_MISMATCH' // chain id resolved but is not testnet (Req 1.3)
  | 'NETWORK_UNVERIFIABLE' // endpoint unreachable / timed out (Req 1.4)
  | 'SUBMISSION_TARGET_MISMATCH'; // package id / chain not testnet (Req 1.7)

/**
 * Raised when a network verification fails in a way that must abort the caller
 * (startup or submission). Digest-origin verification does *not* throw — it
 * returns `false` so the frontend can block display gracefully. (Req 1.9)
 */
export class NetworkVerificationError extends Error {
  constructor(
    message: string,
    readonly code: NetworkErrorCode,
  ) {
    super(message);
    this.name = 'NetworkVerificationError';
  }
}

const DEFAULT_CHAIN_ID_TIMEOUT_MS = 10_000;

/** Sentinel marker distinguishing a timeout from any other rejection. */
const TIMEOUT = Symbol('network-guard-timeout');

/**
 * Race a promise against a timeout. Resolves with the promise's value if it
 * settles first; rejects with {@link TIMEOUT} if the deadline elapses. The
 * timer is always cleared so a slow-but-eventually-resolving call cannot keep
 * the event loop alive.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(TIMEOUT), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export class NetworkGuard {
  private readonly chainIdTimeoutMs: number;

  constructor(
    private readonly client: SuiChainClient,
    private readonly checks: EnvCheckRecorder,
    private readonly config: NetworkGuardConfig,
    options: NetworkGuardOptions = {},
  ) {
    this.chainIdTimeoutMs = options.chainIdTimeoutMs ?? DEFAULT_CHAIN_ID_TIMEOUT_MS;
  }

  /**
   * Verify the configured RPC endpoint reports the Sui Testnet chain id within
   * the timeout. On mismatch or unverifiable endpoint, record a `fail` check
   * and throw so the backend refuses to start with no partial initialization.
   * On match, record a `pass`. (Req 1.1, 1.3, 1.4, 1.10)
   */
  async verifyRpcChainIdAtStartup(): Promise<void> {
    let chainId: string;
    try {
      chainId = await withTimeout(this.client.getChainIdentifier(), this.chainIdTimeoutMs);
    } catch (err) {
      const unverifiable = err === TIMEOUT;
      const detail = unverifiable
        ? `RPC chain identifier could not be verified within ${this.chainIdTimeoutMs}ms`
        : `RPC chain identifier could not be verified: ${errorMessage(err)}`;
      await this.recordCheck('rpc_chain_id', 'fail', detail);
      throw new NetworkVerificationError(detail, 'NETWORK_UNVERIFIABLE');
    }

    if (chainId !== this.config.suiTestnetChainId) {
      const detail =
        `RPC chain identifier "${chainId}" does not match the expected Sui Testnet ` +
        `chain identifier "${this.config.suiTestnetChainId}"`;
      await this.recordCheck('rpc_chain_id', 'fail', detail);
      throw new NetworkVerificationError(detail, 'NETWORK_MISMATCH');
    }

    await this.recordCheck(
      'rpc_chain_id',
      'pass',
      `RPC chain identifier matches Sui Testnet ("${chainId}")`,
    );
  }

  /**
   * Verify that a pending submission targets Sui Testnet: the package id must
   * be one of the configured testnet packages AND the live RPC chain id must
   * still match testnet. Records pass/fail and throws on failure so the Action
   * Executor refuses to submit with no partial submission. (Req 1.6, 1.7, 1.10)
   */
  async verifySubmissionTarget(packageId: string): Promise<void> {
    const allowed = this.allowedPackageIds();
    if (!allowed.includes(packageId)) {
      const detail =
        `Submission target package id "${packageId}" is not a configured Sui Testnet package`;
      await this.recordCheck('submission_target', 'fail', detail);
      throw new NetworkVerificationError(detail, 'SUBMISSION_TARGET_MISMATCH');
    }

    let chainId: string;
    try {
      chainId = await withTimeout(this.client.getChainIdentifier(), this.chainIdTimeoutMs);
    } catch (err) {
      const detail =
        err === TIMEOUT
          ? `RPC chain identifier could not be verified within ${this.chainIdTimeoutMs}ms`
          : `RPC chain identifier could not be verified: ${errorMessage(err)}`;
      await this.recordCheck('submission_target', 'fail', detail);
      throw new NetworkVerificationError(detail, 'SUBMISSION_TARGET_MISMATCH');
    }

    if (chainId !== this.config.suiTestnetChainId) {
      const detail =
        `RPC chain identifier "${chainId}" does not match Sui Testnet for submission target`;
      await this.recordCheck('submission_target', 'fail', detail);
      throw new NetworkVerificationError(detail, 'SUBMISSION_TARGET_MISMATCH');
    }

    await this.recordCheck(
      'submission_target',
      'pass',
      `Submission target package "${packageId}" verified on Sui Testnet`,
    );
  }

  /**
   * Verify a transaction digest originates from Sui Testnet before the
   * frontend displays it. Returns `true` when the chain id matches testnet and
   * the transaction is resolvable on the testnet RPC; returns `false` (without
   * throwing) when verification fails, so the caller can block display and
   * return a verification error. Records pass/fail either way. (Req 1.8, 1.9,
   * 1.10)
   */
  async verifyDigestOrigin(txDigest: string): Promise<boolean> {
    let chainId: string;
    try {
      chainId = await withTimeout(this.client.getChainIdentifier(), this.chainIdTimeoutMs);
    } catch (err) {
      const detail =
        err === TIMEOUT
          ? `Chain identifier could not be verified within ${this.chainIdTimeoutMs}ms while ` +
            `checking digest "${txDigest}"`
          : `Chain identifier could not be verified for digest "${txDigest}": ${errorMessage(err)}`;
      await this.recordCheck('digest_origin', 'fail', detail);
      return false;
    }

    if (chainId !== this.config.suiTestnetChainId) {
      const detail =
        `Digest "${txDigest}" cannot be confirmed on Sui Testnet: RPC chain identifier ` +
        `"${chainId}" does not match`;
      await this.recordCheck('digest_origin', 'fail', detail);
      return false;
    }

    try {
      await this.client.getTransactionBlock({ digest: txDigest });
    } catch (err) {
      const detail =
        `Digest "${txDigest}" could not be resolved on Sui Testnet: ${errorMessage(err)}`;
      await this.recordCheck('digest_origin', 'fail', detail);
      return false;
    }

    await this.recordCheck(
      'digest_origin',
      'pass',
      `Digest "${txDigest}" confirmed on Sui Testnet`,
    );
    return true;
  }

  /**
   * Write a single environment-check result to the `environment_checks` store.
   * The `checked_at` timestamp is supplied by the column default (`now()`),
   * which Postgres stores as a UTC `TIMESTAMPTZ` — i.e. an ISO 8601 UTC
   * instant. (Req 1.10)
   */
  async recordCheck(
    type: EnvCheckType,
    outcome: EnvCheckOutcome,
    detail?: string,
  ): Promise<void> {
    await this.checks.append({
      check_type: type,
      outcome,
      detail: detail ?? null,
    });
  }

  /** Configured testnet package ids, excluding any that are unset (empty). */
  private allowedPackageIds(): string[] {
    return [
      this.config.packageIds.policy,
      this.config.packageIds.demoMarket,
      this.config.packageIds.adapters,
    ].filter((id) => id.trim() !== '');
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

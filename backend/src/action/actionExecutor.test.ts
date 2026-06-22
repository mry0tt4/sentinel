/**
 * Unit tests for the Action Executor's server-defined PTB templates and
 * simulation (task 11.1). These are example-based; the dedicated property
 * tests are 11.2 (template-only) and 11.3 (simulate-before-submit).
 */

import { describe, it, expect } from 'vitest';
import { normalizeSuiObjectId } from '@mysten/sui/utils';
import type { Transaction } from '@mysten/sui/transactions';

import {
  ActionExecutor,
  EXECUTE_GUARDIAN_ACTION,
  POLICY_MODULE,
  type ActionExecutorConfig,
  type DryRunResponseLike,
  type TransactionSimulator,
} from './actionExecutor.js';
import {
  ACTION_TYPE,
  ActionTemplateError,
  FORBIDDEN_REQUEST_KEYS,
  type BoundedActionRequest,
} from './types.js';

const POLICY_PACKAGE = '0xabc';
const PYTH_PACKAGE = '0xdef';

function makeExecutor(
  simulator?: TransactionSimulator,
  overrides: Partial<ActionExecutorConfig> = {},
): ActionExecutor {
  return new ActionExecutor(
    { policyPackageId: POLICY_PACKAGE, pyth: { packageId: PYTH_PACKAGE }, ...overrides },
    simulator,
  );
}

function baseRequest(overrides: Partial<BoundedActionRequest> = {}): BoundedActionRequest {
  return {
    policyObjectId: '0xa1',
    guardianCapObjectId: '0xb2',
    marketStateObjectId: '0xc3',
    actionType: ACTION_TYPE.PAUSE_BORROWS,
    newParamValue: 0,
    pauseDurationMs: 3_600_000,
    riskScore: 95,
    evidenceBlobId: 'blob-abc',
    evidenceHash: [1, 2, 3, 4],
    ...overrides,
  };
}

/** Extract the MoveCall commands from a built Transaction's data. */
function moveCalls(tx: Transaction): Array<{ package: string; module: string; function: string }> {
  const data = tx.getData();
  return data.commands
    .filter((c): c is typeof c & { MoveCall: NonNullable<unknown> } => 'MoveCall' in c && c.MoveCall != null)
    .map((c) => {
      const mc = (c as unknown as { MoveCall: { package: string; module: string; function: string } })
        .MoveCall;
      return { package: mc.package, module: mc.module, function: mc.function };
    });
}

describe('ActionExecutor.buildActionPtb — server-defined templates', () => {
  it('composes a single execute_guardian_action call when no price update is requested', () => {
    const tx = makeExecutor().buildActionPtb(baseRequest());
    const calls = moveCalls(tx);

    expect(calls).toHaveLength(1);
    expect(calls[0].package).toBe(normalizeSuiObjectId(POLICY_PACKAGE));
    expect(calls[0].module).toBe(POLICY_MODULE);
    expect(calls[0].function).toBe(EXECUTE_GUARDIAN_ACTION);
  });

  it('prepends the price-feed update call when a price update is requested', () => {
    const tx = makeExecutor().buildActionPtb(
      baseRequest({
        priceFeedUpdate: { priceInfoObjectId: '0xfeed', priceUpdateData: [9, 9, 9] },
      }),
    );
    const calls = moveCalls(tx);

    expect(calls).toHaveLength(2);
    // Price update is composed first.
    expect(calls[0].package).toBe(normalizeSuiObjectId(PYTH_PACKAGE));
    expect(calls[0].module).toBe('pyth');
    expect(calls[0].function).toBe('update_price_feed');
    // Followed by the guardian action.
    expect(calls[1].package).toBe(normalizeSuiObjectId(POLICY_PACKAGE));
    expect(calls[1].function).toBe(EXECUTE_GUARDIAN_ACTION);
  });

  it('builds the guardian-action argument list in the on-chain signature order', () => {
    const tx = makeExecutor().buildActionPtb(baseRequest({ actionType: ACTION_TYPE.REDUCE_LTV }));
    const data = tx.getData();
    const call = data.commands.find((c) => 'MoveCall' in c && c.MoveCall != null);
    expect(call).toBeDefined();
    const args = (call as unknown as { MoveCall: { arguments: unknown[] } }).MoveCall.arguments;
    // policy, guardian_cap, market, action_type, new_param_value, pause_duration_ms,
    // risk_score, blob_id, evidence_hash, tx_digest, clock => 11 arguments.
    expect(args).toHaveLength(11);
  });

  it('refuses to build when a price update is requested but no pyth target is configured', () => {
    const executor = new ActionExecutor({ policyPackageId: POLICY_PACKAGE });
    expect(() =>
      executor.buildActionPtb(
        baseRequest({
          priceFeedUpdate: { priceInfoObjectId: '0xfeed1', priceUpdateData: [1] },
        }),
      ),
    ).toThrow(ActionTemplateError);
  });
});

describe('ActionExecutor.buildActionPtb — rejects arbitrary structure', () => {
  it('rejects an unknown action type', () => {
    expect(() =>
      makeExecutor().buildActionPtb(baseRequest({ actionType: 99 as never })),
    ).toThrow(/Unknown action type/);
  });

  it('rejects requests that attempt to supply arbitrary PTB structure', () => {
    for (const key of FORBIDDEN_REQUEST_KEYS) {
      const malicious = { ...baseRequest(), [key]: { foo: 'bar' } } as BoundedActionRequest;
      expect(() => makeExecutor().buildActionPtb(malicious)).toThrow(ActionTemplateError);
    }
  });

  it('rejects malformed structured fields', () => {
    expect(() => makeExecutor().buildActionPtb(baseRequest({ policyObjectId: '' }))).toThrow(
      ActionTemplateError,
    );
    expect(() => makeExecutor().buildActionPtb(baseRequest({ newParamValue: -1 }))).toThrow(
      ActionTemplateError,
    );
    expect(() => makeExecutor().buildActionPtb(baseRequest({ riskScore: 1000 }))).toThrow(
      ActionTemplateError,
    );
    expect(() => makeExecutor().buildActionPtb(baseRequest({ evidenceBlobId: '' }))).toThrow(
      ActionTemplateError,
    );
  });
});

describe('ActionExecutor.simulate — dry-run mapping', () => {
  const okResponse: DryRunResponseLike = {
    effects: { status: { status: 'success' } },
    events: [{ type: 'RiskActionExecuted' }],
  };
  const failResponse: DryRunResponseLike = {
    effects: { status: { status: 'failure', error: 'MoveAbort: ECooldownActive' } },
    events: [],
  };

  it('maps a successful dry-run to { success: true } with events', async () => {
    const executor = makeExecutor({ dryRun: async () => okResponse });
    const tx = executor.buildActionPtb(baseRequest());

    const result = await executor.simulate(tx);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.events).toEqual([{ type: 'RiskActionExecuted' }]);
  });

  it('maps a failed dry-run to { success: false } with the abort error', async () => {
    const executor = makeExecutor({ dryRun: async () => failResponse });
    const tx = executor.buildActionPtb(baseRequest());

    const result = await executor.simulate(tx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECooldownActive');
  });

  it('maps a thrown dry-run error to { success: false } (fail-closed)', async () => {
    const executor = makeExecutor({
      dryRun: async () => {
        throw new Error('rpc unreachable');
      },
    });
    const tx = executor.buildActionPtb(baseRequest());

    const result = await executor.simulate(tx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('rpc unreachable');
  });

  it('throws if no simulator was injected', async () => {
    const executor = makeExecutor(undefined);
    const tx = executor.buildActionPtb(baseRequest());
    await expect(executor.simulate(tx)).rejects.toBeInstanceOf(ActionTemplateError);
  });
});

describe('ActionExecutor — construction', () => {
  it('requires a policy package id', () => {
    expect(() => new ActionExecutor({ policyPackageId: '' })).toThrow(ActionTemplateError);
  });
});

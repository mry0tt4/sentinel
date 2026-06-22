// Feature: sentinel-risk-guardian, Property 27: Server-defined PTB templates only
//
// THE Backend SHALL construct PTBs from server-defined templates and SHALL
// reject arbitrary PTB construction from user input.
//
// This property exercises ActionExecutor.buildActionPtb across the whole input
// space and asserts two invariants:
//
//   (a) For ANY VALID BoundedActionRequest (arbitrary valid action type, object
//       ids, bounded params, evidence refs, and an optional priceFeedUpdate),
//       the built PTB's Move calls target ONLY the server-defined template: the
//       final call is `${policyPackageId}::policy::execute_guardian_action`, and
//       when a price update is present the only other call is the configured
//       pyth update. No arbitrary / caller-chosen target ever appears.
//
//   (b) For ANY request carrying a FORBIDDEN_REQUEST_KEYS property (an attempt
//       to smuggle raw-PTB-like structure) OR an unknown/out-of-range action
//       type, buildActionPtb REJECTS the request with ActionTemplateError —
//       arbitrary user-supplied PTB structure can never be built.
//
// Validates: Requirements 16.4

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeSuiObjectId } from '@mysten/sui/utils';
import type { Transaction } from '@mysten/sui/transactions';

import {
  ActionExecutor,
  EXECUTE_GUARDIAN_ACTION,
  POLICY_MODULE,
  type ActionExecutorConfig,
} from './actionExecutor.js';
import {
  VALID_ACTION_TYPE_CODES,
  ActionTemplateError,
  FORBIDDEN_REQUEST_KEYS,
  type ActionTypeCode,
  type BoundedActionRequest,
} from './types.js';

const POLICY_PACKAGE = '0xabc';
const PYTH_PACKAGE = '0xdef';
const PYTH_MODULE = 'pyth';
const PYTH_FUNCTION = 'update_price_feed';

const NUM_RUNS = 200;

function makeExecutor(overrides: Partial<ActionExecutorConfig> = {}): ActionExecutor {
  return new ActionExecutor({
    policyPackageId: POLICY_PACKAGE,
    pyth: { packageId: PYTH_PACKAGE },
    ...overrides,
  });
}

/** Extract the MoveCall commands from a built Transaction's data. */
function moveCalls(tx: Transaction): Array<{ package: string; module: string; function: string }> {
  const data = tx.getData();
  return data.commands
    .filter(
      (c): c is typeof c & { MoveCall: NonNullable<unknown> } =>
        'MoveCall' in c && c.MoveCall != null,
    )
    .map((c) => {
      const mc = (
        c as unknown as { MoveCall: { package: string; module: string; function: string } }
      ).MoveCall;
      return { package: mc.package, module: mc.module, function: mc.function };
    });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** An object-id-shaped hex string (always non-empty, 0x-prefixed). */
const objectIdArb = fc
  .hexaString({ minLength: 1, maxLength: 40 })
  .map((hex) => `0x${hex}`);

/** A bounded vector<u8> input: either a number[] or a Uint8Array. */
const byteInputArb = fc.oneof(
  fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 32 }),
  fc.uint8Array({ maxLength: 32 }),
);

/** A bounded u64 value, expressed as number or bigint. */
const u64Arb = fc.oneof(
  fc.integer({ min: 0, max: 2_000_000_000 }),
  fc.bigInt({ min: 0n, max: 18_446_744_073_709_551_615n }),
);

const actionTypeArb = fc.constantFrom(
  ...(VALID_ACTION_TYPE_CODES as readonly ActionTypeCode[]),
);

/** A fully VALID BoundedActionRequest, with an optional priceFeedUpdate. */
const validRequestArb: fc.Arbitrary<BoundedActionRequest> = fc.record(
  {
    policyObjectId: objectIdArb,
    guardianCapObjectId: objectIdArb,
    marketStateObjectId: objectIdArb,
    actionType: actionTypeArb,
    newParamValue: u64Arb,
    pauseDurationMs: u64Arb,
    riskScore: fc.integer({ min: 0, max: 255 }),
    evidenceBlobId: fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim() !== ''),
    evidenceHash: byteInputArb,
    txDigest: fc.option(byteInputArb, { nil: undefined }),
    clockObjectId: fc.option(objectIdArb, { nil: undefined }),
    priceFeedUpdate: fc.option(
      fc.record({
        priceInfoObjectId: objectIdArb,
        priceUpdateData: byteInputArb,
      }),
      { nil: undefined },
    ),
  },
  { requiredKeys: ['policyObjectId', 'guardianCapObjectId', 'marketStateObjectId', 'actionType', 'newParamValue', 'pauseDurationMs', 'riskScore', 'evidenceBlobId', 'evidenceHash'] },
);

/** An arbitrary JSON-ish value to stuff into a forbidden field. */
const arbitraryStructureArb = fc.oneof(
  fc.record({ target: fc.string(), arguments: fc.array(fc.string()) }),
  fc.array(fc.record({ MoveCall: fc.record({ target: fc.string() }) })),
  fc.string(),
  fc.constant({ kind: 'ProgrammableTransaction', commands: [] }),
);

// ---------------------------------------------------------------------------
// (a) Template-only invariant for valid requests
// ---------------------------------------------------------------------------

describe('Property 27: buildActionPtb only ever targets server-defined templates', () => {
  const policyTarget = {
    package: normalizeSuiObjectId(POLICY_PACKAGE),
    module: POLICY_MODULE,
    function: EXECUTE_GUARDIAN_ACTION,
  };
  const pythTarget = {
    package: normalizeSuiObjectId(PYTH_PACKAGE),
    module: PYTH_MODULE,
    function: PYTH_FUNCTION,
  };

  it('builds PTBs whose Move calls are exclusively the configured template targets', () => {
    fc.assert(
      fc.property(validRequestArb, (req) => {
        const calls = moveCalls(makeExecutor().buildActionPtb(req));

        // The final (or only) call is ALWAYS the server-defined guardian action.
        const last = calls[calls.length - 1];
        expect(last).toEqual(policyTarget);

        if (req.priceFeedUpdate) {
          // Exactly two calls: the configured pyth update THEN the guardian action.
          expect(calls).toHaveLength(2);
          expect(calls[0]).toEqual(pythTarget);
        } else {
          // No price update -> a single guardian-action call, nothing else.
          expect(calls).toHaveLength(1);
        }

        // Defensive: no call may target anything other than the two known
        // server-owned templates — no arbitrary/caller-chosen target appears.
        for (const call of calls) {
          const matchesTemplate =
            (call.package === policyTarget.package &&
              call.module === policyTarget.module &&
              call.function === policyTarget.function) ||
            (call.package === pythTarget.package &&
              call.module === pythTarget.module &&
              call.function === pythTarget.function);
          expect(matchesTemplate).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// (b) Arbitrary user-supplied structure / unknown action type is rejected
// ---------------------------------------------------------------------------

describe('Property 27: buildActionPtb rejects arbitrary user-supplied PTB structure', () => {
  it('rejects any request carrying a forbidden raw-PTB-like property', () => {
    fc.assert(
      fc.property(
        validRequestArb,
        fc.constantFrom(...FORBIDDEN_REQUEST_KEYS),
        arbitraryStructureArb,
        (req, forbiddenKey, payload) => {
          const malicious = { ...req, [forbiddenKey]: payload } as BoundedActionRequest;
          expect(() => makeExecutor().buildActionPtb(malicious)).toThrow(ActionTemplateError);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects any unknown / out-of-range action type', () => {
    const unknownActionTypeArb = fc
      .integer({ min: -1000, max: 1000 })
      .filter((n) => !(VALID_ACTION_TYPE_CODES as readonly number[]).includes(n));

    fc.assert(
      fc.property(validRequestArb, unknownActionTypeArb, (req, badType) => {
        const bad = { ...req, actionType: badType as unknown as ActionTypeCode };
        expect(() => makeExecutor().buildActionPtb(bad)).toThrow(ActionTemplateError);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

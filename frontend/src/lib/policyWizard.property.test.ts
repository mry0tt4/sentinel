// Feature: sentinel-risk-guardian, Property 26: Wizard rejects invalid configuration
//
// Validates: Requirements 4.9
//
// Property 26 — Wizard rejects invalid configuration: a wizard configuration
// that is invalid in exactly one way — a MISSING required value (market type,
// market, feed mapping, allowed actions, or DAO address) OR an OUT-OF-RANGE
// bound (maxLtvDeltaBps / maxMarginDeltaBps / pauseDurationLimitMs / cooldownMs
// being negative, non-integer, or beyond the allowed maximum) — must be
// reported invalid by validateWizard (submission blocked, no draft) AND the
// returned error map must identify the offending field. Conversely, any fully
// valid configuration must be reported ok with a normalized draft.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MARKET_TYPES,
  POLICY_ACTIONS,
  WIZARD_BOUNDS,
  validateWizard,
  type BoundField,
  type WizardField,
  type WizardState,
} from './policyWizard';

const NUM_RUNS = 200;

const BOUND_FIELDS: readonly BoundField[] = [
  'maxLtvDeltaBps',
  'maxMarginDeltaBps',
  'pauseDurationLimitMs',
  'cooldownMs',
];

// ---------------------------------------------------------------------------
// Generators for the valid input space.
// ---------------------------------------------------------------------------

/** A non-empty token with no surrounding/embedded whitespace (asset, feed, id). */
const tokenArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .map((s) => {
    const cleaned = s.replace(/\s/g, '');
    return cleaned.length === 0 ? 'a' : cleaned;
  });

/** A well-formed Sui address: 0x + 1..64 hex digits. */
const hexAddressArb = fc
  .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 1, maxLength: 64 })
  .map((chars) => `0x${chars.join('')}`);

/** An in-range integer (as a raw string) for the given bound field. */
function validBoundRawArb(field: BoundField): fc.Arbitrary<string> {
  const { min, max } = WIZARD_BOUNDS[field];
  return fc.integer({ min, max }).map(String);
}

/** A fully valid wizard state. validateWizard must report this ok. */
const validStateArb: fc.Arbitrary<WizardState> = fc
  .record({
    marketType: fc.constantFrom(...MARKET_TYPES),
    marketMode: fc.constantFrom('select', 'create') as fc.Arbitrary<'select' | 'create'>,
    selectedMarketId: tokenArb,
    newMarketName: tokenArb,
    feedMappings: fc.array(fc.record({ asset: tokenArb, feedId: tokenArb }), {
      minLength: 1,
      maxLength: 3,
    }),
    allowedActions: fc.subarray([...POLICY_ACTIONS], { minLength: 1 }),
    maxLtvDeltaBps: validBoundRawArb('maxLtvDeltaBps'),
    maxMarginDeltaBps: validBoundRawArb('maxMarginDeltaBps'),
    pauseDurationLimitMs: validBoundRawArb('pauseDurationLimitMs'),
    cooldownMs: validBoundRawArb('cooldownMs'),
    daoAddress: hexAddressArb,
  });

// ---------------------------------------------------------------------------
// Generators that take a valid state and break it in exactly one way, pairing
// the mutated state with the field expected to be flagged.
// ---------------------------------------------------------------------------

interface Mutation {
  readonly field: WizardField;
  readonly apply: (base: WizardState) => WizardState;
}

/** An invalid raw bound value: negative, non-integer, or beyond the maximum. */
function invalidBoundRawArb(field: BoundField): fc.Arbitrary<string> {
  const { max } = WIZARD_BOUNDS[field];
  return fc.oneof(
    // Negative — rejected by the strict non-negative integer parser.
    fc.integer({ min: 1, max: 1_000_000 }).map((n) => `-${n}`),
    // Non-integer — a decimal string.
    fc
      .tuple(fc.integer({ min: 0, max: 9_999 }), fc.integer({ min: 1, max: 9 }))
      .map(([whole, frac]) => `${whole}.${frac}`),
    // Beyond the allowed maximum.
    fc.integer({ min: max + 1, max: max + 1_000_000 }).map(String),
  );
}

/** Mutations that remove a required value. */
const missingMutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.constant<Mutation>({
    field: 'marketType',
    apply: (base) => ({ ...base, marketType: null }),
  }),
  // Force select-mode with an empty id so "market" is unambiguously missing.
  fc.constant<Mutation>({
    field: 'market',
    apply: (base) => ({ ...base, marketMode: 'select', selectedMarketId: '   ' }),
  }),
  fc.constant<Mutation>({
    field: 'feedMappings',
    apply: (base) => ({ ...base, feedMappings: [{ asset: '', feedId: '' }] }),
  }),
  fc.constant<Mutation>({
    field: 'allowedActions',
    apply: (base) => ({ ...base, allowedActions: [] }),
  }),
  fc.constant<Mutation>({
    field: 'daoAddress',
    apply: (base) => ({ ...base, daoAddress: '' }),
  }),
);

/** Mutations that push a single bound out of range. */
const outOfRangeMutationArb: fc.Arbitrary<Mutation> = fc
  .constantFrom(...BOUND_FIELDS)
  .chain((field) =>
    invalidBoundRawArb(field).map((raw) => ({
      field,
      apply: (base: WizardState) => ({ ...base, [field]: raw }),
    })),
  );

/** Either kind of single-fault mutation. */
const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(missingMutationArb, outOfRangeMutationArb);

// ---------------------------------------------------------------------------
// Property 26.
// ---------------------------------------------------------------------------

describe('Property 26: Wizard rejects invalid configuration (Req 4.9)', () => {
  it('reports any fully valid configuration as ok and produces a draft', () => {
    fc.assert(
      fc.property(validStateArb, (state) => {
        const result = validateWizard(state);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual({});
        expect(result.draft).not.toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('blocks a configuration invalid in exactly one way and names the invalid value', () => {
    fc.assert(
      fc.property(validStateArb, mutationArb, (base, mutation) => {
        // Precondition: the base must actually be valid so the single mutation
        // is the sole source of invalidity.
        fc.pre(validateWizard(base).valid);

        const broken = mutation.apply(base);
        const result = validateWizard(broken);

        // Submission is blocked and no draft is produced.
        expect(result.valid).toBe(false);
        expect(result.draft).toBeNull();

        // The offending field is identified...
        expect(result.errors[mutation.field]).toBeDefined();
        // ...and it is the only one flagged (the fault is identified precisely).
        expect(Object.keys(result.errors)).toEqual([mutation.field]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

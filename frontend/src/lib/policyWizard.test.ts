import { describe, expect, it } from 'vitest';
import {
  initialWizardState,
  parseIntegerStrict,
  validateWizard,
  type WizardState,
} from './policyWizard';

/** A fully valid wizard state for happy-path assertions. */
function validState(): WizardState {
  return {
    marketType: 'demo',
    marketMode: 'select',
    selectedMarketId: 'market-1',
    newMarketName: '',
    feedMappings: [{ asset: 'SUI', feedId: '0xfeed' }],
    allowedActions: ['pause_new_borrows'],
    maxLtvDeltaBps: '500',
    maxMarginDeltaBps: '300',
    pauseDurationLimitMs: '60000',
    cooldownMs: '30000',
    daoAddress: '0xda0',
  };
}

describe('parseIntegerStrict', () => {
  it('parses non-negative integers', () => {
    expect(parseIntegerStrict('0')).toBe(0);
    expect(parseIntegerStrict(' 42 ')).toBe(42);
  });

  it('rejects non-integers, negatives, and junk', () => {
    expect(parseIntegerStrict('')).toBeNull();
    expect(parseIntegerStrict('-1')).toBeNull();
    expect(parseIntegerStrict('1.5')).toBeNull();
    expect(parseIntegerStrict('abc')).toBeNull();
    expect(parseIntegerStrict('1e3')).toBeNull();
  });
});

describe('validateWizard', () => {
  it('accepts a fully valid configuration and builds a normalized draft', () => {
    const result = validateWizard(validState());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
    expect(result.draft).toMatchObject({
      marketId: 'market-1',
      marketType: 'demo',
      allowedActions: ['pause_new_borrows'],
      maxLtvDeltaBps: 500,
      maxMarginDeltaBps: 300,
      pauseDurationLimitMs: 60000,
      cooldownMs: 30000,
      daoAddress: '0xda0',
    });
  });

  it('flags every missing required value on a blank state', () => {
    const result = validateWizard(initialWizardState());
    expect(result.valid).toBe(false);
    expect(result.draft).toBeNull();
    expect(result.errors.marketType).toBeDefined();
    expect(result.errors.market).toBeDefined();
    expect(result.errors.feedMappings).toBeDefined();
    expect(result.errors.allowedActions).toBeDefined();
    expect(result.errors.maxLtvDeltaBps).toBeDefined();
    expect(result.errors.daoAddress).toBeDefined();
  });

  it('identifies an out-of-range bound and blocks the draft', () => {
    const result = validateWizard({ ...validState(), maxLtvDeltaBps: '20000' });
    expect(result.valid).toBe(false);
    expect(result.draft).toBeNull();
    expect(result.errors.maxLtvDeltaBps).toMatch(/between 0 and 10000/);
  });

  it('rejects a partial feed mapping', () => {
    const result = validateWizard({
      ...validState(),
      feedMappings: [{ asset: 'SUI', feedId: '' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.feedMappings).toBeDefined();
  });

  it('requires the new-market name in create mode', () => {
    const result = validateWizard({
      ...validState(),
      marketMode: 'create',
      selectedMarketId: '',
      newMarketName: '',
    });
    expect(result.errors.market).toBeDefined();
  });

  it('rejects a malformed DAO override address', () => {
    const result = validateWizard({ ...validState(), daoAddress: 'not-an-address' });
    expect(result.errors.daoAddress).toMatch(/0x-prefixed/);
  });
});

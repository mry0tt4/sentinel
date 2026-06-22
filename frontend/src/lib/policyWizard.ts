// Pure state + validation logic for the onboarding / policy configuration
// wizard (/policies/new). Kept framework-free so it can be unit/property
// tested in isolation and reused by the React island.
//
// Validation mirrors the backend `/api/policies/draft` contract
// (backend/src/api/actionRoutes.ts): a non-empty `marketId`, a non-empty
// `allowedActions` subset, and four range-validated integer bounds. The wizard
// additionally enforces the market-type, feed-mapping, and DAO-override-address
// steps that are frontend-only. (Requirements 4.1–4.10)

/** Market types a Protocol_Admin may choose from. (Req 4.2) */
export const MARKET_TYPES = ['lending', 'perps', 'stablecoin', 'demo'] as const;
export type MarketType = (typeof MARKET_TYPES)[number];

/** Autonomous mitigation actions a policy may permit. Mirrors the backend set. */
export const POLICY_ACTIONS = [
  'pause_new_borrows',
  'reduce_max_ltv',
  'enter_guarded_mode',
  'increase_maintenance_margin',
] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/** Inclusive integer range for a policy bound. */
export interface IntegerRange {
  readonly min: number;
  readonly max: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Client-side range specs, matching the backend `DEFAULT_POLICY_BOUNDS`. The
 * backend remains the authority (the wizard also POSTs the draft for
 * server-side range validation), but replicating the ranges lets the UI flag an
 * out-of-range value immediately. (Req 4.9)
 */
export const WIZARD_BOUNDS: Readonly<Record<BoundField, IntegerRange>> = Object.freeze({
  maxLtvDeltaBps: { min: 0, max: 10_000 },
  maxMarginDeltaBps: { min: 0, max: 10_000 },
  pauseDurationLimitMs: { min: 0, max: THIRTY_DAYS_MS },
  cooldownMs: { min: 0, max: THIRTY_DAYS_MS },
});

export type BoundField =
  | 'maxLtvDeltaBps'
  | 'maxMarginDeltaBps'
  | 'pauseDurationLimitMs'
  | 'cooldownMs';

/** A single asset → price-feed mapping row. (Req 4.4) */
export interface FeedMapping {
  asset: string;
  feedId: string;
}

/**
 * The complete wizard form state. Numeric bounds are held as raw strings so the
 * UI can distinguish "empty" (missing) from "0" and surface a precise error.
 */
export interface WizardState {
  marketType: MarketType | null;
  /** Whether the admin selects an existing demo market or creates a new one. (Req 4.3) */
  marketMode: 'select' | 'create';
  selectedMarketId: string;
  newMarketName: string;
  feedMappings: FeedMapping[];
  allowedActions: PolicyAction[];
  maxLtvDeltaBps: string;
  maxMarginDeltaBps: string;
  pauseDurationLimitMs: string;
  cooldownMs: string;
  daoAddress: string;
}

/** A normalized, validated policy draft body for `/api/policies/draft`. */
export interface PolicyDraftBody {
  marketId: string;
  marketType: MarketType;
  allowedActions: string[];
  maxLtvDeltaBps: number;
  maxMarginDeltaBps: number;
  pauseDurationLimitMs: number;
  cooldownMs: number;
  daoAddress: string;
  feedMappings: FeedMapping[];
}

/** Map of field key → human-readable validation message. (Req 4.9) */
export type WizardErrors = Partial<Record<WizardField, string>>;

export type WizardField =
  | 'marketType'
  | 'market'
  | 'feedMappings'
  | 'allowedActions'
  | BoundField
  | 'daoAddress';

export interface WizardValidation {
  /** Field → message for every invalid/missing value. Empty when valid. */
  errors: WizardErrors;
  /** True only when there are no errors. */
  valid: boolean;
  /** The normalized draft body, present only when {@link valid}. */
  draft: PolicyDraftBody | null;
}

/** A fresh wizard state with sensible, in-range defaults. */
export function initialWizardState(): WizardState {
  return {
    marketType: null,
    marketMode: 'select',
    selectedMarketId: '',
    newMarketName: '',
    feedMappings: [{ asset: '', feedId: '' }],
    allowedActions: [],
    maxLtvDeltaBps: '',
    maxMarginDeltaBps: '',
    pauseDurationLimitMs: '',
    cooldownMs: '',
    daoAddress: '',
  };
}

/** Parse a non-negative integer from a raw string, or null when invalid. */
export function parseIntegerStrict(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** A Sui address: 0x-prefixed hex, 1..64 hex digits. */
function isSuiAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value.trim());
}

function validateBound(raw: string, field: BoundField): { value?: number; error?: string } {
  const range = WIZARD_BOUNDS[field];
  if (raw.trim() === '') {
    return { error: `${field} is required` };
  }
  const value = parseIntegerStrict(raw);
  if (value === null) {
    return { error: `${field} must be a whole number` };
  }
  if (value < range.min || value > range.max) {
    return { error: `${field} must be between ${range.min} and ${range.max}` };
  }
  return { value };
}

/**
 * Validate the full wizard state, producing a precise per-field error map and,
 * when fully valid, a normalized draft body ready for submission. This is the
 * single gate that blocks submission of any missing or out-of-range value and
 * identifies the offending field. (Req 4.9)
 */
export function validateWizard(state: WizardState): WizardValidation {
  const errors: WizardErrors = {};

  // Step 1 — market type. (Req 4.2)
  if (!state.marketType) {
    errors.marketType = 'Select a market type';
  }

  // Step 2 — select or create a demo market. (Req 4.3)
  let marketId = '';
  if (state.marketMode === 'select') {
    if (state.selectedMarketId.trim() === '') {
      errors.market = 'Select an existing demo market';
    } else {
      marketId = state.selectedMarketId.trim();
    }
  } else {
    if (state.newMarketName.trim() === '') {
      errors.market = 'Enter a name for the new demo market';
    } else {
      marketId = state.newMarketName.trim();
    }
  }

  // Step 3 — feed mappings. Require at least one complete row; reject partial. (Req 4.4)
  const completeMappings = state.feedMappings.filter(
    (m) => m.asset.trim() !== '' && m.feedId.trim() !== '',
  );
  const partialMapping = state.feedMappings.some(
    (m) =>
      (m.asset.trim() !== '' && m.feedId.trim() === '') ||
      (m.asset.trim() === '' && m.feedId.trim() !== ''),
  );
  if (completeMappings.length === 0) {
    errors.feedMappings = 'Map at least one asset to a Sui Testnet price feed';
  } else if (partialMapping) {
    errors.feedMappings = 'Every asset must be mapped to a price feed';
  }

  // Step 4 — allowed actions + bounds. (Req 4.5)
  if (state.allowedActions.length === 0) {
    errors.allowedActions = 'Select at least one allowed action';
  }

  const ltv = validateBound(state.maxLtvDeltaBps, 'maxLtvDeltaBps');
  if (ltv.error) errors.maxLtvDeltaBps = ltv.error;
  const margin = validateBound(state.maxMarginDeltaBps, 'maxMarginDeltaBps');
  if (margin.error) errors.maxMarginDeltaBps = margin.error;
  const pause = validateBound(state.pauseDurationLimitMs, 'pauseDurationLimitMs');
  if (pause.error) errors.pauseDurationLimitMs = pause.error;
  const cooldown = validateBound(state.cooldownMs, 'cooldownMs');
  if (cooldown.error) errors.cooldownMs = cooldown.error;

  // Step 5 — DAO override address. (Req 4.6)
  if (state.daoAddress.trim() === '') {
    errors.daoAddress = 'Enter a DAO override address';
  } else if (!isSuiAddress(state.daoAddress)) {
    errors.daoAddress = 'DAO override address must be a 0x-prefixed Sui address';
  }

  const valid = Object.keys(errors).length === 0;

  const draft: PolicyDraftBody | null =
    valid && state.marketType
      ? {
          marketId,
          marketType: state.marketType,
          allowedActions: [...state.allowedActions],
          maxLtvDeltaBps: ltv.value as number,
          maxMarginDeltaBps: margin.value as number,
          pauseDurationLimitMs: pause.value as number,
          cooldownMs: cooldown.value as number,
          daoAddress: state.daoAddress.trim(),
          feedMappings: completeMappings.map((m) => ({
            asset: m.asset.trim(),
            feedId: m.feedId.trim(),
          })),
        }
      : null;

  return { errors, valid, draft };
}

/** Ordered wizard steps with their display labels. */
export const WIZARD_STEPS = [
  { id: 'market-type', label: 'Market Type' },
  { id: 'market-select', label: 'Demo Market' },
  { id: 'feed-mapping', label: 'Price Feeds' },
  { id: 'thresholds-bounds', label: 'Thresholds & Bounds' },
  { id: 'dao-address', label: 'DAO Override' },
  { id: 'review', label: 'Review' },
  { id: 'sign-deploy', label: 'Sign & Deploy' },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

/** Fields validated within each step, used to gate step-by-step navigation. */
export const STEP_FIELDS: Record<WizardStepId, WizardField[]> = {
  'market-type': ['marketType'],
  'market-select': ['market'],
  'feed-mapping': ['feedMappings'],
  'thresholds-bounds': [
    'allowedActions',
    'maxLtvDeltaBps',
    'maxMarginDeltaBps',
    'pauseDurationLimitMs',
    'cooldownMs',
  ],
  'dao-address': ['daoAddress'],
  review: [],
  'sign-deploy': [],
};

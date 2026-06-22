// Plain-English explanations for the jargon shown across the app.
//
// A single source of friendly definitions so any label (in the Simulation Lab,
// the dashboard, the override console, etc.) can show a "what is this?" hint.
// Look terms up with {@link explain}, which normalizes a displayed field name
// (lowercases it and strips any parenthetical suffix like "(live)").

/** Canonical term → one or two sentence, newbie-friendly explanation. */
export const GLOSSARY: Record<string, string> = {
  // --- Oracle / price feed ---
  'oracle price':
    'The current market price of the asset, reported by the Pyth price oracle (an on-chain price feed).',
  'oracle confidence':
    'How sure the oracle is about its price, given as a ± range. A wider range means the price is less certain.',
  'oracle freshness':
    'How long ago the oracle last updated. A stale (old) price is risky to act on.',
  'oracle age':
    'How long ago the oracle last updated. A stale (old) price is risky to act on.',

  // --- Market signals ---
  volatility:
    'How sharply the price has been swinging recently. Higher volatility means bigger, faster price moves.',
  'liquidity depth':
    'How much can be traded before the price moves a lot. Low liquidity means even small trades swing the price.',
  liquidity:
    'How much can be traded before the price moves a lot. Low liquidity means even small trades swing the price.',
  spread:
    'The gap between the best buy and sell price, in basis points (1 bps = 0.01%). A wide spread signals a thin, stressed market.',
  utilization:
    'The share of supplied funds currently borrowed (0–1). Near 1.0 means almost everything is lent out, which is risky.',
  exposure:
    'The total value currently at risk in the market — the outstanding borrowed amount.',

  // --- Risk engine outputs ---
  'risk score':
    "Sentinel's overall danger rating from 0 (calm) to 100 (critical), computed by a deterministic engine.",
  'risk band':
    'The severity category the score falls into — e.g. Normal, Warning, ParamAdjust, or EmergencyPause — which decides how Sentinel responds.',
  'recommended action':
    'The bounded safety action the engine suggests for this risk level, such as reducing max LTV or pausing new borrows.',
  confidence: 'How confident the engine is in this assessment, as a percentage.',

  // --- Proof / on-chain ---
  'transaction digest':
    'The unique ID of the on-chain Sui transaction — proof the action really executed on Sui Testnet.',
  'walrus blob id':
    'The address of the evidence file stored on Walrus (decentralized storage), so the decision can be audited later.',
  'evidence hash':
    "A cryptographic fingerprint of the evidence bundle. If the evidence changes, the hash changes — proving it wasn't tampered with.",

  // --- Impact strip ---
  'protected value':
    'The total value locked in the market that Sentinel is safeguarding.',
  'protected value (tvl)':
    'The total value locked in the market that Sentinel is safeguarding.',
  'exposure at risk':
    'The portion of value that could be lost if the market deteriorates.',
  'loss prevented':
    'The estimated value preserved because a mitigation is currently active.',

  // --- Policy bounds / governance ---
  'max ltv':
    'Maximum loan-to-value — how much can be borrowed against collateral. Lowering it makes the market safer.',
  'max ltv δ':
    'The largest max-LTV change the agent is allowed to make in one action.',
  'maintenance margin':
    'The minimum collateral cushion a position must keep before it can be liquidated.',
  cooldown:
    'The minimum wait time between autonomous actions, so the agent can\u2019t act too frequently.',
  'pause limit':
    'The maximum length of time the agent is allowed to pause borrowing.',
  guardiancap:
    'The on-chain capability that grants the agent its bounded permissions. Revoking it instantly stops all autonomous actions.',
  overridecap:
    'The on-chain capability that lets the DAO reverse actions, retune limits, or revoke the agent.',

  // --- Data-source labels ---
  'live oracle data': 'A real, current reading from the live price oracle.',
  'simulated scenario data':
    'Made-up inputs for this practice drill — not real market data.',
  'real testnet transaction': 'A genuine transaction executed on Sui Testnet.',
  'walrus evidence':
    'An audit record stored on Walrus decentralized storage.',

  // --- Override console ---
  'overridecap holder':
    'The DAO/governor address that holds the OverrideCap — the only party allowed to override the agent.',
  'max ltv delta':
    'The largest max-LTV change the agent is allowed to make in a single action.',
  'max margin delta':
    'The largest maintenance-margin change the agent is allowed to make in a single action.',
  'allowed actions':
    'The specific safety actions this agent is permitted to perform — nothing else is possible.',
  'risk score at action time':
    'The risk score (0–100) at the moment the agent took this action — the justification on record.',
  'last tx digest':
    'The ID of the most recent on-chain transaction for this market, verifiable on Sui Testnet.',
};

/** Plain-English help for each Override Console operation. */
export const OPERATION_HELP: Record<string, string> = {
  reverse_action:
    'Undo the agent\u2019s last action on-chain, restoring the market parameter to its prior value.',
  confirm_action:
    'Endorse the agent\u2019s action as correct, leaving it in place on the record.',
  revoke_agent:
    'Immediately and permanently strip the agent\u2019s GuardianCap, stopping all future autonomous actions.',
  update_thresholds:
    'Retune the policy limits (max LTV/margin deltas, pause limit, cooldown, risk thresholds).',
  unpause_market:
    'Lift a borrow pause the agent placed, re-opening the market for new borrows.',
  restore_ltv:
    'Restore the market\u2019s max LTV back to its value before the agent reduced it.',
};

/**
 * Look up a plain-English explanation for a displayed field/term. Normalizes
 * the input (lowercase, trim, strip a trailing parenthetical like "(live)") so
 * the same glossary serves every surface. Returns `undefined` when unknown.
 */
export function explain(term: string | null | undefined): string | undefined {
  if (!term) return undefined;
  const key = term
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '') // drop a trailing "(live)" / "(TVL)" suffix
    .trim();
  if (GLOSSARY[key]) return GLOSSARY[key];
  // Re-try keeping the parenthetical (e.g. "protected value (tvl)").
  return GLOSSARY[term.toLowerCase().trim()];
}

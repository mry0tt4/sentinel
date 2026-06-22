/**
 * Simulation_Lab scenario catalogue (Req 14.1).
 *
 * The Simulation_Lab drives the Risk_Engine through a fixed, server-defined set
 * of EXACTLY NINE predefined risk scenarios against the Demo_Market. This module
 * owns the scenario definitions only — the {@link ./simulationService.ts}
 * `SimulationService` consumes them, feeds each step's feature vector to the
 * Risk_Engine, and (when a threshold is crossed and a valid GuardianCap
 * authorizes it) triggers the real testnet action + Walrus evidence flow.
 *
 * Each scenario is a sequence of *input steps*. A step carries a partial
 * {@link FeatureVector} override; the service merges the steps cumulatively onto
 * {@link DEMO_MARKET_BASELINE} so the market state escalates from calm to the
 * scenario's terminal hazard condition. The ids match the canonical
 * `SIMULATOR_SCENARIOS` list validated by the action routes, so the registered
 * scenario set is identical to the ids the `/api/simulator/start` endpoint
 * accepts. (Req 14.1, 14.2)
 *
 * The terminal step of every *hazard* scenario is tuned to drive the
 * deterministic scoring engine (or, for oracle staleness, the fail-closed
 * stale-data escalation) past an action threshold so the action flow is
 * exercised. The `false-positive-recovery` scenario is the deliberate
 * exception: a transient spike that recovers to a calm state so NO autonomous
 * action is warranted — demonstrating the system does not act on a false
 * positive.
 */

import type { FeatureVector, RiskClass } from '../risk/types.js';

/** Fixed evaluation reference time so scenario scores are reproducible. */
export const SIMULATION_NOW_MS = 1_700_000_000_000;

/**
 * The Demo_Market's calm initial state. Every scenario starts here and resets
 * back to it (Req 14.5). Scores ~12 (Normal band) so no action is recommended
 * until a scenario escalates the relevant feature group(s).
 */
export const DEMO_MARKET_BASELINE: FeatureVector = Object.freeze({
  // Oracle — fresh, tight confidence, no divergence/peg.
  oraclePrice: 2.0,
  oracleConfidence: 0.002,
  oracleTimestampMs: SIMULATION_NOW_MS - 5_000,
  nowMs: SIMULATION_NOW_MS,
  freshnessThresholdMs: 60_000,

  // Volatility — quiet.
  priceChange1mPct: 0,
  priceChange5mPct: 0,
  priceChange15mPct: 0,
  realizedVolatilityPct: 1,

  // Liquidity — deep book, tight spread, balanced.
  liquidityDepth: 1_000_000,
  spreadBps: 5,
  imbalance: 0,

  // Exposure — moderate utilization and exposure, conservative LTV.
  utilization: 0.4,
  exposure: 2_000_000,
  currentMaxLtvBps: 7_500,

  // Governance — healthy, live policy, non-revoked guardian.
  borrowPaused: false,
  guardedMode: false,
  policyActive: true,
  guardianRevoked: false,
  priorActionsCount: 0,
  priorOverridesCount: 0,
  historicalEvidenceRefs: [],
});

/** One input step in a scenario: a label plus a cumulative feature override. */
export interface ScenarioStep {
  /** Human-readable label for the step (shown in the simulator UI). */
  label: string;
  /** Partial feature overrides merged cumulatively onto the prior step. */
  inputs: Partial<FeatureVector>;
}

/** A predefined Simulation_Lab scenario. */
export interface SimulationScenario {
  /** Canonical scenario id — matches `SIMULATOR_SCENARIOS`. */
  id: string;
  /** Short display title. */
  title: string;
  /** What the scenario demonstrates. */
  description: string;
  /** Risk classes the terminal step is expected to surface (documentation). */
  expectedClasses: RiskClass[];
  /**
   * Whether the terminal step is expected to cross an action threshold. The
   * `false-positive-recovery` scenario is the only one that recovers to calm
   * and therefore should NOT trigger an action.
   */
  crossesActionThreshold: boolean;
  /** The ordered input steps (step 0 is the calm baseline). */
  steps: ScenarioStep[];
}

/** Calm opening step shared by every scenario. */
const CALM_STEP: ScenarioStep = { label: 'calm market', inputs: {} };

/**
 * The nine scenarios, keyed by canonical id. Defined as an array (preserving
 * declaration order) and exposed as a frozen catalogue. (Req 14.1)
 */
export const SIMULATION_SCENARIOS: readonly SimulationScenario[] = Object.freeze([
  {
    id: 'sui-flash-crash',
    title: 'SUI flash crash',
    description: 'A sudden, severe SUI price collapse with evaporating liquidity.',
    expectedClasses: ['flash crash', 'liquidation cascade'],
    crossesActionThreshold: true,
    steps: [
      CALM_STEP,
      {
        label: 'initial dip',
        inputs: { priceChange1mPct: -6, priceChange5mPct: -9, realizedVolatilityPct: 12, spreadBps: 40 },
      },
      {
        label: 'flash crash',
        inputs: {
          oraclePrice: 1.3,
          oracleConfidence: 0.06,
          priceChange1mPct: -35,
          priceChange5mPct: -45,
          priceChange15mPct: -50,
          realizedVolatilityPct: 80,
          liquidityDepth: 60_000,
          spreadBps: 350,
          imbalance: 0.85,
          utilization: 0.9,
          exposure: 8_000_000,
        },
      },
    ],
  },
  {
    id: 'stablecoin-depeg',
    title: 'Stablecoin depeg',
    description: 'A pegged asset drifts well off its $1.00 peg under selling pressure.',
    expectedClasses: ['stablecoin depeg'],
    crossesActionThreshold: true,
    steps: [
      CALM_STEP,
      {
        label: 'peg wobble',
        inputs: { oraclePrice: 1.0, expectedPegPrice: 1.0, priceChange5mPct: -1, spreadBps: 30 },
      },
      {
        label: 'depeg',
        inputs: {
          oraclePrice: 0.9,
          expectedPegPrice: 1.0,
          oracleConfidence: 0.04,
          priceChange1mPct: -7,
          priceChange5mPct: -10,
          realizedVolatilityPct: 30,
          liquidityDepth: 120_000,
          spreadBps: 250,
          imbalance: 0.7,
        },
      },
    ],
  },
  {
    id: 'oracle-staleness',
    title: 'Oracle staleness',
    description: 'The oracle stops updating; the last reading ages past the freshness threshold.',
    expectedClasses: ['oracle staleness'],
    crossesActionThreshold: true,
    steps: [
      CALM_STEP,
      {
        label: 'feed slows',
        inputs: { oracleTimestampMs: SIMULATION_NOW_MS - 45_000 },
      },
      {
        label: 'feed stale',
        inputs: { oracleTimestampMs: SIMULATION_NOW_MS - 600_000 },
      },
    ],
  },
  {
    id: 'oracle-divergence',
    title: 'Oracle divergence',
    description: 'The oracle price diverges materially from an independent reference price.',
    expectedClasses: ['oracle divergence'],
    crossesActionThreshold: true,
    steps: [
      CALM_STEP,
      {
        label: 'minor divergence',
        inputs: { oraclePrice: 2.05, referencePrice: 2.0 },
      },
      {
        label: 'divergence',
        inputs: {
          oraclePrice: 2.5,
          referencePrice: 2.0,
          oracleConfidence: 0.07,
          priceChange5mPct: 12,
          realizedVolatilityPct: 25,
          liquidityDepth: 150_000,
          spreadBps: 220,
          imbalance: 0.6,
        },
      },
    ],
  },
  {
    id: 'liquidity-collapse',
    title: 'Liquidity collapse',
    description: 'Order-book depth evaporates and spreads blow out.',
    expectedClasses: ['liquidity collapse'],
    crossesActionThreshold: true,
    steps: [
      CALM_STEP,
      {
        label: 'thinning book',
        inputs: { liquidityDepth: 400_000, spreadBps: 60, imbalance: 0.4 },
      },
      {
        label: 'liquidity collapse',
        inputs: {
          liquidityDepth: 20_000,
          spreadBps: 500,
          imbalance: 0.95,
          oracleConfidence: 0.05,
          priceChange1mPct: -8,
          priceChange5mPct: -12,
          realizedVolatilityPct: 35,
        },
      },
    ],
  },
  {
    id: 'liquidation-cascade',
    title: 'Liquidation cascade',
    description: 'High utilization plus a sharp move triggers cascading liquidations.',
    expectedClasses: ['liquidation cascade', 'high utilization'],
    crossesActionThreshold: true,
    steps: [
      CALM_STEP,
      {
        label: 'utilization climbs',
        inputs: { utilization: 0.8, exposure: 6_000_000, priceChange5mPct: -4 },
      },
      {
        label: 'cascade',
        inputs: {
          utilization: 0.95,
          exposure: 9_000_000,
          priceChange1mPct: -15,
          priceChange5mPct: -25,
          realizedVolatilityPct: 50,
          oracleConfidence: 0.05,
          liquidityDepth: 150_000,
          spreadBps: 280,
          imbalance: 0.8,
        },
      },
    ],
  },
  {
    id: 'high-utilization-spike',
    title: 'High utilization spike',
    description: 'Borrow demand spikes, pushing utilization to near capacity.',
    expectedClasses: ['high utilization'],
    crossesActionThreshold: true,
    steps: [
      CALM_STEP,
      {
        label: 'demand rises',
        inputs: { utilization: 0.7, exposure: 5_000_000 },
      },
      {
        label: 'utilization spike',
        inputs: {
          utilization: 0.99,
          exposure: 9_500_000,
          oracleConfidence: 0.05,
          priceChange1mPct: 4,
          priceChange5mPct: 7,
          realizedVolatilityPct: 20,
          liquidityDepth: 250_000,
          spreadBps: 200,
          imbalance: 0.5,
        },
      },
    ],
  },
  {
    id: 'false-positive-recovery',
    title: 'False-positive recovery',
    description: 'A transient spike that recovers to calm — no autonomous action warranted.',
    expectedClasses: ['flash crash'],
    crossesActionThreshold: false,
    steps: [
      CALM_STEP,
      {
        label: 'transient spike',
        inputs: { priceChange1mPct: -5, priceChange5mPct: -6, realizedVolatilityPct: 3, spreadBps: 60 },
      },
      {
        label: 'recovery',
        inputs: {
          priceChange1mPct: 0,
          priceChange5mPct: 0,
          priceChange15mPct: 0,
          realizedVolatilityPct: 1,
          spreadBps: 6,
        },
      },
    ],
  },
  {
    id: 'guardian-revoked',
    title: 'Guardian revoked',
    description:
      'A severe market move crosses the action threshold while the GuardianCap is revoked, so the action is blocked.',
    expectedClasses: ['guardian revocation', 'flash crash'],
    crossesActionThreshold: true,
    steps: [
      CALM_STEP,
      {
        label: 'guardian revoked',
        inputs: { guardianRevoked: true },
      },
      {
        label: 'market move while revoked',
        inputs: {
          guardianRevoked: true,
          oraclePrice: 1.5,
          oracleConfidence: 0.06,
          priceChange1mPct: -28,
          priceChange5mPct: -38,
          realizedVolatilityPct: 65,
          liquidityDepth: 80_000,
          spreadBps: 320,
          imbalance: 0.8,
          utilization: 0.9,
          exposure: 8_000_000,
        },
      },
    ],
  },
]);

/** The set of registered scenario ids, in declaration order. (Req 14.1) */
export const SIMULATION_SCENARIO_IDS: readonly string[] = Object.freeze(
  SIMULATION_SCENARIOS.map((s) => s.id),
);

/** Look up a scenario by id, or `undefined` when unknown. */
export function getScenario(scenarioId: string): SimulationScenario | undefined {
  return SIMULATION_SCENARIOS.find((s) => s.id === scenarioId);
}

/**
 * Resolve the cumulative {@link FeatureVector} for a given step index by merging
 * step inputs `0..stepIndex` onto {@link DEMO_MARKET_BASELINE}. Throws on an
 * out-of-range index.
 */
export function featuresAtStep(scenario: SimulationScenario, stepIndex: number): FeatureVector {
  if (stepIndex < 0 || stepIndex >= scenario.steps.length) {
    throw new RangeError(
      `step index ${stepIndex} out of range for scenario "${scenario.id}" (0..${scenario.steps.length - 1})`,
    );
  }
  let features: FeatureVector = { ...DEMO_MARKET_BASELINE };
  for (let i = 0; i <= stepIndex; i += 1) {
    const step = scenario.steps[i];
    if (step) {
      features = { ...features, ...step.inputs };
    }
  }
  return features;
}

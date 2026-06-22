// Shared types + the data-source labeling model for the Simulation Lab (Req 14).
//
// The CORE correctness concern of the Simulation Lab frontend is data-source
// labeling (Req 14.6, 14.7): every data element rendered MUST carry EXACTLY ONE
// label drawn from a fixed four-element set, and simulated scenario data MUST
// NEVER be presented as live oracle data.
//
// To make that property mechanically checkable (the upcoming Property 23 test,
// task 18.3), the label is modeled explicitly as a `source` field on every
// rendered datum ({@link LabeledDatum}), and the data model is built only via
// the labeled builders below — each of which hard-codes the source for its
// category. There is no code path that derives a datum's label from anything
// other than its provenance, so a simulated value can never acquire the
// `live oracle data` label.
//
// These types mirror the camelCase DTOs the backend Simulation_Lab emits from
// `POST /api/simulator/start` (the `ScenarioRunResult` in
// `backend/src/simulation/simulationService.ts`). The frontend keeps its own
// copy so the island bundle stays self-contained.

// ---------------------------------------------------------------------------
// The data-source label set (Req 14.6).
// ---------------------------------------------------------------------------

/**
 * The four — and only four — data-source labels a rendered datum may carry.
 * Every element in the Simulation Lab is tagged with exactly one of these.
 * (Req 14.6)
 */
export const DATA_SOURCE_LABELS = [
  'live oracle data',
  'simulated scenario data',
  'real testnet transaction',
  'Walrus evidence',
] as const;

/** Exactly one of the four allowed data-source labels. (Req 14.6) */
export type DataSourceLabel = (typeof DATA_SOURCE_LABELS)[number];

/** Whether `value` is one of the four allowed data-source labels. */
export function isDataSourceLabel(value: unknown): value is DataSourceLabel {
  return (
    typeof value === 'string' && (DATA_SOURCE_LABELS as readonly string[]).includes(value)
  );
}

/**
 * A single rendered data element carrying EXACTLY ONE data-source label. Every
 * value the Simulation Lab displays flows through this shape, so the UI can
 * render the value alongside its provenance badge and the property test can
 * assert the one-of-four labeling invariant. (Req 14.6, 14.7)
 */
export interface LabeledDatum {
  /** Stable key for React lists / test selectors. */
  key: string;
  /** Human-readable field name (e.g. "Oracle price"). */
  field: string;
  /** Rendered value, pre-formatted to a string. */
  value: string;
  /** The single data-source label for this datum. (Req 14.6) */
  source: DataSourceLabel;
}

// ---------------------------------------------------------------------------
// Scenario catalogue (mirror of backend scenario ids/titles) (Req 14.1).
// ---------------------------------------------------------------------------

/** A scenario the picker can start. Mirrors the backend scenario metadata. */
export interface ScenarioOption {
  id: string;
  title: string;
  description: string;
}

/**
 * The nine predefined scenarios, in declaration order. The ids match the
 * backend `SIMULATOR_SCENARIOS` set validated by `POST /api/simulator/start`.
 * (Req 14.1)
 */
export const SCENARIO_OPTIONS: readonly ScenarioOption[] = Object.freeze([
  { id: 'sui-flash-crash', title: 'SUI flash crash', description: 'A sudden, severe SUI price collapse with evaporating liquidity.' },
  { id: 'stablecoin-depeg', title: 'Stablecoin depeg', description: 'A pegged asset drifts well off its $1.00 peg under selling pressure.' },
  { id: 'oracle-staleness', title: 'Oracle staleness', description: 'The oracle stops updating; the last reading ages past the freshness threshold.' },
  { id: 'oracle-divergence', title: 'Oracle divergence', description: 'The oracle price diverges materially from an independent reference price.' },
  { id: 'liquidity-collapse', title: 'Liquidity collapse', description: 'Order-book depth evaporates and spreads blow out.' },
  { id: 'liquidation-cascade', title: 'Liquidation cascade', description: 'High utilization plus a sharp move triggers cascading liquidations.' },
  { id: 'high-utilization-spike', title: 'High utilization spike', description: 'Borrow demand spikes, pushing utilization to near capacity.' },
  { id: 'false-positive-recovery', title: 'False-positive recovery', description: 'A transient spike that recovers to calm — no autonomous action warranted.' },
  { id: 'guardian-revoked', title: 'Guardian revoked', description: 'A severe move crosses the threshold while the GuardianCap is revoked, so the action is blocked.' },
]);

/** The set of registered scenario ids, in declaration order. (Req 14.1) */
export const SCENARIO_IDS: readonly string[] = Object.freeze(SCENARIO_OPTIONS.map((s) => s.id));

// ---------------------------------------------------------------------------
// Backend run-result mirror (subset of `ScenarioRunResult`).
// ---------------------------------------------------------------------------

/** The feature vector evaluated for a step — all values are simulated inputs. */
export type SimFeatureVector = Record<string, unknown>;

/** The Risk_Engine result for a step (derived from simulated inputs). (Req 14.2) */
export interface SimStepRisk {
  riskScore: number;
  band: string;
  recommendedAction: string | null;
  refusalReason?: string | null;
  classes: string[];
  confidence: number;
}

/** Guardian authorization decision surfaced once a threshold is crossed. */
export interface SimGuardianAuthorization {
  authorized: boolean;
  revoked: boolean;
  expired: boolean;
  reason?: string | null;
}

/** Outcome of attempting (or blocking) the action at a threshold-crossing step. */
export interface SimActionOutcome {
  attempted: boolean;
  blocked: boolean;
  blockedReason?: string | null;
  success: boolean;
  txDigest?: string | null;
  blobId?: string | null;
  evidenceHash?: string | null;
  stage?: string | null;
  failureReason?: string | null;
}

/** The result of evaluating a single scenario step. */
export interface SimStepOutcome {
  scenarioId: string;
  stepIndex: number;
  stepLabel: string;
  totalSteps: number;
  features: SimFeatureVector;
  risk: SimStepRisk;
  thresholdCrossed: boolean;
  guardian?: SimGuardianAuthorization;
  action?: SimActionOutcome;
}

/** Lifecycle status of a scenario run. */
export type SimRunStatus =
  | 'running'
  | 'completed'
  | 'action_executed'
  | 'action_blocked'
  | 'action_failed';

/** The full result of starting (running) a scenario. (mirror of `ScenarioRunResult`) */
export interface SimRunResult {
  scenarioId: string;
  title: string;
  status: SimRunStatus;
  steps: SimStepOutcome[];
  action?: SimActionOutcome;
}

/**
 * A genuinely-live oracle reading the simulator may surface alongside the
 * scenario (independent of simulated inputs). The ONLY source of the
 * `live oracle data` label. Absent during a pure simulation. (Req 14.6)
 */
export interface LiveOracleReading {
  price: number;
  confidence: number;
  timestampMs: number;
}

// ---------------------------------------------------------------------------
// Labeled-data builders — each hard-codes its category's data-source label.
// ---------------------------------------------------------------------------

/** The simulated feature-vector fields surfaced in the runner, in order. */
const SIMULATED_FEATURE_FIELDS: readonly { key: string; field: string; suffix?: string }[] = [
  { key: 'oraclePrice', field: 'Oracle price' },
  { key: 'oracleConfidence', field: 'Oracle confidence' },
  { key: 'realizedVolatilityPct', field: 'Volatility', suffix: '%' },
  { key: 'liquidityDepth', field: 'Liquidity depth' },
  { key: 'spreadBps', field: 'Spread', suffix: ' bps' },
  { key: 'utilization', field: 'Utilization' },
  { key: 'exposure', field: 'Exposure' },
];

function fmtNumber(value: unknown, suffix = ''): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  const rounded = Number.isInteger(value) ? value : Number(value.toFixed(4));
  return `${rounded}${suffix}`;
}

/**
 * Build the labeled data elements for a genuinely-live oracle reading. The only
 * builder that emits the `live oracle data` label. (Req 14.6)
 */
export function buildLiveOracleData(reading: LiveOracleReading | null | undefined): LabeledDatum[] {
  if (!reading) return [];
  return [
    { key: 'live-oracle-price', field: 'Oracle price (live)', value: fmtNumber(reading.price), source: 'live oracle data' },
    {
      key: 'live-oracle-confidence',
      field: 'Oracle confidence (live)',
      value: fmtNumber(reading.confidence),
      source: 'live oracle data',
    },
  ];
}

/**
 * Build the labeled data elements for a simulated scenario step: the simulated
 * feature inputs plus the Risk_Engine outputs they produced. EVERY datum here
 * is labeled `simulated scenario data` — never `live oracle data` — satisfying
 * Req 14.7. (Req 14.2, 14.6, 14.7)
 */
export function buildSimulatedStepData(step: SimStepOutcome | null | undefined): LabeledDatum[] {
  if (!step) return [];
  const data: LabeledDatum[] = [];

  for (const spec of SIMULATED_FEATURE_FIELDS) {
    const raw = step.features[spec.key];
    if (raw === undefined || raw === null) continue;
    data.push({
      key: `sim-feature-${spec.key}`,
      field: spec.field,
      value: fmtNumber(raw, spec.suffix),
      source: 'simulated scenario data',
    });
  }

  // Risk_Engine outputs derived from the simulated inputs (also simulated).
  data.push(
    { key: 'sim-risk-score', field: 'Risk score', value: String(step.risk.riskScore), source: 'simulated scenario data' },
    { key: 'sim-risk-band', field: 'Risk band', value: step.risk.band, source: 'simulated scenario data' },
    {
      key: 'sim-recommended-action',
      field: 'Recommended action',
      value: step.risk.recommendedAction ?? 'none',
      source: 'simulated scenario data',
    },
    {
      key: 'sim-confidence',
      field: 'Confidence',
      value: String(step.risk.confidence),
      source: 'simulated scenario data',
    },
  );

  return data;
}

/**
 * Build the labeled data elements for the outcome of a real testnet action: the
 * transaction digest is labeled `real testnet transaction`; the Walrus blob id
 * and evidence hash are labeled `Walrus evidence`. (Req 14.6)
 */
export function buildActionOutcomeData(action: SimActionOutcome | null | undefined): LabeledDatum[] {
  if (!action) return [];
  const data: LabeledDatum[] = [];
  if (action.txDigest) {
    data.push({
      key: 'action-tx-digest',
      field: 'Transaction digest',
      value: action.txDigest,
      source: 'real testnet transaction',
    });
  }
  if (action.blobId) {
    data.push({
      key: 'action-blob-id',
      field: 'Walrus blob id',
      value: action.blobId,
      source: 'Walrus evidence',
    });
  }
  if (action.evidenceHash) {
    data.push({
      key: 'action-evidence-hash',
      field: 'Evidence hash',
      value: action.evidenceHash,
      source: 'Walrus evidence',
    });
  }
  return data;
}

/**
 * Assemble the full labeled-data set the runner displays for the current state.
 * Every returned datum carries exactly one of the four data-source labels, and
 * — because simulated values only ever pass through {@link buildSimulatedStepData}
 * — no simulated datum is ever labeled `live oracle data`. (Req 14.6, 14.7)
 */
export function buildLabeledData(input: {
  liveOracle?: LiveOracleReading | null;
  latestStep?: SimStepOutcome | null;
  action?: SimActionOutcome | null;
}): LabeledDatum[] {
  return [
    ...buildLiveOracleData(input.liveOracle),
    ...buildSimulatedStepData(input.latestStep),
    ...buildActionOutcomeData(input.action),
  ];
}

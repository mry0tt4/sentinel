import { useCallback, useEffect, useState } from 'react';

import { SUI_TESTNET_LABEL } from '../../lib/network';
import { useRiskSocket, type RiskSocketClient } from '../../lib/riskSocket';
import type { ServerMessage } from '../../lib/dashboardTypes';
import type { OverrideOutcome, OverrideRequestBody, SimulatorApi } from '../../lib/simulatorApi';
import {
  buildLabeledData,
  SCENARIO_OPTIONS,
  type LiveOracleReading,
  type SimActionOutcome,
  type SimRunResult,
  type SimStepOutcome,
} from '../../lib/simulatorTypes';
import { NetworkBadge } from '../NetworkBadge';
import { AgentTrace, type AgentTraceAction } from '../dashboard/AgentTrace';
import type { MarketRiskView, RiskIndicators } from '../../lib/dashboardTypes';
import { OverrideControls } from './OverrideControls';
import { ScenarioPicker } from './ScenarioPicker';
import { SimulatorRunner } from './SimulatorRunner';

/**
 * Context required to build a structured (server-controlled) override request.
 * Injected so the simulator can wire the Override_Console to a configured
 * Demo_Market without baking object ids into the bundle. (Req 11.4, 16.4)
 */
export interface OverrideContextConfig {
  policyId: string;
  marketId: string;
  daoAddress: string;
  overrideCapObjectId: string;
  policyObjectId: string;
  marketStateObjectId?: string;
  /** Agent's GuardianCap object id (needed to revoke the guardian). */
  guardianCapObjectId?: string;
  agentSigner: string;
}

export interface SimulatorViewProps {
  /** Injectable backend client. */
  api: SimulatorApi;
  /** Injectable live socket client; null disables live updates. (Req 14.2) */
  socketClient?: RiskSocketClient | null;
  /** Network reported by the connected wallet (for the badge). */
  walletNetwork?: string | null;
  /** Whether a testnet wallet is connected + able to sign overrides. (Req 2.4) */
  canSign?: boolean;
  /** Demo_Market id to subscribe for live updates + override record context. */
  demoMarketId?: string | null;
  /** Context used to build override requests; absent disables overrides. */
  overrideContext?: OverrideContextConfig;
  /** Optional genuinely-live oracle reading (labeled `live oracle data`). (Req 14.6) */
  liveOracle?: LiveOracleReading | null;
  /**
   * Interval (ms) between displayed input steps. Must be < 2000 so the score
   * updates within 2 seconds of each input step. (Req 14.2)
   */
  stepIntervalMs?: number;
}

const DEFAULT_STEP_INTERVAL_MS = 850;

/** A single animation tick — a sub-step between scenario keyframes. */
interface Tick {
  score: number;
  band: string;
  features: Record<string, unknown>;
  stepIndex: number;
}

/** Score → band, matching the deterministic engine's cutoffs. */
function bandForScore(s: number): string {
  if (s <= 39) return 'Normal';
  if (s <= 59) return 'Warning';
  if (s <= 74) return 'Guarded';
  if (s <= 89) return 'ParamAdjust';
  return 'EmergencyPause';
}

/** Deterministic pseudo-noise in [-1, 1] (stable, no hydration surprises). */
function noise(a: number, b: number): number {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const STATIC_KEYS = new Set([
  'oracleTimestampMs',
  'nowMs',
  'freshnessThresholdMs',
  'currentMaxLtvBps',
  'borrowPaused',
  'guardedMode',
  'policyActive',
  'guardianRevoked',
]);

/** Interpolate the numeric fields of two feature vectors, with optional jitter. */
function lerpFeatures(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  t: number,
  jitter: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...b };
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const av = (a as Record<string, unknown>)?.[k];
    const bv = (b as Record<string, unknown>)?.[k];
    if (
      typeof av === 'number' &&
      typeof bv === 'number' &&
      Number.isFinite(av) &&
      Number.isFinite(bv)
    ) {
      let v = lerp(av, bv, t);
      if (jitter > 0 && !STATIC_KEYS.has(k)) {
        v *= 1 + noise(Math.round(t * 1000), k.length) * 0.012 * jitter;
      }
      out[k] = v;
    } else if (t < 0.5 && av !== undefined) {
      out[k] = av;
    }
  }
  return out;
}

const SUBSTEPS = 8; // interpolated ticks per scenario segment
const SETTLE_TICKS = 6; // trailing ticks so the market keeps "breathing"

/**
 * Expand a scenario's coarse keyframe steps into a dense, continuously-moving
 * tick series — so the score and chart update every ~second like a real market
 * feed, rather than jumping a handful of times. Keyframes land on their exact
 * engine scores; interpolated ticks carry small jitter.
 */
function buildTicks(run: SimRunResult | null): Tick[] {
  if (!run || run.steps.length === 0) return [];
  const steps = run.steps;
  const scoreOf = (s: SimStepOutcome) => s.risk.riskScore;
  const featOf = (s: SimStepOutcome) => (s.features as Record<string, unknown>) ?? {};

  if (steps.length === 1) {
    const s = steps[0] as SimStepOutcome;
    return [{ score: scoreOf(s), band: s.risk.band, features: featOf(s), stepIndex: 0 }];
  }

  const ticks: Tick[] = [];
  const first = steps[0] as SimStepOutcome;
  ticks.push({
    score: scoreOf(first),
    band: first.risk.band,
    features: featOf(first),
    stepIndex: 0,
  });

  for (let i = 0; i < steps.length - 1; i += 1) {
    const a = steps[i] as SimStepOutcome;
    const b = steps[i + 1] as SimStepOutcome;
    for (let j = 1; j <= SUBSTEPS; j += 1) {
      const t = j / SUBSTEPS;
      const isKey = j === SUBSTEPS;
      const amp = isKey ? 0 : 1.8;
      let score = lerp(scoreOf(a), scoreOf(b), t) + noise(i + 1, j) * amp;
      score = Math.max(0, Math.min(100, Math.round(score)));
      ticks.push({
        score,
        band: isKey ? b.risk.band : bandForScore(score),
        features: lerpFeatures(featOf(a), featOf(b), t, isKey ? 0 : 1),
        stepIndex: isKey ? i + 1 : i,
      });
    }
  }

  const last = steps[steps.length - 1] as SimStepOutcome;
  for (let k = 1; k <= SETTLE_TICKS; k += 1) {
    let score = scoreOf(last) + noise(99, k) * 1.3;
    score = Math.max(0, Math.min(100, Math.round(score)));
    ticks.push({
      score,
      band: bandForScore(score),
      features: lerpFeatures(featOf(last), featOf(last), 1, 1),
      stepIndex: steps.length - 1,
    });
  }
  return ticks;
}

/** A complete fallback feature vector so an override can build evidence even
 *  before a scenario has been run (mirrors the calm demo baseline). */
const FALLBACK_FEATURES: Record<string, unknown> = {
  oraclePrice: 2.0,
  oracleConfidence: 0.002,
  oracleTimestampMs: 0,
  nowMs: 0,
  freshnessThresholdMs: 30_000,
  referencePrice: undefined,
  expectedPegPrice: undefined,
  priceChange1mPct: 0,
  priceChange5mPct: 0,
  priceChange15mPct: 0,
  realizedVolatilityPct: 6,
  liquidityDepth: 1_200_000,
  spreadBps: 12,
  imbalance: 0,
  utilization: 0.62,
  exposure: 4_200_000,
  currentMaxLtvBps: 6500,
  borrowPaused: true,
  guardedMode: false,
  policyActive: true,
  guardianRevoked: false,
  priorActionsCount: 0,
  priorOverridesCount: 0,
  historicalEvidenceRefs: [],
};

/**
 * Simulation Lab view. Renders the scenario picker, the runner (which shows the
 * simulated Risk_Score updating within 2s of each input step), and the override
 * controls. Every displayed datum carries exactly one data-source label, and
 * simulated data is never labeled as live oracle data. (Req 14.2, 14.4, 14.6, 14.7)
 *
 * Split out from the provider-wrapped {@link Simulator} island so it can be
 * tested with injected fakes (no live backend / socket / wallet).
 */
export function SimulatorView({
  api,
  socketClient = null,
  walletNetwork = null,
  canSign = false,
  demoMarketId = null,
  overrideContext,
  liveOracle = null,
  stepIntervalMs = DEFAULT_STEP_INTERVAL_MS,
}: SimulatorViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<SimRunResult | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [tickIndex, setTickIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [overrideSubmitting, setOverrideSubmitting] = useState(false);
  const [overrideOutcome, setOverrideOutcome] = useState<OverrideOutcome | null>(null);

  // Build the dense tick series whenever a new run arrives.
  useEffect(() => {
    const t = buildTicks(run);
    setTicks(t);
    setTickIndex(0);
    setRunning(t.length > 1);
  }, [run]);

  // Advance the tick on a sub-2s timer so the score + chart move continuously,
  // like a live market feed, instead of jumping a few times. (Req 14.2)
  useEffect(() => {
    if (ticks.length <= 1 || tickIndex >= ticks.length - 1) {
      if (running) setRunning(false);
      return undefined;
    }
    const id = setTimeout(() => {
      setTickIndex((i) => Math.min(i + 1, ticks.length - 1));
    }, stepIntervalMs);
    return () => clearTimeout(id);
  }, [ticks, tickIndex, stepIntervalMs, running]);

  // The simulator no longer overrides its score from the live market socket —
  // the lab must always show the SIMULATED score (the live market is on the
  // Dashboard). The subscription is kept but intentionally ignores messages.
  const handleMessage = useCallback((_message: ServerMessage) => {
    /* simulation score is self-contained; ignore live market pushes */
  }, []);
  useRiskSocket(socketClient, demoMarketId, handleMessage);

  const handleStart = useCallback(async () => {
    if (!selectedId) return;
    setStarting(true);
    setRunning(true);
    setError(null);
    setOverrideOutcome(null);
    setRun(null);
    setTickIndex(0);
    try {
      const result = await api.start(selectedId);
      if (!result.ok) {
        setError(result.message);
        setRunning(false);
        return;
      }
      setRun(result.result);
    } finally {
      setStarting(false);
    }
  }, [api, selectedId]);

  const handleReset = useCallback(async () => {
    setRunning(false);
    setError(null);
    setOverrideOutcome(null);
    setRun(null);
    setTicks([]);
    setTickIndex(0);
    const result = await api.reset();
    if (!result.ok) setError(result.message ?? 'Failed to reset the simulator.');
  }, [api]);

  const handleOverride = useCallback(
    async (operation: string, reason: string) => {
      if (!overrideContext) return;
      setOverrideSubmitting(true);
      setOverrideOutcome(null);

      // Build the operation-specific request fields. Each DAO operation needs a
      // different set of on-chain references / parameters.
      const request: Record<string, unknown> = {
        operation,
        reason,
        overrideCapObjectId: overrideContext.overrideCapObjectId,
        policyObjectId: overrideContext.policyObjectId,
      };
      if (operation === 'unpause_market') {
        request.marketStateObjectId = overrideContext.marketStateObjectId;
      } else if (operation === 'revoke_guardian') {
        request.guardianCapObjectId = overrideContext.guardianCapObjectId;
      } else if (operation === 'update_thresholds') {
        // Retune to the demo policy's standing bounds (cooldown 0 so the agent
        // can keep firing in the lab). These are the values the policy holds.
        request.newMaxLtvDeltaBps = 2000;
        request.newMaxMarginDeltaBps = 2000;
        request.newPauseDurationLimitMs = 604_800_000;
        request.newCooldownMs = 0;
        request.newRiskThresholds = [40, 60, 75, 90];
      }

      const body: OverrideRequestBody = {
        request: request as OverrideRequestBody['request'],
        evaluation: ((): Record<string, unknown> => {
          const activeStepIndex = ticks[tickIndex]?.stepIndex ?? 0;
          const step = run?.steps[activeStepIndex] ?? null;
          const risk = step?.risk;
          return {
            marketId: overrideContext.marketId,
            riskScore: risk?.riskScore ?? 0,
            band: risk?.band ?? 'Normal',
            classes: risk?.classes ?? [],
            recommendedAction: risk?.recommendedAction ?? null,
            refusalReason: risk?.refusalReason ?? null,
            confidence: risk?.confidence ?? 0,
            explanation: '',
            ruleOutputs: [],
            featureVector: (step?.features as Record<string, unknown>) ?? FALLBACK_FEATURES,
            modelVersion: 'sentinel-sim',
            promptConfigVersion: 'sentinel-sim',
          };
        })(),
        actionContext: {
          policyId: overrideContext.policyId,
          agentSigner: overrideContext.agentSigner,
          dataSource: 'simulated',
          marketId: overrideContext.marketId,
          scenarioId: selectedId ?? '',
          priorActionIds: [],
          timestampMs: Date.now(),
        },
        actionLogId: `${selectedId ?? 'scenario'}:override`,
        record: {
          policyId: overrideContext.policyId,
          marketId: overrideContext.marketId,
          daoAddress: overrideContext.daoAddress,
        },
      };
      try {
        const outcome = await api.override(body);
        setOverrideOutcome(outcome);
      } catch (err) {
        setOverrideOutcome({
          ok: false,
          message: err instanceof Error ? err.message : 'The override request failed.',
        });
      } finally {
        setOverrideSubmitting(false);
      }
    },
    [api, overrideContext, run, ticks, tickIndex, selectedId],
  );

  // Derive the displayed state from the current tick (continuous animation).
  const totalSteps = run?.steps.length ?? 0;
  const currentTick: Tick | null = ticks[tickIndex] ?? null;
  const activeStepIndex = currentTick?.stepIndex ?? 0;
  const baseStep: SimStepOutcome | null = run?.steps[activeStepIndex] ?? null;
  const atClimax = totalSteps > 0 && activeStepIndex >= totalSteps - 1;

  const displayedStep: SimStepOutcome | null = baseStep
    ? {
        ...baseStep,
        features: currentTick?.features ?? (baseStep.features as Record<string, unknown>),
        risk: {
          ...baseStep.risk,
          riskScore: currentTick?.score ?? baseStep.risk.riskScore,
          band: currentTick?.band ?? baseStep.risk.band,
        },
      }
    : null;

  // The bounded action only surfaces once the run reaches its climax keyframe.
  const action: SimActionOutcome | null = atClimax
    ? (baseStep?.action ?? run?.action ?? null)
    : (baseStep?.action ?? null);

  const labeledData = buildLabeledData({
    liveOracle,
    latestStep: displayedStep,
    action,
  });

  const selectedScenario = SCENARIO_OPTIONS.find((s) => s.id === selectedId) ?? null;

  // The score trajectory revealed so far drives the live timeline chart.
  const scoreSeries = ticks.slice(0, tickIndex + 1).map((tk) => ({
    score: tk.score,
    band: tk.band,
    label: run?.steps[tk.stepIndex]?.stepLabel ?? '',
  }));

  // Adapt the simulated step + action into the Agent pipeline trace shape so
  // the lab shows the same observe → score → decide → evidence → submit →
  // govern flow as the dashboard, reflecting THIS scenario's live state.
  const agentRisk: MarketRiskView | null = displayedStep
    ? {
        marketId: overrideContext?.marketId ?? demoMarketId ?? 'sim',
        status: null,
        riskScore: displayedStep.risk.riskScore,
        band: displayedStep.risk.band,
        classes: displayedStep.risk.classes ?? [],
        confidence: displayedStep.risk.confidence ?? null,
        recommendedAction: displayedStep.risk.recommendedAction ?? null,
        indicators: (displayedStep.features as RiskIndicators) ?? null,
        sources: {
          network: 'sui:testnet',
          oracle: { protocol: 'Pyth', market: 'SUI/USD', feedId: '' },
          liquidity: { protocol: 'DeepBook', market: 'SUI/USDC', pool: '' },
          marketState: overrideContext?.marketStateObjectId ?? '',
          evidence: 'Walrus',
        },
      }
    : null;
  const agentAction: AgentTraceAction | null =
    action && action.attempted && !action.blocked && action.success
      ? {
          actionType: displayedStep?.risk.recommendedAction ?? null,
          riskScore: displayedStep?.risk.riskScore ?? null,
          txDigest: action.txDigest ?? null,
          walrusBlobId: action.blobId ?? null,
          verifiedTestnet: Boolean(action.txDigest) && action.success,
        }
      : null;

  return (
    <section className="simulator" data-testid="simulator">
      <header className="simulator__header">
        <span className="network-badge network-badge--ok" data-testid="testnet-badge">
          {SUI_TESTNET_LABEL}
        </span>
        <NetworkBadge network={walletNetwork} />
      </header>

      <div className="simulator__intro" data-testid="simulator-intro">
        <h3 className="simulator__intro-title">What is the Simulation Lab?</h3>
        <p className="simulator__intro-lede">
          A safe practice arena for watching Sentinel react to a market crisis — without waiting for
          a real one. Pick one of nine market-stress scenarios and it feeds that scenario&apos;s
          inputs into the <strong>same deterministic risk engine</strong> that runs in production.
          As the scenario escalates, the risk score climbs; when it crosses a threshold, Sentinel
          executes a <strong>real, bounded safety action on Sui Testnet</strong> and stores
          tamper-proof evidence on Walrus.
        </p>
        <ol className="simulator__intro-steps">
          <li>
            <span>1</span> Pick a scenario &amp; press Start
          </li>
          <li>
            <span>2</span> Watch the risk score &amp; indicators update
          </li>
          <li>
            <span>3</span> See the bounded on-chain action + tx digest
          </li>
          <li>
            <span>4</span> Verify the Walrus evidence trail
          </li>
        </ol>
        <p className="simulator__intro-note">
          Every value is tagged with its data source, so simulated scenario inputs are never shown
          as live oracle data. Hover any <span aria-hidden="true">ⓘ</span> for a plain-English
          explanation.
        </p>
      </div>

      {error ? (
        <p className="simulator__error" role="alert" data-testid="simulator-error">
          {error}
        </p>
      ) : null}

      <div className="simulator__layout">
        <aside className="simulator__sidebar">
          <ScenarioPicker
            selectedId={selectedId}
            running={running}
            onSelect={setSelectedId}
            onStart={handleStart}
            onReset={handleReset}
          />
        </aside>

        <div className="simulator__main">
          <h3 className="simulator__main-head" data-testid="simulator-main-head">
            {selectedScenario ? selectedScenario.title : 'Live response'}
          </h3>
          <SimulatorRunner
            scenarioTitle={run?.title ?? null}
            currentStep={displayedStep}
            displayStepNumber={activeStepIndex + 1}
            totalSteps={totalSteps}
            labeledData={labeledData}
            action={action}
            guardian={baseStep?.guardian ?? null}
            selectedScenario={selectedScenario}
            scoreSeries={scoreSeries}
            features={(displayedStep?.features as Record<string, unknown>) ?? null}
            loading={starting}
            // A successful autonomous action is submitted only through the
            // network-gated executor (testnet-only), so a present digest on a
            // successful action is a verified Sui Testnet transaction. (Req 1.9)
            txDigestVerifiedTestnet={action?.success === true && Boolean(action?.txDigest)}
          />

          {run ? <AgentTrace risk={agentRisk} lastAction={agentAction} /> : null}

          <OverrideControls
            canSign={canSign && overrideContext !== undefined}
            submitting={overrideSubmitting}
            outcome={overrideOutcome}
            txDigestVerifiedTestnet={
              overrideOutcome?.success === true && Boolean(overrideOutcome?.txDigest)
            }
            onSubmit={handleOverride}
          />
        </div>
      </div>
    </section>
  );
}

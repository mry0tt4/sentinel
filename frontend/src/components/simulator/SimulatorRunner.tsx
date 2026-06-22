import type {
  LabeledDatum,
  SimActionOutcome,
  SimGuardianAuthorization,
  SimStepOutcome,
} from '../../lib/simulatorTypes';
import { explainScore, scoreHeadline } from '../../lib/scoreExplain';
import { TxDigestDisplay } from '../TxDigestDisplay';
import { RiskScoreGauge } from '../dashboard/RiskScoreGauge';
import { LabeledDatumRow } from './DataSourceBadge';

/** Plain-English meaning of each risk band (what Sentinel does at that level). */
const BAND_MEANING: Record<string, string> = {
  Normal: 'Healthy — monitoring only, no action needed.',
  Warning: 'Elevated — watching closely; still within safe limits.',
  Guarded: 'Stressed — enter guarded mode to limit new risk-taking.',
  ParamAdjust: 'High — adjust parameters (reduce max-LTV) to protect the market.',
  EmergencyPause: 'Critical — pause new borrows immediately to stop the bleed.',
};

const BAND_COLOR: Record<string, string> = {
  Normal: '#059669',
  Warning: '#d97706',
  Guarded: '#ea580c',
  ParamAdjust: '#f97316',
  EmergencyPause: '#dc2626',
};

/** One point on the live risk-score timeline. */
export interface ScorePoint {
  score: number;
  band: string;
  label: string;
}

export interface SimulatorRunnerProps {
  /** Title of the running scenario, or null when idle. */
  scenarioTitle: string | null;
  /** The step currently displayed (drives the score + simulated data). */
  currentStep: SimStepOutcome | null;
  /** 1-based index of the displayed step (for the progress readout). */
  displayStepNumber: number;
  /** Total steps in the running scenario. */
  totalSteps: number;
  /** The fully-labeled data set for the current state. (Req 14.6) */
  labeledData: LabeledDatum[];
  /** The climax action outcome, when a threshold has been crossed. */
  action: SimActionOutcome | null;
  /** Guardian authorization decision at the climax step, if any. (Req 14.8) */
  guardian: SimGuardianAuthorization | null;
  /**
   * Whether the latest action's tx digest has been verified as testnet by the
   * backend Network_Guard. Fail-closed: defaults to false. (Req 1.9)
   */
  txDigestVerifiedTestnet: boolean;
  /** The selected scenario's metadata, shown in the idle state before a run. */
  selectedScenario?: { title: string; description: string } | null;
  /** The risk-score trajectory revealed so far (drives the live chart). */
  scoreSeries?: ScorePoint[];
  /** The current step's feature vector (drives the "why this score" panel). */
  features?: Record<string, unknown> | null;
  /** True while the scenario is being requested from the backend (pre-run). */
  loading?: boolean;
}

const BAND_COLORS: Record<string, string> = {
  Normal: '#059669',
  Warning: '#d97706',
  Guarded: '#ea580c',
  ParamAdjust: '#f97316',
  EmergencyPause: '#dc2626',
};

/** A live risk-score timeline: line over steps with band-threshold guides. */
function RiskTimeline({ series }: { series: ScorePoint[] }) {
  const W = 520;
  const H = 130;
  const padB = 16;
  const yOf = (s: number) => H - padB - (Math.max(0, Math.min(100, s)) / 100) * (H - padB - 6);
  const xOf = (i: number, n: number) => (n <= 1 ? W : (i / (n - 1)) * W);
  const n = series.length;
  const last = series[n - 1];
  const lineColor = last ? (BAND_COLORS[last.band] ?? '#6d5dfc') : '#6d5dfc';
  const path =
    n >= 1
      ? series
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i, n).toFixed(1)},${yOf(p.score).toFixed(1)}`)
          .join(' ')
      : '';
  // Band threshold guides (Normal<40, Warning<60, Guarded<75, ParamAdjust<90).
  const guides = [40, 60, 75, 90];
  return (
    <svg
      className="sim-timeline"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {guides.map((g) => (
        <line
          key={g}
          x1={0}
          y1={yOf(g)}
          x2={W}
          y2={yOf(g)}
          stroke="var(--border)"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
      ))}
      {n >= 2 ? (
        <path
          d={`${path} L${xOf(n - 1, n)},${H - padB} L0,${H - padB} Z`}
          fill={lineColor}
          opacity="0.08"
        />
      ) : null}
      {n >= 2 ? (
        <path d={path} fill="none" stroke={lineColor} strokeWidth="2.5" strokeLinejoin="round" />
      ) : null}
      {last ? <circle cx={xOf(n - 1, n)} cy={yOf(last.score)} r="3.5" fill={lineColor} /> : null}
    </svg>
  );
}

/**
 * The scenario runner. Displays the current simulated Risk_Score (updated within
 * 2 seconds of each input step by the parent view, Req 14.2) and every data
 * element with its single data-source label (Req 14.6, 14.7). When a threshold
 * is crossed it surfaces the action outcome: a blocked indication when the
 * guardian is not authorized (Req 14.8), or the resulting testnet tx digest
 * (guarded by {@link TxDigestDisplay}) and Walrus evidence on success.
 */
export function SimulatorRunner({
  scenarioTitle,
  currentStep,
  displayStepNumber,
  totalSteps,
  labeledData,
  action,
  guardian,
  txDigestVerifiedTestnet,
  selectedScenario = null,
  scoreSeries = [],
  features = null,
  loading = false,
}: SimulatorRunnerProps) {
  if (!scenarioTitle || !currentStep) {
    return (
      <section className="simulator-runner simulator-runner--idle" data-testid="simulator-runner">
        {loading ? (
          <div
            className="sim-loading"
            data-testid="runner-loading"
            role="status"
            aria-live="polite"
          >
            <span className="sim-loading__spinner" aria-hidden="true" />
            <span className="sim-loading__title">Starting scenario…</span>
            <span className="sim-loading__sub">
              Feeding the scenario into the risk engine and spinning up the live feed.
            </span>
          </div>
        ) : selectedScenario ? (
          <div className="runner-scenario" data-testid="runner-scenario-info">
            <p className="runner-scenario__desc">{selectedScenario.description}</p>
            <ul className="runner-scenario__what">
              <li>
                The scenario&apos;s market conditions are fed into the real risk engine, step by
                step.
              </li>
              <li>The risk score and indicators update live as the situation escalates.</li>
              <li>
                If a threshold is crossed, Sentinel executes a bounded on-chain action and records
                Walrus evidence.
              </li>
            </ul>
            <p className="runner-scenario__cta" data-testid="runner-idle">
              Press <strong>“Start scenario”</strong> to run it.
            </p>
          </div>
        ) : (
          <p className="simulator-runner__idle" data-testid="runner-idle">
            Select a scenario on the left to see what it tests, then press “Start scenario”.
          </p>
        )}
      </section>
    );
  }

  const score = currentStep.risk.riskScore;
  const guardianBlocked = action?.blocked === true || (guardian != null && !guardian.authorized);
  const factors = explainScore(features, currentStep.risk.classes);
  const headline = scoreHeadline(score, currentStep.risk.band, factors);

  return (
    <section className="simulator-runner" data-testid="simulator-runner">
      <header className="simulator-runner__header">
        <span className="simulator-runner__progress" data-testid="runner-step-progress">
          Step {displayStepNumber} of {totalSteps}: {currentStep.stepLabel}
        </span>
      </header>

      {/* Live-updating simulated Risk_Score as a gauge + plain-English band. */}
      <div className="simulator-runner__score" data-testid="runner-score">
        <RiskScoreGauge score={score} band={currentStep.risk.band} />
        <div className="simulator-runner__score-meta">
          <span
            className="simulator-runner__score-band"
            style={{ color: BAND_COLOR[currentStep.risk.band] ?? 'var(--fg)' }}
          >
            {currentStep.risk.band}
          </span>
          <span className="simulator-runner__band-meaning">
            {BAND_MEANING[currentStep.risk.band] ?? ''}
          </span>
          <span className="sr-only" data-testid="runner-score-value">
            {score}
          </span>
        </div>
      </div>

      {/* Live risk-score timeline — makes the run feel like real monitoring. */}
      {scoreSeries.length >= 2 ? (
        <div className="sim-timeline-wrap" data-testid="runner-timeline">
          <span className="sim-timeline__title">Risk score · live timeline</span>
          <RiskTimeline series={scoreSeries} />
        </div>
      ) : null}

      {/* Why this score — plain-English reasoning behind the number. */}
      <div className="score-why" data-testid="runner-score-why">
        <p className="score-why__headline">{headline}</p>
        <ul className="score-why__list">
          {factors.map((factor) => (
            <li
              key={factor.label}
              className={`score-why__item score-why__item--${factor.severity}`}
            >
              <span className="score-why__factor">{factor.label}</span>
              <span className="score-why__detail">{factor.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Every displayed datum carries exactly one data-source label. (Req 14.6) */}
      <div className="simulator-runner__data" data-testid="runner-labeled-data">
        {labeledData.map((datum) => (
          <LabeledDatumRow key={datum.key} datum={datum} />
        ))}
      </div>

      {guardianBlocked ? (
        <p className="simulator-runner__blocked" role="alert" data-testid="runner-guardian-blocked">
          {action?.blockedReason ??
            guardian?.reason ??
            'Guardian capability is not authorized; the action was blocked.'}
        </p>
      ) : null}

      {action && action.attempted && !action.blocked ? (
        <div className="simulator-runner__action" data-testid="runner-action-outcome">
          {action.success ? (
            <>
              <p className="simulator-runner__action-ok" data-testid="runner-action-success">
                Autonomous testnet action executed.
              </p>
              <div className="simulator-runner__digest">
                <span>Transaction digest</span>
                <TxDigestDisplay
                  digest={action.txDigest}
                  verifiedTestnet={txDigestVerifiedTestnet}
                />
              </div>
            </>
          ) : (
            <p
              className="simulator-runner__action-fail"
              role="alert"
              data-testid="runner-action-failed"
            >
              {action.failureReason ?? 'The testnet action or evidence storage failed.'}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

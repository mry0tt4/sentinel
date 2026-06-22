import {
  isActionStep,
  toScoreMovementSeries,
  type IncidentTimeline as IncidentTimelineData,
  type TimelineSnapshotStep,
} from '../../lib/incidentTypes';
import { ActionPointMarker } from './ActionPointMarker';
import { ScoreMovementChart } from './ScoreMovementChart';
import { SimulationMarker } from './SimulationMarker';
import { Markdown } from '../Markdown';

export interface IncidentTimelineProps {
  timeline: IncidentTimelineData;
}

/** Format an epoch-ms / ISO time for compact display, falling back to raw. */
function formatTime(at: string): string {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return at;
  return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

/** Arrow glyph for a score-movement direction. */
const DIRECTION_GLYPH: Record<'up' | 'down' | 'flat', string> = {
  up: '▲',
  down: '▼',
  flat: '=',
};

/** Renders a snapshot step: conditions, score movement, and AI explanation. */
function SnapshotStep({ step }: { step: TimelineSnapshotStep }) {
  const { score, delta, direction } = step.scoreMovement;
  return (
    <article className="incident-snapshot" data-testid={`snapshot-step-${step.snapshotId}`}>
      <header className="incident-snapshot__head">
        <span className="incident-snapshot__band" data-testid="snapshot-band">
          {step.band}
        </span>
        <span className="incident-snapshot__score" data-testid="snapshot-score">
          Risk {score}
          {direction ? (
            <span
              className={`incident-snapshot__delta incident-snapshot__delta--${direction}`}
              data-testid="snapshot-delta"
            >
              {DIRECTION_GLYPH[direction]} {delta !== null && delta > 0 ? `+${delta}` : delta}
            </span>
          ) : null}
        </span>
        <time className="incident-snapshot__time">{formatTime(step.at)}</time>
      </header>

      {step.classes.length > 0 ? (
        <ul className="incident-snapshot__classes" data-testid="snapshot-classes">
          {step.classes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : null}

      {/* Per-step AI explanation. (Req 13.2) */}
      {step.explanation ? (
        <Markdown
          className="incident-snapshot__explanation"
          testId="snapshot-explanation"
          text={step.explanation}
        />
      ) : (
        <p
          className="incident-snapshot__explanation incident-snapshot__explanation--none"
          data-testid="snapshot-explanation-none"
        >
          No explanation recorded for this step.
        </p>
      )}
    </article>
  );
}

/**
 * Incident Replay timeline view. Renders, for a single incident:
 *  - a header with the incident window, summary, and simulation marker (Req 13.6);
 *  - a Risk_Score movement chart across the incident (Req 13.1);
 *  - a chronological list of steps — snapshot steps showing conditions, score
 *    movement, and the per-step AI explanation (Req 13.1, 13.2); action steps
 *    showing the tx digest + Walrus blob id (Req 13.3), override/revocation
 *    markers (Req 13.4), and before/after parameters (Req 13.5).
 *
 * Pure/presentational: it takes an already-assembled timeline so it can be
 * tested with a fixture (no live backend).
 */
export function IncidentTimeline({ timeline }: IncidentTimelineProps) {
  const series = toScoreMovementSeries(timeline);

  return (
    <section className="incident" data-testid="incident-timeline">
      <header className="incident__header">
        <div className="incident__title-row">
          <h2 className="incident__title">Incident {timeline.incidentId}</h2>
          <SimulationMarker isSimulated={timeline.isSimulated} scenarioId={timeline.scenarioId} />
        </div>
        <p className="incident__meta">
          <span data-testid="incident-market">Market {timeline.marketId}</span>
          <span data-testid="incident-window">
            {formatTime(timeline.startedAt)} →{' '}
            {timeline.endedAt ? formatTime(timeline.endedAt) : 'ongoing'}
          </span>
        </p>
        {timeline.summary ? (
          <p className="incident__summary" data-testid="incident-summary">
            {timeline.summary}
          </p>
        ) : null}
      </header>

      {/* AI-authored governance report over the incident timeline (advisory). */}
      {timeline.aiSummary ? (
        <div className="incident__ai-report" data-testid="incident-ai-summary">
          <h3 className="incident__heading">
            AI incident report <span className="incident__ai-tag">advisory</span>
          </h3>
          <Markdown
            className="incident__ai-report-body"
            testId="incident-ai-summary-body"
            text={timeline.aiSummary}
          />
        </div>
      ) : null}

      {/* Risk_Score movement across the incident. (Req 13.1) */}
      <div className="incident__chart">
        <h3 className="incident__heading">Risk score movement</h3>
        {series.length > 0 ? (
          <ScoreMovementChart data={series} />
        ) : (
          <p className="incident__empty" data-testid="incident-no-snapshots">
            No risk snapshots recorded for this incident.
          </p>
        )}
      </div>

      {/* Chronological condition/action timeline. (Req 13.1, 13.3-13.5) */}
      <ol className="incident__steps" data-testid="incident-steps">
        {timeline.steps.length === 0 ? (
          <li className="incident__empty" data-testid="incident-empty">
            This incident has no recorded steps.
          </li>
        ) : (
          timeline.steps.map((step) => (
            <li
              key={step.kind === 'snapshot' ? `s:${step.snapshotId}` : `a:${step.actionId}`}
              className={`incident__step incident__step--${step.kind}`}
            >
              {isActionStep(step) ? (
                <ActionPointMarker step={step} />
              ) : (
                <SnapshotStep step={step} />
              )}
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

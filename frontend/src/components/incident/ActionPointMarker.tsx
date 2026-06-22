import { TxDigestDisplay } from '../TxDigestDisplay';
import type { TimelineActionStep } from '../../lib/incidentTypes';
import { BeforeAfterParams } from './BeforeAfterParams';

export interface ActionPointMarkerProps {
  step: TimelineActionStep;
}

/** Human-readable label for an actor type. */
const ACTOR_LABEL: Record<TimelineActionStep['actorType'], string> = {
  agent: 'Agent',
  dao: 'DAO',
  admin: 'Admin',
};

/**
 * Renders a single action point on the incident timeline: the action type and
 * actor, its on-chain transaction digest (via the guarded {@link
 * TxDigestDisplay}) and linked Walrus blob id (Req 13.3), override / revocation
 * / reversal markers (Req 13.4), and the before/after parameters of the change
 * (Req 13.5).
 */
export function ActionPointMarker({ step }: ActionPointMarkerProps) {
  // Distinct event markers so override and revocation events stand out on the
  // timeline. (Req 13.4)
  const markers: { key: string; label: string; testId: string }[] = [];
  if (step.isOverride) {
    markers.push({ key: 'override', label: 'Override', testId: 'action-marker-override' });
  }
  if (step.isRevocation) {
    markers.push({
      key: 'revocation',
      label: 'Guardian revoked',
      testId: 'action-marker-revocation',
    });
  }
  if (step.isReversal) {
    markers.push({ key: 'reversal', label: 'Reversal', testId: 'action-marker-reversal' });
  }
  if (step.wasReversed) {
    markers.push({ key: 'reversed', label: 'Reversed', testId: 'action-marker-reversed' });
  }

  return (
    <article
      className="incident-action"
      data-testid={`action-point-${step.actionId}`}
      data-action-type={step.actionType}
    >
      <header className="incident-action__head">
        <span className="incident-action__type" data-testid="action-type">
          {step.actionType}
        </span>
        <span className="incident-action__actor" data-testid="action-actor">
          {ACTOR_LABEL[step.actorType]}
          {step.actor ? ` · ${step.actor}` : ''}
        </span>
        {step.riskScore !== null ? (
          <span className="incident-action__score" data-testid="action-risk-score">
            Risk {step.riskScore}
          </span>
        ) : null}
      </header>

      {markers.length > 0 ? (
        <div className="incident-action__markers" data-testid="action-markers">
          {markers.map((m) => (
            <span
              key={m.key}
              className={`incident-action__marker incident-action__marker--${m.key}`}
              data-testid={m.testId}
            >
              {m.label}
            </span>
          ))}
        </div>
      ) : null}

      {step.overrideReason ? (
        <p className="incident-action__reason" data-testid="action-override-reason">
          {step.overrideReason}
        </p>
      ) : null}

      {/* Before/after parameters for the change. (Req 13.5) */}
      <BeforeAfterParams params={step.params} />

      {/* On-chain evidence: tx digest (guarded) + Walrus blob id. (Req 13.3) */}
      <div className="incident-action__evidence">
        <div className="incident-action__evidence-row">
          <span className="incident-action__label">Tx digest</span>
          <TxDigestDisplay digest={step.txDigest} verifiedTestnet={step.txDigestVerifiedTestnet} />
        </div>
        <div className="incident-action__evidence-row">
          <span className="incident-action__label">Walrus blob</span>
          {step.walrusBlobId ? (
            <code className="incident-action__blob" data-testid="action-walrus-blob">
              {step.walrusBlobId}
            </code>
          ) : (
            <span
              className="incident-action__blob incident-action__blob--none"
              data-testid="action-walrus-blob-none"
            >
              No linked evidence
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

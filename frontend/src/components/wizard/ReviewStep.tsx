import type { WizardState } from '../../lib/policyWizard';

export interface ReviewStepProps {
  state: WizardState;
}

/**
 * Step 6 — display all configured values for confirmation before signing.
 * (Req 4.7)
 */
export function ReviewStep({ state }: ReviewStepProps) {
  const marketRef =
    state.marketMode === 'select'
      ? state.selectedMarketId || '—'
      : `${state.newMarketName || '—'} (new)`;
  const feeds = state.feedMappings.filter((m) => m.asset.trim() !== '' || m.feedId.trim() !== '');

  return (
    <section className="wizard-step" data-testid="step-review">
      <h3>Review configuration</h3>
      <dl className="wizard-review">
        <div>
          <dt>Market type</dt>
          <dd data-testid="review-marketType">{state.marketType ?? '—'}</dd>
        </div>
        <div>
          <dt>Demo market</dt>
          <dd data-testid="review-market">{marketRef}</dd>
        </div>
        <div>
          <dt>Price feeds</dt>
          <dd data-testid="review-feeds">
            {feeds.length === 0 ? (
              '—'
            ) : (
              <ul>
                {feeds.map((m, i) => (
                  <li key={i}>
                    {m.asset || '—'} → {m.feedId || '—'}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt>Allowed actions</dt>
          <dd data-testid="review-allowedActions">
            {state.allowedActions.length === 0 ? '—' : state.allowedActions.join(', ')}
          </dd>
        </div>
        <div>
          <dt>Max LTV delta (bps)</dt>
          <dd data-testid="review-maxLtvDeltaBps">{state.maxLtvDeltaBps || '—'}</dd>
        </div>
        <div>
          <dt>Max margin delta (bps)</dt>
          <dd data-testid="review-maxMarginDeltaBps">{state.maxMarginDeltaBps || '—'}</dd>
        </div>
        <div>
          <dt>Pause duration limit (ms)</dt>
          <dd data-testid="review-pauseDurationLimitMs">{state.pauseDurationLimitMs || '—'}</dd>
        </div>
        <div>
          <dt>Cooldown (ms)</dt>
          <dd data-testid="review-cooldownMs">{state.cooldownMs || '—'}</dd>
        </div>
        <div>
          <dt>DAO override address</dt>
          <dd data-testid="review-daoAddress">{state.daoAddress || '—'}</dd>
        </div>
      </dl>
    </section>
  );
}

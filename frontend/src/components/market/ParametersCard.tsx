import type { PolicyParams } from '../../lib/dashboardTypes';

export interface ParametersCardProps {
  params: PolicyParams | null;
}

/** Format a numeric/string bound, falling back to a dash when absent. */
function fmt(value: unknown, suffix = ''): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number' && Number.isNaN(value)) return '—';
  return `${value}${suffix}`;
}

/**
 * Current policy parameters for the market: action bounds (max LTV delta, max
 * margin delta, pause duration limit, cooldown), the allowed action types, and
 * the DAO override address. (Req 3.6)
 */
export function ParametersCard({ params }: ParametersCardProps) {
  if (params === null) {
    return (
      <section className="market-card" data-testid="parameters-card">
        <h3 className="market-card__heading">Current parameters</h3>
        <p className="market-card__empty" data-testid="parameters-card-empty">
          No active policy configured for this market.
        </p>
      </section>
    );
  }

  const rows: { key: string; label: string; value: string }[] = [
    { key: 'max-ltv-delta', label: 'Max LTV delta', value: fmt(params.maxLtvDeltaBps, ' bps') },
    {
      key: 'max-margin-delta',
      label: 'Max margin delta',
      value: fmt(params.maxMarginDeltaBps, ' bps'),
    },
    {
      key: 'pause-duration-limit',
      label: 'Pause duration limit',
      value: fmt(params.pauseDurationLimitMs, ' ms'),
    },
    { key: 'cooldown', label: 'Cooldown', value: fmt(params.cooldownMs, ' ms') },
  ];

  const allowedActions =
    params.allowedActions.length > 0 ? params.allowedActions.join(', ') : '—';

  return (
    <section className="market-card" data-testid="parameters-card">
      <h3 className="market-card__heading">Current parameters</h3>
      <dl className="market-card__grid">
        {rows.map((row) => (
          <div className="market-card__row" key={row.key} data-testid={`param-${row.key}`}>
            <dt className="market-card__label">{row.label}</dt>
            <dd className="market-card__value" data-testid={`param-${row.key}-value`}>
              {row.value}
            </dd>
          </div>
        ))}
        <div className="market-card__row" data-testid="param-allowed-actions">
          <dt className="market-card__label">Allowed actions</dt>
          <dd className="market-card__value" data-testid="param-allowed-actions-value">
            {allowedActions}
          </dd>
        </div>
        <div className="market-card__row" data-testid="param-dao-address">
          <dt className="market-card__label">DAO address</dt>
          <dd className="market-card__value market-card__value--mono" data-testid="param-dao-address-value">
            {fmt(params.daoAddress)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

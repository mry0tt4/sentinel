import type { BeforeAfterParams as BeforeAfterParamsData } from '../../lib/incidentTypes';

export interface BeforeAfterParamsProps {
  params: BeforeAfterParamsData;
}

const EMPTY = '—';

/**
 * Renders the before/after parameter values for an action, so a replay viewer
 * can see exactly what each action changed. (Req 13.5)
 */
export function BeforeAfterParams({ params }: BeforeAfterParamsProps) {
  return (
    <dl className="incident-params" data-testid="before-after-params">
      <div className="incident-params__pair">
        <dt>Before</dt>
        <dd data-testid="param-before">{params.before ?? EMPTY}</dd>
      </div>
      <span className="incident-params__arrow" aria-hidden="true">
        →
      </span>
      <div className="incident-params__pair">
        <dt>After</dt>
        <dd data-testid="param-after">{params.after ?? EMPTY}</dd>
      </div>
    </dl>
  );
}

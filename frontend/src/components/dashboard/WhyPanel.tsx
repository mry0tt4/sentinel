import type { DeterministicRuleOutput } from '../../lib/dashboardTypes';
import { Markdown } from '../Markdown';

export interface WhyPanelProps {
  /** Whether the panel is expanded. */
  open: boolean;
  /** Toggle handler for the disclosure button. */
  onToggle: () => void;
  /** Most recent AI explanation for the market. (Req 3.8) */
  explanation?: string | null;
  /** Deterministic rule outputs for the market. (Req 3.8) */
  ruleOutputs?: DeterministicRuleOutput[];
}

/**
 * "Why did this happen?" disclosure panel. When opened, shows the most recent
 * AI explanation and the deterministic rule outputs for the selected market.
 * (Req 3.8)
 */
export function WhyPanel({ open, onToggle, explanation, ruleOutputs }: WhyPanelProps) {
  const rules = ruleOutputs ?? [];

  return (
    <section className="why-panel" data-testid="why-panel">
      <button
        type="button"
        className="why-panel__toggle"
        aria-expanded={open}
        data-testid="why-panel-toggle"
        onClick={onToggle}
      >
        Why did this happen?
      </button>

      {open ? (
        <div className="why-panel__body" data-testid="why-panel-body">
          <h4 className="why-panel__heading">AI explanation</h4>
          {explanation && explanation.trim() !== '' ? (
            <Markdown
              className="why-panel__explanation"
              testId="why-panel-explanation"
              text={explanation}
            />
          ) : (
            <p className="why-panel__explanation" data-testid="why-panel-explanation">
              No explanation available yet.
            </p>
          )}

          <h4 className="why-panel__heading">Deterministic rule outputs</h4>
          {rules.length === 0 ? (
            <p className="why-panel__empty" data-testid="why-panel-rules-empty">
              No rule outputs recorded.
            </p>
          ) : (
            <ul className="why-panel__rules" data-testid="why-panel-rules">
              {rules.map((rule) => (
                <li
                  key={rule.rule}
                  className={`why-panel__rule${rule.fired ? ' why-panel__rule--fired' : ''}`}
                  data-testid={`why-panel-rule-${rule.rule}`}
                >
                  <span className="why-panel__rule-name">{rule.rule}</span>
                  <span className="why-panel__rule-status">{rule.fired ? 'FIRED' : 'ok'}</span>
                  <span className="why-panel__rule-value">{rule.value}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

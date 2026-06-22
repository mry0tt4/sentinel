export interface ResponseFlowProps {
  /** Highlight the step matching the current risk state. */
  recommendedAction?: string | null;
  mitigationActive?: boolean;
}

const STEPS = [
  { key: 'detect', label: 'Detect', desc: 'Live Pyth + DeepBook feeds' },
  { key: 'score', label: 'Score', desc: 'Deterministic risk engine' },
  { key: 'act', label: 'Act (bounded)', desc: 'On-chain Move policy' },
  { key: 'prove', label: 'Prove', desc: 'Evidence on Walrus' },
];

/**
 * A compact, always-visible explainer of how Sentinel responds to risk —
 * detect → score → act within on-chain bounds → prove with evidence. Gives
 * judges the whole story at a glance. (Presentation & Vision)
 */
export function ResponseFlow({ recommendedAction, mitigationActive }: ResponseFlowProps) {
  const active = mitigationActive || (recommendedAction != null && recommendedAction !== '');
  return (
    <ol className="response-flow" data-testid="response-flow" aria-label="How Sentinel responds">
      {STEPS.map((s, i) => (
        <li
          key={s.key}
          className={`response-flow__step${s.key === 'act' && active ? ' response-flow__step--hot' : ''}`}
        >
          <span className="response-flow__num">{i + 1}</span>
          <span className="response-flow__body">
            <span className="response-flow__label">{s.label}</span>
            <span className="response-flow__desc">{s.desc}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

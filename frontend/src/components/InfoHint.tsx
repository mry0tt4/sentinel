import { explain } from '../lib/glossary';

export interface InfoHintProps {
  /** Explanation text. If omitted, `term` is looked up in the glossary. */
  text?: string | null;
  /** A glossary term to look up when `text` is not given (e.g. a field label). */
  term?: string | null;
}

/**
 * A small, accessible "i" affordance that reveals a plain-English explanation
 * on hover or keyboard focus. Renders nothing when no explanation is available,
 * so it can be dropped next to any label safely.
 */
export function InfoHint({ text, term }: InfoHintProps) {
  const body = text ?? explain(term);
  if (!body) return null;
  return (
    <span
      className="info-hint"
      tabIndex={0}
      role="note"
      aria-label={body}
      data-testid="info-hint"
    >
      <span className="info-hint__icon" aria-hidden="true">
        i
      </span>
      <span className="info-hint__pop" role="tooltip">
        {body}
      </span>
    </span>
  );
}

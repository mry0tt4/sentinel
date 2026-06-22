import type { ReactNode } from 'react';

export interface MarkdownProps {
  /** Markdown source (short AI explanation text). */
  text: string;
  /** Class applied to the root container. */
  className?: string;
  /** Optional test id placed on the root container. */
  testId?: string;
}

/**
 * Minimal, dependency-free, XSS-safe Markdown renderer for the short AI
 * explanations. It produces React elements only (never `dangerouslySetInnerHTML`),
 * so untrusted model output cannot inject HTML. Supported syntax:
 *   - paragraphs (blank-line separated) and single newlines → <br/>
 *   - unordered lists (`- ` / `* ` lines)
 *   - inline **bold**, *italic* / _italic_, and `inline code`
 *   - leading `#` heading markers are stripped (rendered as emphasized text)
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let token: RegExpExecArray | null;
  let i = 0;
  while ((token = pattern.exec(text)) !== null) {
    if (token.index > last) {
      nodes.push(text.slice(last, token.index));
    }
    const t = token[0];
    const key = `${keyPrefix}-${i++}`;
    if (t.startsWith('**')) {
      nodes.push(<strong key={key}>{t.slice(2, -2)}</strong>);
    } else if (t.startsWith('`')) {
      nodes.push(<code key={key}>{t.slice(1, -1)}</code>);
    } else {
      nodes.push(<em key={key}>{t.slice(1, -1)}</em>);
    }
    last = token.index + t.length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

export function Markdown({ text, className, testId }: MarkdownProps) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim() !== '');
  return (
    <div className={['md', className].filter(Boolean).join(' ')} data-testid={testId}>
      {blocks.map((block, bi) => {
        const lines = block.split('\n');
        const isList = lines.length > 0 && lines.every((l) => /^\s*[-*]\s+/.test(l));
        if (isList) {
          return (
            <ul className="md__list" key={`b-${bi}`}>
              {lines.map((l, li) => (
                <li key={`li-${bi}-${li}`}>
                  {renderInline(l.replace(/^\s*[-*]\s+/, ''), `il-${bi}-${li}`)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p className="md__p" key={`b-${bi}`}>
            {lines.flatMap((l, li) => {
              const inline = renderInline(l.replace(/^#{1,6}\s+/, ''), `ip-${bi}-${li}`);
              return li < lines.length - 1
                ? [...inline, <br key={`br-${bi}-${li}`} />]
                : inline;
            })}
          </p>
        );
      })}
    </div>
  );
}

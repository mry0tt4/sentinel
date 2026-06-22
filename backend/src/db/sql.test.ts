import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildInsert, buildUpdateById } from './sql.js';

describe('buildInsert', () => {
  it('omits undefined columns and keeps explicit null', () => {
    const { text, values } = buildInsert('markets', {
      id: undefined,
      name: 'Demo',
      summary: null,
    });
    expect(text).toBe('INSERT INTO markets (name, summary) VALUES ($1, $2) RETURNING *');
    expect(values).toEqual(['Demo', null]);
  });

  it('numbers placeholders sequentially starting at $1', () => {
    const { text } = buildInsert('t', { a: 1, b: 2, c: 3 });
    expect(text).toContain('VALUES ($1, $2, $3)');
  });
});

describe('buildUpdateById', () => {
  it('places the where value as the final parameter', () => {
    const { text, values } = buildUpdateById('markets', { status: 'Paused' }, 'id', 'm1');
    expect(text).toBe('UPDATE markets SET status = $1 WHERE id = $2 RETURNING *');
    expect(values).toEqual(['Paused', 'm1']);
  });

  it('throws when there is nothing to update', () => {
    expect(() => buildUpdateById('markets', { x: undefined }, 'id', 'm1')).toThrow();
  });
});

describe('buildInsert parameterization invariant (property)', () => {
  it('always emits exactly one $n placeholder per non-undefined value', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1 }).filter((s) => /^[a-z_]+$/i.test(s)),
          fc.oneof(fc.integer(), fc.string(), fc.constant(null), fc.constant(undefined)),
        ),
        (cols) => {
          const defined = Object.entries(cols).filter(([, v]) => v !== undefined);
          fc.pre(defined.length > 0);
          const { text, values } = buildInsert('tbl', cols);
          // One bind value per defined column.
          expect(values).toHaveLength(defined.length);
          // Each placeholder $1..$n is present; no $(n+1).
          for (let i = 1; i <= values.length; i++) {
            expect(text).toContain(`$${i}`);
          }
          expect(text).not.toContain(`$${values.length + 1}`);
          // No raw value is interpolated into the SQL text.
          expect(text.startsWith('INSERT INTO tbl (')).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

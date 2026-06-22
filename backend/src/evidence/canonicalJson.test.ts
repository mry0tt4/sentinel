import { describe, expect, it } from 'vitest';

import { canonicalJsonStringify } from './canonicalJson.js';

describe('canonicalJsonStringify', () => {
  it('sorts object keys ascending', () => {
    expect(canonicalJsonStringify({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it('produces identical output regardless of key insertion order', () => {
    const a = canonicalJsonStringify({ x: 1, y: { p: 2, q: 3 } });
    const b = canonicalJsonStringify({ y: { q: 3, p: 2 }, x: 1 });
    expect(a).toBe(b);
  });

  it('preserves array order', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('sorts keys recursively inside arrays of objects', () => {
    expect(canonicalJsonStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('omits undefined object properties (matching JSON.stringify)', () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('renders undefined array elements as null (matching JSON.stringify)', () => {
    expect(canonicalJsonStringify([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('serializes primitives and null', () => {
    expect(canonicalJsonStringify('hi')).toBe('"hi"');
    expect(canonicalJsonStringify(42)).toBe('42');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(null)).toBe('null');
  });

  it('throws on non-finite numbers to protect hash stability', () => {
    expect(() => canonicalJsonStringify({ x: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });
});

/**
 * Canonical JSON serialization.
 *
 * Evidence_Bundles are content-addressed: the `rawDataHash` and any later
 * on-chain evidence hash must be reproducible from the bundle data alone. JSON
 * object key order is otherwise insertion-dependent, so two structurally equal
 * bundles could serialize to different byte strings and hash differently. This
 * module produces a deterministic, stable-ordered JSON string by recursively
 * sorting object keys, so equal data always yields identical bytes.
 *
 * Rules:
 *  - Object keys are emitted in ascending (UTF-16 code unit) order.
 *  - Arrays preserve their order (order is semantically meaningful).
 *  - `undefined` object properties are omitted (matching `JSON.stringify`).
 *  - `undefined`/function array elements serialize to `null` (matching
 *    `JSON.stringify`).
 *  - Non-finite numbers (NaN, Infinity) are rejected — they would serialize to
 *    `null` and silently corrupt a hash. Bundles must carry finite numerics.
 */

/** A JSON-serializable value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Serialize `value` to a deterministic, stable-key-ordered JSON string.
 *
 * @throws {Error} if a non-finite number is encountered.
 */
export function canonicalJsonStringify(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  const type = typeof value;

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot canonicalize non-finite number: ${String(value)}`);
    }
    return JSON.stringify(value);
  }

  if (type === 'string' || type === 'boolean') {
    return JSON.stringify(value);
  }

  if (type === 'bigint') {
    throw new Error('Cannot canonicalize bigint; convert to string or number first');
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => {
      // JSON.stringify renders undefined/functions inside arrays as null.
      if (item === undefined || typeof item === 'function') {
        return 'null';
      }
      return serialize(item);
    });
    return `[${items.join(',')}]`;
  }

  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const entries: string[] = [];
    for (const key of keys) {
      const propValue = obj[key];
      // Omit undefined / function properties, matching JSON.stringify.
      if (propValue === undefined || typeof propValue === 'function') {
        continue;
      }
      entries.push(`${JSON.stringify(key)}:${serialize(propValue)}`);
    }
    return `{${entries.join(',')}}`;
  }

  // undefined / function at the top level has no JSON representation.
  throw new Error(`Cannot canonicalize value of type ${type}`);
}

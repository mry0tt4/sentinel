/**
 * Sensitive-field encryption for evidence bundles.
 *
 * WHERE a bundle field is designated sensitive by policy configuration, that
 * field is encrypted before storage and the bundle's status becomes
 * `private_encrypted` (Req 10.9). Real envelope/Seal encryption is out of scope
 * for this task; instead an *injectable* encrypt function performs the
 * transformation so production can later swap in Seal without touching callers.
 *
 * {@link encryptSensitiveFields} is pure: it returns a new bundle in which each
 * designated top-level field is replaced by an opaque encrypted representation,
 * records the encrypted field names in `sensitiveFieldsEncrypted`, and reports
 * the target lifecycle status (`private_encrypted`). It never mutates its input
 * and never strips a field's presence — only its value is encrypted — so the
 * bundle shape remains schema-complete.
 */

import { createHash } from 'node:crypto';

import { canonicalJsonStringify } from './canonicalJson.js';
import type { EvidenceBundle } from './types.js';

/**
 * Injectable field encryptor. Given a field name and its current value, returns
 * the opaque string stored in place of the plaintext. Implementations must be
 * deterministic enough for the caller's needs; the default stub is fully
 * deterministic.
 */
export type FieldEncryptFn = (fieldName: string, value: unknown) => string;

/**
 * Default deterministic encryption stub. Produces `enc:<sha256>` over the field
 * name + canonical value, so equal inputs yield equal ciphertext and no
 * plaintext leaks into the stored representation. NOT real encryption — a
 * placeholder for Seal/envelope encryption (out of scope, Req 10.9).
 */
export const defaultDeterministicEncrypt: FieldEncryptFn = (fieldName, value) => {
  const canonical = canonicalJsonStringify({ field: fieldName, value } as unknown);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `enc:${digest}`;
};

/** Result of encrypting a bundle's policy-designated sensitive fields. */
export interface EncryptedSensitiveResult {
  /** The new bundle with designated fields encrypted in place. */
  bundle: EvidenceBundle;
  /** Lifecycle status the encrypted bundle must be persisted under. (Req 10.9) */
  status: 'private_encrypted';
  /** Names of the fields that were actually present and encrypted. */
  encryptedFields: string[];
}

/**
 * Encrypt the policy-designated sensitive fields of `bundle`.
 *
 * Only top-level bundle fields named in `sensitiveFieldNames` that are actually
 * present are encrypted. The returned bundle:
 *  - has each such field's value replaced by `encryptFn(name, originalValue)`,
 *  - lists the encrypted field names in `sensitiveFieldsEncrypted`,
 *  - is destined for `private_encrypted` status.
 *
 * The input bundle is never mutated. `rawDataHash` and `sensitiveFieldsEncrypted`
 * are themselves never treated as sensitive fields.
 *
 * @param bundle The source bundle.
 * @param sensitiveFieldNames Field names designated sensitive by policy config.
 * @param encryptFn Injectable encryptor; defaults to a deterministic stub.
 */
export function encryptSensitiveFields(
  bundle: EvidenceBundle,
  sensitiveFieldNames: readonly string[],
  encryptFn: FieldEncryptFn = defaultDeterministicEncrypt,
): EncryptedSensitiveResult {
  // Fields that are part of the encryption bookkeeping itself can never be
  // designated as sensitive payload fields.
  const reserved = new Set<keyof EvidenceBundle>(['sensitiveFieldsEncrypted', 'rawDataHash']);

  const next = { ...bundle } as Record<string, unknown>;
  const encryptedFields: string[] = [];

  // De-duplicate names while preserving first-seen order.
  const uniqueNames = Array.from(new Set(sensitiveFieldNames));

  for (const name of uniqueNames) {
    if (reserved.has(name as keyof EvidenceBundle)) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(bundle, name)) {
      continue;
    }
    const original = (bundle as unknown as Record<string, unknown>)[name];
    next[name] = encryptFn(name, original);
    encryptedFields.push(name);
  }

  next.sensitiveFieldsEncrypted = encryptedFields;

  return {
    bundle: next as unknown as EvidenceBundle,
    status: 'private_encrypted',
    encryptedFields,
  };
}

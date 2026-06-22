/**
 * Shared secret-exclusion guard for evidence bundles.
 *
 * Secrets and private keys MUST NEVER be persisted in a non-private evidence
 * bundle — i.e. any bundle whose status is `pending_upload`, `uploaded`, or
 * `linked_on_chain` (Req 10.8, 16.1). This module centralises the forbidden-key
 * detection so every persistence path (generation, upload, link) applies the
 * exact same check, rather than duplicating the logic.
 *
 * Detection is structural: it walks the object graph and matches any key whose
 * normalised (lowercased, separators stripped) form contains a known
 * secret-bearing substring (e.g. `privateKey`, `mnemonic`, `apiKey`). A match
 * is treated as a programming error and throws, so a leaked secret can never be
 * silently written to storage.
 */

/**
 * Lowercased substrings that must never appear as an object key anywhere in a
 * bundle. Any match indicates a secret/private key leaked into evidence.
 * (Req 10.8)
 */
export const FORBIDDEN_KEY_SUBSTRINGS = [
  'privatekey',
  'private_key',
  'secretkey',
  'secret',
  'mnemonic',
  'seedphrase',
  'seed_phrase',
  'passphrase',
  'apikey',
  'api_key',
  'password',
  'signerkey',
] as const;

/**
 * Normalise a key for matching: lowercase and strip the common word separators
 * (`_`, `-`, whitespace) so `private_key`, `private-key`, and `privateKey` all
 * collapse onto the same forbidden substring.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

/**
 * Return the first object key (in traversal order) that matches a forbidden
 * secret pattern, or `null` if the structure contains no secret-looking key.
 */
export function findSecretKey(data: unknown): string | null {
  const stack: unknown[] = [data];

  while (stack.length > 0) {
    const value = stack.pop();

    if (Array.isArray(value)) {
      for (const item of value) {
        stack.push(item);
      }
      continue;
    }

    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const normalized = normalizeKey(key);
        if (FORBIDDEN_KEY_SUBSTRINGS.some((bad) => normalized.includes(normalizeKey(bad)))) {
          return key;
        }
        stack.push(child);
      }
    }
  }

  return null;
}

/** Whether `data` contains any secret-looking key. */
export function containsSecretKey(data: unknown): boolean {
  return findSecretKey(data) !== null;
}

/**
 * Throw if `data` contains any secret-looking key. Guards Req 10.8 — secrets /
 * private keys must never appear in a stored non-private bundle.
 */
export function assertNoSecrets(data: unknown): void {
  const offending = findSecretKey(data);
  if (offending !== null) {
    throw new Error(`Evidence bundle must not contain secret field "${offending}" (Req 10.8)`);
  }
}

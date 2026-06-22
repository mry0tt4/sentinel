export interface TxDigestDisplayProps {
  /** The Sui transaction digest, or null when none is available yet. */
  digest?: string | null;
  /**
   * Whether the digest has been verified by the backend Network_Guard as
   * originating from Sui Testnet (NetworkGuard.verifyDigestOrigin). The frontend
   * MUST NOT display a digest that has not been verified.
   */
  verifiedTestnet: boolean;
}

/** Shown in place of a digest that has not been verified as testnet. (Req 1.9) */
export const UNVERIFIED_DIGEST_MESSAGE =
  'Transaction digest blocked: not verified as originating from Sui Testnet.';

/**
 * Guarded transaction-digest display.
 *
 * Only renders the digest once it has been verified as originating from Sui
 * Testnet. Any unverified (or absent) digest is suppressed and replaced with a
 * verification-blocked message, so the frontend never surfaces a digest it
 * cannot confirm is a testnet transaction.
 * (Requirement 1.9)
 */
export function TxDigestDisplay({ digest, verifiedTestnet }: TxDigestDisplayProps) {
  if (!verifiedTestnet || !digest) {
    return (
      <span
        className="tx-digest tx-digest--blocked"
        role="alert"
        data-testid="tx-digest-blocked"
      >
        {UNVERIFIED_DIGEST_MESSAGE}
      </span>
    );
  }

  return (
    <code className="tx-digest tx-digest--verified" data-testid="tx-digest">
      {digest}
    </code>
  );
}

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TxDigestDisplay, UNVERIFIED_DIGEST_MESSAGE } from './TxDigestDisplay';

const DIGEST = 'A1b2C3d4E5f6G7h8J9k0';

// Guarded tx-digest display. (Req 1.9)
describe('TxDigestDisplay', () => {
  it('shows the digest once verified as testnet', () => {
    render(<TxDigestDisplay digest={DIGEST} verifiedTestnet />);
    expect(screen.getByTestId('tx-digest')).toHaveTextContent(DIGEST);
    expect(screen.queryByTestId('tx-digest-blocked')).not.toBeInTheDocument();
  });

  it('blocks display of an unverified digest', () => {
    render(<TxDigestDisplay digest={DIGEST} verifiedTestnet={false} />);
    expect(screen.queryByText(DIGEST)).not.toBeInTheDocument();
    expect(screen.getByTestId('tx-digest-blocked')).toHaveTextContent(
      UNVERIFIED_DIGEST_MESSAGE,
    );
  });

  it('blocks display when no digest is available', () => {
    render(<TxDigestDisplay digest={null} verifiedTestnet />);
    expect(screen.getByTestId('tx-digest-blocked')).toBeInTheDocument();
  });
});

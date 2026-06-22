import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useSuiWallet } from '../hooks/useSuiWallet';

export interface SignButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  /** Button label / content. */
  children: ReactNode;
  /**
   * Additional disabling condition layered on top of the network gate (e.g. a
   * pending submission). The control is always disabled when signing is gated.
   */
  disabled?: boolean;
  /** When true, shows a spinner and disables the control during an in-flight action. */
  loading?: boolean;
}

/**
 * Reusable signing control.
 *
 * Consults `canSign` from {@link useSuiWallet} (true only when connected AND on
 * Sui Testnet) and disables itself whenever signing is not permitted, so no
 * transaction can be initiated from a disconnected or wrong-network wallet.
 * Must be rendered inside the SuiProvider so the wallet hook resolves.
 * (Requirements 1.5, 2.4, 2.5)
 */
export function SignButton({
  children,
  disabled = false,
  loading = false,
  className,
  ...rest
}: SignButtonProps) {
  const { canSign } = useSuiWallet();
  const isDisabled = disabled || loading || !canSign;

  return (
    <button
      type="button"
      {...rest}
      className={['btn', 'btn--primary', className].filter(Boolean).join(' ')}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      aria-busy={loading}
      data-testid="sign-button"
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

import { TxDigestDisplay } from '../TxDigestDisplay';
import type { DaoOverrideStatus, MarketActionRecord } from '../../lib/dashboardTypes';

export interface LastActionCardProps {
  /** The most recent executed/overridden action, or null when none yet. */
  lastAction: MarketActionRecord | null;
  /** Last Tx_Digest surfaced by the backend. (Req 3.6) */
  lastTxDigest: string | null;
  /**
   * Whether the digest has been verified as a Sui Testnet transaction. Passed
   * to {@link TxDigestDisplay}; an unverified digest is blocked. (Req 1.8, 1.9)
   */
  lastTxDigestVerifiedTestnet: boolean;
  /** Last Walrus Blob_ID for linked evidence. (Req 3.6) */
  lastWalrusBlobId: string | null;
  /** DAO override status derived from the last action. (Req 3.6) */
  daoOverrideStatus: DaoOverrideStatus;
}

const OVERRIDE_LABEL: Record<DaoOverrideStatus, string> = {
  none: 'None',
  overridden: 'Overridden by DAO',
  reversed: 'Reversed by DAO',
};

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

/**
 * The last executed action for the market with its on-chain Tx_Digest (guarded
 * by {@link TxDigestDisplay} so an unverified digest is blocked), the linked
 * Walrus Blob_ID, and the DAO override status. (Req 3.6)
 */
export function LastActionCard({
  lastAction,
  lastTxDigest,
  lastTxDigestVerifiedTestnet,
  lastWalrusBlobId,
  daoOverrideStatus,
}: LastActionCardProps) {
  return (
    <section className="market-card" data-testid="last-action-card">
      <h3 className="market-card__heading">Last executed action</h3>

      {lastAction === null ? (
        <p className="market-card__empty" data-testid="last-action-empty">
          No actions have been executed for this market yet.
        </p>
      ) : (
        <dl className="market-card__grid">
          <div className="market-card__row" data-testid="last-action-type">
            <dt className="market-card__label">Action</dt>
            <dd className="market-card__value" data-testid="last-action-type-value">
              {fmt(lastAction.actionType)}
            </dd>
          </div>
          <div className="market-card__row" data-testid="last-action-change">
            <dt className="market-card__label">Change</dt>
            <dd className="market-card__value" data-testid="last-action-change-value">
              {fmt(lastAction.oldValue)} → {fmt(lastAction.newValue)}
            </dd>
          </div>
          <div className="market-card__row" data-testid="last-action-risk-score">
            <dt className="market-card__label">Risk score</dt>
            <dd className="market-card__value" data-testid="last-action-risk-score-value">
              {fmt(lastAction.riskScore)}
            </dd>
          </div>
          <div className="market-card__row" data-testid="last-action-actor">
            <dt className="market-card__label">Actor</dt>
            <dd className="market-card__value market-card__value--mono" data-testid="last-action-actor-value">
              {fmt(lastAction.actor)}
            </dd>
          </div>
        </dl>
      )}

      <dl className="market-card__grid">
        <div className="market-card__row" data-testid="last-action-tx-digest">
          <dt className="market-card__label">Tx digest</dt>
          <dd className="market-card__value">
            <TxDigestDisplay
              digest={lastTxDigest}
              verifiedTestnet={lastTxDigestVerifiedTestnet}
            />
          </dd>
        </div>
        <div className="market-card__row" data-testid="last-action-blob-id">
          <dt className="market-card__label">Walrus blob ID</dt>
          <dd className="market-card__value market-card__value--mono" data-testid="last-action-blob-id-value">
            {fmt(lastWalrusBlobId)}
          </dd>
        </div>
        <div className="market-card__row" data-testid="last-action-override-status">
          <dt className="market-card__label">DAO override status</dt>
          <dd className="market-card__value" data-testid="last-action-override-status-value">
            {OVERRIDE_LABEL[daoOverrideStatus]}
          </dd>
        </div>
      </dl>
    </section>
  );
}

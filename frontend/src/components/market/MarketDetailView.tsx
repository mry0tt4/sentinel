import { useEffect, useState } from 'react';

import type { DashboardDataClient } from '../../lib/dashboardApi';
import {
  isRiskDataStale,
  type MarketDetailView as MarketDetailData,
  type MarketRiskView,
  type RiskPoint,
} from '../../lib/dashboardTypes';
import { IndicatorPanel } from '../dashboard/IndicatorPanel';
import { RiskScoreGauge } from '../dashboard/RiskScoreGauge';
import { RiskTrendChart } from '../dashboard/RiskTrendChart';
import { StaleBadge } from '../dashboard/StaleBadge';
import { LastActionCard } from './LastActionCard';
import { MarketHeader } from './MarketHeader';
import { ParametersCard } from './ParametersCard';

export interface MarketDetailViewProps {
  /** Injectable backend client (REST reads). */
  dataClient: DashboardDataClient;
  /** The market id from the route. */
  marketId: string;
  /** Optionally seed the detail (skips the initial fetch) — used in tests. */
  initialDetail?: MarketDetailData;
  /** Optionally seed the risk view (skips the initial fetch) — used in tests. */
  initialRisk?: MarketRiskView | null;
}

/**
 * Single-market detail view. Renders the market header + status, the current
 * policy parameters card, the last-action card (Tx_Digest, Walrus Blob_ID, DAO
 * override status), and the risk trend chart alongside the current risk score
 * and indicators. (Req 3.3, 3.4, 3.5, 3.6)
 *
 * Split from the provider-wrapped {@link MarketDetail} island so it can be
 * tested with an injected fake client (no live backend).
 */
export function MarketDetailView({
  dataClient,
  marketId,
  initialDetail,
  initialRisk = null,
}: MarketDetailViewProps) {
  const [detail, setDetail] = useState<MarketDetailData | null>(initialDetail ?? null);
  const [risk, setRisk] = useState<MarketRiskView | null>(initialRisk);
  const [error, setError] = useState<string | null>(null);

  // Load the market detail (params, last action, digest, blob id, override). (Req 3.6)
  useEffect(() => {
    if (initialDetail) return;
    let cancelled = false;
    dataClient
      .getMarketDetail(marketId)
      .then((view) => {
        if (!cancelled) setDetail(view);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load market detail');
      });
    return () => {
      cancelled = true;
    };
  }, [dataClient, marketId, initialDetail]);

  // Load the current risk score + indicators for the trend/gauge. (Req 3.3–3.5)
  useEffect(() => {
    if (initialRisk) return;
    let cancelled = false;
    dataClient
      .getRisk(marketId)
      .then((view) => {
        if (!cancelled) setRisk(view);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load risk');
      });
    return () => {
      cancelled = true;
    };
  }, [dataClient, marketId, initialRisk]);

  if (error !== null && detail === null) {
    return (
      <p className="market-detail__error" role="alert" data-testid="market-detail-error">
        {error}
      </p>
    );
  }

  if (detail === null) {
    return (
      <p className="market-detail__loading" data-testid="market-detail-loading">
        Loading market…
      </p>
    );
  }

  const trend: RiskPoint[] = risk?.riskScore == null ? [] : [{ t: 0, score: risk.riskScore }];
  const stale = isRiskDataStale(risk);

  return (
    <section className="market-detail" data-testid="market-detail">
      <div className="market-detail__title-row">
        <MarketHeader market={detail.market} />
        <StaleBadge stale={stale} />
      </div>

      {error !== null ? (
        <p className="market-detail__error" role="alert" data-testid="market-detail-error">
          {error}
        </p>
      ) : null}

      <div className="market-detail__risk-row">
        <RiskScoreGauge score={risk?.riskScore ?? null} band={risk?.band ?? null} />
        <IndicatorPanel indicators={risk?.indicators ?? null} />
      </div>

      <div className="market-detail__trend">
        <h3 className="market-card__heading">Risk score trend</h3>
        <RiskTrendChart data={trend} />
      </div>

      <div className="market-detail__cards">
        <ParametersCard params={detail.params} />
        <LastActionCard
          lastAction={detail.lastAction}
          lastTxDigest={detail.lastTxDigest}
          lastTxDigestVerifiedTestnet={detail.lastTxDigestVerifiedTestnet}
          lastWalrusBlobId={detail.lastWalrusBlobId}
          daoOverrideStatus={detail.daoOverrideStatus}
        />
      </div>
    </section>
  );
}

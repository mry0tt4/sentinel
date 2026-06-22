import { useCallback, useEffect, useRef, useState } from 'react';

import type { DashboardDataClient } from '../../lib/dashboardApi';
import {
  isRiskDataStale,
  snapshotToRiskView,
  type MarketRiskView,
  type MarketSummary,
  type PricePoint,
  type RiskPoint,
  type ServerMessage,
} from '../../lib/dashboardTypes';
import { useRiskSocket, type RiskSocketClient } from '../../lib/riskSocket';
import { NetworkBadge } from '../NetworkBadge';
import { SUI_TESTNET_LABEL } from '../../lib/network';
import { IndicatorPanel } from './IndicatorPanel';
import { ImpactStrip } from './ImpactStrip';
import { LiveSources } from './LiveSources';
import { AgentTrace, type AgentTraceAction } from './AgentTrace';
import { ReplayPanel } from './ReplayPanel';
import { ResponseFlow } from './ResponseFlow';
import { MarketList } from './MarketList';
import { OraclePriceChart } from './OraclePriceChart';
import { RiskScoreGauge } from './RiskScoreGauge';
import { RiskTrendChart } from './RiskTrendChart';
import { StaleBadge } from './StaleBadge';
import { WhyPanel } from './WhyPanel';

const MAX_POINTS = 60;

export interface DashboardViewProps {
  /** Injectable backend client (REST reads). */
  dataClient: DashboardDataClient;
  /** Injectable live socket client; null disables live updates. (Req 3.7) */
  socketClient: RiskSocketClient | null;
  /** Network reported by the connected wallet (for the badge). (Req 3.1) */
  walletNetwork?: string | null;
  /** Optionally seed the market list (skips the initial fetch). */
  initialMarkets?: MarketSummary[];
  /** Optionally preselect a market. */
  initialSelectedId?: string | null;
}

/**
 * Risk Operations Dashboard view. Renders the testnet badge + wallet network,
 * the market list, and — for the selected market — the risk gauge, trend +
 * oracle price charts, indicator panel, the "Why?" panel, and a stale badge.
 * Subscribes over the WebSocket for live updates. (Req 3.1–3.5, 3.7–3.9)
 *
 * Split out from the provider-wrapped {@link Dashboard} island so it can be
 * tested with injected fakes (no live backend/socket).
 */
export function DashboardView({
  dataClient,
  socketClient,
  walletNetwork = null,
  initialMarkets,
  initialSelectedId = null,
}: DashboardViewProps) {
  const [markets, setMarkets] = useState<MarketSummary[]>(initialMarkets ?? []);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId ?? initialMarkets?.[0]?.id ?? null,
  );
  const [risk, setRisk] = useState<MarketRiskView | null>(null);
  const [stale, setStale] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [trend, setTrend] = useState<RiskPoint[]>([]);
  const [priceTrend, setPriceTrend] = useState<PricePoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<AgentTraceAction | null>(null);

  // Track the selected market across stable socket-listener callbacks.
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;

  // Load the market list once if not seeded. (Req 3.2)
  useEffect(() => {
    if (initialMarkets && initialMarkets.length > 0) return;
    let cancelled = false;
    dataClient
      .listMarkets()
      .then((list) => {
        if (cancelled) return;
        setMarkets(list);
        setSelectedId((current) => current ?? list[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load markets');
      });
    return () => {
      cancelled = true;
    };
  }, [dataClient, initialMarkets]);

  // Load risk for the selected market and reset the per-market trend. (Req 3.3–3.5)
  useEffect(() => {
    if (!selectedId) {
      setRisk(null);
      setTrend([]);
      setPriceTrend([]);
      setStale(false);
      return;
    }
    let cancelled = false;
    dataClient
      .getRisk(selectedId)
      .then((view) => {
        if (cancelled) return;
        setRisk(view);
        setStale(isRiskDataStale(view));
        setTrend(view.riskScore === null ? [] : [{ t: 0, score: view.riskScore }]);
        const price = view.indicators?.oraclePrice;
        setPriceTrend(typeof price === 'number' ? [{ t: 0, price }] : []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load risk');
      });
    return () => {
      cancelled = true;
    };
  }, [dataClient, selectedId]);

  // Load the latest on-chain action for the Agent pipeline trace (last tx
  // digest + Walrus evidence blob + testnet-verified flag). Best-effort: a
  // failure just leaves the execution stages un-hydrated. (Req 3.6)
  useEffect(() => {
    if (!selectedId) {
      setLastAction(null);
      return;
    }
    let cancelled = false;
    dataClient
      .getMarketDetail(selectedId)
      .then((detail) => {
        if (cancelled) return;
        setLastAction({
          actionType: detail.lastAction?.actionType ?? null,
          riskScore: detail.lastAction?.riskScore ?? null,
          txDigest: detail.lastTxDigest ?? null,
          walrusBlobId: detail.lastWalrusBlobId ?? null,
          verifiedTestnet: detail.lastTxDigestVerifiedTestnet ?? false,
        });
      })
      .catch(() => {
        if (!cancelled) setLastAction(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dataClient, selectedId]);
  // Live fallback: poll the selected market's risk on an interval so the
  // oracle keeps refreshing even if the WebSocket drops. The socket still
  // drives faster updates when connected; this guarantees movement otherwise.
  useEffect(() => {
    if (!selectedId) return undefined;
    const timer = setInterval(() => {
      dataClient
        .getRisk(selectedId)
        .then((view) => {
          if (selectedIdRef.current !== selectedId) return;
          setRisk(view);
          setStale(isRiskDataStale(view));
          if (view.riskScore !== null) {
            setTrend((prev) =>
              [...prev, { t: prev.length, score: view.riskScore as number }].slice(-MAX_POINTS),
            );
          }
          const price = view.indicators?.oraclePrice;
          if (typeof price === 'number') {
            setPriceTrend((prev) => [...prev, { t: prev.length, price }].slice(-MAX_POINTS));
          }
        })
        .catch(() => {
          /* transient poll errors are ignored; the socket/next poll recovers */
        });
    }, 15000);
    return () => clearInterval(timer);
  }, [dataClient, selectedId]);

  // Stable handler so the socket listener is registered once. Filters to the
  // currently-selected market via a ref. (Req 3.7)
  const handleMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case 'risk_update': {
        if (message.marketId !== selectedIdRef.current) return;
        const view = snapshotToRiskView(message.snapshot);
        // Preserve the impact figures + live-source provenance across socket
        // updates: the WebSocket snapshot carries the score/indicators but not
        // the protocol-anchored impact/sources (those come from the REST
        // endpoint + the 15s poll). Without this, the TVL cards flicker away on
        // every oracle refresh.
        setRisk((prev) => ({
          ...view,
          impact: view.impact ?? prev?.impact ?? null,
          sources: view.sources ?? prev?.sources ?? null,
        }));
        setStale(false);
        if (view.riskScore !== null) {
          setTrend((prev) =>
            [...prev, { t: prev.length, score: view.riskScore as number }].slice(-MAX_POINTS),
          );
        }
        const price = view.indicators?.oraclePrice;
        if (typeof price === 'number') {
          setPriceTrend((prev) => [...prev, { t: prev.length, price }].slice(-MAX_POINTS));
        }
        break;
      }
      case 'stale_data': {
        if (message.marketId === selectedIdRef.current) setStale(true);
        break;
      }
      case 'guardian_revoked': {
        setMarkets((prev) =>
          prev.map((m) => (m.id === message.marketId ? { ...m, status: 'Revoked' } : m)),
        );
        if (message.marketId === selectedIdRef.current) {
          setRisk((prev) => (prev ? { ...prev, status: 'Revoked' } : prev));
        }
        break;
      }
      // action_executed / override_applied are surfaced on the market detail
      // page (task 16.2); ignored here.
      default:
        break;
    }
  }, []);

  useRiskSocket(socketClient, selectedId, handleMessage);

  const selectedMarket = markets.find((m) => m.id === selectedId) ?? null;

  return (
    <section className="dashboard" data-testid="dashboard">
      <header className="dashboard__header">
        {/* Sui Testnet badge + connected wallet network status. (Req 3.1) */}
        <span className="network-badge network-badge--ok" data-testid="testnet-badge">
          {SUI_TESTNET_LABEL}
        </span>
        <NetworkBadge network={walletNetwork} />
      </header>

      {error ? (
        <p className="dashboard__error" role="alert" data-testid="dashboard-error">
          {error}
        </p>
      ) : null}

      <div className="dashboard__layout">
        <aside className="dashboard__sidebar">
          <h3 className="dashboard__heading">Markets</h3>
          <MarketList markets={markets} selectedId={selectedId} onSelect={setSelectedId} />
        </aside>

        <div className="dashboard__main">
          {selectedMarket === null ? (
            <p className="dashboard__hint" data-testid="dashboard-no-selection">
              Select a market to view its risk profile.
            </p>
          ) : (
            <>
              <div className="dashboard__title-row">
                <h2 className="dashboard__market-name" data-testid="selected-market-name">
                  {selectedMarket.name}
                </h2>
                <StaleBadge stale={stale} />
              </div>

              <ImpactStrip impact={risk?.impact} />
              <ResponseFlow
                recommendedAction={risk?.recommendedAction}
                mitigationActive={risk?.impact?.mitigationActive}
              />

              <div className="dashboard__gauge-row">
                <RiskScoreGauge score={risk?.riskScore ?? null} band={risk?.band ?? null} />
                <IndicatorPanel indicators={risk?.indicators ?? null} />
              </div>

              <div className="dashboard__charts">
                <div>
                  <h4 className="dashboard__heading">Risk score trend</h4>
                  <RiskTrendChart data={trend} />
                </div>
                <div>
                  <h4 className="dashboard__heading">Oracle price</h4>
                  <OraclePriceChart data={priceTrend} />
                </div>
              </div>

              <LiveSources sources={risk?.sources} />

              <AgentTrace risk={risk} lastAction={lastAction} />

              <ReplayPanel />

              <WhyPanel
                open={whyOpen}
                onToggle={() => setWhyOpen((o) => !o)}
                explanation={risk?.explanation}
                ruleOutputs={risk?.ruleOutputs}
              />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

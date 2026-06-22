import { useEffect, useState } from 'react';

import { fetchReplay, type ReplayResult } from '../../lib/replayApi';
import { InfoHint } from '../InfoHint';

/** Humanize a snake_case action code for display. */
function humanizeAction(action: string | null): string {
  if (!action) return 'No action';
  return action
    .split('_')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Band → colour for the risk line / score chip. */
function bandColor(band: string): string {
  switch (band) {
    case 'EmergencyPause':
      return '#dc2626';
    case 'ParamAdjust':
      return '#f97316';
    case 'Guarded':
      return '#ea580c';
    case 'Warning':
      return '#d97706';
    default:
      return '#059669';
  }
}

/** A compact dual-line chart: price (down) and risk score (up). */
function ReplayChart({ data }: { data: ReplayResult }) {
  const pts = data.points;
  if (pts.length < 2) return null;
  const W = 560;
  const H = 150;
  const n = pts.length;
  const prices = pts.map((p) => p.price);
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);
  const pRange = pMax - pMin || 1;
  const x = (i: number) => (i / (n - 1)) * W;
  const priceY = (v: number) => H - ((v - pMin) / pRange) * (H - 16) - 8;
  const riskY = (v: number) => H - (v / 100) * (H - 16) - 8;

  const pricePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${priceY(p.price).toFixed(1)}`).join(' ');
  const riskPath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${riskY(p.riskScore).toFixed(1)}`).join(' ');
  const actionIdx = pts.findIndex((p) => p.recommendedAction !== null);

  return (
    <svg className="replay-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${riskPath} L${W},${H} L0,${H} Z`} fill="rgba(220,38,38,0.06)" stroke="none" />
      <path d={pricePath} fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinejoin="round" />
      <path d={riskPath} fill="none" stroke="#dc2626" strokeWidth="2.5" strokeLinejoin="round" />
      {actionIdx >= 0 ? (
        <line
          x1={x(actionIdx)}
          y1={4}
          x2={x(actionIdx)}
          y2={H}
          stroke="#dc2626"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
      ) : null}
    </svg>
  );
}

/**
 * Real-event replay: streams a genuine recorded SUI sell-off through the same
 * deterministic Risk Engine that gates live actions, proving Sentinel detects
 * real market stress (not just synthetic scenarios). (Real-World Application)
 */
export function ReplayPanel() {
  const [data, setData] = useState<ReplayResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchReplay()
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load replay');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return null; // fail quiet — replay is supplementary
  if (!data) {
    return (
      <section className="replay" data-testid="replay-panel">
        <span className="replay__loading">Loading real-event replay…</span>
      </section>
    );
  }

  const { summary } = data;
  const color = bandColor(summary.peakBand);

  return (
    <section className="replay" data-testid="replay-panel">
      <div className="replay__head">
        <div>
          <span className="replay__eyebrow">
            Real event replay
            <InfoHint text="A genuine recorded price series replayed through the same deterministic engine that gates live actions — proving detection on real market data." />
          </span>
          <h3 className="replay__title">{data.title}</h3>
          <p className="replay__desc">{data.description}</p>
        </div>
        <div className={`replay__verdict${summary.wouldHaveActed ? ' replay__verdict--act' : ''}`}>
          {summary.wouldHaveActed ? '✓ Sentinel would have acted' : 'Detected · no action needed'}
        </div>
      </div>

      <ReplayChart data={data} />

      <div className="replay__legend">
        <span><i style={{ background: '#94a3b8' }} /> {data.asset} price</span>
        <span><i style={{ background: '#dc2626' }} /> Risk score</span>
      </div>

      <div className="replay__stats">
        <div className="replay__stat">
          <span className="replay__k">Max drawdown</span>
          <span className="replay__v">{summary.maxDrawdownPct.toFixed(1)}%</span>
        </div>
        <div className="replay__stat">
          <span className="replay__k">Peak risk score</span>
          <span className="replay__v" style={{ color }}>
            {summary.peakRiskScore} · {summary.peakBand}
          </span>
        </div>
        <div className="replay__stat">
          <span className="replay__k">First response</span>
          <span className="replay__v">{humanizeAction(summary.firstActionType)}</span>
        </div>
      </div>

      <p className="replay__method">
        <strong>Source:</strong> {data.source}. <strong>Method:</strong> {data.methodology}
      </p>
    </section>
  );
}

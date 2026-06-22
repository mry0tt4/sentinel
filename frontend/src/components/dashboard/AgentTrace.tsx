import type { MarketRiskView } from '../../lib/dashboardTypes';
import { formatUsdPrice, shortId } from '../../lib/format';
import { InfoHint } from '../InfoHint';

const TX_EXPLORER = 'https://suiscan.xyz/testnet/tx';
const WALRUS = 'https://aggregator.walrus-testnet.walrus.space/v1/blobs';

/** The most recent on-chain action, when one is available for this market. */
export interface AgentTraceAction {
  actionType: string | null;
  riskScore: number | null;
  txDigest: string | null;
  walrusBlobId: string | null;
  /** Network_Guard confirmed the digest originates from Sui Testnet. (Req 1.8) */
  verifiedTestnet: boolean;
}

export interface AgentTraceProps {
  risk?: MarketRiskView | null;
  lastAction?: AgentTraceAction | null;
}

type StageState = 'live' | 'armed' | 'idle' | 'done';

interface Stage {
  key: string;
  label: string;
  desc: string;
  detail?: React.ReactNode;
  state: StageState;
}

function humanizeAction(action: string | null | undefined): string {
  if (!action) return '—';
  return action
    .split('_')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Agent trace — the full autonomous pipeline Sentinel runs on every tick, made
 * legible for judges: observe live data → score → decide within policy bounds →
 * write Walrus evidence → build a server-defined PTB → simulate → submit a
 * network-gated Sui Testnet tx → record the ActionLog → leave the DAO an
 * OverrideCap. The first three stages reflect THIS market's live state; the
 * execution stages link the most recent real on-chain action + evidence when
 * one exists. (Agentic / Technical / Presentation)
 */
export function AgentTrace({ risk, lastAction }: AgentTraceProps) {
  const score = risk?.riskScore ?? null;
  const band = risk?.band ?? null;
  const recommended = risk?.recommendedAction ?? null;
  const decided = recommended != null && recommended !== '';
  const oraclePrice = risk?.indicators?.oraclePrice;
  const oracleMarket = risk?.sources?.oracle?.market ?? 'Pyth';
  const liquidityMarket = risk?.sources?.liquidity?.market ?? 'DeepBook';

  const txDigest = lastAction?.txDigest ?? null;
  const blobId = lastAction?.walrusBlobId ?? null;
  const executed = Boolean(txDigest) && (lastAction?.verifiedTestnet ?? false);

  // The execution half of the pipeline is "done" when a verified on-chain
  // action exists for this market, "armed" when the live score has crossed a
  // threshold (an action is recommended now), else "idle" (monitoring).
  const execState: StageState = executed ? 'done' : decided ? 'armed' : 'idle';

  const stages: Stage[] = [
    {
      key: 'observe',
      label: 'Observe',
      desc: `Live ${oracleMarket} oracle · ${liquidityMarket} liquidity`,
      detail:
        typeof oraclePrice === 'number' ? (
          <span className="agent-trace__metric">{formatUsdPrice(oraclePrice)}</span>
        ) : undefined,
      state: 'live',
    },
    {
      key: 'score',
      label: 'Score',
      desc: 'Deterministic risk engine (0–100)',
      detail:
        score != null ? (
          <span className="agent-trace__metric">
            {score} · {band}
          </span>
        ) : undefined,
      state: 'live',
    },
    {
      key: 'decide',
      label: 'Decide',
      desc: 'Fail-closed policy gate → bounded action',
      detail: (
        <span className="agent-trace__metric">
          {decided ? humanizeAction(recommended) : 'No action — monitoring'}
        </span>
      ),
      state: decided ? 'armed' : 'idle',
    },
    {
      key: 'evidence',
      label: 'Evidence',
      desc: 'Canonical JSON → Walrus (before the tx)',
      detail: blobId ? (
        <a
          className="agent-trace__link"
          href={`${WALRUS}/${blobId}`}
          target="_blank"
          rel="noreferrer"
        >
          blob {shortId(blobId)}
        </a>
      ) : undefined,
      state: execState,
    },
    {
      key: 'build',
      label: 'Build PTB',
      desc: 'Server-defined template: execute_guardian_action',
      state: execState,
    },
    {
      key: 'simulate',
      label: 'Simulate',
      desc: 'Dry-run first; refuse to submit on failure',
      state: execState,
    },
    {
      key: 'submit',
      label: 'Submit',
      desc: 'Network-gated Sui Testnet transaction',
      detail: txDigest ? (
        <a
          className="agent-trace__link"
          href={`${TX_EXPLORER}/${txDigest}`}
          target="_blank"
          rel="noreferrer"
        >
          tx {shortId(txDigest)}
          {executed ? ' ✓' : ''}
        </a>
      ) : undefined,
      state: execState,
    },
    {
      key: 'govern',
      label: 'Record + Govern',
      desc: 'ActionLog recorded · DAO OverrideCap can reverse / retune',
      state: 'live',
    },
  ];

  return (
    <section className="agent-trace" data-testid="agent-trace">
      <div className="agent-trace__head">
        <span className="agent-trace__title">
          Agent pipeline
          <InfoHint text="The autonomous loop Sentinel runs continuously. The AI never holds funds or keys — it can only compose a fixed, server-defined action that the on-chain policy validates, with Walrus evidence written before the transaction and a DAO OverrideCap able to reverse it." />
        </span>
        <span className="agent-trace__status" data-testid="agent-trace-status">
          {executed
            ? 'Last action verified on-chain'
            : decided
              ? 'Threshold crossed — action armed'
              : 'Monitoring — within bounds'}
        </span>
      </div>
      <ol className="agent-trace__stages">
        {stages.map((s, i) => (
          <li
            key={s.key}
            className={`agent-trace__stage agent-trace__stage--${s.state}`}
            data-testid={`agent-stage-${s.key}`}
          >
            <span className="agent-trace__num">{i + 1}</span>
            <span className="agent-trace__body">
              <span className="agent-trace__label">{s.label}</span>
              <span className="agent-trace__desc">{s.desc}</span>
              {s.detail ? <span className="agent-trace__detail">{s.detail}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

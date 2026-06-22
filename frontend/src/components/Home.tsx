import { ConnectButton } from '@mysten/dapp-kit';

import { useSuiWallet } from '../hooks/useSuiWallet';

/** Brand mark reused in the footer. */
function ShieldMark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path d="M12 2.5 4 5.5v6c0 4.5 3.2 8 8 10 4.8-2 8-5.5 8-10v-6L12 2.5Z" fill="url(#bm)" />
      <path
        d="M8.5 12.2l2.4 2.4 4.6-5"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <defs>
        <linearGradient id="bm" x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8474ff" />
          <stop offset="1" stopColor="#4f3fd6" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** Lightdash-style mosaic: dense at the top, tapering to a single block, random shades. */
function HeroBlocks() {
  const cols = 8;
  const rows = 13;
  const s = 24;
  const g = 0;
  // deterministic pseudo-random in [0,1)
  const rand = (a: number, b: number) => {
    const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const palette = [
    '#ede9fe',
    '#ddd6fe',
    '#c4b5fd',
    '#a78bfa',
    '#8b5cf6',
    '#7c6cff',
    '#6d5dfc',
    '#5a4be0',
    '#4f3fd6',
  ];
  type Cell = { x: number; y: number; fill: string; o: number };
  const cells: Cell[] = [];
  for (let r = 0; r < rows; r += 1) {
    const frac = r / (rows - 1); // 0 top → 1 bottom
    // Overall downward trend, but deliberately NON-uniform per row: a
    // deterministic wobble means a row can be wider than the one above it
    // (e.g. 5 → 6 → 4), so the mosaic looks organic rather than a clean ramp.
    const base = cols * Math.pow(1 - frac, 1.15);
    const wobble = (rand(r * 1.7 + 2, 19) - 0.5) * 4.5; // ~±2.25 blocks
    let count = Math.max(0, Math.min(cols, Math.round(base + wobble)));
    if (r === 0) count = Math.max(count, cols - 1); // keep the top edge dense
    if (r === rows - 1) count = 0; // end before the last line
    for (let k = 0; k < count; k += 1) {
      const c = cols - 1 - k; // anchor to the right edge
      // ragged left edge — occasionally drop the leftmost cell of a row
      if (k === count - 1 && count > 1 && rand(r + 5, c + 5) > 0.6) continue;
      const pick = rand(r, c);
      let fill: string;
      if (pick > 0.85)
        fill = '#ffffff'; // some fully white
      else if (pick > 0.7)
        fill = `url(#hbgrad${Math.floor(rand(r + 9, c + 4) * 2)})`; // some gradient
      else fill = palette[Math.floor(rand(r * 3 + 1, c * 7 + 2) * palette.length)] ?? '#6d5dfc';
      const o = fill === '#ffffff' ? 1 : 0.5 + rand(c + 1, r + 1) * 0.5; // random lightness
      cells.push({ x: c * (s + g), y: r * (s + g), fill, o });
    }
  }
  const w = cols * (s + g) - g;
  const h = rows * (s + g) - g;
  return (
    <svg
      className="lp-hero__blocks"
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      aria-hidden="true"
      preserveAspectRatio="xMaxYMin meet"
    >
      <defs>
        <linearGradient id="hbgrad0" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c4b5fd" />
          <stop offset="1" stopColor="#4f3fd6" />
        </linearGradient>
        <linearGradient id="hbgrad1" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#6d5dfc" />
          <stop offset="1" stopColor="#ede9fe" />
        </linearGradient>
      </defs>
      {cells.map((cell, i) => (
        <rect
          key={i}
          x={cell.x}
          y={cell.y}
          width={s}
          height={s}
          fill={cell.fill}
          opacity={cell.o}
        />
      ))}
    </svg>
  );
}

function Spark({ stroke = '#6366f1', d, fillId }: { stroke?: string; d: string; fillId?: string }) {
  return (
    <svg className="mk-spark" viewBox="0 0 220 60" preserveAspectRatio="none" aria-hidden="true">
      {fillId ? (
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={stroke} stopOpacity="0.2" />
            <stop offset="1" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
      ) : null}
      {fillId ? <path d={`${d} L220,60 L0,60 Z`} fill={`url(#${fillId})`} /> : null}
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Gauge({
  pct,
  score,
  band,
  tone = 'ok',
  size = 96,
}: {
  pct: number;
  score: string;
  band: string;
  tone?: 'ok' | 'warn' | 'danger';
  size?: number;
}) {
  const color = tone === 'danger' ? '#dc2626' : tone === 'warn' ? '#d97706' : '#10b981';
  return (
    <div
      className="mk-gauge"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(${color} ${pct}%, #eef1f6 ${pct}% 100%)`,
      }}
      aria-hidden="true"
    >
      <div className="mk-gauge__hole">
        <span className="mk-gauge__score">{score}</span>
        <span className="mk-gauge__band" style={{ color }}>
          {band}
        </span>
      </div>
    </div>
  );
}

/** Tall risk-timeline bar chart for the hero dashboard. */
function RiskBars() {
  // [height%, tone] — a calm stretch, a build-up, a red spike, recovery.
  const bars: Array<[number, 'ok' | 'warn' | 'danger']> = [
    [22, 'ok'],
    [28, 'ok'],
    [25, 'ok'],
    [34, 'ok'],
    [46, 'warn'],
    [52, 'warn'],
    [63, 'warn'],
    [82, 'danger'],
    [95, 'danger'],
    [70, 'warn'],
    [44, 'ok'],
    [31, 'ok'],
  ];
  const color = (t: string) => (t === 'danger' ? '#dc2626' : t === 'warn' ? '#f59e0b' : '#10b981');
  const labels = ['', '', '', '', '', '', '', 'flash crash', '', 'agent paused', '', ''];
  return (
    <div className="mk-bars" aria-hidden="true">
      {bars.map(([h, t], i) => (
        <div className="mk-bars__col" key={i}>
          <div className="mk-bars__bar" style={{ height: `${h}%`, background: color(t) }}>
            {labels[i] ? <span className="mk-bars__tag">{labels[i]}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Full, tall dashboard mockup for the hero (Lightdash-style). */
function HeroDashboard() {
  return (
    <div className="mk-browser mk-hero-dash" aria-hidden="true">
      <div className="mk-browser__bar">
        <span className="mk-browser__dot" />
        <span className="mk-browser__dot" />
        <span className="mk-browser__dot" />
        <span className="mk-browser__url">sentinel.app/dashboard</span>
        <span className="mk-browser__live">
          <span className="lp-dot lp-dot--ok" /> live · Sui Testnet
        </span>
      </div>
      <div className="mk-dash">
        {/* AI assistant row */}
        <div className="mk-ai">
          <span className="mk-ai__bot">
            <ShieldMark size={16} />
          </span>
          <p className="mk-ai__text">
            <b>SUI Lending</b> risk is elevated — utilization 92% and the oracle is stale.
            Recommending a bounded LTV reduction.
          </p>
          <span className="mk-ai__chip">Why did this happen?</span>
          <span className="mk-ai__chip">Show evidence</span>
          <span className="mk-ai__chip mk-ai__chip--hide">Simulate flash crash</span>
        </div>

        <div className="mk-dash__grid">
          <aside className="mk-dash__side">
            <span className="mk-dash__sidehead">Markets</span>
            <div className="mk-dash__market mk-dash__market--sel">
              <span>SUI Lending</span>
              <span className="mk-pill mk-pill--ok">Normal</span>
            </div>
            <div className="mk-dash__market">
              <span>SUI Perps</span>
              <span className="mk-pill mk-pill--warn">Warning</span>
            </div>
            <div className="mk-dash__market">
              <span>USDC Vault</span>
              <span className="mk-pill">Normal</span>
            </div>
            <div className="mk-dash__market">
              <span>haSUI LST</span>
              <span className="mk-pill">Normal</span>
            </div>

            <span className="mk-dash__sidehead" style={{ marginTop: '0.7rem' }}>
              Signals
            </span>
            <div className="mk-side-kv">
              <span>Volatility</span>
              <b>48%</b>
            </div>
            <div className="mk-side-kv">
              <span>Liquidity</span>
              <b className="mk-bad">↓ 55%</b>
            </div>
            <div className="mk-side-kv">
              <span>Oracle age</span>
              <b className="mk-bad">600s</b>
            </div>
            <div className="mk-side-kv">
              <span>Utilization</span>
              <b>0.92</b>
            </div>

            <span className="mk-dash__sidehead" style={{ marginTop: '0.7rem' }}>
              Live sources
            </span>
            <div className="mk-src">Pyth · SUI/USD</div>
            <div className="mk-src">DeepBook · SUI/USDC</div>
            <div className="mk-src">Walrus · evidence</div>
          </aside>

          <div className="mk-dash__main">
            <div className="mk-dash__head">
              <div className="mk-dash__titlewrap">
                <span className="mk-dash__title">SUI Lending</span>
                <span className="mk-pill mk-pill--ok">Normal · 26</span>
              </div>
              <div className="mk-seg">
                <span className="mk-seg__item mk-seg__item--on">1H</span>
                <span className="mk-seg__item">24H</span>
                <span className="mk-seg__item">7D</span>
              </div>
            </div>

            <div className="mk-dash__impact">
              <div className="mk-tile">
                <span className="mk-tile__k">Protected value</span>
                <span className="mk-tile__v">$10.0M</span>
                <span className="mk-tile__d mk-tile__d--ok">▲ guarded</span>
              </div>
              <div className="mk-tile">
                <span className="mk-tile__k">Exposure</span>
                <span className="mk-tile__v">$6.2M</span>
                <span className="mk-tile__d">62% utilization</span>
              </div>
              <div className="mk-tile">
                <span className="mk-tile__k">Loss prevented</span>
                <span className="mk-tile__v">$1.8M</span>
                <span className="mk-tile__d mk-tile__d--ok">▲ this week</span>
              </div>
              <div className="mk-tile mk-tile--gauge">
                <Gauge pct={26} score="26" band="Normal" tone="ok" size={78} />
              </div>
            </div>

            <div className="mk-panel mk-panel--chart">
              <div className="mk-panel__hd">
                <span className="mk-panel__h">Risk score · last 12 intervals</span>
                <div className="mk-legend">
                  <span>
                    <i style={{ background: '#10b981' }} /> Normal
                  </span>
                  <span>
                    <i style={{ background: '#f59e0b' }} /> Warning
                  </span>
                  <span>
                    <i style={{ background: '#dc2626' }} /> Action
                  </span>
                </div>
              </div>
              <RiskBars />
            </div>

            <div className="mk-dash__lower">
              <div className="mk-mini">
                <span className="mk-mini__h">Recent actions</span>
                <div className="mk-act">
                  <span className="mk-act__dot mk-act__dot--ok" />
                  <span className="mk-act__name">pause_new_borrows</span>
                  <span className="mk-act__t">3s ago</span>
                  <span className="mk-pill mk-pill--ok">executed</span>
                </div>
                <div className="mk-act">
                  <span className="mk-act__dot mk-act__dot--warn" />
                  <span className="mk-act__name">reduce_max_ltv</span>
                  <span className="mk-act__t">2m ago</span>
                  <span className="mk-pill mk-pill--warn">bounded</span>
                </div>
                <div className="mk-act">
                  <span className="mk-act__dot" />
                  <span className="mk-act__name">update_thresholds</span>
                  <span className="mk-act__t">14m ago</span>
                  <span className="mk-pill mk-pill--indigo">logged</span>
                </div>
              </div>
              <div className="mk-mini">
                <span className="mk-mini__h">Policy bounds</span>
                <div className="mk-bound">
                  <span>Max LTV Δ</span>
                  <div className="mk-meter">
                    <i style={{ width: '40%' }} />
                  </div>
                  <b>1000</b>
                </div>
                <div className="mk-bound">
                  <span>Pause</span>
                  <div className="mk-meter">
                    <i style={{ width: '25%' }} />
                  </div>
                  <b>1h</b>
                </div>
                <div className="mk-bound">
                  <span>Cooldown</span>
                  <div className="mk-meter">
                    <i style={{ width: '15%' }} />
                  </div>
                  <b>5m</b>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Home() {
  const { connected, address } = useSuiWallet();
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;

  const PrimaryCta = connected ? (
    <a className="btn btn--primary btn--lg" href="/dashboard">
      Open Risk Dashboard →
    </a>
  ) : (
    <div className="lp-connect">
      <ConnectButton connectText="Connect Wallet to Start" />
    </div>
  );

  return (
    <div className="lp">
      <div className="lp-frame">
        {/* ---------------------------------------------------------------- Hero */}
        <section className="lp-hero">
          <div className="lp-hero__blockwrap" aria-hidden="true">
            <HeroBlocks />
          </div>
          <div className="lp-hero__copy">
            <h1 className="lp-hero__title">
              The autonomous risk layer for <span className="lp-grad">Sui DeFi</span>
            </h1>
            <p className="lp-hero__sub">
              Sentinel watches your markets in real time, scores risk with a deterministic engine,
              and executes <strong>bounded</strong> on-chain safety actions in seconds — every
              decision provable on Walrus.
            </p>
            <div className="lp-hero__cta">
              {PrimaryCta}
              <a className="btn btn--ghost btn--lg" href="/simulator">
                Try live demo
              </a>
            </div>
            <p className="lp-hero__note">
              {connected ? (
                <>
                  <span className="lp-dot lp-dot--ok" /> Wallet connected · {short}
                </>
              ) : (
                'No signup. Connect a Sui Testnet wallet to explore the live system.'
              )}
            </p>
          </div>

          <div className="lp-hero__stage">
            <div className="lp-hero__dots" aria-hidden="true" />
            <div className="lp-hero__mockwrap">
              <HeroDashboard />
            </div>
          </div>
        </section>

        {/* trust strip */}
        <div className="lp-trust">
          <span className="lp-trust__label">Built on real Sui infrastructure</span>
          <div className="lp-trust__row">
            <span className="lp-trust__item">Sui Move</span>
            <span className="lp-trust__sep" />
            <span className="lp-trust__item">Pyth</span>
            <span className="lp-trust__sep" />
            <span className="lp-trust__item">DeepBook</span>
            <span className="lp-trust__sep" />
            <span className="lp-trust__item">Walrus</span>
            <span className="lp-trust__sep" />
            <span className="lp-trust__item">DeepSeek</span>
          </div>
        </div>

        {/* --------------------------------------------------------------- Stats */}
        <section className="lp-stats">
          <div className="lp-stat">
            <span className="lp-stat__value">$10.0M</span>
            <span className="lp-stat__label">Value protected</span>
          </div>
          <div className="lp-stat">
            <span className="lp-stat__value">~3s</span>
            <span className="lp-stat__label">Detect → on-chain action</span>
          </div>
          <div className="lp-stat">
            <span className="lp-stat__value">100%</span>
            <span className="lp-stat__label">Actions bounded on-chain</span>
          </div>
          <div className="lp-stat">
            <span className="lp-stat__value">0</span>
            <span className="lp-stat__label">Funds the agent can move</span>
          </div>
        </section>

        {/* ---------------------------------------------------------------- Bento */}
        <div className="lp-section-head">
          <h2>A guardian that acts — but only within the rails you set</h2>
          <p>
            Four pieces work together so autonomy is fast where it helps and impossible where it
            shouldn't be.
          </p>
        </div>

        <div className="lp-bento">
          {/* Card 1 — monitoring */}
          <article className="bento bento--slate">
            <div className="bento__head">
              <h3>See risk before it cascades</h3>
              <p>Live Pyth prices and DeepBook liquidity, scored 0–100 every few seconds.</p>
            </div>
            <div className="bento__art">
              <div className="mk-card mk-monitor">
                <div className="mk-card__hd">
                  <span className="mk-tag mk-tag--indigo">SUI Lending</span>
                  <span className="mk-tag mk-tag--warn">● Warning</span>
                </div>
                <div className="mk-monitor__top">
                  <Gauge pct={62} score="62" band="ParamAdjust" tone="warn" size={92} />
                  <div className="mk-kv mk-kv--sm">
                    <div className="mk-kv__row">
                      <span>Volatility</span>
                      <b>48%</b>
                    </div>
                    <div className="mk-kv__row">
                      <span>Liquidity</span>
                      <b>↓ 55%</b>
                    </div>
                    <div className="mk-kv__row">
                      <span>Oracle</span>
                      <b className="mk-bad">stale 600s</b>
                    </div>
                    <div className="mk-kv__row">
                      <span>Utilization</span>
                      <b>0.92</b>
                    </div>
                  </div>
                </div>
                <div className="mk-monitor__chart">
                  <span className="mk-panel__h">Risk score · last 12 intervals</span>
                  <Spark
                    d="M0,54 L24,52 L48,48 L72,44 L96,30 L120,16 L144,20 L168,34 L196,42 L220,46"
                    stroke="#6366f1"
                    fillId="bm1"
                  />
                </div>
                <div className="mk-monitor__feet">
                  <span className="mk-src">Pyth</span>
                  <span className="mk-src">DeepBook</span>
                  <span className="mk-src">updated 3s ago</span>
                </div>
              </div>
            </div>
          </article>

          {/* Card 2 — bounded policy */}
          <article className="bento bento--indigo">
            <div className="bento__head">
              <h3>Act within on-chain limits</h3>
              <p>A Sui Move policy + capability caps every action.</p>
            </div>
            <div className="bento__art">
              <div className="mk-card">
                <div className="mk-card__hd">
                  <span className="mk-tag mk-tag--indigo">RiskPolicy</span>
                  <span className="mk-tag mk-tag--ok">✓ within bounds</span>
                </div>
                <div className="mk-bound">
                  <span>Max LTV Δ</span>
                  <div className="mk-meter">
                    <i style={{ width: '40%' }} />
                  </div>
                  <b>1000 / 2500</b>
                </div>
                <div className="mk-bound">
                  <span>Pause limit</span>
                  <div className="mk-meter">
                    <i style={{ width: '25%' }} />
                  </div>
                  <b>1h / 7d</b>
                </div>
                <div className="mk-bound">
                  <span>Cooldown</span>
                  <div className="mk-meter">
                    <i style={{ width: '15%' }} />
                  </div>
                  <b>5m</b>
                </div>
                <div className="mk-bound">
                  <span>Margin Δ</span>
                  <div className="mk-meter mk-meter--off">
                    <i style={{ width: '0%' }} />
                  </div>
                  <b>blocked</b>
                </div>
                <div className="mk-cap">
                  <span className="mk-cap__dot" /> GuardianCap · agent 0xa054…d4b4
                </div>
                <div className="mk-policy-foot">Enforced on-chain · Sui Move</div>
              </div>
            </div>
          </article>

          {/* Card 3 — deterministic / AI explains */}
          <article className="bento bento--mint">
            <div className="bento__head">
              <h3>AI explains, never decides</h3>
              <p>Deterministic gate. The model is strictly advisory.</p>
            </div>
            <div className="bento__art">
              <div className="mk-card">
                <div className="mk-card__hd">
                  <span className="mk-why">
                    Why? <span className="mk-tag mk-tag--muted">advisory</span>
                  </span>
                  <span className="mk-tag mk-tag--muted">DeepSeek</span>
                </div>
                <p className="mk-why__text">
                  Score <b>62</b> — utilization is high and the oracle is stale; recommending a
                  bounded LTV reduction within policy. Liquidity remains adequate.
                </p>
                <div className="mk-rule mk-rule--fired">
                  <span>utilization_high</span>
                  <b>0.92</b>
                </div>
                <div className="mk-rule mk-rule--fired">
                  <span>oracle_stale</span>
                  <b>600s</b>
                </div>
                <div className="mk-rule">
                  <span>liquidity_ok</span>
                  <b>—</b>
                </div>
                <div className="mk-rule">
                  <span>peg_ok</span>
                  <b>—</b>
                </div>
                <div className="mk-why__foot">Deterministic score · the model never decides</div>
              </div>
            </div>
          </article>

          {/* Card 4 — evidence + override */}
          <article className="bento bento--cyan">
            <div className="bento__head">
              <h3>Every action, provable forever</h3>
              <p>
                Evidence on Walrus, linked to the on-chain ActionLog — and your DAO can reverse it.
              </p>
            </div>
            <div className="bento__art">
              <div className="mk-card mk-card--evidence">
                <span className="mk-tag mk-tag--ok">● pause_new_borrows · executed</span>
                <div className="mk-evi__row">
                  <span>actor</span>
                  <code>agent · GuardianCap</code>
                </div>
                <div className="mk-evi__row">
                  <span>tx</span>
                  <code>9rro5erj…dM2S</code>
                  <span className="mk-pill mk-pill--ok">testnet ✓</span>
                </div>
                <div className="mk-evi__row">
                  <span>evidence</span>
                  <code>5Tw0tB3X…qL_8</code>
                  <span className="mk-pill mk-pill--indigo">Walrus</span>
                </div>
                <div className="mk-evi__row">
                  <span>hash</span>
                  <code>e4c5fe61…edcc</code>
                </div>
                <div className="mk-override">
                  <span className="mk-override__h">Override console · DAO</span>
                  <div className="mk-override__btns">
                    <span className="mk-btn">Reverse</span>
                    <span className="mk-btn">Unpause</span>
                    <span className="mk-btn mk-btn--primary">Confirm</span>
                  </div>
                </div>
              </div>
            </div>
          </article>
        </div>

        {/* ---------------------------------------------------------- How it works */}
        <div className="lp-section-head">
          <h2>From signal to provable action in seconds</h2>
          <p>Detect, score, act, and prove — every step bounded on-chain and reproducible.</p>
        </div>
        <ol className="lp-how">
          {/* 01 — Detect */}
          <li className="lp-how__step">
            <div className="lp-how__art">
              <div className="howg">
                <div className="howg__row">
                  <span className="mk-src">Pyth · SUI/USD</span>
                  <span className="mk-pill mk-pill--ok">live</span>
                </div>
                <div className="howg__row">
                  <span className="mk-src">DeepBook · SUI/USDC</span>
                  <span className="mk-pill mk-pill--ok">live</span>
                </div>
                <div className="howg__chart">
                  <span className="mk-panel__h">Oracle price · SUI/USD</span>
                  <Spark
                    d="M0,46 L24,44 L48,40 L72,42 L96,32 L120,24 L144,28 L168,20 L196,26 L220,18"
                    stroke="#6d5dfc"
                    fillId="hg1"
                  />
                </div>
              </div>
            </div>
            <div className="lp-how__body">
              <span className="lp-how__n">01</span>
              <h4>Detect</h4>
              <p>
                Live Pyth prices and DeepBook liquidity stream market conditions into the engine
                continuously.
              </p>
            </div>
          </li>

          {/* 02 — Score */}
          <li className="lp-how__step">
            <div className="lp-how__art">
              <div className="howg howg--center">
                <Gauge pct={62} score="62" band="Warning" tone="warn" size={72} />
                <div className="howg__rules">
                  <div className="mk-rule mk-rule--fired">
                    <span>utilization_high</span>
                    <b>0.92</b>
                  </div>
                  <div className="mk-rule mk-rule--fired">
                    <span>oracle_stale</span>
                    <b>600s</b>
                  </div>
                  <div className="mk-rule">
                    <span>peg_ok</span>
                    <b>—</b>
                  </div>
                </div>
              </div>
            </div>
            <div className="lp-how__body">
              <span className="lp-how__n">02</span>
              <h4>Score</h4>
              <p>
                A deterministic risk engine grades the market 0–100 every few seconds —
                reproducible, no black box.
              </p>
            </div>
          </li>

          {/* 03 — Act */}
          <li className="lp-how__step">
            <div className="lp-how__art">
              <div className="howg">
                <div className="mk-card__hd">
                  <span className="mk-tag mk-tag--indigo">reduce_max_ltv</span>
                  <span className="mk-tag mk-tag--ok">✓ within bounds</span>
                </div>
                <div className="mk-bound">
                  <span>Max LTV Δ</span>
                  <div className="mk-meter">
                    <i style={{ width: '40%' }} />
                  </div>
                  <b>1000</b>
                </div>
                <div className="mk-bound">
                  <span>Cooldown</span>
                  <div className="mk-meter">
                    <i style={{ width: '15%' }} />
                  </div>
                  <b>5m</b>
                </div>
                <div className="howg__foot">
                  <span className="mk-cap__dot" /> GuardianCap · executed on-chain
                </div>
              </div>
            </div>
            <div className="lp-how__body">
              <span className="lp-how__n">03</span>
              <h4>Act</h4>
              <p>
                When a threshold is crossed, a bounded Move action executes on-chain within the
                policy limits.
              </p>
            </div>
          </li>

          {/* 04 — Prove */}
          <li className="lp-how__step">
            <div className="lp-how__art">
              <div className="howg">
                <span className="mk-tag mk-tag--ok">● pause_new_borrows · executed</span>
                <div className="mk-evi__row">
                  <span>tx</span>
                  <code>9rro5erj…dM2S</code>
                  <span className="mk-pill mk-pill--ok">testnet ✓</span>
                </div>
                <div className="mk-evi__row">
                  <span>evidence</span>
                  <code>5Tw0tB3X…qL_8</code>
                  <span className="mk-pill mk-pill--indigo">Walrus</span>
                </div>
                <div className="mk-evi__row">
                  <span>hash</span>
                  <code>e4c5fe61…edcc</code>
                </div>
              </div>
            </div>
            <div className="lp-how__body">
              <span className="lp-how__n">04</span>
              <h4>Prove</h4>
              <p>
                The evidence bundle lands on Walrus, linked to the on-chain ActionLog — a
                tamper-evident trail.
              </p>
            </div>
          </li>
        </ol>

        {/* ----------------------------------------------------------------- CTA */}
        <section className="lp-final">
          <div className="lp-final__blocks" aria-hidden="true">
            <HeroBlocks />
          </div>
          <div className="lp-final__inner">
            <span className="lp-final__eyebrow">Sui Testnet · live</span>
            <h2 className="lp-final__title">Put a guardian on your market</h2>
            <p className="lp-final__sub">
              Connect a Sui Testnet wallet and watch Sentinel monitor, score, and defend a live
              market — end to end, on-chain, in seconds.
            </p>
            <div className="lp-final__cta">
              {PrimaryCta}
              <a className="btn btn--ghost btn--lg" href="/dashboard">
                Explore the dashboard
              </a>
            </div>
          </div>
        </section>
      </div>

      {/* -------------------------------------------------------------- Footer */}
      <footer className="lp-footer">
        <div className="lp-footer__top">
          <div className="lp-footer__brand">
            <span className="lp-footer__mark">
              <ShieldMark />
            </span>
            <div>
              <span className="lp-footer__name">Sentinel</span>
              <p className="lp-footer__tag">Autonomous, bounded risk control for Sui DeFi.</p>
            </div>
          </div>
          <div className="lp-footer__cols">
            <div className="lp-footer__col">
              <span className="lp-footer__h">Product</span>
              <a href="/dashboard">Dashboard</a>
              <a href="/simulator">Simulation Lab</a>
              <a href="/policies/new">New Policy</a>
              <a href="/admin">Override Console</a>
            </div>
            <div className="lp-footer__col">
              <span className="lp-footer__h">Built with</span>
              <span>Sui Move</span>
              <span>Pyth · DeepBook</span>
              <span>Walrus</span>
              <span>DeepSeek</span>
            </div>
            <div className="lp-footer__col">
              <span className="lp-footer__h">Status</span>
              <span className="lp-footer__live">
                <span className="lp-dot lp-dot--ok" /> Live on Sui Testnet
              </span>
              <span>Mainnet disabled</span>
            </div>
          </div>
        </div>
        <div className="lp-footer__bar">
          <span>© {new Date().getFullYear()} Sentinel · Sui Overflow 2026</span>
          <span>Built on Sui · Evidence on Walrus</span>
        </div>
      </footer>
    </div>
  );
}

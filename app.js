'use strict';
/* Trend Bot — phone dashboard. Overview + Value book (active) + Archive (paused
   trade books). Reads the static snapshot JSON the bot publishes
   (data/*.json) and renders it in plain English. No framework, no network beyond
   its own origin — installable + offline via sw.js. */

const DATA = { combined: null, value: null, markets: null, trend: null, crypto: null };
const BOOKS = {
  value:   { label: 'Value',   sub: '75% value ETFs · 25% UK/US stock picks' },
  markets: { label: 'Markets', sub: 'Indices · Gold · FX — trend pullback', paused: true,
             why: 'Paused 13 Nov 2026. After fixing two fill bugs and charging overnight funding, the 5-year backtest came out at about +0.02R per trade — no real edge.' },
  trend:   { label: 'Trend',   sub: '36 ETFs — 100-day breakout, trailing stop', paused: true,
             why: 'Never went live. Loses money as a spread bet once funding is charged; in a plain ETF account it had a small edge that didn’t clearly beat just holding an index fund.' },
  crypto:  { label: 'Crypto',  sub: 'BTC · ETH · SOL · …', paused: true,
             why: 'Paused 13 Nov 2026. Backtest was negative before launch and it went 1 win / 15 losses live — the coins move as one, so it was really a single bet repeated.' },
};
const ARCHIVE = ['markets', 'trend', 'crypto'];
const SERIES = { port: '#3987e5', bench: '#d95926' };   // validated pair (dark surface)
const GATE_TARGET = 30;
let view = localStorage.getItem('tb.view') || 'combined';

/* ---------- tiny helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtR(x, dp = 1) { if (x == null || isNaN(x)) return '—'; return (x >= 0 ? '+' : '') + Number(x).toFixed(dp) + 'R'; }
function fmtPct(x, dp = 1) { if (x == null || isNaN(x)) return '—'; return (x >= 0 ? '+' : '') + Number(x).toFixed(dp) + '%'; }
function signClass(x) { return x > 0 ? 'pos' : x < 0 ? 'neg' : 'flat'; }
function fmtPrice(p) {
  if (p == null || isNaN(p)) return '—';
  const a = Math.abs(p);
  if (a >= 1000) return Number(p).toLocaleString('en', { maximumFractionDigits: 0 });
  if (a >= 100) return Number(p).toLocaleString('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (a >= 1) return Number(p).toFixed(2);
  return Number(p).toPrecision(3);
}
function ago(iso) {
  if (!iso) return { text: 'never', hrs: Infinity };
  const then = new Date(iso).getTime();
  if (isNaN(then)) return { text: 'unknown', hrs: Infinity };
  const mins = Math.max(0, (Date.now() - then) / 60000);
  const hrs = mins / 60;
  let text;
  if (mins < 1) text = 'just now';
  else if (mins < 60) text = `${Math.round(mins)}m ago`;
  else if (hrs < 24) text = `${Math.round(hrs)}h ago`;
  else text = `${Math.round(hrs / 24)}d ago`;
  return { text, hrs };
}
const ICON = {
  up: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 11l4-4 3 3 5-6"/><path d="M14 4h-3.5M14 4v3.5"/></svg>',
  down: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 5l4 4 3-3 5 6"/><path d="M14 12h-3.5M14 12V8.5"/></svg>',
  flatline: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 8h12"/></svg>',
  chev: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3l5 5-5 5"/></svg>',
  warn: '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2L1 14h14L8 2z"/><path d="M8 6.5v3.5M8 12h.01"/></svg>',
  chart: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 20l5-6 4 3 5-8 4 5"/><path d="M3 3v18h18"/></svg>',
  ring: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
};
const COIN = { Bitcoin: '₿', Ethereum: 'Ξ', Solana: '◎', XRP: 'X', Litecoin: 'Ł', Cardano: '₳', Dogecoin: 'Ð', Avalanche: 'A' };

/* ---------- staleness (single rule for all books) ---------- */
function freshness(iso) {           // check-ins are ~3.5 days apart
  const a = ago(iso);
  const cls = a.hrs > 120 ? 'stale' : a.hrs > 96 ? 'warn' : '';
  return { text: a.text, cls, stale: a.hrs > 120 };
}

/* ---------- equity chart ---------- */
function equitySVG(cumSeries) {
  const pts = [0, ...cumSeries];              // start the line at 0R
  if (pts.length < 2) return '';
  const W = 358, H = 128, pad = 8;
  const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts);
  const span = (hi - lo) || 1;
  const x = i => (i / (pts.length - 1)) * W;
  const y = v => pad + (1 - (v - lo) / span) * (H - 2 * pad);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const col = last >= 0 ? '#3fb950' : '#f85149';
  const zeroY = y(0).toFixed(1);
  return `<svg class="eq" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Equity curve">
    <defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${col}" stop-opacity="0.18"/><stop offset="1" stop-color="${col}" stop-opacity="0"/>
    </linearGradient></defs>
    <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="#30363d" stroke-width="1" stroke-dasharray="3 4"/>
    <polygon points="${line} ${W},${H} 0,${H}" fill="url(#fill)"/>
    <polyline points="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5" fill="${col}"/>
  </svg>`;
}

/* ---------- shared pieces ---------- */
function betWord(dir) { return dir === 'long' ? 'betting it rises' : 'betting it falls'; }
function dirPill(dir) {
  const up = dir === 'long';
  return `<span class="pill ${up ? 'long' : 'short'}">${up ? ICON.up : ICON.down}${up ? 'rising' : 'falling'}</span>`;
}
function openCard(o, showBook) {
  const r = o.unreal_R, pct = o.return_pct;
  let st = 'on track', stc = '';
  if (r != null && r >= 0.8) { st = 'near target'; stc = 'near'; }
  else if (r != null && r <= -0.7) { st = 'near get-out'; stc = 'risk'; }
  const bookTag = showBook && o.book ? `<span class="pill booktag">${esc(o.book)}</span>` : '';
  const val = pct != null ? fmtPct(pct) : fmtR(r);            // % headline, R + status below
  const sub = pct != null ? `${fmtR(r)} · ${st}` : st;
  const c = el(`<button class="pos-card">
    <div class="body">
      <div class="top"><span class="nm">${esc(o.market)}</span>${dirPill(o.direction)}${bookTag}</div>
      <div class="desc">${betWord(o.direction)}${o.entry_date ? ' · opened ' + esc(o.entry_date) : ''}</div>
    </div>
    <div class="r"><div class="val ${signClass(pct != null ? pct : r)}">${val}</div><div class="st ${stc}">${sub}</div></div>
    <span class="chev">${ICON.chev}</span>
  </button>`);
  c.addEventListener('click', () => openSheet(o));
  return c;
}
function marketRow(m) {
  const icon = m.trend === 'up' ? ICON.up : m.trend === 'down' ? ICON.down : ICON.flatline;
  const iconCol = m.trend === 'up' ? 'var(--green)' : m.trend === 'down' ? 'var(--red)' : 'var(--muted)';
  const tag = { in_trade: ['trade', 'in a trade'], watch: ['watch', 'watch'], no_setup: [m.trend === 'down' ? 'dn' : 'up', 'no setup'], flat: ['fl', 'flat'] }[m.status] || ['fl', m.status];
  const mono = COIN[m.name];
  const ti = mono ? `<span class="ti" style="color:${iconCol}">${mono}</span>` : `<span class="ti" style="color:${iconCol}">${icon}</span>`;
  return `<div class="mkt">${ti}
    <div class="body"><div class="nm">${esc(m.name)}</div><div class="desc">${esc(m.plain)}</div></div>
    <span class="tag ${tag[0]}">${tag[1]}</span></div>`;
}
function closedTable(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.slice(0, 8).map(t => {
    const act = t.actual_return_pct, exp = t.expected_return_pct;
    const headline = act != null ? fmtPct(act) : fmtR(t.outcome_R, 2);
    const sub = act != null
      ? `<div class="why">expected ${fmtPct(exp)} · ${fmtR(t.outcome_R, 2)}</div>`
      : '';
    return `<tr>
      <td class="nm">${esc(t.market)} <span class="pill ${t.direction === 'long' ? 'long' : 'short'}" style="margin-left:4px">${t.direction}</span>
        <div class="why">${esc(t.reason)}</div></td>
      <td class="r ${signClass(act != null ? act : t.outcome_R)}">${headline}${sub}</td></tr>`;
  }).join('');
  return `<div class="list2"><table>${body}</table></div>`;
}
function sampleGate(n, target) {
  if (n >= target) return '';
  const pct = Math.round(Math.min(1, n / target) * 100);
  return `<div class="gate"><span class="ic">${ICON.warn}</span>
    <div class="t"><b>Still early — ${n} of ${target} trades.</b> Not enough yet to call the strategy good or bad; the bot keeps its verdicts to itself until the sample means something.
    <div class="bar"><i style="width:${pct}%"></i></div></div></div>`;
}

/* ---------- value pieces ---------- */
function money(x) { return x == null ? '—' : '£' + Number(x).toLocaleString('en-GB', { maximumFractionDigits: 0 }); }
function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/* Two-line chart: portfolio vs world index, % since start. One axis (both are %),
   legend + end labels, crosshair tooltip on hover/touch, table fallback. */
function vsChart(history) {
  const pts = (history || []).filter(h => h.port_pct != null);
  if (pts.length < 2) {
    return `<div class="empty"><span class="g">${ICON.chart}</span><div class="h">The chart starts after the next check-in</div>
      <div class="p">One point so far — each Wednesday and Sunday check-in adds one.</div></div>`;
  }
  const W = 358, H = 150, padY = 12, padR = 44;
  const vals = pts.flatMap(p => [p.port_pct, p.bench_pct]).filter(v => v != null);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = (hi - lo) || 1;
  const x = i => (i / (pts.length - 1)) * (W - padR);
  const y = v => padY + (1 - (v - lo) / span) * (H - 2 * padY);
  const line = k => pts.map((p, i) => p[k] == null ? null : `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).filter(Boolean).join(' ');
  const last = pts[pts.length - 1];
  const lab = (k, name) => last[k] == null ? '' :
    `<text x="${(x(pts.length - 1) + 6).toFixed(1)}" y="${(y(last[k]) + 4).toFixed(1)}" class="endlab">${name}</text>`;
  const rows = pts.map(p => `<tr><td>${esc(p.date)}</td><td class="r">${fmtPct(p.port_pct)}</td><td class="r">${fmtPct(p.bench_pct)}</td></tr>`).join('');
  return `<div class="legend"><span><i style="background:${SERIES.port}"></i>Your portfolio</span><span><i style="background:${SERIES.bench}"></i>World index</span></div>
    <div class="chartwrap" data-pts='${esc(JSON.stringify(pts))}'>
    <svg class="eq vs" viewBox="0 0 ${W} ${H}" role="img" aria-label="Portfolio vs world index, percent since start">
      <line x1="0" y1="${y(0).toFixed(1)}" x2="${W - padR}" y2="${y(0).toFixed(1)}" stroke="#30363d" stroke-width="1" stroke-dasharray="3 4"/>
      <polyline points="${line('bench_pct')}" fill="none" stroke="${SERIES.bench}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <polyline points="${line('port_pct')}" fill="none" stroke="${SERIES.port}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${lab('bench_pct', 'Index')}${lab('port_pct', 'You')}
      <line class="xh" x1="0" y1="0" x2="0" y2="${H}" stroke="#8b949e" stroke-width="1" visibility="hidden"/>
      <rect class="hit" x="0" y="0" width="${W - padR}" height="${H}" fill="transparent"/>
    </svg><div class="tip" hidden></div></div>
    <details class="tbl"><summary>Show as table</summary><table><tr><th>Date</th><th class="r">You</th><th class="r">Index</th></tr>${rows}</table></details>`;
}
function wireChart(root) {
  root.querySelectorAll('.chartwrap').forEach(w => {
    const pts = JSON.parse(w.dataset.pts), svg = w.querySelector('svg'), tip = w.querySelector('.tip'), xh = w.querySelector('.xh');
    const W = 358, padR = 44;
    const move = ev => {
      const r = svg.getBoundingClientRect();
      const cx = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) / r.width * W;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(cx / (W - padR) * (pts.length - 1))));
      const px = i / (pts.length - 1) * (W - padR);
      xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('visibility', 'visible');
      const p = pts[i];
      tip.innerHTML = `<b>${esc(p.date)}</b><span><i style="background:${SERIES.port}"></i>You ${fmtPct(p.port_pct)}</span><span><i style="background:${SERIES.bench}"></i>Index ${fmtPct(p.bench_pct)}</span>`;
      tip.hidden = false;
      tip.style.left = Math.min(r.width - 150, Math.max(0, px / W * r.width - 70)) + 'px';
    };
    const hide = () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); };
    const hit = w.querySelector('.hit');
    hit.addEventListener('mousemove', move); hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('touchstart', move, { passive: true });
    hit.addEventListener('mouseleave', hide); hit.addEventListener('touchend', () => setTimeout(hide, 1500));
  });
}

function issueCards(issues) {
  if (!issues || !issues.length) {
    return `<div class="allclear"><span class="ok">✓</span> Nothing needs you — no open bot issues.</div>`;
  }
  const icon = { error: '🛠', change: '💡', review: '🔎' };
  const word = { error: 'Needs a fix', change: 'Suggested change', review: 'Time to review' };
  return issues.map((i, n) => `<section class="issue ${esc(i.kind)}">
    <div class="it"><span>${icon[i.kind] || '•'}</span><div><div class="k">${word[i.kind] || esc(i.kind)}${i.book ? ' · ' + esc(i.book) : ''}</div>
      <div class="ttl">${esc(i.title)}</div>
      <div class="meta">open since ${esc((i.first_seen || '').slice(0, 10))}${i.count > 1 ? ' · seen ' + i.count + '×' : ''}</div></div></div>
    <div class="cmdlab">Hand it to Claude — on the laptop:</div>
    <div class="cmd"><code id="cmd${n}">${esc(i.command)}</code><button class="copy" data-copy="cmd${n}">Copy</button></div>
  </section>`).join('');
}
document.addEventListener('click', async e => {
  const b = e.target.closest('.copy'); if (!b) return;
  const txt = document.getElementById(b.dataset.copy).textContent;
  try { await navigator.clipboard.writeText(txt); b.textContent = 'Copied'; }
  catch (_) { const r = document.createRange(); r.selectNodeContents(document.getElementById(b.dataset.copy)); getSelection().removeAllRanges(); getSelection().addRange(r); b.textContent = 'Selected'; }
  setTimeout(() => { b.textContent = 'Copy'; }, 1800);
});

function holdingRow(h) {
  return `<div class="hold"><div class="body"><div class="nm">${esc(h.name)} <span class="tk">${esc(h.ticker)}</span></div>
    ${h.why ? `<div class="desc">${esc(h.why)}</div>` : ''}<div class="desc dim">${h.weight_pct.toFixed(1)}% of portfolio · since ${esc(h.entry_date)}</div></div>
    <div class="r ${signClass(h.return_pct)}">${fmtPct(h.return_pct)}</div></div>`;
}

function renderValue(root) {
  const d = DATA.value;
  if (!d) { root.append(el('<div class="empty"><div class="h">No Value data yet</div><div class="p">The first check-in publishes it.</div></div>')); return; }
  const h = d.headline || {};
  root.append(el(`<section class="hero-row">
    <div class="l"><div class="k">Value book · paper · since ${esc(h.start_date)}</div>
      <div class="nm">${esc(BOOKS.value.sub)}</div>
      <div class="meta">World index ${fmtPct(h.bench_return_pct)} · you're ${h.vs_bench_pts >= 0 ? 'ahead' : 'behind'} by ${Math.abs(h.vs_bench_pts || 0).toFixed(1)} pts · ${money(h.nav_gbp)} of ${money(h.start_capital)}</div></div>
    <div class="big ${signClass(h.return_pct)}">${fmtPct(h.return_pct)}</div></section>`));

  root.append(el(`<section class="card"><div class="chartcap"><h2 style="margin:0">You vs the world index</h2><span class="v">% since start, dividends in</span></div>${vsChart(d.history)}</section>`));

  if (d.alerts && d.alerts.length) {
    root.append(el(`<div class="flag"><span class="ic">${ICON.warn}</span><div class="t"><b>Buy case weakening.</b> ${d.alerts.map(esc).join('<br>')}<br><span class="dim">The monthly review sells a pick if it stops qualifying.</span></div></div>`));
  }

  const core = (d.holdings || []).filter(x => x.sleeve === 'core');
  const picks = (d.holdings || []).filter(x => x.sleeve === 'pick');
  root.append(el(`<div class="sec"><span class="h">Core ETFs · ${(h.core_pct || 0).toFixed(0)}%</span></div>`));
  root.append(el(`<div class="list">${core.map(holdingRow).join('')}</div>`));
  root.append(el(`<div class="sec"><span class="h">Stock picks · ${(h.picks_pct || 0).toFixed(0)}% · ${h.n_picks || 0} held</span></div>`));
  root.append(el(`<div class="list">${picks.map(holdingRow).join('') || '<div class="hold"><div class="body dim">No picks yet</div></div>'}</div>`));

  const sc = d.screen || {};
  if (sc.top && sc.top.length) {
    root.append(el(`<div class="sec"><span class="h">Latest monthly screen · ${esc(sc.date)}</span></div>`));
    const rows = sc.top.map(t => `<div class="hold"><div class="body"><div class="nm"><span class="rk">${t.rank}</span> ${esc(t.name)} <span class="tk">${esc(t.ticker)}</span>
      ${t.mark === 'held' ? '<span class="tag trade">in portfolio</span>' : t.mark === 'capped' ? '<span class="tag fl">cyclical limit</span>' : ''}</div>
      <div class="desc">${esc(t.sector)} · ${esc(t.why)}</div></div></div>`).join('');
    root.append(el(`<div class="list">${rows}</div>`));
    root.append(el(`<div class="note dim">${sc.qualifying} of the S&P 500 + FTSE 350 passed the filters (${Math.round((sc.coverage || 0) * 100)}% downloaded). “Cyclical limit”: max 2 picks across energy, mining and chip makers — they look cheapest at the top of their cycle.</div>`));
  }

  if (d.trades && d.trades.length) {
    root.append(el('<div class="sec"><span class="h">Recent paper trades</span></div>'));
    root.append(el(`<div class="list">${d.trades.slice(0, 12).map(t => `<div class="hold"><div class="body"><div class="desc"><span class="${t.text.startsWith('SELL') || t.text.startsWith('TRIM') ? 'neg' : 'pos'}">${esc(t.text.split(' ')[0])}</span> ${esc(t.text.split(' ').slice(1).join(' '))}</div></div><div class="r dim mono">${esc(t.date)}</div></div>`).join('')}</div>`));
  }

  const sch = d.schedule || {};
  root.append(el(`<div class="note"><b>Paper only — the bot never trades.</b> Mirror changes in your ISA if you agree. Next check-in ${esc(when(sch.next_checkin))}; next stock screen at the ${esc(sch.next_screen || 'next month')}. Costs modelled: 0.1% per trade + 0.5% UK stamp duty.</div>`));
  wireChart(root);
}

function renderArchive(root) {
  root.append(el(`<div class="note"><b>Archived books.</b> These traded short-term price patterns. After the November 2026 audit none showed an edge once real costs were included, so they're paused. Their full records stay here.</div>`));
  ARCHIVE.forEach(slug => {
    const d = DATA[slug], meta = BOOKS[slug], bh = (d && d.headline) || {};
    const row = el(`<button class="book">
      <span class="ic" style="color:var(--muted)">${slug === 'crypto' ? '₿' : ICON.chart.replace(/width="22" height="22"/, 'width="18" height="18"')}</span>
      <div class="body"><div class="nm">${esc(meta.label)} <span class="tag fl">paused</span></div>
        <div class="meta">${d ? `${d.counts?.closed || 0} closed trades · final ${fmtR(bh.total_R)}` : 'never published'}</div>
        <div class="meta dim">${esc(meta.why)}</div></div>
      <span class="chev">${ICON.chev}</span></button>`);
    row.addEventListener('click', () => switchView(slug));
    root.append(row);
  });
}

/* ---------- views ---------- */
function renderCombined(root) {
  const v = DATA.value, c = DATA.combined || {};
  const h = (v && v.headline) || {};
  if (v) {
    root.append(el(`<section class="card hero">
      <div class="kicker">Value portfolio · paper · since ${esc(h.start_date)}</div>
      <div class="big ${signClass(h.return_pct)}">${fmtPct(h.return_pct)}</div>
      <div class="sub">World index ${fmtPct(h.bench_return_pct)} over the same time — you're ${h.vs_bench_pts >= 0 ? 'ahead' : 'behind'} by ${Math.abs(h.vs_bench_pts || 0).toFixed(1)} pts.</div>
      <div class="facts">
        <div><div class="n">${money(h.nav_gbp)}</div><div class="l">paper value</div></div>
        <div><div class="n">${h.n_picks || 0}</div><div class="l">stock picks</div></div>
        <div><div class="n">${(h.core_pct || 0).toFixed(0)}/${(h.picks_pct || 0).toFixed(0)}</div><div class="l">core / picks %</div></div>
      </div></section>`));
  } else {
    root.append(el('<div class="empty"><div class="h">Value book not published yet</div><div class="p">It appears after the first check-in.</div></div>'));
  }

  const issues = (v && v.issues) || c.issues || [];
  root.append(el(`<div class="sec"><span class="h">Needs attention${issues.length ? ' · ' + issues.length : ''}</span></div>`));
  root.append(el(`<div>${issueCards(issues)}</div>`));

  if (v) {
    root.append(el(`<section class="card"><div class="chartcap"><h2 style="margin:0">You vs the world index</h2><span class="v">% since start</span></div>${vsChart(v.history)}</section>`));
    wireChart(root);
  }

  const sch = (v && v.schedule) || c.schedule;
  if (sch) {
    root.append(el(`<div class="note">🗓 <b>Next check-in:</b> ${esc(when(sch.next_checkin))} (every ${esc((sch.checkin_days || []).map(x => x[0].toUpperCase() + x.slice(1)).join(' + '))}, or as soon as the laptop wakes). <b>Next stock screen:</b> ${esc(sch.next_screen)}.</div>`));
  }

  root.append(el('<div class="sec"><span class="h">Books</span></div>'));
  const vrow = el(`<button class="book"><span class="ic" style="color:var(--blue)">${ICON.chart.replace(/width="22" height="22"/, 'width="18" height="18"')}</span>
    <div class="body"><div class="nm">Value <span class="tag trade">active</span></div><div class="meta">${esc(BOOKS.value.sub)}</div></div>
    <div class="r ${signClass(h.return_pct)}">${fmtPct(h.return_pct)}</div><span class="chev">${ICON.chev}</span></button>`);
  vrow.addEventListener('click', () => switchView('value'));
  root.append(vrow);
  const arow = el(`<button class="book"><span class="ic" style="color:var(--muted)">${ICON.ring.replace(/width="22" height="22"/, 'width="18" height="18"')}</span>
    <div class="body"><div class="nm">Archive <span class="tag fl">paused</span></div><div class="meta">Markets · Trend · Crypto — no edge after costs</div></div>
    <span class="chev">${ICON.chev}</span></button>`);
  arow.addEventListener('click', () => switchView('archive'));
  root.append(arow);
}

function renderBook(root, slug) {
  const d = DATA[slug];
  const label = (BOOKS[slug] || {}).label || slug;
  if (!d) { root.append(el(`<div class="empty"><div class="h">No ${esc(label)} data yet</div><div class="p">This book hasn’t published a snapshot.</div></div>`)); return; }
  if ((BOOKS[slug] || {}).paused) {
    root.append(el(`<div class="flag"><span class="ic">${ICON.warn}</span><div class="t"><b>Paused — record only.</b> ${esc(BOOKS[slug].why)} <a href="#" class="back">Back to archive</a></div></div>`));
    root.querySelector('.back').addEventListener('click', e => { e.preventDefault(); switchView('archive'); });
  }
  const h = d.headline || {}; const n = h.n || 0;
  const wentRight = n ? `${Math.round((h.win_rate || 0) / 100 * n)} of ${n} went right` : 'no closed trades yet';

  root.append(el(`<section class="hero-row">
    <div class="l"><div class="k">${esc(label)} book · paper</div>
      <div class="nm">${esc((BOOKS[slug] || {}).sub || '')}</div>
      <div class="meta">${d.counts?.closed || 0} closed · ${d.counts?.open || 0} open · ${wentRight}</div></div>
    <div class="big ${signClass(h.total_R)}">${fmtR(h.total_R)}</div></section>`));

  if (slug === 'crypto' && d.correlated_book) {
    root.append(el(`<div class="flag purple"><span class="ic">${ICON.warn.replace('stroke-width="1.5"', 'stroke-width="1.4"')}</span>
      <div class="t"><b>These move together.</b> Bitcoin, Ether and the rest usually rise and fall as one, so several open crypto trades act more like a single larger bet than separate ones — worth remembering when the numbers look strong.</div></div>`));
  }

  const g = sampleGate(n, d.sample_gate?.target || GATE_TARGET); if (g) root.append(el(g));

  const cum = (d.equity || []).map(e => e.cum_R);
  if (cum.length) {
    root.append(el(`<section class="card"><div class="chartcap"><h2 style="margin:0">${esc(label)} equity</h2><span class="v">running total, in R</span></div>${equitySVG(cum)}<div class="axis"><span>start</span><span class="${signClass(h.total_R)}">${fmtR(h.total_R)}</span></div></section>`));
  }

  if (d.markets && d.markets.length) {
    root.append(el('<div class="sec"><span class="h">Where each market sits right now</span></div>'));
    root.append(el(`<div class="list">${d.markets.map(marketRow).join('')}</div>`));
  }

  const opens = d.open || [];
  root.append(el('<div class="sec"><span class="h">Open positions</span></div>'));
  if (opens.length) opens.forEach(o => root.append(openCard(o, false)));
  else root.append(el(`<section class="card"><div class="empty"><span class="g">${ICON.ring}</span><div class="h">Nothing open right now</div><div class="p">By design — the strategy waits for a clean setup and stays out in between.</div></div></section>`));

  const ct = closedTable(d.closed);
  if (ct) { root.append(el('<div class="sec"><span class="h">Recently closed</span></div>')); root.append(el(ct)); }

  const note = slug === 'crypto'
    ? '<b>No money limits.</b> Every crypto signal is logged as a paper trade and shown per share as a % return (expected vs actual on close). Because crypto trades weekends, this book updates daily, just after midnight UTC.'
    : '<b>No money limits.</b> Every valid signal is logged as a paper trade and shown per share as a % return — expected vs actual on close. Nothing here places a real order or moves real money.';
  root.append(el(`<div class="note">${note}</div>`));
}

/* ---------- position detail sheet ---------- */
function openSheet(o) {
  const up = o.direction === 'long';
  const r = o.unreal_R;
  const rr = (o.target != null && o.stop != null && o.entry != null && (o.entry - o.stop))
    ? Math.round(Math.abs(o.target - o.entry) / Math.abs(o.entry - o.stop)) : 2;
  let pos = 50;
  if (o.price != null && o.stop != null && o.target != null && (o.target - o.stop)) {
    pos = ((o.price - o.stop) / (o.target - o.stop)) * 100;
    if (!up) pos = 100 - pos;
    pos = Math.max(4, Math.min(96, pos));
  }
  let lab = 'on track', labc = 'flat';
  if (r != null && r >= 0.8) { lab = 'near the target'; labc = 'pos'; }
  else if (r != null && r <= -0.7) { lab = 'near the get-out'; labc = 'neg'; }
  const days = o.entry_date ? Math.max(0, Math.round((Date.now() - new Date(o.entry_date).getTime()) / 86400000)) : null;

  $('#sheetPanel').innerHTML = `
    <div class="grab"></div>
    <div class="d-head"><span class="nm">${esc(o.market)}</span>${dirPill(o.direction)}${o.book ? `<span class="pill booktag">${esc(o.book)}</span>` : ''}</div>
    <div class="d-say">Betting ${esc(o.market)} keeps ${up ? 'rising' : 'falling'}${o.entry_date ? '. Opened ' + esc(o.entry_date) : ''}.</div>
    <div class="result"><span class="big ${signClass(o.return_pct != null ? o.return_pct : r)}">${o.return_pct != null ? fmtPct(o.return_pct) : fmtR(r)}</span><span class="${labc}" style="font-size:12px">${r != null ? fmtR(r) + ' · ' : ''}${lab}</span></div>
    <div class="track"><span class="now" style="left:${pos}%"></span></div>
    <div class="ends"><span class="s">Get out ${fmtPrice(o.stop)}<span class="sub">−1R · exits if wrong</span></span>
      <span class="t">Target ${fmtPrice(o.target)}<span class="sub">+${rr}R · exits if right</span></span></div>
    <div class="grid">
      <div class="cell"><div class="l">Price per share now</div><div class="v">${fmtPrice(o.price)}</div></div>
      <div class="cell"><div class="l">Bought at</div><div class="v">${fmtPrice(o.entry)}</div></div>
      <div class="cell"><div class="l">Expected return</div><div class="v pos">${fmtPct(o.expected_return_pct)} <span style="color:var(--dim);font-size:12px">+${rr}R</span></div></div>
      <div class="cell"><div class="l">Return so far</div><div class="v ${signClass(o.return_pct)}">${fmtPct(o.return_pct)}</div></div>
      ${days != null ? `<div class="cell"><div class="l">Days held</div><div class="v">${days} / 20</div></div><div class="cell"><div class="l">Payoff</div><div class="v">${rr}:1</div></div>` : ''}
    </div>
    <h2 style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px">What happens next</h2>
    <ul class="steps">
      <li><span class="dt t"></span><div>Closes for a <b>+${rr}R</b> win if it reaches ${fmtPrice(o.target)}.</div></li>
      <li><span class="dt s"></span><div>Closes for a <b>−1R</b> loss if it falls to ${fmtPrice(o.stop)}.</div></li>
      <li><span class="dt x"></span><div>Closes automatically after its time limit if neither is hit — banking wherever it stands.</div></li>
    </ul>`;
  $('#sheet').classList.add('open');
}
function closeSheet() { $('#sheet').classList.remove('open'); }

/* ---------- shell ---------- */
function render() {
  const tab = ARCHIVE.includes(view) ? 'archive' : view;
  document.querySelectorAll('#seg button').forEach(b => b.classList.toggle('on', b.dataset.view === tab));
  const main = $('#main'); main.innerHTML = '';

  // staleness follows the ACTIVE book; paused books are a frozen record, not stale
  const paused = ARCHIVE.includes(view) || view === 'archive';
  const src = DATA.value || DATA.combined;
  const f = freshness(src && src.generated_at);
  const fresh = $('#fresh'); fresh.className = 'fresh ' + (paused ? '' : f.cls);
  $('#stamp').textContent = paused ? 'archived' : 'updated ' + f.text;
  if (f.stale && !paused) {
    main.append(el(`<div class="stale-banner"><span class="ic">${ICON.warn}</span>
      <div><b>This is ${esc(f.text.replace(' ago', ''))} old.</b>
      <span class="sub">Check-ins are Wednesday and Sunday, so up to ~4 days is normal. Older than that: the laptop may have been off, or the last publish didn’t go through.</span></div></div>`));
  }

  if (view === 'combined') renderCombined(main);
  else if (view === 'value') renderValue(main);
  else if (view === 'archive') renderArchive(main);
  else renderBook(main, view);
}
function switchView(v) { view = v; localStorage.setItem('tb.view', v); closeSheet(); render(); window.scrollTo(0, 0); }

async function load(bust) {
  const opt = bust ? { cache: 'no-store' } : {};
  const files = { combined: 'combined', value: 'value', markets: 'markets', trend: 'trend', crypto: 'crypto' };
  await Promise.all(Object.entries(files).map(async ([k, name]) => {
    try {
      const res = await fetch(`./data/${name}.json${bust ? '?t=' + Date.now() : ''}`, opt);
      if (res.ok) DATA[k] = await res.json();
    } catch (e) { /* keep whatever the cache had */ }
  }));
  render();
}

document.addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
$('#seg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) switchView(b.dataset.view); });
$('#refresh').addEventListener('click', async () => {
  const btn = $('#refresh'); btn.firstElementChild.classList.add('spin');
  await load(true); btn.firstElementChild.classList.remove('spin');
});

load(false);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

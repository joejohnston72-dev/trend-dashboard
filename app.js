'use strict';
/* Trend Bot — phone dashboard. Reads the static snapshot JSON the bot publishes
   (data/*.json) and renders it in plain English. No framework, no network beyond
   its own origin — installable + offline via sw.js. */

const DATA = { combined: null, markets: null, crypto: null };
const GATE_TARGET = 30;
let view = localStorage.getItem('tb.view') || 'combined';

/* ---------- tiny helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtR(x, dp = 1) { if (x == null || isNaN(x)) return '—'; return (x >= 0 ? '+' : '') + Number(x).toFixed(dp) + 'R'; }
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
function freshness(iso) {
  const a = ago(iso);
  const cls = a.hrs > 72 ? 'stale' : a.hrs > 36 ? 'warn' : '';
  return { text: a.text, cls, stale: a.hrs > 72 };
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
  const r = o.unreal_R;
  let st = 'on track', stc = '';
  if (r != null && r >= 0.8) { st = 'near target'; stc = 'near'; }
  else if (r != null && r <= -0.7) { st = 'near get-out'; stc = 'risk'; }
  const bookTag = showBook && o.book ? `<span class="pill booktag">${esc(o.book)}</span>` : '';
  const c = el(`<button class="pos-card">
    <div class="body">
      <div class="top"><span class="nm">${esc(o.market)}</span>${dirPill(o.direction)}${bookTag}</div>
      <div class="desc">${betWord(o.direction)}${o.entry_date ? ' · opened ' + esc(o.entry_date) : ''}</div>
    </div>
    <div class="r"><div class="val ${signClass(r)}">${fmtR(r)}</div><div class="st ${stc}">${st}</div></div>
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
  const body = rows.slice(0, 8).map(t => `<tr>
    <td class="nm">${esc(t.market)} <span class="pill ${t.direction === 'long' ? 'long' : 'short'}" style="margin-left:4px">${t.direction}</span>
      <div class="why">${esc(t.reason)}</div></td>
    <td class="r ${signClass(t.outcome_R)}">${fmtR(t.outcome_R, 2)}</td></tr>`).join('');
  return `<div class="list2"><table>${body}</table></div>`;
}
function sampleGate(n, target) {
  if (n >= target) return '';
  const pct = Math.round(Math.min(1, n / target) * 100);
  return `<div class="gate"><span class="ic">${ICON.warn}</span>
    <div class="t"><b>Still early — ${n} of ${target} trades.</b> Not enough yet to call the strategy good or bad; the bot keeps its verdicts to itself until the sample means something.
    <div class="bar"><i style="width:${pct}%"></i></div></div></div>`;
}

/* ---------- views ---------- */
function renderCombined(root) {
  const d = DATA.combined;
  if (!d) { root.append(el('<div class="empty"><div class="h">No data yet</div></div>')); return; }
  const h = d.headline || {};
  const n = h.n || 0;
  const openN = (d.books || []).reduce((s, b) => s + (b.counts?.open || 0), 0);
  const wr = h.win_rate != null ? `${h.win_rate}%` : '—';

  root.append(el(`<section class="card hero">
    <div class="kicker">Paper performance · both books</div>
    <div class="big ${signClass(h.total_R)}">${fmtR(h.total_R)}</div>
    <div class="sub">Profit measured in risk units — 1R is what a single trade puts at stake.</div>
    <div class="facts">
      <div><div class="n">${n}</div><div class="l">trades closed</div></div>
      <div><div class="n">${openN}</div><div class="l">open now</div></div>
      <div><div class="n">${wr}</div><div class="l">went right</div></div>
    </div></section>`));

  const g = sampleGate(n, GATE_TARGET); if (g) root.append(el(g));

  const cum = (d.equity || []).map(e => e.cum_R);
  root.append(el(`<section class="card">
    <div class="chartcap"><h2 style="margin:0">Combined equity</h2><span class="v">running total, in R</span></div>
    ${cum.length ? equitySVG(cum) : '<div class="empty"><span class="g">' + ICON.chart + '</span><div class="h">No closed trades yet</div><div class="p">The curve begins when the first position closes.</div></div>'}
    ${cum.length ? `<div class="axis"><span>start</span><span class="${signClass(h.total_R)}">${fmtR(h.total_R)}</span></div>` : ''}
  </section>`));

  const opens = d.open || [];
  if (opens.length) {
    root.append(el('<div class="sec"><span class="h">Open now</span></div>'));
    opens.forEach(o => root.append(openCard(o, true)));
  }

  root.append(el('<div class="sec"><span class="h">The two books</span></div>'));
  (d.books || []).forEach(b => {
    const bh = b.headline || {};
    const isC = b.slug === 'crypto';
    const glyph = isC ? '₿' : ICON.chart.replace(/width="22" height="22"/, 'width="18" height="18"');
    const row = el(`<button class="book">
      <span class="ic" style="color:${isC ? 'var(--amber)' : 'var(--blue)'}">${glyph}</span>
      <div class="body"><div class="nm">${esc(b.book)}</div>
        <div class="meta">${b.counts?.closed || 0} closed · ${b.counts?.open || 0} open${isC ? ' · <span style="color:var(--amber)">new</span>' : ''}</div></div>
      <div class="r ${signClass(bh.total_R)}">${fmtR(bh.total_R)}</div>
      <span class="chev">${ICON.chev}</span></button>`);
    row.addEventListener('click', () => switchView(b.slug));
    root.append(row);
  });
}

function renderBook(root, slug) {
  const d = DATA[slug];
  const label = slug === 'crypto' ? 'Crypto' : 'Markets';
  if (!d) { root.append(el(`<div class="empty"><div class="h">No ${esc(label)} data yet</div><div class="p">This book hasn’t published a snapshot.</div></div>`)); return; }
  const h = d.headline || {}; const n = h.n || 0;
  const wentRight = n ? `${Math.round((h.win_rate || 0) / 100 * n)} of ${n} went right` : 'no closed trades yet';

  root.append(el(`<section class="hero-row">
    <div class="l"><div class="k">${esc(label)} book · paper${slug === 'crypto' ? ' · new' : ''}</div>
      <div class="nm">${slug === 'crypto' ? 'BTC · ETH · SOL · …' : 'Indices · Gold · FX'}</div>
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
    ? '<b>No money limits here.</b> Every crypto signal is logged as a paper trade to gather data fast. Because crypto trades weekends, this book updates daily, just after midnight UTC.'
    : '<b>Data-collection mode.</b> Every valid signal is logged as a paper trade, sized as if the money were there. Nothing here places a real order or moves real money.';
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
    <div class="result"><span class="big ${signClass(r)}">${fmtR(r)}</span><span class="${labc}" style="font-size:12px">${r != null ? (r >= 0 ? 'ahead' : 'behind') + ' by ' + Math.abs(r).toFixed(1) + '× the risk · ' : ''}${lab}</span></div>
    <div class="track"><span class="now" style="left:${pos}%"></span></div>
    <div class="ends"><span class="s">Get out ${fmtPrice(o.stop)}<span class="sub">−1R · exits if wrong</span></span>
      <span class="t">Target ${fmtPrice(o.target)}<span class="sub">+${rr}R · exits if right</span></span></div>
    <div class="grid">
      <div class="cell"><div class="l">Got in at</div><div class="v">${fmtPrice(o.entry)}</div></div>
      <div class="cell"><div class="l">Price now</div><div class="v">${fmtPrice(o.price)}</div></div>
      <div class="cell"><div class="l">Risk on the trade</div><div class="v">1R</div></div>
      <div class="cell"><div class="l">Reward if it wins</div><div class="v pos">+${rr}R</div></div>
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
  document.querySelectorAll('#seg button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  const main = $('#main'); main.innerHTML = '';

  // staleness from the displayed book
  const src = view === 'combined' ? DATA.combined : DATA[view];
  const f = freshness(src && src.generated_at);
  const fresh = $('#fresh'); fresh.className = 'fresh ' + f.cls;
  $('#stamp').textContent = 'updated ' + f.text;
  if (f.stale) {
    main.append(el(`<div class="stale-banner"><span class="ic">${ICON.warn}</span>
      <div><b>This is ${esc(f.text.replace(' ago', ''))} old.</b>
      <span class="sub">The bot hasn’t published a fresh update — your Mac may have been asleep, or the last publish didn’t go through. These numbers aren’t current.</span></div></div>`));
  }

  if (view === 'combined') renderCombined(main);
  else renderBook(main, view);
}
function switchView(v) { view = v; localStorage.setItem('tb.view', v); closeSheet(); render(); window.scrollTo(0, 0); }

async function load(bust) {
  const opt = bust ? { cache: 'no-store' } : {};
  const files = { combined: 'combined', markets: 'markets', crypto: 'crypto' };
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

/* ==========================================================
   TradeDesk — Backtest vs Live
   Data: GET /api/compare/data (passkey token) returns the live
   JSONBin record + every backtests/*.csv parsed by the server.
   Read-only: this page never writes anything.
   Rules agreed with the user:
   - backtest trades count on their EXIT date
   - comparison is per strategy; each trader's account is its own line
   - live entries without an execution type count as "Unknown"
   ========================================================== */

const TOKEN_KEY = 'td_compare_token';
const PERIODS = [['live', 'Since go-live'], ['fy', 'Current FY'], ['q', 'Current Quarter'], ['m', 'Current Month']];
const ACC_COLORS = ['#4cc9f0', '#f472b6', '#ff9f5a', '#5eead4'];
const BT_COLOR = '#a78bfa';
const EXEC = { clean: 'Clean run', manual: 'Manual exit', tech: 'Technical glitch', unknown: 'Unknown' };
const RANGE_DAYS = 20;

/* ---------- formatting ---------- */
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (n, signed = true) => (signed ? (n > 0 ? '+' : n < 0 ? '−' : '') : (n < 0 ? '−' : '')) + '₹' + inr.format(Math.abs(Math.round(n)));
const compact = n => {
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(1).replace(/\.0$/, '') + 'L';
  if (a >= 1e3) return s + '₹' + (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return s + '₹' + Math.round(a);
};
const scompact = n => (n > 0 ? '+' : '') + compact(n);
const pct = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) + '%' : '—');
const dfmt = (iso, o = { day: 'numeric', month: 'short', year: 'numeric' }) => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', o);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = isoOf(new Date());
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const norm = s => String(s).toLowerCase().replace(/[·\-_]+/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------- state ---------- */
let RAW = null;          // server payload
let MODEL = [];          // per-strategy prepared data
const state = { strat: 0, period: 'live', acc: 0, dayFilter: 'all' };

/* ---------- boot & passkey gate ---------- */
queueMicrotask(boot);

async function boot() {
  const dash = location.pathname.replace(/compare\/?$/, '') || '/';
  document.querySelectorAll('a.brand, a.back-link').forEach(a => { a.href = dash; });
  $('#lockForm').addEventListener('submit', onUnlock);
  $('#lockBtn').addEventListener('click', () => { try { sessionStorage.removeItem(TOKEN_KEY); } catch {} location.reload(); });
  let token = null;
  try { token = sessionStorage.getItem(TOKEN_KEY); } catch {}
  if (token && await load(token)) return;
  showLock();
}

function showLock(msg = '') {
  $('#app').hidden = true;
  $('#lockScreen').hidden = false;
  $('#lockErr').textContent = msg;
  setTimeout(() => $('#lockInput').focus(), 50);
}

async function onUnlock(e) {
  e.preventDefault();
  const key = $('#lockInput').value.trim();
  const err = $('#lockErr'), ok = $('#lockOk');
  if (!key) { err.textContent = 'Enter your passkey.'; return; }
  ok.disabled = true; ok.textContent = 'Checking…'; err.textContent = '';
  try {
    const res = await fetch('/api/compare/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passkey: key }) });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || !j.ok) throw new Error((j && j.error) || `Server error (${res.status})`);
    try { sessionStorage.setItem(TOKEN_KEY, j.token); } catch {}
    $('#lockInput').value = '';
    if (!(await load(j.token))) throw new Error('Could not load the comparison data.');
  } catch (ex) {
    err.textContent = ex.message;
    const card = $('#lockForm'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  } finally { ok.disabled = false; ok.textContent = 'Open'; }
}

async function load(token) {
  let res, j;
  try {
    res = await fetch('/api/compare/data', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
    j = await res.json().catch(() => null);
  } catch { showLock('No connection to the TradeDesk server.'); return false; }
  if (res.status === 401) { try { sessionStorage.removeItem(TOKEN_KEY); } catch {} return false; }
  if (!res.ok || !j || !j.ok) { showLock((j && j.error) || `Server error (${res.status})`); return false; }
  RAW = j;
  prepare();
  $('#lockScreen').hidden = true;
  $('#app').hidden = false;
  $('#whoChip').hidden = false; $('#whoChip').innerHTML = `<i></i>${esc(j.who)}`;
  $('#lockBtn').hidden = false;
  buildControls();
  render();
  return true;
}

/* ---------- data model ---------- */
let TRACK_FROM = '2026-12-01';
function prepare() {
  if (/^\d{4}-\d{2}-\d{2}$/.test(RAW.trackFrom || '')) TRACK_FROM = RAW.trackFrom;
  const strategies = RAW.live.strategies.map(s => {
    const parts = s.name.split(' - ').map(p => p.trim());
    return { id: s.id, trader: parts.length > 1 ? parts[0] : 'Desk', short: parts.length > 1 ? parts.slice(1).join(' · ') : s.name };
  });
  MODEL = RAW.backtests.filter(b => !b.error && b.trades && b.trades.length).map(b => {
    // backtest by exit date
    const bt = new Map();
    for (const t of b.trades) {
      const d = bt.get(t.exit) || { pnl: 0, vix: null, trades: 0 };
      d.pnl += t.pnl; d.trades++; if (t.vix != null) d.vix = t.vix;
      bt.set(t.exit, d);
    }
    const btDates = [...bt.keys()].sort();
    const key = norm(b.strategy);
    const accounts = strategies.filter(s => norm(s.short) === key).map((s, i) => {
      const days = new Map();
      RAW.live.entries.filter(e => e.strategy === s.id && e.date >= TRACK_FROM).forEach(e => {
        days.set(e.date, { pnl: +e.pnl, funds: +e.investedFunds, exec: EXEC[e.execution] ? e.execution : 'unknown' });
      });
      const dates = [...days.keys()].sort();
      return { id: s.id, name: s.trader, color: ACC_COLORS[i % ACC_COLORS.length], days, start: dates[0], end: dates.at(-1) };
    }).filter(a => a.start);
    return { name: b.strategy.replace(/\s+-\s+/g, ' · '), file: b.file, skipped: b.skipped || 0, bt, btDates, trades: b.trades.length, accounts };
  });
}

function periodWindow(m) {
  const starts = m.accounts.map(a => a.start).sort(), ends = m.accounts.map(a => a.end).sort();
  const goLive = starts[0], lastLive = ends.at(-1);
  if (!goLive) return null;
  const t = new Date(TODAY + 'T00:00:00'), y = t.getFullYear(), mo = t.getMonth();
  let from = goLive, to = lastLive, label = `Since go-live · ${dfmt(goLive)} – ${dfmt(lastLive)}`;
  if (state.period === 'fy') { const fy = mo >= 3 ? y : y - 1; from = `${fy}-04-01`; to = `${fy + 1}-03-31`; label = `FY ${fy}–${String(fy + 1).slice(2)}`; }
  if (state.period === 'q') { const qs = Math.floor(mo / 3) * 3; from = isoOf(new Date(y, qs, 1)); to = isoOf(new Date(y, qs + 3, 0)); label = `${MONTHS[qs]} – ${MONTHS[qs + 2]} ${y}`; }
  if (state.period === 'm') { from = isoOf(new Date(y, mo, 1)); to = isoOf(new Date(y, mo + 1, 0)); label = new Date(y, mo, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); }
  from = from < goLive ? goLive : from;
  to = to > lastLive ? lastLive : to;
  return { from, to, label, goLive };
}

/* per-account comparison over [from, to] (from clipped to the account's own start) */
function compareAccount(m, a, W) {
  // the account's own active span: never count days before its first or after its last live entry
  const from = a.start > W.from ? a.start : W.from, to = a.end < W.to ? a.end : W.to;
  const inW = d => d >= from && d <= to;
  const btDays = m.btDates.filter(inW);
  const liveDays = [...a.days.keys()].filter(inW).sort();
  const all = [...new Set([...btDays, ...liveDays])].sort();
  const rows = all.map(d => {
    const b = m.bt.get(d), l = a.days.get(d);
    return { date: d, bt: b ? b.pnl : null, live: l ? l.pnl : null, exec: l ? l.exec : null, vix: b ? b.vix : null };
  });
  const matched = rows.filter(r => r.bt != null && r.live != null);
  const missed = rows.filter(r => r.bt != null && r.live == null);
  const extra = rows.filter(r => r.bt == null && r.live != null);
  const btTotal = rows.reduce((s, r) => s + (r.bt || 0), 0);
  const liveTotal = rows.reduce((s, r) => s + (r.live || 0), 0);
  const byExec = { clean: 0, manual: 0, tech: 0, unknown: 0 }, nExec = { clean: 0, manual: 0, tech: 0, unknown: 0 };
  matched.forEach(r => { byExec[r.exec] += r.live - r.bt; nExec[r.exec]++; });
  const same = matched.filter(r => Math.sign(r.live) === Math.sign(r.bt)).length;
  return {
    from, to, rows, matched, missed, extra, btTotal, liveTotal, byExec, nExec,
    gap: liveTotal - btTotal,
    sameDir: matched.length ? (100 * same) / matched.length : NaN,
    corr: correlation(matched.map(r => r.live), matched.map(r => r.bt)),
    btStats: stats(rows.filter(r => r.bt != null).map(r => r.bt)),
    liveStats: stats(rows.filter(r => r.live != null).map(r => r.live)),
    verdict: verdict(m, btDays.length, liveTotal - btTotal),
  };
}

function stats(vals) {
  const net = vals.reduce((s, v) => s + v, 0);
  const wins = vals.filter(v => v > 0), losses = vals.filter(v => v < 0);
  const gp = wins.reduce((s, v) => s + v, 0), gl = -losses.reduce((s, v) => s + v, 0);
  let cum = 0, peak = 0, dd = 0;
  vals.forEach(v => { cum += v; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); });
  return { net, days: vals.length, win: vals.length ? (100 * wins.length) / vals.length : NaN, avg: vals.length ? net / vals.length : 0, dd, pf: gl ? gp / gl : (gp ? Infinity : NaN), curDD: cum - peak };
}

function correlation(x, y) {
  const n = x.length; if (n < 3) return NaN;
  const mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
  let sxy = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
  return sx && sy ? sxy / Math.sqrt(sx * sy) : NaN;
}

// all rolling k-day sums over the backtest's full history (exit-date days)
function rollingSums(m, k) {
  const v = m.btDates.map(d => m.bt.get(d).pnl), out = [];
  if (k < 1 || v.length < k) return out;
  let s = 0;
  for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= k) s -= v[i - k]; if (i >= k - 1) out.push(s); }
  return out;
}
const ordinal = n => { const v = Math.round(n), t = v % 100; return v + (t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th')); };
const stdev = a => { if (a.length < 2) return 0; const m = a.reduce((x, y) => x + y) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

// Ahead / On track / Lagging: is the gap bigger than normal backtest noise for a stretch this long?
function verdict(m, k, gap) {
  if (k < 5) return { cls: 'early', text: 'Too early to judge', band: 0 };
  const band = 0.5 * stdev(rollingSums(m, k));
  if (gap > band) return { cls: 'ahead', text: 'Ahead of backtest', band };
  if (gap < -band) return { cls: 'lag', text: 'Lagging backtest', band };
  return { cls: 'track', text: 'On track', band };
}

/* ---------- controls ---------- */
function buildSeg(host, opts, get, set) {
  host.innerHTML = '<span class="pill"></span>' + opts.map(([v, l]) => `<button type="button" data-v="${esc(v)}">${esc(l)}</button>`).join('');
  const pill = host.querySelector('.pill');
  const sync = () => host.querySelectorAll('button').forEach(b => {
    const on = b.dataset.v === String(get());
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    if (on) { pill.style.width = b.offsetWidth + 'px'; pill.style.transform = `translateX(${b.offsetLeft}px)`; }
  });
  host.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { set(b.dataset.v); sync(); }));
  host._sync = sync;
  requestAnimationFrame(sync); document.fonts?.ready.then(sync);
}
function buildControls() {
  if (!MODEL.length) return;
  buildSeg($('#stratSeg'), MODEL.map((m, i) => [String(i), m.name]), () => state.strat, v => { state.strat = +v; state.acc = 0; buildAccSegs(); render(); });
  buildSeg($('#periodSeg'), PERIODS, () => state.period, v => { state.period = v; render(); });
  buildAccSegs();
  addEventListener('resize', () => { document.querySelectorAll('.seg').forEach(s => s._sync?.()); clearTimeout(window.__rz); window.__rz = setTimeout(renderCurves, 150); });
}
function buildAccSegs() {
  const m = MODEL[state.strat];
  document.querySelectorAll('.acc-seg').forEach(host => {
    host.hidden = m.accounts.length < 2;
    buildSeg(host, m.accounts.map((a, i) => [String(i), a.name]), () => state.acc, v => {
      state.acc = +v; document.querySelectorAll('.acc-seg').forEach(h => h._sync?.());
      renderCurves(); renderGap(); renderRange();
    });
  });
}

/* ---------- render ---------- */
let CUR = null; // { m, W, cmp: [] }
function render() {
  if (!MODEL.length) {
    $('#heroSub').textContent = '';
    document.querySelectorAll('#app .block').forEach(b => { b.hidden = true; });
    $('#score').hidden = false;
    $('#scoreGrid').innerHTML = `<div class="card empty-cmp"><b>No backtest files yet</b>Add a CSV to the <code>backtests</code> folder in the repo, named after the strategy (e.g. <code>Narad - Hedge.csv</code>).</div>`;
    return;
  }
  const m = MODEL[state.strat];
  const W = periodWindow(m);
  $('#periodLabel').textContent = W ? W.label : '';
  const first = m.btDates[0], last = m.btDates.at(-1);
  $('#heroSub').innerHTML = `<b>${esc(m.name)}</b>: backtest of ${inr.format(m.trades)} trades, ${dfmt(first)} – ${dfmt(last)}${m.skipped ? ` (${m.skipped} unreadable rows skipped)` : ''}, compared with ${m.accounts.length ? m.accounts.map(a => `<span style="color:${a.color}">${esc(a.name)}</span>`).join(' and ') : 'live results'} from <b>${dfmt(TRACK_FROM)}</b>.`;
  $('#footNote').textContent = `Backtest file: backtests/${m.file} · read-only`;
  const sectionsOn = !!(W && m.accounts.length);
  ['#curves', '#gap', '#range', '#days', '#months', '#vix'].forEach(id => { $(id).hidden = !sectionsOn; });
  if (!sectionsOn) {
    CUR = null;
    $('#periodLabel').textContent = `Tracking from ${dfmt(TRACK_FROM)}`;
    $('#scoreGrid').innerHTML = waitingCards(m);
    ['#curveChart', '#gapChart', '#rangeGrid'].forEach(s => { $(s).innerHTML = ''; });
    return;
  }
  CUR = { m, W, cmp: m.accounts.map(a => compareAccount(m, a, W)) };
  if (state.acc >= m.accounts.length) state.acc = 0;
  renderScore(); renderCurves(); renderGap(); renderRange(); renderDays(); renderMonths(); renderVix();
}

/* before live tracking starts: the backtest's own record + what to do next */
function waitingCards(m) {
  const s = stats(m.btDates.map(d => m.bt.get(d).pnl));
  const pf = s.pf === Infinity ? '∞' : Number.isFinite(s.pf) ? s.pf.toFixed(2) : '—';
  const metric = (k, v, c = '') => `<div><span class="k">${k}</span><span class="v ${c}">${v}</span></div>`;
  const future = TRACK_FROM > TODAY;
  return `<article class="sc" style="--c:${BT_COLOR}">
      <div class="sc-top"><span class="sc-name"><i></i>Backtest · full history</span><span class="sc-span">${s.days} days</span></div>
      <div class="sc-net ${cls(s.net)}">${money(s.net)}</div>
      <div class="sc-metrics">${metric('Win rate', pct(s.win))}${metric('Average day', money(s.avg), cls(s.avg))}${metric('Max drawdown', s.dd < 0 ? money(s.dd) : '₹0', s.dd < 0 ? 'neg' : '')}${metric('Profit factor', pf)}</div>
      <div class="sc-vs"><div class="row"><span>Covers</span><b>${dfmt(m.btDates[0])} – ${dfmt(m.btDates.at(-1))}</b></div></div>
    </article>
    <article class="card empty-cmp wait-card">
      <b>${future ? 'Tracking starts ' + dfmt(TRACK_FROM) : 'Waiting for the first ' + esc(m.name) + ' entry'}</b>
      <p>Live results are compared from <b>${dfmt(TRACK_FROM)}</b>, when each portfolio is logged on its own.</p>
      <p class="muted small">In Log P&amp;L → Manage strategies, register <b>“Nishant - ${esc(m.name)}”</b> and <b>“Vinayak - ${esc(m.name)}”</b>, then log each day from ${dfmt(TRACK_FROM, { day: 'numeric', month: 'short' })}. The comparison fills in automatically.</p>
    </article>`;
}

/* 1 scorecard */
function renderScore() {
  const { m, W, cmp } = CUR;
  const btRows = m.btDates.filter(d => d >= W.from && d <= W.to).map(d => m.bt.get(d).pnl);
  const bs = stats(btRows);
  const metric = (k, v, c = '') => `<div><span class="k">${k}</span><span class="v ${c}">${v}</span></div>`;
  const pfTxt = s => (s.pf === Infinity ? '∞' : Number.isFinite(s.pf) ? s.pf.toFixed(2) : '—');
  const btCard = `<article class="sc" style="--c:${BT_COLOR}">
    <div class="sc-top"><span class="sc-name"><i></i>Backtest</span><span class="sc-span">${bs.days} days</span></div>
    <div class="sc-net ${cls(bs.net)}">${money(bs.net)}</div>
    <div class="sc-metrics">${metric('Win rate', pct(bs.win))}${metric('Average day', money(bs.avg), cls(bs.avg))}${metric('Max drawdown', bs.dd < 0 ? money(bs.dd) : '₹0', bs.dd < 0 ? 'neg' : '')}${metric('Profit factor', pfTxt(bs))}</div>
    <div class="sc-vs"><div class="row"><span>Period</span><b>${dfmt(W.from, { day: 'numeric', month: 'short' })} – ${dfmt(W.to, { day: 'numeric', month: 'short' })}</b></div><div class="row"><span>Full history</span><b>${inr.format(m.trades)} trades since ${dfmt(m.btDates[0], { month: 'short', year: 'numeric' })}</b></div></div>
  </article>`;
  const accCards = cmp.map((c, i) => {
    const a = m.accounts[i], s = c.liveStats;
    return `<article class="sc" style="--c:${a.color}">
      <div class="sc-top"><span class="sc-name"><i></i>${esc(a.name)}</span><span class="verdict ${c.verdict.cls}" title="Gap compared with normal backtest variation over ${c.matched.length + c.missed.length} days (±${compact(c.verdict.band)})"><i></i>${c.verdict.text}</span></div>
      <div class="sc-net ${cls(s.net)}">${money(s.net)}</div>
      <div class="sc-metrics">${metric('Win rate', pct(s.win))}${metric('Average day', money(s.avg), cls(s.avg))}${metric('Max drawdown', s.dd < 0 ? money(s.dd) : '₹0', s.dd < 0 ? 'neg' : '')}${metric('Profit factor', pfTxt(s))}</div>
      <div class="sc-vs">
        <div class="row"><span>Backtest on the same dates</span><b class="${cls(c.btTotal)}">${money(c.btTotal)}</b></div>
        <div class="row"><span>Gap (live − backtest)</span><b class="${cls(c.gap)}">${money(c.gap)}</b></div>
        <div class="row"><span>Days moving the same way</span><b>${pct(c.sameDir)} of ${c.matched.length}</b></div>
        <div class="row"><span>Correlation of daily P&amp;L</span><b>${Number.isFinite(c.corr) ? c.corr.toFixed(2) : '—'}</b></div>
      </div>
    </article>`;
  }).join('');
  $('#scoreGrid').innerHTML = btCard + accCards;
}

/* 2 curves */
function renderCurves() {
  if (!CUR) return;
  const { m } = CUR, a = m.accounts[state.acc], c = CUR.cmp[state.acc];
  const host = $('#curveChart');
  const rows = c.rows;
  if (rows.length < 2) { host.innerHTML = '<p class="muted">Not enough days in this period.</p>'; $('#curveRead').innerHTML = ''; return; }
  let cb = 0, cl = 0;
  const pts = rows.map(r => ({ ...r, cb: (cb += r.bt || 0), cl: (cl += r.live || 0) }));
  const W = host.clientWidth || 900, H = host.clientHeight || 420, padL = 64, padR = 12, padT = 10, padB = 26;
  const vals = pts.flatMap(p => [p.cb, p.cl]);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1;
  const x = i => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const y = v => padT + (H - padT - padB) * (1 - (v - lo) / span);
  const line = k => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[k]).toFixed(1)}`).join(' ');
  const gapPoly = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.cl).toFixed(1)}`).join(' ') + ' ' + pts.slice().reverse().map((p, j) => `${x(pts.length - 1 - j).toFixed(1)},${y(p.cb).toFixed(1)}`).join(' ');
  const ticks = niceTicks(lo, hi, 5);
  const step = Math.max(1, Math.ceil(pts.length / Math.max(3, Math.floor(W / 110))));
  const marks = pts.map((p, i) => (p.exec === 'manual' || p.exec === 'tech') ? `<circle cx="${x(i)}" cy="${y(p.cl)}" r="4.5" fill="${p.exec === 'manual' ? 'var(--gold)' : 'var(--loss)'}" stroke="var(--bg)" stroke-width="1.5"/>` : '').join('');
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative P&L, backtest versus ${esc(a.name)}">
    <g class="axis">${ticks.map(t => `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 10}" y="${y(t) + 3.5}" text-anchor="end">${compact(t)}</text>`).join('')}
      ${pts.map((p, i) => (i % step ? '' : `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${dfmt(p.date, { day: 'numeric', month: 'short' })}</text>`)).join('')}</g>
    <line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(255,255,255,.18)"/>
    <polygon points="${gapPoly}" fill="${c.gap >= 0 ? 'rgba(62,234,160,.10)' : 'rgba(255,91,112,.10)'}"/>
    <path d="${line('cb')}" fill="none" stroke="${BT_COLOR}" stroke-width="2.2" stroke-dasharray="6 4" stroke-linejoin="round"/>
    <path d="${line('cl')}" fill="none" stroke="${a.color}" stroke-width="2.6" stroke-linejoin="round" style="filter:drop-shadow(0 0 6px ${a.color})"/>
    ${marks}
    <g class="crosshair" opacity="0"><line class="cx" y1="${padT}" y2="${H - padB}"/><circle class="c1" r="4.5" style="stroke:${BT_COLOR}"/><circle class="c2" r="5" style="stroke:${a.color}"/></g>
    <rect class="hit" x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent"/>
  </svg>`;
  const nm = c.nExec;
  $('#curveLegend').innerHTML = `<span style="--c:${BT_COLOR}"><i></i>Backtest</span><span style="--c:${a.color}"><i></i>${esc(a.name)} (live)</span>
    <span style="--c:var(--gold)"><i class="dot"></i>Manual exit · ${nm.manual}</span><span style="--c:var(--loss)"><i class="dot"></i>Technical glitch · ${nm.tech}</span>
    <span class="muted">Unknown · ${nm.unknown} · Clean run · ${nm.clean}</span>`;
  const read = p => {
    $('#curveRead').innerHTML = `<div><span class="k">Backtest</span><span class="v ${cls(p.cb)}">${money(p.cb)}</span></div>
      <div><span class="k">${esc(a.name)}</span><span class="v ${cls(p.cl)}">${money(p.cl)}</span></div>
      <div><span class="k">Gap</span><span class="v ${cls(p.cl - p.cb)}">${money(p.cl - p.cb)}</span></div>
      <span class="d">${dfmt(p.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>`;
  };
  read(pts.at(-1));
  const svg = host.querySelector('svg'), ch = svg.querySelector('.crosshair');
  svg.querySelector('.hit').addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(pts.length - 1, Math.round((((e.clientX - r.left) / r.width) * W - padL) / (W - padL - padR) * (pts.length - 1))));
    ch.setAttribute('opacity', 1);
    ch.querySelector('.cx').setAttribute('x1', x(i)); ch.querySelector('.cx').setAttribute('x2', x(i));
    ch.querySelector('.c1').setAttribute('cx', x(i)); ch.querySelector('.c1').setAttribute('cy', y(pts[i].cb));
    ch.querySelector('.c2').setAttribute('cx', x(i)); ch.querySelector('.c2').setAttribute('cy', y(pts[i].cl));
    read(pts[i]);
  });
  svg.querySelector('.hit').addEventListener('pointerleave', () => { ch.setAttribute('opacity', 0); read(pts.at(-1)); });
}

function niceTicks(min, max, n) {
  const span = max - min || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/* 3 gap waterfall */
function renderGap() {
  if (!CUR) return;
  const a = CUR.m.accounts[state.acc], c = CUR.cmp[state.acc];
  const missedSum = -c.missed.reduce((s, r) => s + r.bt, 0);
  const extraSum = c.extra.reduce((s, r) => s + r.live, 0);
  const steps = [
    { name: 'Backtest', sub: 'same dates as this account', total: true, v: c.btTotal, n: c.matched.length + c.missed.length, color: BT_COLOR },
    { name: 'Clean-run days', sub: 'live − backtest', v: c.byExec.clean, n: c.nExec.clean },
    { name: 'Manual-exit days', sub: 'live − backtest', v: c.byExec.manual, n: c.nExec.manual },
    { name: 'Technical-glitch days', sub: 'live − backtest', v: c.byExec.tech, n: c.nExec.tech },
    { name: 'Unknown days', sub: 'logged before Execution existed', v: c.byExec.unknown, n: c.nExec.unknown },
    { name: 'Missed trades', sub: 'backtest traded, no live entry', v: missedSum, n: c.missed.length },
    { name: 'Extra trades', sub: 'live entry, no backtest trade', v: extraSum, n: c.extra.length },
    { name: `${a.name} (live)`, sub: 'what actually happened', total: true, v: c.liveTotal, n: c.matched.length + c.extra.length, color: a.color },
  ];
  let run = 0, lo = 0, hi = 0;
  const pos = steps.map(s => {
    if (s.total) { const r = { from: 0, to: s.v }; run = s.v; lo = Math.min(lo, 0, s.v); hi = Math.max(hi, 0, s.v); return r; }
    const r = { from: run, to: run + s.v }; run += s.v; lo = Math.min(lo, r.from, r.to); hi = Math.max(hi, r.from, r.to); return r;
  });
  const span = hi - lo || 1, P = v => (((v - lo) / span) * 100).toFixed(2);
  $('#gapChart').innerHTML = steps.map((s, i) => {
    const p = pos[i], left = P(Math.min(p.from, p.to)), width = ((Math.abs(p.to - p.from) / span) * 100).toFixed(2);
    const kind = s.total ? 'total' : s.v >= 0 ? 'up' : 'down';
    return `<div class="gw-row${s.total ? ' total' : ''}" style="--c:${s.color || 'var(--gold)'}">
      <div class="gw-name"><b>${esc(s.name)}</b><small>${esc(s.sub)}</small></div>
      <div class="gw-track" style="--zero:${P(0)}%"><span class="gw-bar ${kind}" style="left:${left}%;width:${width}%"></span></div>
      <div class="gw-val ${cls(s.v)}">${money(s.v)}</div>
      <div class="gw-days">${s.n} day${s.n === 1 ? '' : 's'}</div>
    </div>`;
  }).join('');
  const unk = c.nExec.unknown, tot = c.matched.length;
  $('#gapNote').textContent = unk && unk === tot
    ? 'All matched days are “Unknown” because they were logged before the Execution field existed. From now on, choosing Clean run / Manual exit / Technical glitch in Log P&L splits this gap properly.'
    : `Execution recorded on ${tot - unk} of ${tot} matched days.`;
}

/* 4 normal range */
function renderRange() {
  if (!CUR) return;
  const { m } = CUR, a = m.accounts[state.acc], c = CUR.cmp[state.acc];
  const liveVals = c.rows.filter(r => r.live != null).map(r => r.live);
  const k = Math.min(RANGE_DAYS, liveVals.length);
  const hist = rollingSums(m, k);
  if (k < 5 || hist.length < 10) { $('#rangeGrid').innerHTML = '<div class="card rg-card"><p class="muted">Not enough live days in this period to judge yet.</p></div>'; return; }
  const liveK = liveVals.slice(-k).reduce((s, v) => s + v, 0);
  const lastDates = c.rows.filter(r => r.live != null).slice(-k).map(r => r.date);
  const btK = lastDates.reduce((s, d) => s + (m.bt.get(d)?.pnl || 0), 0);
  const pctl = v => (100 * hist.filter(h => h <= v).length) / hist.length;
  const pl = pctl(liveK), pb = pctl(btK);
  // histogram
  const bins = 28, mn = Math.min(...hist, liveK), mx = Math.max(...hist, liveK), w = (mx - mn) / bins || 1;
  const counts = Array(bins).fill(0); hist.forEach(h => { counts[Math.min(bins - 1, Math.floor((h - mn) / w))]++; });
  const cmax = Math.max(...counts), X = v => ((v - mn) / (mx - mn || 1)) * 100;
  const svgHist = `<svg viewBox="0 0 100 40" preserveAspectRatio="none">
    ${counts.map((n, i) => `<rect x="${(i * 100) / bins + 0.3}" y="${40 - (n / cmax) * 36}" width="${100 / bins - 0.6}" height="${(n / cmax) * 36}" fill="${mn + (i + 0.5) * w >= 0 ? 'rgba(62,234,160,.35)' : 'rgba(255,91,112,.35)'}"/>`).join('')}
    <line x1="${X(btK)}" x2="${X(btK)}" y1="0" y2="40" stroke="${BT_COLOR}" stroke-width="0.6" stroke-dasharray="1.5 1" vector-effect="non-scaling-stroke"/>
    <line x1="${X(liveK)}" x2="${X(liveK)}" y1="0" y2="40" stroke="${a.color}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
  </svg>`;
  const tone = p => (p < 10 ? 'neg' : p > 50 ? 'pos' : '');
  const words = p => (p < 5 ? 'worse than almost any stretch in the backtest' : p < 15 ? 'in the weakest 15% of backtest stretches — a rough patch' : p < 40 ? 'below the backtest’s middle, but common' : p < 75 ? 'right in the backtest’s normal range' : 'better than most backtest stretches');
  // drawdowns
  const btAll = stats(m.btDates.map(d => m.bt.get(d).pnl));
  const s = c.liveStats;
  const ddPct = v => (btAll.dd < 0 ? Math.min(100, (100 * v) / btAll.dd) : 0);
  $('#rangeGrid').innerHTML = `
    <article class="card rg-card">
      <h3>Last ${k} live days · ${esc(a.name)}</h3>
      <div class="rg-big ${cls(liveK)}">${money(liveK)}</div>
      <span class="muted small">Backtest on those dates: <b class="${cls(btK)}">${money(btK)}</b></span>
      <div class="rg-hist">${svgHist}</div>
      <div class="rg-axis"><span>${compact(mn)}</span><span>every ${k}-day stretch in ${inr.format(hist.length)} backtest windows</span><span>${compact(mx)}</span></div>
      <p class="rg-text">${esc(a.name)}’s last ${k} days rank at the <b class="${tone(pl)}">${ordinal(pl)} percentile</b> — ${words(pl)}. The backtest itself ranks at the ${ordinal(pb)} on the same dates.</p>
    </article>
    <article class="card rg-card">
      <h3>Drawdown vs the backtest’s worst</h3>
      <div class="rg-big ${s.curDD < 0 ? 'neg' : ''}">${s.curDD < 0 ? money(s.curDD) : '₹0'}</div>
      <span class="muted small">current drawdown from ${esc(a.name)}’s peak in this period</span>
      <div class="dd-bars">
        <div class="dd-bar" style="--c:${a.color}"><div class="top"><span>${esc(a.name)} now</span><b>${pct(ddPct(s.curDD))} of worst</b></div><div class="track"><span style="width:${ddPct(s.curDD)}%"></span></div></div>
        <div class="dd-bar" style="--c:${a.color}"><div class="top"><span>${esc(a.name)} deepest in period</span><b>${s.dd < 0 ? money(s.dd) : '₹0'}</b></div><div class="track"><span style="width:${ddPct(s.dd)}%"></span></div></div>
        <div class="dd-bar" style="--c:${BT_COLOR}"><div class="top"><span>Backtest worst ever (since ${dfmt(m.btDates[0], { month: 'short', year: 'numeric' })})</span><b>${money(btAll.dd)}</b></div><div class="track"><span style="width:100%"></span></div></div>
      </div>
      <p class="rg-text">${ddPct(s.dd) < 60 ? 'Within what the backtest has already lived through.' : ddPct(s.dd) <= 100 ? 'Getting close to the backtest’s worst — worth watching.' : 'Deeper than anything in the backtest — investigate.'}</p>
    </article>`;
}

/* 5 day by day */
const DAY_FILTERS = [['all', 'All days'], ['big', 'Biggest gaps'], ['manual', 'Manual exit'], ['tech', 'Technical glitch'], ['unknown', 'Unknown'], ['missed', 'Missed'], ['extra', 'Extra']];
function renderDays() {
  const { m, W, cmp } = CUR;
  const accs = m.accounts;
  $('#dayFilters').innerHTML = DAY_FILTERS.map(([v, l]) => `<button type="button" class="chip f${state.dayFilter === v ? ' on' : ''}" data-v="${v}">${l}</button>`).join('');
  $('#dayFilters').querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => { state.dayFilter = b.dataset.v; renderDays(); }));
  const dates = [...new Set(cmp.flatMap(c => c.rows.map(r => r.date)))].filter(d => d >= W.from && d <= W.to).sort().reverse();
  let rows = dates.map(d => {
    const b = m.bt.get(d);
    return { date: d, bt: b ? b.pnl : null, vix: b ? b.vix : null, acc: accs.map(a => a.days.get(d) || null) };
  });
  const f = state.dayFilter;
  if (['manual', 'tech', 'unknown'].includes(f)) rows = rows.filter(r => r.acc.some(x => x && x.exec === f));
  if (f === 'missed') rows = rows.filter(r => r.bt != null && r.acc.some((x, i) => !x && r.date >= accs[i].start && r.date <= accs[i].end));
  if (f === 'extra') rows = rows.filter(r => r.bt == null && r.acc.some(x => x));
  if (f === 'big') rows = rows.filter(r => r.bt != null && r.acc.some(x => x)).sort((p, q) => maxGap(q) - maxGap(p)).slice(0, 25);
  $('#dayCount').textContent = `${rows.length} day${rows.length === 1 ? '' : 's'}`;
  $('#dayTable thead').innerHTML = `<tr><th>Date</th><th>VIX</th><th>Backtest</th>${accs.map(a => `<th style="color:${a.color}">${esc(a.name)}<span class="sub">live · gap</span></th>`).join('')}</tr>`;
  $('#dayTable tbody').innerHTML = rows.map(r => `<tr>
    <td>${dfmt(r.date, { day: '2-digit', month: 'short', year: 'numeric' })}</td>
    <td class="dim">${r.vix != null ? r.vix.toFixed(1) : '—'}</td>
    <td class="${r.bt == null ? 'dim' : cls(r.bt)}">${r.bt == null ? 'no trade' : money(r.bt)}</td>
    ${r.acc.map((x, i) => {
      if (!x) return `<td class="dim">${r.bt != null && r.date >= accs[i].start && r.date <= accs[i].end ? '<span class="xtag missed">missed</span>' : '—'}</td>`;
      const g = r.bt != null ? x.pnl - r.bt : null;
      return `<td><span class="${cls(x.pnl)}">${money(x.pnl)}</span>${g != null ? ` <span class="dim">·</span> <span class="${cls(g)}">${scompact(g)}</span>` : '<span class="xtag extra">extra</span>'}<span class="xtag ${x.exec}">${EXEC[x.exec]}</span></td>`;
    }).join('')}
  </tr>`).join('') || `<tr><td colspan="${3 + accs.length}" class="dim">No days match this filter.</td></tr>`;
}
const maxGap = r => Math.max(...r.acc.map(x => (x && r.bt != null ? Math.abs(x.pnl - r.bt) : 0)));

/* 6 months */
function renderMonths() {
  const { m, W, cmp } = CUR, accs = m.accounts;
  const months = [...new Set(cmp.flatMap(c => c.rows.map(r => r.date.slice(0, 7))))].sort().reverse();
  $('#monthTable thead').innerHTML = `<tr><th>Month</th><th>Backtest</th>${accs.map(a => `<th style="color:${a.color}">${esc(a.name)}<span class="sub">live</span></th><th>Gap</th><th>Clean-run gap</th>`).join('')}</tr>`;
  $('#monthTable tbody').innerHTML = months.map(mo => {
    const bt = m.btDates.filter(d => d.startsWith(mo) && d >= W.from && d <= W.to).reduce((s, d) => s + m.bt.get(d).pnl, 0);
    return `<tr><td>${dfmt(mo + '-01', { month: 'long', year: 'numeric' })}</td><td class="${cls(bt)}">${money(bt)}</td>
      ${cmp.map(c => {
        const rs = c.rows.filter(r => r.date.startsWith(mo));
        if (!rs.length) return '<td class="dim">—</td><td class="dim">—</td><td class="dim">—</td>';
        const live = rs.reduce((s, r) => s + (r.live || 0), 0), btA = rs.reduce((s, r) => s + (r.bt || 0), 0);
        const clean = rs.filter(r => r.exec === 'clean' && r.bt != null);
        const cg = clean.reduce((s, r) => s + r.live - r.bt, 0);
        return `<td class="${cls(live)}">${money(live)}</td><td class="${cls(live - btA)}">${money(live - btA)}</td><td class="${clean.length ? cls(cg) : 'dim'}">${clean.length ? money(cg) : '—'}</td>`;
      }).join('')}</tr>`;
  }).join('');
}

/* 7 VIX */
function renderVix() {
  const { m, W, cmp } = CUR, accs = m.accounts;
  const B = [['Low', 'below 13', v => v < 13], ['Medium', '13 – 17', v => v >= 13 && v < 17], ['High', '17 and above', v => v >= 17]];
  const all = m.btDates.map(d => m.bt.get(d)).filter(b => b.vix != null);
  const cell = vals => vals.length ? `${pct((100 * vals.filter(v => v > 0).length) / vals.length)} <span class="dim">·</span> <span class="${cls(vals.reduce((s, v) => s + v, 0) / vals.length)}">${money(vals.reduce((s, v) => s + v, 0) / vals.length)}</span>` : '<span class="dim">—</span>';
  $('#vixTable thead').innerHTML = `<tr><th>VIX level</th><th>Backtest, full history<span class="sub">win rate · avg day</span></th><th>Backtest, this period<span class="sub">win rate · avg day</span></th>${accs.map(a => `<th style="color:${a.color}">${esc(a.name)}<span class="sub">win rate · avg day</span></th><th>Avg gap<span class="sub">per day</span></th>`).join('')}</tr>`;
  $('#vixTable tbody').innerHTML = B.map(([name, rng, test]) => {
    const hist = all.filter(b => test(b.vix)).map(b => b.pnl);
    const per = m.btDates.filter(d => d >= W.from && d <= W.to).map(d => m.bt.get(d)).filter(b => b.vix != null && test(b.vix)).map(b => b.pnl);
    return `<tr><td>${name} <span class="dim">${rng}</span><br><span class="dim" style="font-size:11px">${hist.length} backtest days</span></td><td>${cell(hist)}</td><td>${cell(per)}</td>
      ${cmp.map(c => {
        const rs = c.matched.filter(r => r.vix != null && test(r.vix));
        const g = rs.length ? rs.reduce((s, r) => s + r.live - r.bt, 0) / rs.length : null;
        return `<td>${cell(rs.map(r => r.live))}<br><span class="dim" style="font-size:11px">${rs.length} days</span></td><td class="${g == null ? 'dim' : cls(g)}">${g == null ? '—' : money(g)}</td>`;
      }).join('')}</tr>`;
  }).join('');
}

/* ---------- toast ---------- */
let tt;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 3200); }

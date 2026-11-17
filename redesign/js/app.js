/* ==========================================================
   TradeDesk redesign — app logic
   All data comes from, and goes to, the server API (/api), which
   reads/writes the single JSONBin bin. The browser never holds the
   JSONBin key or the passkeys. A change only shows as saved after
   the server confirms JSONBin accepted it.
   ========================================================== */
import { createSkyline } from './skyline.js?v=4';

const API = '/api';
const PALETTE = ['#f4c56b', '#4cc9f0', '#a78bfa', '#ff9f5a', '#f472b6', '#60a5fa', '#e9e46b', '#c4b5fd'];
const PERIODS = [['all', 'Overall'], ['fy', 'Current FY'], ['q', 'Current Quarter'], ['m', 'Current Month']];
const SECTIONS = ['overview', 'calendar', 'performance', 'strategies', 'journal'];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------- formatting ---------------- */
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (n, signed = true) => (signed ? (n > 0 ? '+' : n < 0 ? '−' : '') : (n < 0 ? '−' : '')) + '₹' + inr.format(Math.abs(Math.round(n)));
const compact = n => {
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(1).replace(/\.0$/, '') + 'Cr';
  if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(1).replace(/\.0$/, '') + 'L';
  if (a >= 1e3) return s + '₹' + (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return s + '₹' + Math.round(a);
};
const scompact = n => (n > 0 ? '+' : '') + compact(n);
const pct = (n, signed = true) => (signed && n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + '%';
const dfmt = (iso, opts = { day: 'numeric', month: 'short' }) => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', opts);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const $ = sel => document.querySelector(sel);
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => new Date(s + 'T00:00:00');
const dowOf = s => (parse(s).getDay() + 6) % 7; // Mon = 0
const mondayOf = s => { const d = parse(s); d.setDate(d.getDate() - dowOf(s)); return iso(d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------------- state ---------------- */
let data = { strategies: [], entries: [] };
let strategies = [];
const state = {
  trader: 'all',
  picked: new Set(),
  period: { overview: 'all', calendar: 'fy', performance: 'all', strategies: 'all', journal: 'all' },
  selDay: null,
};
let skyline = null;
const TODAY = iso(new Date());

/* ---------------- boot ---------------- */
queueMicrotask(init); // run after this whole module has been evaluated

/* ---------------- live data layer ---------------- */
const LIVE = { connected: false, writable: false, meta: null, warnedSize: false };

async function apiCall(path, body) {
  let res, json = null;
  try {
    res = await fetch(API + path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' });
  } catch {
    throw new Error('No connection to the TradeDesk server. Nothing was changed.');
  }
  try { json = await res.json(); } catch { /* non-JSON reply */ }
  if (!res.ok || !json || json.ok === false) {
    const err = new Error((json && json.error) || `Server error (${res.status}). Nothing was changed.`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function adoptServerData(json) {
  data = json.data;
  data.entries.forEach(e => { e.pnl = +e.pnl; e.investedFunds = +e.investedFunds; });
  LIVE.meta = json.meta;
  LIVE.writable = !!json.meta.writable;
  updateLiveStatus();
}

async function loadLive() {
  const json = await apiCall('/data');
  LIVE.connected = true;
  adoptServerData(json);
}

// Re-read the latest data (1 JSONBin request). Used by the LIVE button and before downloads.
async function refreshLive({ quiet = false } = {}) {
  setBusy(true);
  try {
    await loadLive();
    refreshAfterDataChange();
    if (!quiet) toast('Up to date');
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  } finally { setBusy(false); }
}

// Every change goes through here: the server reads the latest bin, applies
// this one change, checks the size limit and writes. Returns null if not saved.
let busyCount = 0;
async function runOp(op, payload, passkey) {
  if (!LIVE.connected) { toast('Not connected to live data. Nothing was saved.'); return null; }
  if (!LIVE.writable) { toast('Saving is switched off on this site for now (view-only). Nothing was saved.'); return null; }
  setBusy(true);
  try {
    const json = await apiCall('/ops', { op, payload, passkey });
    adoptServerData(json);
    refreshAfterDataChange();
    return json;
  } catch (e) {
    toast(e.message);
    if (e.status === 404 || e.status === 409) refreshLive({ quiet: true }); // someone else changed it — show the latest
    return null;
  } finally { setBusy(false); }
}

function setBusy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  document.body.classList.toggle('busy', busyCount > 0);
}

function updateLiveStatus() {
  const m = LIVE.meta;
  const badge = $('#liveBadge');
  if (badge && m) {
    const t = new Date(m.readAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    badge.title = `Live data · updated ${t} · click to refresh`;
    $('#liveTime').textContent = t;
  }
  $('#viewOnly').hidden = !LIVE.connected || LIVE.writable;
  if (m && !LIVE.warnedSize && m.sizeBytes > m.maxBytes * 0.8) {
    LIVE.warnedSize = true;
    setTimeout(() => toast(`Heads-up: data is ${(m.sizeBytes / 1024).toFixed(0)} KB of the ${(m.maxBytes / 1024).toFixed(0)} KB JSONBin limit.`), 2500);
  }
}

function showLoadError(msg) {
  const box = document.createElement('div');
  box.className = 'load-error';
  box.innerHTML = `<div><b>Couldn’t load live data</b><p>${esc(msg)}</p><p class="muted small">Nothing has been changed. Check your connection and try again.</p><button type="button" class="btn btn-gold" id="retryLoad">Try again</button></div>`;
  document.body.appendChild(box);
  $('#retryLoad').addEventListener('click', () => location.reload());
}

async function init() {
  setBusy(true);
  try {
    await loadLive();
  } catch (e) {
    setBusy(false);
    showLoadError(e.message);
    return; // never fall back to fake/empty data
  }
  setBusy(false);
  $('#liveBadge').addEventListener('click', () => refreshLive());
  enrich();
  buildFilters();
  setupFilterPanel();
  buildPeriodSwitches();
  setupDrawer();
  setupDayDrawer();
  setupReveal();
  setupNavSpy();
  $('#journalSearch').addEventListener('input', renderJournal);
  $('#dlJson').addEventListener('click', downloadJson);
  $('#dlCsv').addEventListener('click', downloadCsv);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = ''; // so the same file can be picked again
    if (file) importJson(file);
  });
  try {
    skyline = createSkyline($('#skyline'), { onHover: showTowerTip, reducedMotion });
  } catch (e) { console.warn('3D unavailable', e); }
  render(true);
}

function enrich() {
  const used = new Set(data.entries.map(e => e.strategy));
  strategies = data.strategies.map((s, i) => {
    const parts = s.name.split(' - ').map(p => p.trim());
    const trader = parts.length > 1 ? parts[0] : 'Desk';
    const short = parts.length > 1 ? parts.slice(1).join(' · ') : s.name;
    const color = s.customColor ? s.color : PALETTE[i % PALETTE.length];
    return { ...s, trader, short, color, used: used.has(s.id) || !!s.registeredAt };
  });
}
const stratById = id => strategies.find(s => s.id === id) || { id, name: id, short: id, trader: '—', color: '#888' };
const liveStrategies = () => strategies.filter(s => s.used);
const traders = () => [...new Set(liveStrategies().map(s => s.trader))];

/* ---------------- periods ---------------- */
function periodRange(p) {
  const t = parse(TODAY), y = t.getFullYear(), m = t.getMonth();
  if (p === 'fy') {
    const fy = m >= 3 ? y : y - 1;
    return { from: `${fy}-04-01`, to: `${fy + 1}-03-31`, label: `FY ${fy}–${String(fy + 1).slice(2)} · from 1 Apr ${fy}` };
  }
  if (p === 'q') {
    const qs = Math.floor(m / 3) * 3;
    const end = new Date(y, qs + 3, 0);
    const fyq = ((qs - 3 + 12) % 12) / 3 + 1;
    const fy = m >= 3 ? y + 1 : y;
    return { from: iso(new Date(y, qs, 1)), to: iso(end), label: `Q${fyq} FY${String(fy).slice(2)} · ${MONTHS[qs]} – ${MONTHS[qs + 2]} ${y}` };
  }
  if (p === 'm') {
    return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)), label: new Date(y, m, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) };
  }
  const ds = baseEntries().map(e => e.date).sort();
  return { from: null, to: null, label: ds.length ? `All time · ${dfmt(ds[0], { day: 'numeric', month: 'short', year: 'numeric' })} – ${dfmt(ds.at(-1), { day: 'numeric', month: 'short', year: 'numeric' })}` : 'All time' };
}
function forSection(section) {
  const { from, to } = periodRange(state.period[section]);
  return baseEntries().filter(e => (!from || e.date >= from) && (!to || e.date <= to));
}

/* ---------------- filtering ---------------- */
function visibleStrategies() { return liveStrategies().filter(s => state.trader === 'all' || s.trader === state.trader); }
function activeIds() {
  const vis = visibleStrategies().map(s => s.id);
  const picked = vis.filter(id => state.picked.has(id));
  return new Set(picked.length ? picked : vis);
}
function baseEntries() {
  const ids = activeIds();
  return data.entries.filter(e => ids.has(e.strategy)).sort((a, b) => a.date.localeCompare(b.date));
}
function byDay(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.date)) map.set(e.date, { date: e.date, pnl: 0, rows: [] });
    const d = map.get(e.date);
    d.pnl += e.pnl;
    d.rows.push({ ...stratById(e.strategy), pnl: e.pnl, funds: e.investedFunds });
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
// Capital deployed on the latest trading date in the set (Return = P&L ÷ this)
function latestDate(entries) { return entries.reduce((m, e) => (e.date > m ? e.date : m), ''); }
function capitalOf(entries) {
  const last = latestDate(entries);
  return entries.filter(e => e.date === last).reduce((s, e) => s + e.investedFunds, 0);
}

/* ---------------- stats ---------------- */
function stats(entries) {
  const days = byDay(entries);
  const pnls = days.map(d => d.pnl);
  const total = pnls.reduce((s, v) => s + v, 0);
  const wins = pnls.filter(v => v > 0), losses = pnls.filter(v => v < 0);
  const grossP = wins.reduce((s, v) => s + v, 0), grossL = -losses.reduce((s, v) => s + v, 0);
  const capital = capitalOf(entries);
  const capDate = latestDate(entries);
  let cum = 0, peak = 0, maxDD = 0, ddDate = null;
  const curve = days.map(d => {
    cum += d.pnl; peak = Math.max(peak, cum);
    const dd = cum - peak;
    if (dd < maxDD) { maxDD = dd; ddDate = d.date; }
    return { date: d.date, cum, dd, pnl: d.pnl };
  });
  let best = 0, run = 0;
  for (const v of pnls) { run = v > 0 ? run + 1 : 0; best = Math.max(best, run); }
  let current = 0;
  for (let i = pnls.length - 1; i >= 0 && pnls[i] > 0; i--) current++;
  const bestDay = days.reduce((m, d) => (!m || d.pnl > m.pnl ? d : m), null);
  const worstDay = days.reduce((m, d) => (!m || d.pnl < m.pnl ? d : m), null);
  const weeks = {};
  days.forEach(d => { const w = mondayOf(d.date); weeks[w] = (weeks[w] || 0) + d.pnl; });
  const bestWeek = Object.entries(weeks).reduce((m, [w, v]) => (!m || v > m.v ? { w, v } : m), null);
  return {
    days, curve, total, capital, capDate,
    ret: capital ? (total / capital) * 100 : 0,
    winRate: days.length ? (wins.length / days.length) * 100 : 0,
    wins: wins.length, losses: losses.length,
    pf: grossL ? grossP / grossL : Infinity, grossP, grossL,
    avg: days.length ? total / days.length : 0,
    maxDD, ddDate, bestStreak: best, currentStreak: current,
    bestDay, worstDay, bestWeek,
  };
}

/* ---------------- render ---------------- */
const SECTION_RENDER = {
  overview: () => renderBento(stats(forSection('overview'))),
  calendar: () => renderCalendar(),
  performance: () => renderEquity(stats(forSection('performance'))),
  strategies: () => { const e = forSection('strategies'); renderStrategies(e); renderMatrix(e); },
  journal: () => renderJournal(),
};

function render(first = false) {
  const all = stats(baseEntries());
  renderHero(all, first);
  if (skyline) skyline.setDays(all.days);
  SECTIONS.forEach(renderSection);
}
function renderSection(name) {
  $(`[data-label="${name}"]`).textContent = periodRange(state.period[name]).label;
  SECTION_RENDER[name]();
}
const emptyState = msg => `<div class="empty">${msg}</div>`;

/* ----- hero ----- */
function renderHero(s, first) {
  const last = s.days.at(-1);
  $('#heroRange').textContent = last ? `Trading data through ${dfmt(last.date, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'No trades yet';
  const el = $('#heroPnl');
  el.classList.toggle('neg', s.total < 0);
  countUp(el, s.total, first ? 1800 : 900, v => money(v));
  $('#heroRet').innerHTML = `<span class="${cls(s.ret)}">${pct(s.ret)}</span>`;
  $('#heroWin').textContent = s.winRate.toFixed(1) + '%';
  $('#heroDays').textContent = s.days.length;
}

function showTowerTip(day, pos) {
  const tip = $('#towerTip');
  if (!day) { tip.classList.remove('show'); return; }
  tip.innerHTML = `
    <div class="d">${dfmt(day.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase()}</div>
    <div class="p ${cls(day.pnl)}">${money(day.pnl)}</div>
    <div class="rows">${day.rows.map(r => `<div><span>${esc(r.short)}</span><span class="${cls(r.pnl)}">${money(r.pnl)}</span></div>`).join('')}</div>`;
  tip.style.left = pos.x + 'px';
  tip.style.top = pos.y + 'px';
  tip.classList.add('show');
}

/* ----- overview bento ----- */
function renderBento(s) {
  if (!s.days.length) { $('#bento').innerHTML = `<div class="card tile big">${emptyState('No trades in this period yet.')}</div>`; return; }
  const pfText = s.pf === Infinity ? '∞' : s.pf.toFixed(2);
  const ring = 2 * Math.PI * 34;
  const pTotal = s.grossP + s.grossL || 1;
  $('#bento').innerHTML = `
    <div class="card tile big tile-glow reveal">
      <div>
        <span class="k">Net P&amp;L</span>
        <div class="val ${cls(s.total)}" style="margin-top:12px">${money(s.total)}</div>
        <div class="foot-note" style="margin-top:10px">Across <b>${s.days.length}</b> trading days · <b>${compact(s.capital)}</b> deployed on ${dfmt(s.capDate)}</div>
      </div>
      <div class="tile-spark">${areaSpark(s.curve.map(c => c.cum), 'bentoSpark')}</div>
    </div>
    <div class="card tile reveal">
      <span class="k">Return</span>
      <div class="val ${cls(s.ret)}">${pct(s.ret)}</div>
      <div class="foot-note">P&amp;L ÷ <b>${compact(s.capital)}</b> deployed on ${dfmt(s.capDate)}</div>
    </div>
    <div class="card tile reveal">
      <span class="k">Win rate</span>
      <div class="ring-wrap">
        <svg class="ring" viewBox="0 0 78 78"><circle class="bg" cx="39" cy="39" r="34"/><circle class="fg" cx="39" cy="39" r="34" stroke-dasharray="${ring}" stroke-dashoffset="${ring}" data-to="${ring * (1 - s.winRate / 100)}"/></svg>
        <div><div class="val">${s.winRate.toFixed(0)}<span style="font-size:.5em">%</span></div><div class="foot-note"><b>${s.wins}</b>W · <b>${s.losses}</b>L</div></div>
      </div>
    </div>
    <div class="card tile reveal">
      <span class="k">Profit factor</span>
      <div class="val">${pfText}</div>
      <div>
        <div class="split-bar"><span style="flex-grow:${s.grossP / pTotal};background:var(--gain)"></span><span style="flex-grow:${s.grossL / pTotal};background:var(--loss)"></span></div>
        <div class="foot-note">gross profit ÷ gross loss</div>
      </div>
    </div>
    <div class="card tile reveal">
      <span class="k">Max drawdown</span>
      <div class="val ${s.maxDD < 0 ? 'neg' : ''}">${s.maxDD < 0 ? money(s.maxDD) : '₹0'}</div>
      <div class="foot-note">${s.ddDate ? 'trough on <b>' + dfmt(s.ddDate) + '</b>' : 'no drawdown in range'}</div>
    </div>
    <div class="card tile wide reveal">
      <span class="k">Best &amp; worst session</span>
      <div style="display:flex;gap:28px;flex-wrap:wrap;margin-top:10px">
        <div><div class="val pos">${money(s.bestDay.pnl)}</div><div class="foot-note">${dfmt(s.bestDay.date, { weekday: 'short', day: 'numeric', month: 'short' })}</div></div>
        <div><div class="val ${cls(s.worstDay.pnl)}">${money(s.worstDay.pnl)}</div><div class="foot-note">${dfmt(s.worstDay.date, { weekday: 'short', day: 'numeric', month: 'short' })}</div></div>
      </div>
    </div>
    <div class="card tile reveal">
      <span class="k">Average day</span>
      <div class="val ${cls(s.avg)}">${money(s.avg)}</div>
      <div class="foot-note">mean P&amp;L per session</div>
    </div>
    <div class="card tile reveal">
      <span class="k">Win streak</span>
      <div class="val">${s.bestStreak}<span style="font-size:.45em;color:var(--text-3)"> days</span></div>
      <div class="foot-note">current run <b>${s.currentStreak}</b></div>
    </div>`;
  observeReveals($('#bento'));
}

function areaSpark(vals, id) {
  if (vals.length < 2) return '';
  const w = 600, h = 160, min = Math.min(0, ...vals), max = Math.max(0, ...vals), span = max - min || 1;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - ((v - min) / span) * (h - 16) - 8]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4c56b" stop-opacity=".35"/><stop offset="1" stop-color="#f4c56b" stop-opacity="0"/></linearGradient></defs>
    <path d="${line} L${w} ${h} L0 ${h} Z" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="#f4c56b" stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/* ----- calendar: growing day by day ----- */
function renderCalendar() {
  const p = state.period.calendar;
  const s = stats(forSection('calendar'));
  const days = s.days;
  const map = new Map(days.map(d => [d.date, d]));

  const greens = days.filter(d => d.pnl > 0).length, reds = days.filter(d => d.pnl < 0).length;
  $('#calStats').innerHTML = [
    ['Green days', `<span class="pos">${greens}</span>`],
    ['Red days', `<span class="neg">${reds}</span>`],
    ['Hit rate', days.length ? (greens / days.length * 100).toFixed(0) + '%' : '—'],
    ['Best week', s.bestWeek ? `<span class="${cls(s.bestWeek.v)}">${scompact(s.bestWeek.v)}</span> <span class="muted" style="font-size:12px">w/c ${dfmt(s.bestWeek.w)}</span>` : '—'],
    ['Longest green run', `${s.bestStreak} <span class="muted" style="font-size:12px">days</span>`],
  ].map(([k, v]) => `<div class="cal-stat"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

  calCtx = { days, map };
  if (!days.length) {
    $('#calMain').innerHTML = emptyState('No trading days in this period yet.');
    closeDayDrawer();
    return;
  }
  if (!state.selDay || !map.has(state.selDay)) state.selDay = days.at(-1).date;

  renderMonthCards(days, map, p);
}

let calCtx = { days: [], map: new Map() };
function selectDay(date, open = false) {
  if (!calCtx.map.has(date)) return;
  state.selDay = date;
  document.querySelectorAll('.mc-tile.has').forEach(c => c.classList.toggle('sel', c.dataset.date === date));
  if (open) openDayDrawer();
  else if ($('#dayDrawer').classList.contains('open')) renderDayDrawer();
}

function calendarMonths(days, p) {
  const { from, to } = periodRange(p);
  const firstM = (p === 'all' || !from ? days[0].date : from).slice(0, 7);
  const todayM = TODAY.slice(0, 7);
  let endM = to && to.slice(0, 7) < todayM ? to.slice(0, 7) : todayM;
  const lastDataM = days.at(-1).date.slice(0, 7);
  if (lastDataM > endM) endM = lastDataM;
  const out = [];
  let [y, m] = firstM.split('-').map(Number);
  for (;;) {
    const k = `${y}-${pad(m)}`;
    out.push(k);
    if (k >= endM) break;
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// short tile label without ₹ so it fits a small tile: +2.3k, −870, +13k
function tileVal(n) {
  const a = Math.abs(n), s = n > 0 ? '+' : n < 0 ? '−' : '';
  if (a >= 1e5) return s + (a / 1e5).toFixed(1).replace(/\.0$/, '') + 'L';
  if (a >= 1e4) return s + Math.round(a / 1e3) + 'k';
  if (a >= 1e3) return s + (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return s + Math.round(a);
}

function renderMonthCards(days, map, p) {
  const host = $('#calMain');
  const months = calendarMonths(days, p);
  const per = Math.min(4, months.length);
  const solo = months.length === 1;
  const maxAbs = Math.max(...days.map(d => Math.abs(d.pnl)), 1);

  const cards = months.map(mk => {
    const [y, mo] = mk.split('-').map(Number);
    const from = `${mk}-01`, to = iso(new Date(y, mo, 0));
    const mdays = days.filter(d => d.date.startsWith(mk));
    const sum = mdays.reduce((a, d) => a + d.pnl, 0);
    const g = mdays.filter(d => d.pnl > 0).length, r = mdays.filter(d => d.pnl < 0).length;
    let tiles = ['M', 'T', 'W', 'T', 'F'].map(l => `<span class="mc-dow">${l}</span>`).join('');
    for (let w = mondayOf(from); w <= to; w = addDays(w, 7)) {
      if (addDays(w, 4) < from) continue; // no weekday of this month in that week
      for (let k = 0; k < 5; k++) {
        const d = addDays(w, k);
        if (d < from || d > to) { tiles += '<span class="mc-tile out"></span>'; continue; }
        const day = map.get(d);
        const n = +d.slice(8);
        if (!day) { tiles += `<span class="mc-tile ${d > TODAY ? 'future' : 'idle'}"><span class="dn">${n}</span></span>`; continue; }
        const ratio = Math.sqrt(Math.abs(day.pnl) / maxAbs);
        const rgb = day.pnl >= 0 ? '62,234,160' : '255,91,112';
        const tot = day.rows.reduce((a, x) => a + Math.abs(x.pnl), 0) || 1;
        tiles += `<button type="button" class="mc-tile has" data-date="${d}" style="--a:${(0.07 + 0.33 * ratio).toFixed(2)};--rgb:${rgb}">
          <span class="dn">${n}</span>
          <span class="dv">${solo ? money(day.pnl) : tileVal(day.pnl)}</span>
          ${solo ? `<span class="stack">${day.rows.map(x => `<span style="flex-grow:${Math.abs(x.pnl) / tot};background:${x.pnl >= 0 ? x.color : 'var(--loss)'}"></span>`).join('')}</span>` : ''}
        </button>`;
      }
    }
    return `<article class="mc-card${solo ? ' solo' : ''}">
      <header class="mc-head">
        <div><span class="mc-month">${new Date(y, mo - 1, 1).toLocaleDateString('en-IN', { month: 'long' })}</span> <span class="mc-year">${y}</span></div>
        <span class="mc-sum ${cls(sum)}">${mdays.length ? money(sum) : '—'}</span>
      </header>
      <div class="mc-ratio">${mdays.length ? `<span class="g" style="flex-grow:${g}"></span><span class="r" style="flex-grow:${r}"></span>` : ''}</div>
      <div class="mc-grid">${tiles}</div>
      <footer class="mc-foot"><span>${mdays.length} trading day${mdays.length === 1 ? '' : 's'}</span><span><b class="pos">${g}</b> green · <b class="neg">${r}</b> red</span></footer>
    </article>`;
  }).join('');

  const more = months.length > per;
  host.innerHTML = `
    ${more ? `<div class="mc-bar"><span class="mc-hint"></span><div class="mc-arrows"><button type="button" class="icon-btn" data-dir="-1" aria-label="Earlier months">‹</button><button type="button" class="icon-btn" data-dir="1" aria-label="Later months">›</button></div></div>` : ''}
    <div class="mc-scroll" style="--per:${per}">${cards}</div>`;

  host.querySelectorAll('.mc-tile.has').forEach(t => {
    const d = map.get(t.dataset.date);
    t.addEventListener('pointermove', e => showTip(dayTipHtml(d), e));
    t.addEventListener('pointerleave', hideTip);
    t.addEventListener('click', () => { hideTip(); selectDay(d.date, true); });
  });

  if (more) {
    const sc = host.querySelector('.mc-scroll');
    const step = () => sc.querySelector('.mc-card').offsetWidth + 14;
    const lab = k => `${MONTHS[+k.slice(5) - 1]} ${k.slice(0, 4)}`;
    const hint = () => {
      const first = Math.max(0, Math.min(months.length - per, Math.round(sc.scrollLeft / step())));
      const atStart = sc.scrollLeft < 4, atEnd = sc.scrollLeft > sc.scrollWidth - sc.clientWidth - 4;
      host.querySelector('.mc-hint').innerHTML = `Showing <b>${lab(months[first])} – ${lab(months[first + per - 1])}</b>${atStart ? '' : ' · scroll left for earlier months'}`;
      host.querySelector('[data-dir="-1"]').disabled = atStart;
      host.querySelector('[data-dir="1"]').disabled = atEnd;
    };
    host.querySelectorAll('.mc-arrows button').forEach(b => b.addEventListener('click', () => {
      sc.scrollBy({ left: +b.dataset.dir * step() * per, behavior: reducedMotion ? 'auto' : 'smooth' });
    }));
    sc.addEventListener('scroll', () => requestAnimationFrame(hint), { passive: true });
    sc.scrollLeft = sc.scrollWidth; // open on the latest months
    hint();
  }
  selectDay(state.selDay);
}

function dayTipHtml(d) {
  return `<div class="t">${dfmt(d.date, { weekday: 'long', day: 'numeric', month: 'short' })}</div><div class="b ${cls(d.pnl)}">${money(d.pnl)}</div>${d.rows.map(r => `<div class="r"><span>${esc(r.short)}</span><span class="${cls(r.pnl)}">${money(r.pnl)}</span></div>`).join('')}<div class="r" style="margin-top:6px;color:var(--text-3)"><span>Click to open</span></div>`;
}

/* ----- day analytics drawer ----- */
function setupDayDrawer() {
  $('#closeDay').addEventListener('click', closeDayDrawer);
  $('#dayBackdrop').addEventListener('click', closeDayDrawer);
  $('#ddPrev').addEventListener('click', () => stepDay(-1));
  $('#ddNext').addEventListener('click', () => stepDay(1));
  addEventListener('keydown', e => {
    if (!$('#dayDrawer').classList.contains('open')) return;
    if (e.key === 'Escape') closeDayDrawer();
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepDay(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); stepDay(1); }
  });
}
function openDayDrawer() {
  renderDayDrawer();
  const back = $('#dayBackdrop'), dr = $('#dayDrawer');
  back.hidden = false; requestAnimationFrame(() => back.classList.add('show'));
  dr.classList.add('open'); dr.setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#closeDay').focus(), 300);
}
function closeDayDrawer() {
  const back = $('#dayBackdrop'), dr = $('#dayDrawer');
  if (!dr.classList.contains('open')) return;
  back.classList.remove('show'); dr.classList.remove('open'); dr.setAttribute('aria-hidden', 'true');
  setTimeout(() => { back.hidden = true; }, 300);
}
function stepDay(dir) {
  const { days } = calCtx;
  const i = days.findIndex(x => x.date === state.selDay);
  const n = days[i + dir];
  if (n) selectDay(n.date);
}

function renderDayDrawer() {
  const { days, map } = calCtx;
  const d = map.get(state.selDay);
  if (!d) return;
  const idx = days.findIndex(x => x.date === d.date);
  const wk = mondayOf(d.date);
  const weekSum = days.filter(x => mondayOf(x.date) === wk && x.date <= d.date).reduce((a, x) => a + x.pnl, 0);
  const mtd = days.filter(x => x.date.slice(0, 7) === d.date.slice(0, 7) && x.date <= d.date).reduce((a, x) => a + x.pnl, 0);
  const running = days.slice(0, idx + 1).reduce((a, x) => a + x.pnl, 0);
  const capital = d.rows.reduce((a, r) => a + r.funds, 0);
  const avg = days.reduce((a, x) => a + x.pnl, 0) / days.length;
  const rank = [...days].sort((a, b) => b.pnl - a.pnl).findIndex(x => x.date === d.date) + 1;
  const beat = (days.filter(x => x.pnl < d.pnl).length / days.length) * 100;
  const sign = Math.sign(d.pnl);
  let streak = 0;
  for (let i = idx; i >= 0 && sign !== 0 && Math.sign(days[i].pnl) === sign; i--) streak++;
  const rows = [...d.rows].sort((a, b) => b.pnl - a.pnl);
  const maxR = Math.max(...rows.map(r => Math.abs(r.pnl)), 1);
  const stratMtd = id => days.filter(x => x.date.slice(0, 7) === d.date.slice(0, 7) && x.date <= d.date)
    .reduce((a, x) => a + x.rows.filter(r => r.id === id).reduce((s, r) => s + r.pnl, 0), 0);

  // sessions around this day
  const w0 = Math.max(0, Math.min(idx - 14, days.length - 21)), win = days.slice(w0, w0 + 21);
  const wMax = Math.max(...win.map(x => Math.abs(x.pnl)), 1);
  const bw = 400 / win.length;
  const spark = `<svg viewBox="0 0 400 90" preserveAspectRatio="none" role="img" aria-label="Sessions around this day">
    <line x1="0" x2="400" y1="45" y2="45" stroke="rgba(255,255,255,.1)"/>
    ${win.map((x, i) => {
      const h = Math.max(2, (Math.abs(x.pnl) / wMax) * 42);
      const me = x.date === d.date;
      return `<rect class="dd-sbar${me ? ' me' : ''}" data-date="${x.date}" x="${(i * bw + bw * 0.18).toFixed(1)}" y="${x.pnl >= 0 ? 45 - h : 45}" width="${(bw * 0.64).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${me ? 'var(--gold)' : x.pnl >= 0 ? 'rgba(62,234,160,.55)' : 'rgba(255,91,112,.55)'}"/>`;
    }).join('')}
  </svg>`;

  // this week
  const week = [0, 1, 2, 3, 4].map(k => {
    const date = addDays(wk, k), x = map.get(date);
    const lbl = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][k];
    if (!x) return `<div class="dd-wd idle"><span class="l">${lbl}</span><span class="v">—</span></div>`;
    const rgb = x.pnl >= 0 ? '62,234,160' : '255,91,112';
    return `<button type="button" class="dd-wd${x.date === d.date ? ' me' : ''}" data-date="${x.date}" style="--rgb:${rgb}"><span class="l">${lbl} ${+date.slice(8)}</span><span class="v">${tileVal(x.pnl)}</span></button>`;
  }).join('');

  $('#ddTitle').textContent = dfmt(d.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#ddBody').innerHTML = `
    <div class="dd-hero">
      <div class="dd-amt ${cls(d.pnl)}">${money(d.pnl)}</div>
      <div class="dd-chips">
        <span>Return <b class="${cls(d.pnl)}">${pct(capital ? (d.pnl / capital) * 100 : 0)}</b></span>
        <span>Capital <b>${compact(capital)}</b></span>
        <span>Rank <b>#${rank}</b> of ${days.length}</span>
      </div>
    </div>

    <section class="dd-sec">
      <div class="dd-sec-h"><h4>Around this day</h4><span class="muted small">${win.length} sessions · gold is this day</span></div>
      <div class="dd-spark">${spark}</div>
    </section>

    <section class="dd-sec">
      <div class="dd-sec-h"><h4>This week</h4><span class="${cls(weekSum)} mono">${money(weekSum)} so far</span></div>
      <div class="dd-week">${week}</div>
    </section>

    <section class="dd-sec">
      <div class="dd-sec-h"><h4>By strategy</h4><span class="muted small">${rows.length} traded</span></div>
      <div class="dd-rows">
        ${rows.map(r => {
          const m = stratMtd(r.id);
          return `<div class="dd-row" style="--c:${r.color}">
            <div class="top"><span class="nm"><i></i>${esc(r.short)} <span class="muted small">${esc(r.trader)}</span></span><b class="${cls(r.pnl)}">${money(r.pnl)}</b></div>
            <div class="bar"><span style="width:${((Math.abs(r.pnl) / maxR) * 100).toFixed(1)}%;background:${r.pnl >= 0 ? r.color : 'var(--loss)'}"></span></div>
            <div class="sub"><span>${pct(r.funds ? (r.pnl / r.funds) * 100 : 0)} on ${compact(r.funds)}</span><span>Month so far <b class="${cls(m)}">${money(m)}</b></span></div>
          </div>`;
        }).join('')}
      </div>
    </section>

    <section class="dd-sec">
      <div class="dd-sec-h"><h4>In context</h4><span class="muted small">${esc(periodRange(state.period.calendar).label.split(' · ')[0])}</span></div>
      <div class="dd-grid">
        <div><span class="k">Month so far</span><span class="v ${cls(mtd)}">${money(mtd)}</span></div>
        <div><span class="k">Running total</span><span class="v ${cls(running)}">${money(running)}</span></div>
        <div><span class="k">vs average day</span><span class="v ${cls(d.pnl - avg)}">${money(d.pnl - avg)}</span></div>
        <div><span class="k">Better than</span><span class="v">${beat.toFixed(0)}% <span class="muted small">of days</span></span></div>
        <div><span class="k">${sign >= 0 ? 'Green' : 'Red'} streak</span><span class="v ${sign >= 0 ? 'pos' : 'neg'}">${streak} day${streak === 1 ? '' : 's'}</span></div>
        <div><span class="k">Session</span><span class="v">${idx + 1} <span class="muted small">of ${days.length}</span></span></div>
      </div>
    </section>`;

  $('#ddBody').querySelectorAll('[data-date]').forEach(el => el.addEventListener('click', () => selectDay(el.dataset.date)));
  $('#ddPrev').disabled = idx === 0;
  $('#ddNext').disabled = idx === days.length - 1;
}

/* ----- performance ----- */
function renderEquity(s) {
  const host = $('#equityChart');
  const curve = s.curve;
  $('#equityMini').innerHTML = `
    <div><span class="k">Peak</span><span class="v pos">${money(Math.max(0, ...curve.map(c => c.cum)), false)}</span></div>
    <div><span class="k">Max DD</span><span class="v neg">${s.maxDD < 0 ? money(s.maxDD) : '₹0'}</span></div>
    <div><span class="k">Days</span><span class="v">${curve.length}</span></div>`;
  const setRead = c => {
    $('#equityRead').innerHTML = `<span class="${cls(c.cum)}">${money(c.cum)}</span>`;
    $('#equityDate').textContent = `${dfmt(c.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · day ${money(c.pnl)}`;
  };
  if (curve.length < 2) {
    host.innerHTML = emptyState('Not enough trading days in this period yet.');
    if (curve[0]) setRead(curve[0]); else { $('#equityRead').textContent = '—'; $('#equityDate').textContent = ''; }
    return;
  }

  const W = host.clientWidth || 1000, H = host.clientHeight || 420;
  const padL = 58, padR = 12, padT = 12, ddH = H * 0.22, gap = 26, padB = 24;
  const mainH = H - ddH - gap - padT - padB;
  const xs = i => padL + (i / (curve.length - 1)) * (W - padL - padR);
  const vals = curve.map(c => c.cum);
  const vmin = Math.min(0, ...vals), vmax = Math.max(0, ...vals), span = vmax - vmin || 1;
  const ys = v => padT + mainH - ((v - vmin) / span) * mainH;
  const ddMin = Math.min(-1, ...curve.map(c => c.dd));
  const ddTop = padT + mainH + gap;
  const yd = v => ddTop + (v / ddMin) * ddH;

  const line = curve.map((c, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)} ${ys(c.cum).toFixed(1)}`).join(' ');
  const area = `${line} L${xs(curve.length - 1)} ${ys(vmin)} L${xs(0)} ${ys(vmin)} Z`;
  const ddLine = curve.map((c, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)} ${yd(c.dd).toFixed(1)}`).join(' ');
  const ddArea = `M${xs(0)} ${ddTop} ${ddLine.replace(/^M/, 'L')} L${xs(curve.length - 1)} ${ddTop} Z`;

  const ticks = niceTicks(vmin, vmax, 5);
  const xt = [];
  const step = Math.max(1, Math.ceil(curve.length / Math.max(3, Math.floor(W / 120))));
  for (let i = 0; i < curve.length; i += step) xt.push(i);

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative P&L chart">
    <defs>
      <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4c56b" stop-opacity=".28"/><stop offset=".7" stop-color="#f4c56b" stop-opacity=".04"/><stop offset="1" stop-color="#f4c56b" stop-opacity="0"/></linearGradient>
      <linearGradient id="eqStroke" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#a78bfa"/><stop offset=".55" stop-color="#f4c56b"/><stop offset="1" stop-color="#ffe3a8"/></linearGradient>
      <linearGradient id="ddFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5b70" stop-opacity=".05"/><stop offset="1" stop-color="#ff5b70" stop-opacity=".35"/></linearGradient>
      <clipPath id="eqClip"><rect x="0" y="0" width="0" height="${H}"><animate attributeName="width" from="0" to="${W}" dur="${reducedMotion ? '0.01s' : '1.6s'}" fill="freeze" calcMode="spline" keySplines="0.22 1 0.36 1" keyTimes="0;1" begin="indefinite" id="eqAnim"/></rect></clipPath>
    </defs>
    <g class="axis">
      ${ticks.map(t => `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${ys(t)}" y2="${ys(t)}"/><text x="${padL - 10}" y="${ys(t) + 3.5}" text-anchor="end">${compact(t)}</text>`).join('')}
      ${xt.map(i => `<text x="${xs(i)}" y="${H - 4}" text-anchor="middle">${dfmt(curve[i].date)}</text>`).join('')}
      <text x="${padL - 10}" y="${ddTop + 10}" text-anchor="end">DD</text>
      <line class="gridline" x1="${padL}" x2="${W - padR}" y1="${ddTop}" y2="${ddTop}"/>
    </g>
    <g clip-path="url(#eqClip)">
      <path d="${area}" fill="url(#eqFill)"/>
      <line x1="${padL}" x2="${W - padR}" y1="${ys(0)}" y2="${ys(0)}" stroke="rgba(255,255,255,.18)"/>
      <path d="${line}" class="eq-line"/>
      <path d="${ddArea}" class="dd-area"/>
      <path d="${ddLine}" class="dd-line"/>
    </g>
    <g class="crosshair" opacity="0">
      <line class="cx" y1="${padT}" y2="${H - padB}"/>
      <circle class="cdot" r="5.5"/>
    </g>
    <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" class="hit"/>
  </svg>`;

  const svg = host.querySelector('svg');
  const ch = svg.querySelector('.crosshair');
  const cx = svg.querySelector('.cx'), cd = svg.querySelector('.cdot');
  setRead(curve.at(-1));
  svg.querySelector('.hit').addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(curve.length - 1, Math.round(((x - padL) / (W - padL - padR)) * (curve.length - 1))));
    ch.setAttribute('opacity', 1);
    cx.setAttribute('x1', xs(i)); cx.setAttribute('x2', xs(i));
    cd.setAttribute('cx', xs(i)); cd.setAttribute('cy', ys(curve[i].cum));
    setRead(curve[i]);
  });
  svg.querySelector('.hit').addEventListener('pointerleave', () => { ch.setAttribute('opacity', 0); setRead(curve.at(-1)); });

  const anim = svg.querySelector('#eqAnim');
  const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) { anim.beginElement(); io.disconnect(); } }, { threshold: 0.3 });
  io.observe(host);
}

function niceTicks(min, max, n) {
  const span = max - min || 1;
  const raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/* ----- strategies ----- */
function renderStrategies(entries) {
  const ids = [...new Set(entries.map(e => e.strategy))];
  const rows = ids.map(id => {
    const es = entries.filter(e => e.strategy === id);
    const pnl = es.reduce((s, e) => s + e.pnl, 0);
    const maxF = capitalOf(es); // capital on this strategy's latest date in the period
    let c = 0;
    return {
      s: stratById(id), pnl, maxF, n: es.length,
      win: (es.filter(e => e.pnl > 0).length / es.length) * 100,
      w: es.filter(e => e.pnl > 0).length, l: es.filter(e => e.pnl < 0).length,
      curve: es.map(e => (c += e.pnl)),
    };
  }).sort((a, b) => b.pnl - a.pnl);

  $('#stratGrid').innerHTML = rows.length ? rows.map((r, i) => `
    <article class="strat-card reveal" style="--c:${r.s.color}">
      <div class="shine"></div>
      <div class="strat-top">
        <div><div class="strat-trader">${esc(r.s.trader)}</div><div class="strat-name">${esc(r.s.short)}</div></div>
        <div class="rank">${String(i + 1).padStart(2, '0')}</div>
      </div>
      <div class="strat-pnl ${cls(r.pnl)}">${money(r.pnl)}</div>
      <div class="strat-spark">${lineSpark(r.curve, r.s.color)}</div>
      <div class="strat-meta">
        <div><span class="k">Trades</span><span class="v">${r.n} <small class="wl"><b class="pos">${r.w}W</b> <b class="neg">${r.l}L</b></small></span></div>
        <div><span class="k">Win rate</span><span class="v">${r.win.toFixed(0)}%</span></div>
        <div><span class="k">Return</span><span class="v ${cls(r.pnl)}">${pct(r.maxF ? (r.pnl / r.maxF) * 100 : 0)}</span></div>
        <div><span class="k">Capital</span><span class="v">${compact(r.maxF)}</span></div>
      </div>
    </article>`).join('') : emptyState('No strategy traded in this period yet.');

  $('#stratGrid').querySelectorAll('.strat-card').forEach(card => {
    if (reducedMotion) return;
    card.addEventListener('pointermove', e => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      card.style.transform = `rotateX(${(0.5 - py) * 10}deg) rotateY(${(px - 0.5) * 12}deg) translateZ(0)`;
      card.style.setProperty('--mx', px * 100 + '%');
      card.style.setProperty('--my', py * 100 + '%');
    });
    card.addEventListener('pointerleave', () => { card.style.transform = ''; });
  });
  observeReveals($('#stratGrid'));
}

function lineSpark(vals, color) {
  if (vals.length < 2) return '';
  const w = 300, h = 54, min = Math.min(0, ...vals), max = Math.max(0, ...vals), span = max - min || 1;
  const y = v => h - ((v - min) / span) * (h - 6) - 3;
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * w).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const gid = 'g' + Math.random().toString(36).slice(2, 8);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".3"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(255,255,255,.1)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>
    <path d="${d} L${w} ${h} L0 ${h} Z" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 0 4px ${color})"/>
  </svg>`;
}

/* ----- contribution waterfall ----- */
function renderMatrix(entries) {
  const host = $('#matrix');
  if (!entries.length) { host.innerHTML = emptyState('Nothing to show for this period yet.'); return; }
  const months = [...new Set(entries.map(e => e.date.slice(0, 7)))].sort();
  const byWeek = months.length <= 1;
  const keyOf = e => (byWeek ? mondayOf(e.date) : e.date.slice(0, 7));
  const cols = [...new Set(entries.map(keyOf))].sort();
  const colLabel = k => (byWeek ? 'Week of ' + dfmt(k) : `${MONTHS[+k.slice(5) - 1]} ${k.slice(0, 4)}`);
  $('#matrixSub').textContent = `How each strategy built the net for this period. Bars step from left to right and add up to the gold net line; the small bars show each ${byWeek ? 'week' : 'month'}.`;

  const tot = {}, cell = {}, colTot = {};
  for (const e of entries) {
    const k = keyOf(e);
    tot[e.strategy] = (tot[e.strategy] || 0) + e.pnl;
    cell[e.strategy + '|' + k] = (cell[e.strategy + '|' + k] || 0) + e.pnl;
    colTot[k] = (colTot[k] || 0) + e.pnl;
  }
  const ids = Object.keys(tot).sort((a, b) => tot[b] - tot[a]);
  const net = ids.reduce((a, id) => a + tot[id], 0);

  let run = 0, lo = 0, hi = 0;
  const steps = ids.map(id => {
    const from = run; run += tot[id];
    lo = Math.min(lo, from, run); hi = Math.max(hi, from, run);
    return { id, from, to: run };
  });
  const span = hi - lo || 1;
  const pos = v => (((v - lo) / span) * 100).toFixed(2);
  const width = v => ((Math.abs(v) / span) * 100).toFixed(2);

  const mini = (vals, color) => {
    const m = Math.max(...vals.map(Math.abs), 1);
    return `<div class="wf-mini" style="--c:${color}">${vals.map((v, i) => {
      const h = v ? Math.max(6, (Math.abs(v) / m) * 50) : 0;
      return `<span class="${v > 0 ? 'u' : v < 0 ? 'd' : 'z'}" data-tip="${esc(colLabel(cols[i]))}|${v}"><i style="height:${h.toFixed(1)}%"></i></span>`;
    }).join('')}</div>`;
  };
  const share = v => (net > 0 ? `${v < 0 ? '−' : ''}${Math.abs((v / net) * 100).toFixed(0)}%` : '—');

  let html = `<div class="wf-row wf-head"><span>Strategy</span><span>How the net was built</span><span class="r">P&amp;L</span><span class="r">Share</span><span>By ${byWeek ? 'week' : 'month'}</span></div>`;
  steps.forEach((st, i) => {
    const s = stratById(st.id), v = tot[st.id];
    html += `<div class="wf-row" style="--c:${s.color}">
      <div class="wf-name"><i></i><span><small>${esc(s.trader)}</small>${esc(s.short)}</span></div>
      <div class="wf-track" style="--zero:${pos(0)}%">
        <span class="wf-bar ${v >= 0 ? 'p' : 'n'}" style="left:${pos(Math.min(st.from, st.to))}%;width:${width(v)}%;transition-delay:${i * 90}ms"></span>
        <span class="wf-tick" style="left:${pos(st.to)}%"></span>
      </div>
      <div class="wf-val ${cls(v)}">${money(v)}</div>
      <div class="wf-share">${share(v)}</div>
      ${mini(cols.map(k => cell[st.id + '|' + k] || 0), s.color)}
    </div>`;
  });
  html += `<div class="wf-row net" style="--c:var(--gold)">
    <div class="wf-name">Net</div>
    <div class="wf-track" style="--zero:${pos(0)}%">
      <span class="wf-bar ${net >= 0 ? 'p' : 'n'}" style="left:${pos(Math.min(0, net))}%;width:${width(net)}%;transition-delay:${steps.length * 90}ms"></span>
    </div>
    <div class="wf-val ${cls(net)}">${money(net)}</div>
    <div class="wf-share">${net > 0 ? '100%' : '—'}</div>
    ${mini(cols.map(k => colTot[k] || 0), 'var(--gold)')}
  </div>`;
  host.innerHTML = html;
  host.classList.remove('in');

  host.querySelectorAll('.wf-mini span[data-tip]').forEach(c => {
    c.addEventListener('pointermove', e => {
      const [col, v] = c.dataset.tip.split('|');
      showTip(`<div class="t">${col}</div><div class="b ${cls(+v)}">${+v ? money(+v) : 'No trades'}</div>`, e);
    });
    c.addEventListener('pointerleave', hideTip);
  });
  if (reducedMotion) { host.classList.add('in'); return; }
  const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) { host.classList.add('in'); io.disconnect(); } }, { threshold: 0.2 });
  io.observe(host);
}

/* ----- journal ----- */
let freshKey = null;
function renderJournal() {
  const q = $('#journalSearch').value.trim().toLowerCase();
  const rows = forSection('journal').slice().reverse().filter(e => {
    if (!q) return true;
    const s = stratById(e.strategy);
    return (s.name + ' ' + e.date + ' ' + dfmt(e.date, { day: 'numeric', month: 'long' })).toLowerCase().includes(q);
  });
  $('#journalCount').textContent = `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`;
  $('#ledger tbody').innerHTML = rows.map(e => {
    const s = stratById(e.strategy);
    const key = e.date + '|' + e.strategy;
    return `<tr class="${key === freshKey ? 'fresh' : ''}">
      <td class="date">${dfmt(e.date, { day: '2-digit', month: 'short', year: 'numeric' })}</td>
      <td><span class="sname" style="--c:${s.color}"><i></i>${esc(s.name)}</span></td>
      <td class="num">${money(e.investedFunds, false)}</td>
      <td class="num ${cls(e.pnl)}">${money(e.pnl)}</td>
      <td class="num ${cls(e.pnl)}">${pct(e.investedFunds ? (e.pnl / e.investedFunds) * 100 : 0)}</td>
      <td class="act"><button type="button" class="row-del" data-key="${esc(key)}" aria-label="Delete ${esc(s.name)} entry on ${e.date}" title="Delete entry">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9m0-9l-9 9" /></svg></button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">No entries in this period.</td></tr>';
  $('#ledger tbody').querySelectorAll('.row-del').forEach(b => b.addEventListener('click', () => deleteEntry(b.dataset.key)));
}

async function deleteEntry(key) {
  const [date, strategy] = key.split('|');
  const idx = data.entries.findIndex(x => x.date === date && x.strategy === strategy);
  if (idx < 0) return;
  const e = data.entries[idx], s = stratById(strategy);
  const who = await askPasskey(`
    <p>Delete this entry? This removes it from every section.</p>
    <div class="pk-entry" style="--c:${s.color}">
      <span><i></i>${esc(s.name)}</span>
      <span class="mono">${dfmt(date, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
      <b class="${cls(e.pnl)}">${money(e.pnl)}</b>
    </div>`, { okLabel: 'Delete entry', danger: true });
  if (!who) return;
  const res = await runOp('deleteEntry', { date, strategy }, who.key);
  if (!res) return; // not saved — nothing changed, the error was shown
  const removed = res.result.removed;
  toast(`Entry deleted by ${who.who}`, {
    label: 'Undo',
    run: async () => {
      const back = await runOp('restoreEntries', { entries: [removed] }, who.key);
      if (back) { freshKey = key; renderJournal(); toast('Entry restored'); }
    },
  });
}

/* ----- downloads: always the ENTIRE dataset, not the current filter/period ----- */
const EXEC_LABEL = { clean: 'Clean run', manual: 'Manual exit', tech: 'Technical glitch' };
function saveFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => TODAY;
function sortedEntries() {
  return [...data.entries].sort((a, b) => a.date.localeCompare(b.date) || a.strategy.localeCompare(b.strategy));
}
async function downloadJson() {
  if (!(await refreshLive({ quiet: true }))) return; // always download the very latest
  // same { strategies, entries } shape as the JSONBin backup, so it can be re-imported
  const out = { strategies: data.strategies, entries: sortedEntries() };
  saveFile(`tradedesk-data-${stamp()}.json`, JSON.stringify(out, null, 2), 'application/json');
  toast(`Downloaded ${out.entries.length} entries · ${out.strategies.length} strategies (JSON)`);
}
async function downloadCsv() {
  if (!(await refreshLive({ quiet: true }))) return; // always download the very latest
  const cell = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['Date', 'Trader', 'Strategy', 'Strategy ID', 'Capital Deployed (INR)', 'P&L (INR)', 'Return %', 'Execution']];
  sortedEntries().forEach(e => {
    const s = stratById(e.strategy);
    rows.push([
      e.date, s.trader, s.short, e.strategy, e.investedFunds, e.pnl,
      e.investedFunds ? ((e.pnl / e.investedFunds) * 100).toFixed(2) : '',
      EXEC_LABEL[e.execution] || '',
    ]);
  });
  // BOM so Excel reads it as UTF-8; CRLF line endings for Excel on Windows
  saveFile(`tradedesk-data-${stamp()}.csv`, '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  toast(`Downloaded ${rows.length - 1} entries (CSV)`);
}

/* ----- import: replace ALL data from a JSON backup (passkey + Undo) ----- */
function parseBackup(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return { error: 'This file isn’t valid JSON.' }; }
  if (raw && raw.record && Array.isArray(raw.record.entries)) raw = raw.record; // raw JSONBin response
  if (!raw || !Array.isArray(raw.strategies) || !Array.isArray(raw.entries)) {
    return { error: 'This file doesn’t look like a TradeDesk backup (it needs “strategies” and “entries”).' };
  }
  const strategies = raw.strategies.filter(s => s && typeof s.id === 'string' && s.id && typeof s.name === 'string' && s.name.trim());
  const ids = new Set(strategies.map(s => s.id));
  let skipped = 0;
  const seen = new Map();
  for (const e of raw.entries) {
    const ok = e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && ids.has(e.strategy)
      && Number.isFinite(+e.pnl) && Number.isFinite(+e.investedFunds);
    if (!ok) { skipped++; continue; }
    const clean = { ...e, pnl: +e.pnl, investedFunds: +e.investedFunds };
    seen.set(e.date + '|' + e.strategy, clean); // a duplicate date+strategy keeps the last row
  }
  const entries = [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
  const dupes = raw.entries.length - skipped - entries.length;
  if (!strategies.length) return { error: 'No valid strategies found in this file.' };
  return { data: { strategies, entries }, skipped: skipped + (raw.strategies.length - strategies.length), dupes };
}

async function importJson(file) {
  if (file.size > 5 * 1024 * 1024) { toast('That file is too large for a TradeDesk backup (over 5 MB).'); return; }
  const parsed = parseBackup(await file.text());
  if (parsed.error) { toast(parsed.error); return; }
  const next = parsed.data;
  const dates = next.entries.map(e => e.date);
  const span = dates.length ? `${dfmt(dates[0], { day: 'numeric', month: 'short', year: 'numeric' })} – ${dfmt(dates.at(-1), { day: 'numeric', month: 'short', year: 'numeric' })}` : 'no entries';
  const net = next.entries.reduce((a, e) => a + e.pnl, 0);
  const row = (k, now, then) => `<div class="imp-row"><span>${k}</span><span class="muted">${then}</span><span class="arrow">→</span><b>${now}</b></div>`;
  const who = await askPasskey(`
    <p>Replace <b>all</b> current data with <span class="mono">${esc(file.name)}</span>?</p>
    <div class="imp-sum">
      <div class="imp-row head"><span></span><span>Now</span><span></span><span>From file</span></div>
      ${row('Strategies', next.strategies.length, data.strategies.length)}
      ${row('Entries', next.entries.length, data.entries.length)}
      ${row('Net P&amp;L', `<span class="${cls(net)}">${money(net)}</span>`, money(data.entries.reduce((a, e) => a + e.pnl, 0)))}
      <div class="imp-span">${span}</div>
    </div>
    ${parsed.skipped || parsed.dupes ? `<p class="imp-warn">${parsed.skipped ? `${parsed.skipped} invalid row${parsed.skipped === 1 ? '' : 's'} will be skipped. ` : ''}${parsed.dupes ? `${parsed.dupes} duplicate date+strategy row${parsed.dupes === 1 ? '' : 's'} merged.` : ''}</p>` : ''}`,
    { okLabel: 'Replace data', danger: true });
  if (!who) return;
  const before = { strategies: data.strategies, entries: data.entries }; // what Undo puts back
  state.picked.clear();
  state.selDay = null;
  const res = await runOp('replaceAll', { data: next }, who.key);
  if (!res) return;
  toast(`Imported ${res.result.entries} entries · ${res.result.strategies} strategies by ${who.who}`, {
    label: 'Undo',
    run: async () => {
      state.picked.clear(); state.selDay = null;
      if (await runOp('replaceAll', { data: before }, who.key)) toast('Previous data restored');
    },
  });
}

function refreshAfterDataChange() {
  enrich();
  buildFilters();
  render();
}

/* ---------------- passkey (Nishant / Vinayak) ----------------
   Checked by the server (/api/passkey) and again on every protected
   change (/api/ops). Nothing about the passkeys lives in this file.
   Resolves to { who, key } — the key is kept only in memory for the
   action (and its Undo), never stored. */
function askPasskey(detailHtml, { okLabel = 'Unlock', danger = false } = {}) {
  return new Promise(resolve => {
    const back = $('#modalBack'), modal = $('#passModal'), form = $('#passForm');
    const input = $('#passInput'), err = $('#passErr'), ok = $('#passOk');
    $('#passDetail').innerHTML = detailHtml;
    ok.textContent = okLabel;
    ok.classList.toggle('danger', danger);
    input.value = ''; err.textContent = '';
    showModal(modal);
    setTimeout(() => input.focus(), 60);

    const done = who => {
      form.removeEventListener('submit', onSubmit);
      modal.querySelector('[data-cancel]').removeEventListener('click', onCancel);
      back.removeEventListener('pointerdown', onBack);
      removeEventListener('keydown', onKey, true);
      hideModal(modal);
      resolve(who);
    };
    const onCancel = () => done(null);
    const onBack = e => { if (e.target === back) done(null); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    let checking = false;
    const onSubmit = async e => {
      e.preventDefault();
      if (checking) return;
      const key = input.value.trim();
      if (!key) { err.textContent = 'Enter your passkey.'; return; }
      if (!LIVE.connected) { err.textContent = 'Not connected to live data.'; return; }
      checking = true; ok.disabled = true; err.textContent = '';
      try {
        const json = await apiCall('/passkey', { passkey: key });
        done({ who: json.who, key });
        return;
      } catch (ex) {
        err.textContent = ex.message;
      } finally { checking = false; ok.disabled = false; }
      input.value = '';
      modal.classList.remove('shake'); void modal.offsetWidth; modal.classList.add('shake');
      input.focus();
    };
    form.addEventListener('submit', onSubmit);
    modal.querySelector('[data-cancel]').addEventListener('click', onCancel);
    back.addEventListener('pointerdown', onBack);
    addEventListener('keydown', onKey, true);
  });
}
function showModal(modal) {
  const back = $('#modalBack');
  document.querySelectorAll('.modal').forEach(m => { m.hidden = m !== modal; });
  back.hidden = false;
  requestAnimationFrame(() => { back.classList.add('show'); modal.classList.add('show'); });
}
function hideModal(modal) {
  const back = $('#modalBack');
  back.classList.remove('show'); modal.classList.remove('show');
  setTimeout(() => { if (!back.classList.contains('show')) { back.hidden = true; modal.hidden = true; } }, 250);
}

/* ---------------- register a new strategy ---------------- */
const MARKETS = ['NSE', 'BSE', 'MCX'];
const marketsOf = s => {
  const list = Array.isArray(s.markets) ? s.markets : s.market ? [s.market] : [];
  return MARKETS.filter(m => list.some(x => String(x).toUpperCase().startsWith(m)));
};
// multi-select chips: picked is a Set that the chips toggle
function marketChips(host, picked, onChange) {
  host.innerHTML = MARKETS.map(m => `<button type="button" class="rchip${picked.has(m) ? ' on' : ''}" data-v="${m}" aria-pressed="${picked.has(m)}">${m}</button>`).join('');
  host.querySelectorAll('.rchip').forEach(b => b.addEventListener('click', () => {
    const m = b.dataset.v;
    if (picked.has(m)) picked.delete(m); else picked.add(m);
    b.classList.toggle('on', picked.has(m)); b.setAttribute('aria-pressed', picked.has(m));
    onChange?.();
  }));
}
const pickedList = picked => MARKETS.filter(m => picked.has(m));
const SWATCHES = ['#f4c56b', '#4cc9f0', '#a78bfa', '#ff9f5a', '#f472b6', '#60a5fa', '#e9e46b', '#c4b5fd', '#5eead4', '#fca5a5'];
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/* Manage strategies: one passkey, then list (rename / delete) + add form */
let openStrategyForm = null;
async function manageStrategies(onChange) {
  const who = await askPasskey('<p>Only Nishant or Vinayak can add, rename or delete strategies.</p>', { okLabel: 'Unlock' });
  if (!who) return;
  const modal = $('#regModal');
  $('#regWho').innerHTML = `<i></i>Unlocked by ${esc(who.who)}`;
  let lastAdded = null;
  const showList = () => { setManageView('list'); renderStrategyList(who, onChange, lastAdded); lastAdded = null; };
  const onKey = e => {
    if (e.key !== 'Escape' || e.target.closest?.('.sl-input')) return;
    e.stopPropagation();
    if (!$('#regForm').hidden) $('#regForm [data-cancel]').click(); else finish();
  };
  const finish = () => {
    removeEventListener('keydown', onKey, true);
    $('#addStratBtn').onclick = null; $('#doneStrat').onclick = null;
    hideModal(modal);
  };
  // Add and Edit open the same full form (edit = pre-filled with the strategy's current values)
  openStrategyForm = editId => showStrategyForm(who, id => { lastAdded = id; onChange?.(id); showList(); }, showList, editId);
  $('#addStratBtn').onclick = () => openStrategyForm();
  $('#doneStrat').onclick = finish;
  addEventListener('keydown', onKey, true);
  showList();
  showModal(modal);
}

function setManageView(v, editing = false) {
  $('#regList').hidden = v !== 'list';
  $('#regForm').hidden = v !== 'form';
  $('#regTitle').textContent = v === 'list' ? 'Manage strategies' : editing ? 'Edit strategy' : 'Register a strategy';
  $('#regKicker').textContent = v === 'list' ? `${strategies.length} strateg${strategies.length === 1 ? 'y' : 'ies'}` : editing ? 'Edit' : 'New strategy';
}

function renderStrategyList(who, onChange, highlight) {
  const host = $('#stratList');
  const count = id => data.entries.filter(e => e.strategy === id).length;
  const plural = n => `${n} entr${n === 1 ? 'y' : 'ies'}`;
  const groups = {};
  strategies.forEach(s => { (groups[s.trader] = groups[s.trader] || []).push(s); });
  host.innerHTML = Object.entries(groups).map(([t, list]) => `
    <div class="sl-group"><span class="sl-trader">${esc(t)}</span>
      ${list.map(s => `<div class="sl-row${s.id === highlight ? ' fresh' : ''}" data-id="${esc(s.id)}" style="--c:${s.color}">
        <i class="sl-dot"></i>
        <div class="sl-main"><span class="sl-name">${esc(s.short)}</span><span class="sl-meta">${plural(count(s.id))}${marketsOf(s).length ? ' · ' + marketsOf(s).join(' + ') : ''}${s.registeredBy ? ' · added by ' + esc(s.registeredBy) : ''}</span></div>
        <div class="sl-actions">
          <button type="button" class="sl-btn" data-act="rename">Edit</button>
          <button type="button" class="sl-btn del" data-act="delete">Delete</button>
        </div>
      </div>`).join('')}
    </div>`).join('') || '<p class="muted">No strategies yet.</p>';
  $('#regKicker').textContent = `${strategies.length} strateg${strategies.length === 1 ? 'y' : 'ies'}`;
  const again = hl => renderStrategyList(who, onChange, hl);

  host.querySelectorAll('.sl-row').forEach(row => {
    const id = row.dataset.id, s = stratById(id);

    // Edit → the same full form as "Add new strategy", pre-filled
    row.querySelector('[data-act="rename"]').addEventListener('click', () => openStrategyForm?.(id));

    row.querySelector('[data-act="delete"]').addEventListener('click', () => {
      const n = count(id);
      row.classList.add('confirming');
      row.querySelector('.sl-actions').innerHTML = `<span class="sl-warn">${n ? `Also deletes ${plural(n)}` : 'No entries'}</span>
        <button type="button" class="sl-btn" data-act="keep">Keep</button>
        <button type="button" class="sl-btn del solid" data-act="confirm">Delete</button>`;
      row.querySelector('[data-act="keep"]').addEventListener('click', () => again());
      row.querySelector('[data-act="confirm"]').addEventListener('click', async e => {
        e.currentTarget.disabled = true;
        state.picked.delete(id);
        const res = await runOp('deleteStrategy', { id }, who.key);
        if (!res) { again(); return; }
        const removed = res.result; // { strategy, index, entries } — exactly what Undo needs
        onChange?.();
        again();
        toast(`${removed.strategy.name} deleted by ${who.who}`, {
          label: 'Undo',
          run: async () => {
            const back = await runOp('restoreStrategy', removed, who.key);
            if (!back) return;
            onChange?.();
            if (!$('#regList').hidden && !$('#modalBack').hidden) again(id);
            toast('Strategy restored');
          },
        });
      });
    });
  });
}

function showStrategyForm(who, onSaved, onBack, editId = null) {
  const form = $('#regForm');
  const editing = editId ? stratById(editId) : null;
  setManageView('form', !!editing);
  const picked = new Set(editing ? marketsOf(editing) : ['NSE']);
  const usedColors = new Set(strategies.map(s => s.color));
  let color = editing ? editing.color : SWATCHES.find(c => !usedColors.has(c)) || SWATCHES[0];
  const swatchList = SWATCHES.includes(color) ? SWATCHES : [color, ...SWATCHES]; // keep an existing custom colour selectable

  $('#regWho').innerHTML = `<i></i>Unlocked by ${esc(who.who)}`;
  const tr = traders();
  if (editing && !tr.includes(editing.trader)) tr.unshift(editing.trader);
  const selTrader = editing ? editing.trader : who.who;
  form.trader.innerHTML = tr.map(t => `<option value="${esc(t)}"${t === selTrader ? ' selected' : ''}>${esc(t)}</option>`).join('') + '<option value="__new">+ New trader…</option>';
  form.name.value = editing ? editing.short : '';
  form.capital.value = editing && editing.capital != null ? editing.capital : '';
  form.newTrader.value = '';
  $('#newTraderWrap').hidden = true;
  $('#regErr').textContent = '';
  form.querySelector('button[type="submit"]').textContent = editing ? 'Save changes' : 'Register strategy';

  const chips = () => marketChips($('#marketChips'), picked, () => preview());
  const swatches = () => {
    $('#swatches').innerHTML = swatchList.map(c => `<button type="button" class="sw-btn${c === color ? ' on' : ''}" style="--c:${c}" data-c="${c}" aria-label="Colour ${c}"></button>`).join('');
    $('#swatches').querySelectorAll('.sw-btn').forEach(b => b.addEventListener('click', () => { color = b.dataset.c; swatches(); preview(); }));
  };
  const traderName = () => (form.trader.value === '__new' ? form.newTrader.value.trim() : form.trader.value);
  const preview = () => {
    const t = traderName() || 'Trader', n = form.name.value.trim() || 'Strategy name';
    $('#regPreview').innerHTML = `<span class="k">Preview</span>
      <div class="strat-card mini" style="--c:${color}">
        <div class="strat-top"><div><div class="strat-trader">${esc(t)}</div><div class="strat-name">${esc(n)}</div></div><div class="rank">${editing ? 'EDIT' : 'NEW'}</div></div>
        <div class="mini-meta"><span>${pickedList(picked).join(' + ') || 'no market picked'}</span><span>${form.capital.value ? compact(+form.capital.value) + ' capital' : 'no capital yet'}</span></div>
      </div>`;
  };
  chips(); swatches(); preview();

  const onInput = () => { $('#newTraderWrap').hidden = form.trader.value !== '__new'; preview(); };
  const cancelBtn = form.querySelector('[data-cancel]');
  const cleanup = () => {
    form.removeEventListener('input', onInput); form.removeEventListener('change', onInput);
    form.removeEventListener('submit', onSubmit);
    cancelBtn.removeEventListener('click', onCancel);
  };
  const onCancel = () => { cleanup(); onBack(); };
  let saving = false;
  const onSubmit = async e => {
    e.preventDefault();
    if (saving) return;
    const err = $('#regErr');
    const trader = traderName().replace(/\s+/g, ' ').replace(/\s-\s/g, ' ');
    const name = form.name.value.trim().replace(/\s+/g, ' ').replace(/\s-\s/g, ' · ');
    if (!trader) { err.textContent = 'Add the trader’s name.'; return; }
    if (!name) { err.textContent = 'Give the strategy a name.'; return; }
    if (!picked.size) { err.textContent = 'Pick at least one market (NSE, BSE or MCX).'; return; }
    // untouched trader + name → keep the stored name exactly (the box shows "A · B" for "Trader - A - B")
    const full = editing && trader === editing.trader && name === editing.short ? editing.name : `${trader} - ${name}`;
    if (data.strategies.some(s => s.id !== editId && s.name.toLowerCase() === full.toLowerCase())) { err.textContent = editing ? 'Another strategy already has that name.' : 'That strategy is already registered.'; return; }
    if (editing) {
      const capital = form.capital.value === '' ? null : +form.capital.value;
      if (capital !== null && !(capital >= 0)) { err.textContent = 'Starting capital must be a number.'; return; }
      saving = true; err.textContent = '';
      // the id never changes, so every entry stays attached to this strategy
      const res = await runOp('updateStrategy', { id: editId, name: full, markets: pickedList(picked), color, capital }, who.key);
      saving = false;
      if (!res) { err.textContent = 'Not saved — see the message at the bottom.'; return; }
      cleanup();
      toast(`${full} updated by ${who.who}`);
      onSaved(editId);
      return;
    }
    let id = (slug(`${trader}__${name}`) || 'strategy').slice(0, 70);
    while (data.strategies.some(s => s.id === id)) id += '_2';
    const capital = +form.capital.value || null;
    saving = true; err.textContent = '';
    // the server stamps registeredBy / registeredAt itself
    const res = await runOp('addStrategy', { strategy: { id, name: full, color, markets: pickedList(picked), capital } }, who.key);
    saving = false;
    if (!res) { err.textContent = 'Not saved — see the message at the bottom.'; return; }
    cleanup();
    toast(`${full} registered by ${who.who}`);
    onSaved(id);
  };
  form.addEventListener('input', onInput); form.addEventListener('change', onInput);
  form.addEventListener('submit', onSubmit);
  cancelBtn.addEventListener('click', onCancel);
  setTimeout(() => { form.name.focus(); if (editing) form.name.select(); }, 80);
}

/* ---------------- filters UI ---------------- */
// The compact bar shows only these traders; the rest live under "More filters".
const PRIMARY_TRADERS = ['Nishant', 'Vinayak'];
function primaryTraders() {
  const all = traders();
  const p = PRIMARY_TRADERS.filter(t => all.includes(t));
  return p.length ? p : all.slice(0, 2);
}
function setTrader(v) { state.trader = v; state.picked.clear(); buildFilters(); render(); }
function buildFilters() {
  const compact = primaryTraders();
  if (state.trader !== 'all' && !compact.includes(state.trader)) compact.push(state.trader);
  buildSeg($('#traderSeg'), [['all', 'All'], ...compact.map(t => [t, t])], () => state.trader, setTrader);
  buildSeg($('#traderSegAll'), [['all', 'All'], ...traders().map(t => [t, t])], () => state.trader, setTrader);
  buildChips();
}
function updateFilterCount() {
  const n = state.picked.size + (state.trader !== 'all' && !primaryTraders().includes(state.trader) ? 1 : 0);
  const el = $('#fbCount');
  el.hidden = !n;
  el.textContent = n;
}
function setupFilterPanel() {
  const btn = $('#fbToggle'), more = $('#fbMore');
  btn.addEventListener('click', () => {
    const open = !more.classList.contains('open');
    more.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open);
    $('#filterbar').classList.toggle('expanded', open);
    requestAnimationFrame(() => $('#traderSegAll')._sync?.());
  });
  $('#fbReset').addEventListener('click', () => setTrader('all'));
}
function buildPeriodSwitches() {
  document.querySelectorAll('.seg.period').forEach(host => {
    const sec = host.dataset.section;
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'Period');
    buildSeg(host, PERIODS, () => state.period[sec], v => { state.period[sec] = v; renderSection(sec); });
  });
}

function buildSeg(host, opts, get, set) {
  host.innerHTML = `<span class="pill"></span>` + opts.map(([v, l]) => `<button type="button" data-v="${esc(v)}">${esc(l)}</button>`).join('');
  const pill = host.querySelector('.pill');
  const sync = () => {
    host.querySelectorAll('button').forEach(b => {
      const on = b.dataset.v === get();
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
      if (on) { pill.style.width = b.offsetWidth + 'px'; pill.style.transform = `translateX(${b.offsetLeft}px)`; }
    });
  };
  host.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { set(b.dataset.v); sync(); }));
  host._sync = sync;
  requestAnimationFrame(sync);
  document.fonts?.ready.then(() => host._sync());
  if (!host._bound) { addEventListener('resize', () => host._sync()); host._bound = true; }
}

function buildChips() {
  const host = $('#stratChips');
  const vis = visibleStrategies();
  host.innerHTML = vis.map(s => `<button type="button" class="chip" style="--c:${s.color}" data-id="${esc(s.id)}"><i></i>${esc(state.trader === 'all' ? s.name : s.short)}</button>`).join('');
  const sync = () => {
    const act = activeIds();
    const allOn = state.picked.size === 0;
    host.querySelectorAll('.chip').forEach(c => {
      const on = allOn || act.has(c.dataset.id);
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on);
    });
  };
  host.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    const id = c.dataset.id;
    if (state.picked.has(id)) state.picked.delete(id); else state.picked.add(id);
    if (state.picked.size === vis.length) state.picked.clear();
    sync(); updateFilterCount(); render();
  }));
  sync();
  updateFilterCount();
}

/* ---------------- drawer (preview log) ---------------- */
function setupDrawer() {
  const drawer = $('#drawer'), back = $('#drawerBackdrop'), form = $('#logForm');
  let sign = 1, exec = 'clean';
  // Capital pre-fill: the most recent of (last entry's capital, capital set in Manage strategies)
  const lastFunds = id => {
    const l = data.entries.filter(e => e.strategy === id).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    const s = stratById(id);
    if (s.capital != null && s.capital !== '' && (!l || (s.capitalAt && s.capitalAt >= l.date))) return s.capital;
    return l ? l.investedFunds : (s.capital || '');
  };
  const fillStrategies = (selectId) => {
    const keep = selectId || form.strategy.value;
    const groups = {};
    strategies.forEach(s => { (groups[s.trader] = groups[s.trader] || []).push(s); });
    form.strategy.innerHTML = Object.entries(groups).map(([t, list]) =>
      `<optgroup label="${esc(t)}">${list.map(s => `<option value="${esc(s.id)}">${esc(s.short)}</option>`).join('')}</optgroup>`).join('');
    if (keep && strategies.some(s => s.id === keep)) form.strategy.value = keep;
    form.funds.value = lastFunds(form.strategy.value);
  };
  const setExec = v => {
    exec = v;
    form.querySelectorAll('.exec').forEach(b => { const on = b.dataset.exec === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  };
  form.querySelectorAll('.exec').forEach(b => b.addEventListener('click', () => setExec(b.dataset.exec)));
  $('#openRegister').addEventListener('click', () => manageStrategies(id => fillStrategies(id)));  const open = () => {
    fillStrategies();
    form.date.value = TODAY;
    setExec('clean');
    back.hidden = false; requestAnimationFrame(() => back.classList.add('show'));
    drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
    setTimeout(() => form.pnl.focus(), 350);
  };
  const close = () => {
    back.classList.remove('show'); drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true');
    setTimeout(() => { back.hidden = true; }, 300);
  };
  $('#openLog').addEventListener('click', open);
  $('#closeLog').addEventListener('click', close);
  back.addEventListener('click', close);
  addEventListener('keydown', e => { if (e.key === 'Escape' && drawer.classList.contains('open') && $('#modalBack').hidden) close(); });
  form.strategy.addEventListener('change', () => { form.funds.value = lastFunds(form.strategy.value); });
  form.querySelectorAll('.pnl-toggle button').forEach(b => b.addEventListener('click', () => {
    sign = +b.dataset.sign;
    form.querySelectorAll('.pnl-toggle button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
  }));
  let saving = false;
  const saveBtn = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (saving) return;
    const err = $('#formErr');
    const date = form.date.value, strategy = form.strategy.value, funds = +form.funds.value, raw = form.pnl.value;
    if (!date || !strategy || !funds || raw === '') { err.textContent = 'Fill in every field.'; return; }
    if (!Number.isFinite(+raw) || funds < 0) { err.textContent = 'Check the numbers.'; return; }
    err.textContent = '';
    const pnl = sign * Math.abs(+raw);
    // execution type (clean | manual | tech) is stored for the future live-vs-backtest page; not shown on this page
    const entry = { date, strategy, investedFunds: funds, pnl, execution: exec };
    saving = true; saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    const res = await runOp('upsertEntry', { entry });
    saving = false; saveBtn.disabled = false; saveBtn.textContent = 'Save entry';
    if (!res) { err.textContent = 'Not saved — nothing was changed. See the message below.'; return; } // drawer stays open with the values
    freshKey = date + '|' + strategy;
    state.selDay = date;
    form.pnl.value = '';
    close();
    renderJournal();
    toast(`${money(pnl)} saved for ${stratById(strategy).short}${res.result.replaced ? ' (replaced that day’s entry)' : ''}`);
  });
}

/* ---------------- tooltip / toast ---------------- */
function showTip(html, e) {
  const tip = $('#tip');
  tip.innerHTML = html;
  tip.classList.add('show');
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function hideTip() { $('#tip').classList.remove('show'); }

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-act'; b.textContent = action.label;
    b.addEventListener('click', () => { t.classList.remove('show'); action.run(); }, { once: true });
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 3200);
}

/* ---------------- motion helpers ---------------- */
const countState = new WeakMap();
function countUp(el, to, dur, fmt) {
  const from = countState.get(el) ?? 0;
  countState.set(el, to);
  if (reducedMotion) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 4);
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

let revealIO;
function setupReveal() {
  revealIO = new IntersectionObserver(ents => ents.forEach(en => {
    if (!en.isIntersecting) return;
    const el = en.target;
    el.classList.add('in');
    el.querySelectorAll('.ring .fg').forEach(c => { c.style.strokeDashoffset = c.dataset.to; });
    revealIO.unobserve(el);
  }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.block-head, .cal-layout, .equity-card, .matrix-card, #journal .card').forEach(el => { el.classList.add('reveal'); revealIO.observe(el); });
}
function observeReveals(root) {
  root.querySelectorAll('.reveal').forEach((el, i) => {
    el.style.transitionDelay = Math.min(i * 40, 420) + 'ms';
    if (reducedMotion) { el.classList.add('in'); el.querySelectorAll('.ring .fg').forEach(c => { c.style.strokeDashoffset = c.dataset.to; }); return; }
    revealIO.observe(el);
  });
}

function setupMobileMenu() {
  const btn = $('#menuBtn'), menu = $('#mobileMenu');
  const set = open => {
    menu.hidden = !open;
    requestAnimationFrame(() => menu.classList.toggle('open', open));
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open);
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };
  btn.addEventListener('click', e => { e.stopPropagation(); set(menu.hidden); });
  menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => set(false)));
  document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) set(false); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) set(false); });
  matchMedia('(min-width: 981px)').addEventListener('change', m => { if (m.matches) set(false); });
}

function setupNavSpy() {
  setupMobileMenu();
  const links = [...document.querySelectorAll('.nav-links a, .mobile-menu a')];
  const io = new IntersectionObserver(ents => ents.forEach(en => {
    if (en.isIntersecting) links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + en.target.id));
  }), { rootMargin: '-45% 0px -50% 0px' });
  document.querySelectorAll('.block').forEach(s => io.observe(s));
}

// re-layout SVG charts on resize
let rz, lastW = innerWidth;
addEventListener('resize', () => {
  if (innerWidth === lastW) return;
  lastW = innerWidth;
  clearTimeout(rz);
  rz = setTimeout(() => { renderSection('performance'); renderSection('calendar'); }, 200);
});

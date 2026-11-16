/* =====================================================================
   TradeDesk server
   - Serves the classic site (public/) and the redesign (redesign/).
   - /api/* is the ONLY way the redesign reads or writes data. The JSONBin
     key and the passkeys live in environment variables, never in the
     browser.
   - Every write: read the latest bin -> apply ONE change -> size check ->
     write. If the read fails, nothing is written (prevents wiping the bin).

   Environment variables (set in Vercel -> Project -> Settings -> Environment):
     JSONBIN_BIN_ID    the bin id (same bin the classic site uses)
     JSONBIN_KEY       a JSONBin access key with Bins Read + Update permission
     JSONBIN_KEY_TYPE  "access" (default) or "master"
     PASSKEY_HASHES    "Name:sha256hex;Name2:sha256hex"  (see scripts/passkey-hash.js)
     WRITES_ENABLED    "true" to allow saving from the new site (default: off)
     SITE_MODE         "classic" (default: old site at /, new at /new)
                       or "new" (new site at /, old at /classic)
     JSONBIN_MAX_BYTES size guard, default 100000 (JSONBin Free = 100 KB)
     JSONBIN_API       override API base (used only for local testing)
   ===================================================================== */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', true); // Vercel sits in front; needed for per-visitor passkey lockout
const PORT = process.env.PORT || 3000;

const CFG = {
  api: (process.env.JSONBIN_API || 'https://api.jsonbin.io/v3').replace(/\/+$/, ''),
  bin: process.env.JSONBIN_BIN_ID || '',
  key: process.env.JSONBIN_KEY || '',
  keyHeader: (process.env.JSONBIN_KEY_TYPE || '').toLowerCase() === 'master' ? 'X-Master-Key' : 'X-Access-Key',
  writes: process.env.WRITES_ENABLED === 'true',
  siteMode: process.env.SITE_MODE === 'new' ? 'new' : 'classic',
  maxBytes: Number(process.env.JSONBIN_MAX_BYTES) || 100000,
};
const PASSKEY_SALT = 'tradedesk-v1:';
const PASSKEYS = new Map(
  (process.env.PASSKEY_HASHES || '')
    .split(';').map(s => s.trim()).filter(Boolean)
    .map(pair => { const i = pair.lastIndexOf(':'); return [pair.slice(i + 1).trim().toLowerCase(), pair.slice(0, i).trim()]; })
    .filter(([hash, name]) => /^[0-9a-f]{64}$/.test(hash) && name)
);

/* ---------------- helpers ---------------- */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const bytesOf = obj => Buffer.byteLength(JSON.stringify(obj), 'utf8');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXECUTIONS = new Set(['clean', 'manual', 'tech']);

function jsonbinMessage(text) {
  try { const j = JSON.parse(text); return j.message || j.error || text.slice(0, 160); } catch { return text.slice(0, 160); }
}

/* ---------------- JSONBin access ---------------- */
async function readBin() {
  if (!CFG.bin || !CFG.key) fail(500, 'The server is not connected to JSONBin yet (JSONBIN_BIN_ID / JSONBIN_KEY missing).');
  let res, text;
  try {
    res = await fetch(`${CFG.api}/b/${encodeURIComponent(CFG.bin)}/latest`, {
      headers: { [CFG.keyHeader]: CFG.key, 'X-Bin-Meta': 'false' },
      cache: 'no-store',
    });
    text = await res.text();
  } catch {
    fail(502, 'Could not reach JSONBin. Nothing was changed.');
  }
  if (!res.ok) fail(502, `JSONBin read failed (${res.status}: ${jsonbinMessage(text)}). Nothing was changed.`);
  let body;
  try { body = JSON.parse(text); } catch { fail(502, 'JSONBin returned unreadable data. Nothing was changed.'); }
  const rec = body && body.record && Array.isArray(body.record.entries) ? body.record : body;
  // Never treat a bad read as "empty data" — that is how a bin gets wiped.
  if (!rec || !Array.isArray(rec.strategies) || !Array.isArray(rec.entries)) {
    fail(502, 'JSONBin data has no strategies/entries. Refusing to write so nothing is lost.');
  }
  return rec;
}

async function writeBin(record) {
  const size = bytesOf(record);
  if (size > CFG.maxBytes) {
    fail(413, `Not saved: the data would be ${(size / 1024).toFixed(1)} KB, over the ${(CFG.maxBytes / 1024).toFixed(0)} KB limit of your JSONBin plan.`);
  }
  let res, text;
  try {
    res = await fetch(`${CFG.api}/b/${encodeURIComponent(CFG.bin)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', [CFG.keyHeader]: CFG.key },
      body: JSON.stringify(record),
    });
    text = await res.text();
  } catch {
    fail(502, 'Could not reach JSONBin. The change was NOT saved.');
  }
  if (!res.ok) fail(502, `JSONBin save failed (${res.status}: ${jsonbinMessage(text)}). The change was NOT saved.`);
  return record;
}

// One write at a time per server instance, so two saves here never interleave.
let writeChain = Promise.resolve();
function serial(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

/* ---------------- validation ---------------- */
function cleanEntry(e, strategyIds) {
  if (!e || typeof e !== 'object') fail(400, 'Entry is missing.');
  const date = String(e.date || '');
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) fail(400, 'Entry date must be YYYY-MM-DD.');
  const strategy = String(e.strategy || '');
  if (!strategyIds.has(strategy)) fail(400, 'That strategy does not exist (it may have been deleted). Refresh and try again.');
  const pnl = Number(e.pnl), investedFunds = Number(e.investedFunds);
  if (!Number.isFinite(pnl)) fail(400, 'P&L must be a number.');
  // >= 0 so older entries saved by the classic site always survive an import
  if (!Number.isFinite(investedFunds) || investedFunds < 0) fail(400, 'Capital deployed must be zero or more.');
  const out = { date, strategy, investedFunds, pnl };
  if (e.execution !== undefined && e.execution !== null && e.execution !== '') {
    if (!EXECUTIONS.has(e.execution)) fail(400, 'Unknown execution type.');
    out.execution = e.execution;
  }
  return out;
}
const sortEntries = entries => entries.sort((a, b) => a.date.localeCompare(b.date));
const nameTaken = (rec, name, exceptId) => rec.strategies.some(s => s.id !== exceptId && String(s.name).toLowerCase() === name.toLowerCase());
const cleanName = s => String(s || '').trim().replace(/\s+/g, ' ');

function cleanStrategy(s, rec, who) {
  if (!s || typeof s !== 'object') fail(400, 'Strategy is missing.');
  const id = String(s.id || '');
  if (!/^[a-z0-9_]{1,80}$/.test(id)) fail(400, 'Strategy id is invalid.');
  if (rec.strategies.some(x => x.id === id)) fail(409, 'A strategy with that id already exists. Refresh and try again.');
  const name = cleanName(s.name);
  if (!/^.{1,40} - .{1,60}$/.test(name)) fail(400, 'Strategy name must look like "Trader - Strategy".');
  if (nameTaken(rec, name)) fail(409, 'That strategy is already registered.');
  const color = /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#f4c56b';
  const out = { id, name, color, customColor: true };
  if (s.market) out.market = String(s.market).slice(0, 20);
  if (s.capital !== undefined && s.capital !== null && s.capital !== '') {
    const c = Number(s.capital);
    if (!Number.isFinite(c) || c < 0) fail(400, 'Starting capital must be a number.');
    out.capital = c;
  }
  out.registeredBy = who;
  out.registeredAt = new Date().toISOString();
  return out;
}

function cleanBackup(d) {
  if (!d || !Array.isArray(d.strategies) || !Array.isArray(d.entries)) fail(400, 'Import needs "strategies" and "entries".');
  const strategies = d.strategies
    .filter(s => s && typeof s.id === 'string' && s.id && typeof s.name === 'string' && s.name.trim())
    .map(s => ({ ...s, name: cleanName(s.name) }));
  if (!strategies.length) fail(400, 'Import has no valid strategies.');
  const ids = new Set(strategies.map(s => s.id));
  const seen = new Map();
  for (const e of d.entries) {
    try { const c = cleanEntry({ ...e, execution: EXECUTIONS.has(e && e.execution) ? e.execution : undefined }, ids); seen.set(c.date + '|' + c.strategy, c); }
    catch { /* skip invalid rows, same as the preview showed */ }
  }
  return { strategies, entries: sortEntries([...seen.values()]) };
}

/* ---------------- operations (each applied to a FRESH copy of the bin) ---------------- */
const OPS = {
  upsertEntry: { passkey: false, apply(rec, p) {
    const entry = cleanEntry(p.entry, new Set(rec.strategies.map(s => s.id)));
    const i = rec.entries.findIndex(e => e.date === entry.date && e.strategy === entry.strategy);
    const replaced = i >= 0 ? rec.entries[i] : null;
    if (i >= 0) rec.entries[i] = entry; else rec.entries.push(entry);
    sortEntries(rec.entries);
    return { entry, replaced };
  } },
  deleteEntry: { passkey: true, apply(rec, p) {
    const i = rec.entries.findIndex(e => e.date === p.date && e.strategy === p.strategy);
    if (i < 0) fail(404, 'That entry no longer exists (someone may have deleted it). Refresh to see the latest.');
    const [removed] = rec.entries.splice(i, 1);
    return { removed };
  } },
  restoreEntries: { passkey: true, apply(rec, p) {
    const ids = new Set(rec.strategies.map(s => s.id));
    const list = (Array.isArray(p.entries) ? p.entries : []).map(e => cleanEntry(e, ids));
    for (const e of list) {
      if (!rec.entries.some(x => x.date === e.date && x.strategy === e.strategy)) rec.entries.push(e);
    }
    sortEntries(rec.entries);
    return { restored: list.length };
  } },
  addStrategy: { passkey: true, apply(rec, p, who) {
    const s = cleanStrategy(p.strategy, rec, who);
    rec.strategies.push(s);
    return { strategy: s };
  } },
  renameStrategy: { passkey: true, apply(rec, p) {
    const s = rec.strategies.find(x => x.id === p.id);
    if (!s) fail(404, 'That strategy no longer exists. Refresh to see the latest.');
    const name = cleanName(p.name);
    if (!/^.{1,40} - .{1,60}$/.test(name)) fail(400, 'Strategy name must look like "Trader - Strategy".');
    if (nameTaken(rec, name, s.id)) fail(409, 'That name is already used.');
    const old = s.name;
    s.name = name; // id unchanged -> every entry keeps pointing at it
    return { old, name };
  } },
  deleteStrategy: { passkey: true, apply(rec, p) {
    const index = rec.strategies.findIndex(x => x.id === p.id);
    if (index < 0) fail(404, 'That strategy no longer exists. Refresh to see the latest.');
    const [strategy] = rec.strategies.splice(index, 1);
    const entries = rec.entries.filter(e => e.strategy === strategy.id);
    rec.entries = rec.entries.filter(e => e.strategy !== strategy.id);
    return { strategy, index, entries };
  } },
  restoreStrategy: { passkey: true, apply(rec, p) {
    const s = p.strategy;
    if (!s || typeof s.id !== 'string' || typeof s.name !== 'string') fail(400, 'Nothing to restore.');
    if (!rec.strategies.some(x => x.id === s.id)) {
      if (nameTaken(rec, s.name)) fail(409, 'A strategy with that name exists again, so it can’t be restored.');
      const at = Math.max(0, Math.min(Number(p.index) || 0, rec.strategies.length));
      rec.strategies.splice(at, 0, s);
    }
    const ids = new Set(rec.strategies.map(x => x.id));
    for (const e of Array.isArray(p.entries) ? p.entries : []) {
      const c = cleanEntry(e, ids);
      if (!rec.entries.some(x => x.date === c.date && x.strategy === c.strategy)) rec.entries.push(c);
    }
    sortEntries(rec.entries);
    return { restored: true };
  } },
  replaceAll: { passkey: true, replaces: true, apply(rec, p) {
    const next = cleanBackup(p.data);
    rec.strategies = next.strategies;
    rec.entries = next.entries;
    return { strategies: next.strategies.length, entries: next.entries.length };
  } },
};

/* ---------------- passkeys (checked here, never in the browser) ---------------- */
const attempts = new Map(); // ip -> { fails, until }
function checkPasskey(raw, ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { fails: 0, until: 0 };
  if (now < a.until) fail(429, `Too many wrong passkeys. Try again in ${Math.ceil((a.until - now) / 1000)}s.`);
  if (!PASSKEYS.size) fail(503, 'Passkeys are not set up on the server (PASSKEY_HASHES).');
  const key = String(raw || '').trim();
  const hash = crypto.createHash('sha256').update(PASSKEY_SALT + key).digest('hex');
  let who = null;
  for (const [h, name] of PASSKEYS) {
    if (crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'))) who = name;
  }
  if (!who) {
    a.fails += 1;
    if (a.fails >= 5) { a.fails = 0; a.until = now + 30000; }
    attempts.set(ip, a);
    fail(401, 'Passkey not recognised.');
  }
  attempts.delete(ip);
  return who;
}

/* ---------------- API ---------------- */
const api = express.Router();
api.use(express.json({ limit: '1mb' }));
api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const meta = rec => ({ sizeBytes: bytesOf(rec), maxBytes: CFG.maxBytes, writable: CFG.writes, readAt: new Date().toISOString() });
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ ok: false, error: err instanceof HttpError ? err.message : 'Unexpected server error. Nothing was changed.' });
});

api.get('/health', (req, res) => res.json({ ok: true, connected: !!(CFG.bin && CFG.key), writable: CFG.writes, passkeys: PASSKEYS.size, siteMode: CFG.siteMode }));

api.get('/data', wrap(async (req, res) => {
  const rec = await readBin();
  res.json({ ok: true, data: rec, meta: meta(rec) });
}));

api.post('/passkey', wrap(async (req, res) => {
  const who = checkPasskey(req.body && req.body.passkey, req.ip);
  res.json({ ok: true, who });
}));

api.post('/ops', wrap(async (req, res) => {
  const { op, payload, passkey } = req.body || {};
  const def = OPS[op];
  if (!def) fail(400, 'Unknown operation.');
  if (!CFG.writes) fail(403, 'Saving is switched off on this site for now (view-only). Nothing was changed.');
  const who = def.passkey ? checkPasskey(passkey, req.ip) : null;
  const out = await serial(async () => {
    const rec = await readBin();                  // 1) always start from the latest copy
    const result = def.apply(rec, payload || {}, who); // 2) apply exactly one change
    await writeBin(rec);                          // 3) size check + write (throws if not saved)
    return { rec, result };
  });
  res.json({ ok: true, who, result: out.result, data: out.rec, meta: meta(out.rec) });
}));

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

/* ---------------- sites ---------------- */
const OLD_DIR = path.join(__dirname, 'public');
const NEW_DIR = path.join(__dirname, 'redesign');
const NEW_BASE = CFG.siteMode === 'new' ? '/' : '/new/';
const OLD_BASE = CFG.siteMode === 'new' ? '/classic/' : '/';

// redesign/data holds local test copies only — never serve it.
app.use(NEW_BASE + 'data', (req, res) => res.sendStatus(404));
app.use('/_td/data', (req, res) => res.sendStatus(404));

// The new site's CSS/JS live at /_td/ in every layout. On Vercel this path is
// served by the static layer (see vercel.json) so the files are never rewritten
// by the Node bundler; locally (and as a fallback) Express serves them here.
app.use('/_td', express.static(NEW_DIR, { index: false }));

if (CFG.siteMode === 'new') {
  // Classic site under /classic: its HTML uses absolute /css and /js paths, so rewrite them.
  const classicHtml = () => fs.readFileSync(path.join(OLD_DIR, 'index.html'), 'utf8')
    .replace(/(href|src)="\/(css|js)\//g, '$1="/classic/$2/');
  app.get(['/classic', '/classic/', '/classic/index.html'], (req, res) => res.type('html').send(classicHtml()));
  app.use('/classic', express.static(OLD_DIR, { index: false }));
  app.use('/', express.static(NEW_DIR));
  app.get('*', (req, res) => res.sendFile(path.join(NEW_DIR, 'index.html')));
} else {
  app.use('/new', express.static(NEW_DIR)); // also redirects /new -> /new/ by itself
  app.use('/', express.static(OLD_DIR));
  app.get('*', (req, res) => res.sendFile(path.join(OLD_DIR, 'index.html')));
}

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`TradeDesk running on http://localhost:${PORT}`);
    console.log(`  classic site: http://localhost:${PORT}${OLD_BASE}`);
    console.log(`  new site:     http://localhost:${PORT}${NEW_BASE}`);
    console.log(`  JSONBin: ${CFG.bin && CFG.key ? 'configured' : 'NOT configured'} · saving from new site: ${CFG.writes ? 'ON' : 'OFF'} · passkeys: ${PASSKEYS.size}`);
  });
}

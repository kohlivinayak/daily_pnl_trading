/* ==========================================================
   AlgoTest trade log -> daily P&L per portfolio (pure, no DOM)
   ----------------------------------------------------------
   The log has one row per order leg ("Historical Trades" export).
   For every strategy run + option symbol we walk the fills in time
   order. Each time the position goes flat, the cash of that round
   trip is booked on the date of the fill that closed it (= exit date).

   - Rejected / never-filled orders (price NaN, qty 0, no exchange
     time) are ignored.
   - A leg that was entered but never exited by AlgoTest (manual exit
     in the broker, or left to expire) can't be priced from the log:
     it's reported as an "open leg" so the user types that day's P&L.
   - P&L is gross: trade prices only, no brokerage/charges.
   - The portfolio is the part of the AlgoTest strategy name before ":"
     ("Narad: Nifty Hedge 13_10" -> "Narad").
   Nothing is stored: this only turns the file into rows for review.
   ========================================================== */

function splitCsvLine(line) {
  const out = []; let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[ T]\d{1,2}:\d{2}/;
const dayOf = s => { const m = DATE_TIME.exec(String(s || '').trim()); return m ? m[1] : null; };
const round2 = n => Math.round(n * 100) / 100;

export const portfolioOf = name => {
  const s = String(name || '').trim();
  const i = s.indexOf(':');
  return (i > 0 ? s.slice(0, i) : s).trim() || 'Unknown';
};

export function parseAlgoTestLog(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { error: 'This file is empty.' };
  const head = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const col = name => head.indexOf(name);
  const C = {
    id: col('strategy id'), name: col('strategy name'), deployed: col('date'), symbol: col('symbol'),
    account: col('broker name'), broker: col('broker'), side: col('buy/sell'), price: col('trade price'),
    time: col('exchange time'), qty: col('qty'), expiry: col('expiry'),
  };
  if ([C.name, C.symbol, C.side, C.price, C.time, C.qty].some(i => i < 0)) {
    return { error: 'This doesn’t look like an AlgoTest trade log (it needs Strategy name, Symbol, Buy/Sell, Trade Price, Exchange Time and Qty columns).' };
  }

  const legs = new Map();   // run|symbol -> fills
  let rejected = 0, fileEnd = '', fileStart = '';
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line);
    const name = c[C.name] || '';
    if (!name) continue;
    const qty = Number(c[C.qty]), price = Number(c[C.price]), time = c[C.time] || '';
    const side = String(c[C.side] || '').toLowerCase();
    const day = dayOf(time);
    if (!(qty > 0) || !Number.isFinite(price) || price < 0 || !day || (side !== 'buy' && side !== 'sell')) { rejected++; continue; }
    if (!fileEnd || day > fileEnd) fileEnd = day;
    if (!fileStart || day < fileStart) fileStart = day;
    const account = (C.account >= 0 && c[C.account]) || (C.broker >= 0 && c[C.broker]) || 'AlgoTest';
    const run = [account, C.id >= 0 ? c[C.id] : name, C.deployed >= 0 ? c[C.deployed] : ''].join('|');
    const key = run + '|' + c[C.symbol];
    if (!legs.has(key)) legs.set(key, []);
    legs.get(key).push({
      account, run, name, portfolio: portfolioOf(name), symbol: c[C.symbol],
      sign: side === 'buy' ? 1 : -1, qty, price, time, day,
      expiry: C.expiry >= 0 ? dayOf(c[C.expiry]) : null,
    });
  }
  if (!legs.size) return { error: 'No filled trades found in this file.' };

  const days = new Map();      // account|portfolio|date -> row
  const runLastExit = new Map(); // run -> latest booked date
  const open = [];
  const rowFor = (account, portfolio, date) => {
    const k = account + '|' + portfolio + '|' + date;
    if (!days.has(k)) days.set(k, { account, portfolio, date, pnl: 0, trades: 0, openLegs: [], strategies: new Set() });
    return days.get(k);
  };

  for (const fills of legs.values()) {
    fills.sort((a, b) => a.time.localeCompare(b.time));
    let net = 0, cash = 0, orders = 0;
    for (const f of fills) {
      net += f.sign * f.qty;
      cash -= f.sign * f.qty * f.price;
      orders++;
      if (net === 0) {
        const r = rowFor(f.account, f.portfolio, f.day);
        r.pnl += cash; r.trades++; r.strategies.add(f.name);
        if ((runLastExit.get(f.run) || '') < f.day) runLastExit.set(f.run, f.day);
        cash = 0; orders = 0;
      }
    }
    if (net !== 0) {
      const f = fills[fills.length - 1];
      open.push({ ...f, net, since: fills[0].time });
    }
  }

  const stillOpen = [];
  for (const o of open) {
    // Book the unknown leg on the day the rest of its run closed; else its expiry day.
    const date = runLastExit.get(o.run) || o.expiry || o.day;
    const leg = { strategy: o.name, symbol: o.symbol, qty: o.net, since: o.since, expiry: o.expiry };
    if (!runLastExit.get(o.run) && o.expiry && o.expiry > fileEnd) { stillOpen.push(leg); continue; } // may still be running
    const r = rowFor(o.account, o.portfolio, date);
    r.openLegs.push(leg); r.strategies.add(o.name);
  }

  const rows = [...days.values()]
    .map(r => ({ ...r, pnl: round2(r.pnl), strategies: [...r.strategies].sort() }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.portfolio.localeCompare(b.portfolio));
  return {
    rows,
    accounts: [...new Set(rows.map(r => r.account))],
    portfolios: [...new Set(rows.map(r => r.portfolio))].sort(),
    from: fileStart, to: fileEnd, rejected, stillOpen,
  };
}

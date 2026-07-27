// Hourly market-trend snapshot for purrwall.xyz (public aggregate data only).
//
// Enumerates every live Hyperliquid market (perps incl. HIP-3 builder dexs,
// spot pairs; outcome tokens excluded), fetches 24 x 1h candles per market,
// and POSTs one compact blob to the site's ingest endpoint. The site serves
// it edge-cached so every visitor's list view renders trend glyphs instantly
// with ZERO client-side candle fetches.
//
// Budget discipline: Hyperliquid's public info API allows 1200 weight/min/IP;
// candleSnapshot costs ~21 (20 base + 1/60 bars). This runner's own IP is the
// only consumer here, but we still pace to ~46 req/min (~970 weight/min) so a
// retry burst never 429s. Full sweep of ~650 markets ~= 14 minutes.
//
// It also BANKS an hourly context snapshot (open interest, 24h volume,
// funding) into this repo's git history — see recordHistory() near the bottom
// for why that rides along here and why it lands in git rather than KV.
//
// No dependencies. Node >= 20.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';

const API = 'https://api.hyperliquid.xyz/info';
const INGEST = process.env.SPARKS_INGEST_URL ?? 'https://purrwall.xyz/api/sparks-ingest';
const TOKEN = process.env.SPARKS_TOKEN;
const PACE_MS = 1300; // ~46 req/min => ~970 weight/min, safely under 1200
const HOUR = 3600_000;

/** `node fetch-sparks.mjs --history-only` banks the context sample and stops:
 *  ~11 requests instead of a 14-minute sweep, so the history path can be
 *  exercised and a missed hour hand-filled without touching the ingest. */
const HISTORY_ONLY = process.argv.includes('--history-only');

if (!TOKEN && !HISTORY_ONLY) {
  console.error('SPARKS_TOKEN missing');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function info(body, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} (permanent)`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(5000 * (i + 1) ** 2); // 5s, 20s
    }
  }
}

/**
 * Every candle-fetchable market id, plus the context snapshot that arrives in
 * the SAME responses. Mirrors the app's enumeration minimally: outcome tokens
 * ('#...') are excluded (no sparkline column on that tab).
 *
 * Enumeration deliberately uses the *AndAssetCtxs variants: metaAndAssetCtxs
 * returns the identical universe as meta for the identical weight (20) but
 * ALSO carries openInterest / dayNtlVlm / funding / markPx per asset. Reading
 * the plain meta here would throw that away and make the history bank below
 * cost a second full pass over every dex.
 */
async function listMarkets() {
  const coins = [];
  /** coin -> [openInterestUsd, dayVolumeUsd, hourlyFunding] (nulls where n/a) */
  const ctx = {};
  const num = (s) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  // 4 significant figures. Everything these samples will ever answer is a
  // RATIO ("OI +12% vs 24h ago", "volume 3.4x its normal"), so dollar-exact
  // storage buys ~0.05% of precision nobody can use. Raw byte count barely
  // moves (2364000000 is as long as 2381137197); the win is that trailing
  // zeros and hour-to-hour stability compress and delta far better in git,
  // which is what actually decides this repo's growth.
  const sig = (n) => {
    if (n === null || n === 0) return n;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(n))) - 3);
    return Math.round(n / mag) * mag;
  };
  const notePerp = (name, c) => {
    if (!c) return;
    const mark = num(c.markPx);
    const oi = num(c.openInterest);
    ctx[name] = [
      oi !== null && mark !== null ? sig(Math.round(oi * mark)) : null,
      sig(Math.round(num(c.dayNtlVlm) ?? 0)),
      num(c.funding),
    ];
  };

  const [meta, metaCtxs] = await info({ type: 'metaAndAssetCtxs' });
  (meta.universe ?? []).forEach((u, i) => {
    if (u.isDelisted) return;
    coins.push(u.name);
    notePerp(u.name, metaCtxs?.[i]);
  });
  const dexs = await info({ type: 'perpDexs' });
  for (const dex of dexs ?? []) {
    const name = dex?.name;
    if (!name) continue; // first entry = the default dex, already covered
    try {
      const [dmeta, dctxs] = await info({ type: 'metaAndAssetCtxs', dex: name });
      (dmeta.universe ?? []).forEach((u, i) => {
        if (u.isDelisted) return;
        const coin = u.name.includes(':') ? u.name : `${name}:${u.name}`;
        coins.push(coin);
        notePerp(coin, dctxs?.[i]);
      });
    } catch (err) {
      console.warn(`dex ${name} meta failed, skipping:`, err.message);
    }
    await sleep(400);
  }
  const [spot, spotCtxs] = await info({ type: 'spotMetaAndAssetCtxs' });
  // Spot ctxs are keyed by their own coin id, not by universe index.
  const spotByCoin = new Map((spotCtxs ?? []).map((c) => [c.coin, c]));
  for (const u of spot.universe ?? []) {
    // '#...' = HIP-4 outcome tokens — excluded by design
    if (typeof u.name !== 'string' || u.name.startsWith('#')) continue;
    coins.push(u.name);
    const c = spotByCoin.get(u.name);
    // Spot has no open interest and no funding — absent, never zero.
    if (c) ctx[u.name] = [null, sig(Math.round(num(c.dayNtlVlm) ?? 0)), null];
  }
  return { coins: [...new Set(coins)], ctx };
}

/**
 * Bank the hourly context snapshot into THIS REPO's git history.
 *
 * Hyperliquid publishes no history for open interest, and the ctx endpoints
 * only ever answer "right now" — so an OI-change readout, a volume baseline,
 * or a market's listing date can only ever exist if the samples were being
 * collected beforehand. Recording starts the clock; the UI can follow whenever.
 *
 * Git rather than KV, deliberately: it needs no worker route, no KV schema
 * committed before the feature's shape is known, and no ingest contract to get
 * right up front. An append-only commit log IS the time series, it is auditable,
 * and the serving blob can be derived from it later. Same shape as the main
 * repo's spot-overrides sync, which also just commits a file on change.
 *
 * Runs BEFORE the ~14-minute candle sweep on purpose: the sample is in hand
 * a minute in, and a sweep that dies at minute ten must not cost us the hour.
 */
function recordHistory(ctx, coins) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  mkdirSync('history/ctx', { recursive: true });
  appendFileSync(
    `history/ctx/${day}.ndjson`,
    JSON.stringify({ t: now.getTime(), m: ctx }) + '\n',
  );

  // First-seen dates: the raw material for a "new listing" badge, and a
  // by-product nothing else records. Append-only — a market that delists and
  // relists keeps its original date, which is the honest answer.
  //
  // CRITICAL for any consumer: the FIRST run stamps every market that already
  // existed with that day, because this file cannot know when they actually
  // listed. Those are a BASELINE, not listing dates. `baseline` records the
  // seeding day so a "new" badge can exclude every entry equal to it — without
  // that, the feature's very first render would flag the entire exchange as new.
  const path = 'history/first-seen.json';
  let doc = { baseline: day, seen: {} };
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed.seen === 'object') doc = parsed;
    } catch (err) {
      console.warn('first-seen.json unreadable, starting fresh:', err.message);
    }
  }
  let added = 0;
  for (const coin of coins) {
    if (!doc.seen[coin]) {
      doc.seen[coin] = day;
      added++;
    }
  }
  if (added > 0) {
    doc.seen = Object.fromEntries(Object.entries(doc.seen).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(path, JSON.stringify(doc) + '\n');
  }
  const label = doc.baseline === day && added > 100 ? 'baseline seeded' : 'new markets';
  console.log(`history: ${Object.keys(ctx).length} ctx rows, ${added} ${label}`);
}

async function sparkline(coin) {
  const end = Date.now();
  // 26h window: tolerates the current partial bar + one boundary bar
  const bars = await info({
    type: 'candleSnapshot',
    req: { coin, interval: '1h', startTime: end - 26 * HOUR, endTime: end },
  });
  if (!Array.isArray(bars) || bars.length < 2) return null;
  // closes only, oldest -> newest, capped at the most recent 24
  const closes = bars.slice(-24).map((b) => Number(b.c));
  return closes.every((c) => Number.isFinite(c)) ? closes : null;
}

const { coins: markets, ctx } = await listMarkets();
console.log(`markets: ${markets.length}`);
recordHistory(ctx, markets);
if (HISTORY_ONLY) process.exit(0);

const points = {};
let ok = 0;
let empty = 0;
let failed = 0;
for (const [i, coin] of markets.entries()) {
  try {
    const closes = await sparkline(coin);
    if (closes) {
      points[coin] = closes;
      ok++;
    } else {
      empty++; // brand-new/thin market — no glyph is the honest render
    }
  } catch (err) {
    failed++;
    console.warn(`${coin}: ${err.message}`);
  }
  if (i % 50 === 49) console.log(`progress ${i + 1}/${markets.length} (ok ${ok})`);
  await sleep(PACE_MS);
}
console.log(`done: ok ${ok}, empty ${empty}, failed ${failed}`);

// A partial blob would silently blank most of the list's glyphs — better to
// keep serving the previous hour's blob than to overwrite it with a stub.
if (ok < markets.length * 0.5) {
  console.error('under 50% coverage — NOT publishing');
  process.exit(1);
}

const blob = { v: 1, t: Date.now(), iv: '1h', points };
const res = await fetch(INGEST, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${TOKEN}`,
  },
  body: JSON.stringify(blob),
});
if (!res.ok) {
  console.error(`ingest failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`published ${ok} sparklines (${JSON.stringify(blob).length} bytes)`);

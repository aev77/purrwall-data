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
// No dependencies. Node >= 20.

const API = 'https://api.hyperliquid.xyz/info';
const INGEST = process.env.SPARKS_INGEST_URL ?? 'https://purrwall.xyz/api/sparks-ingest';
const TOKEN = process.env.SPARKS_TOKEN;
const PACE_MS = 1300; // ~46 req/min => ~970 weight/min, safely under 1200
const HOUR = 3600_000;

if (!TOKEN) {
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

/** Every candle-fetchable market id. Mirrors the app's enumeration minimally:
 *  outcome tokens ('#...') are excluded (no sparkline column on that tab). */
async function listMarkets() {
  const coins = [];
  const meta = await info({ type: 'meta' });
  for (const u of meta.universe ?? []) {
    if (!u.isDelisted) coins.push(u.name);
  }
  const dexs = await info({ type: 'perpDexs' });
  for (const dex of dexs ?? []) {
    const name = dex?.name;
    if (!name) continue; // first entry = the default dex, already covered
    try {
      const dmeta = await info({ type: 'meta', dex: name });
      for (const u of dmeta.universe ?? []) {
        if (u.isDelisted) continue;
        coins.push(u.name.includes(':') ? u.name : `${name}:${u.name}`);
      }
    } catch (err) {
      console.warn(`dex ${name} meta failed, skipping:`, err.message);
    }
    await sleep(400);
  }
  const spot = await info({ type: 'spotMeta' });
  for (const u of spot.universe ?? []) {
    // '#...' = HIP-4 outcome tokens — excluded by design
    if (typeof u.name === 'string' && !u.name.startsWith('#')) coins.push(u.name);
  }
  return [...new Set(coins)];
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

const markets = await listMarkets();
console.log(`markets: ${markets.length}`);

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

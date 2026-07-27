# purrwall-data

Hourly pipeline that snapshots a 24-point (1h) price trend for every live
[Hyperliquid](https://app.hyperliquid.xyz) market and publishes one compact
blob to [purrwall.xyz](https://purrwall.xyz), where the list view renders
per-row trend glyphs instantly — no client-side candle fetching.

- **Public aggregate market data only.** No user data of any kind flows
  through this repo or pipeline.
- `fetch-sparks.mjs` — enumerate markets → 24×1h closes each (paced well
  under Hyperliquid's public rate limits) → POST to the site's ingest
  endpoint (token-gated).
- `.github/workflows/sparks.yml` — hourly cron + manual dispatch.

## `history/` — the sample bank

Hyperliquid publishes no history for open interest and no listing dates: its
context endpoints only ever answer "right now". So anything phrased as a
CHANGE — "open interest +12% vs 24h ago", "volume 3.4× this market's normal",
"listed 3 days ago" — can only exist if the samples were already being
collected. The same sweep that enumerates markets for the sparklines already
receives those numbers (`metaAndAssetCtxs` costs exactly what `meta` costs and
carries the context too), so banking them is free. Recording starts the clock;
any UI can follow whenever.

It lands in **git rather than a database on purpose**: no worker route, no
storage schema committed before the feature's shape is known, and an
append-only commit log already *is* a time series — auditable, diffable, and
derivable into whatever serving format eventually wants it.

- `history/ctx/YYYY-MM-DD.ndjson` — one line per hourly sweep:
  `{"t": <epoch ms>, "m": {"<coin>": [openInterestUsd, volume24hUsd, hourlyFunding]}}`.
  Values are 4 significant figures (every question they answer is a ratio).
  Spot markets carry `null` for open interest and funding — absent, not zero.
- `history/first-seen.json` — `{"baseline": "YYYY-MM-DD", "seen": {"<coin>": "YYYY-MM-DD"}}`.
  **Read `baseline` before using this.** The first run stamps every market that
  already existed with that day, because the file cannot know when they truly
  listed. Any "new market" feature must exclude entries whose date equals
  `baseline`, or its first render flags the entire exchange as new.

`node fetch-sparks.mjs --history-only` banks a sample and stops (~11 requests,
no token needed) — for exercising this path or hand-filling a missed hour.

The main site repo is private; this repo is public so the pipeline rides
free Actions minutes (same pattern as `purrwall-releases`).

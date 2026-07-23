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

The main site repo is private; this repo is public so the pipeline rides
free Actions minutes (same pattern as `purrwall-releases`).

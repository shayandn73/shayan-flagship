# NINA operations — 2026-09-27

Public APIs are read-only. Execution is manual. Learner promotion is disabled.

## Canonical source

This repository contains the active gateway, learner, technical scanner, PRE-IMPULSE scanner, fundamental service, and Mission Control. Existing Render services run the corresponding nina-*.mjs entrypoints. No credentials or private bootstrap history belong in this repository.

Run `npm install` then `npm test`. Gateway and dashboard need no runtime packages; scanners use ws and learner uses pg.

## Verification completed

- Gateway v1.2.2 rejects PRE alerts older than 90 seconds and future timestamps, preserves UNKNOWN evidence, and fails closed on Ourbit eligibility. Reddit failures affect research confidence without forcing market data to NO TRADE.
- Learner PostgreSQL schema v1 persists signals, shadow trades, outcomes, challenger weights and model state.
- Restart comparison preserved all 8 captured signal IDs and every captured closed outcome unchanged; challenger weights matched. A new boot ID restored the saved model state. Later cold startup restored 15 records, including 9 outcomes.
- Technical detail subscriptions are bootstrapped from the market universe; rank history advances on a timed cycle, not HTTP reads.
- Mission Control clears candidates on failure and expires rows using observation timestamps.
- Source response timestamps do not establish price freshness.

## Limitations and next work

- Free Render services sleep. They cannot provide continuous monitoring or uninterrupted outcome paths. Outcomes spanning missing observation periods are excluded from validated metrics and weight updates.
- Ourbit API fetch fails from this deployment: UNVERIFIED, never executable. Direct contract/ticker proof requires an active contract and a timestamped fresh quote; no direct Ourbit price is claimed without that proof.
- Binance REST open-interest endpoint returned HTTP 418 from Render on 2026-09-27. OI is UNKNOWN and confidence is reduced; `/ready` and `/api/sources` on Technical expose source status and errors.
- Learner observes only seven configured symbols; its challenger weights are experimental, not calibrated production weights.
- PRE minimum observation warm-up is five minutes. Its lead-time performance is unvalidated.
- Public-page sentiment has unverified publication timestamps; heuristic scores cannot create signals.
- PostgreSQL `dpg-dardva3tqb8s73f4625g-a` is on a free expiring plan; Render reports expiry 2026-10-25 20:55 UTC. Free databases have no PITR. Upgrade and restore-test before expiry.
- Canonical realtime services remain Render `free`, with no configured `healthCheckPath` and `autoDeploy: no`. `/ready` is implemented but Render health probes and always-on plans remain unconfigured. No 24-hour continuity claim is valid yet.
- The Netlify production deployment uses an upload and has `commit_ref:null`; its deployed files match current source but Git provenance is unresolved.
- Old superseded Render services were not deleted. They are not the canonical gateway dependencies.
- OHLCV storage, immutable multi-horizon forecast ledger, calibrated ranges, walk-forward model tournament, MCP server and complete frontend failure-injection suite remain future work.

## Services

- Canonical Gateway: https://nina-gateway-v11.onrender.com
- Mission Control: https://nina-dashboard-v1.onrender.com
- Learner: https://nina-learning-lab-v07.onrender.com
- Technical: https://nina-market-intelligence-v05f.onrender.com
- PRE: https://nina-preimpulse-alerts-v081.onrender.com
- Fundamental: https://nina-fundamental-intel-v06.onrender.com
- Flagship: https://shayan-flagship.netlify.app

Production status must be checked at endpoints and matched to the Render deploy commit before declaring an update live. Deployment IDs and commit IDs are available in Render. Never publish private bootstrap environment values.

## Controlled deploy and health

Run `npm test` and `node --check` on all changed entrypoints. Deploy the six canonical services to the same intended SHA and compare `/ready` (Gateway, Technical, PRE, Fundamental, Learner) and `/health` (Mission Control) with Render deploy IDs. `/ready` returns 503 on semantic failures; the research service uses a six-minute cycle freshness allowance because its schedule is three minutes. Keep `SHADOW_ONLY` and manual execution.

Upgrade Technical, PRE, Fundamental, Learner, and Gateway to an always-on paid Render instance before calling this 24/7 monitoring. The minimum published Render Starter web instance is $7/service/month (five services, at least $35/month); capacity and account pricing must be verified at purchase. The dashboard can be served as a Netlify static page. Upgrade the free PostgreSQL instance separately; the minimum published Basic tier starts at $6/month before storage. Paid account/workspace membership alone does not change free instance sleep behavior. After the runtime upgrade configure each canonical Render web service health path to `/ready`, enable checks-pass deployment, and observe 24 hours with independent external monitoring. Do not use keep-alive pings as a substitute.

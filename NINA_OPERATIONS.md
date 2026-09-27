# NINA deployment checkpoint — 2026-09-27

Public APIs are read-only. Execution is manual. Learner promotion is disabled.

## Canonical source

This repository contains the active gateway, learner, technical scanner, PRE-IMPULSE scanner, fundamental service, and Mission Control. Existing Render services run the corresponding nina-*.mjs entrypoints. No credentials or private bootstrap history belong in this repository.

Run `npm install` then `npm test`. Gateway and dashboard need no runtime packages; scanners use ws and learner uses pg.

## Verification completed

- Gateway v1.2.1 rejects PRE alerts older than 90 seconds and future timestamps, preserves UNKNOWN evidence, and fails closed on Ourbit eligibility.
- Learner PostgreSQL schema v1 persists signals, shadow trades, outcomes, challenger weights and model state.
- Restart comparison preserved all 8 captured signal IDs and every captured closed outcome unchanged; challenger weights matched. A new boot ID restored the saved model state. Later cold startup restored 15 records, including 9 outcomes.
- Technical detail subscriptions are bootstrapped from the market universe; rank history advances on a timed cycle, not HTTP reads.
- Mission Control clears candidates on failure and expires rows using observation timestamps.
- Source response timestamps do not establish price freshness.

## Limitations and next work

- Free Render services sleep. They cannot provide continuous monitoring or uninterrupted outcome paths. Outcomes spanning missing observation periods are excluded from validated metrics and weight updates.
- Ourbit API fetch fails from this deployment: UNVERIFIED, never executable. No direct Ourbit pricing.
- OI can be unavailable; represented as null and confidence is reduced.
- Learner observes only seven configured symbols; its challenger weights are experimental, not calibrated production weights.
- PRE minimum observation warm-up is five minutes. Its lead-time performance is unvalidated.
- Public-page sentiment has unverified publication timestamps; heuristic scores cannot create signals.
- PostgreSQL is on a free expiring plan; prior account metadata indicated expiry around 2026-10-25/26. Arrange a durable plan before expiry.
- Old superseded Render services were not deleted. They are not the canonical gateway dependencies.
- OHLCV storage, immutable multi-horizon forecast ledger, calibrated ranges, walk-forward model tournament, MCP server and complete frontend failure-injection suite remain future work.

## Services

- Gateway: https://nina-gateway-v1.onrender.com
- Gateway alias: https://nina-gateway-v11.onrender.com
- Mission Control: https://nina-dashboard-v1.onrender.com
- Learner: https://nina-learning-lab-v07.onrender.com
- Technical: https://nina-market-intelligence-v05f.onrender.com
- PRE: https://nina-preimpulse-alerts-v081.onrender.com
- Fundamental: https://nina-fundamental-intel-v06.onrender.com
- Flagship: https://shayan-flagship.netlify.app

Production status must be checked at endpoints and matched to the Render deploy commit before declaring an update live. Deployment IDs and commit IDs are available in Render. Never publish private bootstrap environment values.

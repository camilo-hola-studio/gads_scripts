# gads_scripts

Google Ads Scripts used across Hola Studio accounts. Each script is a single
self-contained `.js` file that pastes straight into Google Ads at
**Tools > Bulk actions > Scripts** — no build step, no npm, no account-specific
config baked in.

## Scripts

### `bid-strategy-audit.js`

Audits a single account's campaign bid strategies ahead of the 17 August 2026
target-based-bidding change and writes a five-tab Google Sheet:

1. **Summary** — with-target vs no-target pie charts (campaign count, 60d cost,
   60d conversions) plus a full campaign table with trend-based priority.
2. **Actionable** — one row per campaign whose target should move, with timing
   (before/after 17 Aug), a proposed target seeded at the 30d actual, and blank
   Wk1–3/Status columns for manual tracking.
3. **Campaign Data** — every raw and computed field across the 60/30/14/7-day
   windows.
4. **Segment Summary** — cost-weighted ROAS/CPA by segment (target status,
   budget status, gap band, bid strategy — no name-based inference), with cost
   and 30d-vs-7d charts.
5. **Method & Definitions** — how everything is computed and what the data
   cannot tell you.

Key implementation note: windowed ROAS/CPA are **computed, not read** — the
report API only aggregates one date range per query, so the script runs the
metrics query once per window (30/14/7 days, each ending yesterday in the
account's timezone) and joins onto a 60-day base by campaign ID in memory.

Setup: paste the file into a new script, authorise, optionally set
`SPREADSHEET_URL` in the config block (blank = a new sheet is created and its
URL logged), run. Deployable unchanged across ROAS-target and CPA-target
accounts.

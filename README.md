# gads_scripts

Google Ads Scripts used across Hola Studio accounts. Each script is a single
self-contained `.js` file that pastes straight into Google Ads at
**Tools > Bulk actions > Scripts** — no build step, no npm, no account-specific
config baked in.

## Scripts

### `bid-strategy-audit.js`

Audits a single account's campaign bid strategies ahead of the
[17 August 2026 target-based-bidding change](https://support.google.com/google-ads/answer/17061251):
from that date, budget-limited campaigns using tCPA/tROAS bid to the **stated**
target rather than the better number the algorithm was actually achieving, so
stale targets start steering real spend. The audit finds the drift between
stated targets and 30-day actuals and writes a three-tab Google Sheet:

1. **Summary** — with-target vs no-target pie charts (campaign count, 60d cost,
   60d conversions); an interactive weekly chart (last 8 weeks) of stated
   target vs actual for targeted campaigns with a live campaign-filter
   dropdown, an in-sheet linear decay trend line and an estimated decay/week
   figure (all formula-driven, so filtering needs no script re-run); a full
   campaign table with 30/14/7-day actuals and trend-based priority; and a
   compact "How to read this" reference block.
2. **Actionable** — one row per campaign whose target should move, with timing
   ("Before 17 Aug" for budget-limited campaigns — the directly-affected set),
   a proposed target seeded at the 30d actual, auto-generated commentary, and
   blank Wk1–3/Status columns for manual tracking.
3. **Campaign Data** — every raw and computed field across the 60/30/14/7-day
   windows.

Implementation notes:

- Windowed ROAS/CPA are **computed, not read** — the report API only aggregates
  one date range per query, so the script runs the metrics query once per
  window (30/14/7 days, each ending yesterday in the account's timezone) and
  joins onto a 60-day base by campaign ID in memory.
- Budget-limited detection tries the platform's own
  `campaign.primary_status_reasons` (`BUDGET_CONSTRAINED` — the UI's "Limited
  by budget") first, and falls back to a spend-vs-budget derivation (7-day
  average daily spend ≥ 85% of daily budget) if that field isn't available.
  The Summary notes state which method the run used.

Setup: paste the file into a new script, authorise, optionally set
`SPREADSHEET_URL` in the config block (blank = a new sheet is created and its
URL logged), run. Deployable unchanged across ROAS-target and CPA-target
accounts.

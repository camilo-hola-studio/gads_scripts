# gads_scripts

**Read-only.** Nothing in this repo changes a Google Ads account: the scripts
only read reporting data and write results to Google Sheets in the
authorising user's own Drive. No bids, budgets, targets, statuses or
structures are ever modified, and no data is sent anywhere outside that
user's Google account, apart from the POAS report's optional email summary,
which is off by default and only goes to addresses you configure. (Google
Ads Scripts has no read-only consent scope,
so the authorisation prompt shows broad permissions — the code is the
complete behaviour and is short enough to audit.)

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

### `poas-vs-roas-weekly.js`

Weekly campaign profitability for e-commerce accounts with
[conversions with cart data](https://support.google.com/google-ads/answer/9028254):
POAS (gross profit / cost) next to ROAS (conv. value / cost), one row per
campaign per complete Mon–Sun week, so campaigns that look fine on ROAS but
are thin on profit stand out. Targets Google Ads API v25 via `segments.week`
on the `campaign` resource. Writes four tabs — **Campaign Summary** (latest
week vs prior week vs N-week average for ROAS, POAS and margin), **Weekly
Detail** (every campaign-week with impressions, clicks, cost, conversions,
conv. value, gross profit, COGS, cart revenue, orders, AOV, ROAS, reported
POAS, estimated POAS, margin, cart margin, profit coverage, ROAS–POAS gap)
**Account
Weekly** (account totals per week plus the run log) and **Charts** (three
embedded line charts: ROAS vs reported vs estimated POAS by week, then
conversion value and conversions as one chart each rather than one chart with
two y-axes). Rows with conversion
value but no cart data print a blank reported POAS and a separate estimated
POAS from a configurable fallback margin. Notes flag POAS below threshold,
margin moving more than 5 pts week on week, and profit coverage under 50%.
Optional email of flagged campaigns only, off by default. The GAQL is in
[`poas-vs-roas-weekly-queries.md`](poas-vs-roas-weekly-queries.md) for
testing in the query builder first.

Setup:

1. Create a blank Google Sheet and copy its URL.
2. In Google Ads open **Tools > Bulk actions > Scripts**, click **+**, name
   the script and paste in `poas-vs-roas-weekly.js`.
3. In the `CONFIG` block set `SPREADSHEET_URL` to the sheet URL.
4. Optionally adjust `WEEKS` (13), `FALLBACK_MARGIN` (0.58),
   `POAS_THRESHOLD` (3.0), `CAMPAIGN_INCLUDE` / `CAMPAIGN_EXCLUDE`
   (case-insensitive regex, empty include = all campaigns).
5. For email, set `EMAIL_ENABLED: true` and fill `EMAIL_RECIPIENTS`.
6. Click **Authorise** and accept the Google Ads and Sheets/Gmail prompts.
7. Click **Preview** to check the logs, then **Run**.
8. Schedule **Weekly, Monday, 6am** or later so the previous week has closed
   in the account's timezone.

### `mcc-bid-strategy-audit.js`

The same audit, installed **once at manager (MCC) level** and fanned out
across child accounts with `executeInParallel` — built to be shared with
other agencies as-is:

- Each child account gets its own three-tab audit spreadsheet (identical to
  the single-account script's output).
- The MCC gets an **Overview** spreadsheet: one row per account, ranked most
  urgent first ("1 – Act now" campaign count, then actionable count, then
  spend), with the account-level 30d>7d trend and a link to each audit sheet.
  A hidden Registry tab maps CID → audit sheet URL so re-runs write into the
  same sheets instead of creating new ones.
- `LOW_SPEND_FLOOR` defaults to **0** (no minimum spend); agencies raise it
  in the config block if small campaigns make the flags noisy.
- Optional targeting via `ACCOUNT_IDS` or `ACCOUNT_LABEL`. Hard cap of 50
  accounts per run (a Google Ads Scripts limit) — batch bigger MCCs with
  labels.

Setup: paste into a script **in the manager account**, authorise, run once
with `MASTER_SPREADSHEET_URL` blank, then paste the logged Overview URL into
the config and save. Schedule weekly if wanted.

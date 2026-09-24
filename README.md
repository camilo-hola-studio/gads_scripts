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

### `shopping-product-labels.js`

Item-level Shopping performance sorted into five buckets for feed
segmentation: `over-index`, `index`, `near-index`, `under-index`, `no-index`.
Reads `shopping_performance_view` segmented by `segments.product_item_id`,
aggregates per item, and compares each item's ROAS against the account's
**breakeven ROAS (1 / gross margin, not a ROAS target)**, gated on having
enough clicks for the ROAS to mean anything. Writes three tabs — **Bucket
Summary** (items, spend and value per bucket, with share-of-cost, plus the run
log), **Labels** (item ID and bucket, headed for a Merchant Center
supplemental feed) and **Item Detail** (every item, biggest spender first).

Read-only, like the rest: nothing is written to the account or to Merchant
Center. Uploading the supplemental feed is a manual step.

Differences from the widely-circulated version of this idea, all deliberate:
bands are relative to breakeven rather than a flat ±1; the impression floor is
tested first so a handful of impressions with one lucky sale cannot buy a
performance label; recent days are excluded for conversion lag; values are
parsed as numbers (a single-comma strip turns anything over 1,000,000 into
`NaN`); and zero-cost items are handled explicitly, since `value / 0` is
`Infinity`, not `NaN`. Each run also checks the bucket spread and warns if
more than 90% of spend lands in one bucket, which almost always means
`BREAKEVEN_ROAS` is wrong.

Seeding a new market: a market with no history cannot label itself. Point
`SOURCE_CAMPAIGN_INCLUDE` at the market that has data, use its labels to
structure the new market's launch, then switch the filter once the new market
has traffic of its own.

Setup:

1. Create a blank Google Sheet and copy its URL.
2. In Google Ads open **Tools > Bulk actions > Scripts**, click **+**, name
   the script and paste in `shopping-product-labels.js`.
3. In the `CONFIG` block set `SPREADSHEET_URL`.
4. Set `BREAKEVEN_ROAS` to 1 / gross margin (50% margin → 2.0) and
   `AVERAGE_CVR_PCT` to the account's actual Shopping conversion rate.
5. To label from one market only, set `SOURCE_CAMPAIGN_INCLUDE` to a
   case-insensitive regex matching those campaign names.
6. Set `LAG_DAYS` to roughly the account's conversion lag.
7. Click **Authorise**, then **Preview** to check the logs, then **Run**.
8. Read **Bucket Summary** before acting on anything: if one bucket holds
   almost all the spend, the breakeven is wrong.

### `poas-vs-roas-weekly.js`

Weekly campaign profitability for e-commerce accounts reporting
[conversions with cart data](https://support.google.com/google-ads/answer/9028254).

```
POAS = (metrics.revenue_micros - metrics.cost_of_goods_sold_micros) / cost
ROAS =  metrics.conversions_value / cost
```

Both are campaign-level figures from a single report query on the `campaign`
resource (Google Ads API v25, bucketed with `segments.week`); nothing
item-level is read. Conversion value is not used as the POAS numerator
because it includes tax and shipping, which are neither profit nor cost of
goods — that is why conversion value runs ahead of revenue on every row.
There is no assumed margin anywhere in the script: a week with no revenue
prints a blank POAS and is noted, never a zero.

Four tabs — **Campaign Summary** (latest week vs prior week vs N-week average
for ROAS, POAS and margin), **Charts** (ROAS vs POAS by week, then conversion
value and conversions as one chart each rather than one chart with two
y-axes), **Weekly Detail** (every campaign-week: cost, conv. value, revenue,
COGS, gross profit, ROAS, POAS, margin) and **Account Weekly** (account totals
per week plus the run log). Notes flag POAS below a configurable threshold and
product margin moving more than 5 points week on week. Optional email of
flagged campaigns only, off by default. Each run also cross-checks computed
profit against the gross profit Google reports and logs any disagreement. The
GAQL is in [`poas-vs-roas-weekly-queries.md`](poas-vs-roas-weekly-queries.md)
for testing in the query builder first.

Setup:

1. Create a blank Google Sheet and copy its URL.
2. In Google Ads open **Tools > Bulk actions > Scripts**, click **+**, name
   the script and paste in `poas-vs-roas-weekly.js`.
3. In the `CONFIG` block set `SPREADSHEET_URL` to the sheet URL.
4. Optionally adjust `WEEKS` (13), `POAS_THRESHOLD` (3.0),
   `MARGIN_MOVE_PTS` (5), `CAMPAIGN_INCLUDE` / `CAMPAIGN_EXCLUDE`
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

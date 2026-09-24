# GAQL for `poas-vs-roas-weekly.js`

Target: **Google Ads API v25** (the script passes `{ apiVersion: 'v25' }` to
`AdsApp.report` and falls back to the Scripts runtime default if rejected).
Paste these into the Google Ads API query builder / query validator, or run
them in a scratch script with `AdsApp.report(query).rows()`.

Dates below are the range the script would use when run in the week of
2026-08-31: last 13 complete Mon–Sun weeks, ending the most recent Sunday.
Replace them with any Monday-start / Sunday-end pair; the script computes
them from `CONFIG.WEEKS` and the account timezone.

## 1. The report query (the only query the script runs)

```sql
SELECT
  campaign.id,
  campaign.name,
  campaign.status,
  campaign.advertising_channel_type,
  segments.week,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros,
  metrics.conversions,
  metrics.conversions_value,
  metrics.gross_profit_micros,
  metrics.cost_of_goods_sold_micros,
  metrics.revenue_micros,
  metrics.orders,
  metrics.average_order_value_micros
FROM campaign
WHERE campaign.status != 'REMOVED'
  AND metrics.impressions > 0
  AND segments.date BETWEEN '2026-06-01' AND '2026-08-30'
```

Notes:

- `segments.week` is Monday–Sunday and is returned as the Monday's date
  (`yyyy-MM-dd`). Because the `segments.date` range starts on a Monday and
  ends on a Sunday, every bucket is a complete week.
- `*_micros` fields are integers in millionths of the account currency;
  the script divides by 1,000,000.
- `metrics.gross_profit_micros`, `metrics.cost_of_goods_sold_micros`,
  `metrics.revenue_micros`, `metrics.orders` and
  `metrics.average_order_value_micros` are only populated for campaigns that
  report conversions with cart data (and, for profit/COGS, whose Merchant
  Center feed carries `cost_of_goods_sold`). For other campaigns they come
  back as 0 — the script treats "conv. value > 0 with all cart metrics 0" as
  "no cart data" rather than as zero profit.

## 2. Sanity check: does this account return revenue and COGS?

Run this first. POAS is `(revenue - COGS) / cost`, so both figures have to
come back non-zero. If `revenue_micros` is 0 everywhere, purchases are not
reporting cart data and POAS will be blank on every row. Conversion value
will always exceed revenue: the difference is tax and shipping.

```sql
SELECT
  campaign.name,
  campaign.advertising_channel_type,
  metrics.cost_micros,
  metrics.conversions_value,
  metrics.revenue_micros,
  metrics.orders,
  metrics.gross_profit_micros,
  metrics.cost_of_goods_sold_micros
FROM campaign
WHERE campaign.status != 'REMOVED'
  AND metrics.cost_micros > 0
  AND segments.date DURING LAST_30_DAYS
```

## 3. Optional: same query by week for one campaign

Useful for spot-checking a single campaign's weekly buckets against the
Weekly Detail tab. Replace the ID.

```sql
SELECT
  segments.week,
  metrics.cost_micros,
  metrics.conversions_value,
  metrics.revenue_micros,
  metrics.gross_profit_micros,
  metrics.orders
FROM campaign
WHERE campaign.id = 1234567890
  AND segments.date BETWEEN '2026-06-01' AND '2026-08-30'
ORDER BY segments.week
```

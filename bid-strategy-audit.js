/**
 * BID STRATEGY AUDIT — pre-17-Aug-2026 target-based-bidding change.
 *
 * INSTALL: In Google Ads, go to Tools > Bulk actions > Scripts, create a new
 * script, paste this whole file in, click Authorise (it needs Ads read access
 * plus Google Sheets/Drive to write the report), optionally set
 * SPREADSHEET_URL below (leave blank to have the script create a fresh sheet
 * and log its URL), then Preview/Run. Schedule it weekly if you want the sheet
 * kept current. The script is account-generic: it reads the account's own
 * timezone, currency and bid strategies, so the same file can be deployed
 * unchanged across accounts (ROAS-target and CPA-target accounts alike).
 *
 * What it does: pulls campaign performance over four windows (60d base,
 * 30/14/7d rolling, all ending yesterday), computes windowed ROAS/CPA
 * in-script (there is no native windowed column), classifies every campaign
 * by target status, and writes a five-tab audit workbook: Summary,
 * Actionable, Campaign Data, Segment Summary, Method & Definitions.
 */

// ---------------------------------------------------------------------------
// CONFIG — the only block you should need to touch.
// ---------------------------------------------------------------------------
var CONFIG = {
  // Full URL of an existing Google Sheet. Leave '' to create a new one
  // (the URL is logged at the end of the run).
  SPREADSHEET_URL: '',

  // Campaigns with less than this 60-day cost (account currency) are never
  // flagged/prioritised — short-window ratios are too volatile below it.
  LOW_SPEND_FLOOR: 1500,

  // The three rolling lookback windows, in days, each ending yesterday in the
  // account's own timezone. Order matters: [long, mid, short].
  WINDOW_LONG: 30,
  WINDOW_MID: 14,
  WINDOW_SHORT: 7,

  // Base window used for classification, spend weighting and the pie charts.
  BASE_WINDOW: 60,

  // A campaign is treated as budget-limited when its 7-day average daily
  // spend reaches this share of its daily budget (see isBudgetLimited_).
  BUDGET_LIMITED_THRESHOLD: 0.85
};

// Theme.
var COLORS = {
  PINK: '#E72D9E',   // header bands, primary chart series, "with target"
  BLACK: '#1A1A1A',  // comparison chart series, "no target"
  NAVY: '#0D2952',   // titles
  WHITE: '#FFFFFF',
  RED: '#F4C7C3',    // trend <= -20%
  AMBER: '#FCE8B2',  // trend -10% .. -20%
  GREEN: '#D9EAD3',  // trend > -10%
  GREY: '#EFEFEF'    // no-target / low-spend rows
};

var TAB_ORDER = ['Summary', 'Actionable', 'Campaign Data', 'Segment Summary',
                 'Method & Definitions'];

// ---------------------------------------------------------------------------
// ENTRY POINT
// ---------------------------------------------------------------------------
function main() {
  var account = AdsApp.currentAccount();
  var tz = account.getTimeZone();
  var currency = account.getCurrencyCode();

  // All four windows end yesterday *in the account's timezone*, so partial
  // "today" data never skews the short windows.
  var ranges = buildDateRanges_(tz);

  // Portfolio strategies are a separate resource: campaigns attached to one
  // carry their target on the strategy, not on the campaign, so we fetch the
  // strategies once and join by resource name.
  var portfolios = fetchPortfolioStrategies_();

  // 60-day base pull: identity, strategy, targets, budget + 60d metrics.
  var campaigns = fetchBase_(ranges.base, portfolios);

  // -------------------------------------------------------------------------
  // THE CORE JOIN. There is no native 30/14/7-day ROAS or CPA column and the
  // report API only aggregates over one date range per query — so we run the
  // same metrics query three more times (last 30, 14 and 7 days) and stitch
  // the results onto the 60-day base by campaign ID, in memory. A campaign
  // present in the base but absent (or zero) in a shorter window simply gets
  // nulls for that window, which render as blanks — never Infinity/NaN.
  // -------------------------------------------------------------------------
  attachWindow_(campaigns, 'w30', ranges.w30);
  attachWindow_(campaigns, 'w14', ranges.w14);
  attachWindow_(campaigns, 'w7', ranges.w7);

  var list = [];
  for (var id in campaigns) list.push(campaigns[id]);
  list.sort(function(a, b) { return b.base.cost - a.base.cost; });

  // Which metric the account "speaks": cost-weighted by targeted 60d spend.
  var primaryMetric = accountPrimaryMetric_(list);

  var totalCost = 0;
  list.forEach(function(c) { totalCost += c.base.cost; });

  // Per-campaign derived fields; one bad campaign logs and skips, it cannot
  // kill the run.
  list.forEach(function(c) {
    try {
      deriveCampaign_(c, primaryMetric, totalCost);
    } catch (e) {
      Logger.log('Skipping derivations for campaign "' + c.name + '": ' + e);
      c.broken = true;
    }
  });
  list = list.filter(function(c) { return !c.broken; });

  var ss = openOrCreateSpreadsheet_(account, ranges);

  buildSummaryTab_(ss, list, account, ranges, primaryMetric, currency);
  buildActionableTab_(ss, list, primaryMetric, currency);
  buildCampaignDataTab_(ss, list, primaryMetric, currency, totalCost);
  buildSegmentSummaryTab_(ss, list, primaryMetric, currency, totalCost);
  buildMethodTab_(ss, ranges, primaryMetric, currency);

  orderTabs_(ss);

  Logger.log('Bid strategy audit complete: ' + list.length + ' campaigns, ' +
             'primary metric ' + primaryMetric + '.');
  Logger.log('Spreadsheet: ' + ss.getUrl());
}

// ---------------------------------------------------------------------------
// DATES
// ---------------------------------------------------------------------------
function buildDateRanges_(tz) {
  // "Yesterday" as a calendar date in the account's timezone, then shifted
  // with pure date arithmetic in UTC so DST can't move the boundaries.
  var todayIso = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var end = shiftDays_(todayIso, -1);
  function windowOf(days) {
    return { start: shiftDays_(end, -(days - 1)), end: end, days: days };
  }
  return {
    base: windowOf(CONFIG.BASE_WINDOW),
    w30: windowOf(CONFIG.WINDOW_LONG),
    w14: windowOf(CONFIG.WINDOW_MID),
    w7: windowOf(CONFIG.WINDOW_SHORT)
  };
}

function shiftDays_(isoDate, days) {
  var d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

// ---------------------------------------------------------------------------
// DATA PULLS
// ---------------------------------------------------------------------------
function fetchPortfolioStrategies_() {
  var map = {};
  try {
    var rows = AdsApp.report(
      'SELECT bidding_strategy.resource_name, bidding_strategy.name, ' +
      ' bidding_strategy.type, ' +
      ' bidding_strategy.target_roas.target_roas, ' +
      ' bidding_strategy.target_cpa.target_cpa_micros, ' +
      ' bidding_strategy.maximize_conversion_value.target_roas, ' +
      ' bidding_strategy.maximize_conversions.target_cpa_micros ' +
      'FROM bidding_strategy').rows();
    while (rows.hasNext()) {
      var r = rows.next();
      map[r['bidding_strategy.resource_name']] = {
        name: r['bidding_strategy.name'] || '',
        type: r['bidding_strategy.type'] || '',
        targetRoas: num_(r['bidding_strategy.target_roas.target_roas']) ||
                    num_(r['bidding_strategy.maximize_conversion_value.target_roas']),
        targetCpa: micros_(r['bidding_strategy.target_cpa.target_cpa_micros']) ||
                   micros_(r['bidding_strategy.maximize_conversions.target_cpa_micros'])
      };
    }
  } catch (e) {
    // No portfolio strategies (or the resource is unavailable) — campaigns
    // then classify from their own campaign-level fields only.
    Logger.log('Portfolio strategy pull skipped: ' + e);
  }
  return map;
}

function fetchBase_(range, portfolios) {
  var campaigns = {};
  var rows = AdsApp.report(
    'SELECT campaign.id, campaign.name, campaign.bidding_strategy_type, ' +
    ' campaign.bidding_strategy, ' +
    ' campaign.maximize_conversion_value.target_roas, ' +
    ' campaign.maximize_conversions.target_cpa_micros, ' +
    ' campaign.target_roas.target_roas, ' +
    ' campaign.target_cpa.target_cpa_micros, ' +
    ' campaign_budget.amount_micros, campaign_budget.explicitly_shared, ' +
    ' metrics.cost_micros, metrics.conversions_value, metrics.conversions ' +
    'FROM campaign ' +
    "WHERE campaign.status = 'ENABLED' " +
    " AND segments.date BETWEEN '" + range.start + "' AND '" + range.end + "'"
  ).rows();

  while (rows.hasNext()) {
    var r = rows.next();
    try {
      var c = {
        id: String(r['campaign.id']),
        name: r['campaign.name'],
        strategyType: r['campaign.bidding_strategy_type'] || 'UNKNOWN',
        portfolio: false,
        portfolioName: '',
        targetType: 'None',
        target: null,
        budgetDaily: micros_(r['campaign_budget.amount_micros']),
        budgetShared: String(r['campaign_budget.explicitly_shared']) === 'true',
        base: {
          cost: micros_(r['metrics.cost_micros']),
          value: num_(r['metrics.conversions_value']),
          conv: num_(r['metrics.conversions'])
        },
        w30: null, w14: null, w7: null
      };

      // ---- Target resolution, generic across account types. ----
      // Portfolio first: if the campaign points at a portfolio strategy the
      // target lives there, not on the campaign.
      var res = r['campaign.bidding_strategy'] || '';
      if (res && portfolios[res]) {
        c.portfolio = true;
        c.portfolioName = portfolios[res].name;
        if (portfolios[res].targetRoas) {
          c.targetType = 'ROAS'; c.target = portfolios[res].targetRoas;
        } else if (portfolios[res].targetCpa) {
          c.targetType = 'CPA'; c.target = portfolios[res].targetCpa;
        }
      } else {
        // Standard (campaign-level) strategies: read whichever oneof field is
        // populated. A tROAS/max-conv-value campaign exposes a target ROAS, a
        // tCPA/max-conversions campaign exposes a target CPA. 0/absent = no
        // target set (plain Maximise conversions / conversion value).
        var tRoas = num_(r['campaign.target_roas.target_roas']) ||
                    num_(r['campaign.maximize_conversion_value.target_roas']);
        var tCpa = micros_(r['campaign.target_cpa.target_cpa_micros']) ||
                   micros_(r['campaign.maximize_conversions.target_cpa_micros']);
        if (tRoas) { c.targetType = 'ROAS'; c.target = tRoas; }
        else if (tCpa) { c.targetType = 'CPA'; c.target = tCpa; }
      }

      campaigns[c.id] = c;
    } catch (e) {
      Logger.log('Skipping unreadable campaign row: ' + e);
    }
  }
  return campaigns;
}

// One extra query per rolling window: raw cost/value/conversions only, keyed
// by campaign ID and stitched onto the base map. This is the "windowed
// ROAS/CPA" mechanism — the ratios are computed later, never read.
function attachWindow_(campaigns, key, range) {
  var rows = AdsApp.report(
    'SELECT campaign.id, metrics.cost_micros, metrics.conversions_value, ' +
    ' metrics.conversions ' +
    'FROM campaign ' +
    "WHERE campaign.status = 'ENABLED' " +
    " AND segments.date BETWEEN '" + range.start + "' AND '" + range.end + "'"
  ).rows();
  while (rows.hasNext()) {
    var r = rows.next();
    var c = campaigns[String(r['campaign.id'])];
    if (!c) continue; // not in the 60d base (shouldn't happen) — ignore.
    c[key] = {
      cost: micros_(r['metrics.cost_micros']),
      value: num_(r['metrics.conversions_value']),
      conv: num_(r['metrics.conversions'])
    };
  }
}

// ---------------------------------------------------------------------------
// DERIVED FIELDS
// ---------------------------------------------------------------------------
function accountPrimaryMetric_(list) {
  // Cost-weighted, not campaign-counted: whichever target type carries more
  // 60d spend wins. Untargeted accounts fall back on "does the account track
  // conversion value at all".
  var roasCost = 0, cpaCost = 0, anyValue = 0;
  list.forEach(function(c) {
    if (c.targetType === 'ROAS') roasCost += c.base.cost;
    if (c.targetType === 'CPA') cpaCost += c.base.cost;
    anyValue += c.base.value;
  });
  if (roasCost === 0 && cpaCost === 0) return anyValue > 0 ? 'ROAS' : 'CPA';
  return roasCost >= cpaCost ? 'ROAS' : 'CPA';
}

// ROAS = conversions_value / cost; CPA = cost / conversions. Divide-by-zero
// returns null (rendered blank) — never Infinity/NaN.
function metricOf_(w, type) {
  if (!w) return null;
  if (type === 'ROAS') return w.cost > 0 ? w.value / w.cost : null;
  return w.conv > 0 ? w.cost / w.conv : null;
}

function deriveCampaign_(c, primaryMetric, totalCost) {
  // Campaigns with a target are measured on their own target's metric; the
  // rest are displayed on the account's primary metric so columns stay
  // comparable.
  c.metricType = c.targetType !== 'None' ? c.targetType : primaryMetric;

  c.m60 = metricOf_(c.base, c.metricType);
  c.m30 = metricOf_(c.w30, c.metricType);
  c.m14 = metricOf_(c.w14, c.metricType);
  c.m7 = metricOf_(c.w7, c.metricType);

  // Gap vs Target respects direction: beating the target reads POSITIVE for
  // both metric types (higher ROAS is good, lower CPA is good).
  c.gap = null;
  if (c.target && c.m30 != null) {
    c.gap = c.targetType === 'ROAS'
        ? (c.m30 - c.target) / c.target
        : (c.target - c.m30) / c.target;
  }

  // Trend 30d>7d ("decay"): negative = deteriorating, for both metric types.
  // ROAS: (m7-m30)/m30. CPA equivalent: (m30-m7)/m30, so a rising CPA reads
  // negative too.
  c.trend = null;
  if (c.m30 != null && c.m30 !== 0 && c.m7 != null) {
    c.trend = c.metricType === 'ROAS'
        ? (c.m7 - c.m30) / c.m30
        : (c.m30 - c.m7) / c.m30;
  }

  c.hasTarget = c.targetType !== 'None';
  c.aboveFloor = c.base.cost >= CONFIG.LOW_SPEND_FLOOR;
  c.budgetLimited = isBudgetLimited_(c);
  c.pctSpend = totalCost > 0 ? c.base.cost / totalCost : 0;

  // Priority: only campaigns that carry a target AND clear the spend floor
  // are flagged; everyone else is labelled, not scored.
  if (!c.hasTarget) {
    c.priority = 'No target';
  } else if (!c.aboveFloor) {
    c.priority = 'Low spend - not flagged';
  } else if (c.trend == null) {
    c.priority = 'No recent data';
  } else if (c.trend <= -0.20) {
    c.priority = '1 - Act now';
  } else if (c.trend <= -0.10) {
    c.priority = '2 - Watch';
  } else {
    c.priority = '3 - Stable';
  }

  // Segment (no name-based inference — target status, spend floor, gap band).
  if (!c.hasTarget) c.segment = 'No target';
  else if (!c.aboveFloor) c.segment = 'Targeted - low spend';
  else if (c.gap == null) c.segment = 'Within +/-20% of target';
  else if (c.gap > 0.20) c.segment = 'Beating target >20%';
  else if (c.gap < -0.20) c.segment = 'Missing target >20%';
  else c.segment = 'Within +/-20% of target';

  var flags = [];
  if (c.hasTarget && c.aboveFloor) flags.push(c.priority);
  if (c.budgetLimited) flags.push('Budget-limited');
  if (c.portfolio) flags.push('Portfolio strategy');
  c.flag = flags.join('; ') || '-';

  c.actionable = c.hasTarget && c.aboveFloor &&
      ((c.gap != null && Math.abs(c.gap) > 0.20) ||
       (c.trend != null && c.trend <= -0.20));
}

/**
 * Budget-limited flag. The UI's "Limited by budget" status isn't reliably
 * exposed as a clean GAQL field in the Scripts environment (the
 * campaign.primary_status_reasons route is version-dependent), so we DERIVE
 * it instead: a campaign is treated as budget-limited when its last-7-day
 * average daily spend reaches BUDGET_LIMITED_THRESHOLD (default 85%) of its
 * daily budget. Caveat, commented deliberately: for shared budgets the
 * comparison is this campaign's own spend vs the whole shared amount, so
 * shared-budget campaigns can be under-flagged.
 */
function isBudgetLimited_(c) {
  if (!c.budgetDaily || !c.w7) return false;
  var avgDaily = c.w7.cost / CONFIG.WINDOW_SHORT;
  return avgDaily >= CONFIG.BUDGET_LIMITED_THRESHOLD * c.budgetDaily;
}

// ---------------------------------------------------------------------------
// TAB 1: SUMMARY
// ---------------------------------------------------------------------------
function buildSummaryTab_(ss, list, account, ranges, primaryMetric, currency) {
  var sh = resetSheet_(ss, 'Summary');

  title_(sh, 1, 'Bid Strategy Audit - ' + account.getName() + ' (' +
         account.getCustomerId() + ')', 12);
  subtitle_(sh, 2, 'Run ' + ranges.base.end + ' | Windows: 60/30/14/7 days ending ' +
            ranges.base.end + ' | Primary metric: ' + primaryMetric +
            ' | All money in ' + currency);

  // ---- Helper tables the pie charts reference (kept far right, visible). ----
  var withT = list.filter(function(c) { return c.hasTarget; });
  var noT = list.filter(function(c) { return !c.hasTarget; });
  function sum(arr, f) { var t = 0; arr.forEach(function(c) { t += f(c); }); return t; }

  sh.getRange(3, 14).setValue('Chart data - do not edit').setFontStyle('italic')
      .setFontColor('#999999');
  var helper = [
    ['Segment', 'Campaigns'],
    ['With target', withT.length],
    ['No target', noT.length],
    ['', ''],
    ['Segment', 'Cost 60d'],
    ['With target', round2_(sum(withT, function(c) { return c.base.cost; }))],
    ['No target', round2_(sum(noT, function(c) { return c.base.cost; }))],
    ['', ''],
    ['Segment', 'Conversions 60d'],
    ['With target', round2_(sum(withT, function(c) { return c.base.conv; }))],
    ['No target', round2_(sum(noT, function(c) { return c.base.conv; }))]
  ];
  sh.getRange(4, 14, helper.length, 2).setValues(helper);

  // Three native pie charts: with-target vs no-target split by campaign
  // count, 60d cost, 60d conversions.
  insertChartSafe_(sh, function() {
    return sh.newChart().setChartType(Charts.ChartType.PIE)
        .addRange(sh.getRange(4, 14, 3, 2))
        .setPosition(4, 1, 0, 0)
        .setOption('title', 'Campaigns: with vs without target')
        .setOption('colors', [COLORS.PINK, COLORS.BLACK])
        .setOption('width', 300).setOption('height', 220)
        .setOption('legend', { position: 'bottom' })
        .build();
  });
  insertChartSafe_(sh, function() {
    return sh.newChart().setChartType(Charts.ChartType.PIE)
        .addRange(sh.getRange(8, 14, 3, 2))
        .setPosition(4, 4, 0, 0)
        .setOption('title', 'Cost 60d: with vs without target')
        .setOption('colors', [COLORS.PINK, COLORS.BLACK])
        .setOption('width', 300).setOption('height', 220)
        .setOption('legend', { position: 'bottom' })
        .build();
  });
  insertChartSafe_(sh, function() {
    return sh.newChart().setChartType(Charts.ChartType.PIE)
        .addRange(sh.getRange(12, 14, 3, 2))
        .setPosition(4, 7, 0, 0)
        .setOption('title', 'Conversions 60d: with vs without target')
        .setOption('colors', [COLORS.PINK, COLORS.BLACK])
        .setOption('width', 300).setOption('height', 220)
        .setOption('legend', { position: 'bottom' })
        .build();
  });

  // ---- Full campaign table below the charts. ----
  var hdrRow = 17;
  var headers = ['Campaign', 'Bid Strategy', 'Target Type', 'Target',
                 'Actual 30d', 'Trend 30d>7d', 'Priority'];
  sh.getRange(hdrRow, 1, 1, headers.length).setValues([headers]);
  headerBand_(sh, hdrRow, headers.length);

  var out = [];
  list.forEach(function(c) {
    out.push([
      c.name, prettyStrategy_(c), c.targetType,
      c.target != null ? round2_(c.target) : '',
      c.m30 != null ? round2_(c.m30) : '',
      c.trend != null ? c.trend : '',
      c.priority
    ]);
  });
  if (out.length) {
    sh.getRange(hdrRow + 1, 1, out.length, headers.length).setValues(out);
    sh.getRange(hdrRow + 1, 6, out.length, 1).setNumberFormat('0.0%');

    // "Conditional formatting" applied deterministically per row: red/amber/
    // green on the priority thresholds for flagged rows, grey for no-target
    // and low-spend rows.
    list.forEach(function(c, i) {
      var cell = sh.getRange(hdrRow + 1 + i, 6);
      if (!c.hasTarget || !c.aboveFloor) cell.setBackground(COLORS.GREY);
      else if (c.trend == null) cell.setBackground(COLORS.GREY);
      else if (c.trend <= -0.20) cell.setBackground(COLORS.RED);
      else if (c.trend <= -0.10) cell.setBackground(COLORS.AMBER);
      else cell.setBackground(COLORS.GREEN);
    });
  } else {
    sh.getRange(hdrRow + 1, 1).setValue('No enabled campaigns found in this account.');
  }

  var noteRow = hdrRow + out.length + 2;
  sh.getRange(noteRow, 1).setValue(
      'Note: decay on low-spend campaigns (< ' + CONFIG.LOW_SPEND_FLOOR + ' ' +
      currency + ' over 60d) is volatile — shown deliberately for context, not action.')
      .setFontStyle('italic').setFontColor('#666666');

  sh.setColumnWidths(1, 1, 280);
  sh.setColumnWidths(2, 6, 130);
  finishSheet_(sh);
}

// ---------------------------------------------------------------------------
// TAB 2: ACTIONABLE
// ---------------------------------------------------------------------------
function buildActionableTab_(ss, list, primaryMetric, currency) {
  var sh = resetSheet_(ss, 'Actionable');
  title_(sh, 1, 'Actionable - campaigns whose target should move', 12);
  subtitle_(sh, 2, 'Filter: carries a target, 60d cost >= ' +
      CONFIG.LOW_SPEND_FLOOR + ' ' + currency +
      ', and |gap| > 20% or decay <= -20%. Ordered by 60d cost. ' +
      'Proposed Target is seeded at the 30d actual - edit freely; Wk1-3 and ' +
      'Status are yours for manual tracking.');

  var headers = ['Campaign', 'Target', 'Actual 30d', 'Gap', 'Timing',
                 'Proposed Target', 'Wk1', 'Wk2', 'Wk3', 'Status', 'Commentary'];
  sh.getRange(3, 1, 1, headers.length).setValues([headers]);
  headerBand_(sh, 3, headers.length);

  var rows = list.filter(function(c) { return c.actionable; });
  var out = rows.map(function(c) {
    return [
      c.name,
      round2_(c.target),
      c.m30 != null ? round2_(c.m30) : '',
      c.gap != null ? c.gap : '',
      // Budget-limited campaigns behave differently once target-based bidding
      // changes on 17 Aug 2026 — move those first.
      c.budgetLimited ? 'Before 17 Aug' : 'After 17 Aug',
      c.m30 != null ? round2_(c.m30) : '',
      '', '', '', '',
      actionCommentary_(c)
    ];
  });
  if (out.length) {
    sh.getRange(4, 1, out.length, headers.length).setValues(out);
    sh.getRange(4, 4, out.length, 1).setNumberFormat('0.0%');
    sh.getRange(4, 2, out.length, 1).setNumberFormat('#,##0.00');
    sh.getRange(4, 3, out.length, 1).setNumberFormat('#,##0.00');
    sh.getRange(4, 6, out.length, 1).setNumberFormat('#,##0.00');
  } else {
    sh.getRange(4, 1).setValue('Nothing actionable right now - no targeted, ' +
        'above-floor campaign is >20% off target or decaying >=20%.');
  }

  sh.setColumnWidths(1, 1, 280);
  sh.setColumnWidths(2, 9, 105);
  sh.setColumnWidths(11, 1, 420);
  sh.getRange(4, 11, Math.max(out.length, 1), 1).setWrap(true);
  finishSheet_(sh);
}

function actionCommentary_(c) {
  var parts = [];
  var metric = c.targetType;
  if (c.gap != null) {
    var pct = Math.round(Math.abs(c.gap) * 100);
    if (c.gap > 0.20) {
      parts.push('Beating ' + metric + ' target by ' + pct +
                 '% over 30d - target likely has headroom');
    } else if (c.gap < -0.20) {
      parts.push('Missing ' + metric + ' target by ' + pct + '% over 30d');
    } else {
      parts.push('Within ' + pct + '% of ' + metric + ' target over 30d');
    }
  }
  if (c.trend != null && c.trend <= -0.20) {
    parts.push('decaying ' + Math.round(Math.abs(c.trend) * 100) +
               '% (7d vs 30d)');
  }
  if (c.portfolio) {
    parts.push('portfolio strategy "' + c.portfolioName +
               '" - target sits at strategy level and needs unpicking before ' +
               'a per-campaign change');
  }
  if (c.budgetLimited) {
    parts.push('budget-limited - target and budget cap are interacting, ' +
               'resolve before 17 Aug');
  }
  return parts.join('; ') + '.';
}

// ---------------------------------------------------------------------------
// TAB 3: CAMPAIGN DATA
// ---------------------------------------------------------------------------
function buildCampaignDataTab_(ss, list, primaryMetric, currency, totalCost) {
  var sh = resetSheet_(ss, 'Campaign Data');
  title_(sh, 1, 'Campaign Data - all raw and computed fields', 12);

  var headers = ['Campaign', 'Campaign ID', 'Bid Strategy', 'Portfolio',
                 'Target Type', 'Target', 'Budget-limited', 'Cost 60d',
                 '% of Spend', 'Metric', 'ROAS/CPA 60d', 'ROAS/CPA 30d',
                 'ROAS/CPA 14d', 'ROAS/CPA 7d', 'Gap vs Target',
                 'Trend 30d>7d', 'Segment', 'Flag'];
  sh.getRange(2, 1, 1, headers.length).setValues([headers]);
  headerBand_(sh, 2, headers.length);

  var out = list.map(function(c) {
    return [
      c.name, c.id, prettyStrategy_(c), c.portfolio ? 'Yes' : 'No',
      c.targetType, c.target != null ? round2_(c.target) : '',
      c.budgetLimited ? 'Yes' : 'No',
      Math.round(c.base.cost),
      c.pctSpend,
      c.metricType,
      c.m60 != null ? round2_(c.m60) : '',
      c.m30 != null ? round2_(c.m30) : '',
      c.m14 != null ? round2_(c.m14) : '',
      c.m7 != null ? round2_(c.m7) : '',
      c.gap != null ? c.gap : '',
      c.trend != null ? c.trend : '',
      c.segment, c.flag
    ];
  });
  if (out.length) {
    sh.getRange(3, 1, out.length, headers.length).setValues(out);
    sh.getRange(3, 8, out.length, 1).setNumberFormat('#,##0');
    sh.getRange(3, 9, out.length, 1).setNumberFormat('0.0%');
    sh.getRange(3, 11, out.length, 4).setNumberFormat('#,##0.00');
    sh.getRange(3, 15, out.length, 2).setNumberFormat('0.0%');
  } else {
    sh.getRange(3, 1).setValue('No enabled campaigns found.');
  }

  sh.setFrozenRows(2);
  sh.setFrozenColumns(1);
  sh.setColumnWidths(1, 1, 280);
  sh.setColumnWidths(2, 17, 110);
  finishSheet_(sh);
}

// ---------------------------------------------------------------------------
// TAB 4: SEGMENT SUMMARY
// ---------------------------------------------------------------------------
function buildSegmentSummaryTab_(ss, list, primaryMetric, currency, totalCost) {
  var sh = resetSheet_(ss, 'Segment Summary');
  title_(sh, 1, 'Segment Summary - cost-weighted ' + primaryMetric + ' by segment', 12);
  subtitle_(sh, 2, 'Segments come only from target status, budget status, gap ' +
      'band and bid strategy - never from campaign names. Every rollup is ' +
      'cost-weighted (ratio of sums), not an average of ratios.');

  // Segment definitions. Rows are dimension-prefixed because the dimensions
  // overlap (a campaign appears once per dimension it belongs to).
  var defs = [
    ['Target: With target', function(c) { return c.hasTarget; }],
    ['Target: No target', function(c) { return !c.hasTarget; }],
    ['Budget: Limited', function(c) { return c.budgetLimited; }],
    ['Budget: Not limited', function(c) { return !c.budgetLimited; }],
    ['Gap: Beating target >20%', function(c) { return c.segment === 'Beating target >20%'; }],
    ['Gap: Within +/-20%', function(c) { return c.segment === 'Within +/-20% of target'; }],
    ['Gap: Missing target >20%', function(c) { return c.segment === 'Missing target >20%'; }],
    ['Gap: Targeted - low spend', function(c) { return c.segment === 'Targeted - low spend'; }]
  ];
  // One segment per bid strategy type actually present.
  var types = {};
  list.forEach(function(c) { types[c.strategyType] = true; });
  Object.keys(types).sort().forEach(function(t) {
    defs.push(['Strategy: ' + prettyStrategyType_(t),
               function(c) { return c.strategyType === t; }]);
  });

  var headers = ['Segment', 'Campaigns', 'Cost 60d', '% Spend',
                 primaryMetric + ' 60d', primaryMetric + ' 30d',
                 primaryMetric + ' 14d', primaryMetric + ' 7d',
                 'Decay', 'Commentary'];
  sh.getRange(3, 1, 1, headers.length).setValues([headers]);
  headerBand_(sh, 3, headers.length);

  var out = [];
  defs.forEach(function(def) {
    var members = list.filter(def[1]);
    if (!members.length) return;
    // Cost-weighted by construction: sum the raw components per window, then
    // take the ratio of sums — never average the per-campaign ratios.
    function agg(key) {
      var t = { cost: 0, value: 0, conv: 0 };
      members.forEach(function(c) {
        var w = key === 'base' ? c.base : c[key];
        if (!w) return;
        t.cost += w.cost; t.value += w.value; t.conv += w.conv;
      });
      return t;
    }
    var b = agg('base'), a30 = agg('w30'), a14 = agg('w14'), a7 = agg('w7');
    var m60 = metricOf_(b, primaryMetric), m30 = metricOf_(a30, primaryMetric);
    var m14 = metricOf_(a14, primaryMetric), m7 = metricOf_(a7, primaryMetric);
    var decay = null;
    if (m30 != null && m30 !== 0 && m7 != null) {
      decay = primaryMetric === 'ROAS' ? (m7 - m30) / m30 : (m30 - m7) / m30;
    }
    out.push([
      def[0], members.length, Math.round(b.cost),
      totalCost > 0 ? b.cost / totalCost : 0,
      m60 != null ? round2_(m60) : '', m30 != null ? round2_(m30) : '',
      m14 != null ? round2_(m14) : '', m7 != null ? round2_(m7) : '',
      decay != null ? decay : '',
      segmentCommentary_(def[0], members.length, b, totalCost, decay, primaryMetric)
    ]);
  });

  if (out.length) {
    sh.getRange(4, 1, out.length, headers.length).setValues(out);
    sh.getRange(4, 3, out.length, 1).setNumberFormat('#,##0');
    sh.getRange(4, 4, out.length, 1).setNumberFormat('0.0%');
    sh.getRange(4, 5, out.length, 4).setNumberFormat('#,##0.00');
    sh.getRange(4, 9, out.length, 1).setNumberFormat('0.0%');
    sh.getRange(4, 10, out.length, 1).setWrap(true);

    var n = out.length;
    // Bar chart: 60d cost by segment (pink).
    insertChartSafe_(sh, function() {
      return sh.newChart().setChartType(Charts.ChartType.BAR)
          .addRange(sh.getRange(3, 1, n + 1, 1))
          .addRange(sh.getRange(3, 3, n + 1, 1))
          .setPosition(4, 12, 0, 0)
          .setOption('title', 'Cost 60d by segment (' + currency + ')')
          .setOption('colors', [COLORS.PINK])
          .setOption('width', 520).setOption('height', 20 * n + 160)
          .setOption('legend', { position: 'none' })
          .build();
    });
    // Column chart: 30d vs 7d metric by segment (pink primary, black comparison).
    insertChartSafe_(sh, function() {
      return sh.newChart().setChartType(Charts.ChartType.COLUMN)
          .addRange(sh.getRange(3, 1, n + 1, 1))
          .addRange(sh.getRange(3, 6, n + 1, 1))
          .addRange(sh.getRange(3, 8, n + 1, 1))
          .setPosition(Math.max(20, n + 6), 12, 0, 0)
          .setOption('title', primaryMetric + ' 30d vs 7d by segment')
          .setOption('colors', [COLORS.PINK, COLORS.BLACK])
          .setOption('width', 520).setOption('height', 320)
          .setOption('legend', { position: 'bottom' })
          .build();
    });
  } else {
    sh.getRange(4, 1).setValue('No campaigns to segment.');
  }

  sh.setColumnWidths(1, 1, 230);
  sh.setColumnWidths(2, 8, 100);
  sh.setColumnWidths(10, 1, 380);
  finishSheet_(sh);
}

function segmentCommentary_(name, count, base, totalCost, decay, metric) {
  var parts = [count + ' campaign' + (count === 1 ? '' : 's')];
  if (totalCost > 0) {
    parts.push(Math.round(100 * base.cost / totalCost) + '% of 60d spend');
  }
  if (decay != null) {
    if (decay <= -0.20) {
      parts.push(metric + ' deteriorating sharply into the last 7 days (' +
                 Math.round(decay * 100) + '%)');
    } else if (decay <= -0.10) {
      parts.push(metric + ' softening into the last 7 days (' +
                 Math.round(decay * 100) + '%)');
    } else if (decay >= 0.10) {
      parts.push(metric + ' improving into the last 7 days (+' +
                 Math.round(decay * 100) + '%)');
    } else {
      parts.push(metric + ' steady across windows');
    }
  } else {
    parts.push('not enough recent data for a trend read');
  }
  return parts.join('; ') + '.';
}

// ---------------------------------------------------------------------------
// TAB 5: METHOD & DEFINITIONS
// ---------------------------------------------------------------------------
function buildMethodTab_(ss, ranges, primaryMetric, currency) {
  var sh = resetSheet_(ss, 'Method & Definitions');
  title_(sh, 1, 'Method & Definitions', 12);

  var rows = [
    ['Windows', 'Four windows, all ending ' + ranges.base.end + ' (yesterday, ' +
     'account timezone): a 60-day base for classification and spend weighting, ' +
     'plus rolling 30/14/7-day windows. They are read together so steady-state ' +
     'performance (30d) can be separated from recent movement (7d) without ' +
     'over-reacting to either.'],
    ['Windowed ROAS/CPA are computed, not read', 'There is no native 30/14/7-day ' +
     'ROAS or CPA column in Google Ads. The script runs the same campaign query ' +
     'once per window, pulls raw cost / conversion value / conversions, joins the ' +
     'results by campaign ID in memory, and computes ROAS = value/cost and ' +
     'CPA = cost/conversions per window. Divide-by-zero renders blank, never ' +
     'Infinity or NaN.'],
    ['Segments', 'Segments are defined only by target status, budget status, gap ' +
     'band and bid strategy type. No inference is made from campaign names.'],
    ['Low-spend floor', 'Campaigns under ' + CONFIG.LOW_SPEND_FLOOR + ' ' + currency +
     ' of 60-day cost are never flagged or prioritised: 7-day ratios on small ' +
     'spend are noise. Their figures are still shown for context.'],
    ['Gap vs Target', 'Direction-aware so beating the target always reads ' +
     'positive: ROAS gap = (actual - target)/target; CPA gap = (target - actual)/target.'],
    ['Trend 30d>7d (decay)', 'ROAS: (ROAS7 - ROAS30)/ROAS30. CPA equivalent: ' +
     '(CPA30 - CPA7)/CPA30. Negative always means deteriorating. Priority: ' +
     '<= -20% = "1 - Act now"; -10% to -20% = "2 - Watch"; else "3 - Stable".'],
    ['Timing', '"Before 17 Aug" when a campaign is budget-limited (target and ' +
     'budget cap interact once target-based bidding changes on 17 Aug 2026); ' +
     '"After 17 Aug" otherwise.'],
    ['Budget-limited (derived)', 'The UI\'s "Limited by budget" status is not ' +
     'reliably exposed to scripts, so it is derived: last-7-day average daily ' +
     'spend >= ' + Math.round(CONFIG.BUDGET_LIMITED_THRESHOLD * 100) + '% of ' +
     'daily budget. Shared budgets can be under-flagged by this method.'],
    ['Averages', 'Every rollup that averages a rate is cost-weighted (ratio of ' +
     'sums), never a simple average of ratios.'],
    ['Primary metric', 'This account reads as a ' + primaryMetric + ' account: ' +
     'the metric carrying the most targeted 60-day spend. Campaigns with their ' +
     'own target are always measured on that target\'s metric.'],
    ['What this data cannot tell us', 'Attribution completeness and lag; the ' +
     'intended role of each campaign (prospecting vs brand vs clearance); ' +
     'whether a target was set deliberately or inherited; and the promo ' +
     'calendar. Treat the sheet as a map, not a verdict.']
  ];

  sh.getRange(3, 1, 1, 2).setValues([['Topic', 'Definition']]);
  headerBand_(sh, 3, 2);
  sh.getRange(4, 1, rows.length, 2).setValues(rows).setWrap(true)
      .setVerticalAlignment('top');
  sh.getRange(4, 1, rows.length, 1).setFontWeight('bold');
  sh.setColumnWidths(1, 1, 240);
  sh.setColumnWidths(2, 1, 760);
  finishSheet_(sh);
}

// ---------------------------------------------------------------------------
// SPREADSHEET / FORMATTING HELPERS
// ---------------------------------------------------------------------------
function openOrCreateSpreadsheet_(account, ranges) {
  if (CONFIG.SPREADSHEET_URL) {
    return SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
  }
  var ss = SpreadsheetApp.create('Bid Strategy Audit - ' + account.getName() +
                                 ' - ' + ranges.base.end);
  Logger.log('Created new spreadsheet: ' + ss.getUrl());
  return ss;
}

function resetSheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
  } else {
    sh.getCharts().forEach(function(ch) { sh.removeChart(ch); });
    sh.clear();
    sh.setFrozenRows(0);
    sh.setFrozenColumns(0);
  }
  return sh;
}

function orderTabs_(ss) {
  TAB_ORDER.forEach(function(name, i) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(i + 1);
  });
  // Drop the default empty tab if we created the file this run.
  var d = ss.getSheetByName('Sheet1');
  if (d && d.getLastRow() === 0 && ss.getSheets().length > TAB_ORDER.length) {
    ss.deleteSheet(d);
  }
  ss.setActiveSheet(ss.getSheetByName(TAB_ORDER[0]));
}

function title_(sh, row, text, size) {
  sh.getRange(row, 1).setValue(text).setFontColor(COLORS.NAVY)
      .setFontWeight('bold').setFontSize(size || 12);
}

function subtitle_(sh, row, text) {
  sh.getRange(row, 1).setValue(text).setFontColor('#666666').setFontSize(9);
}

function headerBand_(sh, row, ncols) {
  sh.getRange(row, 1, 1, ncols).setBackground(COLORS.PINK)
      .setFontColor(COLORS.WHITE).setFontWeight('bold');
}

function finishSheet_(sh) {
  sh.setHiddenGridlines(true);
  var rows = Math.min(sh.getMaxRows(), Math.max(sh.getLastRow() + 20, 50));
  sh.getRange(1, 1, rows, sh.getMaxColumns()).setFontFamily('Arial');
}

// Charts degrade gracefully: if the Charts service ever misbehaves the run
// keeps its tables and logs a warning instead of dying.
function insertChartSafe_(sh, buildFn) {
  try {
    sh.insertChart(buildFn());
  } catch (e) {
    Logger.log('Chart skipped on "' + sh.getName() + '": ' + e);
  }
}

// ---------------------------------------------------------------------------
// SMALL UTILITIES
// ---------------------------------------------------------------------------
function num_(v) {
  var n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

// Micros -> currency units. Raw micros are never printed.
function micros_(v) {
  return num_(v) / 1e6;
}

function round2_(v) {
  return Math.round(v * 100) / 100;
}

function prettyStrategyType_(t) {
  var names = {
    'TARGET_ROAS': 'Target ROAS',
    'TARGET_CPA': 'Target CPA',
    'MAXIMIZE_CONVERSION_VALUE': 'Max conv. value',
    'MAXIMIZE_CONVERSIONS': 'Max conversions',
    'TARGET_SPEND': 'Max clicks',
    'TARGET_IMPRESSION_SHARE': 'Target impr. share',
    'MANUAL_CPC': 'Manual CPC',
    'MANUAL_CPM': 'Manual CPM',
    'MANUAL_CPV': 'Manual CPV',
    'COMMISSION': 'Commission',
    'PERCENT_CPC': 'Percent CPC'
  };
  return names[t] || t;
}

function prettyStrategy_(c) {
  var label = prettyStrategyType_(c.strategyType);
  if (c.portfolio) label += ' (portfolio)';
  if (c.targetType === 'ROAS' && c.strategyType === 'MAXIMIZE_CONVERSION_VALUE') {
    label += ' + tROAS';
  }
  if (c.targetType === 'CPA' && c.strategyType === 'MAXIMIZE_CONVERSIONS') {
    label += ' + tCPA';
  }
  return label;
}

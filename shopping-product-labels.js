/**
 * SHOPPING PRODUCT LABELS — performance buckets for feed segmentation.
 *
 * READ-ONLY: this script makes NO changes to the Google Ads account. It reads
 * one report query and writes the result to a Google Sheet in your own Drive.
 * No bids, budgets, targets, statuses or structures are touched, and nothing
 * is written back to Merchant Center — the feed upload is a manual step you
 * control.
 *
 * WHAT IT DOES: pulls item-level Shopping performance over a lookback window,
 * aggregates it per product item ID, and sorts every item into one of five
 * buckets by how its ROAS compares with the account's breakeven, gated on
 * having enough traffic for that ROAS to mean anything:
 *
 *   over-index   proven winner        - enough clicks for ~3 conversions,
 *                                       ROAS comfortably above breakeven
 *   index        profitable           - enough clicks for ~1 conversion,
 *                                       ROAS at or above breakeven
 *   near-index   promising, thin data - ROAS near breakeven
 *   under-index  losing money         - has traffic, ROAS below the band
 *   no-index     no demand or no cost - below the impression floor, or
 *                                       impressions with no spend at all
 *
 * You then push the bucket into a Merchant Center supplemental feed as a
 * custom label, and split campaigns or ad groups by that label so winners
 * stop sharing budget with dead stock. The Labels tab is formatted for that
 * upload; nothing happens in the account until you do it.
 *
 * SEEDING A NEW MARKET: a market with no history cannot label itself -
 * every item would fall to no-index. Point SOURCE_CAMPAIGN_INCLUDE at the
 * market that HAS data and use its labels to structure the new market's
 * launch, then switch the filter across once the new market has enough
 * traffic of its own (roughly when most items clear the click gates below).
 *
 * BREAKEVEN ROAS is the setting that decides everything. It is 1 / gross
 * margin, NOT a target:
 *
 *   50% margin -> 2.0      40% margin -> 2.5      60% margin -> 1.67
 *
 * Set it from the client's actual product margin. A breakeven set far too
 * high dumps every item into under-index and the output is worthless, so the
 * script checks the bucket spread at the end of each run and says so in the
 * log if the split looks degenerate.
 *
 * DIFFERENCES FROM THE COMMON PUBLIC VERSION of this idea, all deliberate:
 *   - Bands are relative to breakeven, not a flat +/- 1. At a breakeven of
 *     2.0 a flat 1 is a 50% swing; at 15 it is 7%. Same code, wildly
 *     different meaning.
 *   - The impression floor is tested FIRST. Testing it last means an item
 *     with 12 impressions and one lucky sale is labelled near-index and
 *     never reaches the floor at all.
 *   - Recent days are excluded for conversion lag, so items are not judged
 *     on conversions that have not landed yet.
 *   - Numbers are parsed as numbers. String maths with a single-comma strip
 *     turns any value over 1,000,000 into NaN.
 *   - Zero-cost items are handled explicitly: value / 0 is Infinity, not
 *     NaN, so an isNaN guard lets them through as top performers.
 *
 * API: targets Google Ads API v25 via the apiVersion option on
 * AdsApp.report, falling back to the runtime default if that is rejected.
 *   resource  shopping_performance_view
 *   segments  segments.product_item_id, segments.date
 *   fields    campaign.name
 *   metrics   impressions, clicks, cost_micros, conversions, conversions_value
 *
 * ITEM ID CASE: the API returns product item IDs lower-cased, while Merchant
 * Center IDs are case-sensitive. Match on a lower-cased key when you build
 * the supplemental feed, or the join silently drops rows.
 *
 * MCC: this file runs against a single account. For a manager account, wrap
 * main() in a per-account loop via MccApp.accounts().executeInParallel and
 * give each account its own spreadsheet or add an Account column.
 *
 * INSTALL: Google Ads > Tools > Bulk actions > Scripts > new script, paste
 * this file, set CONFIG below, authorise, preview, run. Weekly is plenty.
 */

// ---------------------------------------------------------------------------
// CONFIG — the only block you should need to touch.
// ---------------------------------------------------------------------------
var CONFIG = {
  // Full URL of the Google Sheet to write to. Leave '' to have the script
  // create one and log its URL (paste that back here afterwards).
  SPREADSHEET_URL: '',

  // 1 / gross margin. NOT your ROAS target. See the note above.
  BREAKEVEN_ROAS: 2.0,

  // How far either side of breakeven the middle band runs, as a share of
  // breakeven. 0.15 at a breakeven of 2.0 means over-index needs 2.30+ and
  // near-index reaches down to 1.70.
  BAND: 0.15,

  // Site-wide Shopping conversion rate, as a percentage. Used only to turn
  // "enough clicks to trust this" into a number: one expected conversion is
  // 100 / CVR clicks. Read it off the account, do not guess.
  AVERAGE_CVR_PCT: 2.5,

  // Expected conversions an item needs before it can earn each label.
  CONVERSIONS_FOR_INDEX: 1,
  CONVERSIONS_FOR_OVER_INDEX: 3,

  // Below this many impressions an item is no-index regardless of ROAS.
  IMPRESSION_FLOOR: 50,

  // Lookback window, in days, ending LAG_DAYS ago.
  DAYS: 180,

  // Days excluded from the end of the window so conversions have time to
  // land. Set this to roughly the account's conversion lag.
  LAG_DAYS: 7,

  // Which campaigns' performance decides the labels. Case-insensitive
  // regular expressions; plain text works too. Empty include = whole
  // account. Exclude wins.
  //   one account, two markets:  SOURCE_CAMPAIGN_INCLUDE: ['\\bAU\\b']
  //   separate accounts:         leave both empty, run in each account
  SOURCE_CAMPAIGN_INCLUDE: [],
  SOURCE_CAMPAIGN_EXCLUDE: [],

  // Shown in the sheet header so a printed tab says which market it came
  // from. Cosmetic only.
  SOURCE_LABEL: 'whole account',

  // The Merchant Center attribute the Labels tab is headed with. Pick one
  // that is not already in use in the feed.
  FEED_COLUMN: 'custom_label_2',

  // Google Ads API version passed to AdsApp.report. '' uses the runtime
  // default.
  API_VERSION: 'v25'
};

var TABS = {
  LABELS: 'Labels',
  DETAIL: 'Item Detail',
  SUMMARY: 'Bucket Summary'
};
var TAB_ORDER = [TABS.SUMMARY, TABS.LABELS, TABS.DETAIL];

// Fixed bucket order: best to worst, then the two that carry no verdict.
var BUCKETS = ['over-index', 'index', 'near-index', 'under-index', 'no-index'];

var COLORS = {
  HEADER_BG: '#0D2952',
  HEADER_FG: '#FFFFFF',
  TITLE: '#0D2952',
  SUBTITLE: '#666666',
  BORDER: '#D9D9D9',
  BUCKET_BG: {
    'over-index': '#D9EAD3',
    'index': '#EAF3E6',
    'near-index': '#FFF2CC',
    'under-index': '#F4CCCC',
    'no-index': '#EFEFEF'
  }
};

var FMT = {
  INT: '#,##0',
  MONEY: '#,##0.00',
  RATIO: '0.00',
  PCT: '0.0%',
  TEXT: '@'
};

var RUN_LOG = [];

// ---------------------------------------------------------------------------
// ENTRY POINT
// ---------------------------------------------------------------------------
function main() {
  var account = AdsApp.currentAccount();
  var tz = account.getTimeZone();
  var currency = account.getCurrencyCode();

  var range = buildRange_(tz, CONFIG.DAYS, CONFIG.LAG_DAYS);
  Logger.log('Lookback ' + range.start + ' to ' + range.end + ' (' +
             CONFIG.DAYS + ' days, last ' + CONFIG.LAG_DAYS +
             ' excluded for conversion lag), timezone ' + tz +
             ', currency ' + currency);

  var gates = clickGates_();
  Logger.log('Breakeven ROAS ' + fix2_(CONFIG.BREAKEVEN_ROAS) +
             ', band +/-' + Math.round(CONFIG.BAND * 100) + '% (' +
             fix2_(overBar_()) + ' / ' + fix2_(nearBar_()) + '), click gates ' +
             gates.index + ' and ' + gates.over + ' at ' +
             CONFIG.AVERAGE_CVR_PCT + '% CVR');

  var query = buildQuery_(range);
  Logger.log('GAQL:\n' + query);

  var data;
  try {
    data = fetchItems_(query);
  } catch (e) {
    Logger.log('FATAL: report query failed: ' + e);
    throw e;
  }
  Logger.log(data.itemCount + ' items from ' + data.rowCount + ' rows' +
             (data.filteredRows ? ' (' + data.filteredRows +
              ' rows skipped by the campaign filter)' : ''));

  var items = [];
  Object.keys(data.items).forEach(function(id) {
    var it = data.items[id];
    try {
      it.r = ratios_(it);
      it.bucket = bucketFor_(it, it.r, gates);
      items.push(it);
    } catch (e) {
      logProblem_('Item "' + id + '" skipped: ' + e);
    }
  });

  // Biggest spender first, regardless of bucket. Sorting by bucket would put
  // hundreds of zero-cost zombies at the top of the sheet; sorting by cost
  // puts the decisions there instead, and the zombies fall to the bottom on
  // their own.
  items.sort(function(a, b) {
    if (b.cost !== a.cost) return b.cost - a.cost;
    return b.value - a.value;
  });

  var summary = summarise_(items);
  sanityCheck_(summary, items.length);

  var ss = openOrCreateSpreadsheet_(account.getName());
  var meta = {
    account: account.getName(), currency: currency, range: range,
    generated: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm') + ' ' + tz,
    apiVersion: data.apiVersion, gates: gates
  };
  safeTab_(ss, TABS.SUMMARY, function() { writeSummaryTab_(ss, summary, items, meta); });
  safeTab_(ss, TABS.LABELS, function() { writeLabelsTab_(ss, items, meta); });
  safeTab_(ss, TABS.DETAIL, function() { writeDetailTab_(ss, items, meta); });
  orderTabs_(ss);

  if (RUN_LOG.length) {
    Logger.log('Run finished with ' + RUN_LOG.length + ' problem(s):\n - ' +
               RUN_LOG.join('\n - '));
  } else {
    Logger.log('Run finished cleanly.');
  }
  Logger.log('Sheet: ' + ss.getUrl());
}

// ---------------------------------------------------------------------------
// THRESHOLDS
// ---------------------------------------------------------------------------
function overBar_() { return CONFIG.BREAKEVEN_ROAS * (1 + CONFIG.BAND); }
function nearBar_() { return CONFIG.BREAKEVEN_ROAS * (1 - CONFIG.BAND); }

// Clicks needed before an item has had a fair chance to convert N times.
function clickGates_() {
  var perConversion = 100 / CONFIG.AVERAGE_CVR_PCT;
  return {
    index: Math.ceil(perConversion * CONFIG.CONVERSIONS_FOR_INDEX),
    over: Math.ceil(perConversion * CONFIG.CONVERSIONS_FOR_OVER_INDEX)
  };
}

// ---------------------------------------------------------------------------
// DATE RANGE — DAYS days ending LAG_DAYS ago, in the account's timezone.
// ---------------------------------------------------------------------------
function buildRange_(tz, days, lag) {
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var end = shiftDays_(today, -Math.max(1, lag));
  var start = shiftDays_(end, -(days - 1));
  return { start: start, end: end, days: days };
}

function shiftDays_(isoDate, delta) {
  var p = isoDate.split('-');
  var d = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1,
                            parseInt(p[2], 10)));
  d.setUTCDate(d.getUTCDate() + delta);
  var m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' +
         (day < 10 ? '0' : '') + day;
}

// ---------------------------------------------------------------------------
// DATA
// ---------------------------------------------------------------------------
function buildQuery_(range) {
  return 'SELECT segments.product_item_id, campaign.name, ' +
      'metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
      'metrics.conversions, metrics.conversions_value ' +
      'FROM shopping_performance_view ' +
      "WHERE segments.date BETWEEN '" + range.start + "' AND '" + range.end + "'";
}

function runReport_(query) {
  if (CONFIG.API_VERSION) {
    try {
      var it = AdsApp.report(query, { apiVersion: CONFIG.API_VERSION }).rows();
      it.hasNext(); // force validation now, not mid-parse
      return { rows: it, apiVersion: CONFIG.API_VERSION };
    } catch (e) {
      logProblem_('apiVersion ' + CONFIG.API_VERSION + ' rejected, retrying ' +
                  'on the Scripts default version: ' + e);
    }
  }
  return { rows: AdsApp.report(query).rows(), apiVersion: 'runtime default' };
}

function fetchItems_(query) {
  var run = runReport_(query);
  var rows = run.rows;
  var items = {};
  var rowCount = 0, filteredRows = 0, itemCount = 0;
  var include = compile_(CONFIG.SOURCE_CAMPAIGN_INCLUDE);
  var exclude = compile_(CONFIG.SOURCE_CAMPAIGN_EXCLUDE);

  while (rows.hasNext()) {
    var row;
    try {
      row = rows.next();
    } catch (e) {
      logProblem_('Row read failed, stopping early: ' + e);
      break;
    }
    rowCount++;
    try {
      var campaign = row['campaign.name'] || '';
      if (!nameMatches_(campaign, include, exclude)) { filteredRows++; continue; }

      // The API lower-cases item IDs. Key on that and keep it consistent all
      // the way to the feed, or the join drops rows.
      var id = String(row['segments.product_item_id'] || '').toLowerCase();
      if (!id) { filteredRows++; continue; }

      var it = items[id];
      if (!it) {
        it = items[id] = { id: id, impressions: 0, clicks: 0, cost: 0,
                           conversions: 0, value: 0, campaigns: {} };
        itemCount++;
      }
      it.impressions += num_(row['metrics.impressions']);
      it.clicks += num_(row['metrics.clicks']);
      it.cost += micros_(row['metrics.cost_micros']);
      it.conversions += num_(row['metrics.conversions']);
      it.value += num_(row['metrics.conversions_value']);
      it.campaigns[campaign] = true;
    } catch (e) {
      logProblem_('Row ' + rowCount + ' skipped: ' + e);
    }
  }
  return { items: items, rowCount: rowCount, itemCount: itemCount,
           filteredRows: filteredRows, apiVersion: run.apiVersion };
}

// ---------------------------------------------------------------------------
// BUCKETS
// ---------------------------------------------------------------------------
function ratios_(m) {
  var out = {};
  // value / 0 is Infinity, not NaN, so zero cost is caught here rather than
  // sailing through a later isNaN check as a spectacular performer.
  out.roas = m.cost > 0 ? m.value / m.cost : null;
  out.cpc = m.clicks > 0 ? m.cost / m.clicks : null;
  out.cvr = m.clicks > 0 ? m.conversions / m.clicks : null;
  out.aov = m.conversions > 0 ? m.value / m.conversions : null;
  return out;
}

// Order matters. The impression floor is tested first so a handful of
// impressions with one lucky sale cannot buy a performance label.
function bucketFor_(m, x, gates) {
  if (m.impressions < CONFIG.IMPRESSION_FLOOR) return 'no-index';
  if (m.cost <= 0) return 'no-index';
  if (m.clicks >= gates.over && x.roas >= overBar_()) return 'over-index';
  if (m.clicks >= gates.index && x.roas >= CONFIG.BREAKEVEN_ROAS) return 'index';
  if (x.roas >= nearBar_()) return 'near-index';
  return 'under-index';
}

function summarise_(items) {
  var by = {};
  BUCKETS.forEach(function(b) {
    by[b] = { bucket: b, items: 0, impressions: 0, clicks: 0, cost: 0,
              conversions: 0, value: 0 };
  });
  var totals = { bucket: 'TOTAL', items: 0, impressions: 0, clicks: 0, cost: 0,
                 conversions: 0, value: 0 };
  items.forEach(function(m) {
    [by[m.bucket], totals].forEach(function(t) {
      t.items++;
      t.impressions += m.impressions;
      t.clicks += m.clicks;
      t.cost += m.cost;
      t.conversions += m.conversions;
      t.value += m.value;
    });
  });
  return { by: by, totals: totals };
}

// A healthy split has real spend in more than one bucket. When it does not,
// the breakeven is almost certainly wrong, and saying so beats handing over a
// sheet that is all one colour.
function sanityCheck_(summary, itemTotal) {
  if (!itemTotal) {
    logProblem_('No items returned. Check the campaign filter and that ' +
                'Shopping or PMax campaigns ran in the window.');
    return;
  }
  var cost = summary.totals.cost;
  if (cost <= 0) return;
  BUCKETS.forEach(function(b) {
    var share = summary.by[b].cost / cost;
    if (share > 0.9) {
      logProblem_(Math.round(share * 100) + '% of spend landed in a single ' +
                  'bucket (' + b + '). BREAKEVEN_ROAS is ' +
                  fix2_(CONFIG.BREAKEVEN_ROAS) + ' — check it is 1 / gross ' +
                  'margin and not a ROAS target.');
    }
  });
  var priced = summary.totals.value / cost;
  Logger.log('Account ROAS over the window: ' + fix2_(priced) +
             ' against a breakeven of ' + fix2_(CONFIG.BREAKEVEN_ROAS) + '.');
}

// ---------------------------------------------------------------------------
// SHEET OUTPUT
// ---------------------------------------------------------------------------

// The upload tab: two columns, headed exactly as Merchant Center expects, so
// it can go straight into a supplemental feed.
function writeLabelsTab_(ss, items, meta) {
  var cols = [['id', FMT.TEXT], [CONFIG.FEED_COLUMN, FMT.TEXT]];
  var rows = items.map(function(m) { return [m.id, m.bucket]; });
  writeTable_(ss, TABS.LABELS, meta,
      'Paste columns A and B into a Merchant Center supplemental feed. IDs ' +
      'are lower-cased, as the API returns them — match case-insensitively ' +
      'against the primary feed. Nothing in the account or the feed changes ' +
      'until you upload this yourself.',
      cols, rows, {});
}

function writeDetailTab_(ss, items, meta) {
  var cur = meta.currency;
  var cols = [
    ['Item ID', FMT.TEXT], ['Bucket', FMT.TEXT],
    ['Impressions', FMT.INT], ['Clicks', FMT.INT],
    ['Cost (' + cur + ')', FMT.MONEY], ['Conversions', FMT.RATIO],
    ['Conv. value (' + cur + ')', FMT.MONEY], ['ROAS', FMT.RATIO],
    ['CPC (' + cur + ')', FMT.MONEY], ['CVR', FMT.PCT],
    ['AOV (' + cur + ')', FMT.MONEY], ['Campaigns', FMT.INT]
  ];
  var rows = items.map(function(m) {
    var x = m.r;
    return [m.id, m.bucket, m.impressions, m.clicks, r2_(m.cost),
            r2_(m.conversions), r2_(m.value), r2_(x.roas), r2_(x.cpc),
            r4_(x.cvr), r2_(x.aov), Object.keys(m.campaigns).length];
  });
  writeTable_(ss, TABS.DETAIL, meta,
      'One row per product item ID, biggest spender first. ROAS is blank ' +
      'where the item had no cost. The zero-cost long tail sits at the bottom.',
      cols, rows, { bucketCol: 2 });
}

function writeSummaryTab_(ss, summary, items, meta) {
  var cur = meta.currency;
  var cols = [
    ['Bucket', FMT.TEXT], ['Items', FMT.INT], ['Share of items', FMT.PCT],
    ['Impressions', FMT.INT], ['Clicks', FMT.INT],
    ['Cost (' + cur + ')', FMT.MONEY], ['Share of cost', FMT.PCT],
    ['Conversions', FMT.RATIO], ['Conv. value (' + cur + ')', FMT.MONEY],
    ['Share of value', FMT.PCT], ['ROAS', FMT.RATIO],
    ['What it means', FMT.TEXT]
  ];
  var meaning = {
    'over-index': 'Proven winners. Own campaign or ad group, highest priority, ' +
                  'most budget.',
    'index': 'Profitable with enough data to believe it. Standard tier.',
    'near-index': 'Around breakeven or short of data. Give them room to prove ' +
                  'themselves, watch them.',
    'under-index': 'Spending above breakeven-adjusted ROAS. Cap, restructure ' +
                   'or exclude.',
    'no-index': 'Below the impression floor or no spend. Nothing to judge yet — ' +
                'a catch-all campaign gives them a chance to earn a label.'
  };
  var T = summary.totals;
  var rows = BUCKETS.map(function(b) {
    var s = summary.by[b];
    return [
      b, s.items, T.items ? s.items / T.items : '',
      s.impressions, s.clicks, r2_(s.cost), T.cost ? s.cost / T.cost : '',
      r2_(s.conversions), r2_(s.value), T.value ? s.value / T.value : '',
      s.cost > 0 ? r2_(s.value / s.cost) : '',
      meaning[b]
    ];
  });
  rows.push(['TOTAL', T.items, 1, T.impressions, T.clicks, r2_(T.cost), 1,
             r2_(T.conversions), r2_(T.value), 1,
             T.cost > 0 ? r2_(T.value / T.cost) : '', '']);

  var sh = writeTable_(ss, TABS.SUMMARY, meta,
      'Source: ' + CONFIG.SOURCE_LABEL + '. Breakeven ROAS ' +
      fix2_(CONFIG.BREAKEVEN_ROAS) + ' (over-index needs ' + fix2_(overBar_()) +
      ', near-index reaches down to ' + fix2_(nearBar_()) + '). Click gates: ' +
      meta.gates.index + ' for index, ' + meta.gates.over + ' for over-index, ' +
      'at ' + CONFIG.AVERAGE_CVR_PCT + '% CVR. Impression floor ' +
      CONFIG.IMPRESSION_FLOOR + '. Read the share-of-cost column first: that ' +
      'is the money this split is asking you to move.',
      cols, rows, { bucketCol: 1 });

  var at = sh.getLastRow() + 2;
  var lines = RUN_LOG.length ? RUN_LOG.slice() : ['No problems logged this run.'];
  var block = [['Run log (' + meta.generated + ')']].concat(
      lines.map(function(l) { return [l]; }));
  sh.getRange(at, 1, block.length, 1).setValues(block);
  sh.getRange(at, 1).setFontWeight('bold').setFontColor(COLORS.TITLE);
  if (RUN_LOG.length) {
    sh.getRange(at + 1, 1, RUN_LOG.length, 1).setFontColor('#B00020');
  }
}

// Shared tab writer: title, subtitle, header band, one batched setValues, one
// batched setNumberFormats, bucket colouring, freeze, widths.
function writeTable_(ss, name, meta, subtitle, cols, rows, opts) {
  var sh = resetSheet_(ss, name);
  var headerRow = 4, dataRow = 5;
  var nCols = cols.length;

  sh.getRange(1, 1).setValue(name + ' - ' + meta.account)
      .setFontColor(COLORS.TITLE).setFontWeight('bold').setFontSize(12);
  sh.getRange(2, 1).setValue(
      meta.range.days + ' days ' + meta.range.start + ' to ' + meta.range.end +
      ' | ' + meta.currency + ' | Google Ads API ' + meta.apiVersion +
      ' | generated ' + meta.generated)
      .setFontColor(COLORS.SUBTITLE).setFontSize(9);
  sh.getRange(3, 1).setValue(subtitle).setFontColor(COLORS.SUBTITLE).setFontSize(9);

  sh.getRange(headerRow, 1, 1, nCols)
      .setValues([cols.map(function(c) { return c[0]; })])
      .setBackground(COLORS.HEADER_BG).setFontColor(COLORS.HEADER_FG)
      .setFontWeight('bold').setWrap(true).setVerticalAlignment('middle');

  if (rows.length) {
    var range = sh.getRange(dataRow, 1, rows.length, nCols);
    range.setValues(rows);
    var fmtRow = cols.map(function(c) { return c[1]; });
    var fmts = [];
    for (var i = 0; i < rows.length; i++) fmts.push(fmtRow);
    range.setNumberFormats(fmts);
    range.setBorder(true, true, true, true, true, true, COLORS.BORDER,
                    SpreadsheetApp.BorderStyle.SOLID);

    if (opts.bucketCol) {
      var bgs = rows.map(function(r) {
        var bg = COLORS.BUCKET_BG[r[opts.bucketCol - 1]] || null;
        var line = [];
        for (var j = 0; j < nCols; j++) line.push(bg);
        return line;
      });
      range.setBackgrounds(bgs);
    }
  } else {
    sh.getRange(dataRow, 1).setValue('No items in range.');
  }

  sh.setFrozenRows(headerRow);
  sh.setColumnWidths(1, nCols, 110);
  for (var k = 0; k < nCols; k++) {
    if (cols[k][0] === 'Item ID' || cols[k][0] === 'id') sh.setColumnWidth(k + 1, 220);
    if (cols[k][0] === 'What it means') sh.setColumnWidth(k + 1, 420);
  }
  sh.setHiddenGridlines(true);
  return sh;
}

function safeTab_(ss, name, fn) {
  try {
    fn();
  } catch (e) {
    logProblem_('Tab "' + name + '" failed: ' + e);
  }
}

function openOrCreateSpreadsheet_(accountName) {
  if (CONFIG.SPREADSHEET_URL) {
    return SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
  }
  var ss = SpreadsheetApp.create('Shopping product labels - ' + accountName);
  Logger.log('Created new spreadsheet (paste into CONFIG.SPREADSHEET_URL): ' +
             ss.getUrl());
  return ss;
}

function resetSheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
  } else {
    sh.clear();
    sh.clearConditionalFormatRules();
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
  var d = ss.getSheetByName('Sheet1');
  if (d && d.getLastRow() === 0 && ss.getSheets().length > TAB_ORDER.length) {
    ss.deleteSheet(d);
  }
  var first = ss.getSheetByName(TAB_ORDER[0]);
  if (first) ss.setActiveSheet(first);
}

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------
function compile_(patterns) {
  var out = [];
  (patterns || []).forEach(function(p) {
    try {
      out.push(new RegExp(p, 'i'));
    } catch (e) {
      logProblem_('Ignoring bad campaign pattern "' + p + '": ' + e);
    }
  });
  return out;
}

function nameMatches_(name, include, exclude) {
  for (var i = 0; i < exclude.length; i++) {
    if (exclude[i].test(name)) return false;
  }
  if (!include.length) return true;
  for (var j = 0; j < include.length; j++) {
    if (include[j].test(name)) return true;
  }
  return false;
}

// Report values arrive as strings and can carry thousands separators. Strip
// every separator, not just the first one.
function num_(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v).replace(/,/g, '').replace(/%/g, ''));
  return isNaN(n) ? 0 : n;
}

function micros_(v) {
  return num_(v) / 1000000;
}

function r2_(v) {
  return (v === null || v === undefined || !isFinite(v)) ? '' : Math.round(v * 100) / 100;
}

function r4_(v) {
  return (v === null || v === undefined || !isFinite(v)) ? '' : Math.round(v * 10000) / 10000;
}

function fix2_(v) {
  return (v === null || v === undefined || !isFinite(v)) ? 'n/a' : Number(v).toFixed(2);
}

function logProblem_(msg) {
  RUN_LOG.push(msg);
  Logger.log('PROBLEM: ' + msg);
}

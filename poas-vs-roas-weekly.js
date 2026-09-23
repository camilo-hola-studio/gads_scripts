/**
 * WEEKLY POAS vs ROAS — campaign profitability report.
 *
 * READ-ONLY: this script makes NO changes to the Google Ads account. It only
 * reads reporting data (one AdsApp.report query) and writes the results to a
 * Google Sheet in your own Drive, plus an optional email summary (off by
 * default). No bids, budgets, targets, statuses or structures are touched.
 *
 * WHY: ROAS (conv. value / cost) treats every dollar of revenue the same, but
 * product margin differs by campaign. POAS (gross profit / cost) shows what
 * each campaign actually earns. This report puts the two side by side, per
 * campaign, per complete week, so campaigns that look fine on ROAS but are
 * thin on profit stand out.
 *
 * WHERE THE PROFIT NUMBERS COME FROM: "conversions with cart data". When cart
 * data is reported for a purchase conversion and the Merchant Center feed
 * carries cost_of_goods_sold, Google Ads exposes revenue, gross profit, COGS,
 * orders and average order value as campaign-level metrics. Not every
 * campaign carries cart data, so every row also states how much of its
 * conversion value has cart data behind it ("profit coverage"), and rows
 * with conversion value but no gross profit print a BLANK reported POAS
 * plus a clearly separate estimated POAS built from CONFIG.FALLBACK_MARGIN.
 *
 * API: targets Google Ads API v25 (current major version at time of
 * writing, released 22 Jul 2026) via the apiVersion option on
 * AdsApp.report. If the Scripts runtime rejects that version the query is
 * retried on the runtime's default version and the fallback is logged.
 * Fields used (verified against the v25 reporting reference):
 *   resource  campaign
 *   segments  segments.week (Mon–Sun, keyed by the Monday date), segments.date
 *   metrics   impressions, clicks, cost_micros, conversions, conversions_value,
 *             gross_profit_micros, cost_of_goods_sold_micros, revenue_micros,
 *             orders, average_order_value_micros
 *
 * CHARTS: the Charts tab holds a small chronological data block (week, ROAS,
 * reported POAS, estimated POAS, conversion value, conversions) and three
 * embedded line charts built from it. Conversion value and conversions get a
 * chart each rather than sharing one frame with two y-axes: a second axis can
 * be scaled to make any two lines appear to agree, so it is never used here.
 * Charts are removed and rebuilt each run — sheet.clear() leaves them behind.
 *
 * WEEK BUCKETING: segments.week (server-side, Monday–Sunday) rather than
 * pulling segments.date and bucketing in-script. The date range is aligned
 * to a Monday start and a Sunday end in the account's timezone, so every
 * bucket is a full week, the current partial week is excluded, and the
 * report returns ~N rows per campaign instead of ~7N. The only thing
 * segments.date bucketing would buy is a non-Monday week start.
 *
 * INSTALL: Google Ads > Tools > Bulk actions > Scripts > new script, paste
 * this file, set CONFIG.SPREADSHEET_URL, authorise, preview, run. Schedule
 * weekly (Monday morning, after the previous week has closed).
 *
 * MCC: this file runs against a single account. For a manager account you
 * would (1) wrap the body of main() in a function run per child account via
 * MccApp.accounts().withIds([...]).executeInParallel('processAccount',
 * 'finish') or a plain iterator loop, (2) either give each account its own
 * spreadsheet (keyed by customer ID) or add an "Account" column to every tab
 * and write all accounts into one sheet from the finish() callback, and
 * (3) send the email once from finish() rather than once per account.
 * Nothing in the query changes — it is already scoped to the current account.
 */

// ---------------------------------------------------------------------------
// CONFIG — the only block you should need to touch.
// ---------------------------------------------------------------------------
var CONFIG = {
  // Full URL of the Google Sheet to write to. Leave '' to have the script
  // create a new sheet and log its URL (paste that back here afterwards).
  SPREADSHEET_URL: '',

  // Number of COMPLETE weeks (Mon–Sun) to report, ending last Sunday. The
  // current partial week is never included.
  WEEKS: 13,

  // Gross margin assumed for conversion value that has NO cart data behind
  // it. Only used for the "Est. POAS" column, never for reported POAS.
  FALLBACK_MARGIN: 0.58,

  // Flag a campaign-week when its POAS is below this.
  POAS_THRESHOLD: 3.0,

  // Flag when margin moves more than this many percentage points vs the
  // previous week (both weeks need reported cart data).
  MARGIN_MOVE_PTS: 5,

  // Flag when less than this share of conversion value has cart data.
  COVERAGE_THRESHOLD: 0.5,

  // Campaign name filters. Case-insensitive regular expressions (plain text
  // works too). Empty include list = every campaign. Exclude wins.
  //   e.g. CAMPAIGN_INCLUDE: ['brand', '^AU - '],  CAMPAIGN_EXCLUDE: ['test']
  CAMPAIGN_INCLUDE: [],
  CAMPAIGN_EXCLUDE: [],

  // Optional email listing only the flagged campaigns (latest week). Off by
  // default. Nothing is sent when no campaign is flagged.
  EMAIL_ENABLED: false,
  EMAIL_RECIPIENTS: [],        // e.g. ['you@example.com']

  // Google Ads API version passed to AdsApp.report. Set '' to use the
  // Scripts runtime default.
  API_VERSION: 'v25'
};

var TABS = {
  DETAIL: 'Weekly Detail',
  SUMMARY: 'Campaign Summary',
  ACCOUNT: 'Account Weekly',
  CHARTS: 'Charts'
};
var TAB_ORDER = [TABS.SUMMARY, TABS.CHARTS, TABS.DETAIL, TABS.ACCOUNT];

var COLORS = {
  HEADER_BG: '#0D2952',
  HEADER_FG: '#FFFFFF',
  TITLE: '#0D2952',
  SUBTITLE: '#666666',
  FLAG_BG: '#FCE8B2',   // rows with any Notes
  NOCART_BG: '#EFEFEF', // rows with conv. value but no cart data
  BORDER: '#D9D9D9',
  // Chart series. Three hues that stay distinguishable under the common forms
  // of colour blindness (checked as a set, not picked by eye).
  SERIES_1: '#2A78D6',  // ROAS        (blue)
  SERIES_2: '#EB6834',  // POAS repd.  (orange)
  SERIES_3: '#1BAF7A',  // POAS est.   (aqua)
  GRID: '#E6E6E6'
};

// Number-format tokens used per column. Two decimals on money and ratios.
var FMT = {
  INT: '#,##0',
  MONEY: '#,##0.00',
  RATIO: '0.00',
  PCT: '0.0%',
  TEXT: '@'
};

// Everything that went wrong this run, surfaced in the log and on the sheet.
var RUN_LOG = [];

// ---------------------------------------------------------------------------
// ENTRY POINT
// ---------------------------------------------------------------------------
function main() {
  var account = AdsApp.currentAccount();
  var tz = account.getTimeZone();
  var currency = account.getCurrencyCode();
  var accountName = account.getName();

  var range = buildWeekRange_(tz, CONFIG.WEEKS);
  Logger.log('Reporting ' + CONFIG.WEEKS + ' complete weeks: ' + range.start +
             ' (Mon) to ' + range.end + ' (Sun), timezone ' + tz +
             ', currency ' + currency);

  var query = buildQuery_(range);
  Logger.log('GAQL:\n' + query);

  // ---- Pull. A failure here is fatal (no data = nothing to write), and is
  // logged verbatim together with the query so it can be reproduced in the
  // query builder.
  var data;
  try {
    data = fetchWeeklyRows_(query);
  } catch (e) {
    Logger.log('FATAL: report query failed: ' + e);
    throw e;
  }
  Logger.log(data.rowCount + ' campaign-week rows for ' +
             Object.keys(data.campaigns).length + ' campaigns' +
             (data.filteredOut ? ' (' + data.filteredOut +
              ' campaigns excluded by name filter)' : ''));

  // ---- Derive per-row ratios and flags. One bad campaign is logged and
  // dropped; it cannot kill the run.
  var campaigns = [];
  Object.keys(data.campaigns).forEach(function(id) {
    var c = data.campaigns[id];
    try {
      deriveCampaign_(c, range.weeks);
      campaigns.push(c);
    } catch (e) {
      logProblem_('Campaign "' + c.name + '" (' + id + ') skipped: ' + e);
    }
  });
  campaigns.sort(function(a, b) { return b.totals.cost - a.totals.cost; });

  var accountWeeks = buildAccountWeeks_(campaigns, range.weeks);

  // ---- Write. Each tab is independent: a failure on one is logged and the
  // others still get written.
  var ss = openOrCreateSpreadsheet_(accountName, range);
  var meta = {
    account: accountName, currency: currency, range: range,
    generated: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm') + ' ' + tz,
    apiVersion: data.apiVersion
  };
  safeTab_(ss, TABS.DETAIL, function() { writeDetailTab_(ss, campaigns, meta); });
  safeTab_(ss, TABS.SUMMARY, function() { writeSummaryTab_(ss, campaigns, meta); });
  safeTab_(ss, TABS.ACCOUNT, function() { writeAccountTab_(ss, accountWeeks, meta); });
  safeTab_(ss, TABS.CHARTS, function() { writeChartsTab_(ss, accountWeeks, meta); });
  orderTabs_(ss);

  // ---- Optional email, only for flagged campaigns.
  if (CONFIG.EMAIL_ENABLED) {
    try {
      sendEmail_(campaigns, meta, ss.getUrl());
    } catch (e) {
      logProblem_('Email failed: ' + e);
    }
  }

  if (RUN_LOG.length) {
    Logger.log('Run finished with ' + RUN_LOG.length + ' problem(s):\n - ' +
               RUN_LOG.join('\n - '));
  } else {
    Logger.log('Run finished cleanly.');
  }
  Logger.log('Sheet: ' + ss.getUrl());
}

// ---------------------------------------------------------------------------
// DATE RANGE — last N complete Mon–Sun weeks in the account's timezone.
// ---------------------------------------------------------------------------
function buildWeekRange_(tz, weeks) {
  var now = new Date();
  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var dow = parseInt(Utilities.formatDate(now, tz, 'u'), 10); // 1=Mon..7=Sun

  // Last complete week ends on the most recent Sunday strictly before today.
  // On a Sunday the current week is still open, so step back a full week.
  var end = shiftDays_(today, dow === 7 ? -7 : -dow);
  var start = shiftDays_(end, -(7 * weeks) + 1);

  var mondays = [];
  for (var i = 0; i < weeks; i++) mondays.push(shiftDays_(start, 7 * i));

  return { start: start, end: end, weeks: mondays, today: today };
}

function shiftDays_(isoDate, days) {
  var p = isoDate.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + days);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

// ---------------------------------------------------------------------------
// DATA PULL
// ---------------------------------------------------------------------------
function buildQuery_(range) {
  return 'SELECT campaign.id, campaign.name, campaign.status, ' +
    'campaign.advertising_channel_type, segments.week, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions, metrics.conversions_value, ' +
    'metrics.gross_profit_micros, metrics.cost_of_goods_sold_micros, ' +
    'metrics.revenue_micros, metrics.orders, metrics.average_order_value_micros ' +
    'FROM campaign ' +
    "WHERE campaign.status != 'REMOVED' " +
    'AND metrics.impressions > 0 ' +
    "AND segments.date BETWEEN '" + range.start + "' AND '" + range.end + "'";
}

// Runs the query on CONFIG.API_VERSION, falling back to the runtime default
// if that version is rejected. Returns { rows, apiVersion }.
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

function fetchWeeklyRows_(query) {
  var rep = runReport_(query);
  var campaigns = {};
  var rowCount = 0;
  var filteredOut = {};
  var filter = compileNameFilter_();

  while (rep.rows.hasNext()) {
    var r = rep.rows.next();
    try {
      var id = String(r['campaign.id']);
      var name = String(r['campaign.name']);
      if (!filter(name)) { filteredOut[id] = true; continue; }

      var c = campaigns[id];
      if (!c) {
        c = campaigns[id] = {
          id: id,
          name: name,
          status: String(r['campaign.status'] || ''),
          type: prettyType_(r['campaign.advertising_channel_type']),
          weeks: {}
        };
      }
      var week = String(r['segments.week']);
      var m = {
        week: week,
        impressions: num_(r['metrics.impressions']),
        clicks: num_(r['metrics.clicks']),
        cost: micros_(r['metrics.cost_micros']),
        conversions: num_(r['metrics.conversions']),
        value: num_(r['metrics.conversions_value']),
        grossProfit: micros_(r['metrics.gross_profit_micros']),
        cogs: micros_(r['metrics.cost_of_goods_sold_micros']),
        revenue: micros_(r['metrics.revenue_micros']),
        orders: num_(r['metrics.orders']),
        aov: micros_(r['metrics.average_order_value_micros'])
      };
      // The report is already one row per campaign per week; guard anyway
      // so a duplicate could never double-count.
      if (c.weeks[week]) {
        addInto_(c.weeks[week], m);
      } else {
        c.weeks[week] = m;
      }
      rowCount++;
    } catch (e) {
      logProblem_('Row skipped: ' + e);
    }
  }
  return {
    campaigns: campaigns,
    rowCount: rowCount,
    filteredOut: Object.keys(filteredOut).length,
    apiVersion: rep.apiVersion
  };
}

function compileNameFilter_() {
  function compile(list) {
    return (list || []).map(function(p) { return new RegExp(p, 'i'); });
  }
  var inc = compile(CONFIG.CAMPAIGN_INCLUDE);
  var exc = compile(CONFIG.CAMPAIGN_EXCLUDE);
  return function(name) {
    for (var i = 0; i < exc.length; i++) if (exc[i].test(name)) return false;
    if (!inc.length) return true;
    for (var j = 0; j < inc.length; j++) if (inc[j].test(name)) return true;
    return false;
  };
}

// ---------------------------------------------------------------------------
// DERIVED FIELDS
// ---------------------------------------------------------------------------
var SUM_KEYS = ['impressions', 'clicks', 'cost', 'conversions', 'value',
                'grossProfit', 'cogs', 'revenue', 'orders'];

function addInto_(target, m) {
  SUM_KEYS.forEach(function(k) { target[k] += m[k]; });
  // AOV is a ratio, recompute from the sums.
  target.aov = target.orders > 0 ? target.revenue / target.orders : 0;
}

function emptyMetrics_(week) {
  var m = { week: week, aov: 0 };
  SUM_KEYS.forEach(function(k) { m[k] = 0; });
  return m;
}

// Cart data is "present" when any cart-only metric is non-zero.
function hasCartData_(m) {
  return m.revenue > 0 || m.orders > 0 || m.grossProfit !== 0 || m.cogs > 0;
}

// Ratios for one metrics bucket. null = not computable, rendered blank.
function ratios_(m) {
  var out = {};
  var cart = hasCartData_(m);
  out.hasCart = cart;
  out.roas = m.cost > 0 ? m.value / m.cost : null;

  // Reported POAS: blank when there is conversion value but no cart data
  // (never 0 — that would read as "unprofitable"). A genuine zero (spend,
  // no conversions at all) is still 0.
  if (cart) {
    out.poas = m.cost > 0 ? m.grossProfit / m.cost : null;
    out.margin = m.value > 0 ? m.grossProfit / m.value : null;
    // Margin on the orders that actually carry cart data - the true product
    // margin, and the number to calibrate CONFIG.FALLBACK_MARGIN against.
    out.cartMargin = m.revenue > 0 ? m.grossProfit / m.revenue : null;
  } else {
    out.poas = (m.value > 0 || m.cost === 0) ? null : 0;
    out.margin = null;
    out.cartMargin = null;
  }

  // Share of conversion value that has cart data behind it. Cart revenue can
  // exceed conversion value (different attribution/de-duplication paths),
  // so cap at 100%.
  out.coverage = m.value > 0 ? Math.min(1, m.revenue / m.value) : null;

  // Estimated POAS: reported gross profit for the covered part of
  // conversion value, plus FALLBACK_MARGIN on the uncovered remainder.
  // For a row with no cart data at all this is value * margin / cost.
  if (m.cost > 0) {
    var uncovered = Math.max(0, m.value - (cart ? m.revenue : 0));
    out.estPoas = ((cart ? m.grossProfit : 0) + uncovered * CONFIG.FALLBACK_MARGIN) / m.cost;
  } else {
    out.estPoas = null;
  }

  out.gap = (out.roas !== null && out.poas !== null) ? out.roas - out.poas : null;
  return out;
}

function deriveCampaign_(c, weeks) {
  c.rows = [];
  c.totals = emptyMetrics_('');
  c.cartTotals = emptyMetrics_(''); // sums over weeks WITH cart data only
  c.cartWeeks = 0;
  c.valueWeeks = 0;

  var prev = null;
  weeks.forEach(function(w) {
    var m = c.weeks[w];
    if (!m) { prev = null; return; } // gap week: no WoW comparison across it
    var x = ratios_(m);
    m.r = x;
    m.notes = rowNotes_(m, x, prev);
    c.rows.push(m);
    addInto_(c.totals, m);
    if (x.hasCart) { addInto_(c.cartTotals, m); c.cartWeeks++; }
    if (m.value > 0) c.valueWeeks++;
    prev = m;
  });

  c.byWeek = {};
  c.rows.forEach(function(m) { c.byWeek[m.week] = m; });
}

function rowNotes_(m, x, prev) {
  var notes = [];
  if (m.value > 0 && !x.hasCart) {
    notes.push('No cart data - POAS estimated at ' +
               Math.round(CONFIG.FALLBACK_MARGIN * 100) + '% margin');
  }
  if (x.poas !== null) {
    if (x.poas < CONFIG.POAS_THRESHOLD) {
      notes.push('POAS ' + fix2_(x.poas) + ' below ' + fix2_(CONFIG.POAS_THRESHOLD));
    }
  } else if (x.estPoas !== null && m.value > 0 && x.estPoas < CONFIG.POAS_THRESHOLD) {
    notes.push('Est. POAS ' + fix2_(x.estPoas) + ' below ' + fix2_(CONFIG.POAS_THRESHOLD));
  }
  if (x.margin !== null && prev && prev.r && prev.r.margin !== null) {
    var movePts = (x.margin - prev.r.margin) * 100;
    if (Math.abs(movePts) > CONFIG.MARGIN_MOVE_PTS) {
      notes.push('Margin ' + (movePts > 0 ? '+' : '') + movePts.toFixed(1) +
                 ' pts WoW');
    }
  }
  if (x.hasCart && x.coverage !== null && x.coverage < CONFIG.COVERAGE_THRESHOLD) {
    notes.push('Profit coverage ' + Math.round(x.coverage * 100) + '% below ' +
               Math.round(CONFIG.COVERAGE_THRESHOLD * 100) + '%');
  }
  return notes;
}

function buildAccountWeeks_(campaigns, weeks) {
  var out = [];
  var prev = null;
  weeks.forEach(function(w) {
    var m = emptyMetrics_(w);
    var nCamp = 0, nCart = 0;
    campaigns.forEach(function(c) {
      var cm = c.byWeek[w];
      if (!cm) return;
      addInto_(m, cm);
      nCamp++;
      if (cm.r.hasCart) nCart++;
    });
    m.campaigns = nCamp;
    m.cartCampaigns = nCart;
    m.r = ratios_(m);
    m.notes = nCamp ? rowNotes_(m, m.r, prev) : [];
    out.push(m);
    prev = nCamp ? m : null;
  });
  return out;
}

// ---------------------------------------------------------------------------
// SHEET OUTPUT
// ---------------------------------------------------------------------------
function writeDetailTab_(ss, campaigns, meta) {
  var cur = meta.currency;
  var cols = [
    ['Week (Mon)', FMT.TEXT], ['Week end (Sun)', FMT.TEXT],
    ['Campaign', FMT.TEXT], ['Type', FMT.TEXT], ['Status', FMT.TEXT],
    ['Impressions', FMT.INT], ['Clicks', FMT.INT], ['Cost (' + cur + ')', FMT.MONEY],
    ['Conversions', FMT.RATIO], ['Conv. value (' + cur + ')', FMT.MONEY],
    ['Gross profit (' + cur + ')', FMT.MONEY], ['COGS (' + cur + ')', FMT.MONEY],
    ['Cart revenue (' + cur + ')', FMT.MONEY], ['Orders', FMT.INT],
    ['Avg order value (' + cur + ')', FMT.MONEY],
    ['ROAS', FMT.RATIO], ['POAS (reported)', FMT.RATIO], ['POAS (est.)', FMT.RATIO],
    ['Margin', FMT.PCT], ['Cart margin', FMT.PCT], ['Profit coverage', FMT.PCT],
    ['ROAS - POAS gap', FMT.RATIO],
    ['Cart data', FMT.TEXT], ['Notes', FMT.TEXT]
  ];
  var rows = [];
  campaigns.forEach(function(c) {
    c.rows.forEach(function(m) {
      var x = m.r;
      rows.push([
        m.week, shiftDays_(m.week, 6), c.name, c.type, c.status,
        m.impressions, m.clicks, r2_(m.cost), r2_(m.conversions), r2_(m.value),
        cartVal_(x, m.grossProfit), cartVal_(x, m.cogs), cartVal_(x, m.revenue),
        cartVal_(x, m.orders), cartVal_(x, m.aov),
        r2_(x.roas), r2_(x.poas), r2_(x.estPoas), r4_(x.margin), r4_(x.cartMargin),
        r4_(x.coverage), r2_(x.gap), x.hasCart ? 'Yes' : (m.value > 0 ? 'No' : ''),
        m.notes.join('; ')
      ]);
    });
  });
  // Newest week first, then campaigns by spend (already sorted).
  rows.sort(function(a, b) { return a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0; });

  writeTable_(ss, TABS.DETAIL, meta,
      'One row per campaign per complete week. POAS (reported) is blank ' +
      'where conversion value has no cart data; POAS (est.) applies ' +
      Math.round(CONFIG.FALLBACK_MARGIN * 100) + '% margin to uncovered value. ' +
      'Margin = gross profit / conv. value; Cart margin = gross profit / cart revenue.',
      cols, rows, { notesCol: cols.length, cartCol: cols.length - 1 });
}

function writeSummaryTab_(ss, campaigns, meta) {
  var cur = meta.currency;
  var weeks = meta.range.weeks;
  var latest = weeks[weeks.length - 1];
  var prior = weeks.length > 1 ? weeks[weeks.length - 2] : null;
  var avgLabel = weeks.length + 'wk avg';

  var cols = [
    ['Campaign', FMT.TEXT], ['Type', FMT.TEXT], ['Status', FMT.TEXT],
    ['Weeks with data', FMT.INT], ['Weeks with cart data', FMT.INT],
    ['Cost latest wk (' + cur + ')', FMT.MONEY], ['Cost ' + avgLabel + ' (' + cur + ')', FMT.MONEY],
    ['ROAS latest', FMT.RATIO], ['ROAS prior', FMT.RATIO], ['ROAS ' + avgLabel, FMT.RATIO],
    ['POAS latest', FMT.RATIO], ['POAS prior', FMT.RATIO], ['POAS ' + avgLabel, FMT.RATIO],
    ['Est. POAS latest', FMT.RATIO],
    ['Margin latest', FMT.PCT], ['Margin prior', FMT.PCT], ['Margin ' + avgLabel, FMT.PCT],
    ['Cart margin latest', FMT.PCT], ['Cart margin ' + avgLabel, FMT.PCT],
    ['Profit coverage ' + avgLabel, FMT.PCT],
    ['Cart data', FMT.TEXT], ['Notes (latest week)', FMT.TEXT]
  ];

  var rows = [];
  campaigns.forEach(function(c) {
    var L = c.byWeek[latest] ? c.byWeek[latest].r : null;
    var P = prior && c.byWeek[prior] ? c.byWeek[prior].r : null;
    var T = ratios_(c.totals);
    // Period POAS / margin come from weeks that actually carry cart data, so
    // a campaign with patchy cart data is not dragged toward zero.
    var CT = c.cartWeeks ? ratios_(c.cartTotals) : null;
    var cartLabel = c.cartWeeks === 0 ? (c.valueWeeks ? 'None' : '') :
                    (c.cartWeeks < c.valueWeeks ? 'Partial' : 'All weeks');
    var notes = c.byWeek[latest] ? c.byWeek[latest].notes.slice() : ['No data latest week'];
    rows.push([
      c.name, c.type, c.status, c.rows.length, c.cartWeeks,
      c.byWeek[latest] ? r2_(c.byWeek[latest].cost) : '',
      r2_(c.totals.cost / weeks.length),
      L ? r2_(L.roas) : '', P ? r2_(P.roas) : '', r2_(T.roas),
      L ? r2_(L.poas) : '', P ? r2_(P.poas) : '', CT ? r2_(CT.poas) : '',
      L ? r2_(L.estPoas) : '',
      L ? r4_(L.margin) : '', P ? r4_(P.margin) : '', CT ? r4_(CT.margin) : '',
      L ? r4_(L.cartMargin) : '', CT ? r4_(CT.cartMargin) : '',
      r4_(T.coverage),
      cartLabel, notes.join('; ')
    ]);
  });

  writeTable_(ss, TABS.SUMMARY, meta,
      'Latest week ' + latest + (prior ? ', prior week ' + prior : '') +
      '. Period ROAS is sum(value)/sum(cost) over all weeks; period POAS and ' +
      'margins use only the weeks that carry cart data. Cart margin = gross ' +
      'profit / cart revenue (use it to calibrate FALLBACK_MARGIN).',
      cols, rows, { notesCol: cols.length, cartCol: cols.length - 1 });
}

function writeAccountTab_(ss, accountWeeks, meta) {
  var cur = meta.currency;
  var cols = [
    ['Week (Mon)', FMT.TEXT], ['Week end (Sun)', FMT.TEXT],
    ['Campaigns', FMT.INT], ['Campaigns with cart data', FMT.INT],
    ['Impressions', FMT.INT], ['Clicks', FMT.INT], ['Cost (' + cur + ')', FMT.MONEY],
    ['Conversions', FMT.RATIO], ['Conv. value (' + cur + ')', FMT.MONEY],
    ['Gross profit (' + cur + ')', FMT.MONEY], ['COGS (' + cur + ')', FMT.MONEY],
    ['Cart revenue (' + cur + ')', FMT.MONEY], ['Orders', FMT.INT],
    ['Avg order value (' + cur + ')', FMT.MONEY],
    ['ROAS', FMT.RATIO], ['POAS (reported)', FMT.RATIO], ['POAS (est.)', FMT.RATIO],
    ['Margin', FMT.PCT], ['Cart margin', FMT.PCT], ['Profit coverage', FMT.PCT],
    ['ROAS - POAS gap', FMT.RATIO],
    ['Notes', FMT.TEXT]
  ];
  var rows = accountWeeks.slice().reverse().map(function(m) {
    var x = m.r;
    return [
      m.week, shiftDays_(m.week, 6), m.campaigns, m.cartCampaigns,
      m.impressions, m.clicks, r2_(m.cost), r2_(m.conversions), r2_(m.value),
      cartVal_(x, m.grossProfit), cartVal_(x, m.cogs), cartVal_(x, m.revenue),
      cartVal_(x, m.orders), cartVal_(x, m.aov),
      r2_(x.roas), r2_(x.poas), r2_(x.estPoas), r4_(x.margin), r4_(x.cartMargin),
      r4_(x.coverage), r2_(x.gap), m.notes.join('; ')
    ];
  });

  var sh = writeTable_(ss, TABS.ACCOUNT, meta,
      'Account totals per complete week (filtered campaigns only). ' +
      'Reported POAS here understates true profit when coverage is low.',
      cols, rows, { notesCol: cols.length });

  // Run log under the table so problems are visible without opening Logger.
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

function writeChartsTab_(ss, accountWeeks, meta) {
  var sh = resetSheet_(ss, TABS.CHARTS);

  // sh.clear() wipes values but leaves embedded charts behind, so a re-run
  // would stack a second copy of every chart on top of the first.
  var old = sh.getCharts();
  for (var i = 0; i < old.length; i++) sh.removeChart(old[i]);

  sh.getRange(1, 1).setValue(TABS.CHARTS + ' - ' + meta.account)
      .setFontColor(COLORS.TITLE).setFontWeight('bold').setFontSize(12);
  sh.getRange(2, 1).setValue(
      meta.range.weeks.length + ' complete weeks ' + meta.range.start + ' to ' +
      meta.range.end + ' | ' + meta.currency + ' | Google Ads API ' +
      meta.apiVersion + ' | generated ' + meta.generated)
      .setFontColor(COLORS.SUBTITLE).setFontSize(9);
  sh.getRange(3, 1).setValue(
      'Account totals per week, oldest first. Gaps in POAS (reported) are ' +
      'weeks with no cart data - the line breaks rather than dropping to ' +
      'zero. Revenue and conversions are drawn as two charts, not one with ' +
      'two axes: a second axis can be scaled to make any two lines agree.')
      .setFontColor(COLORS.SUBTITLE).setFontSize(9);

  var headerRow = 5, dataRow = 6;
  var cols = [
    ['Week (Mon)', FMT.TEXT], ['ROAS', FMT.RATIO],
    ['POAS (reported)', FMT.RATIO], ['POAS (est.)', FMT.RATIO],
    ['Conv. value (' + meta.currency + ')', FMT.MONEY],
    ['Conversions', FMT.RATIO]
  ];
  var rows = accountWeeks.map(function(m) {
    var x = m.r;
    return [m.week, r2_(x.roas), r2_(x.poas), r2_(x.estPoas), r2_(m.value),
            r2_(m.conversions)];
  });

  sh.getRange(headerRow, 1, 1, cols.length)
      .setValues([cols.map(function(c) { return c[0]; })])
      .setBackground(COLORS.HEADER_BG).setFontColor(COLORS.HEADER_FG)
      .setFontWeight('bold').setWrap(true);

  if (!rows.length) {
    sh.getRange(dataRow, 1).setValue('No data in range - no charts drawn.');
    sh.setColumnWidths(1, cols.length, 110);
    return;
  }

  var range = sh.getRange(dataRow, 1, rows.length, cols.length);
  range.setValues(rows);
  var fmtRow = cols.map(function(c) { return c[1]; });
  var fmts = [];
  for (var j = 0; j < rows.length; j++) fmts.push(fmtRow);
  range.setNumberFormats(fmts);
  range.setBorder(true, true, true, true, true, true, COLORS.BORDER,
                  SpreadsheetApp.BorderStyle.SOLID);
  sh.setColumnWidths(1, cols.length, 110);
  sh.setFrozenRows(headerRow);

  // Charts read the header row too, so the series pick up their names.
  var lastRow = dataRow + rows.length - 1;
  var weekCol = sh.getRange(headerRow, 1, rows.length + 1, 1);
  var common = {
    'backgroundColor': '#FFFFFF',
    'chartArea': { left: 70, top: 48, width: '76%', height: '70%' },
    'curveType': 'none',
    'lineWidth': 2,
    'pointSize': 5,
    'hAxis': { slantedText: true, slantedTextAngle: 45,
               textStyle: { fontSize: 9, color: COLORS.SUBTITLE } },
    'vAxis': { gridlines: { color: COLORS.GRID },
               textStyle: { fontSize: 9, color: COLORS.SUBTITLE } },
    'titleTextStyle': { color: COLORS.TITLE, fontSize: 13, bold: true }
  };

  chart_(sh, [sh.getRange(headerRow, 1, rows.length + 1, 4)], 5, 8, common, {
    'title': 'ROAS vs POAS by week',
    'colors': [COLORS.SERIES_1, COLORS.SERIES_2, COLORS.SERIES_3],
    'legend': { position: 'top', textStyle: { fontSize: 10 } },
    'vAxis': { title: 'Return per $ spent', minValue: 0,
               gridlines: { color: COLORS.GRID },
               textStyle: { fontSize: 9, color: COLORS.SUBTITLE } }
  });

  chart_(sh, [weekCol, sh.getRange(headerRow, 5, rows.length + 1, 1)], 24, 8,
      common, {
    'title': 'Conversion value by week (' + meta.currency + ')',
    'colors': [COLORS.SERIES_1],
    'legend': { position: 'none' },
    'vAxis': { title: meta.currency, minValue: 0,
               gridlines: { color: COLORS.GRID },
               textStyle: { fontSize: 9, color: COLORS.SUBTITLE } }
  });

  chart_(sh, [weekCol, sh.getRange(headerRow, 6, rows.length + 1, 1)], 43, 8,
      common, {
    'title': 'Conversions by week',
    'colors': [COLORS.SERIES_3],
    'legend': { position: 'none' },
    'vAxis': { title: 'Conversions', minValue: 0,
               gridlines: { color: COLORS.GRID },
               textStyle: { fontSize: 9, color: COLORS.SUBTITLE } }
  });

  Logger.log('Charts tab written (' + rows.length + ' weeks, last row ' +
             lastRow + ').');
}

// One line chart from one or more ranges. Each chart is built and inserted on
// its own so a single bad option cannot cost the whole tab.
function chart_(sh, ranges, row, col, common, options) {
  try {
    var b = sh.newChart().asLineChart();
    for (var i = 0; i < ranges.length; i++) b.addRange(ranges[i]);
    var k;
    for (k in common) if (!(k in options)) b.setOption(k, common[k]);
    for (k in options) b.setOption(k, options[k]);
    b.setPosition(row, col, 0, 0);
    sh.insertChart(b.build());
  } catch (e) {
    logProblem_('Chart "' + (options.title || '?') + '" failed: ' + e);
  }
}

// Shared tab writer: title, subtitle, header band, one batched setValues,
// one batched setNumberFormats, row highlighting, freeze, widths.
function writeTable_(ss, name, meta, subtitle, cols, rows, opts) {
  var sh = resetSheet_(ss, name);
  var headerRow = 4, dataRow = 5;
  var nCols = cols.length;

  sh.getRange(1, 1).setValue(name + ' - ' + meta.account)
      .setFontColor(COLORS.TITLE).setFontWeight('bold').setFontSize(12);
  sh.getRange(2, 1).setValue(
      meta.range.weeks.length + ' complete weeks ' + meta.range.start + ' to ' +
      meta.range.end + ' | ' + meta.currency + ' | Google Ads API ' +
      meta.apiVersion + ' | generated ' + meta.generated)
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

    // Row highlights: grey for "no cart data", amber for anything flagged.
    var bgs = rows.map(function(r) {
      var bg = null;
      if (opts.cartCol && r[opts.cartCol - 1] === 'No') bg = COLORS.NOCART_BG;
      if (opts.cartCol && r[opts.cartCol - 1] === 'None') bg = COLORS.NOCART_BG;
      if (opts.notesCol && r[opts.notesCol - 1]) bg = COLORS.FLAG_BG;
      var line = [];
      for (var j = 0; j < nCols; j++) line.push(bg);
      return line;
    });
    range.setBackgrounds(bgs);
  } else {
    sh.getRange(dataRow, 1).setValue('No data in range.');
  }

  sh.setFrozenRows(headerRow);
  sh.setFrozenColumns(name === TABS.SUMMARY ? 1 : 0);
  sh.setColumnWidths(1, nCols, 110);
  for (var k = 0; k < nCols; k++) {
    if (cols[k][0] === 'Campaign') sh.setColumnWidth(k + 1, 260);
    if (cols[k][0].indexOf('Notes') === 0) sh.setColumnWidth(k + 1, 380);
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

function openOrCreateSpreadsheet_(accountName, range) {
  if (CONFIG.SPREADSHEET_URL) {
    return SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
  }
  var ss = SpreadsheetApp.create('POAS vs ROAS weekly - ' + accountName);
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
// EMAIL — flagged campaigns only (latest week). Off unless CONFIG says so.
// ---------------------------------------------------------------------------
function sendEmail_(campaigns, meta, sheetUrl) {
  if (!CONFIG.EMAIL_RECIPIENTS || !CONFIG.EMAIL_RECIPIENTS.length) {
    logProblem_('EMAIL_ENABLED is true but EMAIL_RECIPIENTS is empty.');
    return;
  }
  var weeks = meta.range.weeks;
  var latest = weeks[weeks.length - 1];
  var flagged = campaigns.filter(function(c) {
    return c.byWeek[latest] && c.byWeek[latest].notes.length;
  });
  if (!flagged.length) {
    Logger.log('Email skipped: no campaigns flagged for week of ' + latest + '.');
    return;
  }
  var lines = flagged.map(function(c) {
    var m = c.byWeek[latest], x = m.r;
    return c.name + ' | cost ' + meta.currency + ' ' + fix2_(m.cost) +
        ' | ROAS ' + fix2_(x.roas) +
        ' | POAS ' + (x.poas === null ? 'n/a' : fix2_(x.poas)) +
        ' | est. POAS ' + fix2_(x.estPoas) +
        ' | margin ' + (x.margin === null ? 'n/a' : Math.round(x.margin * 100) + '%') +
        ' | cart margin ' + (x.cartMargin === null ? 'n/a' : Math.round(x.cartMargin * 100) + '%') +
        '\n    ' + m.notes.join('; ');
  });
  var subject = 'POAS vs ROAS - ' + meta.account + ' - week of ' + latest +
                ' - ' + flagged.length + ' flagged campaign' +
                (flagged.length === 1 ? '' : 's');
  var body = 'Flagged campaigns for the week ' + latest + ' to ' +
             shiftDays_(latest, 6) + ' (' + meta.currency + '):\n\n' +
             lines.join('\n\n') + '\n\nFull report: ' + sheetUrl + '\n';
  MailApp.sendEmail({
    to: CONFIG.EMAIL_RECIPIENTS.join(','),
    subject: subject,
    body: body
  });
  Logger.log('Email sent to ' + CONFIG.EMAIL_RECIPIENTS.join(', ') + ' (' +
             flagged.length + ' flagged).');
}

// ---------------------------------------------------------------------------
// SMALL UTILITIES
// ---------------------------------------------------------------------------
function logProblem_(msg) {
  RUN_LOG.push(msg);
  Logger.log('PROBLEM: ' + msg);
}

function num_(v) {
  var n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

// Micros -> currency units. Raw micros are never printed.
function micros_(v) {
  return num_(v) / 1e6;
}

// Round for the sheet; null/undefined -> '' (blank cell, never 0 or NaN).
function r2_(v) {
  return (v === null || v === undefined || !isFinite(v)) ? '' : Math.round(v * 100) / 100;
}
function r4_(v) {
  return (v === null || v === undefined || !isFinite(v)) ? '' : Math.round(v * 10000) / 10000;
}
function fix2_(v) {
  return (v === null || v === undefined || !isFinite(v)) ? 'n/a' : v.toFixed(2);
}

// Cart-only metrics print blank (not 0) on rows that have no cart data.
function cartVal_(x, v) {
  return x.hasCart ? r2_(v) : '';
}

function prettyType_(t) {
  var names = {
    'SEARCH': 'Search',
    'PERFORMANCE_MAX': 'Performance Max',
    'SHOPPING': 'Shopping',
    'DISPLAY': 'Display',
    'VIDEO': 'Video',
    'DEMAND_GEN': 'Demand Gen',
    'MULTI_CHANNEL': 'Multi-channel',
    'LOCAL': 'Local',
    'SMART': 'Smart',
    'HOTEL': 'Hotel',
    'LOCAL_SERVICES': 'Local Services',
    'TRAVEL': 'Travel'
  };
  var s = String(t || '');
  return names[s] || s;
}

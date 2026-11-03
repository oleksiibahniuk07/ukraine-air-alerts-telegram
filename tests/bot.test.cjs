'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/Code.gs'), 'utf8');

function createBot(overrides = {}) {
  const fetches = [];
  const values = {
    TELEGRAM_BOT_TOKEN: 'EXAMPLE_TOKEN_FROM_PRIVATE_PROPERTIES',
    TARGET_CHAT_ID: '@test_channel',
    CHANNEL_FOOTER: '📲 @test_channel',
    HISTORY_SPREADSHEET_ID: 'EXAMPLE_SHEET_ID_FROM_PRIVATE_PROPERTIES',
    ...overrides
  };
  const context = {
    console,
    PropertiesService: {
      getScriptProperties() {
        return {getProperty(key) { return values[key] ?? null; }};
      }
    },
    Utilities: {
      formatDate(date, timeZone, pattern) {
        assert.equal(timeZone, 'Europe/Kyiv');
        assert.equal(pattern, 'H');
        const hour = new Intl.DateTimeFormat('en-GB', {
          timeZone,
          hour: '2-digit',
          hourCycle: 'h23'
        }).format(date);
        return String(Number(hour));
      }
    },
    UrlFetchApp: {
      fetch(url, options) {
        fetches.push({url, options});
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ok: true, result: {message_id: 456}})
        };
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context, {filename: 'Code.gs'});
  return {context, fetches, values};
}

test('quiet window 22:00–07:00 Kyiv includes start, excludes end', () => {
  const {context} = createBot();
  const samples = [
    ['2026-11-03T19:59:00Z', false],
    ['2026-11-03T20:00:00Z', true],
    ['2026-11-04T04:59:00Z', true],
    ['2026-11-04T05:00:00Z', false]
  ];
  for (const [instant, expected] of samples) {
    assert.equal(context.isQuietHours_(new Date(instant)), expected, instant);
  }
});

test('summer-time window uses Europe/Kyiv instead of a fixed UTC offset', () => {
  const {context} = createBot();
  assert.equal(context.isQuietHours_(new Date('2026-07-20T19:00:00Z')), true);
  assert.equal(context.isQuietHours_(new Date('2026-07-21T04:00:00Z')), false);
});

test('Telegram quiet notifications: overnight true, daytime false, tests always true', () => {
  const {context, fetches} = createBot();
  context.sendTelegramMessage('🟡 Test', false, new Date('2026-11-03T20:20:00Z'));
  context.sendTelegramMessage('🔴 Test', false, new Date('2026-11-04T13:00:00Z'));
  context.sendTelegramMessage('🧪 Test', true, new Date('2026-11-04T13:00:00Z'));
  assert.deepEqual(fetches.map(f => JSON.parse(f.options.payload).disable_notification), [true, false, true]);
  for (const {options} of fetches) {
    assert.equal(JSON.parse(options.payload).parse_mode, 'HTML');
  }
});

test('yellow and red levels: RED wins over YELLOW, NONE when empty', () => {
  const {context} = createBot();
  const yellow = {alert_type: 'air_raid', alert_level: 'yellow'};
  const red = {alert_type: 'air_raid', alert_level: 'red'};
  assert.equal(context.resolveSingleAlertLevel(yellow), 'YELLOW');
  assert.equal(context.resolveHighestAlertLevel([yellow, red]), 'RED');
  assert.equal(context.resolveHighestAlertLevel([yellow]), 'YELLOW');
  assert.equal(context.resolveHighestAlertLevel([]), 'NONE');
});

test('monitor both district UID 59 and oblast UID 10', () => {
  const {context} = createBot();
  assert.equal(context.isRelevantLocation({location_uid: 59}), true);
  assert.equal(context.isRelevantLocation({location_uid: 10}), true);
  assert.equal(context.isRelevantLocation({location_uid: 999}), false);
});

test('source parses and does not include hardcoded production tokens or sheet IDs', () => {
  new vm.Script(source);
  assert.doesNotMatch(source, /\b[0-9]{7,12}:[A-Za-z0-9_-]{30,}\b/, 'Telegram bot token found');
  assert.doesNotMatch(source, /HISTORY_SPREADSHEET_ID:\s*['"]1[A-Za-z0-9_-]{30,}/, 'Google Sheet ID found');
  assert.match(source, /getProjectSetting_\('TELEGRAM_BOT_TOKEN'\)/);
  assert.match(source, /getProjectSetting_\('HISTORY_SPREADSHEET_ID'\)/);
});

test('API snapshot ignores unrelated locations and prefers matching RED alert', () => {
  const {context} = createBot();
  context.getRawAlertData = () => ({raw: {alerts: [
    {alert_type: 'air_raid', location_uid: 59, alert_level: 'yellow', started_at: '2026-11-03T15:00:00Z'},
    {alert_type: 'air_raid', location_uid: 10, alert_level: 'red', started_at: '2026-11-03T15:30:00Z'},
    {alert_type: 'air_raid', location_uid: 555, alert_level: 'red', started_at: '2026-11-03T14:00:00Z'}
  ]}});
  const snapshot = context.getDistrictAlertSnapshot();
  assert.equal(snapshot.level, 'RED');
  assert.equal(snapshot.matchedCount, 2);
});

test('malformed API response is an error, not a false all-clear', () => {
  const {context} = createBot();
  context.getRawAlertData = () => ({raw: {unexpected_payload: 'not alerts'}});
  assert.throws(() => context.getDistrictAlertSnapshot(), /Не вдалося знайти масив alerts/);
});

test('network exception does not expose a Telegram token', () => {
  const {context, values} = createBot();
  context.UrlFetchApp.fetch = (url) => { throw new Error('Network failed at ' + url); };
  assert.throws(() => context.sendTelegramMessage('hello', false, new Date('2026-11-04T13:00:00Z')), err => {
    assert.ok(err.message.includes('[REDACTED_BOT_TOKEN]'));
    assert.ok(!err.message.includes(values.TELEGRAM_BOT_TOKEN));
    return true;
  });
});

test('no-alert week report is short and does not introduce a separate drone count', () => {
  const {context} = createBot();
  const msg = context.buildWeeklyStatisticsMessage({count: 0}, new Date(), new Date());
  assert.match(msg, /За минулий тиждень повітряних тривог/);
  assert.doesNotMatch(msg, /дронов/i);
  assert.match(msg, /@test_channel/);
});

test('custom district settings change matching, text and scope without code edits', () => {
  const {context} = createBot({
    REGION_MODE: 'district',
    DISTRICT_UID: '501',
    DISTRICT_NAME: 'Тестовий район',
    OBLAST_UID: '50',
    OBLAST_NAME: 'Тестова область'
  });
  context.validateRegionConfig_();
  assert.equal(context.isRelevantLocation({location_uid: 501}), true);
  assert.equal(context.isRelevantLocation({location_uid: 50}), true);
  assert.equal(context.isRelevantLocation({location_uid: 59}), false);
  assert.equal(context.isRelevantLocation({location_uid: 10}), false);
  const info = vm.runInContext('({mode:CONFIG.REGION_MODE, text:CONFIG.RED_MESSAGE,scope:CONFIG.STATE_SCOPE_KEY})', context);
  assert.equal(info.mode, 'district');
  assert.match(info.text, /Тестовий район/);
  assert.match(info.scope, /district:50:501/);
  const msg = context.buildWeeklyStatisticsMessage({count:0},new Date(),new Date());
  assert.match(msg, /Тестовий район/);
  assert.doesNotMatch(msg, /Житомирському районі/);
});

test('oblast-only mode excludes unrelated district alerts by default', () => {
  const {context} = createBot({
    REGION_MODE: 'oblast',
    OBLAST_UID: '50',
    OBLAST_NAME: 'Тестова область'
  });
  context.validateRegionConfig_();
  assert.equal(context.isRelevantLocation({location_uid:50}),true);
  assert.equal(context.isRelevantLocation({location_uid:501}),false);
  assert.equal(context.isRelevantLocation({location_uid:10}),false);
  const info = vm.runInContext('({text:CONFIG.YELLOW_MESSAGE,scope:CONFIG.STATE_SCOPE_KEY})',context);
  assert.match(info.text, /Тестова область/);
  assert.match(info.scope, /oblast:50/);
});

test('oblast mode can explicitly cover selected district UID list', () => {
  const {context} = createBot({
    REGION_MODE: 'oblast',
    OBLAST_UID: '50',
    OBLAST_NAME: 'Тестова область',
    ADDITIONAL_DISTRICT_UIDS: '501, 502'
  });
  context.validateRegionConfig_();
  assert.equal(context.isRelevantLocation({location_uid:501}),true);
  assert.equal(context.isRelevantLocation({location_uid:502}),true);
  assert.equal(context.isRelevantLocation({location_uid:503}),false);
  const info = vm.runInContext('CONFIG.STATE_SCOPE_KEY',context);
  assert.match(info,/oblast:50:501:502/);
});

test('incomplete region property overrides fail rather than silently falling back', () => {
  const {context} = createBot({REGION_MODE:'district',DISTRICT_UID:'501'});
  assert.throws(()=>context.validateRegionConfig_(),/OBLAST_UID/);
  assert.throws(()=>context.setupRegion(),/OBLAST_UID/);
});

test('invalid region mode and duplicate district IDs are rejected', () => {
  const bad = createBot({REGION_MODE:'city',OBLAST_UID:'50',OBLAST_NAME:'Тестова область'});
  assert.throws(()=>bad.context.validateRegionConfig_(),/REGION_MODE/);
  const duplicates=createBot({REGION_MODE:'oblast',OBLAST_UID:'50',OBLAST_NAME:'Тестова область',ADDITIONAL_DISTRICT_UIDS:'501,501'});
  assert.throws(()=>duplicates.context.validateRegionConfig_(),/дублікати/);
});

test('region names are escaped before inserting into Telegram HTML', () => {
  const {context} = createBot({
    REGION_MODE: 'oblast',
    OBLAST_UID: '50',
    OBLAST_NAME: '<Test & Region>'
  });
  const html=vm.runInContext('CONFIG.RED_MESSAGE',context);
  assert.match(html, /&lt;Test &amp; Region&gt;/);
  assert.doesNotMatch(html, /<Test/);
});

test('setupRegion does not pretend inactive-alert data verifies the UID', () => {
  const {context} = createBot({
    REGION_MODE: 'district',
    DISTRICT_UID: '501',
    DISTRICT_NAME: 'Тестовий район',
    OBLAST_UID: '50',
    OBLAST_NAME: 'Тестова область'
  });
  context.getRawAlertData=()=>({raw:{alerts:[]}});
  const r=context.setupRegion();
  assert.equal(r.matchedActiveAlerts,0);
  assert.equal(r.uidValidation,'NOT_VERIFIABLE_WHEN_NO_MATCHING_ACTIVE_ALERTS');
  assert.match(r.warning,/НЕ підтверджує UID/);
});

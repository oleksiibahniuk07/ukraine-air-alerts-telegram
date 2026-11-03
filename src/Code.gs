/**
 * ============================================================
 * ПОВІТРЯНІ ТРИВОГИ — ЖИТОМИРСЬКИЙ РАЙОН
 * Telegram + історія Google Sheets + тижнева статистика + тихий режим
 * ============================================================
 */

function getProjectSetting_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  return typeof value === 'string' ? value.trim() : '';
}

const CONFIG = {
  API_URL: 'https://ubilling.net.ua/aerialalerts/?source=aiu&raw',

  DISTRICT_UID: '59',
  DISTRICT_NAME: 'Житомирський район',

  OBLAST_UID: '10',
  OBLAST_NAME: 'Житомирська область',

  API_TIMEZONE: 'Europe/Kyiv',

  // Приватні налаштування зберігаються ЛИШЕ в Apps Script → Script Properties.
  // Не додавати токени, ID таблиці або приватний chat ID у Git.
  TELEGRAM_BOT_TOKEN: getProjectSetting_('TELEGRAM_BOT_TOKEN'),
  TARGET_CHAT_ID: getProjectSetting_('TARGET_CHAT_ID'),
  CHANNEL_FOOTER: getProjectSetting_('CHANNEL_FOOTER'),

  // З 22:00 включно до 07:00 (не включно) за Europe/Kyiv — без звуку.
  QUIET_HOURS_START: 22,
  QUIET_HOURS_END: 7,

  // Реальні сповіщення 🟡 🔴 🟢 видаляються через 24 години.
  AUTO_DELETE_AFTER_HOURS: 24,

  // Для НОВОЇ інсталяції не публікувати активний статус одразу при першому запуску.
  // Можна увімкнути true, якщо потрібна початкова синхронізація з повідомленням.
  STATE_SCOPE_KEY: 'aiu:zhytomyr-raion:59:levels-v3',
  PUBLISH_CURRENT_ON_SCOPE_CHANGE: false,

  YELLOW_MESSAGE:
    '🟡 <b>Житомирський район — жовтий рівень повітряної тривоги!</b>',

  RED_MESSAGE:
    '🔴 <b>Житомирський район — червоний рівень повітряної тривоги!</b>',

  CLEAR_MESSAGE_TITLE:
    '🟢 <b>Житомирський район — відбій повітряної тривоги!</b>',

  // ID Google Sheets також прихований у Script Properties.
  HISTORY_SPREADSHEET_ID: getProjectSetting_('HISTORY_SPREADSHEET_ID'),

  SHEET_ALERTS: 'Тривоги',
  SHEET_EVENTS: 'Події',
  SHEET_WEEKLY: 'Тижневі звіти',

  // Щопонеділка приблизно о 08:00 за Києвом.
  // За потреби змініть 8, наприклад, на 9 або 10.
  WEEKLY_REPORT_HOUR: 8
};


/**
 * ============================================================
 * ОСНОВНА ПЕРЕВІРКА
 * ============================================================
 */

function checkAirAlert() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    console.log('Перевірку пропущено: інша функція вже виконується.');
    return;
  }

  try {
    validateConfig();

    const snapshot = getDistrictAlertSnapshot();
    const currentLevel = snapshot.level; // NONE / YELLOW / RED
    const now = Date.now();
    const properties = PropertiesService.getScriptProperties();
    const savedScope = properties.getProperty('ALERT_SCOPE_KEY');

    /**
     * ПЕРШИЙ ЗАПУСК / НОВИЙ SCOPE
     */
    if (savedScope !== CONFIG.STATE_SCOPE_KEY) {
      let telegramMessageId = null;

      if (
        CONFIG.PUBLISH_CURRENT_ON_SCOPE_CHANGE &&
        currentLevel !== 'NONE'
      ) {
        telegramMessageId = publishRealState(currentLevel, null);
      }

      properties.setProperty('ALERT_SCOPE_KEY', CONFIG.STATE_SCOPE_KEY);
      properties.setProperty('LAST_ALERT_LEVEL', currentLevel);
      properties.deleteProperty('LAST_ALERT_STATE');

      if (currentLevel !== 'NONE') {
        const startTs = snapshot.startedAt || now;
        properties.setProperty('ALERT_STARTED_AT', String(startTs));

        const alertId = ensureCurrentAlertId(properties, startTs);

        const historyOk = safeHistoryAction(
          'перший запис активної тривоги',
          function () {
            const created = ensureAlertRecord(
              alertId,
              startTs,
              currentLevel,
              snapshot,
              now
            );

            if (created) {
              appendAlertEvent(
                alertId,
                'NONE',
                currentLevel,
                'START_SYNC',
                snapshot,
                telegramMessageId,
                now
              );
            }
          }
        );

        if (historyOk) {
          properties.setProperty('HISTORY_REGISTERED_ALERT_ID', alertId);
        }
      } else {
        properties.deleteProperty('ALERT_STARTED_AT');
        properties.deleteProperty('CURRENT_ALERT_ID');
      }

      saveSnapshotMetadata(properties, snapshot);
      markSuccessfulCheck(properties);

      console.log(
        'Активовано систему. Поточний стан: ' + formatLevel(currentLevel)
      );
      return;
    }

    /**
     * ПОПЕРЕДНІЙ РІВЕНЬ
     */
    const previousLevel = properties.getProperty('LAST_ALERT_LEVEL');

    /**
     * РЕЗЕРВНИЙ ПЕРШИЙ ЗАПУСК
     */
    if (previousLevel === null) {
      let telegramMessageId = null;

      if (
        CONFIG.PUBLISH_CURRENT_ON_SCOPE_CHANGE &&
        currentLevel !== 'NONE'
      ) {
        telegramMessageId = publishRealState(currentLevel, null);
      }

      properties.setProperty('LAST_ALERT_LEVEL', currentLevel);

      if (currentLevel !== 'NONE') {
        const startTs = snapshot.startedAt || now;
        properties.setProperty('ALERT_STARTED_AT', String(startTs));

        const alertId = ensureCurrentAlertId(properties, startTs);

        const historyOk = safeHistoryAction(
          'резервний перший запис',
          function () {
            const created = ensureAlertRecord(
              alertId,
              startTs,
              currentLevel,
              snapshot,
              now
            );

            if (created) {
              appendAlertEvent(
                alertId,
                'NONE',
                currentLevel,
                'START_SYNC',
                snapshot,
                telegramMessageId,
                now
              );
            }
          }
        );

        if (historyOk) {
          properties.setProperty('HISTORY_REGISTERED_ALERT_ID', alertId);
        }
      } else {
        properties.deleteProperty('ALERT_STARTED_AT');
        properties.deleteProperty('CURRENT_ALERT_ID');
      }

      saveSnapshotMetadata(properties, snapshot);
      markSuccessfulCheck(properties);

      console.log('Перший запуск. Поточний стан: ' + formatLevel(currentLevel));
      return;
    }

    /**
     * СТАН НЕ ЗМІНИВСЯ
     */
    if (previousLevel === currentLevel) {
      if (currentLevel !== 'NONE') {
        syncStoredAlertStart(properties, snapshot.startedAt, now);

        const storedStart = getStoredAlertStartTimestamp(properties, now);
        const alertId = ensureCurrentAlertId(properties, storedStart);

        // Це потрібно, якщо код із журналом встановили посеред активної тривоги.
        // Після першої успішної синхронізації щохвилини таблицю вже не читаємо.
        if (
          properties.getProperty('HISTORY_REGISTERED_ALERT_ID') !== alertId
        ) {
          const historyOk = safeHistoryAction(
            'синхронізація активної тривоги',
            function () {
              const created = ensureAlertRecord(
                alertId,
                storedStart,
                currentLevel,
                snapshot,
                now
              );

              if (created) {
                appendAlertEvent(
                  alertId,
                  'NONE',
                  currentLevel,
                  'START_SYNC',
                  snapshot,
                  null,
                  now
                );
              }
            }
          );

          if (historyOk) {
            properties.setProperty('HISTORY_REGISTERED_ALERT_ID', alertId);
          }
        }
      } else {
        properties.deleteProperty('ALERT_STARTED_AT');
        properties.deleteProperty('CURRENT_ALERT_ID');
      }

      saveSnapshotMetadata(properties, snapshot);
      markSuccessfulCheck(properties);

      console.log(
        'Стан без змін: ' +
          formatLevel(currentLevel) +
          '. Релевантних активних тривог: ' +
          snapshot.matchedCount
      );
      return;
    }

    /**
     * YELLOW / RED → NONE
     * ВІДБІЙ
     */
    if (currentLevel === 'NONE') {
      const alertEndedAt = now;
      const alertStartedAt = getStoredAlertStartTimestamp(
        properties,
        alertEndedAt
      );

      const durationMilliseconds = calculateDurationMilliseconds(
        alertStartedAt,
        alertEndedAt
      );

      const telegramMessageId = publishRealState(
        'NONE',
        durationMilliseconds
      );

      let alertId = properties.getProperty('CURRENT_ALERT_ID');
      if (!alertId) {
        alertId = createAlertId(alertStartedAt);
      }

      // ВАЖЛИВО: спочатку фіксуємо новий стан,
      // щоб у разі помилки Google Sheets не було дубля Telegram.
      properties.setProperty('LAST_ALERT_LEVEL', 'NONE');
      properties.deleteProperty('ALERT_STARTED_AT');
      properties.deleteProperty('CURRENT_ALERT_ID');

      saveSnapshotMetadata(properties, snapshot);
      markSuccessfulCheck(properties);

      const historyOk = safeHistoryAction('запис відбою', function () {
        ensureAlertRecord(
          alertId,
          alertStartedAt,
          previousLevel,
          snapshot,
          now
        );

        markAlertLevelSeen(alertId, previousLevel, now);

        closeAlertRecord(
          alertId,
          alertStartedAt,
          alertEndedAt,
          durationMilliseconds,
          now
        );

        appendAlertEvent(
          alertId,
          previousLevel,
          'NONE',
          'CLEAR',
          snapshot,
          telegramMessageId,
          now
        );
      });

      if (historyOk) {
        properties.deleteProperty('HISTORY_REGISTERED_ALERT_ID');
      }

      console.log(
        'Стан змінився: ' +
          previousLevel +
          ' → NONE. Опубліковано ВІДБІЙ. Тривалість: ' +
          formatAlertDuration(durationMilliseconds)
      );

      return;
    }

    /**
     * NONE → YELLOW / RED
     * або YELLOW ↔ RED
     */
    let alertId;
    let alertStartedAt;

    if (previousLevel === 'NONE') {
      alertStartedAt = snapshot.startedAt || now;
      properties.setProperty('ALERT_STARTED_AT', String(alertStartedAt));

      alertId = createAlertId(alertStartedAt);
      properties.setProperty('CURRENT_ALERT_ID', alertId);
    } else {
      syncStoredAlertStart(properties, snapshot.startedAt, now);
      alertStartedAt = getStoredAlertStartTimestamp(properties, now);
      alertId = ensureCurrentAlertId(properties, alertStartedAt);
    }

    const telegramMessageId = publishRealState(currentLevel, null);

    // Фіксуємо стан до роботи з таблицею.
    properties.setProperty('LAST_ALERT_LEVEL', currentLevel);
    saveSnapshotMetadata(properties, snapshot);
    markSuccessfulCheck(properties);

    const historyOk = safeHistoryAction('запис зміни рівня', function () {
      ensureAlertRecord(
        alertId,
        alertStartedAt,
        previousLevel === 'NONE' ? currentLevel : previousLevel,
        snapshot,
        now
      );

      markAlertLevelSeen(alertId, currentLevel, now);

      appendAlertEvent(
        alertId,
        previousLevel,
        currentLevel,
        previousLevel === 'NONE' ? 'START' : 'LEVEL_CHANGE',
        snapshot,
        telegramMessageId,
        now
      );
    });

    if (historyOk) {
      properties.setProperty('HISTORY_REGISTERED_ALERT_ID', alertId);
    }

    console.log(
      'Рівень змінився: ' +
        previousLevel +
        ' → ' +
        currentLevel +
        '. Повідомлення опубліковано.'
    );
  } catch (error) {
    console.error('Помилка checkAirAlert: ' + error.message);

    PropertiesService.getScriptProperties().setProperty(
      'LAST_ERROR',
      new Date().toISOString() + ' | ' + error.message
    );

    throw error;
  } finally {
    lock.releaseLock();
  }
}


/**
 * ============================================================
 * GOOGLE SHEETS — ІСТОРІЯ
 * ============================================================
 */

function getHistorySpreadsheet() {
  return SpreadsheetApp.openById(CONFIG.HISTORY_SPREADSHEET_ID);
}

function ensureHistorySheets() {
  const spreadsheet = getHistorySpreadsheet();
  spreadsheet.setSpreadsheetTimeZone(CONFIG.API_TIMEZONE);

  const definitions = [
    {
      name: CONFIG.SHEET_ALERTS,
      headers: [
        'ID тривоги',
        'Початок',
        'Завершення',
        'Тривалість, хв',
        'Тривалість',
        'Початковий рівень',
        'Був жовтий',
        'Був червоний',
        'Статус',
        'Тиждень (початок)',
        'Джерело started_at',
        'Створено',
        'Оновлено'
      ]
    },
    {
      name: CONFIG.SHEET_EVENTS,
      headers: [
        'ID події',
        'ID тривоги',
        'Час події',
        'Попередній рівень',
        'Новий рівень',
        'Тип події',
        'Тип загрози',
        'Source alert ID',
        'Location UID',
        'Telegram message ID',
        'Створено'
      ]
    },
    {
      name: CONFIG.SHEET_WEEKLY,
      headers: [
        'Початок тижня',
        'Кінець тижня',
        'Кількість тривог',
        'Загальна тривалість, хв',
        'Найдовша тривога, хв',
        'Жовтий рівень, випадків',
        'Червоний рівень, випадків',
        'Текст звіту',
        'Надіслано',
        'Telegram message ID',
        'Статус'
      ]
    }
  ];

  definitions.forEach(function (definition) {
    let sheet = spreadsheet.getSheetByName(definition.name);

    if (!sheet) {
      sheet = spreadsheet.insertSheet(definition.name);
    }

    if (sheet.getLastRow() === 0) {
      sheet
        .getRange(1, 1, 1, definition.headers.length)
        .setValues([definition.headers]);
      sheet.setFrozenRows(1);
    }
  });

  return spreadsheet;
}

function safeHistoryAction(label, callback) {
  try {
    callback();

    PropertiesService.getScriptProperties().deleteProperty(
      'LAST_HISTORY_ERROR'
    );

    return true;
  } catch (error) {
    console.error('Помилка історії (' + label + '): ' + error.message);

    PropertiesService.getScriptProperties().setProperty(
      'LAST_HISTORY_ERROR',
      new Date().toISOString() + ' | ' + label + ' | ' + error.message
    );

    return false;
  }
}

function createAlertId(startTimestamp) {
  const date = new Date(Number(startTimestamp) || Date.now());
  const prefix = Utilities.formatDate(
    date,
    CONFIG.API_TIMEZONE,
    'yyyyMMdd-HHmmss'
  );

  return 'ALERT-' + prefix + '-' + Utilities.getUuid().slice(0, 8);
}

function ensureCurrentAlertId(properties, startTimestamp) {
  let alertId = properties.getProperty('CURRENT_ALERT_ID');

  if (!alertId) {
    alertId = createAlertId(startTimestamp);
    properties.setProperty('CURRENT_ALERT_ID', alertId);
  }

  return alertId;
}

function findAlertRow(sheet, alertId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const found = sheet
    .getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(String(alertId))
    .matchEntireCell(true)
    .findNext();

  return found ? found.getRow() : null;
}

function ensureAlertRecord(
  alertId,
  startTimestamp,
  initialLevel,
  snapshot,
  createdAtTimestamp
) {
  const spreadsheet = getHistorySpreadsheet();
  const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_ALERTS);

  if (!sheet) {
    throw new Error('Не знайдено аркуш "' + CONFIG.SHEET_ALERTS + '".');
  }

  const existingRow = findAlertRow(sheet, alertId);
  if (existingRow) return false;

  const startDate = new Date(Number(startTimestamp));
  const createdAt = new Date(Number(createdAtTimestamp) || Date.now());
  const sourceStartedAt = snapshot.startedAt
    ? new Date(Number(snapshot.startedAt))
    : '';

  sheet.appendRow([
    alertId,
    startDate,
    '',
    '',
    '',
    initialLevel,
    initialLevel === 'YELLOW',
    initialLevel === 'RED',
    'Активна',
    getWeekStart(startDate),
    sourceStartedAt,
    createdAt,
    createdAt
  ]);

  return true;
}

function markAlertLevelSeen(alertId, level, updatedAtTimestamp) {
  if (level !== 'YELLOW' && level !== 'RED') return;

  const spreadsheet = getHistorySpreadsheet();
  const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_ALERTS);
  const row = findAlertRow(sheet, alertId);

  if (!row) {
    throw new Error('Не знайдено запис тривоги ' + alertId + '.');
  }

  if (level === 'YELLOW') {
    sheet.getRange(row, 7).setValue(true); // G
  }

  if (level === 'RED') {
    sheet.getRange(row, 8).setValue(true); // H
  }

  sheet.getRange(row, 13).setValue(
    new Date(Number(updatedAtTimestamp) || Date.now())
  );
}

function closeAlertRecord(
  alertId,
  startedAt,
  endedAt,
  durationMilliseconds,
  updatedAtTimestamp
) {
  const spreadsheet = getHistorySpreadsheet();
  const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_ALERTS);
  const row = findAlertRow(sheet, alertId);

  if (!row) {
    throw new Error('Не знайдено запис тривоги ' + alertId + '.');
  }

  const minutes = Math.max(
    1,
    Math.round(Number(durationMilliseconds) / 60000)
  );

  sheet.getRange(row, 2).setValue(new Date(Number(startedAt))); // B
  sheet.getRange(row, 3).setValue(new Date(Number(endedAt))); // C
  sheet.getRange(row, 4).setValue(minutes); // D
  sheet.getRange(row, 5).setValue(formatAlertDuration(durationMilliseconds)); // E
  sheet.getRange(row, 9).setValue('Завершено'); // I
  sheet.getRange(row, 10).setValue(getWeekStart(new Date(Number(startedAt)))); // J
  sheet.getRange(row, 13).setValue(
    new Date(Number(updatedAtTimestamp) || Date.now())
  ); // M
}

function appendAlertEvent(
  alertId,
  previousLevel,
  newLevel,
  eventType,
  snapshot,
  telegramMessageId,
  eventTimestamp
) {
  const spreadsheet = getHistorySpreadsheet();
  const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_EVENTS);

  if (!sheet) {
    throw new Error('Не знайдено аркуш "' + CONFIG.SHEET_EVENTS + '".');
  }

  const eventDate = new Date(Number(eventTimestamp) || Date.now());

  sheet.appendRow([
    'EVENT-' + Utilities.getUuid(),
    alertId,
    eventDate,
    previousLevel || '',
    newLevel || '',
    eventType,
    extractThreatTypes(snapshot, newLevel),
    extractSourceAlertIds(snapshot),
    extractLocationUids(snapshot),
    telegramMessageId || '',
    eventDate
  ]);
}

function extractThreatTypes(snapshot, level) {
  const result = [];

  (snapshot.matchedAlerts || []).forEach(function (alert) {
    (alert.threats || []).forEach(function (threat) {
      const type = normalizeValue(threat.threat_type);
      if (type && result.indexOf(type) === -1) {
        result.push(type);
      }
    });
  });

  // Для нашої логіки жовтий рівень = дронова небезпека.
  if (level === 'YELLOW' && result.indexOf('drones') === -1) {
    result.push('drones');
  }

  return result.join(', ');
}

function extractSourceAlertIds(snapshot) {
  const ids = [];

  (snapshot.matchedAlerts || []).forEach(function (alert) {
    const id = String(alert.id || '').trim();
    if (id && ids.indexOf(id) === -1) ids.push(id);
  });

  return ids.join(', ');
}

function extractLocationUids(snapshot) {
  const ids = [];

  (snapshot.matchedAlerts || []).forEach(function (alert) {
    const id = String(alert.location_uid || '').trim();
    if (id && ids.indexOf(id) === -1) ids.push(id);
  });

  return ids.join(', ');
}


/**
 * ============================================================
 * ТИЖНЕВА СТАТИСТИКА
 * ============================================================
 */

function sendWeeklyStatistics() {
  validateConfig();
  ensureHistorySheets();

  const range = getPreviousWeekRange(new Date());
  const reportKey = Utilities.formatDate(
    range.start,
    CONFIG.API_TIMEZONE,
    'yyyy-MM-dd'
  );

  const properties = PropertiesService.getScriptProperties();

  if (properties.getProperty('LAST_WEEKLY_REPORT_KEY') === reportKey) {
    console.log('Звіт за ' + reportKey + ' уже був надісланий.');
    return;
  }

  if (weeklyReportAlreadySent(range.start)) {
    properties.setProperty('LAST_WEEKLY_REPORT_KEY', reportKey);
    console.log('Звіт за ' + reportKey + ' уже є у таблиці.');
    return;
  }

  const stats = calculateWeeklyStatistics(range.start, range.end);
  const message = buildWeeklyStatisticsMessage(stats, range.start, range.end);

  const response = sendTelegramMessage(message, false);
  const messageId = getTelegramMessageId(response);

  // Спочатку блокуємо повторну відправку.
  properties.setProperty('LAST_WEEKLY_REPORT_KEY', reportKey);

  safeHistoryAction('запис тижневого звіту', function () {
    appendWeeklyReportRow(
      range.start,
      range.end,
      stats,
      message,
      messageId,
      'SENT'
    );
  });

  console.log(
    'Тижневий звіт опубліковано. Telegram ID: ' + messageId
  );
}

function calculateWeeklyStatistics(weekStart, weekEnd) {
  const spreadsheet = getHistorySpreadsheet();
  const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_ALERTS);

  if (!sheet) {
    throw new Error('Не знайдено аркуш "' + CONFIG.SHEET_ALERTS + '".');
  }

  const values = sheet.getDataRange().getValues();
  const startMs = weekStart.getTime();
  const endMs = weekEnd.getTime();

  let count = 0;
  let totalDurationMs = 0;
  let longestDurationMs = 0;
  let yellowCount = 0;
  let redCount = 0;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const alertId = String(row[0] || '').trim();
    if (!alertId) continue;

    const alertStart = valueToTimestamp(row[1]);
    if (alertStart === null) continue;

    let alertEnd = valueToTimestamp(row[2]);

    // Якщо тривога ще активна, для завершеного тижня
    // беремо межу weekEnd.
    if (alertEnd === null) {
      alertEnd = endMs;
    }

    const overlapStart = Math.max(alertStart, startMs);
    const overlapEnd = Math.min(alertEnd, endMs);

    if (overlapEnd <= overlapStart) continue;

    const duration = overlapEnd - overlapStart;

    count++;
    totalDurationMs += duration;
    longestDurationMs = Math.max(longestDurationMs, duration);

    if (isTruthySheetValue(row[6])) yellowCount++; // G
    if (isTruthySheetValue(row[7])) redCount++; // H
  }

  return {
    count: count,
    totalDurationMs: totalDurationMs,
    longestDurationMs: longestDurationMs,
    yellowCount: yellowCount,
    redCount: redCount
  };
}

function buildWeeklyStatisticsMessage(stats, weekStart, weekEnd) {
  if (stats.count === 0) {
    return (
      '📊 <b>Статистика за тиждень</b>' +
      '\n\n' +
      '🟢 За минулий тиждень повітряних тривог у Житомирському районі не зафіксовано.' +
      '\n\n' +
      CONFIG.CHANNEL_FOOTER
    );
  }

  return (
    '📊 <b>Статистика повітряних тривог за тиждень</b>' +
    '\n' +
    '📅 ' +
    formatWeeklyDateRange(weekStart, weekEnd) +
    '\n\n' +
    '🚨 Кількість повітряних тривог: <b>' +
    stats.count +
    '</b>' +
    '\n' +
    '⏱ Загальна тривалість: <b>' +
    formatDurationShort(stats.totalDurationMs) +
    '</b>' +
    '\n' +
    '📈 Найдовша тривога: <b>' +
    formatDurationShort(stats.longestDurationMs) +
    '</b>' +
    '\n\n' +
    '🟡 Жовтий рівень: <b>' +
    stats.yellowCount +
    ' ' +
    ukrainianPlural(stats.yellowCount, 'випадок', 'випадки', 'випадків') +
    '</b>' +
    '\n' +
    '🔴 Червоний рівень: <b>' +
    stats.redCount +
    ' ' +
    ukrainianPlural(stats.redCount, 'випадок', 'випадки', 'випадків') +
    '</b>' +
    '\n\n' +
    CONFIG.CHANNEL_FOOTER
  );
}

function appendWeeklyReportRow(
  weekStart,
  weekEnd,
  stats,
  message,
  telegramMessageId,
  status
) {
  const spreadsheet = getHistorySpreadsheet();
  const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_WEEKLY);

  if (!sheet) {
    throw new Error('Не знайдено аркуш "' + CONFIG.SHEET_WEEKLY + '".');
  }

  sheet.appendRow([
    weekStart,
    addLocalDays(weekEnd, -1),
    stats.count,
    Math.round(stats.totalDurationMs / 60000),
    Math.round(stats.longestDurationMs / 60000),
    stats.yellowCount,
    stats.redCount,
    stripHtmlTags(message),
    new Date(),
    telegramMessageId,
    status
  ]);
}

function weeklyReportAlreadySent(weekStart) {
  const spreadsheet = getHistorySpreadsheet();
  const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_WEEKLY);

  if (!sheet || sheet.getLastRow() < 2) return false;

  const targetKey = Utilities.formatDate(
    weekStart,
    CONFIG.API_TIMEZONE,
    'yyyy-MM-dd'
  );

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();

  return values.some(function (row) {
    const rowStart = valueToTimestamp(row[0]);
    const status = String(row[10] || '').trim().toUpperCase();

    if (rowStart === null || status !== 'SENT') return false;

    const rowKey = Utilities.formatDate(
      new Date(rowStart),
      CONFIG.API_TIMEZONE,
      'yyyy-MM-dd'
    );

    return rowKey === targetKey;
  });
}

function testWeeklyReportPreview() {
  validateConfig();
  ensureHistorySheets();

  const range = getPreviousWeekRange(new Date());
  const stats = calculateWeeklyStatistics(range.start, range.end);
  const message = buildWeeklyStatisticsMessage(stats, range.start, range.end);

  console.log(message);
}

function testCurrentWeekStatisticsPreview() {
  validateConfig();
  ensureHistorySheets();

  const start = getWeekStart(new Date());
  const end = new Date();
  const stats = calculateWeeklyStatistics(start, end);
  const message = buildWeeklyStatisticsMessage(stats, start, addLocalDays(start, 7));

  console.log(message);
}

function testHistoryConnection() {
  validateConfig();
  const spreadsheet = ensureHistorySheets();

  // Не виводимо ID таблиці в лог.
  console.log('Google Sheets підключено: ' + spreadsheet.getName());
}


/**
 * ============================================================
 * ДАТИ ТИЖНЯ
 * ============================================================
 */

function getPreviousWeekRange(now) {
  const thisWeekStart = getWeekStart(now);
  const previousWeekStart = addLocalDays(thisWeekStart, -7);

  return {
    start: previousWeekStart,
    end: thisWeekStart
  };
}

function getWeekStart(date) {
  const year = Number(Utilities.formatDate(date, CONFIG.API_TIMEZONE, 'yyyy'));
  const month = Number(Utilities.formatDate(date, CONFIG.API_TIMEZONE, 'MM'));
  const day = Number(Utilities.formatDate(date, CONFIG.API_TIMEZONE, 'dd'));

  const marker = new Date(Date.UTC(year, month - 1, day));
  const mondayOffset = (marker.getUTCDay() + 6) % 7;
  marker.setUTCDate(marker.getUTCDate() - mondayOffset);

  return localMidnightFromUtcMarker(marker);
}

function addLocalDays(date, numberOfDays) {
  const year = Number(Utilities.formatDate(date, CONFIG.API_TIMEZONE, 'yyyy'));
  const month = Number(Utilities.formatDate(date, CONFIG.API_TIMEZONE, 'MM'));
  const day = Number(Utilities.formatDate(date, CONFIG.API_TIMEZONE, 'dd'));

  const marker = new Date(Date.UTC(year, month - 1, day));
  marker.setUTCDate(marker.getUTCDate() + Number(numberOfDays));

  return localMidnightFromUtcMarker(marker);
}

function localMidnightFromUtcMarker(marker) {
  const y = marker.getUTCFullYear();
  const m = String(marker.getUTCMonth() + 1).padStart(2, '0');
  const d = String(marker.getUTCDate()).padStart(2, '0');

  return Utilities.parseDate(
    y + '-' + m + '-' + d + ' 00:00:00',
    CONFIG.API_TIMEZONE,
    'yyyy-MM-dd HH:mm:ss'
  );
}

function formatWeeklyDateRange(weekStart, weekEndExclusive) {
  const weekEnd = addLocalDays(weekEndExclusive, -1);

  const startDay = Utilities.formatDate(weekStart, CONFIG.API_TIMEZONE, 'dd');
  const endDay = Utilities.formatDate(weekEnd, CONFIG.API_TIMEZONE, 'dd');

  const startMonth = Number(
    Utilities.formatDate(weekStart, CONFIG.API_TIMEZONE, 'M')
  );
  const endMonth = Number(
    Utilities.formatDate(weekEnd, CONFIG.API_TIMEZONE, 'M')
  );

  const startYear = Utilities.formatDate(
    weekStart,
    CONFIG.API_TIMEZONE,
    'yyyy'
  );
  const endYear = Utilities.formatDate(
    weekEnd,
    CONFIG.API_TIMEZONE,
    'yyyy'
  );

  if (startMonth === endMonth && startYear === endYear) {
    return (
      startDay +
      '–' +
      endDay +
      ' ' +
      ukrainianMonthGenitive(endMonth) +
      ' ' +
      endYear +
      ' р.'
    );
  }

  if (startYear === endYear) {
    return (
      startDay +
      ' ' +
      ukrainianMonthGenitive(startMonth) +
      ' – ' +
      endDay +
      ' ' +
      ukrainianMonthGenitive(endMonth) +
      ' ' +
      endYear +
      ' р.'
    );
  }

  return (
    startDay +
    ' ' +
    ukrainianMonthGenitive(startMonth) +
    ' ' +
    startYear +
    ' – ' +
    endDay +
    ' ' +
    ukrainianMonthGenitive(endMonth) +
    ' ' +
    endYear +
    ' р.'
  );
}

function ukrainianMonthGenitive(month) {
  const months = [
    '',
    'січня',
    'лютого',
    'березня',
    'квітня',
    'травня',
    'червня',
    'липня',
    'серпня',
    'вересня',
    'жовтня',
    'листопада',
    'грудня'
  ];

  return months[Number(month)] || '';
}


/**
 * ============================================================
 * УСПІШНА ПЕРЕВІРКА
 * ============================================================
 */

function markSuccessfulCheck(properties) {
  properties.setProperty('LAST_SUCCESSFUL_CHECK', new Date().toISOString());
  properties.deleteProperty('LAST_ERROR');
}


/**
 * ============================================================
 * API
 * ============================================================
 */

function getRawAlertData() {
  const retryDelays = [0, 5000, 15000];

  let lastStatusCode = null;
  let lastResponseText = '';

  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    if (retryDelays[attempt] > 0) {
      Utilities.sleep(retryDelays[attempt]);
    }

    const response = UrlFetchApp.fetch(CONFIG.API_URL, {
      method: 'get',
      followRedirects: true,
      muteHttpExceptions: true,
      headers: {
        Accept: 'application/json'
      }
    });

    lastStatusCode = response.getResponseCode();
    lastResponseText = response.getContentText('UTF-8');

    if (lastStatusCode === 200) {
      let data;

      try {
        data = JSON.parse(lastResponseText);
      } catch (error) {
        throw new Error('API повернув некоректний JSON.');
      }

      if (!Object.prototype.hasOwnProperty.call(data, 'raw')) {
        throw new Error(
          'У відповіді Ubilling відсутній ключ raw. Структура API могла змінитися.'
        );
      }

      return data;
    }

    if (
      lastStatusCode === 429 ||
      (lastStatusCode >= 500 && lastStatusCode <= 599)
    ) {
      console.log(
        'Тимчасова помилка API ' +
          lastStatusCode +
          '. Спроба ' +
          (attempt + 1) +
          ' із ' +
          retryDelays.length +
          '.'
      );
      continue;
    }

    throw new Error(
      'API повернув HTTP-код ' +
        lastStatusCode +
        ': ' +
        lastResponseText
    );
  }

  throw new Error(
    'Не вдалося отримати дані після повторних спроб. Останній HTTP-код: ' +
      lastStatusCode
  );
}

function normalizeRawPayload(apiData) {
  let raw = apiData.raw;

  for (let i = 0; i < 3; i++) {
    if (typeof raw !== 'string') break;

    const trimmed = raw.trim();
    if (!trimmed) break;

    try {
      raw = JSON.parse(trimmed);
    } catch (error) {
      break;
    }
  }

  return raw;
}

function findAlertsBundle(value, depth) {
  depth = depth || 0;

  if (depth > 6 || value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    if (looksLikeAlertsArray(value)) {
      return {
        alerts: value,
        meta: {}
      };
    }

    for (let i = 0; i < value.length; i++) {
      const nested = findAlertsBundle(value[i], depth + 1);
      if (nested) return nested;
    }

    return null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value.alerts)) {
    return {
      alerts: value.alerts,
      meta:
        value.meta && typeof value.meta === 'object'
          ? value.meta
          : {}
    };
  }

  const keys = Object.keys(value);

  for (let i = 0; i < keys.length; i++) {
    const nested = findAlertsBundle(value[keys[i]], depth + 1);
    if (nested) return nested;
  }

  return null;
}

function looksLikeAlertsArray(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }

  return value.some(function (item) {
    return (
      item &&
      typeof item === 'object' &&
      (Object.prototype.hasOwnProperty.call(item, 'alert_type') ||
        Object.prototype.hasOwnProperty.call(item, 'location_uid') ||
        Object.prototype.hasOwnProperty.call(item, 'location_title'))
    );
  });
}

function getDistrictAlertSnapshot() {
  const apiData = getRawAlertData();
  const rawPayload = normalizeRawPayload(apiData);
  const bundle = findAlertsBundle(rawPayload, 0);

  if (!bundle || !Array.isArray(bundle.alerts)) {
    throw new Error(
      'Не вдалося знайти масив alerts у raw-даних alerts.in.ua. Помилковий відбій не публікувався.'
    );
  }

  const relevantAlerts = bundle.alerts.filter(
    isRelevantActiveAirRaidAlert
  );

  const level = resolveHighestAlertLevel(relevantAlerts);
  const startedAt = getEarliestAlertStart(relevantAlerts);

  return {
    level: level,
    active: level !== 'NONE',
    startedAt: startedAt,
    matchedCount: relevantAlerts.length,
    totalActiveAlerts: bundle.alerts.length,
    sourceUpdatedAt:
      bundle.meta && bundle.meta.last_updated_at
        ? String(bundle.meta.last_updated_at)
        : '',
    matchedAlerts: relevantAlerts.map(function (alert) {
      return {
        id: alert.id || '',
        location_uid: alert.location_uid,
        location_title: alert.location_title,
        location_type: alert.location_type,
        alert_type: alert.alert_type,
        alert_level: alert.alert_level || null,
        resolved_level: resolveSingleAlertLevel(alert),
        started_at: alert.started_at,
        threats: Array.isArray(alert.threats) ? alert.threats : []
      };
    })
  };
}

function isRelevantActiveAirRaidAlert(alert) {
  if (!alert || typeof alert !== 'object') return false;

  if (normalizeValue(alert.alert_type) !== 'air_raid') {
    return false;
  }

  if (
    alert.finished_at !== null &&
    alert.finished_at !== undefined &&
    String(alert.finished_at).trim() !== ''
  ) {
    return false;
  }

  return isRelevantLocation(alert);
}

function isRelevantLocation(alert) {
  const locationUid = String(
    alert.location_uid === null || alert.location_uid === undefined
      ? ''
      : alert.location_uid
  );

  const locationTitle = normalizeText(alert.location_title);
  const locationType = normalizeValue(alert.location_type);

  const directDistrict =
    locationUid === CONFIG.DISTRICT_UID ||
    (locationTitle === normalizeText(CONFIG.DISTRICT_NAME) &&
      (locationType === '' || locationType === 'raion'));

  const wholeOblast =
    locationUid === CONFIG.OBLAST_UID ||
    (locationTitle === normalizeText(CONFIG.OBLAST_NAME) &&
      (locationType === '' || locationType === 'oblast'));

  return directDistrict || wholeOblast;
}

function resolveSingleAlertLevel(alert) {
  const directLevel = normalizeValue(alert.alert_level);

  if (directLevel === 'red') return 'RED';
  if (directLevel === 'yellow') return 'YELLOW';

  if (Array.isArray(alert.threats)) {
    let hasYellow = false;

    for (let i = 0; i < alert.threats.length; i++) {
      const threatLevel = normalizeValue(alert.threats[i].level);

      if (threatLevel === 'red') return 'RED';
      if (threatLevel === 'yellow') hasYellow = true;
    }

    if (hasYellow) return 'YELLOW';
  }

  // Старий формат активної air_raid без рівня.
  return 'RED';
}

function resolveHighestAlertLevel(alerts) {
  let hasYellow = false;

  for (let i = 0; i < alerts.length; i++) {
    const level = resolveSingleAlertLevel(alerts[i]);

    if (level === 'RED') return 'RED';
    if (level === 'YELLOW') hasYellow = true;
  }

  return hasYellow ? 'YELLOW' : 'NONE';
}

function getEarliestAlertStart(alerts) {
  let earliest = null;

  alerts.forEach(function (alert) {
    const parsed = parseApiTimestamp(alert.started_at);
    if (parsed === null) return;

    if (earliest === null || parsed < earliest) {
      earliest = parsed;
    }
  });

  return earliest;
}

function saveSnapshotMetadata(properties, snapshot) {
  properties.setProperty(
    'LAST_SOURCE_UPDATED_AT',
    String(snapshot.sourceUpdatedAt || '')
  );

  properties.setProperty(
    'LAST_MATCHED_ALERTS_COUNT',
    String(snapshot.matchedCount)
  );

  properties.setProperty(
    'LAST_TOTAL_ACTIVE_ALERTS_COUNT',
    String(snapshot.totalActiveAlerts)
  );

  properties.setProperty('LAST_RESOLVED_LEVEL', String(snapshot.level));
}


/**
 * ============================================================
 * ЧАС / ТРИВАЛІСТЬ
 * ============================================================
 */

function parseApiTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (value instanceof Date) {
    const dateValue = value.getTime();
    return Number.isFinite(dateValue) ? dateValue : null;
  }

  const valueText = String(value).trim();

  if (/^\d+(\.\d+)?$/.test(valueText)) {
    const numericValue = Number(valueText);

    if (Number.isFinite(numericValue)) {
      return numericValue < 1000000000000
        ? Math.round(numericValue * 1000)
        : Math.round(numericValue);
    }
  }

  const directParsed = Date.parse(valueText);

  if (!Number.isNaN(directParsed)) {
    return directParsed;
  }

  const formats = [
    'yyyy-MM-dd HH:mm:ss',
    'yyyy-MM-dd HH:mm',
    'dd.MM.yyyy HH:mm:ss',
    'dd.MM.yyyy HH:mm'
  ];

  for (let i = 0; i < formats.length; i++) {
    try {
      const parsedDate = Utilities.parseDate(
        valueText,
        CONFIG.API_TIMEZONE,
        formats[i]
      );

      const parsedValue = parsedDate.getTime();
      if (Number.isFinite(parsedValue)) return parsedValue;
    } catch (error) {
      // наступний формат
    }
  }

  return null;
}

function valueToTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  return parseApiTimestamp(value);
}

function syncStoredAlertStart(properties, sourceStartedAt, fallbackNow) {
  const storedValue = properties.getProperty('ALERT_STARTED_AT');
  const storedTimestamp = storedValue ? Number(storedValue) : null;

  let candidate = Number(sourceStartedAt);

  if (!Number.isFinite(candidate) || candidate <= 0) {
    candidate = Number(fallbackNow);
  }

  if (
    !storedTimestamp ||
    !Number.isFinite(storedTimestamp) ||
    storedTimestamp <= 0 ||
    candidate < storedTimestamp
  ) {
    properties.setProperty('ALERT_STARTED_AT', String(candidate));
  }
}

function getStoredAlertStartTimestamp(properties, fallbackTimestamp) {
  const storedStart = properties.getProperty('ALERT_STARTED_AT');

  if (storedStart) {
    const numericStart = Number(storedStart);

    if (Number.isFinite(numericStart) && numericStart > 0) {
      return numericStart;
    }
  }

  console.log(
    'Час початку тривоги не знайдено. Використано резервний час.'
  );

  return Number(fallbackTimestamp);
}

function calculateDurationMilliseconds(startedAt, endedAt) {
  let start = Number(startedAt);
  let end = Number(endedAt);

  if (!Number.isFinite(end) || end <= 0) {
    end = Date.now();
  }

  if (!Number.isFinite(start) || start <= 0 || start > end) {
    start = end;
  }

  return Math.max(60 * 1000, end - start);
}

function formatAlertDuration(durationMilliseconds) {
  const totalMinutes = Math.max(
    1,
    Math.round(Number(durationMilliseconds) / (60 * 1000))
  );

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (hours > 0) {
    parts.push(
      hours +
        ' ' +
        ukrainianPlural(hours, 'годину', 'години', 'годин')
    );
  }

  if (minutes > 0 || hours === 0) {
    parts.push(
      minutes +
        ' ' +
        ukrainianPlural(minutes, 'хвилину', 'хвилини', 'хвилин')
    );
  }

  return parts.join(' ');
}

function formatDurationShort(durationMilliseconds) {
  const totalMinutes = Math.max(
    0,
    Math.round(Number(durationMilliseconds || 0) / 60000)
  );

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return hours + ' год ' + minutes + ' хв';
  }

  if (hours > 0) {
    return hours + ' год';
  }

  return minutes + ' хв';
}

function ukrainianPlural(number, formOne, formFew, formMany) {
  const absoluteNumber = Math.abs(Number(number));
  const lastTwoDigits = absoluteNumber % 100;
  const lastDigit = absoluteNumber % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return formMany;
  if (lastDigit === 1) return formOne;
  if (lastDigit >= 2 && lastDigit <= 4) return formFew;

  return formMany;
}

function isTruthySheetValue(value) {
  if (value === true) return true;

  const normalized = normalizeValue(value);
  return normalized === 'true' || normalized === 'так' || normalized === '1';
}


/**
 * ============================================================
 * ТЕКСТ ПОВІДОМЛЕНЬ
 * ============================================================
 */

function appendChannelFooter(message) {
  return message + '\n\n' + CONFIG.CHANNEL_FOOTER;
}

function buildClearMessage(durationMilliseconds) {
  let message = CONFIG.CLEAR_MESSAGE_TITLE;

  if (
    durationMilliseconds !== null &&
    durationMilliseconds !== undefined
  ) {
    message +=
      '\n\n' +
      'Повітряна тривога тривала ' +
      formatAlertDuration(durationMilliseconds) +
      '.';
  }

  return appendChannelFooter(message);
}

function publishRealState(level, durationMilliseconds) {
  let message;

  if (level === 'RED') {
    message = appendChannelFooter(CONFIG.RED_MESSAGE);
  } else if (level === 'YELLOW') {
    message = appendChannelFooter(CONFIG.YELLOW_MESSAGE);
  } else if (level === 'NONE') {
    message = buildClearMessage(durationMilliseconds);
  } else {
    throw new Error('Невідомий рівень для публікації: ' + level);
  }

  const telegramResponse = sendTelegramMessage(message, false);
  const messageId = getTelegramMessageId(telegramResponse);

  addMessageToDeletionQueue(
    messageId,
    CONFIG.AUTO_DELETE_AFTER_HOURS * 60 * 60 * 1000
  );

  console.log(
    'Повідомлення опубліковано. Рівень: ' +
      level +
      '. Telegram ID: ' +
      messageId +
      '. Видалення через ' +
      CONFIG.AUTO_DELETE_AFTER_HOURS +
      ' год.'
  );

  return messageId;
}


/**
 * ============================================================
 * TELEGRAM
 * ============================================================
 */

// Приховує токен навіть тоді, коли зовнішній API згадав його в описі помилки.
function redactToken_(message) {
  const text = String(message || '');
  return CONFIG.TELEGRAM_BOT_TOKEN
    ? text.split(CONFIG.TELEGRAM_BOT_TOKEN).join('[REDACTED_BOT_TOKEN]')
    : text;
}

// Повертає true для 22:00–06:59 за Києвом, у тому числі при переходах на літній час.
function isQuietHours_(when) {
  const hour = Number(
    Utilities.formatDate(when || new Date(), CONFIG.API_TIMEZONE, 'H')
  );
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error('Не вдалося визначити місцеву годину.');
  }
  if (CONFIG.QUIET_HOURS_START < CONFIG.QUIET_HOURS_END) {
    return hour >= CONFIG.QUIET_HOURS_START && hour < CONFIG.QUIET_HOURS_END;
  }
  return hour >= CONFIG.QUIET_HOURS_START || hour < CONFIG.QUIET_HOURS_END;
}

function sendTelegramMessage(text, silent, atDate) {
  // silent=true (наприклад, тест) також примушує тиху відправку.
  const useSilentMode = Boolean(silent) || isQuietHours_(atDate || new Date());
  const url =
    'https://api.telegram.org/bot' +
    CONFIG.TELEGRAM_BOT_TOKEN +
    '/sendMessage';

  let response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        chat_id: CONFIG.TARGET_CHAT_ID,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: useSilentMode
      })
    });
  } catch (error) {
    // Мережеві винятки можуть містити URL з токеном у тексті.
    throw new Error('Не вдалося зʼєднатися з Telegram API: ' + redactToken_(error.message));
  }

  const statusCode = response.getResponseCode();
  const responseText = response.getContentText('UTF-8');

  let result;

  try {
    result = JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      'Telegram повернув некоректну відповідь: ' + redactToken_(responseText)
    );
  }

  if (statusCode !== 200 || !result.ok) {
    throw new Error('Telegram не прийняв повідомлення: ' + redactToken_(responseText));
  }

  return result;
}

function getTelegramMessageId(telegramResponse) {
  const messageId =
    telegramResponse &&
    telegramResponse.result &&
    telegramResponse.result.message_id;

  if (!messageId) {
    throw new Error('Telegram не повернув message_id.');
  }

  return Number(messageId);
}


/**
 * ============================================================
 * ЧЕРГА ВИДАЛЕННЯ TELEGRAM
 * ============================================================
 */

function addMessageToDeletionQueue(messageId, delayMilliseconds) {
  const properties = PropertiesService.getScriptProperties();
  let queue = getDeletionQueue(properties);
  const now = Date.now();

  queue = queue.filter(function (item) {
    return Number(item.messageId) !== Number(messageId);
  });

  queue.push({
    messageId: Number(messageId),
    deleteAfter: now + Number(delayMilliseconds),
    expiresAt: now + 47 * 60 * 60 * 1000
  });

  saveDeletionQueue(properties, queue);

  console.log(
    'Повідомлення ' + messageId + ' додано до черги видалення.'
  );
}

function getDeletionQueue(properties) {
  const savedQueue = properties.getProperty('DELETE_QUEUE');
  if (!savedQueue) return [];

  let queue;

  try {
    queue = JSON.parse(savedQueue);
  } catch (error) {
    throw new Error('Не вдалося прочитати чергу видалення.');
  }

  if (!Array.isArray(queue)) {
    throw new Error('Черга видалення має некоректний формат.');
  }

  return queue;
}

function saveDeletionQueue(properties, queue) {
  if (queue.length === 0) {
    properties.deleteProperty('DELETE_QUEUE');
    return;
  }

  properties.setProperty('DELETE_QUEUE', JSON.stringify(queue));
}

function cleanupOldAlertMessages() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    console.log('Очищення пропущено: інша функція вже виконується.');
    return;
  }

  try {
    const properties = PropertiesService.getScriptProperties();
    const queue = getDeletionQueue(properties);

    if (queue.length === 0) {
      console.log('Немає повідомлень для видалення.');
      return;
    }

    const now = Date.now();
    const remainingQueue = [];

    queue.forEach(function (item) {
      if (now < Number(item.deleteAfter)) {
        remainingQueue.push(item);
        return;
      }

      if (now >= Number(item.expiresAt)) {
        console.error(
          'Повідомлення ' +
            item.messageId +
            ' вилучено з черги: завершився допустимий час видалення.'
        );
        return;
      }

      try {
        deleteTelegramMessage(item.messageId);

        console.log(
          'Повідомлення ' + item.messageId + ' успішно видалено.'
        );
      } catch (error) {
        if (isMessageAlreadyDeletedError(error.message)) {
          console.log(
            'Повідомлення ' + item.messageId + ' уже відсутнє в каналі.'
          );
          return;
        }

        remainingQueue.push(item);

        console.error(
          'Не вдалося видалити повідомлення ' +
            item.messageId +
            ': ' +
            error.message
        );
      }
    });

    saveDeletionQueue(properties, remainingQueue);
  } finally {
    lock.releaseLock();
  }
}

function deleteTelegramMessage(messageId) {
  const url =
    'https://api.telegram.org/bot' +
    CONFIG.TELEGRAM_BOT_TOKEN +
    '/deleteMessage';

  let response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        chat_id: CONFIG.TARGET_CHAT_ID,
        message_id: Number(messageId)
      })
    });
  } catch (error) {
    throw new Error('Не вдалося зʼєднатися з Telegram API: ' + redactToken_(error.message));
  }

  const statusCode = response.getResponseCode();
  const responseText = response.getContentText('UTF-8');

  let result;

  try {
    result = JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      'Telegram повернув некоректну відповідь: ' + redactToken_(responseText)
    );
  }

  if (statusCode !== 200 || !result.ok) {
    throw new Error('Помилка видалення: ' + redactToken_(responseText));
  }

  return result;
}

function isMessageAlreadyDeletedError(errorText) {
  const normalized = String(errorText).toLowerCase();

  return (
    normalized.indexOf('message to delete not found') !== -1 ||
    normalized.indexOf('message_id_invalid') !== -1
  );
}


/**
 * ============================================================
 * ТРИГЕРИ
 * ============================================================
 */

function setupAutomation() {
  validateConfig();
  ensureHistorySheets();

  removeTriggersByFunctionNames([
    'checkAirAlert',
    'cleanupOldAlertMessages',
    'sendWeeklyStatistics',
    'runTestCleanup'
  ]);

  // Перевірка тривог щохвилини.
  ScriptApp.newTrigger('checkAirAlert')
    .timeBased()
    .everyMinutes(1)
    .create();

  // Видалення Telegram-повідомлень приблизно через 24 год.
  ScriptApp.newTrigger('cleanupOldAlertMessages')
    .timeBased()
    .everyMinutes(5)
    .create();

  // Щопонеділка приблизно в задану годину за Києвом.
  ScriptApp.newTrigger('sendWeeklyStatistics')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(CONFIG.WEEKLY_REPORT_HOUR)
    .everyWeeks(1)
    .inTimezone(CONFIG.API_TIMEZONE)
    .create();

  cleanupOldAlertMessages();

  console.log(
    'Автоматизацію створено: тривоги — щохвилини, видалення — кожні 5 хвилин, тижневий звіт — щопонеділка.'
  );
}

function removeAutomation() {
  removeTriggersByFunctionNames([
    'checkAirAlert',
    'cleanupOldAlertMessages',
    'sendWeeklyStatistics',
    'runTestCleanup'
  ]);

  console.log('Автоматичні тригери видалено.');
}

function removeTriggersByFunctionNames(functionNames) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    const handler = trigger.getHandlerFunction();

    if (functionNames.indexOf(handler) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}


/**
 * ============================================================
 * ТЕСТИ
 * ============================================================
 */

function testDistrictLevelsApi() {
  validateConfig();

  const snapshot = getDistrictAlertSnapshot();

  console.log(
    JSON.stringify(
      {
        district: CONFIG.DISTRICT_NAME,
        districtUid: CONFIG.DISTRICT_UID,
        resolvedLevel: snapshot.level,
        active: snapshot.active,
        matchedCount: snapshot.matchedCount,
        totalActiveAlertsInSource: snapshot.totalActiveAlerts,
        startedAt: snapshot.startedAt
          ? new Date(snapshot.startedAt).toISOString()
          : null,
        sourceUpdatedAt: snapshot.sourceUpdatedAt,
        matchedAlerts: snapshot.matchedAlerts
      },
      null,
      2
    )
  );
}

function testYellowMessage() {
  publishTestMessage(
    '🧪 <b>ТЕСТ СИСТЕМИ ОПОВІЩЕННЯ</b>' +
      '\n\n' +
      appendChannelFooter(CONFIG.YELLOW_MESSAGE) +
      '\n\n' +
      '<i>Це тестове повідомлення буде автоматично видалене.</i>'
  );
}

function testRedMessage() {
  publishTestMessage(
    '🧪 <b>ТЕСТ СИСТЕМИ ОПОВІЩЕННЯ</b>' +
      '\n\n' +
      appendChannelFooter(CONFIG.RED_MESSAGE) +
      '\n\n' +
      '<i>Це тестове повідомлення буде автоматично видалене.</i>'
  );
}

function testClearMessageWithDuration() {
  const sampleDuration = (2 * 60 + 17) * 60 * 1000;

  publishTestMessage(
    '🧪 <b>ТЕСТ СИСТЕМИ ОПОВІЩЕННЯ</b>' +
      '\n\n' +
      buildClearMessage(sampleDuration) +
      '\n\n' +
      '<i>Це тестове повідомлення буде автоматично видалене.</i>'
  );
}

function publishTestMessage(text) {
  validateConfig();

  const response = sendTelegramMessage(text, true);
  const messageId = getTelegramMessageId(response);

  addMessageToDeletionQueue(messageId, 2 * 60 * 1000);
  scheduleTestCleanup();

  console.log('Тестове повідомлення опубліковано. ID: ' + messageId);
}

function scheduleTestCleanup() {
  removeTriggersByFunctionNames(['runTestCleanup']);

  ScriptApp.newTrigger('runTestCleanup')
    .timeBased()
    .after(3 * 60 * 1000)
    .create();
}

function runTestCleanup() {
  try {
    cleanupOldAlertMessages();
  } finally {
    removeTriggersByFunctionNames(['runTestCleanup']);
  }
}


/**
 * ============================================================
 * СТАН СИСТЕМИ / RESET
 * ============================================================
 */

function showSystemStatus() {
  const p = PropertiesService.getScriptProperties();
  const safeKeys = [
    'ALERT_SCOPE_KEY', 'LAST_ALERT_LEVEL', 'LAST_RESOLVED_LEVEL',
    'ALERT_STARTED_AT', 'LAST_SOURCE_UPDATED_AT',
    'LAST_MATCHED_ALERTS_COUNT', 'LAST_TOTAL_ACTIVE_ALERTS_COUNT',
    'LAST_SUCCESSFUL_CHECK', 'LAST_WEEKLY_REPORT_KEY'
  ];
  const status = {};
  safeKeys.forEach(function (key) { status[key] = p.getProperty(key); });
  status.hasRecordedError = Boolean(p.getProperty('LAST_ERROR') || p.getProperty('LAST_HISTORY_ERROR'));
  status.telegramConfigured = Boolean(CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TARGET_CHAT_ID);
  status.historyConfigured = Boolean(CONFIG.HISTORY_SPREADSHEET_ID);
  status.quietHours = CONFIG.QUIET_HOURS_START + ':00–' + CONFIG.QUIET_HOURS_END + ':00 ' + CONFIG.API_TIMEZONE;
  // Навмисно НЕ виводимо всі Properties: серед них є Telegram-токен.
  console.log(JSON.stringify(status, null, 2));
}

function resetAlertState() {
  const properties = PropertiesService.getScriptProperties();

  [
    'ALERT_SCOPE_KEY',
    'LAST_ALERT_STATE',
    'LAST_ALERT_LEVEL',
    'LAST_RESOLVED_LEVEL',
    'ALERT_STARTED_AT',
    'CURRENT_ALERT_ID',
    'HISTORY_REGISTERED_ALERT_ID',
    'LAST_ACTIVE_LEVEL_MESSAGE_ID',
    'LAST_SOURCE_UPDATED_AT',
    'LAST_MATCHED_ALERTS_COUNT',
    'LAST_TOTAL_ACTIVE_ALERTS_COUNT',
    'LAST_SUCCESSFUL_CHECK',
    'LAST_ERROR',
    'LAST_HISTORY_ERROR',
    'LAST_WEEKLY_REPORT_KEY'
  ].forEach(function (key) {
    properties.deleteProperty(key);
  });

  console.log(
    'Збережений стан очищено. DELETE_QUEUE та дані Google Sheets не видалено.'
  );
}


/**
 * ============================================================
 * ДОПОМІЖНІ
 * ============================================================
 */

function normalizeText(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeValue(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .trim();
}

function formatLevel(level) {
  if (level === 'RED') return '🔴 ЧЕРВОНИЙ';
  if (level === 'YELLOW') return '🟡 ЖОВТИЙ';
  if (level === 'NONE') return '🟢 ВІДБІЙ';

  return String(level);
}

function stripHtmlTags(text) {
  return String(text || '').replace(/<[^>]*>/g, '');
}

function validateConfig() {
  if (!CONFIG.API_URL) {
    throw new Error('Заповніть API_URL.');
  }

  if (!CONFIG.DISTRICT_UID || !CONFIG.DISTRICT_NAME) {
    throw new Error('Заповніть DISTRICT_UID і DISTRICT_NAME.');
  }

  if (
    !CONFIG.TELEGRAM_BOT_TOKEN ||
    CONFIG.TELEGRAM_BOT_TOKEN.indexOf('ВСТАВТЕ') !== -1
  ) {
    throw new Error('Вкажіть TELEGRAM_BOT_TOKEN у Script Properties.');
  }

  if (
    !CONFIG.TARGET_CHAT_ID ||
    CONFIG.TARGET_CHAT_ID.indexOf('ВСТАВТЕ') !== -1
  ) {
    throw new Error('Вкажіть TARGET_CHAT_ID у Script Properties.');
  }

  if (
    !CONFIG.AUTO_DELETE_AFTER_HOURS ||
    CONFIG.AUTO_DELETE_AFTER_HOURS <= 0 ||
    CONFIG.AUTO_DELETE_AFTER_HOURS >= 48
  ) {
    throw new Error(
      'AUTO_DELETE_AFTER_HOURS має бути більше 0 і менше 48.'
    );
  }

  if (!CONFIG.CHANNEL_FOOTER) {
    throw new Error('Вкажіть CHANNEL_FOOTER у Script Properties.');
  }

  if (!CONFIG.HISTORY_SPREADSHEET_ID) {
    throw new Error('Вкажіть HISTORY_SPREADSHEET_ID у Script Properties.');
  }

  if (
    !Number.isInteger(CONFIG.QUIET_HOURS_START) ||
    !Number.isInteger(CONFIG.QUIET_HOURS_END) ||
    CONFIG.QUIET_HOURS_START < 0 || CONFIG.QUIET_HOURS_START > 23 ||
    CONFIG.QUIET_HOURS_END < 0 || CONFIG.QUIET_HOURS_END > 23 ||
    CONFIG.QUIET_HOURS_START === CONFIG.QUIET_HOURS_END
  ) {
    throw new Error('Некоректні години тихого режиму.');
  }

  if (
    !Number.isInteger(CONFIG.WEEKLY_REPORT_HOUR) ||
    CONFIG.WEEKLY_REPORT_HOUR < 0 ||
    CONFIG.WEEKLY_REPORT_HOUR > 23
  ) {
    throw new Error('WEEKLY_REPORT_HOUR має бути від 0 до 23.');
  }
}
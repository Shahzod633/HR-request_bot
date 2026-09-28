/**
 * HR Request Center — Apps Script backend.
 *
 * Живёт внутри Google-таблицы (Extensions → Apps Script).
 * Принимает POST-запросы от Cloudflare Worker'а и пишет данные в матрицу
 * "сотрудник × дата". Ничего не знает про Telegram — просто получает
 * готовые события и кладёт их в нужные ячейки.
 *
 * Структура:
 *  - Лист "Employees" — мастер-список всех когда-либо зарегистрированных
 *    сотрудников (telegram id, имя, отдел, менеджер). Источник правды для
 *    заполнения новых месячных листов.
 *  - Лист на каждый месяц (например "Sep 2026") — строки это сотрудники
 *    (колонка A), столбцы B..AF это дни месяца. Создаётся автоматически
 *    при первом обращении к этому месяцу (в том числе заранее, если
 *    Vacation/Long-Term Leave заходит в будущий месяц).
 */

const SHEET_EMPLOYEES = 'Employees';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const expected = PropertiesService.getScriptProperties().getProperty('SECRET_TOKEN');

    if (!expected) {
      return jsonResponse_({ success: false, error: 'SECRET_TOKEN не задан в Script Properties' }, 500);
    }
    if (!body.secret || body.secret !== expected) {
      return jsonResponse_({ success: false, error: 'unauthorized' }, 401);
    }

    if (body.action === 'register') {
      return jsonResponse_(handleRegister_(body));
    }
    if (body.action === 'report') {
      return jsonResponse_(handleReport_(body));
    }
    if (body.action === 'day_off_balance') {
      return jsonResponse_(handleDayOffBalance_(body));
    }
    if (body.action === 'list_employees') {
      return jsonResponse_(handleListEmployees_());
    }
    if (body.action === 'update_username') {
      return jsonResponse_(handleUpdateUsername_(body));
    }
    if (body.action === 'register_role') {
      return jsonResponse_(handleRegisterRole_(body));
    }
    if (body.action === 'update_shift') {
      return jsonResponse_(handleUpdateShift_(body));
    }
    if (body.action === 'update_name') {
      return jsonResponse_(handleUpdateName_(body));
    }
    if (body.action === 'update_department') {
      return jsonResponse_(handleUpdateDepartment_(body));
    }
    if (body.action === 'late_checkin_count') {
      return jsonResponse_(handleLateCheckinCount_(body));
    }
    return jsonResponse_({ success: false, error: 'unknown action: ' + body.action }, 400);
  } catch (err) {
    return jsonResponse_({ success: false, error: String(err) }, 500);
  }
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Employees (master roster) ----------

function getOrCreateEmployeesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_EMPLOYEES);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_EMPLOYEES);
    sheet.getRange(1, 1, 1, 8).setValues([
      [
        'Telegram ID', 'Name', 'Department', 'Manager',
        'Username', 'Shift Start', 'Role', 'Registered',
      ],
    ]);
    sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function handleRegister_(body) {
  const telegramId = body.telegramId;
  const name = String(body.name || '').trim();
  const department = body.department;
  const manager = body.manager;

  if (!telegramId || !name) {
    return { success: false, error: 'telegramId и name обязательны' };
  }

  const empSheet = getOrCreateEmployeesSheet_();
  const lastRow = empSheet.getLastRow();

  if (lastRow >= 2) {
    const ids = empSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(telegramId)) {
        // уже зарегистрирован — возвращаем существующее имя, ничего не дублируем
        const existingName = empSheet.getRange(i + 2, 2).getValue();
        return { success: true, alreadyRegistered: true, name: existingName };
      }
    }
  }

  const username = String(body.username || '').replace(/^@/, '');
  const scheduledStart = String(body.scheduledStart || '');
  // Shift Start дописываем отдельно, текстом: через appendRow "20:00" стало бы временем
  empSheet.appendRow([
    telegramId, name, department, manager, username, '', 'Employee', new Date(),
  ]);
  if (scheduledStart) {
    const row = findEmployeeRow_(empSheet, telegramId);
    if (row !== -1) writeShiftStart_(empSheet, row, scheduledStart);
  }

  // если текущий месячный лист уже существует — добавим туда сотрудника сразу,
  // иначе он подтянется автоматически при создании листа (см. getOrCreateMonthSheet_)
  const now = new Date();
  const existingMonthSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(monthSheetName_(now));
  if (existingMonthSheet) {
    getOrCreateEmployeeRow_(existingMonthSheet, name);
  }

  return { success: true, name: name };
}

function handleUpdateUsername_(body) {
  const telegramId = body.telegramId;
  const username = String(body.username || '').replace(/^@/, '');
  if (!telegramId) {
    return { success: false, error: 'telegramId обязателен' };
  }

  const empSheet = getOrCreateEmployeesSheet_();
  const lastRow = empSheet.getLastRow();
  if (lastRow < 2) return { success: true, updated: false };

  const ids = empSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(telegramId)) {
      empSheet.getRange(i + 2, 5).setValue(username);
      return { success: true, updated: true };
    }
  }
  return { success: true, updated: false };
}

/**
 * HR, менеджеры и Super Admin тоже попадают в лист Employees — с пометкой роли,
 * чтобы по Telegram ID было видно, кто именно этой ролью занят.
 */
function handleRegisterRole_(body) {
  const telegramId = body.telegramId;
  const name = String(body.name || '').trim();
  const role = String(body.role || '');
  if (!telegramId || !name || !role) {
    return { success: false, error: 'telegramId, name и role обязательны' };
  }

  const department = String(body.department || '');
  const username = String(body.username || '').replace(/^@/, '');
  const empSheet = getOrCreateEmployeesSheet_();
  const lastRow = empSheet.getLastRow();

  if (lastRow >= 2) {
    const ids = empSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(telegramId)) {
        const row = i + 2;
        empSheet.getRange(row, 2).setValue(name);
        empSheet.getRange(row, 3).setValue(department);
        if (username) empSheet.getRange(row, 5).setValue(username);
        empSheet.getRange(row, 7).setValue(role);
        return { success: true, updated: true };
      }
    }
  }

  empSheet.appendRow([telegramId, name, department, '', username, '', role, new Date()]);
  return { success: true, updated: false };
}

function handleUpdateShift_(body) {
  const telegramId = body.telegramId;
  const scheduledStart = String(body.scheduledStart || '');
  if (!telegramId || !scheduledStart) {
    return { success: false, error: 'telegramId и scheduledStart обязательны' };
  }

  const empSheet = getOrCreateEmployeesSheet_();
  const lastRow = empSheet.getLastRow();
  if (lastRow < 2) return { success: true, updated: false };

  const ids = empSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(telegramId)) {
      writeShiftStart_(empSheet, i + 2, scheduledStart);
      return { success: true, updated: true };
    }
  }
  return { success: true, updated: false };
}

/**
 * Shift Start храним текстом. Строку "20:00" Sheets сам распознаёт как время и
 * хранит числом от 30.12.1899 — getValues() потом отдаёт Date, а не "20:00".
 */
function writeShiftStart_(empSheet, row, scheduledStart) {
  empSheet.getRange(row, 6).setNumberFormat('@').setValue(scheduledStart);
}

/**
 * Защита для уже испорченных записей: Date из колонки Shift Start → "HH:mm".
 * Sheets строит этот Date по часовому поясу таблицы — им же форматируем обратно,
 * иначе при расхождении с поясом скрипта время съедет (21:00 вместо 20:00).
 */
function shiftStartToText_(value, spreadsheetTz) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, spreadsheetTz, 'HH:mm');
  }
  return String(value || '');
}

/** Строка сотрудника в листе Employees по Telegram ID, или -1. */
function findEmployeeRow_(empSheet, telegramId) {
  const lastRow = empSheet.getLastRow();
  if (lastRow < 2) return -1;

  const ids = empSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(telegramId)) return i + 2;
  }
  return -1;
}

/**
 * Правка имени из "My Profile" (или Admin/Super Admin из списка сотрудников).
 * Новую запись не создаём — только обновляем найденную по telegramId, у HR,
 * менеджеров и Super Admin тоже.
 */
function handleUpdateName_(body) {
  const telegramId = body.telegramId;
  const name = String(body.name || '').trim();
  if (!telegramId || !name) {
    return { success: false, error: 'telegramId и name обязательны' };
  }

  const empSheet = getOrCreateEmployeesSheet_();
  const row = findEmployeeRow_(empSheet, telegramId);
  const oldNames = [];
  if (row !== -1) {
    oldNames.push(String(empSheet.getRange(row, 2).getValue()));
    empSheet.getRange(row, 2).setValue(name);
  }
  // имя, под которым Worker писал репорты, — если в Employees почему-то было другое
  const workerOldName = String(body.oldName || '').trim();
  if (workerOldName) oldNames.push(workerOldName);

  const renamed = renameInMonthSheets_(oldNames, name);
  return { success: true, updated: row !== -1, monthRowsRenamed: renamed };
}

/** Правка отдела из "My Profile" — только у обычных сотрудников, это проверяет Worker. */
function handleUpdateDepartment_(body) {
  const telegramId = body.telegramId;
  const department = String(body.department || '').trim();
  if (!telegramId || !department) {
    return { success: false, error: 'telegramId и department обязательны' };
  }

  const empSheet = getOrCreateEmployeesSheet_();
  const row = findEmployeeRow_(empSheet, telegramId);
  if (row === -1) return { success: true, updated: false };

  empSheet.getRange(row, 3, 1, 2).setValues([[department, String(body.manager || '')]]);
  return { success: true, updated: true };
}

/** Сколько раз сотрудник подавал Late Check-in в месяце указанной даты. */
function handleLateCheckinCount_(body) {
  return countReportsInMonth_(body, 'Late Check-in:');
}

function countReportsInMonth_(body, prefix) {
  const name = String(body.name || '').trim();
  if (!name || !body.referenceDate) {
    return { success: false, error: 'name и referenceDate обязательны' };
  }

  const refDate = parseISODate_(body.referenceDate);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(monthSheetName_(refDate));
  if (!sheet) return { success: true, count: 0 };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 2) return { success: true, count: 0 };

  const colA = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let rowIndex = -1;
  for (let i = 0; i < colA.length; i++) {
    if (colA[i][0] === name) {
      rowIndex = i + 2;
      break;
    }
  }
  if (rowIndex === -1) return { success: true, count: 0 };

  const values = sheet.getRange(rowIndex, 2, 1, lastCol - 1).getValues()[0];
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const cell = String(values[i] || '');
    if (!cell) continue;
    const lines = cell.split('\n');
    for (let j = 0; j < lines.length; j++) {
      if (lines[j].indexOf(prefix) === 0) count++;
    }
  }
  return { success: true, count: count };
}

function handleListEmployees_() {
  const empSheet = getOrCreateEmployeesSheet_();
  const lastRow = empSheet.getLastRow();
  if (lastRow < 2) {
    return { success: true, employees: [] };
  }

  const rows = empSheet.getRange(2, 1, lastRow - 1, 8).getValues();
  const spreadsheetTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const employees = [];
  for (let i = 0; i < rows.length; i++) {
    employees.push({
      // по telegramId Worker пишет сотруднику через бота и открывает его профиль
      telegramId: Number(rows[i][0]) || 0,
      name: String(rows[i][1] || ''),
      department: String(rows[i][2] || ''),
      username: String(rows[i][4] || ''),
      scheduledStart: shiftStartToText_(rows[i][5], spreadsheetTz),
      role: String(rows[i][6] || 'Employee'),
    });
  }
  return { success: true, employees: employees };
}

// ---------- Monthly matrix sheets ----------

function monthSheetName_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'MMM yyyy');
}

function getOrCreateMonthSheet_(date) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = monthSheetName_(date);
  let sheet = ss.getSheetByName(name);
  if (sheet) return sheet;

  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1).setValue('Employee / Date');

  const y = date.getFullYear();
  const m = date.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();

  const headers = [];
  for (let d = 1; d <= daysInMonth; d++) {
    headers.push(Utilities.formatDate(new Date(y, m, d), Session.getScriptTimeZone(), 'MM/dd/yyyy'));
  }
  sheet.getRange(1, 2, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length + 1).setFontWeight('bold').setBackground('#fff2cc');
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);

  // подтягиваем текущий состав сотрудников из мастер-листа
  const empSheet = getOrCreateEmployeesSheet_();
  const lastEmpRow = empSheet.getLastRow();
  if (lastEmpRow >= 2) {
    const names = empSheet.getRange(2, 2, lastEmpRow - 1, 1).getValues();
    if (names.length > 0) {
      sheet.getRange(2, 1, names.length, 1).setValues(names);
    }
  }

  return sheet;
}

/** Сколько месяцев вперёд проверять: Vacation/Long-Term Leave создают листы будущих месяцев заранее. */
const RENAME_MONTHS_AHEAD = 12;

/**
 * Переименовывает строку сотрудника (колонка A) в листе текущего месяца и в уже
 * созданных листах будущих месяцев. Новую строку не создаёт. Прошлые месяцы —
 * история на момент подачи заявок, их не трогаем.
 */
function renameInMonthSheets_(oldNames, newName) {
  const candidates = oldNames.filter(function (n) { return n && n !== newName; });
  if (candidates.length === 0) return 0;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const now = new Date();
  let renamed = 0;
  for (let k = 0; k <= RENAME_MONTHS_AHEAD; k++) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() + k, 1);
    const sheet = ss.getSheetByName(monthSheetName_(monthStart));
    if (!sheet) continue;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) continue;

    const colA = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    let oldRow = -1;
    let hasNewName = false;
    for (let i = 0; i < colA.length; i++) {
      if (colA[i][0] === newName) hasNewName = true;
      if (oldRow === -1 && candidates.indexOf(colA[i][0]) !== -1) oldRow = i + 2;
    }
    // строка с новым именем уже есть (репорт успел её создать) — вторую не делаем
    if (oldRow !== -1 && !hasNewName) {
      sheet.getRange(oldRow, 1).setValue(newName);
      renamed++;
    }
  }
  return renamed;
}

function getOrCreateEmployeeRow_(sheet, name) {
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const colA = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < colA.length; i++) {
      if (colA[i][0] === name) {
        return i + 2;
      }
    }
  }
  const newRow = lastRow < 2 ? 2 : lastRow + 1;
  sheet.getRange(newRow, 1).setValue(name);
  return newRow;
}

// ---------- Reports ----------

const REPORT_LABELS = {
  late_checkin: 'Late Check-in',
  early_leave: 'Early Leave',
  day_off: 'Day Off',
  emergency_leave: 'Emergency Leave',
  vacation: 'Vacation',
  long_term_leave: 'Long-Term Leave',
  resignation: 'Resignation',
};

const COLOR_HEX = {
  yellow: '#ffff00',
  red: '#ff0000',
};

function handleReport_(body) {
  const name = String(body.name || '').trim();
  const reportType = body.reportType;
  const details = body.details || '';
  const color = body.color; // 'yellow' | 'red' | undefined

  if (!name || !reportType || !body.startDate) {
    return { success: false, error: 'name, reportType и startDate обязательны' };
  }

  const start = parseISODate_(body.startDate);
  const end = body.endDate ? parseISODate_(body.endDate) : start;
  const label = REPORT_LABELS[reportType] || reportType;
  const text = label + ': ' + details;

  let cursor = new Date(start.getTime());
  let touched = 0;

  while (cursor.getTime() <= end.getTime()) {
    const sheet = getOrCreateMonthSheet_(cursor);
    const row = getOrCreateEmployeeRow_(sheet, name);
    const col = cursor.getDate() + 1; // колонка A = имя, B = день 1

    const cell = sheet.getRange(row, col);
    const existing = cell.getValue();
    cell.setValue(existing ? existing + '\n' + text : text);

    if (color && COLOR_HEX[color]) {
      cell.setBackground(COLOR_HEX[color]);
    }

    touched++;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }

  return { success: true, daysWritten: touched };
}

function parseISODate_(s) {
  // ожидается 'YYYY-MM-DD'
  const parts = s.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

// ---------- Day Off balance ----------

function handleDayOffBalance_(body) {
  const name = String(body.name || '').trim();
  if (!name || !body.referenceDate) {
    return { success: false, error: 'name и referenceDate обязательны' };
  }

  const refDate = parseISODate_(body.referenceDate);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(monthSheetName_(refDate));
  if (!sheet) {
    // лист текущего месяца ещё не создан — значит репортов не было вообще
    return { success: true, used: 0 };
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 2) {
    return { success: true, used: 0 };
  }

  const colA = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let rowIndex = -1;
  for (let i = 0; i < colA.length; i++) {
    if (colA[i][0] === name) {
      rowIndex = i + 2;
      break;
    }
  }
  if (rowIndex === -1) {
    return { success: true, used: 0 };
  }

  const values = sheet.getRange(rowIndex, 2, 1, lastCol - 1).getValues()[0];
  let used = 0;
  for (let i = 0; i < values.length; i++) {
    const cell = String(values[i] || '');
    if (!cell) continue;
    const lines = cell.split('\n');
    for (let j = 0; j < lines.length; j++) {
      if (lines[j].indexOf('Day Off:') === 0) {
        used++;
      }
    }
  }

  return { success: true, used: used };
}


import type { Env, ReportFlowState, Session, Employee } from '../types';
import {
  findReportType,
  ETA_OPTIONS,
  LATE_REASONS,
  DAY_OFF_MONTHLY_LIMIT,
  DAY_OFF_VISIBLE_LIMIT,
  LATE_CHECKIN_ALERT_THRESHOLD,
  MAX_LEAVE_DAYS,
  MAX_TEXT_ANSWER_LENGTH,
} from '../config';
import {
  sendMessage,
  answerCallbackQuery,
  editMessageReplyMarkup,
  editMessageText,
} from '../telegram';
import {
  buildDayPicker,
  calendarCaption,
  buildSmallDurationPicker,
  buildWeekDurationPicker,
  isDayBlocked,
  isRealDay,
} from '../calendar';
import { buildChoiceKeyboard, buildNoticeKeyboard, buildConfirmKeyboard } from '../keyboards';
import { saveSession } from '../session';
import { submitReport, type ReportPayload } from '../appsScriptClient';
import { getDayOffUsed, addDayOffUsed, bumpLateCount } from '../counters';
import { notifyResponsible, notifyHrAndAdmin, buildContactButtons } from './notify';
import { runInBackground } from '../background';
import { showHomeMenu } from './menu';
import {
  tjToday,
  formatISODate,
  addDaysISO,
  tjMinutesNow,
  tjClockNow,
  minutesToClock,
  minutesUntil,
  parseClock,
  HALF_DAY_MINUTES,
} from '../tjTime';

const BLOCK_DAYS: Record<string, number> = {
  day_off: 2,
  vacation: 14,
  long_term_leave: 14,
  early_leave: -1, // сегодня разрешён, ничего не блокируем
};

// ---------- запуск флоу из главного меню ----------

export async function startReportFlow(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  reportType: string
) {
  const rt = findReportType(reportType);
  if (!rt || !session.employee) return;

  if (reportType === 'day_off') {
    const used = await getDayOffUsed(env, telegramId, session.employee.name, isoFromTjToday());

    // жёсткий предел — реальный лимит, о резерве сотруднику не сообщаем
    if (used >= DAY_OFF_MONTHLY_LIMIT) {
      await sendDayOffBlocked(env, chatId, telegramId, session.employee.departmentId);
      await showHomeMenu(env, chatId, telegramId);
      return;
    }

    if (used >= DAY_OFF_VISIBLE_LIMIT) {
      await sendMessage(
        env,
        chatId,
        `⚠️ You are going over the normal Day Off limit (${DAY_OFF_VISIBLE_LIMIT} per month).\n\nThis request will be submitted as an exception and flagged for HR and your manager.`
      );
    } else {
      await sendMessage(
        env,
        chatId,
        `Your Day Off balance this month: ${used} of ${DAY_OFF_VISIBLE_LIMIT} used, ${DAY_OFF_VISIBLE_LIMIT - used} remaining.`
      );
    }
  }

  const state: ReportFlowState = {
    step: 'report_flow',
    reportType,
    flowStep: firstStep(reportType),
    answers: {},
  };
  await saveSession(env, telegramId, { ...session, state });

  await askCurrentStep(env, chatId, state, session.employee);
}

function isoFromTjToday(): string {
  const t = tjToday();
  return formatISODate(t.year, t.month, t.day);
}

function firstStep(reportType: string): string {
  switch (reportType) {
    case 'late_checkin':
      return 'eta';
    case 'early_leave':
    case 'day_off':
    case 'vacation':
    case 'long_term_leave':
      return 'date';
    case 'emergency_leave':
      return 'reason';
    case 'resignation':
      return 'notice';
    default:
      return 'reason';
  }
}

async function askCurrentStep(
  env: Env,
  chatId: number,
  state: ReportFlowState,
  employee: Employee
) {
  const { reportType, flowStep } = state;

  if (flowStep === 'date') {
    const today = tjToday();
    state.calendarYear = today.year;
    state.calendarMonth = today.month;
    const blockDays = BLOCK_DAYS[reportType] ?? 0;
    const kb = buildDayPicker(today.year, today.month, blockDays);
    await sendMessage(env, chatId, calendarCaption(today.year, today.month), kb);
    return;
  }

  if (flowStep === 'eta') {
    const startLine = employee.scheduledStart
      ? `Shift starts at ${employee.scheduledStart}. `
      : '';
    await sendMessage(
      env,
      chatId,
      `${startLine}How many minutes will you be late?`,
      buildChoiceKeyboard(ETA_OPTIONS, 'eta')
    );
    return;
  }
  if (flowStep === 'eta_manual') {
    await sendMessage(
      env,
      chatId,
      'Send the time you expect to arrive (HH:MM, for example 20:30), or the number of minutes:'
    );
    return;
  }

  if (flowStep === 'reason') {
    if (reportType === 'late_checkin') {
      await sendMessage(env, chatId, 'Reason for being late:', buildChoiceKeyboard(LATE_REASONS, 'reason'));
    } else {
      await sendMessage(env, chatId, 'Enter the reason:');
    }
    return;
  }
  if (flowStep === 'reason_manual') {
    await sendMessage(env, chatId, 'Describe the reason:');
    return;
  }

  if (flowStep === 'comment') {
    await sendMessage(env, chatId, 'Additional comment (optional):', {
      inline_keyboard: [[{ text: 'Skip', callback_data: 'comment:skip' }]],
    });
    return;
  }

  if (flowStep === 'time') {
    await sendMessage(env, chatId, 'What time are you leaving? (for example 17:30)');
    return;
  }

  if (flowStep === 'duration') {
    if (reportType === 'day_off') {
      await sendMessage(env, chatId, 'How many days?', buildSmallDurationPicker());
    } else {
      await sendMessage(env, chatId, 'For how long?', buildWeekDurationPicker());
    }
    return;
  }
  if (flowStep === 'duration_manual') {
    await sendMessage(env, chatId, `Enter the number of days (1–${maxLeaveDays(reportType)}):`);
    return;
  }

  if (flowStep === 'notice') {
    await sendMessage(env, chatId, 'Notice period:', buildNoticeKeyboard());
    return;
  }

  if (flowStep === 'confirm') {
    await sendMessage(env, chatId, buildSummary(state, employee), buildConfirmKeyboard());
    return;
  }
}

/** Экран подтверждения перед отправкой — что именно уйдёт менеджеру, HR и Admin. */
function buildSummary(state: ReportFlowState, employee: Employee): string {
  const rt = findReportType(state.reportType);
  const a = state.answers;
  const lines = [
    `📝 ${rt?.label ?? state.reportType}`,
    ``,
    `Employee: ${employee.name}`,
    `Department: ${employee.department}`,
  ];

  if (state.reportType === 'late_checkin') {
    if (employee.scheduledStart) lines.push(`Scheduled start: ${employee.scheduledStart}`);
    if (a.expectedClock) lines.push(`Expected check-in: ${a.expectedClock}`);
  }
  if (a.startDate) lines.push(`Date: ${a.startDate}`);
  if (a.time) lines.push(`Leave time: ${a.time}`);
  if (a.duration) lines.push(`Days: ${a.duration}`);
  if (a.notice) lines.push(`Notice period: ${a.notice}`);
  if (a.reason) lines.push(`Reason: ${a.reason}`);
  if (a.comment) lines.push(`Comment: ${a.comment}`);

  lines.push('', 'Submit this report?');
  return lines.join('\n');
}

// ---------- обработка нажатий кнопок ----------

export async function handleReportCallback(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  callbackQueryId: string,
  messageId: number,
  data: string
) {
  if (session.state.step !== 'report_flow' || !session.employee) {
    await answerCallbackQuery(env, callbackQueryId);
    return;
  }
  const state = session.state as ReportFlowState;
  const employee = session.employee;

  if (data === 'noop') {
    await answerCallbackQuery(env, callbackQueryId);
    return;
  }

  const [prefix, ...rest] = data.split(':');

  // навигация по календарю — не меняет flowStep, перерисовывает подпись месяца и кнопки
  if (prefix === 'nav') {
    const year = Number(rest[0]);
    const month = Number(rest[1]);
    if (!isRealDay(year, month, 1)) {
      await answerCallbackQuery(env, callbackQueryId);
      return;
    }
    state.calendarYear = year;
    state.calendarMonth = month;
    await saveSession(env, telegramId, { ...session, state });
    const blockDays = BLOCK_DAYS[state.reportType] ?? 0;
    await editMessageText(
      env,
      chatId,
      messageId,
      calendarCaption(year, month),
      buildDayPicker(year, month, blockDays)
    );
    await answerCallbackQuery(env, callbackQueryId);
    return;
  }

  if (prefix === 'day' && state.flowStep === 'date') {
    const [year, month, day] = rest.map(Number);
    const blockDays = BLOCK_DAYS[state.reportType] ?? 0;
    // кнопки могли устареть (календарь вчерашний) или callback подделан — проверяем дату заново
    if (!isRealDay(year, month, day) || isDayBlocked(year, month, day, blockDays)) {
      await answerCallbackQuery(env, callbackQueryId, 'This date is not available — pick another day');
      if (isRealDay(year, month, day)) {
        await editMessageReplyMarkup(env, chatId, messageId, buildDayPicker(year, month, blockDays));
      }
      return;
    }
    state.answers.startDate = formatISODate(year, month, day);
    await advance(env, chatId, telegramId, session, state, employee);
    await answerCallbackQuery(env, callbackQueryId);
    return;
  }

  if (prefix === 'eta' && state.flowStep === 'eta') {
    const value = rest.join(':');
    if (value === 'Other') {
      state.flowStep = 'eta_manual';
      await saveSession(env, telegramId, { ...session, state });
      await askCurrentStep(env, chatId, state, employee);
    } else {
      applyEta(state, Number(value));
      await advance(env, chatId, telegramId, session, state, employee);
    }
    await answerCallbackQuery(env, callbackQueryId);
    return;
  }

  if (prefix === 'reason' && state.flowStep === 'reason') {
    const value = rest.join(':');
    if (value === 'Other') {
      state.flowStep = 'reason_manual';
      await saveSession(env, telegramId, { ...session, state });
      await askCurrentStep(env, chatId, state, employee);
    } else {
      state.answers.reason = value;
      await advance(env, chatId, telegramId, session, state, employee);
    }
    await answerCallbackQuery(env, callbackQueryId);
    return;
  }

  if (prefix === 'comment' && state.flowStep === 'comment') {
    await advance(env, chatId, telegramId, session, state, employee);
    await answerCallbackQuery(env, callbackQueryId);
    return;
  }

  if (prefix === 'dur' && state.flowStep === 'duration') {
    const value = rest.join(':');
    if (value === 'manual') {
      state.flowStep = 'duration_manual';
      await saveSession(env, telegramId, { ...session, state });
      await askCurrentStep(env, chatId, state, employee);
    } else {
      // кнопки дают 1–3 или 7/14, но callback могли и подделать
      if (!isValidLeaveDays(state.reportType, Number(value))) {
        await answerCallbackQuery(env, callbackQueryId);
        return;
      }
      state.answers.duration = value;
      await advance(env, chatId, telegramId, session, state, employee);
    }
    await answerCallbackQuery(env, callbackQueryId);
    return;
  }

  if (prefix === 'notice' && state.flowStep === 'notice') {
    state.answers.notice = rest.join(':');
    await advance(env, chatId, telegramId, session, state, employee);
    await answerCallbackQuery(env, callbackQueryId);
    return;
  }

  if (prefix === 'confirm' && state.flowStep === 'confirm') {
    // закрываем форму первым делом, до любых сетевых вызовов: второе быстрое
    // нажатие Submit прочитает уже idle и не отправит репорт повторно
    await saveSession(env, telegramId, { ...session, state: { step: 'idle' } });
    const value = rest.join(':');
    await answerCallbackQuery(env, callbackQueryId);
    if (value === 'cancel') {
      await sendMessage(env, chatId, 'Cancelled, nothing was submitted.');
      await showHomeMenu(env, chatId, telegramId);
      return;
    }
    await finishReport(env, chatId, telegramId, state, employee);
    return;
  }

  await answerCallbackQuery(env, callbackQueryId);
}

function maxLeaveDays(reportType: string): number {
  return MAX_LEAVE_DAYS[reportType] ?? 1;
}

function isValidLeaveDays(reportType: string, days: number): boolean {
  return Number.isInteger(days) && days >= 1 && days <= maxLeaveDays(reportType);
}

/** ETA в минутах → сохраняем и минуты, и вычисленное время прихода. */
function applyEta(state: ReportFlowState, minutes: number) {
  state.answers.eta = `${minutes} min`;
  state.answers.expectedClock = minutesToClock(tjMinutesNow() + minutes);
}

// ---------- обработка свободного текста ----------

export async function handleReportText(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  text: string
) {
  if (session.state.step !== 'report_flow' || !session.employee) return;
  const state = session.state as ReportFlowState;
  const employee = session.employee;
  const trimmed = text.trim();

  // стикер, фото, голосовое или одни пробелы — не ответ: пустоту в таблицу не пишем,
  // задаём тот же вопрос ещё раз
  if (!trimmed) {
    await sendMessage(env, chatId, 'I can only read text here.');
    await askCurrentStep(env, chatId, state, employee);
    return;
  }

  // иначе сводка перед отправкой не влезет в сообщение Telegram и кнопки Submit пропадут
  if (trimmed.length > MAX_TEXT_ANSWER_LENGTH) {
    await sendMessage(
      env,
      chatId,
      `That's too long (${trimmed.length} characters). Please keep it under ${MAX_TEXT_ANSWER_LENGTH}:`
    );
    return;
  }

  if (state.flowStep === 'eta_manual') {
    // принимаем и "20:30", и просто "45"
    const clock = parseClock(trimmed);
    if (clock !== null) {
      state.answers.expectedClock = minutesToClock(clock);
      // по кругу суток: в 23:50 приход в "00:20" — это через 30 минут, а не "уже прошло"
      const ahead = minutesUntil(tjMinutesNow(), clock);
      state.answers.eta = ahead > 0 && ahead < HALF_DAY_MINUTES ? `${ahead} min` : 'time already passed';
    } else {
      const mins = parseInt(trimmed, 10);
      if (!mins || mins < 1) {
        await sendMessage(env, chatId, 'Send the time as HH:MM, or the number of minutes:');
        return;
      }
      applyEta(state, mins);
    }
    await advance(env, chatId, telegramId, session, state, employee);
    return;
  }

  if (state.flowStep === 'reason_manual' || state.flowStep === 'reason') {
    state.answers.reason = trimmed;
    await advance(env, chatId, telegramId, session, state, employee);
    return;
  }

  if (state.flowStep === 'comment') {
    state.answers.comment = trimmed;
    await advance(env, chatId, telegramId, session, state, employee);
    return;
  }

  if (state.flowStep === 'time') {
    state.answers.time = trimmed;
    await advance(env, chatId, telegramId, session, state, employee);
    return;
  }

  if (state.flowStep === 'duration_manual') {
    const n = parseInt(trimmed, 10);
    if (!isValidLeaveDays(state.reportType, n)) {
      const max = maxLeaveDays(state.reportType);
      await sendMessage(
        env,
        chatId,
        `One request can cover 1 to ${max} days. Enter a number from 1 to ${max}:`
      );
      return;
    }
    state.answers.duration = String(n);
    await advance(env, chatId, telegramId, session, state, employee);
    return;
  }

  await sendMessage(env, chatId, 'Please use the buttons above 👆');
}

// ---------- переход между шагами ----------

async function advance(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  state: ReportFlowState,
  employee: Employee
) {
  state.flowStep = nextStep(state);
  await saveSession(env, telegramId, { ...session, state });
  await askCurrentStep(env, chatId, state, employee);
}

function nextStep(state: ReportFlowState): string {
  const { reportType, flowStep } = state;

  switch (reportType) {
    case 'late_checkin':
      if (flowStep === 'eta' || flowStep === 'eta_manual') return 'reason';
      if (flowStep === 'reason' || flowStep === 'reason_manual') return 'comment';
      if (flowStep === 'comment') return 'confirm';
      break;
    case 'early_leave':
      if (flowStep === 'date') return 'time';
      if (flowStep === 'time') return 'reason';
      if (flowStep === 'reason') return 'confirm';
      break;
    case 'day_off':
      if (flowStep === 'date') return 'duration';
      if (flowStep === 'duration' || flowStep === 'duration_manual') return 'reason';
      if (flowStep === 'reason') return 'confirm';
      break;
    case 'emergency_leave':
      if (flowStep === 'reason') return 'confirm';
      break;
    case 'vacation':
    case 'long_term_leave':
      if (flowStep === 'date') return 'duration';
      if (flowStep === 'duration' || flowStep === 'duration_manual') return 'reason';
      if (flowStep === 'reason') return 'confirm';
      break;
    case 'resignation':
      if (flowStep === 'notice') return 'reason';
      if (flowStep === 'reason') return 'confirm';
      break;
  }
  return 'confirm';
}

// ---------- финализация ----------

/** Сессия к этому моменту уже в idle — её сбросили при нажатии Submit. */
async function finishReport(
  env: Env,
  chatId: number,
  telegramId: number,
  state: ReportFlowState,
  employee: Employee
) {
  const a = state.answers;
  const today = tjToday();
  const todayISO = formatISODate(today.year, today.month, today.day);

  let startDate = a.startDate || todayISO;
  let endDate = startDate;
  let details = '';
  let color: 'yellow' | 'red' | undefined;
  let lateNotification = false;

  switch (state.reportType) {
    case 'late_checkin': {
      // сообщил уже после начала смены — это отдельный статус для HR
      if (employee.scheduledStart) {
        const scheduled = parseClock(employee.scheduledStart);
        if (scheduled !== null && isAfterShiftStart(scheduled, tjMinutesNow())) {
          lateNotification = true;
        }
      }
      const parts = [`Submitted: ${tjClockNow()}`];
      if (employee.scheduledStart) parts.unshift(`Scheduled: ${employee.scheduledStart}`);
      if (a.expectedClock) parts.push(`Expected: ${a.expectedClock}`);
      if (a.eta) parts.push(`ETA: ${a.eta}`);
      parts.push(`Reason: ${a.reason}`);
      if (a.comment) parts.push(`Comment: ${a.comment}`);
      if (lateNotification) parts.push('⚠️ LATE NOTIFICATION');
      details = parts.join(', ');
      break;
    }
    case 'early_leave':
      details = `Leave time: ${a.time}, Reason: ${a.reason}`;
      break;
    case 'day_off': {
      const duration = Number(a.duration);
      const usedNow = await getDayOffUsed(env, telegramId, employee.name, todayISO);
      if (usedNow + duration > DAY_OFF_MONTHLY_LIMIT) {
        await sendDayOffBlocked(env, chatId, telegramId, employee.departmentId);
        await showHomeMenu(env, chatId, telegramId);
        return;
      }
      endDate = addDaysISO(...isoToParts(startDate), duration - 1);
      // всё, что сверх видимого лимита, помечаем как исключение — это видят HR и менеджер
      const exception = usedNow >= DAY_OFF_VISIBLE_LIMIT;
      details = `${duration} day(s), Reason: ${a.reason}` + (exception ? ' ⚠️ EXCEPTION' : '');
      color = 'yellow';
      break;
    }
    case 'emergency_leave':
      details = a.reason;
      break;
    case 'vacation':
    case 'long_term_leave': {
      const duration = Number(a.duration);
      endDate = addDaysISO(...isoToParts(startDate), duration - 1);
      details = `${startDate} to ${endDate}, Reason: ${a.reason}`;
      color = 'yellow';
      break;
    }
    case 'resignation':
      details = `Notice: ${a.notice}, Reason: ${a.reason}`;
      break;
  }

  // обновляем счётчик сразу — от него зависит следующая проверка лимита
  if (state.reportType === 'day_off') {
    await addDayOffUsed(env, telegramId, todayISO, Number(a.duration));
  }

  // сотруднику отвечаем немедленно, рассылка и запись в таблицу идут в фоне:
  // Apps Script отвечает секундами, ждать его перед ответом незачем.
  // Рассылка от таблицы не зависит — если Apps Script не ответит, менеджер всё равно узнает.
  runInBackground(sendReportNotification(env, employee, state.reportType, details, lateNotification));
  runInBackground(
    recordReport(env, telegramId, employee, todayISO, {
      name: employee.name,
      reportType: state.reportType,
      startDate,
      endDate,
      details,
      color,
    })
  );

  await sendMessage(env, chatId, '✅ Report sent to your manager, HR and Admin.');
  await showHomeMenu(env, chatId, telegramId);
}

/**
 * Заявка подана уже после начала смены? Смена может переходить через полночь
 * (начало в 20:00, заявка в 00:30 — прошло 4.5 часа), поэтому считаем по кругу суток:
 * ближе прошедшее начало смены — опоздание уже идёт, ближе следующее — предупредил заранее.
 */
function isAfterShiftStart(scheduled: number, now: number): boolean {
  const sinceStart = minutesUntil(scheduled, now);
  return sinceStart > 0 && sinceStart < HALF_DAY_MINUTES;
}

/**
 * Запись в таблицу и счётчик опозданий. Если таблица не ответила, репорт уже
 * разослан, но в учёт не попал — пишем внятный лог и просим HR внести его вручную.
 */
async function recordReport(
  env: Env,
  telegramId: number,
  employee: Employee,
  todayISO: string,
  payload: ReportPayload
) {
  // счётчик — ДО записи в таблицу: если его ещё нет в KV, он досчитывается
  // из таблицы, и текущее опоздание не должно попасть в сумму дважды
  let lateCount = 0;
  if (payload.reportType === 'late_checkin') {
    try {
      lateCount = await bumpLateCount(env, telegramId, employee.name, todayISO);
    } catch (err) {
      console.error(`late check-in counter failed for ${employee.name} (id ${telegramId}):`, err);
    }
  }

  const res = await submitReport(env, payload).catch((err) => ({ success: false, error: String(err) }));
  if (!res?.success) {
    const label = findReportType(payload.reportType)?.label ?? payload.reportType;
    const dates =
      payload.startDate === payload.endDate
        ? payload.startDate
        : `${payload.startDate} – ${payload.endDate}`;
    console.error(
      `REPORT NOT WRITTEN TO GOOGLE SHEETS: ${employee.name} (id ${telegramId}), ${payload.reportType}, ${dates}, ${payload.details}. Apps Script: ${res?.error ?? 'no response'}`
    );
    await notifyHrAndAdmin(
      env,
      `⚠️ A report was sent to the responsible people but was NOT written to Google Sheets. Please add it to the table manually.\n\n` +
        `Employee: ${employee.name}\nDepartment: ${employee.department}\nType: ${label}\nDate: ${dates}\nDetails: ${payload.details}`
    );
  }

  if (lateCount >= LATE_CHECKIN_ALERT_THRESHOLD) {
    await notifyHrAndAdmin(
      env,
      `⚠️ Repeated Late Check-In Alert\n\nEmployee: ${employee.name}\nDepartment: ${employee.department}\nLate Check-ins this month: ${lateCount}\n\nHR review recommended.`
    );
  }
}

async function sendReportNotification(
  env: Env,
  employee: Employee,
  reportType: string,
  details: string,
  lateNotification: boolean
) {
  const rt = findReportType(reportType);
  const label = rt?.label ?? reportType;

  const header =
    reportType === 'late_checkin'
      ? lateNotification
        ? '⚠️ LATE CHECK-IN ALERT (late notification)'
        : '🕒 LATE CHECK-IN ALERT'
      : '📋 New report';

  const text =
    `${header}\n\n` +
    `Employee: ${employee.name}\n` +
    `Department: ${employee.department}\n` +
    `Type: ${label}\n` +
    `Details: ${details}`;

  await notifyResponsible(env, employee, text);
}

/** Лимит исчерпан: сотруднику не называем цифры, даём кнопки связи с ответственными. */
async function sendDayOffBlocked(env: Env, chatId: number, telegramId: number, departmentId: string) {
  const buttons = await buildContactButtons(env, departmentId, telegramId);
  const text =
    '⛔️ You have used up your Day Off limit for this month.\n\n' +
    'Additional days need approval — contact your manager, HR or Admin.';

  if (buttons.length) {
    await sendMessage(env, chatId, text, { inline_keyboard: buttons });
  } else {
    await sendMessage(env, chatId, text);
  }
}

function isoToParts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split('-').map(Number);
  return [y, m - 1, d];
}

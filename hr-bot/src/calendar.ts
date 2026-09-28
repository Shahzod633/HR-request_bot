import type { InlineKeyboard } from './telegram';
import { daysFromToday, tjToday, monthLabel } from './tjTime';

/**
 * Календарь-кнопки 1..N на месяц. Дни от сегодня (включительно) до
 * `blockDays` дней вперёд — заблокированы (крестик, не кликабельны).
 * blockDays = -1 значит "ничего не блокировать, включая сегодня".
 *
 * Пример из ТЗ: сегодня 15, blockDays=2 → заблокированы 15,16,17, с 18 можно.
 */
export function buildDayPicker(year: number, month: number, blockDays: number): InlineKeyboard {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const rows: { text: string; callback_data: string }[][] = [];
  let row: { text: string; callback_data: string }[] = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const blocked = isDayBlocked(year, month, day, blockDays);
    row.push({
      text: blocked ? `✖${day}` : `${day}`,
      callback_data: blocked ? 'noop' : `day:${year}:${month}:${day}`,
    });
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);

  const today = tjToday();
  const isAtCurrentMonth = year === today.year && month === today.month;
  const nav: { text: string; callback_data: string }[] = [];
  if (!isAtCurrentMonth) {
    const p = shiftMonth(year, month, -1);
    nav.push({ text: '◀', callback_data: `nav:${p.year}:${p.month}` });
  }
  const n = shiftMonth(year, month, 1);
  nav.push({ text: '▶', callback_data: `nav:${n.year}:${n.month}` });
  rows.push(nav);

  return { inline_keyboard: rows };
}

/**
 * Правило блокировки — одно для кнопок и для проверки нажатия на сервере:
 * кнопка из вчерашнего календаря не должна пропускать уже закрытый день.
 */
export function isDayBlocked(year: number, month: number, day: number, blockDays: number): boolean {
  const diff = daysFromToday(year, month, day);
  return diff < 0 || diff <= blockDays;
}

/** Такая дата вообще существует: не 31 февраля и не NaN из подделанного callback. */
export function isRealDay(year: number, month: number, day: number): boolean {
  if (![year, month, day].every(Number.isInteger)) return false;
  if (month < 0 || month > 11 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function calendarCaption(year: number, month: number): string {
  return `📅 ${monthLabel(year, month)}`;
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  let m = month + delta;
  let y = year;
  if (m < 0) {
    m = 11;
    y -= 1;
  } else if (m > 11) {
    m = 0;
    y += 1;
  }
  return { year: y, month: m };
}

/** Кнопки 1 / 2 / 3 — для Day Off. */
export function buildSmallDurationPicker(): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '1 day off', callback_data: 'dur:1' },
        { text: '2 days off', callback_data: 'dur:2' },
        { text: '3 days off', callback_data: 'dur:3' },
      ],
    ],
  };
}

/** Кнопки 1 неделя / 2 недели / вручную — для Vacation и Long-Term Leave. */
export function buildWeekDurationPicker(): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '1 week', callback_data: 'dur:7' },
        { text: '2 weeks', callback_data: 'dur:14' },
      ],
      [{ text: 'Enter manually', callback_data: 'dur:manual' }],
    ],
  };
}

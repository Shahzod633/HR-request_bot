// Таджикистан = UTC+5 круглый год, переход на летнее время не действует —
// поэтому фиксированный оффсет безопасен и не требует библиотек часовых поясов.
const TJ_OFFSET_MS = 5 * 60 * 60 * 1000;

/** "Сейчас" по таджикскому времени, как Date (для чтения Y/M/D через getUTC*). */
export function tjNow(): Date {
  return new Date(Date.now() + TJ_OFFSET_MS);
}

export function tjToday(): { year: number; month: number; day: number } {
  const now = tjNow();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth(), day: now.getUTCDate() };
}

/** Текущее время в минутах от полуночи по таджикскому времени. */
export function tjMinutesNow(): number {
  const now = tjNow();
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

/** Текущее время как "HH:MM" по таджикскому времени. */
export function tjClockNow(): string {
  return minutesToClock(tjMinutesNow());
}

/** Половина суток — граница "ближе к прошедшему или к следующему такому же времени". */
export const HALF_DAY_MINUTES = 12 * 60;

/** Сколько минут вперёд по кругу суток от часов `from` до часов `to`: 23:50 → 00:20 = 30. */
export function minutesUntil(from: number, to: number): number {
  return (((to - from) % 1440) + 1440) % 1440;
}

export function minutesToClock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Разбирает "20:00", "20.00", "8:5" → минуты от полуночи. null если не время. */
export function parseClock(input: string): number | null {
  const match = input.trim().match(/^(\d{1,2})[:.\s]?(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** Разница в днях между сегодня (TJ) и указанной датой. 0 = сегодня, отрицательное = прошлое. */
export function daysFromToday(year: number, month: number, day: number): number {
  const today = tjToday();
  const todayUTC = Date.UTC(today.year, today.month, today.day);
  const targetUTC = Date.UTC(year, month, day);
  return Math.round((targetUTC - todayUTC) / 86400000);
}

export function formatISODate(year: number, month: number, day: number): string {
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

export function addDaysISO(year: number, month: number, day: number, add: number): string {
  const base = new Date(Date.UTC(year, month, day + add));
  return formatISODate(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month]} ${year}`;
}

import type { Env } from './types';
import { getDayOffBalance, getLateCheckinCount } from './appsScriptClient';

/**
 * Счётчики Day Off и опозданий держим в KV, а не пересчитываем каждый раз
 * сканированием Google-таблицы: чтение KV — доли секунды, поход в Apps Script —
 * секунды. В таблицу данные всё равно пишутся, KV здесь только кэш-счётчик.
 *
 * Ключ включает месяц, поэтому в начале нового месяца счёт сам начинается с нуля.
 */

function monthKey(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}

const dayOffKey = (id: number, iso: string) => `count:dayoff:${id}:${monthKey(iso)}`;
const lateKey = (id: number, iso: string) => `count:late:${id}:${monthKey(iso)}`;

async function readCount(env: Env, key: string): Promise<number | null> {
  const raw = await env.SESSIONS.get(key);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function writeCount(env: Env, key: string, value: number): Promise<void> {
  // счётчик нужен только до конца месяца, дальше пусть истекает сам
  await env.SESSIONS.put(key, String(value), { expirationTtl: 60 * 60 * 24 * 62 });
}

/**
 * Если счётчика ещё нет (первый заход в этом месяце или бот обновился),
 * один раз считаем из таблицы и запоминаем.
 */
export async function getDayOffUsed(
  env: Env,
  telegramId: number,
  name: string,
  todayISO: string
): Promise<number> {
  const key = dayOffKey(telegramId, todayISO);
  const cached = await readCount(env, key);
  if (cached !== null) return cached;

  const fromSheet = await getDayOffBalance(env, name, todayISO);
  await writeCount(env, key, fromSheet);
  return fromSheet;
}

export async function addDayOffUsed(
  env: Env,
  telegramId: number,
  todayISO: string,
  days: number
): Promise<void> {
  const key = dayOffKey(telegramId, todayISO);
  const current = (await readCount(env, key)) ?? 0;
  await writeCount(env, key, current + days);
}

export async function getLateCount(
  env: Env,
  telegramId: number,
  name: string,
  todayISO: string
): Promise<number> {
  const key = lateKey(telegramId, todayISO);
  const cached = await readCount(env, key);
  if (cached !== null) return cached;

  const fromSheet = await getLateCheckinCount(env, name, todayISO);
  await writeCount(env, key, fromSheet);
  return fromSheet;
}

/**
 * Вызывать ДО записи текущего опоздания в таблицу: холодный счётчик досчитывается
 * из таблицы, и уже записанное опоздание получило бы ещё +1 (алерт после 3-го вместо 4-го).
 */
export async function bumpLateCount(
  env: Env,
  telegramId: number,
  name: string,
  todayISO: string
): Promise<number> {
  const current = await getLateCount(env, telegramId, name, todayISO);
  const next = current + 1;
  await writeCount(env, lateKey(telegramId, todayISO), next);
  return next;
}

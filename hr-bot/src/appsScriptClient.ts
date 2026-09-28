import type { Env } from './types';

async function callAppsScript(env: Env, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(env.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, secret: env.APPS_SCRIPT_SECRET }),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    // вместо JSON Google отдаёт HTML-страницу — в ней и написана причина:
    // ошибка загрузки скрипта, страница входа (закрыт доступ к веб-приложению) и т.п.
    const page = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    json = { success: false, error: `Apps Script returned a page instead of JSON (HTTP ${res.status}): ${page}` };
  }
  if (!json?.success) {
    console.error(`Apps Script error (${body.action}):`, json?.error);
  }
  return json;
}

export async function registerEmployee(
  env: Env,
  telegramId: number,
  name: string,
  department: string,
  manager: string,
  username?: string,
  scheduledStart?: string
) {
  return callAppsScript(env, {
    action: 'register',
    telegramId,
    name,
    department,
    manager,
    username: username || '',
    scheduledStart: scheduledStart || '',
  });
}

export async function updateUsername(env: Env, telegramId: number, username: string) {
  return callAppsScript(env, { action: 'update_username', telegramId, username });
}

export async function updateShiftTime(env: Env, telegramId: number, scheduledStart: string) {
  return callAppsScript(env, { action: 'update_shift', telegramId, scheduledStart });
}

/**
 * Новое имя в листе Employees + переименование строки в листе текущего месяца.
 * oldName — имя, под которым Worker писал репорты (на случай, если в мастер-листе оно другое).
 */
export async function updateEmployeeName(
  env: Env,
  telegramId: number,
  name: string,
  oldName?: string
) {
  return callAppsScript(env, { action: 'update_name', telegramId, name, oldName: oldName || '' });
}

export async function updateEmployeeDepartment(
  env: Env,
  telegramId: number,
  department: string,
  manager: string
) {
  return callAppsScript(env, { action: 'update_department', telegramId, department, manager });
}

export interface RolePersonPayload {
  telegramId: number;
  name: string;
  department: string;
  username: string;
  role: 'HR' | 'Manager' | 'Super Admin';
}

/** Записывает HR/менеджера/Super Admin в лист Employees с пометкой роли. */
export async function registerRolePerson(env: Env, payload: RolePersonPayload) {
  return callAppsScript(env, { action: 'register_role', ...payload });
}

export interface RosterEntry {
  /** 0 у записей, где в колонке Telegram ID пусто */
  telegramId: number;
  name: string;
  department: string;
  username: string;
  scheduledStart: string;
  role: string;
}

/** ok: false — таблица не ответила; это не то же самое, что "сотрудников нет". */
export type RosterResult = { ok: true; employees: RosterEntry[] } | { ok: false; error: string };

export async function listEmployees(env: Env): Promise<RosterResult> {
  const res = await callAppsScript(env, { action: 'list_employees' }).catch((err) => ({
    success: false,
    error: String(err),
  }));
  if (res?.success && Array.isArray(res.employees)) {
    return { ok: true, employees: res.employees };
  }
  const error = String(res?.error || 'unexpected response from Apps Script');
  console.error(`list_employees failed, the employee list can't be shown: ${error}`);
  return { ok: false, error };
}

export interface ReportPayload {
  name: string;
  reportType: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD, равно startDate для однодневных
  details: string;
  color?: 'yellow' | 'red';
}

export async function submitReport(env: Env, payload: ReportPayload) {
  return callAppsScript(env, { action: 'report', ...payload });
}

export async function getDayOffBalance(env: Env, name: string, referenceDate: string): Promise<number> {
  const res = await callAppsScript(env, { action: 'day_off_balance', name, referenceDate });
  return typeof res?.used === 'number' ? res.used : 0;
}

/** Сколько Late Check-in сотрудник подал в текущем месяце (для алерта о повторных). */
export async function getLateCheckinCount(
  env: Env,
  name: string,
  referenceDate: string
): Promise<number> {
  const res = await callAppsScript(env, { action: 'late_checkin_count', name, referenceDate });
  return typeof res?.count === 'number' ? res.count : 0;
}

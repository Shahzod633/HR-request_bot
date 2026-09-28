import type { Env } from './types';

async function callAppsScript(env: Env, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(env.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, secret: env.APPS_SCRIPT_SECRET }),
  });
  const json = await res.json().catch(() => ({ success: false, error: 'invalid JSON from Apps Script' }));
  if (!json.success) {
    console.error('Apps Script error:', json.error);
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

export async function listEmployees(env: Env): Promise<RosterEntry[]> {
  const res = await callAppsScript(env, { action: 'list_employees' });
  return Array.isArray(res?.employees) ? res.employees : [];
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

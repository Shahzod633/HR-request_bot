import type { Env } from './types';
import { getRoleInfo, type RoleInfo } from './roles';
import { getSession } from './session';
import { registerRolePerson, type RolePersonPayload } from './appsScriptClient';

/** В колонке Role листа Employees одна пометка — старшая из ролей человека. */
export function sheetRoleLabel(roles: RoleInfo): RolePersonPayload['role'] {
  if (roles.superAdmin) return 'Super Admin';
  if (roles.hr) return 'HR';
  if (roles.managerOf) return 'Manager';
  return 'Employee';
}

/**
 * Роль сняли или отдали другому — пересчитываем пометку в листе Employees
 * по тем ролям, что у человека остались. Строка и профиль сотрудника остаются.
 * fallback — данные из профиля роли, если профиля сотрудника в боте нет.
 */
export async function syncSheetRole(
  env: Env,
  telegramId: number,
  fallback: { name: string; department: string; username?: string }
): Promise<void> {
  const [roles, session] = await Promise.all([getRoleInfo(env, telegramId), getSession(env, telegramId)]);
  const e = session.employee;
  const name = e?.name || fallback.name;
  if (!name) return; // старый формат профиля без имени — строку в таблице не найти по данным
  await registerRolePerson(env, {
    telegramId,
    name,
    department: e?.department || fallback.department,
    username: e?.username || fallback.username || '',
    role: sheetRoleLabel(roles),
  });
}

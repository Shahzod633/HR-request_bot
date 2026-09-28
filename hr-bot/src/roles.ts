import type { Env, RoleProfile } from './types';
import { DEPARTMENTS } from './config';

const HR_KEY = 'role:hr';
const SUPER_ADMIN_KEY = 'role:super_admin';
const managerKey = (departmentId: string) => `role:manager:${departmentId}`;
const inviteKey = (token: string) => `invite:${token}`;

/** Настоящий Admin — тот, чей id задан секретом ADMIN_TELEGRAM_ID. */
export function isAdmin(env: Env, telegramId: number): boolean {
  return String(telegramId) === env.ADMIN_TELEGRAM_ID;
}

/**
 * Права уровня Admin: настоящий Admin или Super Admin.
 * Назначать Super Admin может только настоящий Admin — там проверяем isAdmin.
 */
export async function isAdminLevel(env: Env, telegramId: number): Promise<boolean> {
  if (isAdmin(env, telegramId)) return true;
  const superAdmin = await getSuperAdminProfile(env);
  return !!superAdmin && superAdmin.telegramId === telegramId;
}

/**
 * Читает профиль роли. Раньше в этих ключах лежал просто id строкой —
 * поддерживаем старый формат, чтобы уже назначенные роли не слетели.
 */
async function readProfile(env: Env, key: string): Promise<RoleProfile | null> {
  const raw = await env.SESSIONS.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.telegramId) {
      return parsed as RoleProfile;
    }
  } catch {
    // старый формат: голый id
  }
  const legacyId = Number(raw);
  if (!legacyId) return null;
  return { telegramId: legacyId, name: '', department: '' };
}

async function writeProfile(env: Env, key: string, profile: RoleProfile): Promise<void> {
  await env.SESSIONS.put(key, JSON.stringify(profile));
}

// ---------- HR ----------

export async function getHrProfile(env: Env): Promise<RoleProfile | null> {
  return readProfile(env, HR_KEY);
}

export async function getHrTelegramId(env: Env): Promise<string | null> {
  const p = await readProfile(env, HR_KEY);
  return p ? String(p.telegramId) : null;
}

export async function setHrProfile(env: Env, profile: RoleProfile): Promise<void> {
  await writeProfile(env, HR_KEY, profile);
}

// ---------- Super Admin ----------

/** Super Admin — одна роль на одного человека, как HR. */
export async function getSuperAdminProfile(env: Env): Promise<RoleProfile | null> {
  return readProfile(env, SUPER_ADMIN_KEY);
}

export async function getSuperAdminTelegramId(env: Env): Promise<string | null> {
  const p = await readProfile(env, SUPER_ADMIN_KEY);
  return p ? String(p.telegramId) : null;
}

export async function setSuperAdminProfile(env: Env, profile: RoleProfile): Promise<void> {
  await writeProfile(env, SUPER_ADMIN_KEY, profile);
}

// ---------- Менеджеры ----------

export async function getManagerProfile(
  env: Env,
  departmentId: string
): Promise<RoleProfile | null> {
  return readProfile(env, managerKey(departmentId));
}

export async function getManagerTelegramId(
  env: Env,
  departmentId: string
): Promise<string | null> {
  const p = await readProfile(env, managerKey(departmentId));
  return p ? String(p.telegramId) : null;
}

export async function setManagerProfile(
  env: Env,
  departmentId: string,
  profile: RoleProfile
): Promise<void> {
  await writeProfile(env, managerKey(departmentId), profile);
}

// ---------- Приглашения ----------

export interface InvitePayload {
  role: 'hr' | 'manager' | 'employee' | 'super_admin';
  departmentId?: string;
}

/** Одноразовое приглашение на роль. Живёт 24 часа. */
export async function createInvite(env: Env, payload: InvitePayload): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await env.SESSIONS.put(inviteKey(token), JSON.stringify(payload), {
    expirationTtl: 60 * 60 * 24,
  });
  return token;
}

export async function consumeInvite(env: Env, token: string): Promise<InvitePayload | null> {
  const key = inviteKey(token);
  const raw = await env.SESSIONS.get(key);
  if (!raw) return null;
  await env.SESSIONS.delete(key);
  try {
    return JSON.parse(raw) as InvitePayload;
  } catch {
    return null;
  }
}

export function buildInviteLink(env: Env, token: string): string {
  return `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=inv_${token}`;
}

/** Каким отделом руководит этот человек, если руководит. */
export async function findManagerDepartment(
  env: Env,
  telegramId: number
): Promise<{ id: string; label: string } | null> {
  const found = await Promise.all(
    DEPARTMENTS.map(async (d) => ({
      dept: d,
      profile: await readProfile(env, managerKey(d.id)),
    }))
  );
  const hit = found.find((f) => f.profile?.telegramId === telegramId);
  return hit ? { id: hit.dept.id, label: hit.dept.label } : null;
}

// ---------- Сводка ролей человека ----------

export interface RoleInfo {
  admin: boolean;
  superAdmin: boolean;
  hr: boolean;
  managerOf: { id: string; label: string } | null;
}

export async function getRoleInfo(env: Env, telegramId: number): Promise<RoleInfo> {
  const [hr, superAdmin, managerOf] = await Promise.all([
    getHrProfile(env),
    getSuperAdminProfile(env),
    findManagerDepartment(env, telegramId),
  ]);
  return {
    admin: isAdmin(env, telegramId),
    superAdmin: !!superAdmin && superAdmin.telegramId === telegramId,
    hr: !!hr && hr.telegramId === telegramId,
    managerOf,
  };
}

/** Admin, Super Admin, HR или менеджер — те, кто получает репорты. */
export function isStaff(roles: RoleInfo): boolean {
  return roles.admin || roles.superAdmin || roles.hr || !!roles.managerOf;
}

/**
 * Отдел HR, Super Admin и менеджера привязан к роли (для менеджера — ссылкой
 * на конкретный отдел), поэтому сменить его можно только переназначением роли.
 */
export function isDepartmentRoleBound(roles: RoleInfo): boolean {
  return roles.superAdmin || roles.hr || !!roles.managerOf;
}

/** Человек сменил имя — обновляем его профили ролей, чтобы панель /admin показывала новое. */
export async function renameRoleProfiles(env: Env, telegramId: number, name: string): Promise<void> {
  const [hr, superAdmin] = await Promise.all([getHrProfile(env), getSuperAdminProfile(env)]);
  if (hr && hr.telegramId === telegramId) {
    await setHrProfile(env, { ...hr, name });
  }
  if (superAdmin && superAdmin.telegramId === telegramId) {
    await setSuperAdminProfile(env, { ...superAdmin, name });
  }
  // один человек может руководить и несколькими отделами
  for (const d of DEPARTMENTS) {
    const mgr = await getManagerProfile(env, d.id);
    if (mgr && mgr.telegramId === telegramId) {
      await setManagerProfile(env, d.id, { ...mgr, name });
    }
  }
}

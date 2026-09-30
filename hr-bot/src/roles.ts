import type { Env, RoleProfile } from './types';
import { DEPARTMENTS } from './config';

const HR_KEY = 'role:hr';
const SUPER_ADMINS_KEY = 'role:super_admins';
/** так Super Admin хранился, пока он был один — читаем для переноса в список */
const LEGACY_SUPER_ADMIN_KEY = 'role:super_admin';
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
  return isSuperAdmin(env, telegramId);
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

/** Super Admin может быть несколько (в отличие от HR) — храним список. */
export async function getSuperAdmins(env: Env): Promise<RoleProfile[]> {
  const raw = await env.SESSIONS.get(SUPER_ADMINS_KEY);
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list as RoleProfile[];
    } catch {
      // битая запись — ниже попробуем старый формат
    }
  }
  // раньше Super Admin был один — подхватываем его, чтобы назначенный не слетел
  const legacy = await readProfile(env, LEGACY_SUPER_ADMIN_KEY);
  return legacy ? [legacy] : [];
}

async function saveSuperAdmins(env: Env, list: RoleProfile[]): Promise<void> {
  await env.SESSIONS.put(SUPER_ADMINS_KEY, JSON.stringify(list));
  await env.SESSIONS.delete(LEGACY_SUPER_ADMIN_KEY);
}

export async function isSuperAdmin(env: Env, telegramId: number): Promise<boolean> {
  return (await getSuperAdmins(env)).some((p) => p.telegramId === telegramId);
}

/** Добавляет в список; если человек уже Super Admin — обновляет его профиль. */
export async function addSuperAdmin(env: Env, profile: RoleProfile): Promise<void> {
  const list = (await getSuperAdmins(env)).filter((p) => p.telegramId !== profile.telegramId);
  list.push(profile);
  await saveSuperAdmins(env, list);
}

/** Снимает роль; возвращает профиль снятого или null, если такого не было. */
export async function removeSuperAdmin(env: Env, telegramId: number): Promise<RoleProfile | null> {
  const list = await getSuperAdmins(env);
  const removed = list.find((p) => p.telegramId === telegramId) ?? null;
  if (removed) await saveSuperAdmins(env, list.filter((p) => p.telegramId !== telegramId));
  return removed;
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
    isSuperAdmin(env, telegramId),
    findManagerDepartment(env, telegramId),
  ]);
  return {
    admin: isAdmin(env, telegramId),
    superAdmin,
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

/**
 * Человек сменил имя — обновляем его профили ролей, чтобы панель /admin показывала новое.
 * Возвращает названия отделов, которыми он руководит: там надо обновить колонку Manager.
 */
export async function renameRoleProfiles(env: Env, telegramId: number, name: string): Promise<string[]> {
  const [hr, superAdmins] = await Promise.all([getHrProfile(env), getSuperAdmins(env)]);
  if (hr && hr.telegramId === telegramId) {
    await setHrProfile(env, { ...hr, name });
  }
  if (superAdmins.some((p) => p.telegramId === telegramId)) {
    await saveSuperAdmins(
      env,
      superAdmins.map((p) => (p.telegramId === telegramId ? { ...p, name } : p))
    );
  }
  // один человек может руководить и несколькими отделами
  const managed: string[] = [];
  for (const d of DEPARTMENTS) {
    const mgr = await getManagerProfile(env, d.id);
    if (mgr && mgr.telegramId === telegramId) {
      await setManagerProfile(env, d.id, { ...mgr, name });
      managed.push(d.label);
    }
  }
  return managed;
}

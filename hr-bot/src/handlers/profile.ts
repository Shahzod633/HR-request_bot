import type { Env, Employee, Session, SessionState } from '../types';
import { sendMessage, type InlineKeyboard, type InlineButton } from '../telegram';
import { getSession, saveSession } from '../session';
import { findDepartment } from '../config';
import { buildDepartmentKeyboard } from '../keyboards';
import {
  getRoleInfo,
  isAdminLevel,
  isDepartmentRoleBound,
  getManagerProfile,
  renameRoleProfiles,
  type RoleInfo,
} from '../roles';
import { updateEmployeeName, updateEmployeeDepartment, syncDepartmentManager } from '../appsScriptClient';
import { runInBackground } from '../background';
import { showHomeMenu } from './menu';

const CANCEL_ROW: InlineButton[] = [{ text: '❌ Cancel', callback_data: 'profile:cancel' }];

const ROLE_BOUND_DEPARTMENT =
  'The department of HR, managers and Super Admin is tied to their role — it changes only when Admin reassigns the role.';

/**
 * Чей профиль открыт. Свой — у любого зарегистрированного, чужой (targetTelegramId) —
 * только у Admin и Super Admin: к ним ведёт кнопка "✏️ Edit" в списке сотрудников.
 */
export interface ProfileSubject {
  telegramId: number;
  isSelf: boolean;
  /** сессия владельца профиля — при правке чужого это не сессия редактирующего */
  session: Session;
  employee: Employee;
}

/** Об ошибке сообщает сам и возвращает null. */
export async function resolveProfileSubject(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  targetTelegramId?: number
): Promise<ProfileSubject | null> {
  if (!targetTelegramId || targetTelegramId === telegramId) {
    if (!session.employee) {
      await sendMessage(env, chatId, 'Please register first: /start');
      return null;
    }
    return { telegramId, isSelf: true, session, employee: session.employee };
  }

  if (!(await isAdminLevel(env, telegramId))) {
    await sendMessage(env, chatId, "Only Admin and Super Admin can edit other people's profiles.");
    return null;
  }
  const targetSession = await getSession(env, targetTelegramId);
  if (!targetSession.employee) {
    await sendMessage(env, chatId, "This person hasn't registered in the bot — there is no profile to edit.");
    return null;
  }
  return {
    telegramId: targetTelegramId,
    isSelf: false,
    session: targetSession,
    employee: targetSession.employee,
  };
}

/** Сохраняет новые данные владельца профиля и возвращает редактирующего в idle. */
export async function saveProfileSubject(
  env: Env,
  editorTelegramId: number,
  editorSession: Session,
  subject: ProfileSubject,
  employee: Employee
): Promise<void> {
  if (subject.isSelf) {
    await saveSession(env, editorTelegramId, { ...editorSession, employee, state: { step: 'idle' } });
    return;
  }
  // state владельца не трогаем — он может быть посреди своего флоу
  await saveSession(env, subject.telegramId, { ...subject.session, employee });
  await saveSession(env, editorTelegramId, { ...editorSession, state: { step: 'idle' } });
}

/** Текущий менеджер отдела: назначенный, иначе запасное имя из схемы, иначе сохранённое. */
async function currentManagerName(env: Env, departmentId: string, stored: string): Promise<string> {
  const mgr = departmentId ? await getManagerProfile(env, departmentId) : null;
  return mgr?.name || findDepartment(departmentId)?.manager || stored;
}

function roleLabel(roles: RoleInfo): string {
  const parts: string[] = [];
  if (roles.admin) parts.push('Admin');
  if (roles.superAdmin) parts.push('Super Admin');
  if (roles.hr) parts.push('HR');
  if (roles.managerOf) parts.push(`Manager of ${roles.managerOf.label}`);
  return parts.length ? parts.join(', ') : 'Employee';
}

/** Состояние правки: своего профиля — без targetTelegramId, чужого — с ним. */
export function editState(
  step: 'editing_profile_name' | 'editing_profile_department' | 'editing_shift_time',
  subject: ProfileSubject
): SessionState {
  return subject.isSelf ? { step } : { step, targetTelegramId: subject.telegramId };
}

// ---------- карточка ----------

export async function showProfile(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  targetTelegramId?: number
) {
  const subject = await resolveProfileSubject(env, chatId, telegramId, session, targetTelegramId);
  if (!subject) return;

  const roles = await getRoleInfo(env, subject.telegramId);
  const roleBound = isDepartmentRoleBound(roles);
  const e = subject.employee;

  const lines = [
    subject.isSelf ? '👤 My Profile' : `👤 Profile: ${e.name}`,
    '',
    `Name: ${e.name}`,
    `Department: ${e.department || '—'}`,
  ];
  // менеджер — текущий: его могли переименовать или сменить после регистрации сотрудника
  const manager = roleBound ? '' : await currentManagerName(env, e.departmentId, e.manager);
  if (manager) lines.push(`Manager: ${manager}`);
  if (!roleBound || e.scheduledStart) lines.push(`Shift starts: ${e.scheduledStart || 'not set'}`);
  lines.push(`Role: ${roleLabel(roles)}`);

  // свой профиль — те же callback'и без id, чужой — с id владельца
  const suffix = subject.isSelf ? '' : `:${subject.telegramId}`;
  const rows: InlineKeyboard['inline_keyboard'] = [
    [{ text: '✏️ Change name', callback_data: `profile:edit_name${suffix}` }],
  ];
  if (!roleBound) {
    rows.push([{ text: '🏢 Change department', callback_data: `profile:edit_department${suffix}` }]);
    // свой — та же кнопка, что "🕐 Shift time" в главном меню
    rows.push([
      {
        text: '🕐 Change shift time',
        callback_data: subject.isSelf ? 'home:shift' : `profile:edit_shift${suffix}`,
      },
    ]);
  }
  rows.push([{ text: '⬅️ Back', callback_data: 'home:back' }]);

  await sendMessage(env, chatId, lines.join('\n'), { inline_keyboard: rows });
}

export async function cancelProfileEdit(env: Env, chatId: number, telegramId: number, session: Session) {
  const step = session.state.step;
  if (step === 'editing_profile_name' || step === 'editing_profile_department') {
    await saveSession(env, telegramId, { ...session, state: { step: 'idle' } });
  }
  await sendMessage(env, chatId, 'Cancelled, nothing was changed.');
  await showHomeMenu(env, chatId, telegramId);
}

// ---------- имя ----------

export async function startNameEdit(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  targetTelegramId?: number
) {
  const subject = await resolveProfileSubject(env, chatId, telegramId, session, targetTelegramId);
  if (!subject) return;

  await saveSession(env, telegramId, { ...session, state: editState('editing_profile_name', subject) });
  await sendMessage(env, chatId, `Current name: ${subject.employee.name}\n\nEnter the new name:`, {
    inline_keyboard: [CANCEL_ROW],
  });
}

export async function handleNameEditInput(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  text: string
) {
  if (session.state.step !== 'editing_profile_name') return;

  const name = text.trim();
  if (!name) {
    await sendMessage(env, chatId, 'Name cannot be empty. Enter the new name:', {
      inline_keyboard: [CANCEL_ROW],
    });
    return;
  }

  const subject = await resolveProfileSubject(
    env,
    chatId,
    telegramId,
    session,
    session.state.targetTelegramId
  );
  if (!subject) {
    await saveSession(env, telegramId, { ...session, state: { step: 'idle' } });
    return;
  }

  const oldName = subject.employee.name;
  const roles = await getRoleInfo(env, subject.telegramId);
  const employee: Employee = {
    ...subject.employee,
    name,
    // у менеджера в поле manager записан он сам
    manager:
      roles.managerOf && subject.employee.manager === oldName ? name : subject.employee.manager,
  };

  await saveProfileSubject(env, telegramId, session, subject, employee);
  // HR / менеджер / Super Admin — чтобы панель /admin сразу показывала новое имя
  const managedDepartments = await renameRoleProfiles(env, subject.telegramId, name);
  // лист Employees + строка в листе текущего месяца
  runInBackground(updateEmployeeName(env, subject.telegramId, name, oldName));
  // переименовали менеджера — колонка Manager у сотрудников его отделов
  for (const department of managedDepartments) {
    runInBackground(syncDepartmentManager(env, department, name));
  }

  await sendMessage(env, chatId, `✅ Name updated: ${name}`);
  await showHomeMenu(env, chatId, telegramId);
}

// ---------- отдел ----------

export async function startDepartmentEdit(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  targetTelegramId?: number
) {
  const subject = await resolveProfileSubject(env, chatId, telegramId, session, targetTelegramId);
  if (!subject) return;

  if (isDepartmentRoleBound(await getRoleInfo(env, subject.telegramId))) {
    await sendMessage(env, chatId, ROLE_BOUND_DEPARTMENT);
    return;
  }

  await saveSession(env, telegramId, { ...session, state: editState('editing_profile_department', subject) });

  // та же клавиатура, что при регистрации, но свой префикс — не путается с регистрацией
  const keyboard = buildDepartmentKeyboard('profile:dept');
  keyboard.inline_keyboard.push(CANCEL_ROW);
  await sendMessage(
    env,
    chatId,
    `Current department: ${subject.employee.department || '—'}\n\nSelect the new department:`,
    keyboard
  );
}

export async function handleDepartmentEditChoice(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  departmentId: string
) {
  // кнопка из старого сообщения — правка уже закончена или отменена
  if (session.state.step !== 'editing_profile_department') return;

  const dept = findDepartment(departmentId);
  if (!dept) {
    await sendMessage(env, chatId, 'Unknown department');
    return;
  }

  const subject = await resolveProfileSubject(
    env,
    chatId,
    telegramId,
    session,
    session.state.targetTelegramId
  );
  if (!subject) {
    await saveSession(env, telegramId, { ...session, state: { step: 'idle' } });
    return;
  }
  if (isDepartmentRoleBound(await getRoleInfo(env, subject.telegramId))) {
    await saveSession(env, telegramId, { ...session, state: { step: 'idle' } });
    await sendMessage(env, chatId, ROLE_BOUND_DEPARTMENT);
    return;
  }

  // актуальный менеджер нового отдела, если назначен, иначе запасное имя — как при регистрации
  const mgr = await getManagerProfile(env, dept.id);
  const manager = mgr?.name || dept.manager;
  const employee: Employee = {
    ...subject.employee,
    department: dept.label,
    departmentId: dept.id,
    manager,
  };

  await saveProfileSubject(env, telegramId, session, subject, employee);
  runInBackground(updateEmployeeDepartment(env, subject.telegramId, dept.label, manager));

  await sendMessage(env, chatId, `✅ Department updated: ${dept.label}, manager: ${manager}`);
  await showHomeMenu(env, chatId, telegramId);
}

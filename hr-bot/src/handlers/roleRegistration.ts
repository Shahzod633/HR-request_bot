import type { Env, RoleKind, RoleProfile, Session } from '../types';
import { findDepartment } from '../config';
import { sendMessage, answerCallbackQuery } from '../telegram';
import { saveSession } from '../session';
import {
  setHrProfile,
  setManagerProfile,
  addSuperAdmin,
  getHrProfile,
  getManagerProfile,
} from '../roles';
import { registerRolePerson, syncDepartmentManager } from '../appsScriptClient';
import { syncSheetRole } from '../roleSheet';
import { runInBackground } from '../background';
import { buildDepartmentKeyboard } from '../keyboards';
import { showHomeMenu } from './menu';

/** "HR", "Super Admin" или "manager of Fleet" — для сообщений при назначении. */
function roleTitle(role: RoleKind, departmentLabel: string): string {
  if (role === 'hr') return 'HR';
  if (role === 'super_admin') return 'Super Admin';
  return `manager of ${departmentLabel}`;
}

/** После перехода по ссылке-приглашению просим человека представиться. */
export async function startRoleRegistration(
  env: Env,
  chatId: number,
  telegramId: number,
  role: RoleKind,
  departmentId?: string
) {
  await saveSession(env, telegramId, { state: { step: 'awaiting_role_name', role, departmentId } });

  const who = roleTitle(role, findDepartment(departmentId || '')?.label ?? '');
  await sendMessage(env, chatId, `You are being assigned as ${who}.\n\nEnter your name (First Last):`);
}

export async function handleRoleNameInput(
  env: Env,
  chatId: number,
  telegramId: number,
  text: string,
  role: RoleKind,
  departmentId: string | undefined,
  username?: string
) {
  const name = text.trim();
  if (!name) {
    await sendMessage(env, chatId, 'Name cannot be empty. Enter your name:');
    return;
  }

  // у менеджера отдел уже определён ссылкой — переспрашивать нечего
  if (role === 'manager' && departmentId) {
    const dept = findDepartment(departmentId);
    if (!dept) {
      await sendMessage(env, chatId, 'This link is broken, ask Admin for a new one.');
      return;
    }
    await finishRoleRegistration(env, chatId, telegramId, {
      telegramId,
      name,
      department: dept.label,
      username,
    }, role, departmentId);
    return;
  }

  // HR и Super Admin выбирают отдел сами
  await saveSession(env, telegramId, {
    state: { step: 'awaiting_role_department', role, name, username },
  });

  await sendMessage(env, chatId, 'Select your department:', buildDepartmentKeyboard('roledept'));
}

export async function handleRoleDepartmentChoice(
  env: Env,
  chatId: number,
  telegramId: number,
  callbackQueryId: string,
  role: RoleKind,
  name: string,
  departmentId: string,
  username?: string
) {
  const dept = findDepartment(departmentId);
  if (!dept) {
    await answerCallbackQuery(env, callbackQueryId, 'Unknown department');
    return;
  }
  await answerCallbackQuery(env, callbackQueryId);
  await finishRoleRegistration(
    env,
    chatId,
    telegramId,
    { telegramId, name, department: dept.label, username },
    role,
    departmentId
  );
}

async function finishRoleRegistration(
  env: Env,
  chatId: number,
  telegramId: number,
  profile: RoleProfile,
  role: RoleKind,
  departmentId: string
) {
  // HR и менеджер отдела — по одному: новый вытесняет прежнего. Super Admin — список
  const previous =
    role === 'hr'
      ? await getHrProfile(env)
      : role === 'manager'
        ? await getManagerProfile(env, departmentId)
        : null;

  if (role === 'hr') {
    await setHrProfile(env, profile);
  } else if (role === 'super_admin') {
    // Super Admin может быть несколько — новый добавляется к списку, никого не вытесняя
    await addSuperAdmin(env, profile);
  } else {
    await setManagerProfile(env, departmentId, profile);
  }

  // по порядку: сначала новый человек, потом прежний (его пометка пересчитывается
  // по оставшимся ролям), потом колонка Manager у сотрудников отдела
  runInBackground(
    (async () => {
      await registerRolePerson(env, {
        telegramId,
        name: profile.name,
        department: profile.department,
        username: profile.username || '',
        role: role === 'hr' ? 'HR' : role === 'super_admin' ? 'Super Admin' : 'Manager',
      });
      if (previous && previous.telegramId !== telegramId) {
        await syncSheetRole(env, previous.telegramId, previous);
        await sendMessage(
          env,
          previous.telegramId,
          `ℹ️ You are no longer ${roleTitle(role, profile.department)} — the role has been given to ${profile.name}.`
        );
      }
      if (role === 'manager') {
        await syncDepartmentManager(env, profile.department, profile.name);
      }
    })()
  );

  // HR, менеджер и Super Admin — тоже люди, которые опаздывают и берут отгулы,
  // поэтому заводим им и обычную запись сотрудника: иначе кнопка
  // "Make a report" им недоступна. Время смены укажут кнопкой.
  const dept = findDepartment(departmentId);
  const session: Session = {
    employee: {
      telegramId,
      name: profile.name,
      department: profile.department,
      departmentId,
      manager: role === 'manager' ? profile.name : dept?.manager || '',
      username: profile.username,
    },
    state: { step: 'idle' },
  };
  await saveSession(env, telegramId, session);

  const roleLabel = roleTitle(role, profile.department);
  const command = role === 'manager' ? '/manage' : '/admin';
  await sendMessage(
    env,
    chatId,
    `✅ ${profile.name}, you are now ${roleLabel}.\n\nFrom now on you will receive employee reports. Use ${command} to open your panel.`
  );
  await showHomeMenu(env, chatId, telegramId);
}

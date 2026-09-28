import type { Env, Session } from '../types';
import { findDepartment } from '../config';
import { sendMessage, answerCallbackQuery } from '../telegram';
import { saveSession } from '../session';
import { registerEmployee, updateShiftTime } from '../appsScriptClient';
import { showHomeMenu } from './menu';
import { resolveProfileSubject, saveProfileSubject, editState } from './profile';
import { parseClock, minutesToClock } from '../tjTime';
import { getManagerProfile } from '../roles';
import { runInBackground } from '../background';
import { buildDepartmentKeyboard } from '../keyboards';
import { hasEmployeeAccess, INVITE_ONLY_MESSAGE } from '../access';

export async function startRegistration(env: Env, chatId: number, telegramId: number) {
  await saveSession(env, telegramId, { state: { step: 'awaiting_name' } });
  await sendMessage(env, chatId, 'Welcome to HR Request Center 👋\n\nEnter your name (First Last):');
}

export async function handleNameInput(
  env: Env,
  chatId: number,
  telegramId: number,
  text: string,
  username?: string
) {
  // без сохранённой сессии любой текст попадает сюда как "имя" —
  // пускаем только тех, кто пришёл по приглашению (или Admin/Super Admin)
  if (!(await hasEmployeeAccess(env, telegramId))) {
    await sendMessage(env, chatId, INVITE_ONLY_MESSAGE);
    return;
  }

  const name = text.trim();
  if (!name) {
    await sendMessage(env, chatId, 'Name cannot be empty. Enter your name:');
    return;
  }

  await saveSession(env, telegramId, { state: { step: 'awaiting_department', name, username } });

  await sendMessage(env, chatId, 'Select your department:', buildDepartmentKeyboard('dept'));
}

/** После выбора отдела спрашиваем время начала смены — без него не работает Late Notification. */
export async function handleDepartmentChoice(
  env: Env,
  chatId: number,
  telegramId: number,
  callbackQueryId: string,
  name: string,
  departmentId: string,
  username?: string
) {
  const dept = findDepartment(departmentId);
  if (!dept) {
    await answerCallbackQuery(env, callbackQueryId, 'Unknown department');
    return;
  }

  await saveSession(env, telegramId, {
    state: { step: 'awaiting_shift_time', name, departmentId, username },
  });

  const mgr = await getManagerProfile(env, departmentId);
  const managerName = mgr?.name || dept.manager;

  await answerCallbackQuery(env, callbackQueryId);
  await sendMessage(
    env,
    chatId,
    `Department: ${dept.label}, manager: ${managerName}.\n\nWhat time does your shift start? Send the time as HH:MM — for example 20:00`
  );
}

export async function handleShiftTimeInput(
  env: Env,
  chatId: number,
  telegramId: number,
  text: string,
  name: string,
  departmentId: string,
  username?: string
) {
  const minutes = parseClock(text);
  if (minutes === null) {
    await sendMessage(env, chatId, "Couldn't read that time. Use HH:MM format, for example 20:00");
    return;
  }
  const scheduledStart = minutesToClock(minutes);

  const dept = findDepartment(departmentId);
  if (!dept) {
    await sendMessage(env, chatId, 'Something went wrong with the department. Type /start to begin again.');
    return;
  }

  const mgr = await getManagerProfile(env, departmentId);
  const managerName = mgr?.name || dept.manager;

  // запись в Google Sheets — в фоне, сотруднику отвечаем сразу
  runInBackground(
    registerEmployee(env, telegramId, name, dept.label, managerName, username, scheduledStart)
  );
  const finalName = name;

  const session: Session = {
    employee: {
      telegramId,
      name: finalName,
      department: dept.label,
      departmentId: dept.id,
      manager: managerName,
      username,
      scheduledStart,
    },
    state: { step: 'idle' },
  };
  await saveSession(env, telegramId, session);

  await sendMessage(
    env,
    chatId,
    `All set! ${finalName}, department: ${dept.label}, manager: ${managerName}, shift starts at ${scheduledStart}.`
  );
  await showHomeMenu(env, chatId, telegramId);
}

/**
 * Смена времени смены — из главного меню или из профиля, если график поменялся.
 * targetTelegramId — Admin/Super Admin меняет время чужой смены из списка сотрудников.
 */
export async function startShiftTimeEdit(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  targetTelegramId?: number
) {
  const subject = await resolveProfileSubject(env, chatId, telegramId, session, targetTelegramId);
  if (!subject) return;
  await saveSession(env, telegramId, { ...session, state: editState('editing_shift_time', subject) });
  const whose = subject.isSelf ? '' : ` for ${subject.employee.name}`;
  await sendMessage(
    env,
    chatId,
    `Current shift start${whose}: ${subject.employee.scheduledStart || 'not set'}.\n\nSend the new time as HH:MM — for example 09:00`
  );
}

export async function handleShiftTimeEdit(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  text: string
) {
  const minutes = parseClock(text);
  if (minutes === null) {
    await sendMessage(env, chatId, "Couldn't read that time. Use HH:MM format, for example 09:00");
    return;
  }
  const scheduledStart = minutesToClock(minutes);

  const target = session.state.step === 'editing_shift_time' ? session.state.targetTelegramId : undefined;
  const subject = await resolveProfileSubject(env, chatId, telegramId, session, target);
  if (!subject) {
    await saveSession(env, telegramId, { ...session, state: { step: 'idle' } });
    return;
  }

  const employee = { ...subject.employee, scheduledStart };
  runInBackground(updateShiftTime(env, subject.telegramId, scheduledStart));
  await saveProfileSubject(env, telegramId, session, subject, employee);

  const whose = subject.isSelf ? '' : ` for ${employee.name}`;
  await sendMessage(env, chatId, `✅ Shift start updated${whose}: ${scheduledStart}`);
  await showHomeMenu(env, chatId, telegramId);
}

import type { Env, Employee } from '../types';
import { sendMessage, type InlineKeyboard } from '../telegram';
import { getSession } from '../session';
import { buildMessageButtons } from '../keyboards';
import {
  getHrTelegramId,
  getManagerTelegramId,
  getHrProfile,
  getManagerProfile,
  getSuperAdmins,
} from '../roles';

/**
 * Рассылает уведомление всем ответственным: менеджеру отдела, HR, Super Admin и Admin.
 * Set убирает дубли, если один человек занимает несколько ролей.
 */
export async function notifyResponsible(
  env: Env,
  employee: Employee,
  text: string,
  extraButtons: InlineKeyboard['inline_keyboard'] = []
) {
  // переписка через бота — всегда; прямая ссылка на чат — если у сотрудника есть username
  const keyboard: InlineKeyboard = {
    inline_keyboard: [
      ...extraButtons,
      buildMessageButtons(employee.telegramId, employee.username, `✍️ Message ${employee.name}`),
    ],
  };

  const [managerId, hrId, superAdmins] = await Promise.all([
    getManagerTelegramId(env, employee.departmentId),
    getHrTelegramId(env),
    getSuperAdmins(env),
  ]);

  const recipients = new Set<string>();
  if (managerId) recipients.add(managerId);
  if (hrId) recipients.add(hrId);
  for (const sa of superAdmins) recipients.add(String(sa.telegramId));
  if (env.ADMIN_TELEGRAM_ID) recipients.add(env.ADMIN_TELEGRAM_ID);

  // параллельно — иначе каждый получатель добавляет секунду ожидания
  await Promise.all([...recipients].map((id) => sendMessage(env, Number(id), text, keyboard)));
}

/** Отдельный алерт только HR, Super Admin и Admin — например о повторных опозданиях. */
export async function notifyHrAndAdmin(env: Env, text: string) {
  const [hrId, superAdmins] = await Promise.all([getHrTelegramId(env), getSuperAdmins(env)]);

  const recipients = new Set<string>();
  if (hrId) recipients.add(hrId);
  for (const sa of superAdmins) recipients.add(String(sa.telegramId));
  if (env.ADMIN_TELEGRAM_ID) recipients.add(env.ADMIN_TELEGRAM_ID);

  await Promise.all([...recipients].map((id) => sendMessage(env, Number(id), text)));
}

/**
 * Кнопки "написать" ответственным — показываем сотруднику, когда его заявку
 * заблокировал лимит и надо связаться с людьми. Переписка через бота — всегда,
 * прямая ссылка на чат — если у ответственного есть username.
 * selfTelegramId — сам сотрудник: себе писать незачем, даже если он, скажем, менеджер.
 */
export async function buildContactButtons(
  env: Env,
  departmentId: string,
  selfTelegramId: number
): Promise<InlineKeyboard['inline_keyboard']> {
  const [manager, hr, superAdmins] = await Promise.all([
    getManagerProfile(env, departmentId),
    getHrProfile(env),
    getSuperAdmins(env),
  ]);

  const contacts: { text: string; telegramId: number; username?: string }[] = [];
  if (manager) {
    contacts.push({ text: `👔 Manager: ${manager.name || 'message'}`, telegramId: manager.telegramId, username: manager.username });
  }
  if (hr) contacts.push({ text: `🧑‍💼 HR: ${hr.name || 'message'}`, telegramId: hr.telegramId, username: hr.username });
  for (const sa of superAdmins) {
    contacts.push({
      text: `🛡 Super Admin: ${sa.name || 'message'}`,
      telegramId: sa.telegramId,
      username: sa.username,
    });
  }
  const adminId = Number(env.ADMIN_TELEGRAM_ID);
  if (adminId) contacts.push({ text: '⚙️ Admin', telegramId: adminId });

  const unique = contacts.filter(
    (c, i) => c.telegramId !== selfTelegramId && contacts.findIndex((x) => x.telegramId === c.telegramId) === i
  );
  // свежий username — из сессии (его обновляет каждый /start), иначе из профиля роли
  const sessions = await Promise.all(unique.map((c) => getSession(env, c.telegramId)));
  return unique.map((c, i) =>
    buildMessageButtons(c.telegramId, sessions[i].employee?.username || c.username, c.text)
  );
}

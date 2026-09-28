import type { Env, Employee } from '../types';
import { sendMessage, type InlineKeyboard } from '../telegram';
import { buildMessageButtons } from '../keyboards';
import {
  getHrTelegramId,
  getManagerTelegramId,
  getSuperAdminTelegramId,
  getHrProfile,
  getManagerProfile,
  getSuperAdminProfile,
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

  const [managerId, hrId, superAdminId] = await Promise.all([
    getManagerTelegramId(env, employee.departmentId),
    getHrTelegramId(env),
    getSuperAdminTelegramId(env),
  ]);

  const recipients = new Set<string>();
  if (managerId) recipients.add(managerId);
  if (hrId) recipients.add(hrId);
  if (superAdminId) recipients.add(superAdminId);
  if (env.ADMIN_TELEGRAM_ID) recipients.add(env.ADMIN_TELEGRAM_ID);

  // параллельно — иначе каждый получатель добавляет секунду ожидания
  await Promise.all([...recipients].map((id) => sendMessage(env, Number(id), text, keyboard)));
}

/** Отдельный алерт только HR, Super Admin и Admin — например о повторных опозданиях. */
export async function notifyHrAndAdmin(env: Env, text: string) {
  const [hrId, superAdminId] = await Promise.all([
    getHrTelegramId(env),
    getSuperAdminTelegramId(env),
  ]);

  const recipients = new Set<string>();
  if (hrId) recipients.add(hrId);
  if (superAdminId) recipients.add(superAdminId);
  if (env.ADMIN_TELEGRAM_ID) recipients.add(env.ADMIN_TELEGRAM_ID);

  await Promise.all([...recipients].map((id) => sendMessage(env, Number(id), text)));
}

/**
 * Кнопки "написать" ответственным — показываем сотруднику, когда его заявку
 * заблокировал лимит и надо связаться с людьми напрямую. Переписка идёт через бота.
 * selfTelegramId — сам сотрудник: себе писать незачем, даже если он, скажем, менеджер.
 */
export async function buildContactButtons(
  env: Env,
  departmentId: string,
  selfTelegramId: number
): Promise<InlineKeyboard['inline_keyboard']> {
  const [manager, hr, superAdmin] = await Promise.all([
    getManagerProfile(env, departmentId),
    getHrProfile(env),
    getSuperAdminProfile(env),
  ]);

  const contacts: { text: string; telegramId: number }[] = [];
  if (manager) contacts.push({ text: `👔 Manager: ${manager.name || 'message'}`, telegramId: manager.telegramId });
  if (hr) contacts.push({ text: `🧑‍💼 HR: ${hr.name || 'message'}`, telegramId: hr.telegramId });
  if (superAdmin) {
    contacts.push({
      text: `🛡 Super Admin: ${superAdmin.name || 'message'}`,
      telegramId: superAdmin.telegramId,
    });
  }
  const adminId = Number(env.ADMIN_TELEGRAM_ID);
  if (adminId) contacts.push({ text: '⚙️ Admin', telegramId: adminId });

  const rows: InlineKeyboard['inline_keyboard'] = [];
  const seen = new Set<number>([selfTelegramId]);
  for (const c of contacts) {
    if (seen.has(c.telegramId)) continue;
    seen.add(c.telegramId);
    rows.push([{ text: c.text, callback_data: `msg:${c.telegramId}` }]);
  }
  return rows;
}

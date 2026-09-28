import type { Env } from '../types';
import { REPORT_TYPES } from '../config';
import { sendMessage, type InlineKeyboard } from '../telegram';
import { isAdminLevel, getHrProfile, findManagerDepartment } from '../roles';

/**
 * Главный экран. Набор кнопок зависит от роли:
 * сотрудник видит только репорты и свой профиль, Admin, Super Admin и HR — ещё
 * свою панель, менеджер — панель своего отдела.
 */
export async function showHomeMenu(env: Env, chatId: number, telegramId: number) {
  const rows: InlineKeyboard['inline_keyboard'] = [
    [{ text: '📝 Make a report', callback_data: 'home:report' }],
  ];

  const [hrProfile, mgrDept, adminLevel] = await Promise.all([
    getHrProfile(env),
    findManagerDepartment(env, telegramId),
    isAdminLevel(env, telegramId),
  ]);

  const isHr = !!hrProfile && hrProfile.telegramId === telegramId;

  if (adminLevel || isHr) {
    rows.push([{ text: '⚙️ Admin', callback_data: 'home:admin' }]);
  }
  if (mgrDept) {
    rows.push([{ text: '👔 Manage', callback_data: 'home:manage' }]);
  }
  rows.push([{ text: '🕐 Shift time', callback_data: 'home:shift' }]);
  rows.push([{ text: '👤 My Profile', callback_data: 'profile:show' }]);

  await sendMessage(env, chatId, 'Main menu', { inline_keyboard: rows });
}

/** Список из 7 типов репортов. */
export async function showReportMenu(env: Env, chatId: number) {
  const rows: InlineKeyboard['inline_keyboard'] = REPORT_TYPES.map((r) => [
    { text: r.label, callback_data: `menu:${r.id}` },
  ]);
  rows.push([{ text: '⬅️ Back', callback_data: 'home:back' }]);

  await sendMessage(env, chatId, 'Select report type:', { inline_keyboard: rows });
}

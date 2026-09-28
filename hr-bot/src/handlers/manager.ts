import type { Env } from '../types';
import { sendMessage, answerCallbackQuery, type InlineKeyboard } from '../telegram';
import { findManagerDepartment } from '../roles';
import { sendEmployeeList } from './employeeList';

/** Панель менеджера — команда /manage. Своя, отдельная от /admin. */
export async function handleManageCommand(env: Env, chatId: number, telegramId: number) {
  const dept = await findManagerDepartment(env, telegramId);
  if (!dept) {
    await sendMessage(env, chatId, 'This command is available to department managers only.');
    return;
  }

  const keyboard: InlineKeyboard = {
    inline_keyboard: [
      [{ text: '👥 Department employees', callback_data: 'manage:employees' }],
    ],
  };
  await sendMessage(
    env,
    chatId,
    `Manager panel.\nYour department: ${dept.label}\n\nYou receive all reports from employees of this department.`,
    keyboard
  );
}

export async function handleManageCallback(
  env: Env,
  chatId: number,
  telegramId: number,
  callbackQueryId: string,
  data: string
) {
  const dept = await findManagerDepartment(env, telegramId);
  if (!dept) {
    await answerCallbackQuery(env, callbackQueryId, 'Not available');
    return;
  }

  if (data === 'manage:employees') {
    await answerCallbackQuery(env, callbackQueryId);
    await sendEmployeeList(env, chatId, telegramId, dept.label);
    return;
  }

  await answerCallbackQuery(env, callbackQueryId);
}

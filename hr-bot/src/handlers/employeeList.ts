import type { Env } from '../types';
import { sendMessage, type InlineButton } from '../telegram';
import { listEmployees } from '../appsScriptClient';
import { isAdminLevel } from '../roles';

/**
 * Список сотрудников с кнопкой "Написать" у каждого (переписка идёт через бота)
 * и, для Admin и Super Admin, кнопкой правки профиля.
 * departmentFilter — для панели менеджера: он видит только свой отдел.
 */
export async function sendEmployeeList(
  env: Env,
  chatId: number,
  viewerTelegramId: number,
  departmentFilter?: string
) {
  const [all, canEdit] = await Promise.all([
    listEmployees(env),
    isAdminLevel(env, viewerTelegramId),
  ]);
  // HR и Super Admin менеджеру не подчиняются, даже если числятся в его отделе
  const employees = departmentFilter
    ? all.filter(
        (e) => e.department === departmentFilter && e.role !== 'HR' && e.role !== 'Super Admin'
      )
    : all;

  if (employees.length === 0) {
    await sendMessage(
      env,
      chatId,
      departmentFilter
        ? `No registered employees in ${departmentFilter} yet.`
        : 'No registered employees yet.'
    );
    return;
  }

  const header = departmentFilter
    ? `👥 ${departmentFilter}: ${employees.length}`
    : `👥 Registered employees: ${employees.length}`;
  await sendMessage(env, chatId, header);

  // по одному сообщению на сотрудника — иначе кнопки нельзя
  // привязать к конкретному человеку (Telegram привязывает клавиатуру к сообщению)
  for (const emp of employees) {
    const shift = emp.scheduledStart ? `\nShift starts: ${emp.scheduledStart}` : '';
    const role = emp.role && emp.role !== 'Employee' ? `\nRole: ${emp.role}` : '';
    const text = `${emp.name}\nDepartment: ${emp.department || '—'}${shift}${role}`;

    const buttons: InlineButton[] = [];
    if (emp.telegramId && emp.telegramId !== viewerTelegramId) {
      buttons.push({ text: '✍️ Message', callback_data: `msg:${emp.telegramId}` });
    }
    if (canEdit && emp.telegramId) {
      buttons.push({ text: '✏️ Edit', callback_data: `profile:show:${emp.telegramId}` });
    }
    await sendMessage(env, chatId, text, buttons.length ? { inline_keyboard: [buttons] } : undefined);
  }
}

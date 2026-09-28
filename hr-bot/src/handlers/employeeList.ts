import type { Env } from '../types';
import { sendMessage, type InlineKeyboard } from '../telegram';
import { listEmployees } from '../appsScriptClient';
import { isAdminLevel } from '../roles';
import { buildMessageButtons } from '../keyboards';

/**
 * Список сотрудников с кнопками связи у каждого (через бота и, если есть username,
 * напрямую) и, для Admin и Super Admin, кнопкой правки профиля.
 * departmentFilter — для панели менеджера: он видит только свой отдел.
 */
export async function sendEmployeeList(
  env: Env,
  chatId: number,
  viewerTelegramId: number,
  departmentFilter?: string
) {
  const [roster, canEdit] = await Promise.all([
    listEmployees(env),
    isAdminLevel(env, viewerTelegramId),
  ]);

  // таблица не ответила — это не "сотрудников нет", говорим как есть
  if (!roster.ok) {
    await sendMessage(
      env,
      chatId,
      `⚠️ Couldn't load the employee list from Google Sheets.\n\nReason: ${roster.error}\n\nTry again in a minute. If it keeps failing, check Apps Script → Executions.`
    );
    return;
  }

  // HR и Super Admin менеджеру не подчиняются, даже если числятся в его отделе
  const employees = departmentFilter
    ? roster.employees.filter(
        (e) => e.department === departmentFilter && e.role !== 'HR' && e.role !== 'Super Admin'
      )
    : roster.employees;

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

    const rows: InlineKeyboard['inline_keyboard'] = [];
    if (emp.telegramId && emp.telegramId !== viewerTelegramId) {
      rows.push(buildMessageButtons(emp.telegramId, emp.username, '✍️ Message'));
    }
    if (canEdit && emp.telegramId) {
      rows.push([{ text: '✏️ Edit', callback_data: `profile:show:${emp.telegramId}` }]);
    }
    await sendMessage(env, chatId, text, rows.length ? { inline_keyboard: rows } : undefined);
  }
}

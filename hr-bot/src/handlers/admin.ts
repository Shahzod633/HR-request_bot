import type { Env, RoleProfile } from '../types';
import { sendMessage, answerCallbackQuery, type InlineKeyboard } from '../telegram';
import {
  isAdmin,
  isAdminLevel,
  getHrTelegramId,
  getHrProfile,
  getSuperAdmins,
  removeSuperAdmin,
  getManagerProfile,
  createInvite,
  consumeInvite,
  buildInviteLink,
  findManagerDepartment,
} from '../roles';
import { startRoleRegistration } from './roleRegistration';
import { startRegistration } from './registration';
import { grantEmployeeAccess } from '../access';
import { sendEmployeeList } from './employeeList';
import { DEPARTMENTS, findDepartment } from '../config';
import { registerRolePerson } from '../appsScriptClient';
import { runInBackground } from '../background';

const personName = (p: RoleProfile) => p.name || `id ${p.telegramId}`;

/**
 * Меню владельца: кто сейчас Super Admin и снятие роли.
 *   admin:super_admins        — список, у каждого кнопка «❌ Remove»
 *   admin:sa_remove:<id>      — подтверждение
 *   admin:sa_remove_yes:<id>  — снять роль
 */
async function handleSuperAdminsMenu(env: Env, chatId: number, data: string) {
  if (data === 'admin:super_admins') {
    const list = await getSuperAdmins(env);
    if (!list.length) {
      await sendMessage(env, chatId, 'No Super Admins yet. Add one with «🛡 Assign Super Admin».');
      return;
    }
    await sendMessage(env, chatId, `🛡 Super Admins: ${list.length}`);
    for (const p of list) {
      await sendMessage(env, chatId, `${personName(p)}\nDepartment: ${p.department || '—'}`, {
        inline_keyboard: [[{ text: '❌ Remove', callback_data: `admin:sa_remove:${p.telegramId}` }]],
      });
    }
    return;
  }

  const [, action, rawId] = data.split(':');
  const telegramId = Number(rawId);
  const target = (await getSuperAdmins(env)).find((p) => p.telegramId === telegramId);
  if (!target) {
    await sendMessage(env, chatId, 'This person is not a Super Admin anymore.');
    return;
  }

  if (action === 'sa_remove') {
    await sendMessage(env, chatId, `Remove the Super Admin role from ${personName(target)}?`, {
      inline_keyboard: [
        [{ text: '✅ Yes, remove', callback_data: `admin:sa_remove_yes:${telegramId}` }],
        [{ text: '❌ Cancel', callback_data: 'admin:super_admins' }],
      ],
    });
    return;
  }

  if (action === 'sa_remove_yes') {
    await removeSuperAdmin(env, telegramId);
    // профиль сотрудника остаётся; в листе Employees пометку роли меняем на Employee
    runInBackground(
      registerRolePerson(env, {
        telegramId,
        name: target.name,
        department: target.department,
        username: target.username || '',
        role: 'Employee',
      })
    );
    await sendMessage(env, telegramId, 'ℹ️ Your Super Admin role has been removed by Admin.');
    await sendMessage(env, chatId, `✅ ${personName(target)} is no longer a Super Admin.`);
  }
}

export async function handleAdminCommand(env: Env, chatId: number, telegramId: number) {
  const admin = isAdmin(env, telegramId);
  const adminLevel = await isAdminLevel(env, telegramId);
  const hrId = await getHrTelegramId(env);
  const isHr = !!hrId && String(telegramId) === hrId;

  if (!adminLevel && !isHr) {
    const mgrDept = await findManagerDepartment(env, telegramId);
    if (mgrDept) {
      await sendMessage(env, chatId, 'Your manager panel opens with /manage');
      return;
    }
    await sendMessage(env, chatId, 'This command is available to Admin, Super Admin and HR only.');
    return;
  }

  const rows: InlineKeyboard['inline_keyboard'] = [
    [{ text: '👥 Employee list', callback_data: 'admin:list_employees' }],
  ];

  rows.push([{ text: '✉️ Invite employee', callback_data: 'admin:invite_employee' }]);
  rows.push([{ text: '👔 Assign manager', callback_data: 'admin:managers' }]);

  // назначать HR могут Admin и Super Admin
  if (adminLevel) {
    rows.push([{ text: '➕ Assign HR', callback_data: 'admin:assign_hr' }]);
  }
  // назначать и снимать Super Admin — только настоящий Admin (владелец бота)
  if (admin) {
    rows.push([{ text: '🛡 Assign Super Admin', callback_data: 'admin:assign_super_admin' }]);
    rows.push([{ text: '🛡 Super Admins', callback_data: 'admin:super_admins' }]);
  }

  const title = admin ? 'Admin panel.' : adminLevel ? 'Super Admin panel.' : 'HR panel.';
  const [hrProfile, superAdmins] = await Promise.all([getHrProfile(env), getSuperAdmins(env)]);
  const hrLine = hrProfile
    ? `Current HR: ${hrProfile.name || `id ${hrProfile.telegramId}`}`
    : 'HR is not assigned yet.';
  const superAdminLine = superAdmins.length
    ? `Super Admins (${superAdmins.length}): ${superAdmins.map(personName).join(', ')}`
    : 'No Super Admins yet.';

  const mgrLines: string[] = [];
  for (const d of DEPARTMENTS) {
    const m = await getManagerProfile(env, d.id);
    mgrLines.push(`• ${d.label}: ${m ? m.name || `id ${m.telegramId}` : 'not assigned'}`);
  }

  const body = `${title}\n${hrLine}\n${superAdminLine}\n\nManagers:\n${mgrLines.join('\n')}`;
  await sendMessage(env, chatId, body, { inline_keyboard: rows });
}

export async function handleAdminCallback(
  env: Env,
  chatId: number,
  telegramId: number,
  callbackQueryId: string,
  data: string
) {
  const admin = isAdmin(env, telegramId);
  const adminLevel = await isAdminLevel(env, telegramId);
  const hrId = await getHrTelegramId(env);
  const isHr = !!hrId && String(telegramId) === hrId;

  if (!adminLevel && !isHr) {
    await answerCallbackQuery(env, callbackQueryId, 'Not available');
    return;
  }

  if (data === 'admin:list_employees') {
    await answerCallbackQuery(env, callbackQueryId);
    await sendEmployeeList(env, chatId, telegramId);
    return;
  }

  if (data === 'admin:invite_employee') {
    const token = await createInvite(env, { role: 'employee' });
    await answerCallbackQuery(env, callbackQueryId);
    await sendMessage(
      env,
      chatId,
      `Employee invite link (single use, valid 24 hours):\n${buildInviteLink(env, token)}\n\nForward it to the new employee. Without this link nobody outside the company can register in the bot.`
    );
    return;
  }

  // назначать Super Admin может только настоящий Admin
  if (data === 'admin:assign_super_admin') {
    if (!admin) {
      await answerCallbackQuery(env, callbackQueryId, 'Only Admin can assign Super Admin');
      return;
    }
    const token = await createInvite(env, { role: 'super_admin' });
    await answerCallbackQuery(env, callbackQueryId);
    await sendMessage(
      env,
      chatId,
      `Super Admin assignment link (single use, valid 24 hours):\n${buildInviteLink(env, token)}\n\nForward it to the right person. Once they open the link they are added to the Super Admins — the current ones keep their role.`
    );
    return;
  }

  // список Super Admin и снятие роли — только настоящий Admin
  if (data === 'admin:super_admins' || data.startsWith('admin:sa_')) {
    if (!admin) {
      await answerCallbackQuery(env, callbackQueryId, 'Only Admin can manage Super Admins');
      return;
    }
    await answerCallbackQuery(env, callbackQueryId);
    await handleSuperAdminsMenu(env, chatId, data);
    return;
  }

  // назначать HR могут Admin и Super Admin, всё остальное доступно и HR
  if (data === 'admin:assign_hr' && !adminLevel) {
    await answerCallbackQuery(env, callbackQueryId, 'Only Admin or Super Admin can assign HR');
    return;
  }

  if (data === 'admin:assign_hr') {
    const token = await createInvite(env, { role: 'hr' });
    await answerCallbackQuery(env, callbackQueryId);
    await sendMessage(
      env,
      chatId,
      `HR assignment link (single use, valid 24 hours):\n${buildInviteLink(env, token)}\n\nForward it to the right person. Once they open the link they become HR (the previous HR is replaced).`
    );
    return;
  }

  if (data === 'admin:managers') {
    await answerCallbackQuery(env, callbackQueryId);
    const rows: InlineKeyboard['inline_keyboard'] = [];
    for (const d of DEPARTMENTS) {
      const current = await getManagerProfile(env, d.id);
      const mark = current ? '✅' : '—';
      const who = current ? current.name || `id ${current.telegramId}` : 'vacant';
      rows.push([{ text: `${mark} ${d.label} — ${who}`, callback_data: `admin:mgr:${d.id}` }]);
    }
    await sendMessage(
      env,
      chatId,
      'Pick a department to get an assignment link for its manager.\n✅ — manager already assigned.',
      { inline_keyboard: rows }
    );
    return;
  }

  if (data.startsWith('admin:mgr:')) {
    const departmentId = data.slice('admin:mgr:'.length);
    const dept = findDepartment(departmentId);
    if (!dept) {
      await answerCallbackQuery(env, callbackQueryId, 'Unknown department');
      return;
    }
    const token = await createInvite(env, { role: 'manager', departmentId });
    await answerCallbackQuery(env, callbackQueryId);
    await sendMessage(
      env,
      chatId,
      `Manager assignment link for ${dept.label} (single use, valid 24 hours):\n${buildInviteLink(env, token)}\n\nForward it to the right person. After opening it they will introduce themselves and start receiving all reports from their department.`
    );
    return;
  }

  await answerCallbackQuery(env, callbackQueryId);
}

/** Вызывается при /start inv_<token> — присвоение роли HR, Super Admin или менеджера. */
export async function handleInviteClaim(
  env: Env,
  chatId: number,
  telegramId: number,
  token: string
) {
  const payload = await consumeInvite(env, token);
  if (!payload) {
    await sendMessage(env, chatId, 'This link is invalid or has already been used.');
    return;
  }

  if (payload.role === 'employee') {
    await grantEmployeeAccess(env, telegramId);
    await startRegistration(env, chatId, telegramId);
    return;
  }

  if (payload.role === 'hr' || payload.role === 'super_admin') {
    await startRoleRegistration(env, chatId, telegramId, payload.role);
    return;
  }

  if (payload.role === 'manager' && payload.departmentId) {
    if (!findDepartment(payload.departmentId)) {
      await sendMessage(env, chatId, 'This link is broken, ask Admin for a new one.');
      return;
    }
    await startRoleRegistration(env, chatId, telegramId, 'manager', payload.departmentId);
    return;
  }

  await sendMessage(env, chatId, 'This link is broken, ask Admin for a new one.');
}

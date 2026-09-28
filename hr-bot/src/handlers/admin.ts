import type { Env } from '../types';
import { sendMessage, answerCallbackQuery, type InlineKeyboard } from '../telegram';
import {
  isAdmin,
  isAdminLevel,
  getHrTelegramId,
  getHrProfile,
  getSuperAdminProfile,
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
  // назначать Super Admin — только настоящий Admin
  if (admin) {
    rows.push([{ text: '🛡 Assign Super Admin', callback_data: 'admin:assign_super_admin' }]);
  }

  const title = admin ? 'Admin panel.' : adminLevel ? 'Super Admin panel.' : 'HR panel.';
  const [hrProfile, superAdminProfile] = await Promise.all([
    getHrProfile(env),
    getSuperAdminProfile(env),
  ]);
  const hrLine = hrProfile
    ? `Current HR: ${hrProfile.name || `id ${hrProfile.telegramId}`}`
    : 'HR is not assigned yet.';
  const superAdminLine = superAdminProfile
    ? `Current Super Admin: ${superAdminProfile.name || `id ${superAdminProfile.telegramId}`}`
    : 'Super Admin is not assigned yet.';

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
      `Super Admin assignment link (single use, valid 24 hours):\n${buildInviteLink(env, token)}\n\nForward it to the right person. Once they open the link they become Super Admin (the previous Super Admin is replaced).`
    );
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

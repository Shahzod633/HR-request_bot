import type { Env, Session, TgUpdate } from './types';
import { getSession, saveSession } from './session';
import { sendMessage, answerCallbackQuery, setWebhook } from './telegram';
import {
  startRegistration,
  handleNameInput,
  handleDepartmentChoice,
  handleShiftTimeInput,
  startShiftTimeEdit,
  handleShiftTimeEdit,
} from './handlers/registration';
import { showHomeMenu, showReportMenu } from './handlers/menu';
import { startReportFlow, handleReportCallback, handleReportText } from './handlers/reportFlow';
import { handleAdminCommand, handleAdminCallback, handleInviteClaim } from './handlers/admin';
import { handleManageCommand, handleManageCallback } from './handlers/manager';
import {
  handleRoleNameInput,
  handleRoleDepartmentChoice,
} from './handlers/roleRegistration';
import { handleMessageCallback, handleComposeText, relayToActivePeer } from './handlers/relay';
import {
  showProfile,
  cancelProfileEdit,
  startNameEdit,
  handleNameEditInput,
  startDepartmentEdit,
  handleDepartmentEditChoice,
} from './handlers/profile';
import {
  getHrProfile,
  getSuperAdmins,
  findManagerDepartment,
  getManagerProfile,
} from './roles';
import { withExecutionContext, runInBackground } from './background';
import { hasEmployeeAccess, INVITE_ONLY_MESSAGE } from './access';
import { findReportType, findDepartmentByLabel } from './config';
import { updateUsername } from './appsScriptClient';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Разовый служебный маршрут для регистрации вебхука в Telegram:
    // GET /setup?url=https://<worker-url>/webhook
    if (url.pathname === '/setup' && request.method === 'GET') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('missing ?url=', { status: 400 });
      const result = await setWebhook(env, target);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname !== '/webhook' || request.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }

    let update: TgUpdate;
    try {
      update = await request.json();
    } catch {
      return new Response('bad request', { status: 400 });
    }

    try {
      // фоновые задачи этого апдейта попадут в ctx именно этого запроса
      await withExecutionContext(ctx, () => handleUpdate(env, update));
    } catch (err) {
      console.error('handleUpdate failed:', err);
    }

    // Telegram ждёт 200 в любом случае, иначе будет ретраить апдейт
    return new Response('OK', { status: 200 });
  },
};

async function handleUpdate(env: Env, update: TgUpdate) {
  if (update.message) {
    const chatId = update.message.chat.id;
    const telegramId = update.message.from.id;
    const text = update.message.text ?? '';
    const username = update.message.from.username;

    // Telegram иногда дописывает @username бота к команде — учитываем это
    const rawText = text.split('@')[0];

    if (rawText === '/manage') {
      await handleManageCommand(env, chatId, telegramId);
      return;
    }

    if (rawText === '/admin') {
      await handleAdminCommand(env, chatId, telegramId);
      return;
    }

    if (rawText.startsWith('/start')) {
      const payload = rawText.slice('/start'.length).trim();

      if (payload.startsWith('inv_')) {
        await handleInviteClaim(env, chatId, telegramId, payload.slice('inv_'.length));
        return;
      }
      // старый формат ссылок на HR — поддерживаем, чтобы уже разосланные не сломались
      if (payload.startsWith('hr_')) {
        await handleInviteClaim(env, chatId, telegramId, payload.slice('hr_'.length));
        return;
      }

      const session = await getSession(env, telegramId);
      if (session.employee) {
        // дописываем username тем, кто регистрировался до появления этой колонки,
        // и подхватываем смену username в Telegram — в фоне, чтобы не тормозить ответ
        if (username && session.employee.username !== username) {
          session.employee.username = username;
          runInBackground(updateUsername(env, telegramId, username));
        }
        // у старых записей нет departmentId — восстанавливаем по названию отдела
        if (!session.employee.departmentId) {
          const dept = findDepartmentByLabel(session.employee.department);
          if (dept) session.employee.departmentId = dept.id;
        }
        await saveSession(env, telegramId, { ...session, state: { step: 'idle' } });
        await showHomeMenu(env, chatId, telegramId);
        return;
      }

      // HR, Super Admin и менеджеры не проходят регистрацию сотрудника — у них своя панель
      const [hrProfile, superAdmins, mgrDept] = await Promise.all([
        getHrProfile(env),
        getSuperAdmins(env),
        findManagerDepartment(env, telegramId),
      ]);
      const superAdminProfile = superAdmins.find((p) => p.telegramId === telegramId);
      const roleProfile =
        hrProfile && hrProfile.telegramId === telegramId
          ? hrProfile
          : superAdminProfile
            ? superAdminProfile
            : mgrDept
              ? await getManagerProfile(env, mgrDept.id)
              : null;

      if (roleProfile) {
        const deptLabel = mgrDept?.label ?? roleProfile.department;
        const dept = findDepartmentByLabel(deptLabel);
        const restored: Session = {
          employee: {
            telegramId,
            name: roleProfile.name,
            department: deptLabel,
            departmentId: dept?.id ?? '',
            manager: mgrDept ? roleProfile.name : dept?.manager ?? '',
            username: roleProfile.username ?? username,
          },
          state: { step: 'idle' },
        };
        await saveSession(env, telegramId, restored);
        await showHomeMenu(env, chatId, telegramId);
        return;
      }

      // регистрация только по приглашению от Admin или HR
      if (!(await hasEmployeeAccess(env, telegramId))) {
        await sendMessage(env, chatId, INVITE_ONLY_MESSAGE);
        return;
      }

      await startRegistration(env, chatId, telegramId);
      return;
    }

    const session = await getSession(env, telegramId);

    if (session.state.step === 'awaiting_name') {
      await handleNameInput(env, chatId, telegramId, text, username);
      return;
    }

    if (session.state.step === 'awaiting_role_name') {
      const st = session.state;
      await handleRoleNameInput(env, chatId, telegramId, text, st.role, st.departmentId, username);
      return;
    }

    if (session.state.step === 'awaiting_shift_time') {
      const st = session.state;
      await handleShiftTimeInput(env, chatId, telegramId, text, st.name, st.departmentId, st.username);
      return;
    }

    if (session.state.step === 'editing_shift_time') {
      await handleShiftTimeEdit(env, chatId, telegramId, session, text);
      return;
    }

    if (session.state.step === 'editing_profile_name') {
      await handleNameEditInput(env, chatId, telegramId, session, text);
      return;
    }

    if (session.state.step === 'editing_profile_department') {
      await sendMessage(env, chatId, 'Please pick the department with the buttons above 👆');
      return;
    }

    if (session.state.step === 'composing_message') {
      await handleComposeText(env, chatId, telegramId, session, text);
      return;
    }

    // форма репорта важнее переписки: её текст не пересылаем
    if (session.state.step === 'report_flow') {
      await handleReportText(env, chatId, telegramId, session, text);
      return;
    }

    // идёт переписка через бота — обычный текст уходит собеседнику
    if (session.state.step === 'idle' && (await relayToActivePeer(env, chatId, telegramId, text))) {
      return;
    }

    if (session.employee) {
      await showHomeMenu(env, chatId, telegramId);
    } else {
      await sendMessage(env, chatId, 'Type /start to begin.');
    }
    return;
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;
    const telegramId = cq.from.id;
    const data = cq.data;

    const session = await getSession(env, telegramId);

    if (data.startsWith('dept:')) {
      if (session.state.step !== 'awaiting_department') {
        await answerCallbackQuery(env, cq.id);
        return;
      }
      const departmentId = data.slice('dept:'.length);
      await handleDepartmentChoice(
        env,
        chatId,
        telegramId,
        cq.id,
        session.state.name,
        departmentId,
        session.state.username
      );
      return;
    }

    if (data.startsWith('roledept:')) {
      if (session.state.step !== 'awaiting_role_department') {
        await answerCallbackQuery(env, cq.id);
        return;
      }
      const st = session.state;
      await handleRoleDepartmentChoice(
        env,
        chatId,
        telegramId,
        cq.id,
        st.role,
        st.name,
        data.slice('roledept:'.length),
        st.username
      );
      return;
    }

    if (data.startsWith('manage:')) {
      await handleManageCallback(env, chatId, telegramId, cq.id, data);
      return;
    }

    if (data.startsWith('admin:')) {
      await handleAdminCallback(env, chatId, telegramId, cq.id, data);
      return;
    }

    if (data.startsWith('msg:')) {
      await handleMessageCallback(env, chatId, telegramId, session, cq.id, data);
      return;
    }

    // profile:<action>[:<telegramId владельца>] — без id свой профиль, с id — чужой (Admin/Super Admin)
    if (data.startsWith('profile:')) {
      const [, action, arg] = data.split(':');
      const target = arg ? Number(arg) : undefined;
      await answerCallbackQuery(env, cq.id);
      if (action === 'show') {
        await showProfile(env, chatId, telegramId, session, target);
      } else if (action === 'edit_name') {
        await startNameEdit(env, chatId, telegramId, session, target);
      } else if (action === 'edit_department') {
        await startDepartmentEdit(env, chatId, telegramId, session, target);
      } else if (action === 'edit_shift') {
        await startShiftTimeEdit(env, chatId, telegramId, session, target);
      } else if (action === 'dept') {
        await handleDepartmentEditChoice(env, chatId, telegramId, session, arg ?? '');
      } else if (action === 'cancel') {
        await cancelProfileEdit(env, chatId, telegramId, session);
      }
      return;
    }

    if (data === 'home:report') {
      if (!session.employee) {
        await answerCallbackQuery(env, cq.id, 'Please register first: /start');
        return;
      }
      await answerCallbackQuery(env, cq.id);
      await showReportMenu(env, chatId);
      return;
    }

    if (data === 'home:back') {
      await answerCallbackQuery(env, cq.id);
      await showHomeMenu(env, chatId, telegramId);
      return;
    }

    if (data === 'home:admin') {
      await answerCallbackQuery(env, cq.id);
      await handleAdminCommand(env, chatId, telegramId);
      return;
    }

    if (data === 'home:manage') {
      await answerCallbackQuery(env, cq.id);
      await handleManageCommand(env, chatId, telegramId);
      return;
    }

    if (data === 'home:shift' || data === 'menu:edit_shift') {
      if (!session.employee) {
        await answerCallbackQuery(env, cq.id, 'Please register first: /start');
        return;
      }
      await answerCallbackQuery(env, cq.id);
      await startShiftTimeEdit(env, chatId, telegramId, session);
      return;
    }

    if (data.startsWith('menu:')) {
      if (!session.employee) {
        await answerCallbackQuery(env, cq.id, 'Please register first: /start');
        return;
      }
      const reportType = data.slice('menu:'.length);
      if (!findReportType(reportType)) {
        await answerCallbackQuery(env, cq.id);
        return;
      }
      await answerCallbackQuery(env, cq.id);
      await startReportFlow(env, chatId, telegramId, session, reportType);
      return;
    }

    // всё остальное — внутри активного репорт-флоу
    await handleReportCallback(env, chatId, telegramId, session, cq.id, messageId, data);
  }
}

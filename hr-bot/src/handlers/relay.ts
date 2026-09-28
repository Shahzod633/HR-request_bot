import type { Env, Session } from '../types';
import { sendMessage, answerCallbackQuery, type InlineKeyboard } from '../telegram';
import { getSession, saveSession, ensureSession } from '../session';
import { getRoleInfo, isStaff, type RoleInfo } from '../roles';
import { showHomeMenu } from './menu';

/**
 * Переписка через самого бота вместо ссылок t.me/username — username есть не у всех,
 * а telegramId есть всегда.
 *
 * Связка "кто кому сейчас пишет" — пара ключей relay:<id>, по одному на каждую
 * сторону, каждый указывает на собеседника. Пока связка жива, обычный текст
 * (в состоянии idle) уходит собеседнику. Живёт час с последнего сообщения,
 * дальше протухает сама.
 */
const RELAY_TTL_SECONDS = 60 * 60;
const relayKey = (telegramId: number) => `relay:${telegramId}`;

interface RelayLink {
  /** кому уходят мои сообщения */
  peerId: number;
  /** как собеседник называется в подтверждениях: "HR (Aziza)", "Bob" */
  peerLabel: string;
  /** шапка, с которой мои сообщения приходят собеседнику */
  prefix: string;
}

const CANCEL_KEYBOARD: InlineKeyboard = {
  inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'msg:cancel' }]],
};

const END_CHAT_KEYBOARD: InlineKeyboard = {
  inline_keyboard: [[{ text: '🔚 End chat', callback_data: 'msg:end' }]],
};

async function readLink(env: Env, telegramId: number): Promise<RelayLink | null> {
  const raw = await env.SESSIONS.get(relayKey(telegramId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RelayLink;
  } catch {
    return null;
  }
}

async function writeLink(env: Env, telegramId: number, link: RelayLink): Promise<void> {
  await env.SESSIONS.put(relayKey(telegramId), JSON.stringify(link), {
    expirationTtl: RELAY_TTL_SECONDS,
  });
}

/** "HR (Aziza)", "Admin (Farrukh)", "Manager (Hurmatullo)" — у обычного сотрудника просто имя. */
function personLabel(telegramId: number, session: Session, roles: RoleInfo): string {
  const name = session.employee?.name ?? '';
  const role = roles.admin
    ? 'Admin'
    : roles.superAdmin
      ? 'Super Admin'
      : roles.hr
        ? 'HR'
        : roles.managerOf
          ? 'Manager'
          : '';
  if (role) return name ? `${role} (${name})` : role;
  return name || `id ${telegramId}`;
}

/** Длинный текст с шапкой может не влезть в 4096 символов — его обрежет sendMessage. */
function composeText(prefix: string, body: string, footer = ''): string {
  return `${prefix}\n\n${body}${footer}`;
}

/** Кнопки msg:<id>, msg:cancel, msg:end. */
export async function handleMessageCallback(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  callbackQueryId: string,
  data: string
) {
  const arg = data.slice('msg:'.length);

  if (arg === 'cancel') {
    await answerCallbackQuery(env, callbackQueryId);
    if (session.state.step === 'composing_message') {
      await saveSession(env, telegramId, { ...session, state: { step: 'idle' } });
    }
    await sendMessage(env, chatId, 'Cancelled, nothing was sent.');
    await showHomeMenu(env, chatId, telegramId);
    return;
  }

  if (arg === 'end') {
    await answerCallbackQuery(env, callbackQueryId);
    await endChat(env, chatId, telegramId);
    return;
  }

  await startCompose(env, chatId, telegramId, session, callbackQueryId, Number(arg));
}

/** "✍️ Message" → просим текст для конкретного человека. */
async function startCompose(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  callbackQueryId: string,
  targetTelegramId: number
) {
  if (!targetTelegramId) {
    await answerCallbackQuery(env, callbackQueryId);
    return;
  }
  if (targetTelegramId === telegramId) {
    await answerCallbackQuery(env, callbackQueryId, 'This is you');
    return;
  }

  const [myRoles, targetRoles, targetSession] = await Promise.all([
    getRoleInfo(env, telegramId),
    getRoleInfo(env, targetTelegramId),
    getSession(env, targetTelegramId),
  ]);
  // Admin/Super Admin/HR/менеджер пишут кому угодно, сотрудник — только им
  // (кнопки связи после исчерпанного лимита Day Off)
  if (!isStaff(myRoles) && !isStaff(targetRoles)) {
    await answerCallbackQuery(env, callbackQueryId, 'Not available');
    return;
  }

  const targetName = personLabel(targetTelegramId, targetSession, targetRoles);
  await answerCallbackQuery(env, callbackQueryId);
  await saveSession(env, telegramId, {
    ...session,
    state: { step: 'composing_message', targetTelegramId, targetName },
  });
  await sendMessage(
    env,
    chatId,
    `✍️ Message for ${targetName}.\n\nType your text — the bot will deliver it, and the reply will come to this chat.`,
    CANCEL_KEYBOARD
  );
}

/** Текст в состоянии composing_message — доставляем адресату и открываем связку. */
export async function handleComposeText(
  env: Env,
  chatId: number,
  telegramId: number,
  session: Session,
  text: string
) {
  if (session.state.step !== 'composing_message') return;
  const { targetTelegramId, targetName } = session.state;

  const body = text.trim();
  if (!body) {
    await sendMessage(env, chatId, 'The message is empty. Type your text or press Cancel.', CANCEL_KEYBOARD);
    return;
  }

  const senderLabel = personLabel(telegramId, session, await getRoleInfo(env, telegramId));
  const prefix = `📩 Message from ${senderLabel}:`;
  const delivered = await sendMessage(
    env,
    targetTelegramId,
    composeText(prefix, body, '\n\n↩️ To reply, just send a message in this chat.')
  );

  await saveSession(env, telegramId, { ...session, state: { step: 'idle' } });

  if (!delivered) {
    await sendMessage(
      env,
      chatId,
      `⚠️ Couldn't deliver the message to ${targetName} — they may have blocked the bot or never opened it.`
    );
    await showHomeMenu(env, chatId, telegramId);
    return;
  }

  await Promise.all([
    writeLink(env, telegramId, { peerId: targetTelegramId, peerLabel: targetName, prefix }),
    writeLink(env, targetTelegramId, {
      peerId: telegramId,
      peerLabel: senderLabel,
      prefix: `↩️ Reply from ${targetName}:`,
    }),
    ensureSession(env, targetTelegramId),
  ]);

  await sendMessage(
    env,
    chatId,
    `✅ Sent to ${targetName}.\n\nThe reply will come here. For the next hour your messages in this chat also go to ${targetName}.`,
    END_CHAT_KEYBOARD
  );
}

/**
 * Обычный текст в состоянии idle: если есть живая связка — пересылаем собеседнику.
 * false — связки нет, текст обрабатывается как раньше.
 */
export async function relayToActivePeer(
  env: Env,
  chatId: number,
  telegramId: number,
  text: string
): Promise<boolean> {
  const body = text.trim();
  if (!body) return false;

  const link = await readLink(env, telegramId);
  if (!link) return false;

  const delivered = await sendMessage(env, link.peerId, composeText(link.prefix, body));
  if (!delivered) {
    await sendMessage(env, chatId, `⚠️ Couldn't deliver the message to ${link.peerLabel}.`, END_CHAT_KEYBOARD);
    return true;
  }

  // разговор идёт — продлеваем связку с обеих сторон (если собеседник ещё не переключился на другого)
  const peerLink = await readLink(env, link.peerId);
  await Promise.all([
    writeLink(env, telegramId, link),
    peerLink && peerLink.peerId === telegramId ? writeLink(env, link.peerId, peerLink) : null,
  ]);

  await sendMessage(env, chatId, `✅ Sent to ${link.peerLabel}.`, END_CHAT_KEYBOARD);
  return true;
}

async function endChat(env: Env, chatId: number, telegramId: number) {
  const link = await readLink(env, telegramId);
  if (!link) {
    await sendMessage(env, chatId, 'This chat has already ended.');
    await showHomeMenu(env, chatId, telegramId);
    return;
  }

  await env.SESSIONS.delete(relayKey(telegramId));
  const peerLink = await readLink(env, link.peerId);
  if (peerLink && peerLink.peerId === telegramId) {
    await env.SESSIONS.delete(relayKey(link.peerId));
    await sendMessage(env, link.peerId, `🔚 ${peerLink.peerLabel} ended the chat.`);
  }

  await sendMessage(env, chatId, `🔚 Chat with ${link.peerLabel} ended.`);
  await showHomeMenu(env, chatId, telegramId);
}

import type { Env } from './types';

const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

/** Кнопка либо шлёт callback внутрь бота, либо открывает внешнюю ссылку (url). */
export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

const TEXT_LIMIT = 4096;

/**
 * Длиннее 4096 символов Telegram сообщение не примет вовсе — вместе с кнопками.
 * Лучше доставить обрезанным, чем потерять (экран подтверждения, уведомление).
 */
function fitTextLimit(text: string): string {
  if (text.length <= TEXT_LIMIT) return text;
  let cut = TEXT_LIMIT - 1;
  // не разрываем эмодзи (суррогатную пару) пополам
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/** Возвращает false, если Telegram не доставил сообщение (например, человек заблокировал бота). */
export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  keyboard?: InlineKeyboard
): Promise<boolean> {
  const res = await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: fitTextLimit(text),
      reply_markup: keyboard,
    }),
  });
  if (!res.ok) {
    console.error('sendMessage failed', await res.text());
    return false;
  }
  return true;
}

export async function answerCallbackQuery(env: Env, callbackQueryId: string, text?: string) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'answerCallbackQuery'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

/** Заменяет клавиатуру у уже отправленного сообщения — используется для навигации по календарю. */
export async function editMessageReplyMarkup(
  env: Env,
  chatId: number,
  messageId: number,
  keyboard: InlineKeyboard
) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'editMessageReplyMarkup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: keyboard,
    }),
  });
}

/** Меняет и текст, и клавиатуру — при листании календаря подпись месяца тоже должна смениться. */
export async function editMessageText(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  keyboard: InlineKeyboard
) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'editMessageText'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: fitTextLimit(text),
      reply_markup: keyboard,
    }),
  });
}

export async function setWebhook(env: Env, url: string) {
  const res = await fetch(api(env.TELEGRAM_BOT_TOKEN, 'setWebhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return res.json();
}

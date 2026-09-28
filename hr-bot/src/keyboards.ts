import type { InlineButton, InlineKeyboard } from './telegram';
import { DEPARTMENTS } from './config';

/** Публичный username Telegram: латиница, цифры и "_", 4–32 символа. */
const USERNAME_RE = /^[A-Za-z0-9_]{4,32}$/;

/**
 * Кнопки связи с человеком: "✍️ ..." — переписка через бота (работает всегда),
 * и, если у него есть публичный username, "📇 Direct message" — личный чат напрямую.
 * Кривой username (например, поправленный руками в таблице) ссылку не даёт:
 * с неверным адресом Telegram отклонил бы всё сообщение вместе с кнопками.
 */
export function buildMessageButtons(
  telegramId: number,
  username: string | undefined,
  label: string
): InlineButton[] {
  const buttons: InlineButton[] = [{ text: label, callback_data: `msg:${telegramId}` }];
  const handle = (username ?? '').trim().replace(/^@/, '');
  if (USERNAME_RE.test(handle)) {
    buttons.push({ text: '📇 Direct message', url: `https://t.me/${handle}` });
  }
  return buttons;
}

/** 5 отделов кнопками. prefix разводит флоу: регистрация, роль, правка профиля. */
export function buildDepartmentKeyboard(prefix: string): InlineKeyboard {
  return {
    inline_keyboard: DEPARTMENTS.map((d) => [{ text: d.label, callback_data: `${prefix}:${d.id}` }]),
  };
}

export function buildChoiceKeyboard(options: readonly string[], prefix: string): InlineKeyboard {
  const rows = options.map((opt) => [{ text: opt, callback_data: `${prefix}:${opt}` }]);
  return { inline_keyboard: rows };
}

export function buildNoticeKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '2 weeks', callback_data: 'notice:2 weeks' },
        { text: '2 months', callback_data: 'notice:2 months' },
      ],
    ],
  };
}

export function buildConfirmKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: '✅ Submit Request', callback_data: 'confirm:submit' }],
      [{ text: '❌ Cancel', callback_data: 'confirm:cancel' }],
    ],
  };
}

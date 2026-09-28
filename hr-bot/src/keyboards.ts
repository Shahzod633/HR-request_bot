import type { InlineKeyboard } from './telegram';
import { DEPARTMENTS } from './config';

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

export interface Env {
  SESSIONS: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  APPS_SCRIPT_URL: string;
  APPS_SCRIPT_SECRET: string;
  ADMIN_TELEGRAM_ID: string;
  TELEGRAM_BOT_USERNAME: string;
}

export interface Employee {
  telegramId: number;
  name: string;
  department: string; // человекочитаемое название отдела
  departmentId: string; // id отдела — по нему находим менеджера
  manager: string;
  /** публичный @username, если он у человека есть — справочно, для колонки в таблице */
  username?: string;
  /** время начала смены в формате HH:MM (таджикское время) */
  scheduledStart?: string;
}

export interface ReportFlowState {
  step: 'report_flow';
  reportType: string;
  flowStep: string;
  answers: Record<string, string>;
  // календарь помнит на каком месяце сейчас находится пользователь при навигации
  calendarYear?: number;
  calendarMonth?: number;
}

/** Кто занимает роль HR, Super Admin или менеджера — чтобы в панели было видно имя, а не голый id. */
export interface RoleProfile {
  telegramId: number;
  name: string;
  department: string;
  username?: string;
}

/** Роли, которые выдаются по ссылке-приглашению. */
export type RoleKind = 'hr' | 'manager' | 'super_admin';

/**
 * targetTelegramId в editing_* — Admin/Super Admin правит чужой профиль.
 * Нет поля (или совпадает со своим id) — человек правит свой.
 */
export type SessionState =
  | { step: 'awaiting_name' }
  | { step: 'awaiting_role_name'; role: RoleKind; departmentId?: string }
  | { step: 'awaiting_role_department'; role: RoleKind; name: string; username?: string }
  | { step: 'awaiting_department'; name: string; username?: string }
  | { step: 'awaiting_shift_time'; name: string; departmentId: string; username?: string }
  | { step: 'editing_shift_time'; targetTelegramId?: number }
  | { step: 'editing_profile_name'; targetTelegramId?: number }
  | { step: 'editing_profile_department'; targetTelegramId?: number }
  | { step: 'composing_message'; targetTelegramId: number; targetName: string }
  | { step: 'idle' }
  | ReportFlowState;

export interface Session {
  employee?: Employee;
  state: SessionState;
}

export interface TgUpdate {
  message?: {
    chat: { id: number };
    from: { id: number; first_name?: string; username?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message: { chat: { id: number }; message_id: number };
    data: string;
  };
}

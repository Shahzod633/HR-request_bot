export const DEPARTMENTS = [
  { id: 'update_dispatch', label: 'Update & Dispatch', manager: 'Shohrukh' },
  { id: 'fleet', label: 'Fleet', manager: 'Hurmatullo' },
  { id: 'safety', label: 'Safety', manager: 'David' },
  { id: 'accounting', label: 'Accounting', manager: 'Zafar' },
  { id: 'it', label: 'IT', manager: 'Fayzullokhon' },
] as const;

export function findDepartment(id: string) {
  return DEPARTMENTS.find((d) => d.id === id);
}

export function findDepartmentByLabel(label: string) {
  return DEPARTMENTS.find((d) => d.label === label);
}

export const REPORT_TYPES = [
  { id: 'late_checkin', label: '🕒 Late Check-in' },
  { id: 'early_leave', label: '🚪 Early Leave' },
  { id: 'day_off', label: '📅 Day Off' },
  { id: 'emergency_leave', label: '🚨 Emergency Leave' },
  { id: 'vacation', label: '🏖 Vacation' },
  { id: 'long_term_leave', label: '📋 Long-Term Leave' },
  { id: 'resignation', label: '✍️ Resignation' },
] as const;

export type ReportTypeId = (typeof REPORT_TYPES)[number]['id'];

export function findReportType(id: string) {
  return REPORT_TYPES.find((r) => r.id === id);
}

export const LATE_REASONS = [
  'Traffic / Transportation',
  'Personal Issue',
  'Emergency',
  'Health Issue',
  'Family Matter',
  'Other',
];

export const ETA_OPTIONS = ['10', '20', '30', 'Other'];
/** Реальный лимит: столько дней бот пропустит за месяц. */
export const DAY_OFF_MONTHLY_LIMIT = 4;
/** Сколько дней видит сотрудник. Разница между лимитами — скрытый резерв. */
export const DAY_OFF_VISIBLE_LIMIT = 2;

/** Начиная с этого количества Late Check-in за месяц HR получает отдельный алерт. */
export const LATE_CHECKIN_ALERT_THRESHOLD = 4;

/**
 * Больше стольких дней одна заявка не покрывает. Без предела опечатка "3000"
 * вместо "3" создала бы тысячи ячеек и повесила Apps Script.
 */
export const MAX_LEAVE_DAYS: Record<string, number> = {
  day_off: 3,
  vacation: 30,
  long_term_leave: 30,
};

/**
 * Предел для текстовых ответов в форме (причина, комментарий, время ухода):
 * сводка и уведомление с ними должны влезать в 4096 символов Telegram.
 */
export const MAX_TEXT_ANSWER_LENGTH = 1000;

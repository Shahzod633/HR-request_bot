import type { Env } from './types';
import { isAdminLevel } from './roles';

/**
 * Доступ к боту только по приглашению: посторонний, набравший /start,
 * не должен иметь возможности записать себя в сотрудники.
 */
const accessKey = (telegramId: number) => `access:${telegramId}`;

export const INVITE_ONLY_MESSAGE =
  'This bot is available to company employees by invitation only.\n\nAsk HR or Admin to send you an invite link.';

export async function grantEmployeeAccess(env: Env, telegramId: number): Promise<void> {
  await env.SESSIONS.put(accessKey(telegramId), '1');
}

export async function hasEmployeeAccess(env: Env, telegramId: number): Promise<boolean> {
  if (await isAdminLevel(env, telegramId)) return true;
  const raw = await env.SESSIONS.get(accessKey(telegramId));
  return raw !== null;
}

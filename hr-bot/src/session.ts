import type { Env, Session } from './types';

const key = (telegramId: number) => `session:${telegramId}`;

export async function getSession(env: Env, telegramId: number): Promise<Session> {
  const raw = await env.SESSIONS.get(key(telegramId));
  if (!raw) return { state: { step: 'awaiting_name' } };
  return JSON.parse(raw) as Session;
}

export async function saveSession(env: Env, telegramId: number, session: Session): Promise<void> {
  await env.SESSIONS.put(key(telegramId), JSON.stringify(session));
}

/**
 * Без сохранённой сессии любой текст считается вводом имени при регистрации.
 * Тому, кто получил сообщение через бота (например, Admin без профиля),
 * заводим пустую idle-сессию — тогда его ответ уйдёт собеседнику.
 */
export async function ensureSession(env: Env, telegramId: number): Promise<void> {
  const raw = await env.SESSIONS.get(key(telegramId));
  if (raw === null) {
    await saveSession(env, telegramId, { state: { step: 'idle' } });
  }
}

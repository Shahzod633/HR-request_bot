import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Фоновая работа Worker'а. Cloudflare убивает запрос, как только вернули ответ,
 * поэтому долгие задачи (запись в Google Sheets, рассылка уведомлений) надо
 * явно передать в ctx.waitUntil — тогда пользователь получает ответ сразу,
 * а работа спокойно доделывается после.
 *
 * ctx хранится в AsyncLocalStorage, а не в глобальной переменной: Worker может
 * обрабатывать несколько апдейтов одновременно, и глобальная переменная к моменту
 * вызова runInBackground (после очередного await) указывала бы уже на чужой запрос.
 */
const requestContext = new AsyncLocalStorage<ExecutionContext>();

/** Всё, что выполняется внутри fn (в том числе после await), видит именно этот ctx. */
export function withExecutionContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}

export function runInBackground(promise: Promise<unknown>): void {
  const guarded = promise.catch((err) => console.error('background task failed:', err));
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.waitUntil(guarded);
  }
}

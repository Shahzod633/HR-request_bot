// Минимальные типы для node:async_hooks. В Cloudflare модуль включается флагом
// nodejs_als в wrangler.toml, а @cloudflare/workers-types его не описывает.
// Если когда-нибудь поставите @types/node — этот файл нужно удалить.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}

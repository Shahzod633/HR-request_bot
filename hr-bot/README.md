# HR Request Center — деплой

## Что где
- `AppsScript_Code.gs` — код для Google Apps Script (вставляется прямо в таблицу через Extensions → Apps Script). Пишет в матрицу сотрудник×дата.
- `src/` — код Cloudflare Worker'а (мозг бота, диалог с сотрудником в Telegram).

## Порядок действий

### 1. Google Sheets + Apps Script
Если ещё не сделали — см. инструкцию, которую я присылал отдельно (создать таблицу → Extensions → Apps Script → вставить `AppsScript_Code.gs` → Script Properties → `SECRET_TOKEN` → Deploy as Web App → скопировать URL).

**Важно:** в самом Apps Script редакторе — File → Project Settings → Time zone — выставьте `(GMT+05:00) Dushanbe`, иначе даты в столбцах могут поехать на день.

### 2. Telegram Bot Token
Если ещё нет — напишите @BotFather в Telegram → `/newbot` → следуйте подсказкам → в конце он даст токен вида `123456:ABC-...`.

### 3. Установка зависимостей
```bash
npm install
```

### 4. KV Namespace
```bash
npx wrangler kv namespace create SESSIONS
```
Команда выведет `id = "..."` — вставьте его в `wrangler.toml` вместо `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### 5. Секреты
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put APPS_SCRIPT_URL
npx wrangler secret put APPS_SCRIPT_SECRET
npx wrangler secret put ADMIN_TELEGRAM_ID
npx wrangler secret put TELEGRAM_BOT_USERNAME
```
(`APPS_SCRIPT_URL` — это URL веб-приложения из шага 1, `APPS_SCRIPT_SECRET` — тот же `SECRET_TOKEN`, что вы задали в Script Properties. `ADMIN_TELEGRAM_ID` — Telegram ID единственного Admin. `TELEGRAM_BOT_USERNAME` — username бота без @, например `UgetHRBot`.)

### 6. Деплой
```bash
npx wrangler deploy
```
В выводе будет URL вида `https://hr-request-bot.<ваш-субдомен>.workers.dev`.

### 7. Подключить Telegram webhook
Откройте в браузере (замените домен на ваш):
```
https://hr-request-bot.<ваш-субдомен>.workers.dev/setup?url=https://hr-request-bot.<ваш-субдомен>.workers.dev/webhook
```
Должно вернуться `{"ok":true,...}`. Это разовая операция — Telegram запомнит webhook сам.

### 8. Проверка
Напишите вашему боту `/start` в Telegram — должна начаться регистрация.

## Ещё не решено (скажите — доделаю)
- Публичный бот или закрытый доступ (по инвайт-ссылке/группе)?
- Проверено пока не было ни разу вживую (нет сети в среде, где я пишу код) — почти наверняка какая-то мелочь потребует правки при первом реальном тесте через настоящий Telegram webhook, это нормально для первого прогона.

## Обновление уже работающего бота (Day Off лимит + Admin/HR роли)

Если у вас уже был задеплоен бот раньше и сейчас обновляете на эту версию:

1. **Обновить Apps Script.** Откройте вашу Google-таблицу → Extensions → Apps Script → выделите весь код (Ctrl+A) → вставьте новый `AppsScript_Code.gs` целиком → сохраните.
2. **Важно:** просто сохранить недостаточно — старый Web App URL продолжит отдавать старый код, пока не выпустите новую версию. Deploy → **Manage deployments** → нажмите значок карандаша (Edit) у существующего деплоя → в поле Version выберите **New version** → Deploy. URL останется тем же самым, `APPS_SCRIPT_URL` менять не нужно.
3. **Новые секреты Worker'а** — только два, остальные три уже есть:
   ```bash
   npx wrangler secret put ADMIN_TELEGRAM_ID
   npx wrangler secret put TELEGRAM_BOT_USERNAME
   ```
4. **Обновить код Worker'а** — замените папку `hr-bot` целиком на новую (или обновите изменённые файлы), затем:
   ```bash
   npm install
   npx wrangler deploy
   ```
   `wrangler.toml` и остальные секреты трогать не нужно — они сохраняются.
5. **Проверка:** напишите боту `/admin` — если вы Admin, должна появиться Admin panel с кнопкой "Назначить HR".

## Обновление: Super Admin, переписка через бота, My Profile

1. **Apps Script — обязательно выпустить New version** (как в шаге 2 выше). В этой версии: Shift Start пишется текстом (баг с «30.12.1899»), `list_employees` отдаёт `telegramId`, новые действия `update_name` и `update_department`. Без новой версии правки имени/отдела из профиля в таблицу не попадут.
2. **Worker** — `npx wrangler deploy`. Новых секретов нет. В `wrangler.toml` появился `compatibility_flags = ["nodejs_als"]` — не удаляйте: без него фоновые задачи (запись в таблицу, рассылка) не привязываются к своему запросу, а бот не запустится.
3. Что появилось:
   - `/admin` → «🛡 Assign Super Admin» (кнопку видит только Admin). Super Admin может всё, что Admin, кроме назначения Super Admin, и получает все репорты.
   - «✍️ Message» больше не ссылка на t.me/username: бот сам пересылает сообщение, человек отвечает обычным текстом. Переписка живёт час с последнего сообщения, «🔚 End chat» закрывает её сразу.
   - «👤 My Profile» в главном меню: имя меняют все, отдел и время смены — все, кроме HR, менеджеров и Super Admin. Admin и Super Admin правят чужие профили кнопкой «✏️ Edit» в списке сотрудников.

## Git и секреты

Секретов в репозитории нет и быть не должно: токен бота, URL и секрет Apps Script, `ADMIN_TELEGRAM_ID` задаются только через `npx wrangler secret put` и хранятся в Cloudflare, `SECRET_TOKEN` — в Script Properties таблицы.

- `.gitignore` не пускает в Git `.dev.vars` / `.env` (секреты для локального `wrangler dev`, образец без значений — `.dev.vars.example`), `.wrangler/` (локальная копия KV: сессии с Telegram ID и именами сотрудников) и `node_modules/`.
- Хук `.githooks/pre-commit` останавливает коммит, если в нём токен бота, URL Apps Script, значение секрета, реальный Telegram ID или ключ KV вида `session:<id>`. **После каждого `git clone` включите его один раз:** `git config core.hooksPath .githooks`
- `id` KV-namespace в `wrangler.toml` — не секрет: без доступа к вашему аккаунту Cloudflare с ним ничего сделать нельзя.

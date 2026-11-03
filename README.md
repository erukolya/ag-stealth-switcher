# Antigravity Stealth Profile Switcher (for Sandbox / Portable Instance)

Локальный автономный стелс-комплекс переключения профилей для **второго (Portable / Sandbox) экземпляра Google Antigravity IDE (версии 2.0 – 2.6.0+, Hub 2.28.0+)**.

---

## 1. Архитектура и гарантии безопасности (Anti-Ban Stealth)

1. **Полная изоляция (Zero-Impact):**
   - Основная установка Antigravity (`%LOCALAPPDATA%\Programs\Antigravity`, системный `%USERPROFILE%\.gemini`) неприкосновенна.
   - Любые операции записи и остановки процессов вне директории `SandboxRoot` блокируются встроенным предохранителем `assertInsideSandbox()`.
   - Если расширение случайно активировано в основном клиенте, оно автоматически переходит в режим **Read-Only** и отключает все функции изменения баз данных.

2. **Отсутствие MITM-прокси ($100\%$ оригинальный Go TLS-отпечаток):**
   - Расширение **не использует** локальный прокси-сервер (порт 8045 отсутствует).
   - Все сетевые запросы к `cloudcode-pa.googleapis.com` и другим сервисам Google отправляются напрямую оригинальным подписанным Go-бинарником `language_server` внутри песочницы.
   - Не происходит рассинхронизации сессионных подписей `thought_signature`.

3. **Пассивный мониторинг квот (Zero-Background-Traffic):**
   - Полностью вырезаны фоновые интервальные таймеры опроса квот (0 фоновых запросов в сеть).
   - Применяется математический расчёт восстановления: по прошествии 5 часов лимит локально рассчитывается как 100% без сетевых запросов.
   - Опрос локального `language_server` strictly на `127.0.0.1` происходит **только** по кнопке `↻ Refresh Quota Now` или при открытии меню пользователем.

4. **Интерактивная статистика токенов (в стиле Antigravity Manager):**
   - Встроенная Webview-панель (`📊 Open Token Statistics`):
     - **5 KPI Карточек:** Total Tokens, Input Tokens (с % cached rate), Output Tokens, Cached Tokens, Total Requests, Active Accounts.
     - **Периоды:** Hourly (24h), Daily (7d), Weekly (30d).
     - **Срезы:** By Model, By Account.
     - **Трендовые графики:** чистый HTML5 Canvas без загрузки внешних скриптов/CDN из сети.
     - **Таблицы расхода:** детальный разбор по каждой модели и каждому профилю.
     - **Защита от дублей:** транзакционный курсор дедупликации `token_sync_cursor`.
   - Совместимость со старой схемой Manager: таблицы `token_usage` (с полями `requested_model` и `ttft_ms`), `token_stats_hourly`.

5. **Поддержка исходящего прокси с защитой loopback (`NO_PROXY`):**
   - Поддержка параметров `-ProxyUrl` (HTTP / HTTPS / SOCKS5) в лаунчерах и в `StoredProfile`.
   - Аппаратная защита loopback: принудительное выставление `$env:NO_PROXY = "localhost,127.0.0.1,::1"` и `"http.noProxy": ["localhost", "127.0.0.1", "::1"]` в `settings.json`, исключающая зависание IDE и локального language_server.

6. **Анти-трекинг и синхронизация цифрового отпечатка:**
   - Полная зачистка телеметрии в `settings.json`: `"telemetry.telemetryLevel": "off"`, `"workbench.enableExperiments": false`, `"update.mode": "none"`.
   - У каждого профиля собственный набор: `machineId` (64 hex), `sqmId` (UUID v4 в `{...}`), `devDeviceId` (UUID v4).
   - Синхронизация `storage.serviceMachineId`: запись `devDeviceId` в `ItemTable` базы `state.vscdb` одной транзакцией, предотвращающая рассинхрон идентификаторов.

7. **Path-Scoping процессов:**
   - Поиск и завершение процессов (`Antigravity.exe`, `language_server_*`, `agy`) ведется **исключительно по полному пути исполняемого файла (`ExecutablePath`)** с префиксом `<SandboxRoot>/App`.
   - Глобальные команды по имени образа (типа `taskkill /IM`) категорически запрещены.

---

## 2. Структура проекта

```
ag-stealth-switcher/
├── package.json               # Манифест расширения, команды и зависимости (sql.js)
├── tsconfig.json              # Конфигурация TypeScript компилятора
├── scripts/
│   ├── copy-wasm.js           # Копирование sql-wasm.wasm в dist/
│   ├── init-sandbox.ps1       # Автоматическое развертывание песочницы (Windows)
│   ├── launch-sandbox.ps1     # Лаунчер песочницы с поддержкой -ProxyUrl (Windows)
│   ├── init-sandbox.sh        # Скрипт развертывания (macOS / Linux)
│   └── launch-sandbox.sh      # Лаунчер с поддержкой --proxy (macOS / Linux)
├── src/
│   ├── extension.ts           # Точка входа: Status Bar, QuickPick меню, пассивные квоты
│   ├── core/
│   │   ├── paths.ts           # Пути песочницы и валидация границ
│   │   ├── sandboxEnv.ts      # Предохранитель assertInsideSandbox и изолированный env
│   │   ├── processManager.ts  # WMI/CIM фильтрация процессов strictly по SandboxRoot/App
│   │   ├── lsRpcClient.ts     # Локальный RPC-клиент квоты и траекторий (127.0.0.1)
│   │   ├── sqliteInjector.ts  # WebAssembly sql.js, патч WAL-байтов, синхронизация serviceMachineId
│   │   ├── profileStore.ts    # Хранилище профилей, генерация machineId, схема 2.6.0, расчет квот
│   │   └── tokenStatsStore.ts # База token_stats.db, дедупликация, агрегации статистики токенов
│   ├── ui/
│   │   └── statsPanel.ts      # Webview-панель статистики токенов (в стиле Antigravity Manager)
│   └── cli/
│       └── switchWorker.ts    # Автономный фоновый воркер ротации и перезапуска песочницы
└── README.md
```

---

## 3. Сборка расширения (.vsix)

```bash
# 1. Установка локальных зависимостей
npm install

# 2. Компиляция TypeScript и копирование WebAssembly WASM
npm run compile

# 3. Упаковка расширения в .vsix пакет
npm run package
```

После выполнения команды в корне появится файл `ag-stealth-switcher-1.0.0.vsix`.

---

## 4. Развертывание и первый запуск песочницы

### Шаг 1: Инициализация второго экземпляра

Запустите PowerShell:

```powershell
.\scripts\init-sandbox.ps1 -SandboxRoot "C:\Apps\Antigravity-Sandbox"
```

Скрипт:
- Создаст изолированную структуру папок (`SandboxHome`, `data/user-data`, `data/extensions`).
- Скопирует бинарники Antigravity IDE в `C:\Apps\Antigravity-Sandbox\App`.
- Скопирует только безопасные пользовательские настройки (`settings.json`, `keybindings.json`).
- Включит в `settings.json` полный запрет телеметрии и правило `"http.noProxy": ["localhost", "127.0.0.1", "::1"]`.
- Сгенерирует чистые уникальные идентификаторы устройства (`telemetry.machineId`, `telemetry.sqmId`, `telemetry.devDeviceId`).
- Создаст ярлык **Antigravity Sandbox** на Рабочем столе.

### Шаг 2: Установка расширения в песочницу

Установите собранный `.vsix` пакет в изолированную директорию песочницы:

```powershell
.\scripts\launch-sandbox.ps1 -SandboxRoot "C:\Apps\Antigravity-Sandbox" -InstallExtension ".\ag-stealth-switcher-1.0.0.vsix"
```

### Шаг 3: Запуск второго экземпляра

Запустите портативный экземпляр через ярлык на Рабочем столе или командой:

```powershell
# Обычный прямой запуск
.\scripts\launch-sandbox.ps1 -SandboxRoot "C:\Apps\Antigravity-Sandbox"

# Запуск через прокси (при необходимости Geo-Unblock)
.\scripts\launch-sandbox.ps1 -SandboxRoot "C:\Apps\Antigravity-Sandbox" -ProxyUrl "socks5://127.0.0.1:1080"
```

---

## 5. Использование свитчера в интерфейсе IDE

В левом нижнем углу Status Bar отображается индикатор:
`🛡️ [Sandbox] user@gmail.com | 5h: 100% (recovered) | Weekly: 92%`

При клике на индикатор открывается меню QuickPick:
- **Список профилей:** выбор сохраненного профиля для мгновенного переключения.
- **$(graph) 📊 Open Token Statistics:** открытие интерактивной Webview-панели статистики токенов и запросов в стиле Antigravity Manager.
- **$(cloud-download) 💾 Save Current Account to Pool:** сохранение текущего авторизованного профиля (с автоопределением email из `oauth_token.json` или локального RPC).
- **$(add) 🔄 Switch to Blank Profile (Login New Account):** зачистка сессии песочницы, генерация нового `machineId` и запуск чистого окна для входа в новый аккаунт через браузер.
- **$(sync) ↻ Refresh Quota Now:** опрос локального `language_server` (strictly 127.0.0.1) по запросу пользователя.
- **$(gear) ⚙️ Toggle Switch Mode:** переключение между режимами `in-place` и `isolated-dir`.
- **$(trash) 🗑️ Delete Saved Profile:** физическое удаление профиля с диска без оставления файлов-сирот.

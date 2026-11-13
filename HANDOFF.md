# Передача Ouroboros GNOME — 13 ноября 2026

Разработка остановлена по просьбе владельца из-за лимита квоты. Цель «поддержать весь функционал API Ouroboros» **на паузе, не завершена**. Автоматически продолжать разработку или объявлять полное покрытие нельзя.

## Текущее состояние

Клиент на TypeScript/GJS, GTK4/Libadwaita. Главное окно и управляющие формы нативные. HTML/JS компонентов навыков и карточек исполняется в изолированных WebKit-контекстах; корневой SPA не используется. Не считать это доказательством полностью нативного интерфейса произвольного навыка.

Контракт целевого Ouroboros: **7.10.0**, commit **15cacd32310868934da44d3c5c6b68ccb6cf458a** в https://github.com/razzant/ouroboros. Карта 187 HTTP method/route pairs, 264 схем и двух WS находится в [docs/API-COVERAGE.md](docs/API-COVERAGE.md). Эта карта показывает точки реализации, а не полную функциональную аттестацию; поздние разделы уточняют старые ограничения.

В рабочем дереве накоплена большая реализация после первоначального v0.6.0: native chat/projects/tasks/routing, вопросы и решения, настройки и провайдеры/MCP/аккаунты, навыки/каталог/публикация, файлы/загрузки/история, расписания, диагностика/обновления, звонки и media, визуальные компоненты и isolated modules. Для навигации использовать README, карту API и именованные `test:*` scripts.

Последние изменения:

- PocketSphinx 5.1.1 + английская модель и отдельный WebRTC VAD упакованы в Flatpak. Native dictation и используемый стандартным browser_speech SpeechRecognition работают через native consent/capture и настоящий локальный decoder. Continuous capture не перезапускается во время декодирования; очередь ограничена; вход MediaStreamTrack явно не поддерживается.
- AccountLogin сохраняет известный job ID до проверки полной create receipt; malformed receipt не забывает принятое задание и не разрешает слепой повтор. GET/DELETE, close/reopen и отдельное происхождение readback проверены.
- ServerSettings сохраняет обычный draft при unknown write outcome, блокирует Save до отдельного GET, очищает submitted secrets/MCP/provider bundles. Совпадение состояния не выдаётся за original receipt. Typed saved=true остаётся отдельным post-commit случаем.

## Первая очередь следующему разработчику

1. **Разобрать плавающий routing-protocol failure.** В прерванном полном запуске `test:routing-protocol:gjs` отказал на `missing-dispatch`: после readback scheduled annotation оставался `attempt.request`. Изолированный повтор прошёл — это не исправление. Файлы: `src/gjs/routing.ts`, `tests/routing-protocol-gjs.js`, `tests/routing-picker-server.py`. Кандидат race, ещё НЕ доказанная причина: `observe()` игнорирует GET, если его readAt старше нового WS entry.at; очистка durable pending находится только в ветке принятого GET, а `frame()` её не выполняет. Нужно управляемое воспроизведение с порядком WS/GET, не ослабление assertion и не очистка журнала по недостоверному старому frame.
2. **Проверить инфраструктуру Xvfb.** `test:routing-journal:gjs` завершил prepare, но recover не открыл display, Xvfb уже отсутствовал. Ошибки приложения здесь не доказаны. Исходный отказ сохранён; retry этого конкретного нового запуска ещё не выполнялся.
3. Завершить общий прогон после устранения/классификации отказов. В полном наборе **207 команд**, последний запуск прерван владельцем; зелёного полного отчёта для текущего состояния нет.
4. **Generic conversation.mountRoom остаётся не реализован.** HostModule регистрирует conversation provider, но не вызывает mountRoom и не передаёт page/ws/composer/rememberEntry/claimEntry/onScreen. Native CallPanel поддерживает Call API, но не исполняет произвольный DOM-контракт модуля. Первичные файлы: `web/modules/conversation_controls.js`, `skills/live_conversation/ui/index.js`, `ui/call.js` в pinned reference. Не заменять эту задачу известным skill key или фиктивным успешным mount.
5. Остальные открытые области: полный семантический API/field audit; другие языки ASR; полный Web Speech API (interim/event constructors/options/track input/context на границах блоков); физические microphone/camera/display portal paths; оставшаяся локализация. Отсутствие имени поля в TS само по себе не означает неподдерживаемость — часть информации приходит через warnings/projections.

## Проверки и доказательства

Переносимые отчёты и выбранные логи: [docs/verification/2026-11-13-handoff](docs/verification/2026-11-13-handoff/README.md).

- Последние выбранные проверки settings recovery: build + 8 команд — pass, inputs unchanged.
- Login receipt: build + 4 команды — pass, inputs unchanged.
- Speech/continuous: build + 9 команд — pass, inputs unchanged.
- Соответствующие Flatpak сборки и runtime проверки прошли; подробности и хеши JS в карте API.
- Полный запуск `b_p544w_`: **67 test commands прошли** (отдельно прошла build), routing-protocol и routing-journal отказали; subagent-availability прерван SIGINT при остановке. Остальные команды не выполнены. После подтверждения остановки статус отчёта аннотирован `interrupted`, exit 130 помечен как interruption, а не product failure. Сохранены оба настоящих отказа. Не выдавать это за полный зелёный набор.

Фоновый runner и его дочерние test process groups остановлены. Исходный `/tmp` report также сохранён, но `/tmp` не является переносимым источником. Журналы содержат fixture data; настоящие provider login, модели Ouroboros и физические устройства этими тестами не запускались. PocketSphinx — реальный локальный ASR decoder на prerecorded/synthetic audio.

## Сборка и запуск на новой машине

Основной production build описан в `io.github.ouroboros.Client.json`: GNOME 51 SDK/Platform, Node 26 и TypeScript SDK extensions. Нужны Flatpak и flatpak-builder.

```sh
flatpak install --user flathub org.gnome.Sdk//51 org.gnome.Platform//51
flatpak install --user flathub org.freedesktop.Sdk.Extension.node26//26.08 org.freedesktop.Sdk.Extension.typescript//26.08
flatpak-builder --user --force-clean build-dir io.github.ouroboros.Client.json
flatpak-builder --run build-dir io.github.ouroboros.Client.json ouroboros-client
```

Host build: `npm run build` / `npm run typecheck`. Зависимости host: Node/tsc, Python, C compiler/pkg-config/GObject Introspection, GJS и GI библиотеки GTK4/Adw/Soup3/WebKit6/GStreamer/Poppler/GtkSource/Shumate и др. Список runtime dependencies и vendored licenses — в manifest/vendor. `scripts/build-native.py` строит реальный C/GIO stream: **не заменять GInputStream JS vfunc**, WebKit читает на worker threads.

Для интеграционных тестов нужен pinned reference и отдельный Python venv, не приватный установленный Ouroboros:

```sh
git clone https://github.com/razzant/ouroboros.git ../ouroboros-reference
git -C ../ouroboros-reference checkout 15cacd32310868934da44d3c5c6b68ccb6cf458a
python3 -m venv ../ouroboros-reference-venv
../ouroboros-reference-venv/bin/pip install -e ../ouroboros-reference
export OUROBOROS_REFERENCE="$(realpath ../ouroboros-reference)"
export OUROBOROS_TEST_PYTHON="$(realpath ../ouroboros-reference-venv/bin/python)"
export OUROBOROS_SPEECH_BUILD="$PWD/build-dir"
python3 scripts/test-native-suite.py --test test:settings-write-recovery:gjs
# Полный набор, длительный и последовательный:
python3 scripts/test-native-suite.py --keep-going
```

Для скриптов с runtime-веткой можно задать `OUROBOROS_FLATPAK_BUILD="$PWD/build-dir"`; не все host/direct GJS commands используют эту переменную. Полный harness требует host GUI/GI dependencies, Xvfb и dbus-run-session. Speech tests используют реальные бинарники/модели из build-dir (через OUROBOROS_SPEECH_BUILD); без переменной некоторые старые scripts ищут локальный `/tmp/...-current` указатель — на другой машине его нет.

Не перестраивать host dist, пока GJS tests ещё работают: модули загружаются лениво. Не пересобирать/удалять Flatpak build, пока speech tests используют его бинарники и модель. `test-native-suite.py` строит один раз, запускает выбранные команды последовательно и записывает SHA256 входов; после изменения кода старый report не доказывает новое состояние.

Локальные пути прежнего окружения (для диагностики, не для переносимости):

- workspace `/home/netsvetoch/projects/ouroboros-gnome`
- reference `/tmp/ouroboros-reference.WnZAMQ`
- Python `/tmp/ouroboros-upload-proof.GCOj55/venv/bin/python`
- Flatpak `/tmp/ouroboros-flatpak-proof.RY9xUD/build`

## Репозиторий и передача

Подготовлена ветка `codex/handoff-2026-11-13` с контрольным коммитом. Исходники, tests, scripts, vendor licenses/patches и документы входят в checkpoint; dist/build caches и Python bytecode исключены. Remote: `git@github.com:netsvetoch/ouroboros-gnome.git`. Push и release не выполнялись.

Рядом с checkout создаётся переносимый `ouroboros-gnome-handoff-2026-11-13.bundle`:

```sh
git clone --branch codex/handoff-2026-11-13 /path/to/ouroboros-gnome-handoff-2026-11-13.bundle ouroboros-gnome
git -C ouroboros-gnome switch codex/handoff-2026-11-13
```

Не запускать новые длительные проверки или разработку до возобновления владельцем; текущая остановка намеренная, не признак завершения цели.

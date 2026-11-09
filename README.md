# Ouroboros GNOME Client

GTK4 + Libadwaita клиент к [Ouroboros](https://github.com/netsvetoch/ouroboros-gnome) gateway — на TypeScript (Node 26 тулчейн, GJS рантайм для UI). Читаемый код без магии: `src/` — весь клиент.

## Установка (рекомендовано)

Релизные бандлы собираются автоматически на GitHub: пуш тега `v*` → workflow `flatpak` → `.flatpak` в Release. Скачай свежий `ouroboros-client-v*.flatpak` со страницы Releases и поставь:

```sh
flatpak install --user ./ouroboros-client-vX.Y.Z.flatpak
flatpak run io.github.ouroboros.Client
```

Рантаймы: `org.gnome.Platform//51`, `org.gnome.Sdk//51` (ставятся автоматически как зависимости).

## Сборка вручную

```sh
flatpak-builder --user --install --force-clean build-dir io.github.ouroboros.Client.json
flatpak run io.github.ouroboros.Client
```

(`--disable-rofiles-fuse` нужен только в контейнерах без /dev/fuse, на обычном хосте — без флага.)

## Настройка подключения

Шестерёнка в шапке → Настройки: Base URL инстанса, пароль (если задан `OUROBOROS_NETWORK_PASSWORD`), chat_id. Проверка — кнопка «Проверить подключение» (`/api/health`). Хранится в `~/.config/ouroboros-client/settings.ini`. Переменные окружения `OUROBOROS_URL`, `OUROBOROS_NETWORK_PASSWORD` — дефолты.

## Разработка

Исходники: `src/*.ts` (читай сверху вниз: `config.ts` → `types.ts` → `api.ts` → `ws.ts` → `cli.ts` → `main-gjs.ts`). Две компиляции: обычный `tsconfig.json` (NodeNext) и GJS `tsconfig.gjs.json` (`module: none`, без `export` — иначе GJS падает).

```sh
npm run build       # обе tsc
npm run typecheck   # проверка без эмита
node dist/cli.js check   # дым без GUI: health + state + история
```

## Релизы

Версия живёт в `package.json` + `CHANGELOG.md`. Релиз: обнови оба, коммит, тег `vX.Y.Z`, пуш тега — бандл соберётся сам (см. `.github/workflows/flatpak.yml`).

# Подписание и распространение

Подготовка от 10-10-2026. Репозиторий остаётся приватным; неподписанный candidate не является стабильным выпуском для Zen.

## Предлагаемый вариант

Стабильный add-on ID: `mendosave@mendozie`. Это идентификатор расширения, а не адрес электронной почты. Он одинаков для AMO и signed unlisted; после первого подписанного выпуска менять его нельзя без смены identity и потери обычного пути обновления. Текущая dev-сборка сохраняет `mendosave-dev@mendozie.local` до решения пользователя. Переход с dev ID требует новой установки; перенос временных OPFS inputs между этими identity не обещается.

| Канал | Польза | Обязанности |
|---|---|---|
| AMO listed | Страница магазина, установка и автоматические обновления через Firefox | Публичный listing, описание и материалы; проверка политик и review Mozilla |
| Signed unlisted | Подписанный XPI для ограниченного тестирования без публичного listing | Раздача файла; обновления вручную либо отдельный согласованный update manifest |

Пользователь выбрал 10-10-2026: сначала signed unlisted candidate и его установка в отдельный Zen-профиль, затем AMO для публичной версии. Это позволяет проверить реальную подпись до публичного listing. Самостоятельный update server сейчас не добавляется. Выбор порядка не является отправкой на подписание или разрешением менять приватность репозитория.

Mozilla требует подпись для release/beta Firefox при обоих каналах и может провести review даже после подписания. `web-ext` 10.7.0 поддерживает initial listed/unlisted submission. Формирование архивов и CI upload не отправляют расширение в Mozilla. Источники: [Signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/), [Self-distribution](https://extensionworkshop.com/documentation/publish/self-distribution/).

## Конкретная поставка

`npm run prepare:release` после проверок создаёт в `artifacts/mendosave-<version>/`:

- `mendosave-<version>-firefox-unsigned.xpi` - Firefox/Zen candidate без подписи;
- `mendosave-<version>-chromium-unsigned.zip` - распаковываемая developer-сборка Chromium;
- `mendosave-<version>-source.zip` - текущие исходники проекта без ignored files;
- `SHA256SUMS` и `release-manifest.json` - hashes архивов, состав каждого архива, revision и признак dirty.

Архивы имеют фиксированные timestamps, порядок и STORE compression. Каждый архив повторно читается с CRC и сравнением извлечённых bytes. Source ZIP проекта содержит исходники расширения, vendor binaries, licenses и provenance. Исходники сторонних библиотек и recipe поставщика доступны по закреплённым ссылкам из [DEPENDENCIES.md](DEPENDENCIES.md). [Требования source submission](https://extensionworkshop.com/documentation/publish/source-code-submission/) применяются к bundled/minified стороннему коду; для submission нужны понятные reviewer build instructions.

## После решения пользователя

1. Закрепить выбранные ID и канал, собрать и проверить финальный candidate.
2. При отдельном разрешении отправить XPI и соответствующий source на подписание из учётной записи владельца. Credentials остаются вне source и logs.
3. Проверить сохранённые ID, version, channel и результат review/signing через readback.
4. Проверить подпись и реальную установку подписанного XPI в отдельный Zen-профиль без изменения signature settings; выполнить конечные file checks.
5. После разрешения на публикацию подготовить release с подписанным XPI, Chromium ZIP, source, hashes и фактическими release notes. Смена приватности требует отдельного решения.

Наличие unsigned XPI, зелёный CI или успешный upload на AMO не заменяют подписанный файл и проверку его установки.

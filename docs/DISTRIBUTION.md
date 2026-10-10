# Подписание и распространение

Подготовка от 10-10-2026. Репозиторий остаётся приватным; неподписанный candidate не является стабильным выпуском для Zen.

## Выбранный вариант

Стабильный add-on ID: `mendosave@mendozie`. Это идентификатор расширения, а не адрес электронной почты. Он одинаков для AMO и signed unlisted; после первого подписанного выпуска менять его нельзя без смены identity и потери обычного пути обновления. Сборка закрепляет этот ID, а проверка отклоняет другие identity. Прежний candidate использовал `mendosave-dev@mendozie.local`; переход требует новой установки, перенос временных OPFS inputs между этими identity не обещается.

| Канал | Польза | Обязанности |
|---|---|---|
| AMO listed | Страница магазина, установка и автоматические обновления через Firefox | Публичный listing, описание и материалы; проверка политик и review Mozilla |
| Signed unlisted | Подписанный XPI для ограниченного тестирования без публичного listing | Раздача файла; обновления вручную либо отдельный согласованный update manifest |

10-10-2026 пользователь прямо разрешил отправку MendoSave на подписание через signed unlisted, без публикации в магазине. Это решение заменяет прежний план «сначала файл, затем AMO». Репозиторий остаётся приватным, публичный listing сейчас не планируется. Обновления устанавливаются вручную; самостоятельный update server не добавляется.

Mozilla требует подпись для release/beta Firefox при обоих каналах и может провести review даже после подписания. `web-ext` 10.7.0 поддерживает initial listed/unlisted submission. Формирование архивов и CI upload не отправляют расширение в Mozilla. Источники: [Signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/), [Self-distribution](https://extensionworkshop.com/documentation/publish/self-distribution/).

## Конкретная поставка

`npm run prepare:release` после проверок создаёт в `artifacts/mendosave-<version>/`:

- `mendosave-<version>-firefox-unsigned.xpi` - Firefox/Zen candidate без подписи;
- `mendosave-<version>-chromium-unsigned.zip` - распаковываемая developer-сборка Chromium;
- `mendosave-<version>-source.zip` - текущие исходники проекта без ignored files;
- `SHA256SUMS` и `release-manifest.json` - hashes архивов, состав каждого архива, revision и признак dirty.

Архивы имеют фиксированные timestamps, порядок и STORE compression. Каждый архив повторно читается с CRC и сравнением извлечённых bytes. Source ZIP проекта содержит исходники расширения, vendor binaries, licenses и provenance. Исходники сторонних библиотек и recipe поставщика доступны по закреплённым ссылкам из [DEPENDENCIES.md](DEPENDENCIES.md). [Требования source submission](https://extensionworkshop.com/documentation/publish/source-code-submission/) применяются к bundled/minified стороннему коду; для submission нужны понятные reviewer build instructions.

## Подписание

1. Собрать и проверить финальный candidate с закреплённым ID и каналом unlisted.
2. По разрешению от 10-10-2026 отправить XPI и соответствующий source на подписание из учётной записи владельца. [Инструкция для reviewer](MOZILLA_REVIEW.md) входит в source archive. Credentials остаются вне source и logs.
3. Проверить сохранённые ID, version, channel и результат review/signing через readback.
4. Проверить подпись и реальную установку подписанного XPI в отдельный Zen-профиль без изменения signature settings; выполнить конечные file checks.
5. После разрешения на публикацию подготовить release с подписанным XPI, Chromium ZIP, source, hashes и фактическими release notes. Смена приватности требует отдельного решения.

Наличие unsigned XPI, зелёный CI или успешный upload на AMO не заменяют подписанный файл и проверку его установки.

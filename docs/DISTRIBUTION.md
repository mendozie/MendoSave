# Подписание и распространение

Текущий выпуск - **[MendoSave 0.4.0](https://github.com/mendozie/MendoSave/releases/tag/v0.4.0)** от 15-10-2026: подписанный Mozilla unlisted XPI, Chromium ZIP, matching source, два manifests и SHA-256. Публикация выполнена в 23:28:37 MSK (20:28:37 UTC); Release сохранён как latest, без draft и prerelease. Шесть assets скачаны обратно и совпали по полным bytes/hashes; CRC трёх архивов прошли. Zen принял постоянное обновление с 0.3.3, сохранил ID/UUID и все пять настроек после полного перезапуска. [Проверки и hashes 0.4.0](RELEASE_VERIFICATION_040.md). Отчёт и изменения проходят через [PR #10](https://github.com/mendozie/MendoSave/pull/10); актуальный merge state доступен по ссылке. Репозиторий публичный, страницы в магазине нет.

Релизные tag/runtime/source закреплены за `456b157241167cd1aa36d576c8ef0ec1e2f2ed66`. Mozilla одобрила версию 0.4.0; подписанный XPI содержит 69 файлов приложения и пять файлов подписи. От unsigned payload отличается только форматирование JSON манифеста, остальные application bytes совпали. Source ZIP, скачанный из Mozilla, совпал с отправленным архивом по SHA-256 и прошёл CRC. Это не воспроизводимость подписи: CI воспроизводит неподписанные архивы. Новый полный media-проход не выполнялся; прежние ограничения сохранены в релизном отчёте.

Исторические проверки: [0.3.3](RELEASE_VERIFICATION_033.md), [0.3.1](SIGNING_VERIFICATION_031.md) и [0.3.0](SIGNING_VERIFICATION.md).

Историческое решение от 13-10-2026 выполнено для 0.3.3: исправления объединены в main через PR/review, Mozilla подписала итоговую 0.3.3, оба пакета опубликованы в GitHub Release. После проверки файлов, истории, GitHub-материалов и архивов репозиторий открыт. Описание, README и скриншоты обновлены; saved-state readback подтвердил внешние результаты. Промежуточная 0.3.2 не публикуется через GitHub Release. Это заменяет прежнее требование сохранять репозиторий приватным. Канал unlisted и ручные обновления сохраняются; публикация в магазинах не добавляется.

## Выбранный вариант

Стабильный add-on ID: `mendosave@mendozie`. Это идентификатор расширения, а не адрес электронной почты. Он одинаков для AMO и signed unlisted; после первого подписанного выпуска менять его нельзя без смены identity и потери обычного пути обновления. Сборка закрепляет этот ID, а проверка отклоняет другие identity. Прежний candidate использовал `mendosave-dev@mendozie.local`; переход требует новой установки, перенос временных OPFS inputs между этими identity не обещается.

| Канал | Польза | Обязанности |
|---|---|---|
| AMO listed | Страница магазина, установка и автоматические обновления через Firefox | Публичный listing, описание и материалы; проверка политик и review Mozilla |
| Signed unlisted | Подписанный XPI для ограниченного тестирования без публичного listing | Раздача файла; обновления вручную либо отдельный согласованный update manifest |

10-10-2026 пользователь прямо разрешил отправку MendoSave на подписание через signed unlisted, без публикации в магазине. Это решение заменило прежний план «сначала файл, затем AMO». На этом этапе репозиторий оставался приватным. Публичный listing не планируется; обновления устанавливаются вручную, самостоятельный update server не добавляется.

11-10-2026 пользователь подтвердил распространение готовых пакетов через GitHub Release для ручной установки в Chromium и Firefox-подобные браузеры. Выпуск 0.3.1 выполнялся в существующем приватном репозитории. Это заменило прежнее отсутствие разрешения на Release; публичная видимость согласована отдельно 13-10-2026. Для работы с Mozilla выбран только встроенный браузер Codex; рабочий Zen пользователя не используется.

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
2. По прямому разрешению на конкретный выпуск отправить XPI и соответствующий source на подписание из учётной записи владельца; для 0.4.0 такое поручение получено 15-10-2026. [Инструкция для reviewer](MOZILLA_REVIEW.md) входит в source archive. Credentials остаются вне source и logs.
3. Проверить сохранённые ID, version, channel и результат review/signing через readback.
4. Проверить подпись и реальную установку подписанного XPI в отдельный Zen-профиль без изменения signature settings; выполнить конечные file checks.
5. После разрешения на публикацию подготовить release с подписанным XPI, Chromium ZIP, source, hashes и фактическими release notes. Открытие репозитория разрешено текущим решением после отдельной проверки приватных данных.

Наличие unsigned XPI, зелёный CI или успешный upload на AMO не заменяют подписанный файл и проверку его установки.

Для 0.3.1 исходный candidate и source snapshot `1fce50347ca109cd60da7d2942353b86de90cabf` сохранены в `artifacts/mendosave-0.3.1-unlisted/`. Рядом находятся полученный от Mozilla `mendosave-0.3.1-firefox-signed.xpi`, отдельный `signing-manifest.json` и `SIGNED_SHA256SUMS`. Скачанный из Mozilla source совпал по SHA-256 с отправленным ZIP. Исходный `release-manifest.json` продолжает описывать неподписанные архивы; подписание не меняет его provenance. Повторная сборка создаёт новые unsigned artifacts и не воспроизводит подпись Mozilla. Release `v0.3.1` закреплён за этим runtime revision; последующие записи поставки в `main` не меняют отправленный source. Шесть Release assets проверены через saved API state по размерам и SHA-256. Смена видимости не выполнялась.

Историческая поставка 0.3.0 и её source revision `fa034ac7748bacd60f53800bbf31e233d4ab1139` сохранены в `artifacts/mendosave-0.3.0-unlisted/`.

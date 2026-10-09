# Аудит исходной базы MendoSave

Дата: 09-10-2026. Результат относится к закреплённому исходнику Nova Video Saver и подготовке MendoSave. Это структурный и статический аудит, а не подтверждение работы всех сайтов, завершённый Codex Security scan или приёмка Firefox-версии.

## Исходная база

- Репозиторий: [confeden/Nova-Video-Saver](https://github.com/confeden/Nova-Video-Saver).
- Default branch при проверке: `main`.
- Проверенный commit: [`6a2bc6dc1234a3c4b0037885b08cad486abe1bac`](https://github.com/confeden/Nova-Video-Saver/tree/6a2bc6dc1234a3c4b0037885b08cad486abe1bac).
- `manifest_version: 3`, версия расширения `1.9`; последний проверенный релиз - [v1.9](https://github.com/confeden/Nova-Video-Saver/releases/tag/v1.9), опубликованный 19-09-2026.
- [Исходный ZIP именно этого commit](https://codeload.github.com/confeden/Nova-Video-Saver/zip/6a2bc6dc1234a3c4b0037885b08cad486abe1bac). Не путать его с пользовательским release ZIP.
- SHA-256 загруженного исходного ZIP: `248a8f43190fe855da96944fe405104111babc4c9c2fa80f3bde7f41fc9d9312`.
- В исходнике 41 файл, 33 874 925 bytes; все их Git blob SHA-1 совпали с полной GitHub tree. Вне локального snapshot дополнительных исходных файлов не обнаружено.
- Сохранённый эталон: `.local/upstream/source/` относительно корня MendoSave; file hashes и происхождение - `.local/upstream/SOURCE.json`.

Все веб-ссылки на исходные файлы ниже закреплены на этом commit. Документация браузерных API отражает состояние источников при подготовке и должна перепроверяться перед внедрением зависимых решений.

## Устройство

Площадка предоставляет metadata и медиапоток. Content script добавляет меню и получает выбранный материал. Уже готовый файл передаётся downloads либо сохраняется через Blob на странице. Если требуется сборка дорожек или преобразование, данные поступают в обработчик расширения, использующий встроенные медиабиблиотеки. После обработки результат сохраняется локально.

Для YouTube применяются отдельные MAIN-world hook и ISOLATED-world UI. Hook наблюдает fetch/XHR, MediaSource/SourceBuffer и workers, получает metadata, прямые URLs и SABR-сегменты; при необходимости управляет плеером и использует capture fallback. UI обменивается с hook сообщениями страницы и обращается к extension APIs.

| Модуль | Строк JS | Роль |
|---|---:|---|
| `extension/background.js` | 607 | Chrome service worker: offscreen lifetime, downloads, журналы, reload state, обновления. |
| `extension/content_hook.js` | 8607 | Перехват и получение YouTube media/metadata, SABR, fallback capture, субтитры и качество плеера. |
| `extension/content_ui.js` | 2166 | Меню YouTube, bridge, одиночные jobs, playlist queue, progress, live UI. |
| `extension/offscreen.js` | 2432 | FFmpeg/WASM, Mediabunny, mux/transcode, OPFS, recovery и live jobs. |
| `extension/mux_worker.js` | 327 | Потоковая сборка дорожек через Mediabunny в отдельном worker. |
| `extension/settings.js` | 120 | Общие настройки качества YouTube/Twitch и storage access. |
| `extension/popup.js` | 198 | Версия, обновления, настройки, восстановление и экспорт диагностики. |
| `extension/rutube.js` | 484 | Rutube HLS и передача сегментов обработчику. |
| `extension/twitch_ui.js` | 885 | Twitch clips/VOD, запись эфира и quality settings. |
| `extension/vk.js` | 648 | Progressive MP4 и отдельное DASH-аудио VK. |
| `extension/coub.js` | 577 | Отдельные дорожки Coub, зацикливание и mux. |
| `extension/zvuk.js` | 517 | Metadata и аудиофайлы Звука, последовательное скачивание треков. |
| `extension/tiktok.js` | 691 | Варианты видео TikTok, отдельный звук и MP3. |
| `extension/musify.js` | 457 | Отключённый адаптер; отсутствует в manifest и исключён из release build. |

Всего 14 собственных JS-модулей и 18 716 строк. CSS, HTML, icons, manifest и build/CI scripts также присутствуют. Архитектура без framework/build dependency manifest; root `package.json` и автоматических тестов в tree нет. Большая часть сложности сосредоточена в YouTube hook и media processor; их полная перепись не требуется для старта переноса.

## Возможности, присутствующие в коде

| Площадка | Реализованные пути | Существенная граница |
|---|---|---|
| YouTube | Видео, оригинальное аудио/M4A/MP3, SRT/TXT; watch, Music, Shorts, playlists, live | Прямые URLs/SABR/MSE/fallback зависят от текущего плеера и форматов. Избранные материалы плейлиста скачиваются в одном выбранном формате. |
| Rutube | HLS-видео и Shorts на `rutube.ru`/`rutube.sport` | Live не заявлен. Сегменты передаются в общий processor. |
| Twitch | Прямые MP4 clips, HLS VOD; real-time live recording | Live использует MediaRecorder/captureStream, отдельно от пути VOD. |
| VK Видео | Progressive MP4, отдельное DASH-аудио, M4A/MP3 | Получение зависит от payload плеера и доступных источнику форматов. |
| TikTok | Варианты MP4, отдельный исходный звук и MP3 | Некоторые результаты сохраняются page Blob/anchor, минуя общий downloads handler. |
| Coub | Видео/звук отдельно; сборка с зацикливанием | Combined mux имеет явный memory limit в коде. |
| Звук | MP3 и очереди треков | Используется доступный аккаунту поток; без соответствующего доступа может быть только preview. |
| Instagram Reels | Не найдено | Нет адаптера и matching host/content script. Нужен отдельный этап исследования. |

Эта таблица подтверждает наличие реализации, а не успешное скачивание в текущем состоянии площадок. В рамках подготовки расширение не устанавливалось в браузер, реальное медиа не скачивалось.

## Что относится к авторскому оформлению и инфраструктуре

- Название, подписи меню и popup, icons, storage/message/DOM namespace, diagnostic filename.
- Telegram link в [`content_ui.js:324`](https://github.com/confeden/Nova-Video-Saver/blob/6a2bc6dc1234a3c4b0037885b08cad486abe1bac/extension/content_ui.js#L324) и [`popup.html:14`](https://github.com/confeden/Nova-Video-Saver/blob/6a2bc6dc1234a3c4b0037885b08cad486abe1bac/extension/popup.html#L14); донат и promotional links в исходном README.
- Updater endpoints в [`background.js:12`](https://github.com/confeden/Nova-Video-Saver/blob/6a2bc6dc1234a3c4b0037885b08cad486abe1bac/extension/background.js#L12) и release link в popup. Проверка выполняется при install/startup, по alarm с периодом 8 часов и из popup. Это внешние запросы помимо самой медиаплощадки.
- [Legacy workflow](https://github.com/confeden/Nova-Video-Saver/blob/6a2bc6dc1234a3c4b0037885b08cad486abe1bac/.github/workflows/publish_update.yml) отправляет update metadata в другой репозиторий автора и использует его secret name. Он не является инфраструктурой MendoSave и не должен активироваться при импорте.

Пользовательское оформление и каналы автора можно заменить. Служебное происхождение, GPL и сторонние notices сохраняются. Условия исходника: GPL-3.0-only согласно исходному README; ffmpeg.wasm wrapper - MIT; используемое FFmpeg core включает GPL-компоненты; Mediabunny - MPL-2.0. Отдельная основа Triangle-Downloader также указана в [исходных notices](https://github.com/confeden/Nova-Video-Saver/blob/6a2bc6dc1234a3c4b0037885b08cad486abe1bac/THIRD_PARTY_NOTICES.md).

## Перенос и новые функции

| Вывод | Evidence | Следствие |
|---|---|---|
| Это Chromium MV3, не готовая Firefox-сборка | [manifest](https://github.com/confeden/Nova-Video-Saver/blob/6a2bc6dc1234a3c4b0037885b08cad486abe1bac/extension/manifest.json) задаёт service worker и offscreen; [Firefox background contract](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background) использует scripts/event pages | Требуются browser-specific background/processor host и проверка lifetime. Простая замена имени не решает перенос. |
| MAIN-world injection сама по себе не является blocker для нового Gecko | [Mozilla compatibility data](https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/content_scripts.json) указывает `world` начиная с Firefox 128 | Проверить реальный bridge и source interception в Zen; не добавлять injector без необходимости. |
| Отсутствие диалога вызвано явным параметром | [background.js:200](https://github.com/confeden/Nova-Video-Saver/blob/6a2bc6dc1234a3c4b0037885b08cad486abe1bac/extension/background.js#L200): `saveAs: false` | Настройку добавить в общий handler и подключить отдельные save paths. |
| Общий handler не покрывает каждое сохранение | [tiktok.js:321](https://github.com/confeden/Nova-Video-Saver/blob/6a2bc6dc1234a3c4b0037885b08cad486abe1bac/extension/tiktok.js#L321) использует Blob/anchor; запись Twitch также имеет page save path | Проверять R-004 по всем адаптерам; Blob нужно передавать поддерживаемым способом между контекстами, сохраняя cookies/CDN semantics. |
| Произвольную постоянную внешнюю директорию обычный Firefox API не предоставляет | [downloads.filename](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/download) принимает путь относительно downloads; [showDirectoryPicker compatibility](https://github.com/mdn/browser-compat-data/blob/main/api/Window.json) не включает Firefox | Использовать Save As. Несколько отдельных файлов могут требовать нескольких диалогов; один ZIP - одного. |
| Существующая очередь не является запрошенным пакетом форматов | [content_ui.js:1740](https://github.com/confeden/Nova-Video-Saver/blob/6a2bc6dc1234a3c4b0037885b08cad486abe1bac/extension/content_ui.js#L1740) хранит очередь разных videos; один выбранный format применяется к списку | Добавить план нескольких output files одного материала; не смешивать его с playlist queue. |
| ZIP-функции отсутствуют | В собственном коде не найден ZIP writer/library; ZIP в background относится к релизу расширения | Нужны output staging, локальная упаковка, общий progress и failure/cancel policy. |
| WebCodecs capabilities отличаются | [Mozilla codec guide](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection) отмечает отсутствие AAC encoding в Firefox; processor уже имеет hardware/fallback paths | Проверять реальные codecs и fallback, не обещать скорость Chromium. MP3 всё равно использует другой encoder. |

## Подтверждённое несовпадение API-контракта

В [`offscreen.js:1438`](https://github.com/confeden/Nova-Video-Saver/blob/6a2bc6dc1234a3c4b0037885b08cad486abe1bac/extension/offscreen.js#L1438) recovery index читается через `chrome.storage.local`; запись также обращается к storage. По [контракту Chrome offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen) в этом контексте доступен только extension API `runtime`.

Из исходника отдельно извлечена функция `readRecoveryIndex`. При выполнении в изолированном Node probe с документированным окружением `chrome = { runtime: {} }` получен `TypeError: Cannot read properties of undefined (reading 'local')`. Это подтверждает несовпадение кода с контрактом и необходимость перенести recovery index operations в поддерживаемый контекст/сообщения. Это не browser reproduction: фактическая работа recovery в Chrome или Zen здесь не испытывалась.

Есть дополнительный предел совместимости исходного Chromium path: `chrome.offscreen.hasDocument()` применяется без feature detection, а [официальная API documentation](https://developer.chrome.com/docs/extensions/reference/api/offscreen#method-hasDocument) указывает Chrome 150+. Нижняя граница Chromium source build явно не записана в manifest. Её необходимо проверить и документировать либо добавить совместимый путь перед заявлением поддержки старых Chromium-браузеров.

## Риски публичного выпуска, требующие проверки

- **Данные страницы недоверенные.** MAIN/ISOLATED bridge уже проверяет source/origin и допускает ограниченные relayed commands. Но page scripts могут участвовать в том же message channel. Нужны схемы, limits, sender/job ownership и проверка отрицательных сценариев. Само наличие проверки origin не является подтверждением полной безопасности.
- **Workers и политика Mozilla.** YouTube hook оборачивает page workers и загружает их оригинальный script через import/importScripts. Нужно проверить необходимость этого пути в Gecko, влияние на страницу и соответствие package review. Отдельно проверяются собственные bundled libraries, отсутствие remote extension code и отсутствие ослабления CSP. Публикационная приемлемость этой реализации не подтверждена.
- **Приватная диагностика.** Исходник сохраняет локальный ограниченный журнал, page URL, state и error details и может автоматически создавать debug file. Экспорт должен исключать credentials, cookies, подписанные media URLs и чувствительные page fragments; private browsing/containers рассматриваются отдельно. Отсутствие analytics identifiers в статическом поиске не заменяет network review.
- **Ресурсы и завершение.** В исходнике используются OPFS, in-memory fallback, base64 transfer и задержанное освобождение Blob URLs. Большие jobs и ZIP требуют проверенных quotas, cancellation, storage cleanup и фактического окончания downloads. Возврат download ID подтверждает начало, а не сохранённый полный файл.
- **Зависимости и воспроизводимость.** FFmpeg core занимает 32 129 114 bytes. В бинарнике обнаружены GPL build flags; версию и recipe notices необходимо связать с фактическим binary/source hash. Mediabunny bundle header подтверждает `1.51.0`. Источник tree проверен, но официальные upstream dependency bundles независимо не сравнивались; vulnerability databases не проверялись.
- **Упаковка.** Исходный build.ps1 упаковует extension files и исключает Musify. Root LICENSE/THIRD_PARTY_NOTICES не входят в этот список автоматически. Скрипт также удаляет архивы других версий в своём каталоге. Для MendoSave нужна проверенная поставка notices и безопасное сохранение финальных releases; исходный script в подготовке не запускался.
- **Документация и факт.** README содержит ограничения старых путей больших live/VOD файлов, а код имеет новые spool/mux paths. Не переносить обещания/пределы дословно: установить их опытно и описать по каждому пути.

В собственных JS/HTML/manifest не найдено совпадений для перечисленных analytics/telemetry markers, Instagram и Native Messaging; ZIP implementation также отсутствует. Это ограниченный статический результат, не доказательство отсутствия всех возможных сетевых действий или уязвимостей.

## Выполненные проверки и пределы

- Получены metadata, default-branch commit, полная Git tree и последние release metadata через GitHub read-only API.
- Скачан закреплённый исходный ZIP; все 41 files проверены по Git blob hashes, сохранены SHA-256 archive/file metadata.
- Все 14 собственных JS-модулей успешно проверены `node --check` с Node `v22.18.0`. Это проверка синтаксиса, не extension API или playback behavior.
- Проверены структура manifest, собственные модули, browser API calls, основные media/save/message paths, branding/updater references, build/CI, notices и metadata встроенных компонентов. WASM и vendor bundle не проходили полный semantic/security review.
- Выполнен изолированный recovery API probe. Его результат и ограничения приведены выше.
- Локально обнаружены Zen `1.23.1b`, Gecko platform `157.0.1`, Python `3.13.7` и Git `2.51.0.windows.1`. Рабочий профиль не изменялся.
- Не выполнялись browser installation, real downloads, `web-ext` lint/build, security scan, render/interaction QA, подписание, создание GitHub remote или публикация. Эти проверки принадлежат следующим фазам.

## Эффект на следующий шаг

На основе исходника можно готовить самостоятельное расширение. Первая существенная неопределённость - полный media/download path и lifetime в Gecko; его проверка должна предшествовать широкому переносу меню и ZIP. Пакетная загрузка - отдельное новое поведение; для одиночного Save As есть штатный browser API. Текущая подготовка завершается документами и сохранённой базой, а улучшение скачивания будет подтверждаться только конечными файлами в целевом браузере.

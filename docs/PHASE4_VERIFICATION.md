# Фаза 4 - проверка release candidate

Проверено: **10-10-2026**, версия **0.3.0**, Windows. Этот отчёт отделяет завершённые браузерные проверки от отрицательных результатов и релизных ограничений. Требования - [PROJECT_SPEC.md](PROJECT_SPEC.md), состояние и разрешения - [ROADMAP.md](ROADMAP.md). Предыдущие результаты сохраняются в [PHASE2_VERIFICATION.md](PHASE2_VERIFICATION.md) и [PHASE3_VERIFICATION.md](PHASE3_VERIFICATION.md).

Браузерный проход закрыл доступный TikTok, очередь двух разных реальных YouTube-материалов через контролируемое начальное состояние, трёхминутный Twitch live, минутное перекодирование, прерывание обработки полным закрытием Chromium и восстановление готовых входов, ZIP около 1 GiB и реальный отказ OPFS. Найденная ошибка Chromium SRT исправлена и повторно проверена в обоих браузерах. **Полная релизная готовность пока не заявляется:** штатная очередь выбранного Google playlist, реальное исчерпание квоты и физический chooser Chromium не получили положительной проверки; окончательная поставка также имеет отдельные релизные условия.

## Среда и проверенная сборка

Использованы отдельные тестовые профили: Zen **1.23.2b / Gecko 157.0.1**, Chromium **148.0.7778.96**. Zen заглушён через `media.volume_scale=0.0` только в тестовом профиле, Chromium запущен с `--mute-audio`. FFmpeg/ffprobe выводили декодирование в null sink, аудиодорожки файлов сохранены. Рабочие профили, cookies пользователя, настройки подписей и общий звук Windows не менялись.

Инструменты: Node.js **22.18.0**, Python **3.13.7**, FFmpeg/ffprobe **9.0.2**, geckodriver **0.37.1**. Существующий WebDriver/CDP harness продолжен без замены среды. В отдельном Chromium-профиле включён Developer mode, необходимый для unpacked extension; исправлен каталог загрузок этого профиля. Первый TikTok output до исправления harness попал в стандартный Downloads и был скопирован в QA с проверкой SHA; исходный файл сохранён.

После коррекции processor RAM bounds, абсолютного stage TTL и ограничений background log повторены затронутые YouTube video/audio, Cancel и restart. Тогда кандидат содержал **54 файла Firefox / 55 Chromium**; его bytes и inventory зафиксированы в `.local/qa/phase4/build-before-caption-correction.json`. Затем в обоих браузерах повторены свежие SRT-загрузки после соответствующей коррекции. Текущая сборка с parser guards Mediabunny и включёнными source/patch metadata содержит **57 файлов Firefox / 58 Chromium**; её inventory и затронутый браузерный повтор описаны ниже. Прежние receipts не выдаются за inventory текущей сборки. FFmpeg/WASM core сохранён; Mediabunny изменён детерминированным text transformation существующего bundle, без компиляции vendor code из исходников.

Локальный pipeline до SRT-коррекции дал **285 tests passed**. Текущий pipeline после SRT и vendor parser guards дал **295/295 tests passed**, ESLint **0 errors / 14 warnings**; `check:build`, dependency checks/audit и outgoing/history checks прошли. Для SRT выполнены regressions публичного transcript reader и сохранённых subtitle data, для parser guards - шесть проверок фактического публичного `Input` parser и отдельный byte-exact round-trip transformations. Mozilla `web-ext` текущего кандидата: **0 errors / 0 notices / 3 warnings**:

- `vendor/ffmpeg/814.ffmpeg.js:1:1124` - `UNSAFE_VAR_ASSIGNMENT`;
- `vendor/ffmpeg/ffmpeg.js:1:444` - `DANGEROUS_EVAL`;
- `vendor/zipjs/zip-native.min.js:1:63468` - `UNSAFE_VAR_ASSIGNMENT`.

Warnings закреплены за проверенными vendor bytes; strict lint продолжает их отвергать. Текущий pipeline подготовил три unsigned candidate archives и проверил CRC и извлечённые bytes. Это отдельный packaging receipt, не три пользовательских ZIP ниже. Текущие результаты - `.local/qa/phase4/pipeline-parser-final.log` и `pipeline.json`; ранний проход сохранён в `pipeline-final-code.log`. Подпись и публикация не выполнялись этим QA-проходом.

Из реально загруженного bundled core получены `-version` и `-buildconf`, оба завершились с кодом 0: FFmpeg **5.1.4**, emcc **3.1.40**, `--enable-gpl`, x264/x265/libvpx/libmp3lame и остальные перечисленные build flags. Receipt `ffmpeg-runtime-buildconf.json` подтверждает runtime configuration. Он не является проверкой компиляции vendor code из исходников; сохранение существующего ядра и source references описано в [DEPENDENCIES.md](DEPENDENCIES.md).

## Завершённые медиафайлы

Проверка выполнялась после фактического завершения browser download: контейнер, дорожки, выбранные параметры, длительность, timestamps начала/конца, полное декодирование с `-xerror -err_detect explode`, начальные/конечные кадры и аудиосэмплы. Receipt `media-validation.json` охватывает **27 файловых paths / 17 уникальных SHA**, все полные decode завершились без stderr ошибок. Совпадающие копии проверялись по bytes/SHA без повторного декодирования того же содержимого. Просмотрены кадры начала/конца каждого контрольного визуального материала; SRT имеет отдельную проверку содержимого ниже.

| Контроль | Полученный файл | Измерение и граница |
|---|---|---|
| [TikTok scout2015](https://www.tiktok.com/@scout2015/video/6718335390845095173), Zen и Chromium | MP4, **2 953 029 bytes**, H.264 576×1024 + AAC | Видео 10,466667 с / 314 кадров, аудио 10,495011 с. SHA обоих файлов `d2899f4428fa4c46a8dca6b0222bc313ffdeff0fd8ed6f99a300f1833b3fda3e`. Ранее недоступный конкретный материал теперь получен; весь каталог TikTok не проверен. |
| [Me at the zoo](https://www.youtube.com/watch?v=jNQXAC9IVRw), оба браузера, повтор после RAM/log corrections | MP4 240p, **603 216 bytes**, VP9 320×240 + AAC; MP3 VBR V0 с JPEG cover | Видео 18,933663 с / 284 кадра, AAC 19,063583 с. MP3: Zen **247 236 bytes**, 19,013016 с; Chromium **247 392 bytes**, 19,020998 с. Контейнерные SHA различаются; одинаковый размер не использован как доказательство равенства bytes. |
| [Coub clownpiece](https://coub.com/view/or1i6abuay), оба браузера | Три выбранных отдельных файла и STORE ZIP | H.264/AAC один проход **3 580 865 bytes**, видео-only med **2 406 769 bytes**, исходный MP3 **1 052 674 bytes**. Параметры и SHA совпали с фазой 3; видео 10 с, звук MP4 10,008005 с, MP3 43,782993 с. |
| [Twitch shyr1k999](https://www.twitch.tv/shyr1k999), Zen, 180 с записи | WebM **279 149 648 bytes**, VP8/Opus 1920×1080 | 7 334 видеокадра; конец видео 181,260 с, аудио 181,326 с. SHA `46f8f537ce9c6b65d9fcf57e8d6a6934df8ca50f3b5b56e4225e2b66ebca0866`. Это трёхминутный контроль, не предел многочасового эфира. |
| Twitch, Chromium, normal и закрытие исходной вкладки | WebM VP9/Opus 1920×1080: **7 630 322 / 7 512 235 bytes** | Конец аудио 12,261 / 11,980 с; видео 12,076 / 11,922 с. По одному output, закрытие помечено `[частичная запись]`; начальные/конечные кадры извлечены. |
| Контролируемая processor fixture, Zen | MP4 H.264 1280×720 + AAC, **55 771 353 bytes** | Реальные входы: видео 56 866 446 bytes и аудио 508 046 bytes. Видео 60 с / 1 800 кадров, звук 60,010 с. Повтор после Cancel завершился примерно за **38,17 с** при скрытом owner и закрытии дополнительного popup. Это синтетический input для обработки, не новый site result. |

Положительные paths: прямой site download TikTok, Coub audio/video-only и processor output Coub/YouTube. В текущем YouTube-контроле использовались SABR capture и локальная сборка дорожек; это не доказательство доступности произвольной подписанной direct URL.

## Повтор после parser guards Mediabunny

В обоих временных профилях установлена текущая сборка и открыты свежие страницы тех же реальных материалов. SHA-256 bundle, полученного через extension resource в каждом браузере, совпал с текущим `extension/vendor/mediabunny/mediabunny.min.mjs` и обеими `dist`-сборками: **`30dedb32345d3ccc025df5ed6af5c518f79eb589fcf757022ae2af0eaffaec58`**, **645 512 bytes**. Полные изменённые MPL source files, описание преобразования и hashes включены в `extension/vendor/mediabunny/`; это не доказательство компиляции TypeScript в поставляемый bundle.

| Материал и путь | Zen и Chromium после guards | Проверка конечных bytes |
|---|---|---|
| YouTube `jNQXAC9IVRw`, MP4 240p | По одному complete download **603 216 bytes**, VP9 320×240 + AAC. В обоих журналах `mediabunny worker-remux ok` и `run=mediabunny.mp4`, без fallback | Видео 18,933663 с / 284 кадра, AAC 19,063583 с / 821 frame. Начало обоих tracks 0; конечные PTS+duration 18,933664 / 19,063583 с. Полный decode и извлечённые кадры начала/конца прошли; container SHA браузеров различаются. |
| Coub `or1i6abuay`, «Только звук» | По одному complete download исходного MP3 **1 052 674 bytes** | Аудио 43,782993 с / 1 678 frames. SHA обоих файлов `a8f26de68586ed91878e89ac3ff5d10c20d5fb585714e34641312a2e6528a853` совпал с ранее полностью декодированным контролем. Этот source-audio путь не использует parser guards Mediabunny. |
| Twitch VOD `1442198124`, HLS MPEG-TS → FFmpeg remux | По одному complete MP4 **4 333 423 bytes**, H.264 1280×720 + AAC; `run=out.mp4` | Видео 24,024367 с / 720 кадров, AAC 24,042667 с / 1 127 frames. Начало обоих tracks 0; максимальные PTS+duration 24,025 / 24,042666 с. Полный decode и кадры начала/конца прошли. Оба файла имеют SHA `0eeccb0e3db44271b8accb57f768e19a80d5f203e0b020615dd0b9a18a747bf9`. Это прежний FFmpeg TS-путь, не браузерная проверка malformed ADTS. |

Новый receipt охватывает **6 файловых paths / 4 уникальных SHA**. Полное декодирование завершилось с кодом 0 и пустым stderr; для bytes, уже проверенных под тем же SHA, повторное декодирование не выполнялось. Начальные/конечные аудиосэмплы получены в null/PCM sink без слухового воспроизведения. В Zen не зарегистрированы ошибки script console собственного extension origin; в Chromium не зарегистрированы `Runtime.exceptionThrown` подключённых extension contexts. Эти условия не означают отсутствие ошибок сторонних страниц или рекламы.

Receipts: `.local/qa/phase4/guarded/zen-media.json`, `chromium-media.json`, `media-validation.json`, `final-check.json`. Поле `presentationRanges` использует максимум PTS+duration по дорожке; последний пакет в порядке чтения не принят за последний показанный кадр при H.264 B-frames. Отрицательные parser cases покрыты шестью actual `Input` regressions в [mp4-resource.test.cjs](../tests/mp4-resource.test.cjs), где allocation budget уменьшен только в test copy. В браузеры не передавались malformed fixtures с миллиардными counts. Остальные 27 outputs, ZIP и исправленные SRT не повторялись после этой vendor-коррекции.

## Очередь разных материалов

Штатный picker [Google Search Stories](https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE) показал **10 реально загруженных строк**. Выбраны первые два разных материала: `GvgqDSnpRQM` и `V4DDt30Aat4`, формат MP3. Первый материал получил HTTP 403 на audio URL, затем запасной MSE-путь остановился с частичными данными. В bounded проходе конечного файла не получено, второй материал остался pending. Собственный reload расширения не дал завершения. После Cancel key очереди удалён, новых файлов нет. Это отрицательный результат конкретного playlist/sample; штатный сквозной picker-проход **не считается PASS**.

Отдельно в **Zen и Chromium** выполнен одинаковый контролируемый runner-проход: в `storage.local` записана очередь двух известных доступных реальных видео с корректным owner token, затем использован обычный startup/queue runtime. Первый [jNQXAC9IVRw](https://www.youtube.com/watch?v=jNQXAC9IVRw) сохранён, расширение само открыло страницу второго [FlD9m5ufSjs](https://www.youtube.com/watch?v=FlD9m5ufSjs), второй сохранён, UI сообщил **2/2**, key очереди очищен. Ровно два завершённых native download на браузер: **603 216** и **1 815 653 bytes**. Второй файл - VP9 240×240, 58,500330 с / 1 755 кадров, AAC 58,560726 с; полный decode прошёл.

Этот положительный контроль доказывает исполнение очереди реальных разных материалов и собственную навигацию. Начальный выбор был **runtime-seeded fixture**, поэтому он не заменяет отрицательный результат штатного playlist picker и не доказывает восстановление очереди после полного browser restart. Receipts: `zen-playlist-negative.json`, `zen-seeded-queue.json`, `chromium-seeded-queue.json`.

## Cancel, закрытый popup и полный перезапуск

В Zen после текущих processor corrections отменено минутное перекодирование: `mendosave-abort` вернул `ok: true`, finalize - `ok: false, cancelled: true`. Файл `QA-cancel.mp4` не создан. Последующая задача с теми же входами успешно завершилась, что проверяет освобождение processor lease. Owner был скрыт, дополнительный popup закрыт.

В Chromium тот же bounded processor input также отменён после непосредственного подтверждения `phase: processing`. Abort вернул `ok: true`, finalize - `cancelled: true`; после него `activeJob` и staging пусты. Ни download, ни `QA-Chromium-cancel.mp4` не появились. Это отмена processor API, не физическое взаимодействие с диалогом сохранения.

В Chromium три **реально подготовленных Coub-входа** оставлены в OPFS после ошибки упаковки. Затем начата минутная processor-задача. Перед `Browser.close` непосредственно подтверждены её job ID и `phase: processing`. Закрыт весь отдельный браузер, запущен тот же тестовый профиль. После запуска `activeJob` пуст, незавершённый `QA-full-browser-restart.mp4` отсутствует. Три исходных recovery ID, размеры и bytes сохранены.

Автоматический flush вернул `saved: 0, pending: 3`. Настоящая кнопка popup «Сохранить готовый файл» создала ровно три `complete` downloads; их SHA совпали с подготовленными Coub-входами, у каждой записи появился `savedAt`. Следующая реальная YouTube-очередь также завершилась. Это сохранность **готовых входов**, не автоматическое продолжение прерванного перекодирования. Проверялось обычное полное закрытие браузера, а не OS crash или отключение питания. Полный restart Zen в этом проходе отдельно не выполнялся; его processor-restart/Cancel evidence фазы 3 сохраняется.

Receipts: `cancel-processor-result.json`, `chromium-processor-cancel.json`, `long-processor-result.json`, `chromium-full-restart-before.json`, `chromium-full-restart-after.json`, `restart-recovery-bytes-check.json`. Прежние phase 3 Save As, Cancel второго файла, SRT Cancel, Tab ownership и остановка после chunk используются в пределах тех сценариев; новый физический chooser-проход не заявляется.

## ZIP, верхний размер и отказ ресурса

Новые Coub ZIP обоих браузеров - **7 041 032 bytes**, три STORE entries. Оба извлечены Windows PowerShell `Expand-Archive`; CRC и все извлечённые bytes проверены. Для Chromium хеши совпали с capture подготовленных bytes **этого же запуска до упаковки**. Для Zen использованы конечные файлы независимого запуска той же очереди; попытка capture globals в WebDriver не дала receipt, поэтому точное pre-archive сравнение Zen-запуска не заявляется.

В Chromium через настоящий package transfer → OPFS → STORE ZIP сохранены две диагностические Blob по **536 838 144 bytes**. Payload **1 073 676 288 bytes** = 1 GiB - 64 KiB; готовый ZIP **1 073 676 678 bytes**, overhead **390 bytes**. Скрытая исходная вкладка и закрытые popup не остановили упаковку; завершение измерено примерно за **165 с**. Все извлечённые Windows bytes, CRC и SHA сравнили с известным повторяемым исходным шаблоном. Это bounded binary fixture, не медиа сайта. 1 GiB готового архива целиком, ZIP64 большого файла и пиковая RAM этим измерением не доказаны.

Реальный безопасный отказ OPFS проверен созданием **файла** `mendo-archives` на месте ожидаемого каталога в тестовом storage. ZIP вернул `TypeMismatchError`; готового архива и native download нет, все три подготовленных входа остались для ручного сохранения. После удаления только созданной коллизии новые отдельные files и ZIP завершились. Это реальная filesystem resource error, **не исчерпание квоты или диска**.

Попытка `Storage.overrideQuotaForOrigin` для extension origin вернула CDP `-32603 / Internal error`. Диск не заполнялся; фактическая нехватка квоты остаётся непроверенной. Receipts: `coub-zip-bytes-check.json`, `chromium-upper-zip.json`, `upper-zip-bytes-check.json`, `chromium-storage-conflict.json`, `quota-override-negative.json`. Три пользовательских архива - Zen Coub, Chromium Coub и Chromium upper fixture - извлечены с полной проверкой содержимого.

## Screenshot и controls

Просмотрены реальные full-viewport screenshots: Zen settings **1190×975 / 306×975**, Zen package dialog **1230×875 / 310×835**, Chromium package dialog **1280×800 / 360×800**. Размеры получены из viewport, а не положения окна. Dialog помещается в узкий viewport; у исходной Coub-страницы в узком Zen есть horizontal overflow, сам dialog шириной 276 px не обрезан. Chromium narrow dialog шириной 311 px помещается и переводит action buttons в колонку.

В Zen настоящий WebDriver click включил Save As и сохранил настройку; Space выключил и сохранил её. Три нужных checkbox пакета выбраны Space; обработаны «Отдельные файлы» и «Один ZIP». Состояния подтверждены storage и конечными файлами. Это техническая визуальная проверка и controls QA, пользовательская визуальная приёмка отдельно не получена.

В Chromium реальный CDP keyboard event Space последовательно выбрал одну, две и снова одну позицию настоящего Coub dialog. «Один ZIP» включился только при двух позициях, «Отдельные файлы» - при одной; кнопка закрытия закрыла dialog. Выбранные значения не задавались напрямую в этом keyboard-контроле. Receipt: `chromium-keyboard-controls.json`.

Физический chooser Chromium сейчас **недоступен**: текущий каталог `mcp__cua_repl` явно содержит `Native computer APIs are disabled.` Native API не вызывались и запрет не обходился. `chromium-physical-chooser-unavailable.json` сохраняет источник и границу. Browser downloads cancellation фазы 3 остаётся подтверждённой отдельной проверкой; физический выбор пути/Cancel не выдаётся за PASS.

## Исправленная SRT-проблема и оставшиеся условия

До исправления Zen SRT имел **330 bytes**, UTF-8 BOM, три непересекающихся cue, конец **19,013 с**. Chromium SRT завершился с корректным UTF-8, но содержал **770 bytes / 9 cues** с повторяющимся текстом, пятью соседними overlap и концом **19,440 с**. Свежая вкладка воспроизвела тот же результат.

Диагностика не сохранила cookies или подписанные URL. Raw JSON3 и `get_transcript` ответ содержали шесть сегментов одной расшифровки. В DOM одновременно находились **три `transcript-segment-view-model` и шесть `ytd-transcript-segment-renderer`** с альтернативным разбиением того же текста. Фактический `MendoCaptions.readTranscript` объединил девять строк; `normalizeCues` затем сдвинул совпадающие начала на 0,5 с и создал overlap. Это был воспроизводимый продуктовый дефект смешивания DOM representations. Отрицательные receipts сохранены: `subtitle-files-check.json`, `chromium-srt-fresh-repro.json`, `chromium-srt-dom-choice.json`.

Коррекция выбирает одну DOM representation и сохраняет заданные start/end cues. Повтор на свежих вкладках после установки исправленных сборок дал **330 bytes / три cues в каждом браузере**, начала 1/7/16 с, концы 7/16/19,013 с в Zen и 7/16/19,021 с в Chromium. Повторного текста, overlap, добавленных 0,5 с и выхода за длительность соответствующего плеера нет. SHA отличаются только вместе с разными конечными timestamps; файл и browser download завершены. Проверка не включала независимую редактуру удалённого текста. Receipts: `chromium-srt-after-fix.json`, `subtitle-after-fix-check.json`, последний SRT case `zen-final-youtube.json`.

Остальные релизные границы: штатный playlist picker end-to-end, реальная quota exhaustion, физический Chromium chooser, многочасовой live, полный restart Zen, подпись и пользовательская приёмка. Затронутые vendor corrections проверены выше; сохранение нынешнего ядра и источники описаны в [DEPENDENCIES.md](DEPENDENCIES.md). Недоступный инструмент и отрицательный sample сохраняют свой статус; перечисленные положительные результаты относятся к конкретным сценариям.

Все частные outputs, browser profiles, logs, screenshots и receipts находятся в игнорируемой `.local/qa/phase4/`. В Git не включаются профили, пользовательские выгрузки, cookies, токены и подписанные медиассылки.

## Совокупная проверка технической подготовки

Runtime corrections закреплены в `aaf370a1277209c8b8029d05c25ea4508635058c`; base - `ee081f4aa121b7a006b5be268923cd7d1501308f`. Внутренний `$code-review` рассмотрел совокупный diff: приём и staging media, abort/ownership, очередь диагностики, transcript/SRT timing, MP4/AAC parser bounds, соответствующие MPL sources, упаковку, dependency/warning gates и CI. Оставшихся подтверждённых существенных дефектов в проверенном изменении не выявлено. Native decoder code и перечисленные непроверенные браузерные условия этим review не покрыты.

Локальный `npm run verify` прошёл все 10 gates и 295 tests. [GitHub CI run 38062095320](https://github.com/mendozie/MendoSave/actions/runs/38062095320) на том же runtime commit завершил Windows 2025, Ubuntu 24.04 и сравнение hashes трёх архивов/manifest успешно. Это переносимость build/packaging, не browser QA Linux. Первый CI run нашёл ошибку пути к вложенному artifact directory в comparator; путь исправлен, предыдущий успешный run и текущий pass сохранены.

Один Standard repository security scan завершён и sealed: 0 открытых reportable findings, coverage partial. Четыре исходные resource deficiencies устранены; фактический source snapshot, runtime digest и пределы описаны в [SECURITY_REVIEW.md](SECURITY_REVIEW.md). Managed PR review, окончательная подписанная поставка и её установка учитываются отдельно.

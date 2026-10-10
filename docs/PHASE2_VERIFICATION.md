# MendoSave - проверка фазы 2

Проверки: 09-10-2026 и 10-10-2026. Версия: 0.2.0. Результат - самостоятельное оформление расширения, исправленные адаптеры и измеренная матрица совместимости. Публичный релиз не выполнялся; репозиторий [mendozie/MendoSave](https://github.com/mendozie/MendoSave) создан приватным по прямому поручению пользователя.

**Технический результат фазы 2 проверен 10-10-2026.** После возобновления исправлены harness, сохранение при teardown, длительный browser save и завершение WebM. Проверены актуальные сборки в обоих браузерах; предыдущая остановка сохранена в [историческом checkpoint](PHASE2_CHECKPOINT.md). Совокупный срез фаз 1 и 2 находится в [PR #1](https://github.com/mendozie/MendoSave/pull/1). Репозиторий остаётся приватным; релизная приёмка не заявляется.

## Среда и границы

- Основная матрица: Windows, Zen 1.23.1b / Gecko 157.0.1, BuildID `20261006042626`; geckodriver 0.37.1 и отдельный временный профиль. При повторном запуске Zen штатно обновился до 1.23.2b, BuildID `20261009073723`, Gecko 157.0.1. Дополнительные lifecycle-проверки Twitch выполнены на этой версии; результаты остальных сайтов не приписываются повторно новому браузеру.
- Дополнительная сборка: Chromium 148.0.7778.96, отдельный профиль и CDP. Логин на площадки не выполнялся.
- В Zen `media.volume_scale = 0.0`, в Chromium `--mute-audio`. Это настройки тестовых профилей; аудиодорожки в скачанных файлах проверены отдельно и сохранены.
- Node.js 22.18.0, npm 10.9.3, Python 3.13.7, FFmpeg/ffprobe 9.0.2. Установка расширения временная/распакованная; проверки не устанавливают готовность подписанного XPI.

Локальные профили, готовые медиа, сырые DOM/network данные, журналы и screenshots сохранены в `.local/qa/phase2/` и исключены из Git. В README входит только просмотренный screenshot собственного документа настроек, без площадки, аккаунта или локального пути. Исходный snapshot и исторический README не редактировались.

## Изменения и regression evidence

Имя, значки, видимые подписи и runtime messages заменены на MendoSave. Upstream updater, его обработчик, `alarms` и GitHub host permission удалены. Durable storage keys и OPFS `nvs-recovered` сохранены: переименование этой папки при первой внутренней проверке оказалось бы потерей доступа к уже подготовленному файлу и исправлено до публикации. Лицензии, credits и все пять vendor-файлов сохранены без изменения bytes.

В Zen обнаружена ошибка Gecko Xray: чужой ArrayBuffer нельзя безопасно передавать через локальные typed-array методы с выбором species. Rutube/TikTok/Twitch/VK создают собственные bytes на границе; YouTube копирует только передаваемые chunks размером до 4 MiB, включая staging/mux/live. Исходные массивы дорожек целиком не дублируются этой helper-функцией. Для Coub уже существующий путь с owned merged buffer проверен отдельно. Регрессии воспроизводят исходное исключение; реальные Rutube и MSE-fallback подтверждают исправление в браузере. Контекст: [Mozilla Bug 1868675](https://bugzilla.mozilla.org/show_bug.cgi?id=1868675), [Bug 1681809](https://bugzilla.mozilla.org/show_bug.cgi?id=1681809).

Дополнительные исправления:

- YouTube MSE: `currentVideoId` доступен в обеих ветках наблюдения за appendBuffer; init/media bytes не теряются.
- Rutube: кнопка распознаёт текущий Shorts overlay и переносится при SPA-навигации; rolling/encrypted HLS, `MAP` и `BYTERANGE` не выдаются за полный VOD; ошибка finalize вызывает abort.
- VK: учтены видимые open shadow roots; проверяются start/end/total в доступном `Content-Range` и размер тела. Размер из HEAD/GET должен быть положительным decimal safe integer. В regression воспроизведён ответ `bytes 0-3/999` при ожидаемых 4 bytes: теперь chunk/finalize не выполняются. Скрытый CORS header и неизвестный total `*` сохраняют fallback с точной проверкой body. JSON и защищённые/неподдержанные DASH варианты также покрыты отрицательными tests; отдельный аудиофайл в живом VK не подтверждён.
- TikTok: реальное разрешение, MIME исходного звука и MP3 filename; проверка ID и точного range start/end/total/length, включая fallback. Несовпадение отвергается до отправки chunks/finalize.
- Twitch: завершённый HLS собирается по порядку с ограниченным lookahead; варианты одинакового разрешения различаются по фактическим master-параметрам. В контрольном AWS master оба варианта заявляют 29,973 fps: разные `VIDEO` и bandwidth не превращены в выдуманные 60/30 fps. Отсутствующий live frame даёт немедленное сообщение вместо зависшего `play()`.
- Coub: неполный последний MP3 frame отвергается; MPEG-2 duration разобран корректно; high/med с одинаковыми pixels различаются по source key/размеру.
- Звук: доступный preview имеет `[фрагмент]` в имени и реальные параметры; полный трек или 320 кбит/с не заявляются по одному preview.
- Coub/TikTok/Звук: Enter/Space для `role=button`, защита от repeat; Escape закрывает меню и освобождает listener. Twitch использует нативные buttons.

Журнал очищается перед сохранением и повторно при экспорте, включая legacy entries: URL path/query, blob/data URLs, headers, bearer, secret fields и приватные пути. Отдельно воспроизведена и исправлена утечка suffix в пути с пробелом/апострофом. Structured JSON остаётся читаемым; свободный текст с путём консервативно теряет остаток строки. Это ограниченная redaction-проверка, не доказательство отсутствия любых возможных секретов.

## Сохранение записи и готового файла

Первый managed review [PR #1](https://github.com/mendozie/MendoSave/pull/1) проверил commit `1f763286a60e6d90778c2e9109b66a5ff4e84f7d` и выявил два подтверждённых дефекта: потерю page-local Twitch chunks при teardown и уничтожение готового output по произвольному 30-минутному deadline. Для обоих воспроизведён RED до исправления.

Twitch теперь передаёт chunks в обработчик с подтверждением записи в OPFS. Перед началом MediaRecorder проверяются реальный sender, верхний frame, Twitch URL, tab/document/job и подтверждённый Port. Входная очередь ограничена 192 MiB, передачи - chunks до 4 MiB. При завершении обработчик дожидается уже принятых write chains; повторный disconnect не создаёт второй download. Нормальная остановка дожидается хвоста recorder, а reload/close сохраняет полученный фрагмент с явной пометкой. Последние события MediaRecorder асинхронны, поэтому они не служат условием сохранения ранее принятых bytes: [MediaRecorder.stop](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/stop), [runtime.Port](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port).

Первый Chromium проход дополнительно обнаружил повтор video timestamp и незавершённый однобайтовый EBML header в конце частичной записи. Эти два download были `complete`, но строгую проверку файла не прошли; они сохранены как отрицательное evidence и исключены из числа проверенных файлов. Локальный packet-copy probe встроенного Mediabunny сохранил все полные video/audio payloads и декодированный PCM побайтно. В обычной записи изменён ровно один video timestamp, 621 → 622 мс; audio timestamps не изменены. Частичный input завершён в новый WebM без потери полных пакетов. Итоговый путь пишет контейнер в OPFS через StreamTarget; весь эфир не собирается в page-local массив. [Encoded packet sources](https://mediabunny.dev/guide/media-sources#encodedvideopacketsource) позволяют переносить готовые пакеты без декодирования и повторного кодирования.

На момент остановки remux был WIP: после промежуточного 8/8 PASS suite завершился 8 PASS / 6 cancelled, exit 1. Причина отмены тестов - `unref` у таймеров awaited work в harness. После исправления таймеры сохраняют event loop до результата и очищаются в конце теста. Текущий live suite: 20/20 PASS, без cancelled; полный набор: 173/173 PASS. Обе сборки пересобраны и проверены реальными браузерными файлами.

Независимое чтение коррекции выявило ещё две границы, обе воспроизведены до исправления. При усечении native Chromium source на 100 bytes исходник содержал 369 полных VP9 и 206 Opus packets, но Mediabunny отбрасывал последний cluster и сохранял лишь 365/204. Повторное чтение тем же parser не замечало потери. Теперь обработчик обходит EBML headers через bounded Blob slices, оставляет полные terminal blocks и корректирует размеры контейнера; число пакетов сверяется независимо от vendor. Неполный хвост автоматически включает `[частичная запись]`. Encoded payloads и audio timestamps сохраняются; video timestamps нормализуются до строго возрастающих milliseconds. Исправленный native output проверен независимым FFprobe: 369/206 packets. Regression собственного fixture проверяет known/unknown-sized Cluster, 3 VP8/30 Opus packets и точное совпадение payloads. Правила размеров и границ: [EBML, RFC 8794](https://www.rfc-editor.org/rfc/rfc8794.html), [Matroska, RFC 9559](https://www.rfc-editor.org/rfc/rfc9559.html).

Если OPFS `getFileHandle` завершается после stall guard, позднее создание output больше не оставляет потерянный файл: copy проверяет остановку после await и повторяет cleanup для поздно полученных ресурсов. RED → GREEN проверяет отсутствие download и сохранение raw source. Неизвестная структура, потеря дорожки/пакетов, пустой или повреждённый output и неподдержанный неполный BlockGroup дают ошибку вместо успешного файла. Данные raw source при ошибке остаются у обработчика; продолжение после закрытия host или браузера этим не обещается.

После получения download ID Blob URL, output и keepalive сохраняются до состояния `complete`, `interrupted` либо явной отмены job. Regression моделирует 31 минуту паузы/медленного сохранения, завершение, отмену, очередь следующего job и OPFS recovery при недоступном worker без дубликата. Реальное ожидание 31 минут не выполнялось; это проверка состояния на виртуальных часах. При бессрочной пользовательской паузе ресурс остаётся занят до resume/cancel.

## Реальные файлы

Полная [матрица площадок и контрольные ссылки](SITE_MATRIX.md) отделяет проверенный файл от fixtures и недоступной страницы. Проверены 36 конечных медиафайлов, включая повторения между браузерами, два upgrade-контроля и 14 дополнительных Twitch recordings, плюс SRT. Девять новых WebM проверены после исправления remux. Два ранних Chromium raw WebM с отрицательным результатом и локальные remux probes в это число не входят. В таблице показаны основные разные варианты первого Zen прохода; размер - bytes, длительность - секунды по ffprobe, кроме отмеченного WebM.

| Сценарий | Размер | Контейнер и дорожки | Длительность |
|---|---:|---|---:|
| YouTube watch 240p | 603 216 | MP4, VP9 320×240 + AAC | 19,064 |
| YouTube watch MP3 | 247 236 | MP3 VBR + обложка | 19,013 |
| YouTube Music MP3 | 247 601 | MP3 VBR + обложка | 19,063 |
| YouTube Shorts, прямой путь | 7 604 002 | MP4, H.264 720×720 + AAC | 58,561 |
| YouTube Shorts, MSE fallback | 5 932 473 | MP4, VP9 720×720 + Opus | 58,521 |
| Rutube VOD 720p | 12 658 771 | MP4, H.264 1280×720 + AAC | 54,400 |
| Rutube Shorts 408p | 1 508 825 | MP4, H.264 408×720 + AAC | 23,733 |
| VK Видео 1080p | 4 093 725 | MP4, H.264 1920×1080 + AAC | 43,070 |
| Coub, один проход | 3 580 865 | MP4, H.264 880×720 + AAC | 10,008 |
| Coub, повторы | 15 765 585 | MP4, H.264 880×720 + AAC | 43,900 |
| Coub, исходный звук | 1 052 674 | MP3 192 кбит/с | 43,783 |
| Twitch clip 720p | 6 054 696 | MP4, H.264 1280×720 + AAC | 18,954 |
| Twitch VOD 720p | 4 333 423 | MP4, H.264 1280×720 + AAC | 24,043 |
| Twitch live, короткая запись | 20 961 303 | WebM, VP8 1280×720 + Opus | 12,860 |
| Звук, доступный фрагмент | 360 490 | MP3 96 кбит/с | 30,041 |

Для каждого файла проверены SHA-256, контейнер, дорожки, frames и полное декодирование без ошибок FFmpeg. Начальные и конечные видеокадры просмотрены; PCM проверен по длительности и RMS начала/конца. Нулевая последняя секунда звука AWS VOD отражена в receipt, вместе с конечной титульной карточкой; она не объявлена несуществующей дорожкой.

Chromium получил YouTube MP4/MP3/SRT, Rutube VOD, Coub одного прохода и Twitch clip. Rutube/Coub/clip побайтно совпали с Zen. У YouTube MP4 разные container hashes, но извлечённые VP9 и AAC payloads совпали по bytes и SHA-256. Оба SRT по 330 bytes содержат одинаковые три текста и начала cues; конец последнего - 19,013 и 19,021 с. Побайтное совпадение MP4 или SRT не заявляется.

MSE fallback проверен на настоящем Shorts: сначала плеер собрал медиа, затем сеть отключена только в тестовом профиле. Прямой запрос перестал работать; расширение собрало готовый MSE buffer через исправленную byte boundary. После проверки сеть и настройки возвращены. Это контролируемый fallback уже имеющихся bytes, не новая offline-функция.

Первый Twitch live проверен на публичном активном канале после штатного `Start Watching`: запись началась, нативная кнопка остановки создала WebM. В нём 768 video frames, 643 audio frames и ненулевой PCM. Native MediaRecorder не записал duration в format metadata: 12,86 с измерены по packet timestamps. Этот же файл воспроизведён в Zen без звука до `ended`, плеер определил 12,866 с. У офлайн `twitchdev` подтверждены `readyState=0`, явное сообщение и отсутствие файла. Длительный эфир, смена канала, завершение настоящей трансляции и большие квоты не объявляются проверенными.

До последнего remux WIP в Zen 1.23.2b получены 5 дополнительных WebM VP8 1280×720 / Opus 48 kHz stereo. Тогда lifecycle-проход дал normal 10 774 219 bytes / 13,12 с, reload 9 564 431 bytes / 13,12 с и close 9 323 180 bytes / 13,08 с; последние два имеют `[частичная запись]`, по одному download на сценарий. Все 5 декодированы, PCM ненулевой, первые/последние кадры просмотрены. В native readback `state=complete`, `exists=true` и totalBytes совпадают с файлами; Firefox bytesReceived при этом недосчитывает часть bytes, поэтому он не используется как доказательство размера. Два ранних файла сохраняют промежуточный результат; ранний reload ещё не доказывал верную пометку в имени.

После возобновления 10-10-2026 channel `fridocs` показывал архив, что отражено в browser receipts. Через актуальный MediaRecorder/host путь получены ещё три Zen WebM (Stop/reload/close) и один Chromium WebM (Stop); все четыре прошли проверку. Для проверки именно live выбран активный `shyr1k999`, индикатор эфира подтверждён страницей и screenshots. Итоговые пять файлов актуальной сборки:

| Браузер / действие | Размер, bytes | Дорожки | Длительность, с |
|---|---:|---|---:|
| Zen / Stop | 14 806 019 | VP8 1280×720 + Opus 48 kHz stereo | 13,226 |
| Zen / reload, partial | 13 113 214 | VP8 1280×720 + Opus 48 kHz stereo | 13,146 |
| Zen / close, partial | 12 253 737 | VP8 1280×720 + Opus 48 kHz stereo | 12,126 |
| Chromium / Stop | 9 014 361 | VP9 852×480 + Opus 48 kHz stereo | 12,253 |
| Chromium / close, partial | 9 898 156 | VP9 852×480 + Opus 48 kHz stereo | 12,112 |

На каждый сценарий получен ровно один файл: native readback `complete/exists`, totalBytes совпадает с actual bytes. Все девять новых WebM полностью декодированы без ошибок, PCM ненулевой, 18 начальных/конечных кадров просмотрены. Последние partial files воспроизведены без звука до `ended` в обоих браузерах: Zen определил duration 12,146 с, Chromium - 12,112 с. Различие Zen packet/format duration и native playback end отражает конец последнего audio packet. У обоих браузеров прочитаны runtime ID, версия 0.2.0 и SHA-256 `offscreen.js`, совпадающий с актуальной сборкой. Звук браузера выключен глобально; это не удаляет аудиодорожку из результата.

TikTok-контроль в обоих браузерах показал недоступность видео: полученного UI-файла нет, контрактные tests не заменяют эту проверку. Rutube playlist открывается как список без активного video/кнопки; скачивание всей подборки не реализовано. Сквозной проход унаследованной YouTube playlist queue в этой фазе не подтверждён. Эти границы остаются в матрице и roadmap.

## Обновление и устойчивость processor

В отдельном профиле временно установлена сохранённая сборка 0.1.0. После завершения старого startup flush в `nvs-recovered` помещён готовый контрольный MP4, index имеет `savedAt=0`; до обновления выходного файла нет. Выставлены нестандартные YouTube/Twitch settings. Установка 0.2.0 автоматически сохранила ровно один файл размером 603 216 bytes с исходным SHA-256 и обновила `savedAt`; настройки сохранены. Два последующих flush дали `saved=0`, `pending=0`, новых копий нет. Нельзя приписывать сохранение первому явному flush: оно произошло раньше, при startup нового background. После проверки настройки возвращены к default.

Regression suite сохраняет ownership, отмену, finalization и recovery контракты processor. Долгий WASM job, damaged input, закрытие host, скрытый/закрытый инициатор и прямой HTTPS измерены в [фазе 1](PHASE1_VERIFICATION.md); эти результаты использованы как существующее evidence, весь проход не повторялся. В фазе 2 дополнительно проверены реальные jobs адаптеров, MSE и upgrade recovery. Перезапуск Zen выполнялся без активного job ради конфигурации WebDriver; это не тест продолжения job после полного browser restart.

## Интерфейс и инструменты

Реальные screenshots просмотрены:

| Среда | Viewport | Проверка |
|---|---|---|
| Zen | 1246×983, 326×843 | Меню YouTube/Coub; новое меню Rutube Shorts на узком экране. Контролы помещаются; Coub Space сохранил MP3, Escape закрыл меню. |
| Zen popup document | 1246×983, 326×478 | Настройки, подписи и экспорт журнала помещаются. Screenshot узкого документа включён в README. |
| Chromium | 1280×800, 360×800, DPR 1 | Popup/settings, YouTube/Coub: клавиатурные select/checkbox/radio, focus, Escape, сохранение и восстановление settings. Экспорт журнала подтверждён download readback `complete`, 1689/1689 bytes, `exists=true`. |
| Twitch после коррекции | Zen 1246×983 / 306×843; Chromium 1280×800 / 360×800 | Start/Stop/таймер и normal/partial outputs. Узкие screenshots просмотрены после отказа от cookies и штатного сворачивания chat: кнопка видна, hit test попадает в неё. До сворачивания chat сама страница перекрывает плеер. |

У narrow YouTube в Chromium document scrollWidth 404 сохранился при скрытии всех MendoSave nodes; собственное меню помещается в 360 px. Старая content context после обновления Chromium extension дала ошибку до reload тестовой страницы; итоговый UI проверен после reload. Popup проверялся как документ вкладки расширения; нативное toolbar popup, все zoom/DPR и все клавиатурные сочетания площадок не подтверждены.

Итоговые локальные проверки коррекции:

- `npm test`: 173/173, включая 142 top-level tests и 31 subtests; failures/cancelled/skipped/todo нет. Live suite использует реальный pinned vendor и собственный синтетический VP8/Opus fixture.
- Firefox/Chromium 0.2.0: 40/41 file, manifest/local references/CSP/inventory hashes и состав проверены. Vendor bytes и обязательные лицензии сохранены; Musify не поставляется.
- ESLint: 0 errors, 14 видимых warnings. `web-ext`: 0 errors, 2 неизменённых vendor warnings; strict warnings-as-errors не считается пройденным.
- Outgoing checks: исходники и исходящая история проверяются отдельно; binary files считаются отдельно, ограниченные fixtures и точный исторический vendor build path имеют видимые исключения. Проверка не заменяет полный secret/security scan.
- `npm audit`: 3 high entries dev-only цепочки `web-ext > adbkit > node-forge`, 0 critical; совместимое исправление не подтверждено. Scoped `shell-quote` override проверен regression и `web-ext`; force downgrade не выполнялся.
- Внутренний `$code-review` совокупного программного diff выполнен; коррекция отдельно проверена на ownership, write/finalize races, packet integrity, lifetime, recovery, cleanup и соседний legacy YouTube live. Независимая проверка нашла потерю terminal packets и позднее создание OPFS output после timeout; оба дефекта исправлены и повторно проверены. Первый managed review сообщил два дефекта сохранения; для завершающего PR предусмотрен один focused managed correction pass.

Версии, команды и точные границы инструментов находятся в [DEVELOPMENT.md](DEVELOPMENT.md). Type checker, whole-program dead-code pass, GitHub CI и полный Codex Security scan не заявляются выполненными. Релизный scan предусмотрен фазой 4.

## Продолжение

Техническая коррекция фазы 2 проверена. Фаза 3 включает единый выбор места сохранения, отмену штатного Save As, пакет выбранных форматов, очередь и ZIP с проверкой извлечённых bytes. Различия processor/Page-Blob путей учтены в roadmap; реализация фазы 3 не начата и требует следующего поручения пользователя. Перед публичным выпуском нужны релизная приёмка, повторный dependency audit, security scan, подписание и отдельное сохранённое решение о смене приватности.

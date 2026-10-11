# MendoSave 0.3.1 - проверки

Дата: 11-10-2026. Статус: проверки и подписанная ручная поставка 0.3.1 завершены. Основная среда - отдельные тестовые профили Zen 1.23.2b / Gecko 157.0.1 на Windows; дополнительная - Chromium 148.0.7778.96. Рабочие профили пользователя и настройки подписей при runtime QA не менялись. [Release](https://github.com/mendozie/MendoSave/releases/tag/v0.3.1) и [отчёт подписания](SIGNING_VERIFICATION_031.md).

## Что проверяется

Срез исправляет скрытие окна пакета, отмену и повторный запуск, завершение progress UI, Worker lifecycle и освобождение медиапроцессора. Добавляется отдельный TXT с реальными таймкодами и доступными главами. Требования - [R-011-R-013](PROJECT_SPEC.md), разрешённый объём - [ROADMAP.md](ROADMAP.md#срез-031---пользовательская-проверка-и-исправления).

Исторические проверки 0.3.0 сохраняются в прежних отчётах и не считаются проверкой нового кода. Подписанный baseline имеет ID `mendosave@mendozie`; архив 0.3.0 и исходный snapshot сохранены.

## Пакет и обработчик

В Zen выполнен настоящий Coub workflow: три выбранных варианта, отмена первого запуска, повторный ZIP в том же окне, Hide клавишей Enter, переключение вкладки, завершение скрытого пакета, открытие по плавающей кнопке, Escape и следующая очередь отдельных файлов. Во время открытого неблокирующего окна native WebDriver click и ввод в поиск Coub сработали; picker остался открыт. В отменённом состоянии выбор и кнопки снова доступны, поздний статус его не заменил.

Обработчик работал в скрытом iframe фоновой страницы. Служебной вкладки не было. После отмены, ZIP и очереди отдельных файлов readback показал отсутствие iframe, instance, producer ports и reservations. Следующий запуск создал обработчик заново. Весь путь включал настоящие OPFS, медиабиблиотеки и browser downloads.

ZIP извлечён с проверкой CRC и byte comparison с захваченными входами именно этого запуска:

| Выбранный файл | Bytes | SHA-256 |
|---|---:|---|
| MP4 со звуком, один проход, 880×720 | 3 580 865 | `0c5c329c575b96274fd359fb27b53fff0bee1989eda259267ad6b8e401c6c36b` |
| MP4 без звука, 880×720 | 2 406 769 | `03e3c26923feb3aedab1543b06a57a05e7b7243fcb9cd7ab4d26bb2fbdfdf43b` |
| Исходный MP3 | 1 052 674 | `a8f26de68586ed91878e89ac3ff5d10c20d5fb585714e34641312a2e6528a853` |

Те же bytes уже прошли полное FFmpeg декодирование: H.264 880×720, 300 кадров / 10 с; со звуком - AAC около 10,008 с. MP3 длится около 43,783 с. Начало/конец видео просмотрены, крайние аудиосэмплы ненулевые. Повторные файлы с совпадающим SHA используют эту проверку явно, без заявления о новом декодировании каждого дубликата.

Реальные screenshots просмотрены при viewport **1246×883** и **326×843**. Все строки и controls помещаются, горизонтального overflow нет. Checkbox Space, Hide Enter и Escape выполнены через клавиатуру WebDriver. Headless Zen не подтвердил `document.visibilityState === 'hidden'` при переключении вкладки; переключение не выдаётся за измерение этого свойства. В отдельном Chromium проходе значение `hidden` подтверждено.

Текущие receipts находятся в ignored `.local/qa/next031/`. В Git нет профилей, пользовательских выгрузок, cookies, visitor IDs и подписанных медиассылок. Последующие corrections имеют отдельные regression и browser receipts; прежние файлы и результаты не заменяются утверждением о повторной проверке.

## Другие реальные файлы

Rutube: выбран 720p MP4 контрольного 54-секундного VOD. Завершённый файл содержит 12 658 771 bytes, SHA-256 `79eb681eb1d31de81f050236bda672bcbbfa71f85eb69bb788ed9d674860e5b7`, H.264 1280×720 и AAC. Видео - 1 629 кадров / 54,3 с; аудио - 54,358 с. Полный decode с `-xerror -err_detect explode` завершён без ошибок. Проверены packet ranges, крайние аудиосэмплы и начальный/конечный кадры; начальный кадр чёрный, конечный содержит затухающие титры. Это не заявляется проверкой всего каталога Rutube.

В Zen также завершены следующие настоящие загрузки. Для каждой подтверждены `downloads.complete`, существование файла, дорожки, начало/конец и полный decode с `-xerror -err_detect explode` без ошибок.

| Сценарий | Bytes | Дорожки и длительность | SHA-256 |
|---|---:|---|---|
| Twitch VOD, выбранные 720p | 4 333 423 | H.264 1280×720 + AAC, 24,043 с | `0eeccb0e3db44271b8accb57f768e19a80d5f203e0b020615dd0b9a18a747bf9` |
| TikTok, доступный вариант 576p | 2 953 029 | H.264 576×1024 + AAC, 10,495 с | `d2899f4428fa4c46a8dca6b0222bc313ffdeff0fd8ed6f99a300f1833b3fda3e` |
| YouTube jNQXAC9IVRw, 240p | 603 216 | VP9 320×240 + AAC, 19,064 с | `309a077c443ccf3f8db144976ea5cc370e355ada008644cef6957007a1ae7250` |
| Twitch live, 12 с записи до обычной остановки | 15 802 930 | VP8 1280×720 + Opus, 14,106 с | `7783435670f0b9fb642d1fa83e0c0450b9a17c315909e629c3288c47843d6dbf` |

После последней коррекции Worker fallback короткая загрузка YouTube 240p повторена на окончательной сборке: 603 216 bytes, SHA-256 `e779a190f98c1a3d70276fe4ae99dce2106f858e5705f38a014f8c4bf034cef5`, VP9 320×240 + AAC, 19,064 с. Полное строгое декодирование прошло без ошибок, начало/конец просмотрены, крайние аудиосэмплы ненулевые. Readback после завершения подтвердил отсутствие instance, iframe, producer ports и reservations. Hash отличается от предыдущего запуска, поэтому выполнена отдельная проверка файла.

В live сценарии shyr1k999 был offline. Через настоящую страницу Twitch directory выбран доступный LIVE Papaplatte; playback продвигался, использованы обычные start/stop controls расширения. Toast показал сохранение и terminal результат, затем скрылся. Собственные producer/reservations освобождены. Глобальное отсутствие host этим live запуском не подтверждается: до него оставалась работа прерванного YT480. Для Coub и остальных завершённых одиночных файлов отсутствие host проверено отдельно. VK и Звук в этом срезе повторно не проверялись; исторические результаты остаются в матрице.

Длинный WiDLJlGI5d0 в 480p не дал полного файла в ограниченном лабораторном проходе. SABR получил четыре ответа, но остановился без продвижения дорожек; 69,9 с вместо 773 с были правильно отвергнуты duration guard. После завершения Worker входные buffers уже недоступны, поэтому прежний buffered fallback подменял исходную ошибку сообщением «пустые данные аудио». Это не доказывает пустое аудио источника. SABR collector и соответствующая streaming logic совпадали с сохранённым upstream; новая регрессия 0.3.1 не установлена, парного запуска 0.3.0 на этом видео не было. Теперь при неполных retained inputs сохраняется исходная duration/worker ошибка и её diagnostics; полный buffered fallback сохранён с проверкой exact bytes. Это исправление достоверности ошибки и cleanup, не исправление источника или SABR protocol.

Подтверждённая недоступная отмена исправлена отдельно: SABR processing скрывал single-download Cancel, а резервный capture его не возвращал. После RED/GREEN выполнен настоящий повторный Zen проход с отказом SABR и reload: Cancel снова виден, native click дал «Загрузка отменена», readback показал ноль instance/iframe/producer/reservations. Это подтверждает отмену и cleanup конкретного перехода, но не полный 480p файл или устранение прежнего 97% stall. Residual прежнего теста сохранён перед заменой только лабораторной temporary installation; её замена не выдана за штатный cleanup.

## Расшифровка

SRT, plain TXT и timed TXT имеют отдельные подписи. Форматирование использует фактические cue times и отдельные главы, проверяет порядок, нулевой timestamp, часы, одинаковые времена, дубли, literal text и UTF-8. Отказ optional chapter extraction не превращает отсутствие captions в успех.

В Chromium настоящий пакет WiDLJlGI5d0 сохранил все три формата: SRT 3 448 bytes, plain TXT 1 672 bytes и timed TXT 2 463 bytes. Состояния downloads - `complete`, файлы существуют. Timed TXT содержит UTF-8 BOM, 47 настоящих cues и 9 буквальных глав; bytes совпадают с production payload. Cues и главы отдельно сопоставлены со свежим успешным native `get_panel` response. SHA-256 timed файла: `7dfd6cb9351d00fbe558f986e97d21600cead778f303a677856b4ad8ad236e11`.

В Zen на новой готовой странице тот же пакет завершил три downloads. Timed файл содержит 2 418 bytes, SHA-256 `57806bc2c382f129bdbb0a7ef797430431ed950fab0005abdf8093c381be6585`, UTF-8 BOM и exact production payload. Отдельное извлечение из реально заполненного native transcript panel подтвердило 47 cues и 9 глав с endpoints текущего видео. Отличие bytes от Chromium объясняется native локализацией заголовков: `Chapter` в Zen и `Эпизод` в Chromium. Текст сохраняется буквально. После пакета Zen host полностью освобождён.

Modern response не сообщает язык явно. В данном проверенном случае полный текущий player response содержит ровно одну дорожку `en/asr/a.en`, native CC metadata совпадает, перевод отсутствует; native command и все cue/chapter endpoints принадлежат текущему видео. Проверки до/после запроса подтверждают неизменность источника. Это ограниченный inference, отражённый в API как `unique-native-caption-track`, а не выдуманная attribution протокола. Stale SPA chapters отклоняются; главы без подтверждённой принадлежности текущему видео не добавляются.

Пример начала настоящего Zen-файла, с буквальным заголовком, полученным от YouTube:

```text
[00:00] Chapter 1: Intense tank battle

[00:00] Beautiful.
[00:22] Oh. Oh.
```

Существенная граница сохраняется: modern `get_panel` для jNQ возвращал английскую расшифровку после выбора немецких CC. Его video-only параметры не подтверждают выбранную дорожку. Multi-track или неизвестный track list таким inference не разрешается. В первом Zen сценарии после отменённого capture native captions ещё не были инициализированы: SRT/plain TXT сохранились, timed вариант честно отказал с 2/3 завершённых позиций. Отрицательный receipt сохранён отдельно; успешный проход выполнен на новой готовой странице.

Managed review выявил разрыв между допустимым размером расшифровки и старой передачей текста: большой TXT мог превысить лимит decoded text или data URL. Для UTF-8 output более 1 MiB используется существующий owned Blob transfer с chunks до 1 MiB, OPFS и ожиданием native download completion. Малые файлы сохраняют прежний маршрут. Строгая схема MIME/name/size не ослаблена; длинное supplementary Unicode имя сокращается без разрыва символа, terminal UI использует фактическое имя. RED/GREEN через настоящий `PackageIO.handle` проверяет ASCII, Unicode, длинное имя, точные bytes, отмену и освобождение spool/ports.

В отдельном Zen-профиле проверена контролируемая синтетическая расшифровка из 400 cues и одной главы. Через обычную кнопку сохранён timed TXT **3 077 523 bytes**, SHA-256 `f720d88e8c053e811dc8fb2034c388ee8800bf1ecdb234b5a559d8b4f72af988`. Затем настоящая очередь ZIP сохранила его вместе с plain TXT **3 073 492 bytes**, SHA-256 `d5513d66cfc2ef774ac095848ab48de4d1445b783eff86439f6b8a0eb304e4e8`. Извлечённые entries совпали с полными UTF-8/BOM inputs, подготовленными до упаковки; CRC прошли. Оба native downloads завершены, host/iframe/producers/reservations после них отсутствуют. Screenshots **1246×883** просмотрены. Это проверка большого output и пакетного транспорта, не получение настоящих больших captions от YouTube. Рабочий профиль и настройки подписей не менялись; свои процессы и порты закрыты. Receipts сохранены в ignored `.local/qa/next031-correction/`.

## Нагрузка

Выполнен baseline подписанной 0.3.0: 10 принятых пар enabled/disabled в свежих отдельных профилях, один первый визит и девять warm visits. Качество фиксировано: VP9 480×480@30 и Opus; seek 0, startup 15 с и playback 30 с, фильтры качества/пауз/времени. Порядок чередовался, одновременно работал один проверяемый браузер. Два SPA home/back перехода дополнительно сохранили document marker и выбранное качество.

Для девяти warm pairs разность enabled минус disabled по медиане: DCL -81 мс, load +47 мс, startup CPU +2,679 с, playback CPU +0,256 с, конечный Commit -15,35 MiB. Разброс менял знак: например, startup CPU от -5,250 до +5,412 с, Commit от -37,79 до +18,73 MiB. CPU учитывает доступные process samples, потерянные PID нельзя восстановить; Commit относится к конечной точке, не peak RAM. Long Tasks, native capture bytes, hidden playback и тяжёлая активная загрузка этим baseline не измерены.

Из этих данных не установлен доминирующий внутренний путь и не доказано ускорение 0.3.1. FFmpeg уже загружался лениво. Worker cleanup исправляет отдельно воспроизведённую ошибку lifecycle; выигрыш CPU или RAM от неё не объявляется измеренным. Частные protocol/raw/summary и проверки ownership cleanup сохранены в `.local/qa/next031-performance/`.

Пользователь сообщил, что прежний 480p stall на 97% сейчас не повторился и одиночный файл/пакет 480p+SRT завершились. Отсутствие воспроизведения не устанавливает старую причину и не считается её доказанным исправлением.

## Проверки кода и поставка

Новые behavioral cases проходят TDD. Старые harness обновлены для реального producer admission с сохранением проверок bytes, cancellation и удаления credentials. Совокупный внутренний review и bounded проверка коррекций выполнены. Исправлены обязательный instance target, кэш исчезнувшего idle host, terminal live toast, stale SPA chapters и закрытие активного host во время awaited ownership read. Последняя гонка воспроизведена с настоящими Chromium/Firefox backend в VM: четыре RED tests теперь GREEN; повторный независимый repro сохраняет активный host и старого producer, а после последнего idle закрывает host один раз.

Окончательный полный `npm run verify`: **561 tests PASS**, 0 failures/cancellations; ESLint 0 errors / 13 существующих warnings. Обе сборки содержат 58 файлов, manifests/CSP/inventory hashes проверены. `web-ext`: 0 errors / 0 notices / 3 рассмотренных vendor warnings. Свежий tooling audit сохраняет три рассмотренных node-forge entries, runtime registry audit - 0. Проверка outgoing files/history не нашла новых секретов; три unsigned архива извлечены и проверены byte comparison. Последняя коррекция сообщения Worker fallback входит в этот pipeline и имеет пять сценариев с настоящим detachment через `structuredClone(..., {transfer})`: duration/crash/partial сохраняют исходную ошибку и освобождают processor slot; возвращённые и pre-ready buffers сохраняют exact bytes для FFmpeg fallback.

Codex Security diff scan завершён на immutable code checkpoint `8570cbe0183e2ab2c5c615f29cb5931f97c45ca3`: 22 исходных файла, complete coverage данного diff, 0 reportable findings. [Отчёт и пределы security review](SECURITY_REVIEW_031.md) сохраняют неполное native/vendor покрытие прежнего repository scan. Последующий transport diff `aa09bcc..9673e5f` запечатан отдельно: один resource-кандидат оставлен deferred, поскольку конкретное влияние на доступность не доказано. Текущий consumer дополнительно ограничивает output 32 MiB UTF-8/BOM до processor/OPFS и SRT/VTT вход до форматирования: 50000 cues, 65536 UTF-16 units на строку, 8 Mi суммарно. RED/GREEN отклоняет превышения без ports/messages; максимальный допустимый Unicode budget сохраняет более 24 MiB exact bytes в timed TXT и SRT. Guard correction `9673e5f..6c84b8e` и финальный cue/filename diff `6c84b8e..1fce503` запечатаны отдельно, complete coverage их source scope, 0 reportable/deferred findings. Исторический deferred результат промежуточного scan сохранён; native exhaustion и peak memory не измерялись.

Первый managed PR review завершён на `aa09bcc915c227d61fff6788e8622f5d63999170`; обнаруженный oversized transcript исправлен и проверен локально. Единственный focused correction pass завершён на `6c84b8efb7f8741b6f1099e6eaa8fbd5f86fd984`, review `5482717699`. Два замечания о literal cue whitespace и потере filename markers исправлены после этого review. Новые RED/GREEN проверки сравнивают реальные SRT/VTT bytes, small/data-URL и large/PackageIO names, общий Archive.safeName и Windows reserved stems с ASCII/BMP/supplementary Unicode. Независимый bounded review выявил добавление `_` после распределения бюджета; prefix теперь учитывается до сокращения title. Все 123 scoped tests и итоговые 561 tests проходят. Третий managed pass не запускался; последние коррекции проверены по diff и существенным отрицательным случаям. Это локальная проверка финального candidate, а не managed review нового SHA.

Финальный runtime/source revision - `1fce50347ca109cd60da7d2942353b86de90cabf`. [CI run 38128782490](https://github.com/mendozie/MendoSave/actions/runs/38128782490) завершил Windows/Linux verify и reproducibility; 561 tests прошли на обеих платформах. Все три скачанных CI архива совпали с локальными SHA-256. [PR #5](https://github.com/mendozie/MendoSave/pull/5) интегрирован merge commit `606392fe1b07f500160dba75e653503f18fdf719`; подтверждённые review findings исправлены, ответы сохранены, threads resolved.

## Свежий Chromium и границы финальной коррекции

В отдельном Chromium 148.0.7778.96 проверены controlled large timed TXT **3 077 523 bytes** и ZIP **6 151 901 bytes** с plain TXT **3 073 492 bytes** и timed TXT. Извлечённые UTF-8/BOM inputs совпали byte-for-byte, CRC прошли. Native Space переключил выбор, Escape скрыл окно, floating control вернул его; скрытый ZIP завершился, terminal UI и offscreen/producers/reservations освободились. Реальный Coub MP4 **3 580 865 bytes**, H.264 880×720 / 300 кадров / 10 с и AAC 10,008 с прошёл полный строгий decode и проверку начала/конца. Screenshots **1280×800** и **360×800** просмотрены, меню и окно пакета доступны. Уже открытое меню после resize сохраняло прежние координаты; новое открытие соответствовало новому viewport. Это наблюдение сохранено отдельно.

Loaded `content_ui.js` SHA-256 `10f836525ab1ad0421b89bb7fcdab6e12325efa5e464ea60dc46ef48b5e8403c` совпал с checkpoint `6c84b8e`; этот native проход не переименован в проверку `1fce503`. Для последних изменений cue whitespace и длинных filename markers отдельный native Chromium edge rerun не выполнен: запуск средства проверки отклонён как `blocked by policy`, источник ограничения не указан. Это не приписывается Auto-review и не считается дефектом расширения. Коррекция покрыта 123 scoped regression tests, финальными 561 tests и security diff scan. Receipts - ignored `.local/qa/next031-final-chromium/` и `.local/qa/next031-final-chromium-G/`; свой Chromium-процесс остановлен, порт `9234` свободен.

## Подписанная поставка

Mozilla сохранила 0.3.1 как approved unlisted, matching source и reviewer notes проверены после сохранения. Signed XPI имеет 58 неизменённых application files, эквивалентный JSON manifest и пять файлов подписи. В отдельном headless Zen-профиле подписанное обновление 0.3.0 → 0.3.1 сохранило ID, UUID и настройки, подпись обязательна и принята, постоянная установка активна после полного restart. На ней завершён реальный Coub MP4, проверены дорожки/длительность/полный decode/крайние кадры и аудиосэмплы, cleanup и исчезновение terminal toast. [Точные файлы, hashes и receipt](SIGNING_VERIFICATION_031.md).

GitHub Release `v0.3.1` опубликован в существующем приватном репозитории. Точный runtime revision закреплён tag; шесть assets и release notes прочитаны из saved API state, имена/размеры/SHA-256 совпали. Магазин и смена приватности не выполнялись. Подписание и ручной Release не закрывают известные ограничения native playlist, квот и физического Save As Chromium из [предыдущего отчёта](PHASE4_VERIFICATION.md).

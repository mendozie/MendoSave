# Instagram - кандидат 0.4.0

Дата: 15-10-2026. Четыре замечания первого managed review [PR #10](https://github.com/mendozie/MendoSave/pull/10) исправлены; повторные автоматические и native проверки приведены ниже. Остаются focused managed review коррекций, CI и подготовка финальных пакетов. Исходный кандидат `8585160` сохранён как evidence и отозван после review. PR остаётся draft без merge. Опубликованный выпуск остаётся 0.3.3. Порядок дальнейшего выпуска определяет [AGENTS.md](../AGENTS.md).

## Объём

Открытая публикация или Reel, в том числе permalink с именем аккаунта. Фото, видео и смешанная карусель обрабатываются поэлементно с сохранением порядка; доступны выбранные файлы либо ZIP, авторское описание TXT, исходное аудио и MP3 из видео. TXT содержит описание публикации, а не распознанную речь.

Варианты с размерами, подтверждёнными metadata, показывают эти размеры. Если Instagram передал URL без размеров, интерфейс явно сообщает это; размер другого варианта или thumbnail не подставляется. Исходный файл автора не обещается. Video/audio codecs и MIME фактического результата проверяются; неизвестный или неполный результат не сохраняется как успешный.

До 64 выбранных итоговых файлов; файл/ZIP ограничены 1 GiB с действующим резервом упаковки. Несколько качеств одного элемента и оба аудиоварианта учитываются отдельно. Видео и исходное аудио по возможности копируются или muxed без перекодирования; MP3 преобразуется локально.

Официальный API Meta не используется. Адаптер из ISOLATED context получает свежий ограниченный по размеру HTTP-ответ канонической публикации, с `Accept: text/html`; резервный same-origin запрос к web endpoint `instagram.com/api/v1/media/.../info/` использует текущую сессию. Данные DOM страницы и её `postMessage` не служат источником metadata. Пароль, cookies и CSRF не экспортируются. Подписанные CDN-ссылки загружаются без cookies: это устраняет подтверждённый CORS `InvalidAllowCredentials`.

## Проверки после коррекций review

Все четыре замечания первого managed review исправлены. Удалён MAIN message bus; HTTP reader ограничивает поток ответа, проверяет точный canonical URL, source, timeout и отмену. Native anonymous проверка выявила необходимость `Accept: text/html`: без него Instagram возвращал routing metadata без содержимого карусели. С заголовком один HTML-ответ даёт все четыре элемента без API fallback.

MP4 проверяется существующим bundled Mediabunny: реальные размеры с учётом rotation, metadata и actual packets, непустые дорожки, длительность и физические диапазоны каждого sample внутри одного `mdat`. Небольшая документированная vendor projection предоставляет неизменяемые offsets/sizes; новый parser/index не добавлен. Потеря целых последних fragments отклоняется с абсолютным допуском 0,25 с. Отмена прекращает ожидание parser и освобождает Input один раз. Это проверка структуры и доступности samples; полное декодирование codecs выполнялось отдельно над конечными проверочными файлами.

Recovery index вмещает 320 записей, то есть пять полных пакетов по 64 результата. Перед подготовкой ZIP резервирует места для всего плана в общей сериализованной очереди. Проверены параллельное одиночное сохранение, отмена во время admission, частичный пакет, ошибка finish/save и освобождение reservation. Прежние готовые входы не удаляются для приёма нового пакета.

Автоматические проверки текущих коррекций: **1000/1000 tests**, ESLint 0 errors / 17 прежних warnings; обе сборки по 66 файлов и build checks прошли. Web-ext: 0 errors / 0 notices / 4 рассмотренных warnings. Новое предупреждение относится к единственному постоянному `runtime.getURL` для bundled module; точные location и bytes закреплены gate, [разбор](DEPENDENCIES.md). Provenance, licenses, lockfiles и свежий audit прошли: runtime 0 entries, tooling 3 записи рассмотренной цепочки node-forge.

Совокупный внутренний review и focused correction review завершены без оставшихся подтверждённых findings. В последнем выполнены 72 tests и независимые probes с двумя `mdat`, промежуточным `free` и extended-size header; исходные ложные успехи `stco→0` и `600→595 с` теперь дают отказ. Четыре vendor transforms обратимы до pinned originals и повторно дают точные shipped bytes. SHA-256 проверенного media module: `69053814a2785963aa88b34c7530bea9076d5587ad7f50e95ec802eda6c0b2a1`; parser bundle: `01c2aed114c87822d1024067912b4853583184dc39c8531370929c46ebaec9f5`.

Повторный native проход выполнен над исправленной сборкой в прежних отдельных muted profiles. Пользовательский вход сохранён; cookies и пароли между профилями не переносились. В Zen оба установленных XPI сверены по всем 66 entries с текущим build. В Edge source/dist hashes проверены для 11 затронутых assets; загрузка bundled Mediabunny дала HTTP 200, MAIN globals отсутствуют.

| Сценарий после коррекций | Zen | Edge / Chromium build |
|---|---|---|
| Reel `DecDOjeM5K8`, auth и anonymous | DASH и progressive MP4, M4A и MP3 завершены | Те же четыре результата завершены |
| Карусель `DTVqKjZDCf5`, auth и anonymous | Четыре элемента + TXT: files 5/5 и ZIP 5/5 | Те же files/ZIP 5/5 |
| Конечные файлы | 10 новых outputs/profile: 6 полных media decode, 2 image decode, UTF-8 TXT и ZIP CRC; ZIP exact новым отдельным файлам | 10 outputs/profile, полный decode, CRC и exact ZIP bytes; исходные AAC packets совпали с дорожкой DASH |
| Отмена и повтор | Native отмена во время «Проверка дорожек MP4», нет partial download, controls восстановлены, MP3 повтор завершён | Прежний native cancel сохранён; новые abort/parser/reservation cases покрыты regression tests |
| Пакет 64 и recovery | Regression tests полного processor/background пути | Controlled fixture в реальном ISOLATED/OPFS: 2 отмены по 64, повторный ZIP с 64 exact entries, затем 320 сохранённых inputs; следующий пакет отклонён до prepare, прежние bytes/index неизменны, transfer/archive temporaries пусты |
| UI/keyboard | Пакет 1246×983 / 306×883: скриншоты просмотрены, bounds/Space/Escape/Hide/resume/Back пройдены | 1440×1000 / 360×800, screenshots и keyboard; dialog scroll без горизонтального overflow |
| SPA | Auth trusted переход из профиля сохранил `performance.timeOrigin`; Back убрал UI. Anonymous profile click получил login wall Instagram до перехода | Регрессионные tests; отдельный native SPA не заявляется |

64-file fixture проверяет пакетный протокол, хранение и ZIP; это не выгрузка 64 настоящих Instagram videos. Частные публикации не проверены: пользователь разрешил пропуск при отсутствии контрольного материала. Отдельный permalink с одним фото также не проверен; реальные фото проверены внутри карусели, single-photo shape покрыт tests. Эти ограничения не скрываются за passing tests.

Локальные post-review доказательства: `zen-*/post-review-public.json`, `post-review-validated-files.json`, `post-review-controls-*.json`, `post-review-zen-installed-bytes.json`; `chromium-anon-post-review/` содержит public/ZIP/audio/recovery64 reports и screenshots. Подписанные URL и профили остаются в ignored области, в Git и source archive не включаются.

## Исходные проверки до коррекций review

Исходный commit `8585160`: **962/962 tests**, ESLint 0 errors / 17 прежних warnings, обе сборки по 66 файлов, manifests/CSP/inventory, web-ext 0 errors / 0 notices / 3 известных vendor warnings. Проверены provenance, licenses и exact lockfiles. Audit: runtime 0 entries; tooling 3 entries существующей рассмотренной цепочки node-forge. Новых runtime dependencies нет. Эти результаты не подтверждают последующие коррекции.

- Источник: API/GraphQL shapes, source/URL/size validation, полная карусель, поздние ответы и отмена; проверены отдельными regression tests.
- Пакет: host/UI предел 64/65, сохранение выбора, отмена внешним signal и исходное аудио без lossy fallback; проверены regression tests.
- Source/media/UI прошли совокупный внутренний code review; подтверждённые замечания исправлены и проверены отдельно. После native-проверок исправлены CORS credentials, Gecko foreign buffers/reader cleanup и неизвестный `hasAudio` у авторизованной карусели. Отмена имеет приоритет над ошибкой foreign Promise только при действительно отменённом signal; обычная ошибка остаётся видимой.
- Native browsers: Zen 1.23.2b / Gecko 157.0.1 и Edge 155.0.4283.45, Windows. В обоих есть отдельные auth и anonymous profiles; пользователь выполнил вход обычным способом. Воспроизведение muted, звуковые дорожки файлов сохранены. Browser Use использован для предварительного чтения настоящих shapes; установленное расширение проверялось отдельно.

| Сценарий | Zen | Edge / Chromium build |
|---|---|---|
| Reel `DecDOjeM5K8`, auth и anonymous | MP4, исходный M4A, MP3 и TXT завершены; anonymous progressive MP4 проверен дополнительно | MP4, исходный M4A и MP3 завершены в обоих режимах |
| Карусель `DTVqKjZDCf5`, auth и anonymous | Все четыре элемента и TXT: отдельные файлы и ZIP, 5/5; CRC и exact bytes | Auth: все четыре элемента и TXT, файлы/ZIP 5/5; anonymous: фото+TXT отдельно/очередь/ZIP |
| Отмена и повтор | Три итоговых native trials: fetch 53%, fetch 100%, запуск кодировщика 2%; отмена, 0 partial downloads, повторный MP3 завершён | Throttled photo cancelled, controls восстановлены, поздних downloads нет |
| UI и keyboard | Меню: 1246×983 / 306×883; пакет: 1230×975 / 306×875. Скриншоты просмотрены, Escape/Enter/Space, Hide/resume/Back проверены | 1440×1000 / 360×800, скриншоты просмотрены, keyboard/Hide/resume/Back проверены |
| SPA | Trusted переход из профиля в публикацию сохранил `performance.timeOrigin`; Back убрал прежние controls | Unit regressions; отдельный native SPA не заявляется |

Headful Edge потребовал CDP focus emulation из-за Windows occlusion; события trusted, физический OS focus не проверяется этим результатом. Для Zen временная установка активна при включённой обязательной проверке подписей. Все собственные тестовые browsers/driver processes остановлены с проверкой принадлежности; профили и evidence сохранены.

Конечный Reel: H.264 720×1280, видео 11,133333 с, AAC stereo 44,1 kHz; MP4 11,258821 с. M4A 11,144127 с, MP3 11,284898 с. В Edge исходный M4A и MP4 имеют одинаковые AAC packets, что подтверждает отсутствие перекодирования. Фото карусели - JPEG 864×1100 и 1440×1833; silent H.264 MP4 720×918 - 8,6 и 9,833333 с. Полный decode, начальные/конечные кадры и ненулевые аудиосэмплы по краям проверены. TXT карусели 2454 bytes; Zen сравнил оба TXT с описанием в странице побайтно в UTF-8. ZIP извлечён и сравнен с отдельными файлами; авторизованные имена содержат подтверждённые размеры фото, anonymous имена их не выдумывают.

Закрытая публикация **не проверена**, подходящий контрольный материал не выбран; пользователь разрешил этот пропуск. Отдельный single-photo permalink не проверен: реальные фото проверены в карусели, single-photo shape покрыт regression tests. В native проверены H.264/AAC и JPEG; другие поддержанные codecs/image formats имеют автоматические проверки, live-совместимость не заявляется. Предел 64/65 проверен автоматически; native пакет на 64 файла, заполнение квоты и новый проход верхней границы ZIP не выполнялись. Физический Save As chooser в этом срезе не повторялся; общий путь и его отказ/отмена покрыты существующими regression tests. CAPTCHA, login wall и rate limits не обходятся.

Локальные доказательства находятся в ignored `.local/qa/instagram-15-10-2026/`: `zen-*/validated-files.json`, `zip-validation.json`, `controls-*.json`, screenshots, итоговый TAP; `chromium-anon-summary.json` и auth/anonymous file/ZIP reports. Cookies, профили, подписанные медиассылки и пользовательские выгрузки не входят в Git или пакеты исходников.

## Исходные пакеты, отозванные после review

Исходный runtime/source commit: `85851602719aeb7bd343a850d0c917c498dff074`. Эти пакеты сохранены как evidence и отозваны до исправления замечаний. Их `release-manifest.json` подтверждает чистый исходный checkout и `signed: false`; entries, CRC и исходные Git bytes сверены. Финальные пакеты будут пересобраны из проверенного исправленного commit.

| Файл | Bytes | SHA-256 |
|---|---:|---|
| `mendosave-0.4.0-firefox-unsigned.xpi` | 34517468 | `1b9fa87c6eb5760a400f755a84d4204bddc74f5d4e796df7d584804de1f31039` |
| `mendosave-0.4.0-chromium-unsigned.zip` | 34518451 | `311883d2371f31b05ef365cc20390f677f10dfb561fcdb61aef7ea7860a40be0` |
| `mendosave-0.4.0-source.zip` | 36202115 | `265a30ac49ca109f293cf18d423066c5e27dfd7edd4c5d51a7e870145ec595c2` |

[CI Windows/Linux](https://github.com/mendozie/MendoSave/actions/runs/38759359826) прошёл вместе с archive reproducibility. Все локальные archives и receipt совпали с Linux CI по `SHA256SUMS`; [повтор PR CI](https://github.com/mendozie/MendoSave/actions/runs/38759692984) также прошёл. Outgoing scanner: 176 текущих text blobs и 520 исторических text blobs, 0 findings; рассмотренные fixtures и неизменённый vendor build path учитываются отдельно.

## Порядок ручной установки после передачи исправленного кандидата

Используй отдельный профиль, сохрани существующую установленную 0.3.3. До завершения коррекций новый кандидат не передан.

1. Zen: в отдельном профиле открой `about:debugging#/runtime/this-firefox`, нажми «Загрузить временное дополнение» и выбери unsigned XPI кандидата. Проверка подписей не отключается; временная установка прекращается после перезапуска браузера.
2. Chromium/Edge: распакуй ZIP в постоянную папку, открой страницу расширений, включи режим разработчика и выбери «Загрузить распакованное расширение».
3. Открой публикацию Instagram, при необходимости войди обычным способом на сайте. Нажми MendoSave внизу страницы, выбери файл или «Выбрать несколько…» для пакета.
4. Проверь видео со звуком, фото, нужные элементы карусели, TXT и оба аудиоварианта. Отдельно попробуй отмену, повторный запуск и Save As. Сохрани сообщение ошибки и описание сценария, если результат отличается от выбранного.

Stories, Direct, live и массовая выгрузка профиля не входят в этот срез. CAPTCHA и ограничения доступа не обходятся. DASH поддерживается для static MP4 с прямыми BaseURL без отдельных initialization URL; остальные структуры дают явный отказ. Web-интерфейс Instagram может измениться и потребовать обновления адаптера.

## Источники методов

Изучены [Instagram-Downloader (MIT)](https://github.com/hoaianle/Instagram-Downloader), [Instaloader](https://github.com/instaloader/instaloader), [yt-dlp Instagram extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/instagram.py) и [gallery-dl](https://codeberg.org/mikf/gallery-dl). Адаптер использует существующие локальные библиотеки MendoSave, без новых runtime dependencies. Для проверки физических диапазонов MP4 samples выполнена небольшая документированная коррекция pinned Mediabunny; лицензии, provenance и полные затронутые MPL source files сохраняются.

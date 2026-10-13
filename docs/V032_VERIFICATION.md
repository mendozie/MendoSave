# MendoSave 0.3.2 - локальный кандидат для проверки

Актуализировано: 13-10-2026. Base: `5fea4facdd383444bb0692283393edf35b5f7859`, branch `fix/032-source-and-package-ux`. Реализация, автоматические проверки, совокупный review и доступные native сценарии завершены. Кандидат предназначен для ручной приёмки; ограничения перечислены ниже. Локальные архивы формируются из чистого commit; его точный revision, `dirty=false`, inventories и hashes записаны в `artifacts/mendosave-0.3.2/release-manifest.json`. Опубликованная подписанная версия остаётся 0.3.1. GitHub/Mozilla publication и signing этого среза не выполнялись и требуют нового прямого разрешения после проверки.

Точка предыдущей остановки - ignored `.local/qa/candidate-032-12-10-2026/SAFE_STOP.md`; копии WIP, patch, inventories и SHA-256 находятся в `safe-stop/` этого каталога. Перед возобновлением совпали все 38 файлов. Новые receipts находятся в `.local/qa/candidate-032-13-10-2026/`. Старые профили и файлы проверок сохранены.

## Изменения и проверки

SRT, plain TXT и timed TXT связываются с immutable `{videoId, lang, trackId, revision}` и request ID. Hook проверяет каждый fallback и final response URL; UI проверяет ответ и текущий источник перед передачей файла. Actual player snapshot отдельно доказывает владельца title/media, а отсутствие полного caption response не запрещает известное текущее AV.

Modern transcript принимается только при доказанном владельце и языке: допустим проверенный native default track без противоречащего CC selection. Chapter-only section не создаёт вымышленных cues. Захваченная длительность ограничивает SRT/VTT end; некорректные времена отклоняются. Неподтверждённый язык или источник дают явный отказ.

VK legacy/CP1251 и BFF разделены по реальному ответу embed. Modern путь использует собственный скрытый iframe и bundled MAIN observer штатного `video.getEmbed`; расширение не создаёт API auth request. MAIN передаёт только ограниченную projection. Isolated parent проверяет frame/origin/request/source/schema и текущую страницу. Bridge не читает `parent.location`: нативная проверка подтвердила `SecurityError` между VK watch/embed. Права и CSP не расширены.

Back обновляет одиночное меню и фокус; во время run/cancel cleanup он отключён. Hide/Escape продолжают пакет. Повторный idle вход обновляет plan и сохраняет только совместимые позиции. Семантические ID вариантов устойчивы к перестановке qualities и reused TikTok rail. Общие подписи и группы различают SRT, plain TXT и TXT с таймкодами/реальными главами.

Тесты воспроизвели source/track/revision races, A → B → A, чужие redirects/replies, timeout/cancel/retry, поздние menu/queue callbacks, live Back без записи, source change во время async Back, изменение codec/quality plan и ошибочные интервалы. Совокупный review включал новые runtime assets и негативные сценарии; найденные title/media ownership и VK opaque-parent findings исправлены с независимым readback. Независимый correction review ready-panel patch завершён: 13/13, новых подтверждённых findings нет.

Отдельный дефект точности SRT воспроизведён через single-menu action в DOM/runtime harness: вход `1.2 → 3.36` давал `1.199 → 3.359`. Общий formatter теперь округляет время один раз до целых миллисекунд, затем вычисляет часы, минуты и секунды. RED 0/1 → GREEN 1/1; package/SRT/VTT и clock boundaries 5/5; nearby 140/140. Native Edge подтвердил исправленные миллисекунды шести cues. Source ownership и plain/timed TXT этой коррекцией не менялись.

В Twitch найдено бесконечное ожидание metadata доступного клипа. После reload тот же клип открыл четыре качества ещё до правки, поэтому причина первоначального network stall не установлена. Исправлен доказанный недостаток deadline: весь metadata read Clip/VOD, включая JSON и master playlist body, ограничен 30 секундами; запрос отменяется, кнопка допускает ручной повтор. Поздние результаты и ошибки не публикуются на другом источнике. RED 0/1 → GREEN 1/1; independent checks 11/11 и Twitch regressions 43/43. Отдельный RED/GREEN подтвердил и исправил попадание явно объявленного `audio_only` в группу «Видео»: теперь этот вариант находится в «Аудио». Download pipeline и output formats не менялись.

Последний прогон финального runtime от 13-10-2026: **824/824 tests**, без failures/skips/cancel; ESLint 0 errors / 17 warnings. Обе сборки по 60 файлов, build validation, dependency provenance/license/lockfile checks и outgoing check прошли. Свежий audit: 0 runtime entries и 3 ранее рассмотренных tooling entries цепочки `node-forge`. `web-ext`: 0 errors / 0 notices / 3 рассмотренных vendor warnings. Полный security scan нового кода не выполнялся; он остаётся условием будущего публичного выпуска.

Локальные доказательства сохранены в ignored `.local/qa/candidate-032-12-10-2026/` и `.local/qa/candidate-032-13-10-2026/`: `pipeline/`, `review/`, `subtitles/`, `ux/`, `vk/`, `native-zen/`, `native-edge/` и media validation. Старый audit, неправильные контрольные файлы, checkpoint и пакеты 0.3.1 сохранены. Итоговые receipts связывают проверки с фактическими source hashes; старые helper failures не подменяют положительные результаты.

## Нативный срез

Проверки выполнены на Windows в собственных headless profiles. Рабочие профили и подпись Zen не менялись. Zen 1.23.2b / Gecko 157.0.1: временная активная установка 0.3.2, ID `mendosave@mendozie`, `signatureRequired=true`, `signedState=0`. Дополнительная среда - Edge 155.0.4283.45 из Chromium-сборки. Проверенные runtime assets установок совпали с соответствующим `dist` по SHA-256. После последней Twitch correction Zen пересобран, переустановлен и проверен заново; YouTube assets этой правкой не менялись. Обе собственные native-среды остановлены с проверкой PID/ports; профили и необходимые результаты сохранены.

| Сценарий | Подтверждённый результат |
|---|---|
| YouTube `jNQXAC9IVRw`, EN | Все три одиночных экспорта сохранены: SRT 330 bytes/3 cues, plain TXT 220 bytes, timed TXT 332 bytes с реальными главами. SRT end 19,013 с при source duration 19,013042 с. Три ZIP entry совпали с отдельными файлами. |
| Native Shift+N во время SRT/plain/timed TXT | Все три свежих сценария: URL действительно сменился при pending request, `timeOrigin` не изменился; явный stale-source отказ, нового файла нет. |
| YouTube/Coub package UI в Zen | Enter/Space, Back и фокус на новом opener, compatible selection, Hide/Escape и resume; actual viewports 1246×883 и 326×843 проверены скриншотами. |
| Coub `or1i6abuay` в Zen | Отмена/cleanup и повтор, ZIP при скрытом окне и другой активной вкладке, отдельные файлы и single AV. ZIP input/output bytes совпали с отдельными сохранениями. AV 880×720, 10,008005 с; MP3 43,782993 с. Полное строгое декодирование и начало/конец проверены. |
| VK `-217878975_456240430` в Zen | Modern native path открыл 8 progressive qualities и 2 audio variants; Back/focus и сохранение выбора прошли. MAIN observer действительно загрузился в embed frame. Полный 91-минутный файл в этом проходе не скачивался. |
| VK `-210469567_456242958` в Zen | Реальный single 1080p MP4: 4093725 bytes, H.264 1920×1080/AAC stereo, 43,070 с; completed download, полное строгое декодирование и начало/конец проверены. Menu hint 0:43 совпал; native playback показал 44,001814 с. Эта разница сохранена как ограничение сравнения длительности, без вывода об обрезанном файле. |
| Coub в Edge | Single AV/muted/MP3, три отдельных файла и ZIP прошли; CRC и bytes ZIP совпали с подготовленными blobs и отдельными файлами. Строгое декодирование и начало/конец проверены. Back/focus/selection, Enter/Space, cancel/retry, Hide/другая вкладка/Escape проверены; скриншоты 1280×800 и 360×800 просмотрены. |
| Popup/settings в Edge | Статус 0.3.2, сохранение и повторное чтение Save As, codec и Twitch hotkey settings проверены. Диагностический TXT завершился после слишком короткого ожидания helper; прежний timeout сохранён. |
| Popup/settings в Zen | Native Space, сохранение и восстановление Save As/quality locks/quality selection, повторное чтение в новом документе прошли. Текст 0.3.2 и controls проверены на скриншотах 1246×883 и 326×843. Это `popup.html` в собственной вкладке, а не физический toolbar popup. |
| YouTube media в Zen | Шесть single/package файлов прошли strict full decode, tracks, timestamps, audio RMS и просмотр начала/конца/обложек; три пары побайтно равны. H.264/AAC 320×240 MP4 - 18,947007 с, AAC M4A с cover - 19,017143 с, VBR MP3 с cover - 19,013016 с при source 19,013042 с. MP4 отличается на −66,035 мс; причина по этой проверке не устанавливается, точное равенство длительности не заявляется. |
| YouTube в свежем Edge | SRT 441 bytes/6 cues с точными миллисекундами, plain TXT 220 bytes, timed TXT 347 bytes; ZIP 1508 bytes/3 entries. Browser completion/exists/totalBytes и фактические bytes проверены; CRC и SHA-256 всех ZIP entries совпали с отдельными файлами. Source/request/response закреплены за теми же `jNQXAC9IVRw`, EN, `.en`, revision 0. |
| Rutube VOD/Shorts в Zen | Menu Home/End/Arrow/wrap/Escape, Enter/Space package, Back/fresh focus и совместимый выбор прошли. Реальная Shorts SPA A → B сохранила `timeOrigin`; Back открыл текущий B и очистил выбор A. Picker screenshots 1280×800 и 360×800 просмотрены. Source Space и narrow source menu Shorts остаются отдельными gaps. |
| Twitch clip в итоговом Zen | `CloudySarcasticSashimiTwitchRPG` открыл 1080p/720p/480p/360p. Home/End/Arrow/wrap/Escape, Enter/Space package, Back с новым opener и сохранение выбора прошли после reinstall финального runtime. Source menus и picker 1280×800 / 360×800 просмотрены. Принудительное зависание native сети не создавалось; deadline/cancel/retry проверены автоматическими public-boundary tests. |
| Twitch VOD в итоговом Zen | Фактический AWS source `2894450759`: Back/fresh focus, Enter/Space package и выбор прошли после reload финальной сборки. `audio_only` виден в «Аудио» отдельно от пяти video qualities; широкие и узкие меню/пакет просмотрены. Полный 59-минутный VOD этим проходом не скачивался. |
| TikTok, Twitch live, Звук | TikTok signup закрыл доступ к rail; ввод данных и обход auth не выполнялись. Live показал mature-content gate, запись не включалась; native VOD → live Back не проверен. Звук открыл меню через native Enter и закрыл Escape; source Space не открыл меню, причина не установлена, mobile opener отсутствовал. Shared package navigation к этому одиночному адаптеру не применялась. Эти пути не объявлены успешными. |

Специфический ready legacy DOM reuse подтверждён сохранённой нативной формой панели от 12-10-2026 и 13 regression cases. Сегодня настоящий Show transcript открыл modern panel с тремя segments, legacy panel отсутствовал, а legacy request endpoint сохранился. Подмены metadata не было; свежая тройная выгрузка не объявляется нативным повторением прежней ошибки исчезнувшего endpoint. Реальные версии transcript различаются между браузерами; ZIP сравнивается с отдельными файлами своей версии.

Ранние ошибки QA helpers сохранены отдельно: premature final filename до завершения записи, чтение popup до hydration настроек, отсутствие execution context после reload и доставка клавиши без focus. Конечные положительные результаты используют проверенные readiness/focus и finished-download conditions. Исправление этих helpers не объявляется исправлением продукта.

Начальная попытка Yandex 26.8.5.811 / Chromium 150.0.7871.811 не загрузила расширение штатными CLI flags; CDP attach/evaluation страницы `chrome://extensions/` вернул `-32000 Forbidden`. Это ограничение конкретного внутреннего DevTools route. Оно не обходилось; установленная Chromium-сборка проверяется в отдельном Edge. Установка кандидата через Yandex UI отдельно не подтверждена.

Проверка расширения в авторизованной VK-сессии и полный auth download остаются для ручного прохода. Отдельно подтверждены нативный hidden-frame request и schema validation реального authenticated metadata ответа. Cookies/профили не копировались, новая авторизация не выполнялась. Физический Save As chooser и toolbar popup не покрываются headless проверкой; popup.html и persistence проверяются отдельно от них. Этот срез не устанавливает совместимость всех ОС, браузеров, площадок и qualities.

## Ручная установка кандидата

Поставка находится в `artifacts/mendosave-0.3.2/`. XPI и Chromium ZIP содержат проверенные build inventories; source ZIP соответствует чистому локальному commit. При упаковке проверяются CRC и побайтное совпадение извлечённых entries с исходными файлами. Служебные временные XPI из `.local/` сохраняются как доказательства проведённых установок; для ручной проверки используй архивы ниже.

Состав локальной поставки:

- `mendosave-0.3.2-firefox-unsigned.xpi` - временная тестовая установка Firefox/Zen.
- `mendosave-0.3.2-chromium-unsigned.zip` - распаковываемая developer-сборка.
- `mendosave-0.3.2-source.zip` - matching source.
- `release-manifest.json` и `SHA256SUMS` - revision, inventories, размеры и hashes.

Сверь SHA-256 нужного файла с `SHA256SUMS`, например из корня проекта:

```powershell
Get-FileHash -LiteralPath 'artifacts/mendosave-0.3.2/mendosave-0.3.2-firefox-unsigned.xpi' -Algorithm SHA256
```

В Zen создай отдельный тестовый профиль через `about:profiles` и запусти его. Открой `about:debugging` → This Firefox → Load Temporary Add-on и выбери unsigned XPI либо `dist/firefox/manifest.json`. После полного restart временная установка исчезнет. Постоянный рабочий signed 0.3.1 для этой проверки менять не нужно; signature checks сохраняются.

В отдельном Edge/Chromium-профиле распакуй ZIP в папку, которую сохранишь на время проверки. Открой `chrome://extensions`, включи developer mode и выбери «Загрузить распакованное расширение» → папку с `manifest.json`. После Reload расширения обнови страницу площадки; активные jobs перед этим заверши или отмени.

Проверь свои YouTube/VK материалы: правильные title/language/content, Back и выбор, одиночные файлы и ZIP, Hide/cancel/retry, сохранение настроек, реальный Save As и смену видео при pending subtitle request. Для ошибки достаточно назвать страницу, действие, выбранные варианты и фактический результат; локальный журнал можно выгрузить через popup. После ручной приёмки требуется отдельное решение о следующем шаге. Пока кандидат остаётся локальным и неподписанным.

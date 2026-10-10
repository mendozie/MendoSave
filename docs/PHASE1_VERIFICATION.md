# Фаза 1 - фактические проверки

Дата: 09-10-2026. Версия MendoSave: `0.1.0`. Статус: первый рабочий путь технически проверен; продукт и подписанный релиз ещё не готовы. Исходный аудит в [SOURCE_AUDIT.md](SOURCE_AUDIT.md) остаётся историческим документом.

## Исходник и среда

Перед импортом все 41 файла сохранённого upstream совпали с Git blob hashes из `.local/upstream/SOURCE.json`. База: Nova 1.9, commit `6a2bc6dc1234a3c4b0037885b08cad486abe1bac`. Рабочая копия находится в `extension/`, исходный README - в `docs/upstream/README.md`. Эталон не изменялся. Исходные build/CI scripts не запускались.

| Среда | Фактически использовано |
|---|---|
| Основная | Windows; Zen `1.23.1b`, Gecko `157.0.1`, BuildID `20261006042626`; отдельный профиль `.local/qa/zen-profile` |
| Контрольная | Chrome `148.0.7778.96`, Chromium; отдельный профиль `.local/qa/chromium-profile` |
| Автоматизация | GeckoDriver `0.37.1` / WebDriver и Chromium CDP; браузеры работали в headless mode |
| Разработка | Node.js `22.18.0`; `web-ext` `10.7.0`; `linkedom` `0.18.12`; Python `3.13.7` для внешней проверки файлов |
| Медиа QA | FFmpeg/ffprobe `9.0.2` из официального Gyan GitHub mirror; SHA-256 архива проверен по release asset digest |

Звук тестового Zen отключён через `media.volume_scale = "0.0"`; значение прочитано после проверок. Chromium запущен с `--mute-audio`. QA декодирует файлы без воспроизведения. Аудиодорожки в результатах сохранены. Рабочий профиль, расширения и настройки подписей пользователя не менялись. Бинарные инструменты QA не входят в продукт.

## Первый полный путь

Контрольный материал: [YouTube watch - Me at the zoo](https://www.youtube.com/watch?v=jNQXAC9IVRw), около 19 секунд. Выбор формата сделан через установленный UI; SABR, bridge, browser background и bundled processor работали в настоящих браузерах.

| Результат | Проверка конечного файла |
|---|---|
| Оригинальное видео 240p в Zen и Chromium | MP4, VP9 `320×240`, 15 fps, 284 декодированных кадра; AAC `44100 Hz`, stereo; контейнер `19.063583 s`, `603216 bytes` |
| Выбранное H.264/AAC | Zen: MP4 `2011992 bytes`, H.264 `320×240`, 284 кадра, AAC stereo, `18.947007 s`. Chromium: MP4 `1292060 bytes`, H.264 `320×240`, 284 кадра, AAC stereo, `19.063583 s` |
| MP3 | `247392 bytes`, MP3 VBR V0, `44100 Hz`, stereo, около 19 секунд; JPEG cover `480×360`. Файл одинаков в двух браузерах по SHA-256 |
| Английские SRT | UTF-8, `330 bytes`, три настоящие реплики с началами `1`, `7`, `16 s`; порядок и границы времени проверены, текст сопоставлен с transcript DOM |
| Прямой HTTPS download | [W3C sample MP4](https://media.w3.org/2010/05/bunny/trailer.mp4): `11053871 bytes`, H.264 `853×480`, 811 кадров, AAC; контейнер около 33 секунд; состояние `complete` и полный decode |

Все принятые видео и MP3 прошли полное декодирование. Для контрольного материала дополнительно проверены длительности дорожек, число кадров, разрешение и ненулевой PCM в первой и последней секунде. Кадры начала и конца оригинального видео извлечены и просмотрены. Готовый файл проверяется отдельно от download ID.

В оригинальном MP4 хеши elementary video/audio streams совпали между Zen и Chromium. Контейнеры отличаются 20 bytes временных полей; это не различие дорожек. SHA-256 MP3: `14f99911ecdb3945031a171ab7e4e2a43c58d8790a284bcb58a392f0bdd65e00`. Последний SRT end отличается на 8 ms из-за duration страницы: `19.013` и `19.021 s`; byte identity SRT не заявляется.

Во время QA исправлены три воспроизведённых дефекта: DOM fallback принимал главы видео за реплики; SABR игнорировал выбор перекодирования H.264; WebCodecs мог выдавать Opus при подписи H.264/AAC. Настройка теперь доходит до SABR job, исходный AAC сохраняется без обязательного encoder, а для другого исходного кодека нужен AAC encoder либо FFmpeg fallback. Старые неверные результаты сохранены локально как отрицательные evidence и не включены в принятые файлы. Предупреждения старого внешнего decoder 2018 года проверены актуальным FFmpeg 9.0.2; принятый H.264/AAC файл декодируется без ошибок.

## Processor и ошибки

В Zen host - собственная неактивная закреплённая вкладка `offscreen.html`. Concurrent ensure создаёт один host и ожидает готовность listener. В Chromium сохраняется offscreen document; recovery storage доступно через background, поскольку Chromium offscreen не предоставляет обычный storage API. Все библиотеки и workers поставляются локально; CSP страницы не ослаблялась.

| Сценарий | Наблюдаемый результат |
|---|---|
| Скрытая YouTube-вкладка, закрытый документ popup | Клавиатурный выбор 240p в H.264/AAC завершился готовым валидным файлом; visibility events подтверждают скрытие инициатора |
| Продолжительная WASM обработка | Синтетические tracks общей длиной 60 s и размером около 57.4 MB переданы processor; принудительный FFmpeg путь выдал MP4 `55771353 bytes`, H.264 `1280×720`, AAC, 1800 кадров, `60.01 s`. Полный decode успешен |
| Закрытие инициатора во время обработки | После закрытия его вкладки тот же минутный файл сохранён целиком; процессор освободился. От закрытия до результата около 27.5 s; это один сценарий, не benchmark |
| Abort выполняющегося FFmpeg | Ответ `cancelled: true`; выходной файл отсутствует. Следующее минутное задание успешно, полный decode проверен |
| Закрытие processor во время работы | Ответ на незавершённый finalize исчезает, успешный файл не создаётся. Новая ensure создаёт host; повторное минутное задание успешно. Автоматический resume не заявляется |
| Повреждённый вход | Заголовок из четырёх неверных bytes отклонён с текстом причины; медиафайл не создан, следующий job принят. Диагностический TXT хранится локально |
| OPFS recovery готового файла | Записаны шесть контрольных bytes, закрыт и открыт host, готовый файл сохранён; bytes совпали, index получил `savedAt` |
| Освобождение ресурсов | После jobs `jobsActive() === false`; в корне FFmpeg FS нет временных входов/выходов медиа. Workers завершаются в finally; Blob URL живёт до `downloads.complete` и затем освобождается |

Измеренная граница этого среза - 60 s / около 57.4 MB входа. Многогигабайтные файлы, длительные live streams, исчерпание реальных квот, полный browser restart и системное засыпание пока не проверены. OPFS recovery проверяет готовые bytes после перезапуска host; он не доказывает восстановление незавершённой обработки или устранение всех crash races.

## Автоматические и визуальные проверки

`npm.cmd test`: 23 passed, 0 failed. Проверяются исполняемый background/processor с контролируемыми внешними API, реальный DOM parser, меню и media plan. Покрыты принадлежность job/staging/download другой вкладке, ограничения URL и chunk/schema, сериализация host, recovery routes, завершение/прерывание сохранения, codec/downscale, исключение глав из субтитров и клавиатура. Watchdog и `FILE_NO_SPACE` проверяются с контролируемым engine/time/API, а не реальным заполнением диска. Реальные browser/file checks описаны выше и не заменены mocks.

В Zen просмотрены полные screenshots viewport `1246×983` и `326×843`: menu внутри viewport, узкая кнопка видна под плеером, подписи переносятся. Размер browser window отличается от viewport из-за sidebar Zen. Enter открывает меню и запускает video download, Tab переводит фокус, Escape закрывает и возвращает его к кнопке. Space выбирает H.264/AAC; значение и `aria-checked` прочитаны после изменения. Просмотрены popup document `1246×983`, processor page `1246×983` и Chromium watch `1280×800`. Нативный toolbar popup отдельно не автоматизирован; при проверках открывался и закрывался его HTML document в обычной вкладке.

`npm.cmd run build` создаёт Firefox/Chromium каталоги с 39/40 файлами. Повторная сборка сохраняет те же SHA-256 файлов. Локальные `web-ext build` ZIP проверены по составу и bytes против inventories; `LICENSE` и `THIRD_PARTY_NOTICES.md` присутствуют. Профили, QA files, npm dependencies, Musify и исходные CI/build scripts в поставку не входят.

`web-ext lint`: 0 errors, 0 notices, 2 warnings в неизменённом FFmpeg wrapper: `UNSAFE_VAR_ASSIGNMENT` (worker import) и `DANGEROUS_EVAL` (fallback получения global object). В используемых браузерах globalThis присутствует, а worker core URLs задаются локально. Предупреждения не скрыты и не объявляются исправленными; строгий lint не пройден. Перед выпуском нужны проверка source/build provenance ядра и security scan.

Применён `$code-review` к совокупному срезу от `8ebe2522dd4466000ecacd9f265d8c4d29b01b37` и изменениям относительно pinned upstream: browser host, MAIN/ISOLATED callers, codec choice, jobs, abort/watchdog, download lifecycle, recovery, упаковка и tests. Подтверждённые дефекты текущего пути исправлены и перепроверены. На момент фиксации открытых блокирующих findings для фазы 1 нет. Полный repository security scan и managed GitHub review не выполнялись.

## Evidence и продолжение

Приватные browser receipts и файлы сохранены в `.local/qa/`, вне Git:

- `final-zen-media.json`, `final-chromium-media.json`, `final-zen-h264.json`, `final-chromium-h264.json`, `elementary-parity.json` - параметры, хеши, полный decode и сравнение дорожек.
- `downloads/Me at the zoo [240p](1).mp4`, `downloads/Me at the zoo [240p](4).mp4`, `downloads/Me at the zoo(1).mp3`, `downloads/Me at the zoo [en](2).srt` - принятые Zen файлы; Chromium файлы находятся в `chromium-downloads/`.
- `long-processor-result.json`, `cancel-processor-result.json`, `after-cancel-processor-result.json`, `kill-processor-result.json`, `after-kill-processor-result.json`, `closed-owner-result.json`, `negative-processor-result.json`, `hidden-watch-result.json`, `recovery-before.json`, `recovery-after.json`, `processor-file-verification.json` - processor scenarios, совпадение четырёх минутных файлов и отсутствие выходов отменённого/прерванного job.
- `ui-qa.json`, `final-ui-state.json` и `zen-menu-1246x983.png`, `zen-menu-326x843.png`, `zen-popup-1246x983.png`, `zen-processor-1246x983.png`, `chromium-watch-1280x800.png` - UI и mute readback.
- `packages/`, `package-verification.json`, `build-reproducibility.json`, `final-package-install.json` - локальная упаковка, inventories и установка финального ZIP в тестовый Zen. ZIP не подписан; signature preference не имеет user override.

A-001/A-002 закрыты для контрольного материала. A-006/A-008/A-009 проверены только в перечисленных сценариях. A-003/A-004/A-005, матрица остальных адаптеров, полная очистка legacy оформления/диагностики, UX отмены, журналы без секретов, redirect policy и A-010 остаются в roadmap. Наличие исходного кода адаптера не доказывает поддержку.

Внешних writes, GitHub remote, подписания или публикации не было. Репозиторий остаётся локальным и приватным до релизной версии. Следующий срез - фаза 2; текущее поручение на фазу 1 не запускает её автоматически.

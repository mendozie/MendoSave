# MendoSave - остановка фазы 2

**Исторический snapshot.** Пользователь возобновил работу 10-10-2026. Harness и коррекция проверены; текущее состояние находится в [ROADMAP.md](ROADMAP.md), итоговое evidence - в [PHASE2_VERIFICATION.md](PHASE2_VERIFICATION.md). Ниже сохранено состояние остановки; оно не задаёт текущий запрет продолжения.

Дата: 10-10-2026, Europe/Moscow. Основание: прямое поручение пользователя остановиться и сохранить состояние до продолжения. Новые изменения кода, тесты и браузерные прогоны остановлены. Автоматическое продолжение не разрешено.

## Git и публикация

- Ветка: `feat/adapter-compatibility`, локальный и последний опубликованный HEAD `1f763286a60e6d90778c2e9109b66a5ff4e84f7d`.
- Base `main`: `8ebe2522dd4466000ecacd9f265d8c4d29b01b37`. История сохраняет фазу 1 `23e7b5c83cbf22b82b2312c0d2421b3a36cf40db`; переписывать её не нужно.
- [Репозиторий](https://github.com/mendozie/MendoSave) приватный; [PR #1](https://github.com/mendozie/MendoSave/pull/1) открыт. После остановки commit/push/merge, смена видимости и релиз не выполнялись.
- Изменения после опубликованного HEAD остаются unstaged/untracked в рабочем дереве. Они не признаны завершённым программным срезом. Единственный worktree - текущий проект; неизвестные файлы и ignored outputs сохранены.

## Проверенное и незавершённое

Первый срез включает импорт GPL upstream, собственное оформление, исправления адаптеров, диагностики и инструменты. Подробности - в [отчёте](PHASE2_VERIFICATION.md) и [матрице](SITE_MATRIX.md). До последнего WebM remux WIP полный набор дал 161/161 PASS, ESLint 0 errors / 14 warnings; проверены 27 медиафайлов и SRT. Это evidence предыдущего состояния, а не GREEN текущего исходника.

Первый managed review завершён для HEAD `1f763286a60e6d90778c2e9109b66a5ff4e84f7d`, review ID `5475105435`. Подтверждены оба findings:

1. `4234333820`: Twitch chunks в page-local памяти терялись при teardown. WIP постоянно передаёт их в OPFS, связывает Port с tab/frame/document/job и сохраняет полученный фрагмент один раз. До последнего remux реальные normal/reload/close прошли в Zen 1.23.2b, включая partial filename.
2. `4234333828`: произвольный 30-минутный timeout уничтожает output при pause/slow save. Deadline удалён; время на виртуальных часах и download lifetime/recovery проверены. Нельзя приписывать этим tests реальное 31-минутное ожидание.

Новая проверка Chromium normal/close дала download `complete/exists`, но выявила duplicate video timestamp и незавершённый однобайтовый EBML header. Оба исходных файла сохранены как отрицательное evidence. Локальные FFmpeg/Mediabunny probes показали завершение контейнера без изменения полных video/audio payloads или PCM; video duplicate сдвинут на 1 мс, audio timestamps сохранены.

В `extension/offscreen.js` добавлен WIP `remuxRawRecording`: pinned Mediabunny, BlobSource → packet copy → OPFS StreamTarget, проверки packets/выхода, source preservation при ошибке. `tests/live-recording.test.cjs` использует реальный vendor и собственный `tests/fixtures/raw-recording.webm` (3180 bytes, VP8/Opus, video timestamps `[0, 200, 200]`). Точечный duplicate test прошёл RED → GREEN; промежуточно suite дал 8/8 PASS.

**Последний targeted run: 8 PASS / 6 cancelled, exit 1.** Node завершает event loop до pending Promise из-за `unref` таймера в harness. Отрицательные/lifetime/recovery/stall tests не признаны пройденными. Не завершены полный GREEN, lint, собственный review последней helper, пересборка и браузерная проверка remux. `dist` и ранее созданные QA ZIP не соответствуют последнему WIP; не выдавать их за его результат.

## Сохранённое evidence

Все приватные артефакты остаются в `.local/`, вне Git:

- `.local/qa/phase2/tests-corrected.log`, `eslint-corrected.log` - последний полный GREEN до remux.
- `.local/qa/phase2/media-validation.json` - 27 положительных медиа; `frames/` - просмотренные первые/последние кадры.
- `.local/qa/phase2/live-lifecycle.json`, `live-download-readback.json` - Zen normal/reload/close до remux; ранние попытки также сохранены.
- `.local/qa/phase2/correction/chromium-twitch-live/` - два raw файла, browser receipts/screenshots, `timestamp-check.json`, packet-copy probes и `ffmpeg-remux/`.
- `.local/qa/phase2/managed-review-1.json`, `review-threads.json` - первый review и два пока unresolved threads. Повторный managed pass ещё не запрошен.
- `.local/qa/phase2/shutdown-chromium.json`, `shutdown-checkpoint.json` - остановка тестовых процессов. Профили и скачанные файлы сохранены; звук при проверках был выключен.
- `.local/checkpoints/` - snapshot остановки с Git metadata, binary diff, копиями WIP и SHA-256 manifest. Он не заменяет исходное рабочее дерево и не должен импортироваться поверх него без сравнения.

## Порядок продолжения

1. Дождаться нового поручения пользователя. Сверить текущую ветку/HEAD/dirty files с snapshot; не сбрасывать WIP и не повторять подготовку upstream или создание GitHub.
2. Прочитать изменения `offscreen.js` и live harness. Исправить жизненный цикл тестового таймера; выполнить текущие отрицательные/lifetime/recovery/stall tests. Проверить новый helper на cleanup, сохранение source, track/packet integrity и concurrency, включая соседний legacy YouTube live.
3. Запустить targeted processor/Twitch/live tests, полный `npm test` и ESLint. Только после GREEN пересобрать обе сборки и проверить manifests/inventories/CSP/vendor bytes.
4. Запустить отдельные сохранённые тестовые профили: Zen 1.23.2b и Chromium 148.0.7778.96. Сначала убедиться в глобальном mute, отсутствии активных jobs и актуальной сборке. Не вызывать старые `start` helpers, требующие новой пустой папки, поверх существующих профилей. WebDriver session ID и CDP targets после закрытия недействительны; не использовать старые handles.
5. Повторить настоящие Twitch normal/reload/close в Zen и normal/close в Chromium. Проверить ровно один файл на сценарий, complete/exists, actual bytes, tracks, duration, полное декодирование и начало/конец. Для VFR null decode сохранить source time base; source duplicate или incomplete container по-прежнему должны проваливать проверку. Отрицательные raw файлы не удалять и не смешивать с положительным итогом.
6. Обновить report/matrix/README/roadmap по фактическому результату. Проверить outgoing source/history и portable links; создать новые QA ZIP без перезаписи прежних. Применить `$code-review` к актуальному correction diff.
7. После проверки завершённого среза commit/push в существующую task branch, обновить тот же PR и readback. Разобрать два старых threads. Допускается один focused managed pass коррекции, поскольку изменяется сохранность данных; первый полный pass уже выполнен, третий по умолчанию не нужен. Проверить весь отчёт и финальный head/base.
8. Завершить обычный guarded merge commit в `main` с сохранением SHA фазы 1 и безопасной очисткой только merged task refs по `$git-conventions`. Приватность не менять. Фаза 3 начинается только по отдельному следующему поручению.

Полный security scan, подписанный XPI, магазин, публичный релиз и открытие репозитория остаются отложены. Ничего из этого не требуется для сохранения данной остановки.

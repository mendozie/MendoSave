# MendoSave - roadmap

Основание: [PROJECT_SPEC.md](PROJECT_SPEC.md).
Актуализировано: 11-10-2026.

`[ ]` - не начато; `[~]` - выполняется либо остаётся необходимая проверка; `[x]` - результат технически проверен. Пользовательская приёмка и публикация отмечаются отдельно. Дальние этапы уточняются перед выполнением по spec; они не расширяют разрешения автоматически.

## Текущее состояние

- Текущий результат: подписанная 0.3.1 и пакеты обоих движков для ручной установки через GitHub Release. Срез 0.3.1 добавляет неблокирующее окно, timed TXT и исправления отмены/progress/processor lifecycle; [проверки](V031_VERIFICATION.md) и [поставка](SIGNING_VERIFICATION_031.md) завершены. Фазы 1-3 сохраняют основу выбора места сохранения, очереди и ZIP; [PHASE3_VERIFICATION.md](PHASE3_VERIFICATION.md) и [PHASE2_CHECKPOINT.md](PHASE2_CHECKPOINT.md) остаются историческими evidence.
- Выполнено: собственное оформление и общий код двух сборок; отключён upstream updater. Все пути используют общий Save As, включая Page-Blob. Подготовленные ZIP-входы сохраняются для ручного восстановления; sender, вкладка, документ, job и текущий индекс проверяются. Старые durable keys и recovery directory сохранены. Проверенная совместимость находится в [SITE_MATRIX.md](SITE_MATRIX.md).
- Проверки фазы 3: 269/269 tests, ESLint 0 errors / 14 warnings; обе сборки и inventories, `web-ext` 0 errors / 3 vendor warnings. Внутренний совокупный review и focused review коррекций выполнены; подтверждённая утечка recovery bytes из первого managed review исправлена с regression checks. В Zen проверены настоящие Save As для MP4/MP3/SRT/ZIP и отмена. В обоих браузерах завершены три файла Coub, ZIP с byte comparison и диагностический ZIP 128 MiB; в Chromium проверены две вкладки и отмена после первого chunk. Подробности и частные receipts - в отчёте фазы 3; результаты старых WebM/live проверок остаются в [PHASE2_VERIFICATION.md](PHASE2_VERIFICATION.md).
- Пользовательская приёмка: подготовка и направление приняты 09-10-2026. Техническое закрытие фазы 2 не заменяет пользовательскую визуальную приёмку и релизную приёмку.
- GitHub: [mendozie/MendoSave](https://github.com/mendozie/MendoSave) остаётся приватным; owner, remote и `isPrivate: true` проверены через API. 11-10-2026 опубликован [Release 0.3.1](https://github.com/mendozie/MendoSave/releases/tag/v0.3.1) с signed unlisted XPI, Chromium ZIP, matching source и hashes. Магазины не используются; обновления ручные.
- Продолжение: фазы 1-3 интегрированы через [PR #1](https://github.com/mendozie/MendoSave/pull/1) и [PR #2](https://github.com/mendozie/MendoSave/pull/2), техническая подготовка фазы 4 - через [PR #3](https://github.com/mendozie/MendoSave/pull/3). Разрешённое 10-10-2026 подписание unlisted XPI выполнено; постоянная установка, сохранение после перезапуска Zen и контрольный MP3 проверены. Это заменяет прежний план последующего AMO listing. Репозиторий остаётся приватным. Подготовка и импорт upstream не повторяются.
- Результаты фазы 4: 295/295 tests, обе сборки, vendor provenance/licenses и свежий audit, RAM/staging/log guards и детерминированные архивы. Получен реальный TikTok-файл в двух браузерах, трёхминутный Twitch live в Zen, Chromium ZIP с payload 1 GiB минус 64 KiB. После полного restart Chromium три готовых recovery inputs сохранены и вручную выгружены; активный незавершённый job не продолжился и не выдал неполный файл. Исправлены SRT и MP4/AAC parser resource paths; свежие затронутые загрузки прошли в обоих браузерах. Standard security scan завершён с partial coverage и 0 открытых findings; совокупный внутренний review не выявил оставшихся существенных дефектов. CI на runtime commit `aaf370a1277209c8b8029d05c25ea4508635058c`: Windows/Linux verify и сравнение hashes архивов прошли, [run 38062095320](https://github.com/mendozie/MendoSave/actions/runs/38062095320). Подробности - [PHASE4_VERIFICATION.md](PHASE4_VERIFICATION.md) и [SECURITY_REVIEW.md](SECURITY_REVIEW.md).
- Границы: native YouTube playlist с двумя выбранными роликами дал HTTP 403 и зависший MSE fallback; отмена очистила queue state. Отдельная runtime-seeded очередь двух реальных роликов завершилась в Zen и Chromium и не подменяет проверку полного native picker пути. Верхний ZIP размер проверен в Chromium; Zen сохраняет измерение 128 MiB. Реальное заполнение квоты и физический chooser Chromium не проверены; native UI control недоступен в текущем инструменте. Downloads completion/cancel/recovery проверены. Подписание не закрывает остальные gaps или пользовательскую приёмку.

## Срез 0.3.1 - пользовательская проверка и исправления

Статус: `[x]`; текущий срез проверен, интегрирован и выпущен 11-10-2026 для ручной установки. Baseline - подписанная 0.3.0 и интегрированный PR #4. Выполнены скрытие окна, дополнительный timed TXT, повторный запуск после отмены, завершение progress UI и bounded диагностика прежнего 97%. [PR #5](https://github.com/mendozie/MendoSave/pull/5) merged; [Release 0.3.1](https://github.com/mendozie/MendoSave/releases/tag/v0.3.1) содержит пакеты обоих движков. Результаты и отрицательные сценарии - в [V031_VERIFICATION.md](V031_VERIFICATION.md); подписание и upgrade - в [SIGNING_VERIFICATION_031.md](SIGNING_VERIFICATION_031.md). Дополнительных действий пользователя для технического завершения этого среза не требуется.

- [x] Разделить видимость окна и состояние пакета: Hide/Escape, повторное открытие, доступность страницы, явная отмена, видимое завершение/ошибка скрытого пакета.
- [x] После окончательной отмены восстановить выбор и применимые кнопки в том же окне; исключить наложение запусков, старые updates и позднее сохранение. Завершать progress panel и его timers/listeners.
- [x] Исправить ложное обещание reload/retry пакета. Ограниченно проверить сообщённый 480p: лабораторный полный файл не получен, duration guard отверг короткий SABR output; причина прежнего 97% не установлена. Исправлены потеря Cancel при capture fallback и подмена исходной Worker ошибки. Пользовательское завершение 480p+SRT сохранено как отдельное наблюдение.
- [x] Добавить отдельный TXT с реальными таймкодами и доступными главами; сохранить plain TXT/SRT, показать пример, уточнить пакетные подписи. Настоящие complete files в Zen/Chromium: 47 cues и 9 глав, exact payload и native source comparison.
- [x] Исправить подтверждённый Worker lifecycle finding с regression terminate/SPA/live reuse; провести paired same-quality замер startup/passive playback. Выполнены 10 baseline pairs 0.3.0; ускорение 0.3.1 не установлено. Cleanup неизвестных файлов не выполнялся.
- [x] Убрать видимую служебную вкладку в Zen через невидимый background iframe. Реальные OPFS/Worker/queue/downloads и idle disposal проверены; readiness/recovery/SaveAs/parallel/live и async close race имеют meaningful regressions. Fallback во вкладку закрывает только собственный processor tab; реальный forced fallback не заявляется проверенным. Новых разрешений нет.
- [x] Проверить реальные сценарии нескольких доступных адаптеров, отдельные файлы/ZIP, отмену/повторный запуск/скрытие/переключение вкладок и terminal cleanup. Coub, Rutube, Twitch VOD/live, TikTok и YouTube проверены; ограничения записаны. VK/Звук повторно не проверялись.
- [x] TDD/regression, обе сборки, конечные files/ZIP bytes, wide/narrow UI/keyboard и совокупный внутренний code review завершены; итоговый runtime `1fce503` прошёл 561 tests и [Windows/Linux CI/reproducibility](https://github.com/mendozie/MendoSave/actions/runs/38128782490). Большой TXT и ZIP проверены в native Zen/Chromium на controlled fixture. Managed review выполнен в двух проходах; findings исправлены и threads resolved. Финальные guards и cue/filename correction прошли локальный review, regression checks и отдельные запечатанные [security diffs](SECURITY_REVIEW_031.md). Native Chromium checkpoint `6c84b8e` записан отдельно; latest cue/filename edge rerun после отказа инструмента не заявляется выполненным.
- [x] Выпустить 0.3.1 с ID `mendosave@mendozie`, matching source/reviewer notes через private PR/review/merge, Mozilla unlisted и GitHub Release. Saved source совпал по SHA-256; подпись принята, permanent upgrade сохранил настройки и UUID после полного restart Zen. На signed сборке проверен завершённый MP4 и cleanup. Шесть Release assets прочитаны из saved state и совпали по именам/размерам/hashes; репозиторий приватный. Магазин и смена видимости не запрошены.

Наблюдения пользователя: одиночный 480p и пакет 480p+SRT сейчас «вроде всё ок», SRT также; при переключении вкладки файл скачался. Первым проверенным роликом был WiDLJlGI5d0, его особенность не установлена. Старый stall не повторился. Локальные скриншоты отмены и независимый аудит сохраняются в ignored `.local/qa/`; они не включаются в Git.

## Фаза 0 - подготовка

Статус: `[x]`; подготовка технически проверена и сохранена в локальном Git.

Результат: самостоятельный локальный проект с согласованными требованиями, источником, evidence и понятным продолжением.

- [x] Закрепить название, платформу, пакетные режимы, публичную цель и контекст.
- [x] Сохранить исходник и его происхождение; составить исходный аудит.
- [x] Записать spec, roadmap, инструкции и README.
- [x] Проверить непротиворечивость, относительные ссылки, отсутствие template markers и приватных путей в отслеживаемых документах.
- [x] Сверить копию всех файлов upstream и исключение `.local/` из Git.
- [x] Создать и прочитать начальный локальный commit с идентичностью mendozie.

Приёмка: подтверждение preview уже получено. По завершении проверок дополнительных согласований документов подготовки не требуется.

Фаза 1 запущена последующим поручением в MendoSave. Подготовку проекта при продолжении повторять не нужно.

## Фаза 1 - первый рабочий путь в Zen

Статус: `[x]`; технический результат проверен 09-10-2026. Запрет внешнего сохранения кода действовал при выполнении фазы 1; последующее поручение разрешило приватный GitHub и PR для совокупного среза фаз 1 и 2.

Результат: загрузка контролируемого видео/аудио/субтитров в Zen с работающим browser-specific host медиапроцессора, без заявления о готовности всех площадок.

- [x] Импортировать проверенную исходную базу в рабочее дерево с сохранёнными лицензиями. Legacy build/CI не запускались; updater отключён.
- [x] Получить Chromium baseline и полный путь для YouTube watch: UI → metadata/media → processor → конечный файл.
- [x] Подготовить Firefox manifest и browser adapter; проверить MAIN/ISOLATED bridge, WASM workers, OPFS, Blob URLs и завершение downloads.
- [x] Проверить независимость от документа popup, скрытый и закрытый инициатор, минутный WASM job, abort и повторный запуск после закрытия host; выбрать закреплённую вкладку расширения для Zen.
- [x] Внести контрактные исправления с regression checks, проверить совокупный diff по `$code-review` и локальный состав сборки.

Evidence: A-001/A-002 для контрольного материала подтверждены. A-006/A-008/A-009 покрыты частично указанными сценариями; полный browser restart, квоты, все адаптеры, UX отмены и релизная безопасность остаются в следующих этапах. См. [отчёт](PHASE1_VERIFICATION.md).

После разрешения реализации продолжать принятый срез самостоятельно; не вводить gate после каждого теста. Существенный новый подход вне spec требует решения пользователя.

## Фаза 2 - самостоятельное расширение и совместимость адаптеров

Статус: `[x]`; фаза завершена и технически проверена 10-10-2026. После предыдущей остановки исправлены harness, оба дефекта первого managed review, WebM контейнер, потеря terminal packets и cleanup поздней OPFS операции. Второй managed review завершён; зависание cleanup, несовместимый codec selection и отказ video-only capture устранены с regression checks и повторным браузерным проходом. Релизная приёмка всех сценариев остаётся отдельной.

Результат: MendoSave в собственном оформлении, общий код для двух сборок и проверенная матрица поддерживаемых сайтов.

- [x] Убрать пользовательские ссылки/обновления upstream; заменить имя, значок, runtime namespace и диагностические подписи. Сохранены происхождение, notices и durable storage имена для обновления.
- [x] Проверить YouTube watch/Music/Shorts, Rutube, VK, TikTok, Twitch, Coub и Звук по реально существующим возможностям. Результаты, отрицательные проверки и непроверенные варианты записаны в матрице; live и playlist не смешаны с одиночным VOD.
- [x] Провести Chromium regression общей изменённой логики; проверить сборки, реальные файлы, отдельные browser hosts и upgrade recovery. Различающиеся Page-Blob пути описаны и остаются предметом фазы 3.
- [x] Подключить regression tests, scoped ESLint, build/inventory checks и ограниченный outgoing scanner; разобрать внутренний code review и обновить README/документы.
- [x] Завершить коррекцию Twitch teardown и длительного browser save по PR review. Harness исправлен, 26/26 live tests и 182/182 полного набора; отрицательные/lifetime/recovery/stall cases проверены. Обе сборки пересобраны, реальные WebM в Zen и Chromium проверены, source preservation и cleanup рассмотрены отдельно.
- [x] Завершить один focused managed correction pass, устранить его подтверждённые замечания и проверить последующий diff локально. Для интеграции общего PR фаз 1 и 2 выбран merge commit, сохраняющий исходную историю; приватность сохраняется. Фазу 3 пока не начинать.

Evidence: A-003/A-006/A-007/A-008 в относящейся к фазе части; для неподдержанных сценариев - честный статус и причина, без молчаливого исключения из исходного объёма.

Фаза 2 закрывает матрицу измерений и исправления адаптеров, а не все release criteria. TikTok требует нового доступного контрольного материала; playlist queue - отдельной сквозной проверки. A-003 остаётся в фазе 3; A-006/A-008 покрыты указанными сценариями без заявления о полном закрытии.

## Фаза 3 - выбор места и пакеты

Статус: `[x]`; реализация разрешена и технически проверена 10-10-2026. Релизные проверки и пользовательская визуальная приёмка сохраняются отдельно.

Результат: удобная одиночная загрузка, выбор нескольких форматов, последовательные отдельные файлы и ZIP.

- [x] Подключить R-004 ко всем путям сохранения. В Zen реальные MP4, MP3, SRT и ZIP находятся в выбранных путях; Cancel не вызывает повторный диалог или принудительную загрузку. Chromium completion и программная отмена native download проверены отдельно.
- [x] Добавить выбранные позиции пакета и последовательную очередь. В обоих браузерах получены ровно выбранные три Coub-файла; при отмене второго Save As первый сохраняется. Принадлежность пакета и блокировка второго запуска проверены в двух реальных вкладках Chromium.
- [x] Закрепить локальную zip.js 2.20.0 и BSD-3-Clause. STORE ZIP извлечены Windows `Expand-Archive`; payload совпал по SHA. Диагностические 128 MiB прошли в двух браузерах; ошибки/квота/коллизии/traversal покрыты regression checks. Верхний предел не объявлен измеренным.
- [x] Проверить progress, отмену после реального chunk, restart processor и ручное восстановление. Выполнены screenshots wide/narrow и клавиатура; совокупный `$code-review`, TDD/regression checks и документация обновлены.

Evidence: A-003/A-004/A-005/A-006/A-009 в указанном объёме - [PHASE3_VERIFICATION.md](PHASE3_VERIFICATION.md). Реальное browser restart recovery незавершённого задания и верхние квоты остаются непроверенными; это не полная релизная приёмка A-006/A-008/A-010.

## Фаза 4 - публичный выпуск

Статус: `[~]`; техническая подготовка интегрирована, текущая ручная поставка 0.3.1 завершена через signed unlisted и Release в приватном репозитории. Публичное распространение требует отдельного решения; указанные ниже gaps и пользовательская приёмка сохраняются отдельно от завершённого среза 0.3.1.

Текущий результат: проверенный подписанный пакет для ручной постоянной установки, материалы с фактическими возможностями, ограничениями и правилами приватности. Публичное распространение отложено до отдельного решения.

- [x] Проверить свежий dependency audit, достижимость advisories, runtime versions/hashes, licenses/source references и vendor warnings. Сохранена существующая сборка ядра по решению пользователя; новая toolchain и компиляция vendor code не выполнялись. См. [DEPENDENCIES.md](DEPENDENCIES.md).
- [x] Проверить сохранение, lifecycle/recovery, privileged boundaries и доступность controls в описанных сценариях; завершить Standard repository security scan и совокупный внутренний code review. Scan complete / coverage partial / 0 открытых findings; native FFmpeg source и остальные пределы указаны в [SECURITY_REVIEW.md](SECURITY_REVIEW.md). Managed PR review выполняется при интеграции технического среза.
- [~] Закрыть практические gaps: TikTok-файл, playlist queue, длительный live/processor, полный restart, размер ZIP и безопасный resource failure, физический Chromium Save As. Уже подтверждены TikTok, длинный live, Chromium restart/manual recovery и верхний ZIP payload. Native playlist и недоступные сценарии сохраняют отдельные ограничения.
- [x] Подготовить переносимый локальный pipeline и GitHub CI на Windows/Linux: lockfile, tests, semantic lint, web-ext, licenses/vendor hashes, outgoing files/history, unsigned archives/source/CRC/hashes. Сохранить результат действительного CI run; Linux не заменяет Zen QA.
- [x] Повторить текущий unsigned candidate в отдельных muted Zen/Chromium profiles в пределах [PHASE4_VERIFICATION.md](PHASE4_VERIFICATION.md): конечные media/ZIP bytes, Cancel/recovery/source lifecycle, wide/narrow viewport и keyboard. Записать фактические версии и пределы.
- [x] Подготовить README, install/update/uninstall, privacy/security, site matrix, license/provenance и release notes. [Вариант распространения](DISTRIBUTION.md) уточнён: signed unlisted без магазина. Закреплён постоянный ID `mendosave@mendozie`, подготовлена [инструкция Mozilla reviewer](MOZILLA_REVIEW.md). Прежний dev ID остаётся только в историческом candidate.
- [x] По разрешению от 10-10-2026 подписать пакет, проверить saved ID/version/channel и реальную установку подписанного XPI. Mozilla: «Одобрено», 0.3.0, скрытый unlisted; 57 payload files сверены, пять файлов подписи. В отдельном Zen-профиле подпись принята при обязательной проверке, установка постоянная и активна после полного перезапуска; контрольный MP3 завершён, bytes совпали и полное декодирование прошло. [Отчёт подписания](SIGNING_VERIFICATION.md). Пользовательская визуальная приёмка остаётся отдельной от технического PASS.
- [x] По решению от 11-10-2026 выпустить пакеты для ручной установки через Release в существующем приватном репозитории. Saved state, tag revision, имена/размеры/hashes assets проверены; [поставка 0.3.1](SIGNING_VERIFICATION_031.md).
- [ ] Публичное распространение выполнять только по отдельному разрешению: сначала определить необходимую видимость и проверить оставшиеся gaps. Магазины не являются обязательным способом поставки.

Evidence: A-008/A-010, подтверждённое подписание/установка и readback разрешённой публикации. Наличие public GitHub source не означает подписанный или одобренный Mozilla пакет.

## Последующее исследование

Instagram Reels, другие Firefox-производные, другие ОС и дополнительные UX-функции рассматриваются после основной совместимости. Возможность сохранить внешнюю папку между пакетами без диалогов потребовала бы другого подхода; Native Messaging сейчас не выбран.

## Журнал состояния

| Дата | Изменение | Причина и evidence |
|---|---|---|
| 09-10-2026 | Создан roadmap; фаза 0 выполняется, продуктовая реализация не начата | Согласованный preview; аудит upstream и ответы пользователя. |
| 09-10-2026 | Фаза 0 завершена; фазе 1 требуется поручение в целевом проекте | 41 файл исходника совпал; 14 локальных ссылок исправны; staged diff без whitespace errors; начальный commit `a61e86b` прочитан и содержит только подготовку. |
| 09-10-2026 | Фаза 1 начата; работа локальная, репозиторий приватный до релиза | Проверка перед импортом: все 41 files и Git blob hashes совпали с SOURCE.json. Новое поручение заменяет прежний запрет реализации; запрет внешней публикации сохраняется. |
| 09-10-2026 | Фаза 1 технически проверена; фаза 2 не начата | A-001/A-002 на контрольном YouTube watch в Zen, Chromium regression, 23 tests, decoder checks, processor failure/recovery и visual/keyboard QA. Подробности и незакрытые критерии - в PHASE1_VERIFICATION.md. |
| 09-10-2026 | Фаза 2 начата; GitHub подключён приватно | Прямое поручение пользователя; remote и приватность проверены. Публичный выпуск и смена видимости остаются отложены. |
| 09-10-2026 | Фаза 2 технически проверена; фаза 3 не начата | 134 tests, 22 медиафайла, SRT, Chromium regression, upgrade recovery, реальные MSE/live и wide/narrow keyboard QA. Ограничения и отрицательные результаты сохранены в SITE_MATRIX.md и PHASE2_VERIFICATION.md. |
| 10-10-2026 | Работа остановлена по просьбе пользователя; фаза 2 снова `[~]`, PR открыт | После первого managed review выполнены коррекции и GREEN 161 tests; проверены Zen normal/reload/close. Chromium raw WebM выявили duplicate timestamp и незавершённый EBML header. Потоковый remux внесён как WIP; targeted run 8 PASS / 6 cancelled, итоговые проверки не завершены. Checkpoint и локальный snapshot сохраняют исходники, evidence и порядок продолжения. |
| 10-10-2026 | Фаза 2 завершена и PR #1 интегрирован | Harness/WebM и существенные review findings исправлены; 182 tests, обе сборки, реальные media outputs и lifecycle checks. |
| 10-10-2026 | Фаза 3 технически завершена, версия 0.3.0 | Save As, выбранная очередь и STORE ZIP; 269 tests, реальные Coub/SRT, Cancel/recovery/two-tab и 128 MiB в Zen/Chromium. В PR #2 подтверждённая утечка recovery bytes исправлена; приватность сохраняется, релизные границы записаны. |
| 10-10-2026 | Фаза 4: проверены code/pipeline slice и runtime guards; выбран сначала файл, затем магазин | 295 tests, vendor hashes/licenses, fresh audit, три byte-verified archives. Существующее ядро сохраняется без новой среды. Ветка `chore/release-readiness` опубликована приватно; внешний выпуск не выполнялся. |
| 10-10-2026 | Получен подписанный Mozilla unlisted XPI 0.3.0 без страницы в магазине | Постоянный ID `mendosave@mendozie`; matching source snapshot `fa034ac`, 296 tests. Saved «Одобрено», hidden channel и reviewer notes проверены. Постоянная установка, подпись, полный restart и завершённый декодируемый Coub MP3 подтверждены в отдельном Zen-профиле. Репозиторий остаётся приватным. |

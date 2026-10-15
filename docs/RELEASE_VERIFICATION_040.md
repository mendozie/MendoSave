# Проверка выпуска 0.4.0

Дата: 15-10-2026. Версия - 0.4.0, постоянный ID - `mendosave@mendozie`. Пользователь принял общий интерфейс B, запросил небольшую правку выравнивания и прямо разрешил commit, обновление документации/скриншотов, Mozilla unlisted signing и GitHub Release. Подготовка идёт в [PR #10](https://github.com/mendozie/MendoSave/pull/10); общий порядок ручной приёмки будущих изменений сохраняется.

**0.4.0 подписана Mozilla и [опубликована](https://github.com/mendozie/MendoSave/releases/tag/v0.4.0) 15-10-2026 в 23:28 МСК.** Подписанное обновление и все шесть загруженных Release assets проверены. Изменения и этот отчёт проходят в main через [PR #10](https://github.com/mendozie/MendoSave/pull/10); его текущий merge state доступен по ссылке. Пакеты прежних кандидатов и выпуска 0.3.3 сохранены отдельно и не перезаписаны.

## Шапка и документация

Причина разницы уровней - отдельные flex items с разными line boxes для заголовка/источника и текстовые символы grip/close; Back SVG имел геометрию, сдвинутую вправо. Шапка теперь использует grid для четырёх областей и общий baseline заголовка/источника. Grip и close используют существующую SVG-систему; Back имеет границы `(6, 6, 12, 12)` в viewBox 24×24. Название источника сокращается, заголовок остаётся видимым.

| Проверка | Zen 1.23.2b / Gecko 157.0.1 | Edge 155.0.4283.45 |
|---|---|---|
| Actual viewport | 1440×1000 и 360×800 | 1440×1000 и 360×800 |
| Центры Back/grip/close | Совпадают | Совпадают |
| Baseline заголовка/источника | Разница 0 px | Разница 0 px |
| Back SVG | Центр (12,12), transform none | Центр (12,12), transform none |
| Controls | Back Enter, X trusted click, drag +65/+30, Tab/Shift+Tab | Те же действия прошли |

Рассмотрены полноразмерные viewport screenshots и отдельные элементы. Это реальные установленные компоненты расширения на синтетической нейтральной странице, без скачивания медиа и без заявления о новом real-site E2E. Popup открыт как extension tab; physical toolbar popover отдельно не проверен. Созданные browser/driver процессы завершены с readback, профили сохранены.

README теперь содержит новые [settings](images/settings-zen-040.png) 316×520 и [package](images/package-zen-040.png) 480×412. Старые 0.3.3 изображения сохранены. PNG содержат только IHDR/IDAT/IEND, текстовые метаданные не обнаружены; точные копии совпали с источниками по SHA-256. Размеры element screenshots не выдаются за размеры viewport.

## Парсеры и локальные проверки

Новый Standard security scan завершён с тремя medium findings до исправлений. MP4, FLAC и AV1 исправлены через общие parser boundaries; [область, воспроизведение и ограничения](SECURITY_REVIEW_040.md). Исходный запечатанный отчёт сохраняет findings. Новый scanner run с нулевыми findings не заявляется.

- 81 PASS в четырёх затронутых parser/Instagram suites, включая девять новых public-boundary tests; TDD RED/green воспроизведение сохранено.
- Scoped ESLint и `git diff --check` прошли.
- Свежий независимый review parser corrections не выявил подтверждённого surviving bypass или новой регрессии; все шесть transforms и восемь vendor entries сверены отдельно. Совокупный UI diff также проверен локально против UIB-006 и native evidence.
- Dependency/license hashes и exact lockfiles прошли; все шесть deterministic source/bundle transforms обратимы.
- Firefox и Chromium builds по 69 файлов; manifests, CSP, references, inventory hashes и build hygiene прошли.
- `web-ext`: 0 errors, 0 notices, четыре прежних reviewed warnings. Outgoing scan: 0 findings; бинарные fixtures/изображения проверены отдельно.

Полный набор tests вручную не запускался повторно. Прежние проверки media/ZIP и сайтов относятся к замороженному кандидату, описанному в [UI_B_VERIFICATION.md](UI_B_VERIFICATION.md) и [INSTAGRAM_VERIFICATION.md](INSTAGRAM_VERIFICATION.md). Неизменённые участки используют эти evidence; проверка текущего diff и постоянной установки записывается отдельно.

## Замороженный исходный срез и review

Tag `v0.4.0`, runtime и submitted source соответствуют чистому commit `456b157241167cd1aa36d576c8ef0ec1e2f2ed66`. Base проверки - `2a4284b943c1ed90f9eaea689da37c1ac829647f`. Последующие изменения записывают фактические receipts только в документах; отправленные application/source bytes не меняются.

Полный managed UI review завершился на `f024c680081779047b78e0fffe08f2dfab8da705`. Второй проход понадобился из-за изменений общего parser contract. Автоматический run после перевода draft в ready завершился на `456b157241167cd1aa36d576c8ef0ec1e2f2ed66` 15-10-2026 в 20:12:02 UTC, без findings. Подтверждены authenticated bot metadata `status=completed`, `has_any_findings=false`, `has_unresolved_findings=false` в [summary](https://github.com/mendozie/MendoSave/pull/10#issuecomment-6195669689); это не вывод по emoji или отсутствию комментария. Новый managed pass для последующих документов не запрашивается.

[Windows/Linux CI](https://github.com/mendozie/MendoSave/actions/runs/38799429945) того же среза завершён: по **1051 PASS, 0 FAIL**, lint, provenance/audit, обе сборки, web-ext, outgoing history и archive reproducibility. Все три архива Linux CI скачаны обратно и совпали с локальными по SHA-256. Это автоматический полный pipeline; локально вручную выполнялись только затронутые 81 tests и checks.

## Mozilla и постоянное обновление

Через встроенный браузер отправлен self-distributed вариант существующего add-on `mendosave@mendozie`, без нового listing. Mozilla version ID - `6582334`, file ID - `5126466`; сохранённый статус **«Одобрено»**. Валидация: 0 errors, 4 известных warnings. Отправленный source содержит 201 файл; его скачанная из Mozilla копия совпала по SHA-256 и прошла CRC. Release/reviewer notes сохранены и прочитаны после новой загрузки страницы. Первое сохранение notes превысило серверный лимит 3000 из-за CRLF; текст сокращён, сохранённый reviewer note содержит 2260 символов.

Подписанный XPI содержит 69 application files и пять Mozilla `META-INF` signature files. Manifest JSON семантически совпадает с unsigned, остальные application bytes совпадают точно. После появления статуса «Одобрено» файл скачан повторно: SHA-256 неизменён.

В новом отдельном Zen-профиле выполнено постоянное обновление **0.3.3 → 0.4.0**. После полного restart сохранены ID, UUID и пять контрольных настроек; `signedState=2`, `signatureRequired=true`, `temporarilyInstalled=false`, add-on активен. Signature/CSP preferences и рабочий профиль пользователя не менялись. Из установленного XPI повторно проверены header assets, фактические viewport 1440×1000/360×800, Back/close/drag/Tab/Shift+Tab; девять screenshots визуально рассмотрены без подтверждённых дефектов. Package screenshot совпал с новым README image по полным bytes.

Первоначальный QA helper остановился на ошибке обхода собственных процессов при завершении baseline. Ошибка была в игнорируемом проверочном скрипте, не в расширении. Failed receipt сохранён; узкая правка helper проверена RED → GREEN, затем проверка продолжена с сохранённого этапа без повторной установки baseline. Итоговый readback: собственных browser/driver процессов нет, порты 5591/4011 свободны, профиль и evidence сохранены.

## Пакеты и внешнее чтение результата

| Файл | Bytes | SHA-256 |
|---|---:|---|
| `mendosave-0.4.0-firefox-signed.xpi` | 11081205 | `880940a7ba5ffc8dd725c5cae8b6eec8222a24c97f24bb772bd075cb8b5761f1` |
| `mendosave-0.4.0-chromium-unsigned.zip` | 34690900 | `379358440178f58abc4f2bb65094404069e6b1fa350344774ecd50cf90ac467a` |
| `mendosave-0.4.0-source.zip` | 36624328 | `509c66ed7b71ab565794c2e55b7dbca6269b13e7bee9d608d75bfc01c888518a` |

Сохранён и unsigned Firefox XPI: 34689917 bytes, SHA-256 `f4c4de1fe51da6c3291bb475d308ba670d5f98afe3eecbd88b0924c6665f0d36`. `release-manifest.json` описывает исходные unsigned archives и точный состав; отдельный `signing-manifest.json` - подпись и native upgrade. `SIGNED_SHA256SUMS` содержит hashes пяти остальных загруженных assets и не включает себя.

GitHub readback подтвердил author `mendozie`, tag/commit, `draft=false`, `prerelease=false`, latest `v0.4.0`, точные notes и шесть загруженных assets. Все шесть скачаны обратно и совпали с сохранёнными файлами по размеру и SHA-256; три архива прошли CRC, имена entries уникальны. Два автоматически создаваемых GitHub source archives показываются в UI дополнительно к этим шести assets. Публичная видимость репозитория сохранена. Финальные документы не пересобирают и не подменяют пакеты.

Закрытый Instagram не проверен по решению пользователя. Прежний native MP3 disconnect в долгоживущем Zen не приписывается новым parser corrections; его причина не установлена, а контроль после restart прошёл на прежних frozen bytes. Другие ОС и все производные браузеры не считаются проверенными.

# Security review 0.4.0

Дата: 15-10-2026. Область - выпуск Instagram и общего интерфейса B, затем ограниченные исправления парсеров. Это отдельная проверка от [исторического review 0.3.2/0.3.3](SECURITY_REVIEW_032.md).

## Исходный Standard scan

Codex Security Standard scan завершён и сохранён для исходного `67cfb177c5be06fd7fb238bf4b0e2495a4f1a4bc` с тремя незакоммиченными изменениями шапки: `menu.js`, `package_ui.js`, `package_ui.css`. Snapshot digest - `codex-security-snapshot/v1:sha256:252a48e335d5c4c9639356284944d610656e12fc68b36cfe0531f8370599393a`. Отчёт запечатан до исправлений; его три findings не заменены нулевым результатом.

Рассмотрено 191 отслеживаемое имя: 190 файлов полностью на уровне доступных исходников/данных, один частично. Проверены first-party runtime, manifests/CSP, привилегированные сообщения и ownership, vendor JavaScript, tests/config, документы, лицензии и девять прежних PNG. Встроенный сжатый ZIP worker декодирован как данные и также рассмотрен. Для `ffmpeg-core.wasm` проверены структура бинарного файла, imports/exports, память и строки; нативные тела функций и C/C++ исходники не проверены. Утверждение о полном source-level review FFmpeg не делается.

Scan был статическим: приложение, malformed-media PoC и fuzzing во время него не запускались. Точечные воспроизведения ниже выполнены отдельно после запечатывания.

| Finding | Подтверждённая граница | Исправление |
|---|---|---|
| `vendor-stsc-01`, medium | Regular MP4 packet lookup использовал непроверенный `samplesPerChunk`; маленькая physical sample table могла задавать большой цикл. Повторные суммы корректного chunk также давали квадратичную работу. | Проверка производных индексов и физического диапазона; один ленивый prefix index нормализованной variable-size таблицы. Constant-size/PCM и fragment paths сохранены. |
| `vendor-flac-eof-01`, medium | Timestamp lookup пустого FLAC продолжал читать после известного EOF и удерживал mutex. | Terminal empty lookup возвращает `null` через существующий `finally`; непустой поток сохраняет lazy read и выбор последнего packet. |
| `vendor-av1-obu-01`, medium | Signed/aliased LEB128 длина AV1 OBU могла передвинуть курсор назад; отсутствовали физические границы extension/length/payload. | Unsigned arithmetic, прежний численный и восьмибайтовый предел, проверка физических bytes до yield, явная ошибка на некорректной длине. |

Для этих findings необходим контроль входных медиа в разрешённом приложением маршруте и запуск обработки пользователем. Сохранение такого контроля после обычного upload/transcoding площадкой не установлено. Подтверждённый результат - риск зависания processor/worker; кража данных, выполнение кода и browser-wide impact не установлены. Sender/tab/job проверки не обходятся.

## Исправления и проверка

Используется узкая общая граница каждого парсера. Обновлены deterministic transformations bundle и пять полных MPL source files с сохранением notices/imports. [PATCH.md](../extension/vendor/mediabunny/PATCH.md) и provenance содержат исходные и изменённые hashes. Обратное и прямое преобразования проверены для всех шести входов; новая компиляция TypeScript в jsDelivr bundle не заявляется.

TDD выполнен через public `Input`, `EncodedPacketSink`, duration и codec APIs поставляемого bundle. MP4 regression сначала не получила ожидаемую ошибку; пустой FLAC и AV1 codec probe достигли целевой операции и завершились только по ограничению дочернего процесса в 3 секунды. После исправлений те же regressions проходят. Проверены uint32 chunk counts, actual/metadata и timestamp/key lookups, compact widths 4/8/16, cold/known-EOF FLAC, concurrent mutex access, short/bad-sync tails, AV1 length aliases/overflow/truncation/payload overrun и оба потребителя OBU iterator. Корректные FLAC frames/bytes/duration/seeks, AV1 codec/key/delta и padded/extension/empty/size-less OBUs сохранены.

Команда из корня:

```sh
node --test tests/parser-work-bounds.test.cjs tests/mp4-resource.test.cjs tests/mp4-extent.test.cjs tests/instagram-media.test.cjs
```

Результат - **81 PASS, 0 FAIL**. Новые synthetic FLAC/AV1 fixtures независимо проверены `ffprobe` и полностью декодированы в null sink; описание в [fixtures/README.md](../tests/fixtures/README.md). Потенциально зависающие варианты запускаются только в завершаемых дочерних процессах. Полный набор тестов вручную не повторялся по просьбе пользователя; существующий CI сохраняет свой полный pipeline.

Lint изменённых JS/tests, vendor/license/lockfile provenance, обе сборки по 69 файлов, manifests/CSP/inventories, outgoing scan и `web-ext` прошли. `web-ext`: 0 errors, 0 notices, прежние четыре разобранных warnings; strict lint по-прежнему отклоняет warnings. Свежий независимый read-only bypass/regression review трёх исправлений не выявил конкретного surviving bypass или новой регрессии. Он отдельно сверил шесть transforms, восемь vendor записей и public FLAC/AV1 controls. Review относится к bundle SHA-256 `9ce416761bc48aa3c7450a6e463a079aaa261454c82879abf8d3d394f8c372fa`; после него runtime не менялся. Итог remediation - **fixed** в замороженном `456b157241167cd1aa36d576c8ef0ec1e2f2ed66`. Windows/Linux CI прошёл по 1051 tests; второй managed correction pass того же commit завершился без findings. Подпись, native upgrade и внешние package receipts описаны в [релизном отчёте](RELEASE_VERIFICATION_040.md).

## Пределы результата

- Исходный scan относится к замороженному снимку до исправлений. Последующая проверка corrections не является новым repository-wide scan.
- WASM/native implementation остаётся частично рассмотренной. Наличие SOCKFS/WebSocket и protocol strings не позволяет называть FFmpeg intrinsically network-disabled; приложение передаёт фиксированные локальные inputs. Конкретный неразрешённый сетевой эффект не установлен.
- Две dev-only записи lockfile имеют несовпадающие version labels и имена tarball: `real-require` 0.3.0/0.2.0 и `uhyphen` 0.3.0/0.2.0. HTTPS/integrity закреплены; причина и security impact не установлены. Lockfile не изменялся ради выпуска.
- Проверка credentials не обнаружила подтверждённого встроенного секрета в рассмотренном текущем source snapshot. Это не доказательство отсутствия всех возможных secret formats.
- Реальная закрытая публикация Instagram остаётся непроверенной по согласованному исключению. Native header QA и parser tests не подменяют полную проверку всех площадок и декодеров.
- Large-table scaling не измерялся отдельно; линейная конструкция индекса проверена по source. Streamed FLAC disposal во время pending read отдельно не упражнялся; проверены concurrent EOF lookups и отказ public sink после disposal.

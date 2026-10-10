# Локальные проверки MendoSave

Актуализировано: 10-10-2026. Команды выполняются из корня репозитория в PowerShell либо другом shell с Node.js.

## Среда и зависимости

Для инструментов разработки нужен Node.js `^22.13.0 || >=24`; фактически проверены Node.js 22.18.0 и npm 10.9.3 на Windows. Используется JavaScript; миграция на TypeScript не входит в этот срез. Перед подготовкой среды сверь `node --version`, `npm --version` и выбранные executable paths. Установка по lockfile:

```powershell
npm ci --ignore-scripts
```

`--ignore-scripts` исключает автоматические lifecycle scripts. Исходные upstream build/CI scripts не запускаются. Dev dependencies закреплены точными версиями и не копируются в расширение: ESLint 10.12.0, `@eslint/js` 10.0.1, `globals` 17.13.0, `linkedom` 0.18.12, `web-ext` 10.7.0. Медиабиблиотеки остаются в `extension/vendor/`.

ESLint 10 выбран как поддерживаемая версия; ESLint 9 завершил поддержку 06-08-2026. Требование Node 22.13+ относится к dev tooling. Источники: [статус версий ESLint](https://eslint.org/version-support/), [Node.js requirements ESLint 10](https://eslint.org/docs/latest/use/migrate-to-10.0.0), [flat config](https://eslint.org/docs/latest/use/configure/configuration-files).

## Команды и границы результата

```powershell
npm test
npm run lint:js
npm run build
npm run check:build
npm run lint:extension
npm run check:outgoing
```

- `npm test` запускает regression tests расширения и проверки самих QA-инструментов. Проверки QA создают небольшие fixtures в `.local/qa/phase2/checks/fixtures/`; они сохраняются для диагностики и не попадают в Git.
- `lint:js` применяет semantic recommended rules к собственному JS в `extension/`, `browser-hosts/`, `scripts/`, `tests/` и конфигурации. Browser, worker и Node globals заданы по окружению; shared extension globals объявлены явно. Vendor, сборки, `.local/` и `node_modules/` исключены. Ошибки вроде необъявленного binding завершают команду с ненулевым кодом. Неиспользуемые значения, лишние присвоения и потеря `cause` остаются видимыми предупреждениями. Style rules и массовое автоисправление не добавлены.
- `build` генерирует Firefox- и Chromium-сборки. `check:build` читает готовый `dist/`: проверяет имя/версию manifest, разделение browser hosts, локальные manifest/HTML script references, CSP, обязательные licenses, полный inventory и SHA-256 каждого файла, совпадение копируемых source bytes и отсутствие служебных/private artifacts. Устаревшая сборка не проходит проверку. Это локальная проверка состава, без установки в браузер.
- `lint:extension` проверяет Firefox-сборку через Mozilla `web-ext`. В 0.3.0 остаются три vendor warnings: dynamic import в FFmpeg worker, `Function` constructor в FFmpeg wrapper и dynamic import в zip.js native bundle. ZIP выполняется локально с `useWebWorkers: false`; этот режим не вызывает worker import. Обычная команда сохраняет warnings; `lint:extension:strict` намеренно возвращает ошибку при любом предупреждении. Разбор warnings не означает прохождения полного security scan или релизной приёмки.
- `check:outgoing` сканирует текущие tracked и неигнорируемые untracked файлы. Ищет распространённые токены, private-key markers, приватные пути и буквальные подписанные URL; выводит только путь, строку и категорию. `.local/`, профили и ignored файлы не читаются. Если приватная область уже tracked, её наличие считается ошибкой. Binary blobs пропускаются и учитываются в summary; значения совпадений не выводятся. Проверка не заменяет полный поиск секретов, просмотр изображений, индексированного состояния или проверку браузерных профилей.

Для исходящей истории укажи реально разрешённую revision:

```powershell
node scripts/check-outgoing.cjs --history=HEAD
```

History scan читает reachable commits и проверяет каждый уникальный text blob по паре path/object. Рабочая копия и история проверяются раздельно: `--all` не доказывает чистоту старых commits. В обоих режимах действуют узкие reviewed exceptions для отрицательных test fixtures. Один исторический build path в неизменённом FFmpeg wrapper разрешён только при совпадении конкретного пути и SHA-256 vendor-файла; новые пути или изменённые bytes требуют отдельного рассмотрения. Совпадения exceptions видны в summary. Лицензии и происхождение upstream сохраняются.

ESLint не является type checker. Межфайловая типизация, динамические message schemas, фактическое поведение браузера и доступность сайтов подтверждаются контрактными/regression tests и отдельной browser QA. Whole-program dead-code removal не добавлен: manifest, HTML и shared globals являются динамическими entrypoints. Локальные неиспользуемые значения ESLint показывает без удаления кода.

В фазе 3 набор 0.3.0 содержал 269 tests. Фаза 4 добавляет проверки dependency policy, release archives, warning inventory, RAM budgets и диагностики. Новые public-boundary проверки охватывают ZIP/CRC/имена, очередь и принадлежность позиции, схемы Blob/source messages, квоту, отмену Save As, восстановление, откат при ошибке recovery index или открытия writable и foreign buffer view Gecko. Реальный браузерный harness запускает отдельные профили и использует WebDriver/CDP; диагностические binary fixtures проверяют передачу и упаковку, а не качество медиа. Финальные browser/file receipts и screenshots находятся в игнорируемой `.local/qa/phase3/`. Перед Git проверь изображения глазами: текстовый outgoing scanner их содержимое не анализирует.

Локальная zip.js закреплена вместе с BSD-3-Clause и SHA-256 в `extension/vendor/zipjs/`; установка npm не загружает runtime ZIP library. Измеренный ZIP payload - 128 MiB в обоих браузерах; guard 1 GiB не является результатом нагрузочного испытания. Полные сценарии и ограничения находятся в [PHASE3_VERIFICATION.md](PHASE3_VERIFICATION.md).

## Audit dev tooling

```powershell
npm audit
npm ls shell-quote node-forge
```

Scoped override `fx-runner > shell-quote` закреплён на 1.11.0. В 1.10.0 reproducer позволял newline после comment token без ошибки; 1.11.0 отклоняет его. Проверка также подтверждает parsing quoted browser/profile arguments, а `web-ext lint` проверен после override. Это исправление не меняет `web-ext` major и не запускает браузер. Источники: [advisory shell-quote](https://github.com/advisories/GHSA-pqg4-j6r4-53mv), [upstream changelog](https://github.com/ljharb/shell-quote/blob/main/CHANGELOG.md).

Исторический audit от 09-10-2026 после override возвращал три high entries одной цепочки: `web-ext > @devicefarmer/adbkit > node-forge` 1.4.0, advisory [RSA signature verification](https://github.com/advisories/GHSA-86w9-cpqp-85rv). Latest `node-forge` в npm registry остаётся 1.4.0; совместимое исправление не подтверждено. Critical entries после override отсутствуют. Это служебные зависимости; `check:build` исключает `node_modules` из поставки. Автоматический `npm audit fix --force` предлагает downgrade `web-ext` до 5.1.0 и не принят. Свежий audit от 10-10-2026 и достижимость рассмотрены в [DEPENDENCIES.md](DEPENDENCIES.md); он подтверждает те же три tooling entries и 0 runtime entries. Repository security scan учитывается отдельно.

Установка расширения, реальные media outputs, wide/narrow screenshots, keyboard и adapters проверяются отдельно по [PROJECT_SPEC.md](PROJECT_SPEC.md) и [ROADMAP.md](ROADMAP.md). Команды выше не доказывают browser compatibility или полноту конечного media-файла.

## Pipeline фазы 4

После `npm ci --ignore-scripts` выполни:

```powershell
npm run verify
```

Pipeline последовательно запускает tests, semantic lint, офлайн vendor/license/lockfile checks, свежие tooling/runtime audits, обе сборки и inventories, warning gate, outgoing current/history scan и подготовку неподписанных архивов. На первом отказе он останавливается. Локальный receipt с командами и exit codes сохраняется в `.local/qa/phase4/pipeline.json`.

`check:extension` читает JSON Mozilla linter. Errors/notices, некорректный report и любое новое или повторное warning завершают gate с ошибкой. Три разобранные vendor warnings допускаются только при совпадении code/file/line/column и закреплённых SHA-256 соответствующих файлов; они выводятся явно. `lint:extension:strict` по-прежнему отклоняет эти warnings. Обоснование находится в [DEPENDENCIES](DEPENDENCIES.md).

`prepare:release` создаёт Firefox unsigned XPI, Chromium ZIP, source ZIP и manifests/checksums в `artifacts/mendosave-<version>/`. Каждый архив проверяется повторным чтением CRC и извлечённых bytes. Порядок, STORE compression и timestamps фиксированы. Source берётся из текущих tracked и неигнорируемых untracked files, поэтому признак `dirty` в receipt важен: окончательные archives следует строить из чистого проверенного commit. Подробности поставки и следующий внешний шаг - в [DISTRIBUTION](DISTRIBUTION.md).

[GitHub workflow](../.github/workflows/verify.yml) выполняет те же checks на `ubuntu-24.04` и `windows-2025`, затем сравнивает hashes архивов. Node 22.18.0 и Actions закреплены; Actions используют full commit SHA. Checkout имеет read-only token и не сохраняет credentials. Workflow работает на PR, разрешённых task branches, main и manual dispatch; он не подписывает, не публикует GitHub release и не содержит signing secrets. Artifacts хранятся 14 дней. `.gitattributes` фиксирует LF для source и сохраняет vendor/binary bytes.

GitHub CI проверяет переносимость developer pipeline. Windows runner без Zen и Linux checks не заменяют отдельные browser/file receipts. Живой network audit может остановиться при недоступности registry или новой advisory; обход такого отказа не встроен. SHA-pinned Action проверяет используемый checkout actions code, но hosted runner image продолжает обслуживаться GitHub.

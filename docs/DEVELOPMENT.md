# Локальные проверки MendoSave

Актуализировано: 09-10-2026. Команды выполняются из корня репозитория в PowerShell либо другом shell с Node.js.

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
- `lint:extension` проверяет Firefox-сборку через Mozilla `web-ext`. У vendored FFmpeg известны два предупреждения: dynamic import в worker и `Function` constructor в wrapper. Обычная команда сохраняет эти предупреждения; `lint:extension:strict` намеренно возвращает ошибку при любом предупреждении. Разрешение этих warnings не означает прохождения полного security scan или релизной приёмки.
- `check:outgoing` сканирует текущие tracked и неигнорируемые untracked файлы. Ищет распространённые токены, private-key markers, приватные пути и буквальные подписанные URL; выводит только путь, строку и категорию. `.local/`, профили и ignored файлы не читаются. Если приватная область уже tracked, её наличие считается ошибкой. Binary blobs пропускаются и учитываются в summary; значения совпадений не выводятся. Проверка не заменяет полный поиск секретов, просмотр изображений, индексированного состояния или проверку браузерных профилей.

Для исходящей истории укажи реально разрешённую revision:

```powershell
node scripts/check-outgoing.cjs --history=HEAD
```

History scan читает reachable commits и проверяет каждый уникальный text blob по паре path/object. Рабочая копия и история проверяются раздельно: `--all` не доказывает чистоту старых commits. В обоих режимах действуют узкие reviewed exceptions для отрицательных test fixtures. Один исторический build path в неизменённом FFmpeg wrapper разрешён только при совпадении конкретного пути и SHA-256 vendor-файла; новые пути или изменённые bytes требуют отдельного рассмотрения. Совпадения exceptions видны в summary. Лицензии и происхождение upstream сохраняются.

ESLint не является type checker. Межфайловая типизация, динамические message schemas, фактическое поведение браузера и доступность сайтов подтверждаются контрактными/regression tests и отдельной browser QA. Whole-program dead-code removal не добавлен: manifest, HTML и shared globals являются динамическими entrypoints. Локальные неиспользуемые значения ESLint показывает без удаления кода.

## Audit dev tooling

```powershell
npm audit
npm ls shell-quote node-forge
```

Scoped override `fx-runner > shell-quote` закреплён на 1.11.0. В 1.10.0 reproducer позволял newline после comment token без ошибки; 1.11.0 отклоняет его. Проверка также подтверждает parsing quoted browser/profile arguments, а `web-ext lint` проверен после override. Это исправление не меняет `web-ext` major и не запускает браузер. Источники: [advisory shell-quote](https://github.com/advisories/GHSA-pqg4-j6r4-53mv), [upstream changelog](https://github.com/ljharb/shell-quote/blob/main/CHANGELOG.md).

На 09-10-2026 `npm audit` после override возвращает три high entries одной цепочки: `web-ext > @devicefarmer/adbkit > node-forge` 1.4.0, advisory [RSA signature verification](https://github.com/advisories/GHSA-86w9-cpqp-85rv). Latest `node-forge` в npm registry остаётся 1.4.0; совместимое исправление не подтверждено. Critical entries после override отсутствуют. Это служебные зависимости; `check:build` исключает `node_modules` из поставки. Автоматический `npm audit fix --force` предлагает downgrade `web-ext` до 5.1.0 и не принят. Перед релизом нужны повторный audit и предусмотренный проектом repository security scan; нынешние checks не заявляют их завершение.

Установка расширения, реальные media outputs, wide/narrow screenshots, keyboard и adapters проверяются отдельно по [PROJECT_SPEC.md](PROJECT_SPEC.md) и [ROADMAP.md](ROADMAP.md). Команды выше не доказывают browser compatibility или полноту конечного media-файла.

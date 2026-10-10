# Зависимости и исходный код

Проверено: 10-10-2026. Runtime bytes не изменены в этом срезе. Добавлены лицензии и provenance для уже поставляемых библиотек, отдельный lockfile для их advisory audit и проверки supply chain.

## Закреплённая поставка

| Компонент | Версия и источник | Проверенный результат |
|---|---|---|
| FFmpeg wrapper | `@ffmpeg/ffmpeg` 0.12.10; Git `e0d4c62a229ba58ea0c6e6b881e289f2fefe97c4` | `ffmpeg.js` совпал с npm `dist/umd/ffmpeg.js`. Worker совпал после одной унаследованной замены default CDN URL на локальный `new URL("ffmpeg-core.js", self.location.href).href`. |
| FFmpeg core | `@ffmpeg/core` 0.12.6; тот же Git commit | JS и WASM совпали byte-for-byte с official npm package. Browser `-version` и `-buildconf` подтвердили FFmpeg 5.1.4, Emscripten 3.1.40 и GPL build flags. |
| Mediabunny | 1.51.0; Git `634186fd5e2dac946bf994a955680b85aceb7709` | Bundle совпал с versioned jsDelivr `+esm`. Все 66 файлов `package/src/` из npm совпали с закреплённым Git source archive. |
| zip.js | `@zip.js/zip.js` 2.20.0; Git `38508528fe00b094447d9122b7725ab412149e2d` | Native bundle совпал с npm package; npm `gitHead` совпал с ранее проверенным Git commit. |

Все npm tarballs скачаны без выполнения lifecycle scripts и проверены по registry SHA-512 integrity. Отдельно сохранены SHA-256 tarballs. Конкретные source URLs, versions, file sizes, SHA-256 и преобразование worker записаны в `extension/vendor/{ffmpeg,mediabunny,zipjs}/PROVENANCE.json`. Hash фиксирует полученные bytes; он не является доказательством доверенности npm publisher или воспроизводимой компиляции.

В пакет входят MIT notice wrapper, GPLv2 text ядра, полный MPL-2.0 Mediabunny и BSD-3-Clause zip.js. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) сохраняет исходную GPL и происхождение Nova/Triangle. Ссылки на исходники и scripts поставщика приведены ниже.

## Advisory audit и достижимость

Свежий `npm audit` tooling вернул 3 high entries одной цепочки, 0 critical: `web-ext` 10.7.0 → `@devicefarmer/adbkit` 3.3.9 → `node-forge` 1.4.0. Причина - [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), некорректная проверка RSA PKCS#1 v1.5; advisory на дату проверки не указывает patched version. Предложенное npm исправление - downgrade `web-ext` до 5.1.0. Оно не принято. Scoped override `fx-runner > shell-quote` 1.11.0 сохраняется; `audit fix --force` не выполнялся.

Это не три независимые уязвимости расширения. `node_modules` не поставляется в browser package. Статическая проверка установленного `web-ext/lib/extension-runners/index.js` показала импорт Android runner только для `firefox-android`; текущие lint/build и browser QA не используют Android. `web-ext/lib/util/adb.js` создаёт ADB client, но не TCPUSB server. Потенциально уязвимые `key.verify` находятся в `adbkit/dist/src/adb/tcpusb/socket.js`, в server authentication; `auth.js` допускает exponent 3. Значит у dependency есть реальный уязвимый механизм, а достижимость в текущем desktop/lint workflow не установлена. Разрешение Android/TCPUSB потребует нового рассмотрения. Это ограниченная статическая оценка, без exploit reproduction.

Для четырёх фактических runtime package versions выполнен отдельный registry audit: 0 entries. `scripts/runtime-audit/package-lock.json` фиксирует также их npm metadata/type dependencies и не устанавливает эти пакеты в расширение. npm advisories не покрывают весь C/C++ FFmpeg и не доказывают отсутствие vulnerabilities в WASM, декодерах или самостоятельно собранном bundle. Repository security scan выполняется отдельно.

```powershell
npm run check:dependencies
npm run audit:dependencies
```

Первая команда офлайн проверяет recorded vendor/license hashes и отсутствие незарегистрированных vendor files, exact direct dependency versions, соответствие lockfile и SHA-512 npm integrity. Вторая дополнительно получает свежие audit reports для tooling и runtime. Единственное исключение - указанная advisory, exact installed versions и три exact dependency nodes, пока npm предлагает только конкретный major downgrade. Новая advisory, новый dependency path/version, совместимое исправление или некорректный report приводят к ошибке. Runtime audit исключений не имеет. Успех этого gate допускает известную tooling advisory; он не означает нулевой audit count.

## Три предупреждения web-ext

`web-ext` 10.7.0 на Firefox build: 0 errors, 3 warnings. Исполняемые vendor bytes сохранены; предупреждения не скрыты и CSP не ослаблена.

| Warning | Источник и проверенная граница |
|---|---|
| `UNSAFE_VAR_ASSIGNMENT`, `vendor/ffmpeg/814.ffmpeg.js:1` | Dynamic import используется только как fallback после `importScripts(coreURL)`. `loadSingleThreadFFmpeg()` передаёт локальные core/WASM URLs из `chrome.runtime.getURL`. Унаследованный default тоже локален. Контекст worker и CSP ограничивают extension scripts локальной поставкой. Другой core URL не является разрешённой конфигурацией продукта. |
| `DANGEROUS_EVAL`, `vendor/ffmpeg/ffmpeg.js:1` | Webpack global lookup немедленно возвращает `globalThis`, когда он существует; `new Function("return this")` - fallback старого окружения. Проверенные Zen/Chromium имеют `globalThis`, поэтому этот branch не нужен. String eval запрещён текущей CSP; разрешён только `wasm-unsafe-eval`. Удаление fallback изменило бы официальный bundle без улучшения используемого пути. |
| `UNSAFE_VAR_ASSIGNMENT`, `vendor/zipjs/zip-native.min.js:1` | Dynamic import относится к worker setup библиотеки. `MendoArchive.write` задаёт `useWebWorkers: false` и ZIP STORE для writer и каждой entry. Regression test запускает реальные browser scripts с Worker/fetch, которые бросают ошибку, и запрещённым dynamic code execution; ZIP успешно создаётся. |

Обычный lint оставляет warnings видимыми; `lint:extension:strict` завершится ошибкой. Данный разбор не является утверждением о будущем одобрении AMO и не заменяет Mozilla review. При изменении vendor bytes, loader/configuration или warning inventory обоснование нужно пересмотреть.

## Исходники и воспроизводимость

Для JS зафиксированы следующие независимые источники:

- [FFmpeg wrapper/build recipe](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/e0d4c62a229ba58ea0c6e6b881e289f2fefe97c4), [wrapper npm source distribution](https://registry.npmjs.org/@ffmpeg/ffmpeg/-/ffmpeg-0.12.10.tgz). Унаследованная модификация worker полностью описана в provenance; `ffmpeg.js` официальный.
- [Mediabunny source commit](https://github.com/Vanilagy/mediabunny/tree/634186fd5e2dac946bf994a955680b85aceb7709), [npm archive с `src/` и MPL-2.0](https://registry.npmjs.org/mediabunny/-/mediabunny-1.51.0.tgz). Generated jsDelivr bundle использует Rollup 4.62.2 и esbuild 0.28.1 по своему header. Исходники подтверждены, повторная bit-for-bit сборка generated bundle не выполнялась. Runtime не загружает код с CDN.
- [zip.js source commit](https://github.com/gildas-lormeau/zip.js/tree/38508528fe00b094447d9122b7725ab412149e2d), [npm archive с `lib/`, license и native bundle](https://registry.npmjs.org/@zip.js/zip.js/-/zip.js-2.20.0.tgz). Bundle bytes воспроизводимо получены из versioned npm archive; компиляция из `lib/` не повторялась.

## Принятая сборка

10-10-2026 пользователь выбрал сохранить существующее official FFmpeg core без новой toolchain и пересборки. Воспроизводимость локальной поставки проверяется по закреплённым vendor bytes, licenses и inventories; CI дополнительно сравнивает hashes архивов Windows/Linux. Лицензии и ссылки на исходники сохраняются. Подробные исследовательские receipts находятся в игнорируемой локальной QA-области.

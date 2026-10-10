# Подписанный файл MendoSave 0.3.0

Проверено 10-10-2026. Mozilla одобрила и подписала пакет в канале unlisted для самостоятельной установки. Страницы в магазине нет; GitHub-репозиторий остаётся приватным, GitHub release не создавался. Обновления устанавливаются вручную.

## Файл и исходники

Установочный файл: `artifacts/mendosave-0.3.0-unlisted/mendosave-0.3.0-firefox-signed.xpi`, 10 975 255 bytes. Его SHA-256:

```text
f87da052cf94986e34d0261f8919f19a143612ceed5d1374e164a4037df10ecc
```

Рядом сохранены unsigned XPI, дополнительный Chromium ZIP, matching source ZIP, исходный `release-manifest.json`, отдельный `signing-manifest.json` и `SIGNED_SHA256SUMS`. Source snapshot: `fa034ac7748bacd60f53800bbf31e233d4ab1139`; архив содержит 139 файлов. Отчёт результата добавлен после отправки и не меняет этот снимок. SHA-256 отправленного source ZIP:

```text
e0ce7d269dd33fe29309cd2b63b2db5f0ed9da2fa367fbecf3532569f4a9840c
```

Пакет, скачанный с Mozilla, содержит все 57 application files. 56 совпадают с отправленным candidate byte-for-byte; Mozilla переформатировала `manifest.json`, его JSON-содержимое совпадает полностью. Добавлены пять файлов подписи в `META-INF/`; CRC, уникальность имён и состав проверены. `LICENSE` и `THIRD_PARTY_NOTICES.md` сохранены. Chromium ZIP не изменился по сравнению с предыдущим candidate. Наличие файлов подписи дополнено проверкой доверия в настоящем браузере.

## Сохранённое состояние Mozilla

Через Developer Hub прочитаны ID `mendosave@mendozie`, версия 0.3.0, статус «Одобрено» и отметка скрытой версии. Mozilla version ID: `6562236`; file ID: `5106374`. При повторном открытии сохранены release notes, reviewer instructions и matching source; скачанный обратно source ZIP совпал с отправленным по SHA-256. Валидатор Mozilla показал 0 ошибок и три известные vendor warnings, разобранные в [DEPENDENCIES.md](DEPENDENCIES.md). Статус «Одобрено» не используется как утверждение о завершённом ручном review всех внутренних компонентов Mozilla.

## Постоянная установка в Zen

Проверка выполнена в новом отдельном профиле на Windows 11: Zen 1.23.2b / Gecko 157.0.1, geckodriver 0.37.1. Headless браузер использовал WebDriver для установки файла с `temporary: false`; signature settings не менялись. Рабочий профиль пользователя не затрагивался.

До и после полного закрытия и запуска браузера AddonManager подтвердил:

- ID `mendosave@mendozie` и version `0.3.0`;
- `signedState: 2`, равный `AddonManager.SIGNEDSTATE_SIGNED`, при `xpinstall.signatures.required: true`;
- `temporarilyInstalled: false`, `isActive: true`, `userDisabled: false`, `appDisabled: false`;
- сохранение внутреннего UUID после перезапуска.

После перезапуска открытый popup вернул правильные runtime ID/version. Манифест требует Gecko 157.0 или новее; фактическая проверка выполнена на указанной версии Zen, совместимость иных браузеров или версий не заявляется. Шаги ручной установки находятся в [INSTALLATION.md](INSTALLATION.md).

## Конечный медиафайл и границы

После перезапуска в Coub штатным control расширения выбран «Только звук · MP3». Browser downloads API подтвердил один завершённый файл: 1 052 674 bytes, контейнер MP3, одна аудиодорожка MP3, 44 100 Hz, stereo, длительность 43.782993 s. Bytes совпали с ранее проверенным контрольным файлом; `ffprobe` и полное декодирование `ffmpeg` прошли без ошибок. SHA-256 медиафайла: `a8f26de68586ed91878e89ac3ff5d10c20d5fb585714e34641312a2e6528a853`.

Во время проверки harness сначала читал downloads из страницы Coub после создания вкладки без явного выбора, затем неверно декодировал UTF-8 путь на Windows. Исправлены выбор вкладки и encoding, существующая браузерная сессия и скачанный файл сохранены; итоговый readback и полное декодирование завершены. Это ошибки тестового harness, изменений в runtime расширения для их устранения не потребовалось. Тестовый браузер закрыт.

Перед отправкой полный `npm run verify` прошёл: 296 tests, оба build inventories, dependency/outgoing checks и проверка архивов; `web-ext` - 0 errors, 0 notices, три разобранных vendor warnings. Программное изменение этого среза ограничено постоянным Firefox ID и его проверкой сборки. Прочие application bytes сохранены; предыдущие browser/security evidence остаются ограничены фактическим объёмом из [PHASE4_VERIFICATION.md](PHASE4_VERIFICATION.md) и [SECURITY_REVIEW.md](SECURITY_REVIEW.md).

Подписание и постоянная установка выполнены. Пользовательская визуальная приёмка, native YouTube playlist, физический Chromium Save As, полная квота и остальные пределы не закрываются этой проверкой. Публичный выпуск не планируется без отдельного решения. Локальные receipts, логи и screenshots находятся в `.local/signing/` и не включены в Git.

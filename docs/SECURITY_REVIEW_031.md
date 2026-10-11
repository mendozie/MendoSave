# MendoSave 0.3.1 - security diff review

Дата: 10-10-2026. Codex Security scan `d4e7d4bd-187c-4c21-9423-582e64090cdf` завершён; canonical manifest, findings и coverage запечатаны, report и SARIF созданы и прочитаны после завершения.

Проверен неизменяемый диапазон `692df5b57a223c3c4775da46ae8e73e21a28358a..8570cbe0183e2ab2c5c615f29cb5931f97c45ca3`. Все 54 изменённых пути учтены; все 22 исходных файла из authoritative diff inventory рассмотрены. Coverage этого diff - `complete`, кандидатов и reportable findings - 0, незавершённых in-scope candidates - 0. Это результат проверки изменений, а не новый полный аудит репозитория.

Проверка использовала repository-scoped threat model и offline source review. Основные границы: данные страницы остаются недоверенными; browser-authenticated sender, tab/document/package, producer lease и processor instance ограничивают операции; обработчик удерживается во время работы и закрывается только при подтверждённом владении и поздней проверке idle; download ID принадлежит вкладке или processor instance. Рассмотрены отмена/повторный запуск, восстановление, OPFS, ограничения URL/сообщений/таймкодов и сборочные изменения. Разные маршруты имеют разные договоры владения: generic media главным образом привязаны к вкладке, package и raw Twitch дополнительно привязаны к документу.

После reviewed revision исправлено устаревшее описание служебной вкладки Zen в PRIVACY.md и обновлены reviewer notes. Эти редакционные изменения не меняют рассмотренные runtime bytes. Позднейшая коррекция больших text output находится вне данного sealed range; её исторический diff и последующие consumer bounds проверяются отдельно перед подписанием.

## Пределы результата

- Неизменённые vendor libraries, native FFmpeg и WASM internals повторно полностью не аудировались. Пределы предыдущего repository scan сохраняются в [SECURITY_REVIEW.md](SECURITY_REVIEW.md).
- Source byte/time/count limits не доказывают peak heap или native resource bounds. Полная кампания malformed media и memory pressure не выполнялась.
- Security reviewers не запускали приложение, тесты или exploit reproductions. Сценарии настоящих браузеров, 526 tests и строгая проверка конечных файлов - отдельные свидетельства из [V031_VERIFICATION.md](V031_VERIFICATION.md).
- Lifecycle, OPFS/download failure paths и restart рассмотрены по исходникам; реальные QA checks покрывают только записанные сценарии. Отказ сайта или недоступность медиаданных сами по себе не считались уязвимостью.
- Нулевая находка не доказывает отсутствие всех уязвимостей и не расширяет проверенную совместимость браузеров/ОС.

Canonical artifacts остаются в завершённом scan; их machine-specific storage path не публикуется. SHA-256 canonical report: `6335e07655ff0e0cfa7d169ed912bf522600dee8f96dcb9c40ca57d57821c587`. Учтённый инструментом расход: 11 566 091 input tokens, из них 10 968 064 cached; 67 759 output tokens; total 11 633 850. Это token accounting пяти связанных review threads, не цена и не только новые input tokens.

Подпись Mozilla, private PR/CI и постоянное обновление Zen проверяются отдельно. Публичный магазин и смена приватности этим scan не разрешались.


## Коррекция большого текстового output

11-10-2026 завершён и прочитан sealed scan `d042ef9c-9d2b-462d-b5e7-ff5fe1b4df5f` для `aa09bcc915c227d61fff6788e8622f5d63999170..9673e5fba704914d927183ac8df7e9c7b9954c05`. Все семь changed paths учтены, один authoritative production source рассмотрен. Coverage `partial`: один кандидат CWE-400/770 имеет подтверждённый путь подменённого ответа страницы до ограниченного OPFS, но конкретный security impact не доказан; validation и attack-path decision сохранены как deferred. Reportable findings - 0. Это не результат «все риски отсутствуют».

Bounded PoC использовал настоящий consumer, shared PackageUI и PackageIO.handle: forged 9 Mi UTF-16 ASCII сохранил 9437187 UTF-8/BOM bytes; квота 4 MiB отклонила его до chunks. В обоих случаях spool/jobs/ports освобождены. Generic file/transfer/quota/owner limits сохранены; исходный media путь уже допускал больший объём памяти, но с иными OPFS preconditions. Native exhaustion и paused-download concurrency не воспроизводились.

Текущий код после этого snapshot добавляет consumer bounds 32 MiB UTF-8/BOM и ранний SRT/VTT budget. Регрессии проверяют отказ до privileged transfer и полное сохранение допустимого Unicode текста. Эти guards не приписываются историческому scan; итоговый immutable diff проверяется отдельно.

SHA-256 canonical report: `7c2b0f80379790cb2a2057c7309b5e42b2fe218866c6d1c47af2d0bc2ac86184`. Учтено 7171684 input tokens, включая 6805120 cached, и 35919 output; total 7207603. Это accounting связанного thread, не цена и не изолированная стоимость короткого diff. Завершённая scan-цель заняла около 17 минут активного времени; пауза пользователя не считается выполненной работой.

## Итоговые consumer bounds

11-10-2026 завершён и прочитан sealed scan `91ce2aad-9e80-4f14-bb6f-0dce13a76f57` для `9673e5fba704914d927183ac8df7e9c7b9954c05..6c84b8efb7f8741b6f1099e6eaa8fbd5f86fd984`: все шесть changed paths учтены, один authoritative production source рассмотрен вместе с соседними formatter/producer/metadata/OPFS controls. Coverage данного diff complete, candidates/reportable findings/deferred - 0. Исторический deferred-кандидат предыдущего snapshot этим не переименован и не закрыт задним числом.

Проверены early cue count/per-row/aggregate guards, cheap output-length guard до Blob и фактический UTF-8/BOM byte guard до processor/OPFS. MIME, sender/owner/instance, sequence/quota, native completion и cancel cleanup не ослаблены. Root source review и независимый bounded code review согласуются; 541 tests на этом snapshot и native functional QA являются отдельными evidence. Последующие literal-whitespace/filename corrections имеют собственные RED/GREEN и code review; они не приписываются этому sealed range.

SHA-256 canonical report: `b02dc832406fe8b98d0fa908e269dc087de4ff598498dc165d16f274080e9ac1`. Учтено 792629 input tokens, включая 777856 cached, и 4759 output; total 797388 в одном связанном thread. Это accounting, не цена. Полный vendor/native audit и native exhaustion/peak-memory campaign не повторялись.

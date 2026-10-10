# MendoSave 0.3.1 - security diff review

Дата: 10-10-2026. Codex Security scan `d4e7d4bd-187c-4c21-9423-582e64090cdf` завершён; canonical manifest, findings и coverage запечатаны, report и SARIF созданы и прочитаны после завершения.

Проверен неизменяемый диапазон `692df5b57a223c3c4775da46ae8e73e21a28358a..8570cbe0183e2ab2c5c615f29cb5931f97c45ca3`. Все 54 изменённых пути учтены; все 22 исходных файла из authoritative diff inventory рассмотрены. Coverage этого diff - `complete`, кандидатов и reportable findings - 0, незавершённых in-scope candidates - 0. Это результат проверки изменений, а не новый полный аудит репозитория.

Проверка использовала repository-scoped threat model и offline source review. Основные границы: данные страницы остаются недоверенными; browser-authenticated sender, tab/document/package, producer lease и processor instance ограничивают операции; обработчик удерживается во время работы и закрывается только при подтверждённом владении и поздней проверке idle; download ID принадлежит вкладке или processor instance. Рассмотрены отмена/повторный запуск, восстановление, OPFS, ограничения URL/сообщений/таймкодов и сборочные изменения. Разные маршруты имеют разные договоры владения: generic media главным образом привязаны к вкладке, package и raw Twitch дополнительно привязаны к документу.

После reviewed revision исправлено устаревшее описание служебной вкладки Zen в PRIVACY.md и обновлены reviewer notes. Эти редакционные изменения не меняют рассмотренные runtime bytes. Позднейшая коррекция больших text output находится вне данного sealed range; она проверяется отдельным security diff перед подписанием.

## Пределы результата

- Неизменённые vendor libraries, native FFmpeg и WASM internals повторно полностью не аудировались. Пределы предыдущего repository scan сохраняются в [SECURITY_REVIEW.md](SECURITY_REVIEW.md).
- Source byte/time/count limits не доказывают peak heap или native resource bounds. Полная кампания malformed media и memory pressure не выполнялась.
- Security reviewers не запускали приложение, тесты или exploit reproductions. Сценарии настоящих браузеров, 526 tests и строгая проверка конечных файлов - отдельные свидетельства из [V031_VERIFICATION.md](V031_VERIFICATION.md).
- Lifecycle, OPFS/download failure paths и restart рассмотрены по исходникам; реальные QA checks покрывают только записанные сценарии. Отказ сайта или недоступность медиаданных сами по себе не считались уязвимостью.
- Нулевая находка не доказывает отсутствие всех уязвимостей и не расширяет проверенную совместимость браузеров/ОС.

Canonical artifacts остаются в завершённом scan; их machine-specific storage path не публикуется. SHA-256 canonical report: `6335e07655ff0e0cfa7d169ed912bf522600dee8f96dcb9c40ca57d57821c587`. Учтённый инструментом расход: 11 566 091 input tokens, из них 10 968 064 cached; 67 759 output tokens; total 11 633 850. Это token accounting пяти связанных review threads, не цена и не только новые input tokens.

Подпись Mozilla, private PR/CI и постоянное обновление Zen проверяются отдельно. Публичный магазин и смена приватности этим scan не разрешались.

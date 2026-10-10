# Security review MendoSave

Завершён: **10-10-2026**. Выполнен один **Codex Security Standard repository scan**; canonical artifacts успешно проверены и sealed. Статус workflow - `complete`, покрытие - `partial`, открытых reportable findings - **0**. Это результат ограниченного анализа, не доказательство отсутствия всех уязвимостей и не общая приёмка релиза.

## Проверенный исходник

Scan зарегистрирован на `ee081f4aa121b7a006b5be268923cd7d1501308f`. В ходе того же прохода проверены подготовка runtime/pipeline `3d03c784`, CI correction `b8e36805` и последующие разрешённые caption/parser/provenance changes. На момент sealing они были reviewed working snapshot; затем закреплены в **`aaf370a1277209c8b8029d05c25ea4508635058c`**. Commit не запустил новый scan. После commit повторный byte check подтвердил совпадение с уже проверенным runtime snapshot.

Runtime inventory: **58 файлов** под `extension/` и `browser-hosts/`, включая vendor/source/provenance. SHA-256:

```text
e4bb5a420613106ce391a8421275e80a242f00da28728b8ad5f0f3334ff770e7
```

Digest вычислен по отсортированным UTF-8 records: `repository-relative-path + NUL + file-sha256-hex + LF`. Полный source snapshot до этого документа содержал 137 tracked/nonignored-untracked files, digest `81f9f65778be6a4ba905f23e9f5f6806f50ad7c4c81438b362764e6a77618242`. Последующие reporting edits меняют полный source digest; runtime digest фиксирует проверенные bytes независимо от них.

Native scan metadata сохраняет исходный registration revision и warning о смене HEAD. Canonical scope явно описывает фактически проверенный working snapshot и его digest; scan не выдаётся за анализ только неизменённого `ee081f4`.

## Метод и охват

Анализ выполнялся офлайн по исходникам с независимыми baseline, architecture, MAIN-hook и vendor investigators. Прочитаны runtime JavaScript, адаптеры, privileged broker/processor, package/download ownership, URL/redirect controls, OPFS/recovery/rollback, cancellation/lifecycle, diagnostic redaction, build/release/CI scripts и dependency metadata.

Полностью прочитаны пять vendor JavaScript implementations, включая декодированный как данные ZIP worker source. Изменённые Mediabunny TypeScript-файлы и bundle сопоставлены с закреплёнными оригиналами: прямое и обратное применение literal edits воспроизводят точные bytes и hashes. Это проверка преобразования, не повторная компиляция TypeScript. Все 13 записанных vendor/license/source/document files совпали с текущим provenance.

Scan не исполнял приложение, библиотеки или malformed media и не выполнял browser/exploit reproduction. Основной агент отдельно сообщил **295 passed tests / 10 pipeline gates** и затронутые browser/file checks. В scan проверены source contracts и regression fixtures; самостоятельный runtime PASS ему не приписывается. Подробные QA-границы находятся в [PHASE4_VERIFICATION.md](PHASE4_VERIFICATION.md).

## Исправленные deficiencies

| Контроль | Исходная проблема | Проверенное исправление |
|---|---|---|
| Stage/receiving | Page-owned media могла накапливаться без совокупного RAM-предела; stage expiry продлевался chunks. | Trusted-side 750 000 000 bytes/track, 1 500 000 000 total, фиксированный stage TTL 20 минут; adopted/prefix/worker inputs учитываются, overflow освобождает job. Muxed video сохраняет OPFS-путь. |
| Diagnostics | Неограниченный tag и очередь storage writes могли расходовать storage/RAM. | Raw schema/size gate, tag 128, stored text 4 000, 400 records и 32 pending writes; legacy records также ограничиваются. |
| MP4 metadata | Compact counts в `trun`, `stz2`, `stts/ctts` и PCM chunk indices создавали работу без соответствующего чтения bytes. | `stz2` width 4/8/16; 1 000 000 expanded timestamps/chunks или retained fragment samples суммарно по tracks/runs; actual PCM chunk ranges; `ctts` loop ограничен реальной таблицей. Compact raw PCM count сохраняется. |
| AAC progress | ADTS frame length 0 позволяла повторно выдавать packets без продвижения input cursor. | Общий ADTS header parser требует минимум 7 bytes без CRC / 9 с CRC для raw ADTS и MPEG-TS AAC consumers. |

Original candidate payloads, source validation и counterevidence сохранены в canonical coverage. Итоговый `rejected` у этих rows означает исправленный текущий source, а не ошибочность исходной диагностики. Подтверждённый security impact был ограничен локальной доступностью extension при активной media operation; host crash, execution или exfiltration не установлены. Bounded regressions используют actual `Input`, допустимые и malformed cases, scaled test-only budget и terminable child для CPU-only case. AAC runtime regression использует raw ADTS; MPEG-TS route и общий helper проверены по source.

## Пределы покрытия

- Исходный native C/C++ codec/demuxer code FFmpeg не входил в reviewed repository; WASM machine code не проходил полный reverse engineering. JS glue/import/memory metadata проверены. Наличие SOCKFS plumbing не доказывает media-driven native network path; generic SSRF finding не заявлена.
- Byte/sample ceilings не измеряют peak heap, decoded frames или native resources. Полная native memory-pressure campaign и все многочасовые варианты не проверялись.
- Исторические документы получили targeted security/privacy review; binary WebM fixture не декодировалась. CSS/SVG references, PNG metadata и settings screenshots проверены в пределах source/data review.
- Игнорируемые private data, browser profiles, installed dependencies и generated outputs исключены. Advisory/pipeline/browser receipts - отдельные источники проверки.
- Решение сохранить существующий official core и не создавать новую build environment принято пользователем. Scan не устанавливает полную compilation provenance или юридическое соответствие.

Canonical report, threat model, findings и coverage доступны в завершённом Codex Security scan **`4edf6bfd-16fe-4814-9e0d-0eea5f5788b9`**. Его machine-specific storage path не включён в репозиторий. Измерение token usage недоступно (`scan_thread_unavailable`); нулевое потребление или стоимость не предполагаются. Подпись, публикация и пользовательская приёмка остаются отдельными действиями.

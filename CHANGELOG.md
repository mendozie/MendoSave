# Изменения

## 0.3.0 - разработка, 10-10-2026

- Штатный Save As для processor и Page-Blob путей.
- Выбор нескольких форматов одного материала, последовательные отдельные файлы и локальный STORE ZIP.
- Проверки принадлежности package/job/позиции и ручное восстановление подготовленных ZIP inputs.
- Исправление OPFS rollback при отказе записи recovery index или открытия writable.
- Ограничение RAM входящих дорожек, абсолютного срока staging и очереди диагностических записей.
- Ограничения разрастания MP4 metadata и проверка длины AAC ADTS frames с соответствующими изменёнными MPL-исходниками.
- Выбор одной версии transcript и сохранение её таймкодов при экспорте SRT; устранены дубли и искусственные перекрытия.
- Vendor provenance и лицензии, свежий dependency audit, gate для рассмотренных web-ext warnings.
- Детерминированные неподписанные XPI/ZIP/source archives с проверкой извлечённых bytes и Windows/Linux CI.

Подписанного стабильного выпуска ещё нет. Проверенные сценарии, размеры и оставшиеся gates находятся в [ROADMAP](docs/ROADMAP.md) и [PHASE4_VERIFICATION](docs/PHASE4_VERIFICATION.md).

## 0.2.0 - разработка, 10-10-2026

Собственный бренд MendoSave, проверки адаптеров и Chromium regression, локальная диагностика, исправления live WebM и ограничение ожидания cleanup. См. [PHASE2_VERIFICATION](docs/PHASE2_VERIFICATION.md).

## 0.1.0 - разработка, 09-10-2026

Общий исходник для Firefox/Zen и Chromium; отдельные processor hosts, первый проверенный путь video/audio/subtitles и сохранённое происхождение upstream. См. [PHASE1_VERIFICATION](docs/PHASE1_VERIFICATION.md).

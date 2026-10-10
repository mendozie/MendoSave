# Изменения

## 0.3.0 - разработка, 10-10-2026

- Штатный Save As для processor и Page-Blob путей.
- Выбор нескольких форматов одного материала, последовательные отдельные файлы и локальный STORE ZIP.
- Проверки принадлежности package/job/позиции и ручное восстановление подготовленных ZIP inputs.
- Исправление OPFS rollback при отказе записи recovery index или открытия writable.

Подписанного стабильного выпуска ещё нет. Проверенные сценарии, размеры и оставшиеся gates находятся в [ROADMAP](docs/ROADMAP.md) и [PHASE3_VERIFICATION](docs/PHASE3_VERIFICATION.md).

## 0.2.0 - разработка, 10-10-2026

Собственный бренд MendoSave, проверки адаптеров и Chromium regression, локальная диагностика, исправления live WebM и ограничение ожидания cleanup. См. [PHASE2_VERIFICATION](docs/PHASE2_VERIFICATION.md).

## 0.1.0 - разработка, 09-10-2026

Общий исходник для Firefox/Zen и Chromium; отдельные processor hosts, первый проверенный путь video/audio/subtitles и сохранённое происхождение upstream. См. [PHASE1_VERIFICATION](docs/PHASE1_VERIFICATION.md).

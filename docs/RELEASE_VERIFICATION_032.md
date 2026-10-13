# Релизная проверка 0.3.2

Дата: 13-10-2026. Пользователь принял r2 и разрешил merge, подписание, Release обоих движков и публичный GitHub после проверки приватных данных. Предыдущие пакеты и доказательства 0.3.1, первоначального 0.3.2 и r2 сохранены.

## Реализованный результат

Source binding субтитров, современный VK, Back/focus и актуальный idle plan описаны в [проверке исходного кандидата](V032_VERIFICATION.md). Скролл VK, page-origin package transport, drag/close и Save As readiness - в [проверке r2](V032_R2_VERIFICATION.md).

Перед выпуском дополнительно исправлены live-anchor refit VK после scroll/resize/remount и четыре подтверждённых security findings. Оба совокупных review и bounded correction reviews завершены без оставшихся подтверждённых blockers. [Область security review](SECURITY_REVIEW_032.md) записана отдельно.

## Текущие проверки

- Полная suite: **862 PASS / 0 FAIL**; ESLint: 0 errors / 17 прежних warnings. Обе сборки содержат 60 файлов; dependency provenance, license hashes и exact lockfiles прошли.
- В отдельном Zen 1.23.2b / Gecko 157.0.1 Windows подтверждены настоящие pointer/Enter/Space и отказ программных clicks/keydown страницы. Два Coub-файла и ZIP завершены без дополнительных gestures между позициями.
- Видео: H.264 880×720, 10.0 s, 3329944 bytes, SHA-256 `554a6e5d7f861bca719743e2bdaf2a71aad9c7347bdaa2344e43411d8fb0da05`; аудио: MP3 44100 Hz, stereo, 43.782993 s, 1052674 bytes, SHA-256 `a8f26de68586ed91878e89ac3ff5d10c20d5fb585714e34641312a2e6528a853`. Full strict decode: exit 0; начало/конец видео просмотрены, начало/конец аудио имеют ненулевой RMS. ZIP CRC/size/извлечённые bytes совпали с отдельными завершёнными файлами.
- Полный прежний VK 480p повторно проверен по SHA-256 и прочитан текущим shipped parser: 436665925 bytes, H.264/AAC, 5476.672 s. Его полный decode и прежний ZIP сохранены в r2 evidence; это повторная проверка parser на существующем контроле, не новая загрузка 480p.
- Native VK сохранил то же меню при wheel и пяти resize/scroll состояниях, сохранил bounds и доступ к значку; повторный click не создал download. Синтетическая отмена отклонена, настоящая завершила cleanup. Активный крестик недоступен; Hide/reopen, четыре drag edges и полное закрытие проверены.
- README screenshots: реальные settings 0.3.2 и delivered package component с нейтральными demo labels. Viewports popup: 1246×883 / 326×843; package: 1246×983 / 326×843. Полные viewport screenshots просмотрены; пользовательские URL, имена и аккаунты в публичные изображения не включены.

## Оставшиеся этапы выпуска

CI Windows/Linux/reproducibility, managed PR review, финальный clean source snapshot, unlisted signed payload, постоянное обновление/restart Zen и saved public Release state фиксируются после выполнения. Наличие unsigned build не считается подписью или публикацией.

Проверки конкретных сценариев не подтверждают все площадки, codecs, версии браузеров и другие ОС. Реальное заполнение дисковой квоты и physical chooser Chromium остаются прежними gaps. Workspace/browser profiles и private QA не публикуются.

Дополнительный Native Edge 155.0.4283.45: trusted pointer/Enter/Space и отказ synthetic events, два файла и ZIP, полное закрытие; viewports 1280×900 / 360×800. Оба файла совпали по SHA-256 с полностью декодированными Zen controls, ZIP CRC и извлечённые bytes совпали. CDP Enter включает native keypress; прежний неполный тестовый ввод не считался дефектом расширения.

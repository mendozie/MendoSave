# Проверка выпуска 0.4.0

Дата: 15-10-2026. Версия - 0.4.0, постоянный ID - `mendosave@mendozie`. Пользователь принял общий интерфейс B, запросил небольшую правку выравнивания и прямо разрешил commit, обновление документации/скриншотов, Mozilla unlisted signing и GitHub Release. Подготовка идёт в [PR #10](https://github.com/mendozie/MendoSave/pull/10); общий порядок ручной приёмки будущих изменений сохраняется.

**Состояние: проверки исправлений выполнены локально; окончательные review/CI, frozen package, Mozilla signing, signed upgrade, Release/readback и merge ещё не завершены.** Пакеты прежних кандидатов и выпуска 0.3.3 сохраняются отдельно и не перезаписываются.

## Шапка и документация

Причина разницы уровней - отдельные flex items с разными line boxes для заголовка/источника и текстовые символы grip/close; Back SVG имел геометрию, сдвинутую вправо. Шапка теперь использует grid для четырёх областей и общий baseline заголовка/источника. Grip и close используют существующую SVG-систему; Back имеет границы `(6, 6, 12, 12)` в viewBox 24×24. Название источника сокращается, заголовок остаётся видимым.

| Проверка | Zen 1.23.2b / Gecko 157.0.1 | Edge 155.0.4283.45 |
|---|---|---|
| Actual viewport | 1440×1000 и 360×800 | 1440×1000 и 360×800 |
| Центры Back/grip/close | Совпадают | Совпадают |
| Baseline заголовка/источника | Разница 0 px | Разница 0 px |
| Back SVG | Центр (12,12), transform none | Центр (12,12), transform none |
| Controls | Back Enter, X trusted click, drag +65/+30, Tab/Shift+Tab | Те же действия прошли |

Рассмотрены полноразмерные viewport screenshots и отдельные элементы. Это реальные установленные компоненты расширения на синтетической нейтральной странице, без скачивания медиа и без заявления о новом real-site E2E. Popup открыт как extension tab; physical toolbar popover отдельно не проверен. Созданные browser/driver процессы завершены с readback, профили сохранены.

README теперь содержит новые [settings](images/settings-zen-040.png) 316×520 и [package](images/package-zen-040.png) 480×412. Старые 0.3.3 изображения сохранены. PNG содержат только IHDR/IDAT/IEND, текстовые метаданные не обнаружены; точные копии совпали с источниками по SHA-256. Размеры element screenshots не выдаются за размеры viewport.

## Парсеры и локальные проверки

Новый Standard security scan завершён с тремя medium findings до исправлений. MP4, FLAC и AV1 исправлены через общие parser boundaries; [область, воспроизведение и ограничения](SECURITY_REVIEW_040.md). Исходный запечатанный отчёт сохраняет findings. Новый scanner run с нулевыми findings не заявляется.

- 81 PASS в четырёх затронутых parser/Instagram suites, включая девять новых public-boundary tests; TDD RED/green воспроизведение сохранено.
- Scoped ESLint и `git diff --check` прошли.
- Свежий независимый review parser corrections не выявил подтверждённого surviving bypass или новой регрессии; все шесть transforms и восемь vendor entries сверены отдельно. Совокупный UI diff также проверен локально против UIB-006 и native evidence.
- Dependency/license hashes и exact lockfiles прошли; все шесть deterministic source/bundle transforms обратимы.
- Firefox и Chromium builds по 69 файлов; manifests, CSP, references, inventory hashes и build hygiene прошли.
- `web-ext`: 0 errors, 0 notices, четыре прежних reviewed warnings. Outgoing scan: 0 findings; бинарные fixtures/изображения проверены отдельно.

Полный набор tests вручную не запускался повторно. Прежние проверки media/ZIP и сайтов относятся к замороженному кандидату, описанному в [UI_B_VERIFICATION.md](UI_B_VERIFICATION.md) и [INSTAGRAM_VERIFICATION.md](INSTAGRAM_VERIFICATION.md). Неизменённые участки используют эти evidence; проверка текущего diff и постоянной установки записывается отдельно.

## Оставшиеся шаги выпуска

1. Завершить независимый correction review и Windows/Linux CI с archive reproducibility для frozen revision.
2. Сохранить новые unsigned Firefox/Chromium/source archives, сверить CRC, application bytes, Git source и SHA-256; прежние пакеты не изменять.
3. Отправить matching Firefox/source через встроенный браузер, прочитать сохранённые Mozilla ID/version/channel/status/reviewer notes, получить signed XPI и сверить application/source bytes.
4. Проверить постоянное обновление 0.3.3 → 0.4.0 в новом отдельном Zen: подпись, ID/UUID/настройки, полный restart и затронутая шапка. Настройки проверки подписей не менять.
5. Опубликовать шесть Release assets, скачать их обратно и сверить hashes/размеры/CRC, обновить фактические ссылки и выполнить guarded merge проверенного PR head.

Закрытый Instagram не проверен по решению пользователя. Прежний native MP3 disconnect в долгоживущем Zen не приписывается новым parser corrections; его причина не установлена, а контроль после restart прошёл на прежних frozen bytes. Другие ОС и все производные браузеры не считаются проверенными.

# Проверка безопасности 0.3.2

Дата: 13-10-2026. Область: отслеживаемый репозиторий и границы расширения; исходный snapshot `9de12ba31bef5cc5b8b26ec3e5f75173871c76cc`. Локальные профили, credentials и журналы проверки в публичные материалы не включаются.

Standard scan завершён с частичным покрытием. Независимый baseline полностью рассмотрел 57 файлов; остальные крупные hooks, адаптеры, тесты, документы и vendor binaries проверялись по конкретным границам и признакам credentials. Исходников C/C++ FFmpeg в checkout нет; полная проверка native/WASM memory safety не заявляется.

| Подтверждённая проблема исходного snapshot | Уровень | Исправление |
|---|---|---|
| MP4 physical sample tables разрастаются до ограничения metadata | Medium | Совокупный бюджет до чтения/материализации всех затронутых таблиц, включая повторные boxes/tracks; compact constant-size PCM сохраняется |
| Duplicate `tfra` timestamps вызывают повторное перемещение массива | Medium | Бюджет index entries/revisits и линейное стабильное уплотнение после сортировки |
| Shared acyclic diagnostic objects разрастаются при JSON serialization | Medium | Ограниченная redacted projection до content forwarding и независимо в фоне; пределы обхода и текста |
| Синтетические DOM events страницы запускают действия расширения | Low | Проверка настоящего клика или исходного keyboard event в isolated callbacks; внутреннее продолжение принятой очереди сохраняется |

Все четыре исправления прошли отдельный review исходников и затронутых границ. Детерминированная forward/reverse трансформация Mediabunny совпала с закреплёнными originals; full MPL sources, bundle и provenance синхронизированы. Регрессионные проверки выполняют реальные parser/diagnostic/DOM boundaries с малыми входами; большие аварийные heap/crash эксперименты не выполнялись.

Полная suite: **862 PASS, 0 FAIL**. В отдельном Zen настоящий Enter/Space запускает два файла Coub и ZIP, а `.click()`/page-dispatched events не запускают работу; синтетическая отмена VK отклоняется, настоящая отмена завершает cleanup. Новые MP4/MP3 полностью декодированы; ZIP entries совпали с завершёнными отдельными файлами. Текущий shipped MP4 parser прочитал прежний полный контрольный 480p: 436665925 bytes, H.264/AAC, 5476.672 s; его bytes сверены повторно.

Перед открытием репозитория дополнительно проверены 32 достижимых commits, 420 уникальных версий файлов, GitHub metadata семи PR, шесть опубликованных файлов 0.3.1, 22 журнала Actions и 44 архива Actions с 132 вложенными архивами. Приватных ключей, cookies, токенов пользователя и сохранённых приватных медиассылок не обнаружено. Credential-like совпадения разобраны как публичные web-client identifiers и явные отрицательные fixtures. Это проверка с известными шаблонами и просмотром контекста, а не доказательство отсутствия любого возможного кодирования секрета.

Исходный scan сохраняет четыре finding исходного revision; исправления не переписывают его в результат «0 findings». Финальные source/archive/signature/CI readbacks записываются в релизной проверке и roadmap. [Исторический scan 0.3.0](SECURITY_REVIEW.md) не заменяет этот проход.

Managed PR review `52c209d88f15bb6e4b126eb9fcb376438ef3585f` дополнительно выявил обход aggregate budget через `saiz`. В версии 0.3.3 count расходует тот же бюджет до retention/lazy resolution, независимо от constant/variable размера и повторных boxes. Малый actual parser regression сначала воспроизвёл отказ ограничения, затем прошёл вместе с 864 tests и forward/reverse parity. Это последующая correction verification, а не переписанный полный scan. Diagnostic export также сохраняет последние записи при переполнении; [проверка окончательного выпуска](RELEASE_VERIFICATION_033.md).

Дополнительный Native Edge 155.0.4283.45: trusted pointer/Enter/Space и отказ synthetic events, два файла и ZIP, полное закрытие; viewports 1280×900 / 360×800. Оба файла совпали по SHA-256 с полностью декодированными Zen controls, ZIP CRC и извлечённые bytes совпали. CDP Enter включает native keypress; прежний неполный тестовый ввод не считался дефектом расширения.

Последующая проверка 0.3.3 дополнительно воспроизвела и закрыла PSSH и senc/lazy-subsample обходы aggregate budget; полный набор - 867 PASS. Итоговый независимый correction report недоступен после cybersecurity flag сервиса; выполнены собственный source/caller review и малые public Input/packet regressions. Финальный snapshot не называется повторным полным scan.

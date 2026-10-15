# Общий интерфейс B - кандидат 0.4.0

Дата: 15-10-2026. Срез UIB-001..UIB-005 реализован поверх исходного Instagram-кандидата `5d09469`. Опубликованная версия остаётся 0.3.3. Порядок ручной приёмки, merge и выпуска задаёт [AGENTS.md](../AGENTS.md); текущая работа не разрешает выпуск.

## Результат

Общая тема, SVG-иконка и компактные группы подключены к Instagram, YouTube/Music/Shorts, VK Видео, TikTok, Coub, Rutube, Twitch и Звуку. Специфичные способы запуска, live controls и субтитры сохранены. Musify остаётся отключённым.

Пакет использует однострочную шапку B высотой 48 px: стрелка «Назад» в рамке, заголовок, сокращаемый источник, захват перемещения и закрытие. Список прокручивается отдельно, количество и действия закреплены снизу. Семья содержит основной вариант и раскрываемые дополнительные; несколько качеств одного элемента можно отметить независимо. Первоначальный выбор пуст. «Выбрать всё» отмечает по одному основному варианту каждой основной семьи; отдельное аудио, TXT и субтитры выбираются вручную. Для аудиотрека без видео, включая Music art track, основным результатом является аудио. Все скрытые отметки учитываются в пределе 64; при 65 запуск запрещён без сокращения выбора.

Instagram показывает одну карточку на фото/видео с выбором качества. Аудио и описание раскрываются отдельно; альтернативные пропорции фото обозначены явно. Значок находится над лайком справа от активного Reel при наличии этой колонки. При отсутствии колонки используется ограниченная краем viewport позиция. Меню открывается рядом при достаточном месте и адаптируется в узком окне.

Back/reopen того же статичного источника используют проверенный снимок и совместимые качество, раскрытие и scroll. Смена источника и ошибка требуют нового чтения. Live-данные и текущие caption settings YouTube не замораживаются. Закрытие меню не отменяет принадлежащий скачиванию refresh; явная отмена и смена источника продолжают его останавливать. После refresh нельзя молча подменить исчезнувшее качество.

Новых dependencies, host permissions, web-accessible resources или CSP exceptions нет. Исправлен существовавший дефект обработчика: startup sweep `packageIO` больше не разрывает чужие runtime ports; собственные transfer/package ports сохраняют запрет sweep и проверки sender/owner. Форматы сообщений, медиапреобразование и bundled vendors в этом срезе не менялись. [Первый отчёт Instagram](INSTAGRAM_VERIFICATION.md) относится к прежнему frozen runtime и сохранённым исходным пакетам.

## Автоматические проверки и review

| Проверка | Результат |
|---|---|
| Полный `npm test` | 1042/1042, без failed, skipped и cancelled |
| TDD состояния | Back/reopen без нового metadata-запроса; раскрытие/scroll; смена источника; error invalidation; совместимость качества; forged actions; сохранение work-owned refresh при X/Escape |
| TDD пакета | Независимые real options, primary quality, hidden selection, Select all/clear, Music audio primary, busy locks, 64/65, возврат фокуса без сброса scroll |
| TDD ports | Удерживаемая OPFS initialization воспроизводит disconnect чужого producer до исправления; после исправления чужой port игнорируется, собственные transfer/package по-прежнему отклоняются |
| Build/provenance | Firefox и Chromium по 67 файлов; manifest/references/CSP/inventory, exact lockfiles и license hashes прошли |
| ESLint | 0 errors, 17 существовавших warnings |
| `web-ext` | 0 errors, 0 notices, 4 рассмотренных warnings: bundled parser import и три предупреждения vendor-кода. Strict lint их отклоняет |
| Outgoing scan | 0 findings; 7 рассмотренных fixture matches и один сохранённый upstream build path |
| Internal review | Совокупный UI diff и corrections проверены; значимых открытых findings нет. Поздние Music/port corrections и callers проверены отдельно |

Internal/native review выявил повторное чтение non-Instagram меню, потерю disclosure/scroll, недостаточную глубину поиска Reel rail, выход Coub за narrow viewport, лишний TikTok cache, неинвалидированный Instagram snapshot после media failure и отмену work-owned refresh при закрытии меню. Причины исправлены и проверены соответствующими regression tests/native сценариями.

## Реальные браузеры

Проверены Zen 1.23.2b / Gecko 157.0.1 и Edge 155.0.4283.45 на Windows, в отдельных профилях проверки с отключённым звуком. Начальные auth/anonymous проходы обоих движков и финальные auth проходы разделены в evidence. Рабочие профили и signature checks не менялись.

| Сценарий | Наблюдаемый результат |
|---|---|
| Reel, смешанная карусель, отдельное фото | Оба движка, с входом и без: initial zero, Select all, keyboard quality, advanced variants, Back без дополнительного source HTML request, память выбора/раскрытия/scroll, Hide/resume, доступный footer. Drag проверен в Zen |
| Viewport | Zen 1230 × 975 / 306 × 775; Edge 1440 × 1000 / 360 × 800. Реальные screenshots и controls проверены: header 48 px, список прокручивается отдельно, footer доступен |
| Позиция Instagram | Wide Reel: общая ось с лайком, нижний край значка на 14 px выше него. Узкий Instagram не всегда показывает rail; проверен bounded fallback. Меню/пакет помещаются в viewport |
| Files/ZIP | Все четыре engine/session сочетания: Cancel 0/3, retry, MP4 + исходный M4A + TXT отдельно и ZIP. Full/endpoint decode, UTF-8, CRC и exact extracted bytes прошли |
| Финальная build7 | После полного restart Zen и в свежем Edge: MP3 + TXT и progressive MP4 + M4A + TXT, files/ZIP, full/endpoint decode и exact extracted bytes прошли. Edge дополнительно Cancel 0/3 → retry; recovery index 0 → 0 без изменения |
| Adaptive MP4 | Финальный Zen: 720 × 1280 H.264/AAC, M4A и TXT сохранены отдельно и в ZIP, извлечённые файлы полностью декодированы. Между независимыми mux runs MP4 отличаются 10 bytes creation/modification timestamps в пяти header boxes; все остальные bytes совпадают. Это не whole-file equality и не наблюдение prepared inputs того же adaptive ZIP |
| SPA | Вошедший Zen: доверенный переход к следующему Reel сбросил прежнее меню/выбор и потребовал новое чтение |
| Coub/YouTube | Реальные меню Zen: metadata 1 → 1 → 1 при Back/reopen. YouTube lightweight caption probe 1 → 2 → 3 допустим; основной info не перечитывается. Scroll Coub 59 → 59 → 59 и YouTube 178 → 178 → 178 сохранён через Back и Escape/reopen; resize проверен |
| Общие компоненты | Оба движка: установленные `MendoMenu`/`MendoPackageUI` на синтетических строках семи non-Instagram адаптеров, keyboard и screenshots. Финальный Music fixture: initial zero → Select all AAC 1; clear → native quality End → Select all MP3 1, caption не отмечен. Это не full live-проверка адаптеров |

## Контролируемые отрицательные сценарии

В Edge использовался явно синтетический transport на реальной странице через установленные reader/UI/executor, без production debug bridge.

- Истёкший photo URL возвращает 403, свежая metadata содержит другое качество. Повтор явно отклоняет исчезнувший выбор; reopen показывает новый вариант без несовместимой отметки. Новый JPEG полностью проверен по bytes.
- При совместимом качестве второй reader response удерживается, пользователь закрывает меню крестиком, ответ освобождается. Загрузка завершается готовым JPEG; reopen сохраняет совместимую отметку.
- 65 реальных checkbox options в одной семье: Select all выбирает один primary; 64 скрытые отметки учитываются и допускают запуск. Доверенный выбор 65-го качества и сворачивание не скрывают превышение: оба запуска запрещены. Clear возвращает ноль, backend job не создаётся.

## Сбой Zen и границы вывода

В длительно работавшем тестовом сеансе build5 MP3 + TXT дважды завершился разрывом связи с обработчиком, 0/2, без файлов. Логи не установили причину. После полного restart **та же frozen build5** в том же профиле успешно сохранила фото + TXT и MP3 + TXT, files/ZIP. Исправленная build7 прошла MP3 + TXT, progressive video + M4A + TXT и adaptive media проверки. Причинная связь найденного startup port defect с первоначальным native-сбоем не доказана; успешный restart не используется как доказательство исправления именно этого сбоя. Исходные отрицательные отчёты сохранены.

Закрытая публикация Instagram не проверена: контрольного примера нет, пользователь разрешил пропуск. TikTok при bounded live-попытке показал landing page без видео/кнопки; этот live-сценарий не подтверждён. Остальные live-площадки за пределами Coub/YouTube заново целиком не проверялись. Popup document проверен во вкладке; физический toolbar popover этим не подтверждён. Другие браузеры/ОС не проверены.

Screenshots, JSON, отрицательные отчёты, контрольные файлы, package receipts и readback остановки собственных browser/driver процессов находятся в игнорируемом `.local/qa/ui-b-15-10-2026/`. Они нужны до ручной приёмки, в Git/архивы не входят. Cookies, токены, browser profiles и подписанные media URLs в публичный отчёт не включены.

## Передача

Завершаются review текущего UI-среза и проверка отдельно упакованного unsigned кандидата. Его каталог - `artifacts/mendosave-0.4.0-ui-b/`; прежний `artifacts/mendosave-0.4.0/` сохраняется без перезаписи. Предыдущие два managed review исходного Instagram-среза не считаются review нового UI diff.

PR остаётся draft и не объединяется. Следующий шаг после передачи пакетов - ручная проверка пользователя; merge, подпись и Release требуют нового прямого поручения.

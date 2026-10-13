# MendoSave 0.3.2-r2 - исправления ручной проверки

Дата: 13-10-2026. Base: `5ef99bb01e508f9e0b6ffc428b2fdfd33f64d567`, branch `fix/032-source-and-package-ux`. Срез остаётся локальным и неподписанным. Внутренний manifest version - `0.3.2`; обозначение `r2` отличает повторную поставку от сохранённого исходного кандидата. Точный revision, inventories и hashes каждой поставки находятся в её `release-manifest.json`.

## Исправления

- VK-меню сохраняется при прокрутке страницы. Повторный клик по значку, клик снаружи и Escape закрывают его. Длинный список больше не перекрывает значок: размещается сбоку либо ограничивается по высоте с внутренним скроллом.
- Окно пакета перемещается левой кнопкой мыши за верхнюю область. Положение ограничивается viewport, пересчитывается после resize и сохраняется при Hide/reopen. Поля и кнопки не запускают drag.
- Крестики в диалоге и нижней кнопке скрытого пакета полностью убирают оба элемента в idle/terminal. Во время загрузки, отмены и cleanup оба крестика отключены; Hide/Cancel сохраняются. Close не вызывает Back или отмену.
- Progressive video пакета VK читается из контекста страницы по 1 MiB и передаётся через существующий producer/Blob protocol в OPFS. Одиночное browser download сохранено. Новых permissions, auth operations, серверов, программ или remote code нет. Прежний audio Range остаётся 8 MiB; общий reader проверяет доступные headers и точный размер, ограничивает body и освобождает его при ошибке/отмене.
- Save As уже находится в popup значка расширения: «Сохранение файлов» → «Спрашивать, куда сохранить». Исправлена отдельная startup race: controls доступны после saved settings и установки listeners. При ошибке чтения controls остаются отключёнными с понятным сообщением. Default Downloads и расположение настройки сохранены.

## Диагностика и автоматические проверки

Исходный XPI установлен в собственный отдельный Zen с обязательной проверкой подписей. На сообщённом пользователем VK-материале реально воспроизведены оба сбоя: меню исчезло при изменении scrollY без смены источника; пакет 480p завершился NetworkError и 0/1.

Реальный extension-origin CDN GET получил HTTP 400, длину 2 и отсутствие ACAO. Тот же actual URL дал HTTP 200 и длину 436665925 из MAIN страницы. После исправления проверен именно установленный ISOLATED adapter: GET `bytes=0-1048575`, HTTP 206, длина 1048576, request Origin/ACAO страницы и loading/trigger schemes HTTPS. Подписанные query и пользовательские cookies не экспортировались в отчёты или Git. Точное правило отказа на стороне CDN не выводится из этих наблюдений.

Дополнительная native проверка обнаружила перекрытие значка строкой 720p. Одного исчезновения меню было недостаточно: повторный клик запускал файл. Исправление размещения прошло отдельный RED→GREEN; итоговый native dismissal дополнительно проверяет отсутствие новых download IDs. Незапланированная собственная 720p-загрузка отменена и подтверждена как USER_CANCELED; файлы пользователя не затрагивались.

Итоговый полный набор: **851/851 PASS**, без skipped/cancelled. ESLint: 0 errors / 17 прежних warnings. Оба build inventories содержат 60 файлов; manifest/references/CSP/hashes/hygiene проверки прошли. `web-ext`: 0 errors / 0 notices / 3 прежних vendor warnings. Dependency provenance/lockfiles/licenses прошли; runtime audit - 0 entries, tooling audit - 3 записи прежней рассмотренной node-forge цепочки.

Совокупный code review включает requirements и ownership/lifetime contracts. Независимые проверки UI и VK transport/menu не выявили оставшихся подтверждённых defects; дополнительный transport набор - 108/108 PASS. Проверены exact bytes, диапазоны через 8 MiB, ignored/short/oversized Range, размер выше 1 GiB, redirects/credentials, pending read, writer failure, producer/transfer loss, cancellation drain, запрет overlap, retry и ZIP bytes. Старые failures fixtures и промежуточные ошибочные browser oracles сохранены; их исправление не выдаётся за product RED.

## Native результат

Среды: собственные headless Zen 1.23.2b / Gecko 157.0.1 и Edge 155.0.4283.45 на Windows. Рабочие профили и Google Chrome не использовались; профили не копировались. Временная установка Zen активна при `signatureRequired=true`, `signedState=0`. Изменённые runtime assets совпали с соответствующим `dist` по SHA-256: 14 в Zen, 10 в Edge.

| Проверка | Подтверждённый результат |
|---|---|
| VK-меню, Zen и Edge | Trusted wheel вверх/вниз меняет страницу при том же источнике; меню сохраняется. Повторный pointer click закрывает его без нового download. В Zen дополнительно outside click и Escape. |
| Окно пакета, Zen | Реальные LMB drags к четырём краям, narrow resize, Hide/reopen и оба ×. Viewports 1726×1183 и 326×843; screenshots просмотрены. Native Enter/Space и сохранение выбора после Close прошли. |
| Окно пакета, Edge | Viewports 1440×1000 и 360×800; реальные mouse/keyboard controls, clamping, Hide/reopen, оба × и выбор после Close. Скриншоты просмотрены; никакой download этими UI действиями не начат. |
| Active Close и отмена, Zen | После реальных данных оба × отключены. Click disabled chip ничего не закрывает; Hide/reopen и active drag сохраняют job. Cancel завершает cleanup, возвращает controls и не сохраняет поздний файл. Новый ZIP run после отмены завершён. |
| Save As popup | Native Space меняет setting; новый документ восстанавливает сохранённое значение в обоих браузерах. Значение возвращено к default false. Wide/narrow screenshots просмотрены. |
| Полный VK 480p | Native download `complete`, `exists=true`, 436665925 bytes; MP4/H.264, 852×480, AAC. Полное strict декодирование видео и аудио прошло; начало/конец просмотрены, обе audio edges дают конечный ненулевой RMS. |
| VK ZIP 480p + 144p | STORE, ровно две выбранные позиции, CRC/extracted byte counts проверены. 144p: 111689500 bytes, MP4/H.264, 256×144, AAC; полный decode и edges прошли. Оба извлечённых файла совпали по SHA-256 и размеру с самостоятельными контрольными загрузками, завершёнными до начала нового ZIP run. |

Оба MP4 имеют длительность 5476.672 s; captured player - 5476.646 s, отклонение +0.026 s сохранено как измерение. SHA-256 480p: `a6d293554fab3eb33bf863f2f0d8d4f70d764c833c9c3df891a78318ab40e474`; 144p: `eddda731e3ee7744334375fa97d6e16fb937870c139ffa09c1e90285cf25dc29`.

Новые private receipts, screenshots, logs, completed media и exact review hashes находятся в ignored `.local/qa/candidate-032-fixes-13-10-2026/`. Исходные 0.3.1/0.3.2 packages, checkpoints и старые доказательства сохраняются. Собственные Zen, WebDriver и Edge остановлены после проверки identity/PID; отсутствие процессов и освобождение портов подтверждены. Профили и контрольные файлы сохранены как доказательства до ручной приёмки.

## Поставка и ручная проверка

Отдельная папка `artifacts/mendosave-0.3.2-r2/`: unsigned Firefox XPI, unsigned Chromium ZIP, matching source ZIP, `release-manifest.json` и `SHA256SUMS`. Архивы сохранены из чистого локального runtime commit `94a04d46fa090d26d0c6653ec377dbef97959fe4`. Независимый readback проверил CRC и точные bytes: по 60 entries в двух сборках, 167 source entries с совпадением Git bytes указанного revision. Последующий документальный commit записывает завершение поставки, не меняя runtime или frozen source. Исходные 124 защищённых файла, включая папки поставок 0.3.1/0.3.2, совпали с прежними размерами и SHA-256.

| Архив | Bytes | SHA-256 |
|---|---:|---|
| `mendosave-0.3.2-r2-firefox-unsigned.xpi` | 34441566 | `2aa9c02982b6bf8f1126303d07ebe9e5db0846aa0a745a00f1f26a82a798c942` |
| `mendosave-0.3.2-r2-chromium-unsigned.zip` | 34442549 | `43adefe7cd9d83b64da3c7cdd7037a44f67d5fa1ed1d5de5d5db5986e8b9627d` |
| `mendosave-0.3.2-r2-source.zip` | 35863267 | `78a582edd2bb6554377a4da70a1872e859b0d3b7b8e1fb3b23f250fd894194b0` |

В Zen открой `about:debugging#/runtime/this-firefox` и загрузи новый `mendosave-0.3.2-r2-firefox-unsigned.xpi` как временное дополнение. Обнови открытые VK/YouTube страницы. Внутренняя версия остаётся 0.3.2; новый файл и крестик/область перетаскивания отличают r2. Обычная постоянная установка unsigned XPI не используется; настройки подписей менять не нужно.

Для Save As открой popup MendoSave из меню расширений/панели браузера и включи «Спрашивать, куда сохранить». Это настройка всех файлов и ZIP, а не строка в меню плеера.

Физический toolbar popup и Windows chooser этим headless проходом не проверены. Загрузка пакета подтверждена на том же публичном материале в отдельном анонимном Zen; пользовательская авторизованная сессия не копировалась и не проверялась. Chromium media transport, все qualities/площадки и количественный native heap profile не объявляются проверенными. Heap браузера не приравнивается к 1 MiB собственного Range buffer. Требования будущего публичного security scan, ручной приёмки и нового разрешения на публикацию/подписание сохраняются. Push, PR, merge, tags, Release и Mozilla signing не выполняются.

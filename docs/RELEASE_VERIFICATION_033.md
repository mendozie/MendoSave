# Релизная проверка 0.3.3

Дата: 13-10-2026. Версия сохраняет принятые исправления 0.3.2/r2 и разрешённый browser-only подход. Промежуточный commit `52c209d88f15bb6e4b126eb9fcb376438ef3585f` прошёл CI Windows/Linux/reproducibility и был отправлен в Mozilla, но не распространяется через GitHub Release: managed PR review обнаружил ещё три замечания. Исправленный пакет получает новый patch version 0.3.3; прежние архивы и доказательства сохранены.

## Коррекции PR review

- `saiz` sample count раньше обходил aggregate MP4 budget. Малый actual `Input` fixture сначала не отклонял oversized count; после исправления constant/variable sizes и повторные boxes отклоняются до сохранения, допустимый fixture сохраняет длительность. Shipped bundle и полный MPL source проходят deterministic forward/reverse parity.
- Финальное prefix-only ограничение diagnostic export теряло State и последние журнальные записи. Regression сначала воспроизвёл потерю; теперь отдельно ограничены header/error/details/state и выбрана последняя часть bounded journal в исходном порядке. Общий export остаётся ограниченным и redacted.
- Manifest больше не называет рабочее расширение тестовым кандидатом. Package version, lockfile, manifests и фотографии согласованы с 0.3.3.

Независимый reviewer обнаружил соседние PSSH/senc gaps, но сервис заблокировал его итоговый отчёт с пометкой cybersecurity risk. Завершённый независимый correction review не заявляется. Собственная проверка подтвердила и исправила physical/aggregate PSSH key bounds, повторные senc rows и inline/lazy subsamples до allocation. Малые actual Input/packet regressions сначала воспроизвели обходы; valid fixtures сохранили duration/no-key refusal. Полные три modified MPL sources и четыре deterministic transformations согласованы. Большие аварийные входы и crash experiments не выполнялись.

## Фактическая проверка

867 tests PASS, 0 FAIL; ESLint 0 errors / 17 прежних warnings. Обе сборки по 61 файлу; manifests/CSP/inventory, provenance/licenses/exact lockfiles прошли. Dependency audit: runtime 0; только три прежних reviewed tooling entries. web-ext: 0 errors / 0 notices / 3 reviewed vendor warnings.

В отдельном Zen 1.23.2b / Gecko 157.0.1 временная 0.3.3 активна при обязательной проверке подписей. Настройка Save As изменена настоящей клавишей и сохранилась после открытия popup. Actual worker/export/native download завершил TXT длиной 23404 characters: последние записи, State и Details присутствуют, dummy secret скрыт, старейшие записи исключены. Восемь runtime assets совпали с dist на момент съёмки; последующая parser correction сохраняет UI assets.

Новые фотографии 0.3.3 и полные viewport screenshots просмотрены: popup 1246×883 / 326×843; package 1246×983 / 326×843. Package photo показывает delivered component с нейтральными demo labels; это иллюстрация UI, а не загрузка материала. Приватные ссылки, названия пользовательских файлов и аккаунты не включены.

Native Zen/Edge package, media decode/ZIP bytes, source ownership, VK menu/drag/cancel и исходные security corrections проверены на 0.3.2; точные сценарии находятся в [предыдущей проверке](RELEASE_VERIFICATION_032.md). Эти неизменённые пути повторно покрыты полной suite. Отдельная проверка подписанного окончательного пакета, обновления, cold restart и конечного медиафайла фиксируется ниже после выполнения.

## Оставшиеся этапы

Собственный correction review завершён; CI нового head, clean source freeze, Mozilla source/payload readback, signed upgrade/restart, guarded PR merge, публичная видимость и шесть Release assets. Каждый внешний результат отмечается только после проверки saved state.

Остальные браузеры/ОС, physical chooser Chromium, фактическая дисковая квота и все материалы площадок не объявляются проверенными.

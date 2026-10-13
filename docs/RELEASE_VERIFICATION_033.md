# Релизная проверка 0.3.3

Дата: 13-10-2026. **[MendoSave 0.3.3 выпущена](https://github.com/mendozie/MendoSave/releases/tag/v0.3.3)**, репозиторий публичный. Версия сохраняет принятые исправления 0.3.2/r2 и разрешённый browser-only подход. Промежуточный commit `52c209d88f15bb6e4b126eb9fcb376438ef3585f` прошёл CI Windows/Linux/reproducibility и был отправлен в Mozilla, но не распространяется через GitHub Release: managed PR review обнаружил ещё три замечания. Исправленный пакет выпущен с новым patch version 0.3.3; прежние архивы и доказательства сохранены.

## Коррекции PR review

- `saiz` sample count раньше обходил aggregate MP4 budget. Малый actual `Input` fixture сначала не отклонял oversized count; после исправления constant/variable sizes и повторные boxes отклоняются до сохранения, допустимый fixture сохраняет длительность. Shipped bundle и полный MPL source проходят deterministic forward/reverse parity.
- Финальное prefix-only ограничение diagnostic export теряло State и последние журнальные записи. Regression сначала воспроизвёл потерю; теперь отдельно ограничены header/error/details/state и выбрана последняя часть bounded journal в исходном порядке. Общий export остаётся ограниченным и redacted.
- Manifest больше не называет рабочее расширение тестовым кандидатом. Package version, lockfile, manifests и фотографии согласованы с 0.3.3.

Независимый reviewer обнаружил соседние PSSH/senc gaps, но сервис заблокировал его итоговый отчёт с пометкой cybersecurity risk. Завершённый независимый correction review не заявляется. Собственная проверка подтвердила и исправила physical/aggregate PSSH key bounds, повторные senc rows и inline/lazy subsamples до allocation. Малые actual Input/packet regressions сначала воспроизвели обходы; valid fixtures сохранили duration/no-key refusal. Полные три modified MPL sources и четыре deterministic transformations согласованы. Большие аварийные входы и crash experiments не выполнялись.

## Фактическая проверка

867 tests PASS, 0 FAIL; ESLint 0 errors / 17 прежних warnings. Обе сборки по 61 файлу; manifests/CSP/inventory, provenance/licenses/exact lockfiles прошли. Dependency audit: runtime 0; только три прежних reviewed tooling entries. web-ext: 0 errors / 0 notices / 3 reviewed vendor warnings.

В отдельном Zen 1.23.2b / Gecko 157.0.1 временная 0.3.3 активна при обязательной проверке подписей. Настройка Save As изменена настоящей клавишей и сохранилась после открытия popup. Actual worker/export/native download завершил TXT длиной 23404 characters: последние записи, State и Details присутствуют, dummy secret скрыт, старейшие записи исключены. Восемь runtime assets совпали с dist на момент съёмки; последующая parser correction сохраняет UI assets.

Новые фотографии 0.3.3 и полные viewport screenshots просмотрены: popup 1246×883 / 326×843; package 1246×983 / 326×843. Package photo показывает delivered component с нейтральными demo labels; это иллюстрация UI, а не загрузка материала. Приватные ссылки, названия пользовательских файлов и аккаунты не включены.

Native Zen/Edge package, media decode/ZIP bytes, source ownership, VK menu/drag/cancel и исходные security corrections проверены на 0.3.2; точные сценарии находятся в [предыдущей проверке](RELEASE_VERIFICATION_032.md). Эти неизменённые пути повторно покрыты полной suite. Подписанный окончательный пакет отдельно проверен в Zen, как описано ниже; финальный native Edge-прогон 0.3.3 не заявляется.

## Подпись и постоянное обновление

Замороженный source/runtime commit: `aa9f3c65fab2164887763d630114889ecd9b051d`, clean tree. [CI финального PR head](https://github.com/mendozie/MendoSave/actions/runs/38450446790) прошёл на Windows 2025 и Ubuntu 24.04, включая воспроизводимость архивов.

Mozilla version `6573936`, file `5118072`: статус Approved, unlisted, ID `mendosave@mendozie`, минимум Gecko 157.0. Saved-state readback подтвердил version/reviewer notes. Скачанный source ZIP содержит 177 файлов и byte-for-byte совпадает с отправленным архивом и Git blobs замороженного commit. Подписанный XPI содержит 61 application file и пять `META-INF` signature files. Mozilla изменила формат JSON manifest без изменения значений; остальные application bytes совпали с неподписанной сборкой. CRC, уникальность и безопасность archive paths проверены.

Отдельный профиль Zen 1.23.2b / Gecko 157.0.1 на Windows 11 получил постоянное обновление 0.3.1 → 0.3.3: `signedState: 2`, обязательная проверка подписей включена. ID/UUID и настройки Save As, качества и locks сохранились. После полной остановки процессов и повторного запуска установка активна. Рабочий профиль пользователя и настройки подписей не менялись. При обновлении старый popup был закрыт браузером; тестовый harness выбрал сохранившуюся вкладку и продолжил проверку без переустановки.

Настоящий клик в Coub после restart завершил «Со звуком · один проход»: MP4 3 580 865 bytes, H.264 880×720 / 300 кадров / 10 с, AAC / 431 кадров / 10,008005 с. Полный decode прошёл без ошибок, первый/последний кадры просмотрены, звук на обоих концах проверен. SHA-256: `0c5c329c575b96274fd359fb27b53fff0bee1989eda259267ad6b8e401c6c36b`. В финальном readback processor instance отсутствует, producers/reservations/iframes равны нулю; terminal UI скрыт после задержки. Собственные браузер и driver остановлены, порты освобождены.

## Публичная поставка и hashes

[PR #8](https://github.com/mendozie/MendoSave/pull/8) объединён в main guarded merge проверенного head. Base: `5fea4facdd383444bb0692283393edf35b5f7859`; merge commit: `f8e3f6d0dabcb9dbf165b23c11efb4418f9cdd80`, файлы совпали с frozen head. Managed review относится к `52c209d88f15bb6e4b126eb9fcb376438ef3585f`; три threads resolved, последующий диапазон до `aa9f3c65fab2164887763d630114889ecd9b051d` покрыт собственной проверкой и итоговыми tests/native checks. Это не managed review окончательного SHA. [CI main](https://github.com/mendozie/MendoSave/actions/runs/38456518388) также прошёл. Тег `v0.3.3` сохраняет frozen source commit; обновление документации в main выполняется отдельно от релизных bytes.

До смены видимости проверены 34 reachable commits, 493 unique path-blobs, GitHub descriptions/issues/PR/reviews, 26 Actions logs, 52 Actions archives и 156 inner archives, прежний Release и готовые пакеты. Контекст совпадений разобран: публичный browser client key и явные тестовые заглушки; приватных credentials не обнаружено. Новые картинки просмотрены и не содержат дополнительных PNG metadata. `.local/`, профили, cookies и пользовательские медиассылки в публикацию не входят. Такая проверка не доказывает отсутствие всех возможных секретов; пределы [security scan](SECURITY_REVIEW_032.md) сохранены отдельно.

GitHub API и запрос без авторизации подтвердили публичный репозиторий и latest Release `v0.3.3`, не draft и не prerelease, автор `mendozie`. Все шесть assets скачаны обратно: bytes и размеры совпали с frozen files, archive CRC прошёл, пять записей `SIGNED_SHA256SUMS` проверены.

| Пакет | Bytes | SHA-256 |
|---|---:|---|
| Firefox/Zen signed XPI | 11 016 681 | `253023aa6bd5ab1c301b619d7887a138f8ff4782bc5849cb95bed06f9dda378f` |
| Chromium unsigned ZIP | 34 453 511 | `653eff95395be233dc7706a49b13013ad74d276dde5cca098beecdc6ce49aa0a` |
| Matching source ZIP | 36 021 467 | `1d15766b5ab58b468b1cf62eef02df887da256f94f6551e301c3f799434a3839` |

Также опубликованы `release-manifest.json`, `signing-manifest.json` и `SIGNED_SHA256SUMS`. Первый manifest описывает замороженную неподписанную подготовку, второй - подпись и фактические браузерные проверки. Mozilla unlisted и Chromium unpacked распространяются с ручными обновлениями, без страницы AMO или Chrome Web Store.

Остальные браузеры/ОС, physical chooser Chromium, фактическая дисковая квота и все материалы площадок не объявляются проверенными.

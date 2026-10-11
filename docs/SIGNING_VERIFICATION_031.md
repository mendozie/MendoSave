# MendoSave 0.3.1 - подписание и ручная поставка

Дата: 11-10-2026. Mozilla одобрила существующее дополнение в канале **unlisted**. [Release v0.3.1](https://github.com/mendozie/MendoSave/releases/tag/v0.3.1) опубликован в приватном репозитории; магазины и update server не используются.

## Сохранённая версия и исходники

- Add-on ID: `mendosave@mendozie`; version `0.3.1`.
- Mozilla version `6564301`, file `5108439`, saved status «Одобрено», скрытая версия.
- Firefox minimum `157.0`, maximum `*`; Android не выбирался.
- Валидация: 0 errors / 3 рассмотренных vendor warnings.
- Release notes и reviewer build instructions сохранены; после reload значения совпали с отправленными. Reviewer notes - 2931 символ.
- Source archive содержит 154 файла. Скачанный из сохранённой версии Mozilla ZIP совпал по размеру и SHA-256 с отправленным snapshot `1fce50347ca109cd60da7d2942353b86de90cabf`.

Вход и submission выполнены во встроенном браузере Codex из учётной записи `mendozie`. Рабочий профиль Zen пользователя при подписании и runtime QA не использовался.

## Пакеты

| Файл | Bytes | SHA-256 |
|---|---:|---|
| `mendosave-0.3.1-firefox-signed.xpi` | 10 997 028 | `7ce03a5aeccdee388e89ae0a12677dcc9f5c2520b37046576ea19eade9f17a8f` |
| `mendosave-0.3.1-chromium-unsigned.zip` | 34 385 937 | `f43c6169e348fdc9a04583ea3a170afff9cdf23f7ab191586788f49ef8c46ac8` |
| `mendosave-0.3.1-source.zip` | 35 557 932 | `402ce73fd73ee5ad9dbc23b73013e39f52ad35df2c5ed29f7e58e635d34553e4` |

Signed XPI содержит те же 58 application files, что и проверенный unsigned candidate, плюс пять `META-INF` файлов подписи. CRC и уникальность путей проверены. Mozilla изменила JSON formatting манифеста; его значения совпали, bytes остальных application files не изменились. Лицензии и notices сохранены. Наличие signature metadata проверяется отдельно от доверия браузера к подписи.

Замороженные пакеты находятся в ignored `artifacts/mendosave-0.3.1-unlisted/`. `release-manifest.json` сохраняет provenance неподписанной сборки; отдельные `signing-manifest.json` и `SIGNED_SHA256SUMS` описывают подписанный файл и поставку. Версия 0.3.0 не перезаписывалась.

## Постоянное обновление и restart

Использован отдельный headless-профиль Zen 1.23.2b / Gecko 157.0.1 на Windows 11. Baseline - ранее проверенный signed XPI 0.3.0. Signature preferences и рабочий профиль пользователя не менялись.

1. Подписанная 0.3.0 установлена постоянно; подготовлены Save As `false`, YouTube `480p`, Twitch `360p`, quality locks `false`.
2. Signed 0.3.1 установлена поверх того же ID. AddonManager: `signedState: 2`, `signatureRequired: true`, `isActive: true`, `temporarilyInstalled: false`.
3. ID, extension UUID и все пять настроек совпали до и после обновления.
4. После полного завершения процесса новый процесс загрузил активную постоянную 0.3.1 с той же identity и настройками. Popup показывает `v0.3.1`; фактический screenshot viewport - **1086×783**.

Это проверка постоянного обновления и сохранения настроек, без обещания автоматического продолжения незавершённых jobs.

## Реальный файл после restart

На Coub через обычное меню выбрано «Со звуком · один проход». Native download завершён, файл существует: **3 580 865 bytes**, SHA-256 `0c5c329c575b96274fd359fb27b53fff0bee1989eda259267ad6b8e401c6c36b`.

MP4 содержит H.264 **880×720**, **300 кадров / 10 с** и AAC **10,008005 с**. Полное декодирование с `-xerror -err_detect explode` прошло без ошибок. Первый и последний кадры просмотрены; крайние аудиосэмплы ненулевые, RMS первых/последних 0,25 с - **0,1377 / 0,1403**. После завершения instance/iframe/producers/reservations отсутствуют; terminal toast скрыт через 6 с.

Собственные headless browser/driver процессы остановлены, порты `4469` и `2889` свободны. Receipts и screenshots сохранены в ignored `.local/qa/next031-permanent/` и `.local/qa/next031-signing/`.

## GitHub и границы

Runtime revision интегрирован через [PR #5](https://github.com/mendozie/MendoSave/pull/5), merge `606392fe1b07f500160dba75e653503f18fdf719`. Annotated tag `v0.3.1` принадлежит `mendozie` и указывает на точный source/runtime revision. Saved Release state: `isDraft: false`, `isPrerelease: false`; все шесть assets имеют ожидаемые имена, размеры и SHA-256. Репозиторий остаётся приватным, release notes сохранены без изменений.

Финальный runtime прошёл 561 tests, Windows/Linux CI и воспроизводимость архивов. Native Chromium large TXT/ZIP и Coub проверены на checkpoint `6c84b8e`; последующие cue/filename corrections проверены regression tests, отдельный native edge rerun недоступен после отказа инструмента. Другие Gecko/Chromium-производные и ОС отдельно не проверены. Остальные ограничения приведены в [V031_VERIFICATION.md](V031_VERIFICATION.md) и [PHASE4_VERIFICATION.md](PHASE4_VERIFICATION.md).

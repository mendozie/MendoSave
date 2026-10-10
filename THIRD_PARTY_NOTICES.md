# Сторонние компоненты MendoSave

MendoSave развивается на основе [confeden/Nova-Video-Saver](https://github.com/confeden/Nova-Video-Saver), commit `6a2bc6dc1234a3c4b0037885b08cad486abe1bac`, версия 1.9. Подготовка самостоятельного проекта начата 09-10-2026. Пользовательское оформление и контакты могут изменяться; происхождение кода и лицензионные уведомления сохраняются.

Исходная база распространяется по GNU GPL v3.0 only согласно её README. Полный текст GPL v3.0 находится в [LICENSE](LICENSE). Неизменённые исходные notices входят в локальную копию upstream; ниже сохранены сведения об основе и включённых компонентах.

Nova Video Saver (ранее Nova Youtube Downloader) основан на [HelpFreedom/Triangle-Downloader](https://github.com/HelpFreedom/Triangle-Downloader), распространяемом по лицензии GNU GPL v3.0. Код исходной базы был изменён и расширен в 2026 году.

В исходную базу включена версия [ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), распространяемая по лицензии MIT:

MIT License

Copyright (c) 2019 Jerome Wu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Встроенное ядро содержит [FFmpeg](https://github.com/FFmpeg/FFmpeg) с включёнными `--enable-gpl` и `libx264`, поэтому эта сборка распространяется по GPL v2.0 или более поздней версии. Исходные notices указывают исходный код и сценарии сборки соответствующей версии ffmpeg.wasm в [теге v0.12.6](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.6). Соответствие конкретного бинарного ядра этому source/build recipe предстоит независимо проверить перед выпуском MendoSave. Условия FFmpeg приведены в его [файле лицензии](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md).

В исходную базу включён однофайловый bundle [Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny) версии 1.51.0 (`extension/vendor/mediabunny/mediabunny.min.mjs`), распространяемый по [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/). Библиотека используется для сборки медиа и аппаратного перекодирования через WebCodecs. Условия исходных notices сохраняются: изменения файлов самой библиотеки должны сохранять применимые требования MPL-2.0.

09-10-2026 исходная папка `extension/` импортирована в рабочий проект. Неизменённый snapshot остаётся вне Git; исторический README сохранён в `docs/upstream/README.md`. В MendoSave изменены browser host и manifests, сохранение и восстановление файлов, контракты jobs, отмена/таймауты, получение субтитров и YouTube UI. Legacy updater отключён. Файлы встроенных FFmpeg/WASM и Mediabunny в этом срезе не изменялись.

Сборка включает этот файл и `LICENSE` в Firefox- и Chromium-пакеты. Musify исключён из обеих сборок. Инструменты разработки `web-ext` 10.7.0 (MPL-2.0) и `linkedom` 0.18.12 (ISC) закреплены в `package-lock.json`; они не входят в пакет расширения. Их notices находятся в установленных npm packages. Исполняемые FFmpeg/ffprobe для внешней проверки конечных файлов также не входят в расширение и не являются его runtime dependency.

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

Встроенное ядро содержит [FFmpeg](https://github.com/FFmpeg/FFmpeg) с включёнными `--enable-gpl` и `libx264`, поэтому эта сборка распространяется по GPL v2.0 или более поздней версии. 10-10-2026 JS/WASM ядра совпали byte-for-byte с official npm `@ffmpeg/core` 0.12.6; browser build metadata подтвердил FFmpeg 5.1.4 и Emscripten 3.1.40. Wrapper `ffmpeg.js` совпал с `@ffmpeg/ffmpeg` 0.12.10. Worker наследует единственную замену default CDN URL на локальный URL; изменение описано в [provenance](extension/vendor/ffmpeg/PROVENANCE.json). Локальные тексты лицензий - [MIT](extension/vendor/ffmpeg/LICENSE.wrapper) и [GPL v2](extension/vendor/ffmpeg/COPYING.GPLv2). [Исходники и build recipe ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/e0d4c62a229ba58ea0c6e6b881e289f2fefe97c4), [исходники FFmpeg 5.1.4](https://github.com/FFmpeg/FFmpeg/tree/n5.1.4). Версии и проверки поставки приведены в [DEPENDENCIES.md](docs/DEPENDENCIES.md).

В исходную базу включён однофайловый bundle [Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny) версии 1.51.0 (`extension/vendor/mediabunny/mediabunny.min.mjs`), распространяемый по [MPL-2.0](extension/vendor/mediabunny/LICENSE). Библиотека используется для сборки медиа и аппаратного перекодирования через WebCodecs. Исходный bundle совпал с versioned jsDelivr `+esm`, а все 66 npm source files совпали с [Git commit](https://github.com/Vanilagy/mediabunny/tree/634186fd5e2dac946bf994a955680b85aceb7709). В MendoSave bundle изменён: добавлены ограничения MP4 metadata и chunk lookup, проверка длины ADTS frames, завершение пустого FLAC lookup на EOF, unsigned физически ограниченные AV1 OBU lengths и неизменяемая проекция физических границ MP4 sample для проверки перед сохранением. Полные изменённые MPL-исходники [isobmff-demuxer.ts](extension/vendor/mediabunny/isobmff-demuxer.ts), [isobmff-misc.ts](extension/vendor/mediabunny/isobmff-misc.ts), [adts-reader.ts](extension/vendor/mediabunny/adts-reader.ts), [flac-demuxer.ts](extension/vendor/mediabunny/flac-demuxer.ts) и [codec-data.ts](extension/vendor/mediabunny/codec-data.ts) входят в поставку вместе с [описанием преобразования](extension/vendor/mediabunny/PATCH.md). [Npm source archive](https://registry.npmjs.org/mediabunny/-/mediabunny-1.51.0.tgz) содержит остальное `src/` и license; исходные и изменённые hashes сохранены в [provenance](extension/vendor/mediabunny/PROVENANCE.json). Исходные notices и условия MPL-2.0 сохраняются.

09-10-2026 исходная папка `extension/` импортирована в рабочий проект. Неизменённый snapshot остаётся вне Git; исторический README сохранён в `docs/upstream/README.md`. В MendoSave изменены browser host и manifests, сохранение и восстановление файлов, контракты jobs, отмена/таймауты, получение субтитров и YouTube UI. Legacy updater отключён. Файлы встроенных FFmpeg/WASM сохраняются; изменения Mediabunny описаны выше.

Сборка включает этот файл и `LICENSE` в Firefox- и Chromium-пакеты. Musify исключён из обеих сборок. Инструменты разработки `web-ext` 10.7.0 (MPL-2.0) и `linkedom` 0.18.12 (ISC) закреплены в `package-lock.json`; они не входят в пакет расширения. Их notices находятся в установленных npm packages. Исполняемые FFmpeg/ffprobe для внешней проверки конечных файлов также не входят в расширение и не являются его runtime dependency.

Для ZIP встроен неизменённый native bundle [gildas-lormeau/zip.js](https://github.com/gildas-lormeau/zip.js/tree/38508528fe00b094447d9122b7725ab412149e2d) версии 2.20.0, commit `38508528fe00b094447d9122b7725ab412149e2d`, по BSD-3-Clause. Полная лицензия находится в [extension/vendor/zipjs/LICENSE](extension/vendor/zipjs/LICENSE), версии и контрольные суммы - в [PROVENANCE.json](extension/vendor/zipjs/PROVENANCE.json). `MendoArchive` использует локальный `zip-native.min.js`, последовательный ZIP STORE и `WritableStream`; Web Workers отключены. Этот путь не использует сеть, WebAssembly или динамическое исполнение кода. Автоматический ZIP64 поддерживается библиотекой; проверка файлов больше 4 GiB остаётся отдельной границей испытаний.

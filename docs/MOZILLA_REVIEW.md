# Mozilla reviewer build instructions

This document records the 0.3.3 submission. The current branch contains an unsigned 0.4.0 Instagram candidate for manual acceptance; it has not been submitted to Mozilla. The candidate reads bounded fresh same-origin HTTP responses in ISOLATED and imports one bundled Mediabunny module exposed through an Instagram-only WAR entry. Its MP4 demuxer projects immutable physical packet extents, checked by the adapter against `mdat`. See [candidate verification](INSTAGRAM_VERIFICATION.md) for its added permissions, checks and installation steps.

Submission: MendoSave 0.3.3, add-on ID `mendosave@mendozie`, self-distributed (unlisted). This updates the published 0.3.1 add-on and supersedes the intermediate 0.3.2 submission after PR review. The owner authorized public GitHub distribution after a release privacy audit. No public AMO listing or update server is part of this submission.

## Build the submitted Firefox package

The source archive contains the extension, browser-specific host, build scripts, lockfile, bundled libraries, licenses and provenance. Extract it into an empty directory and run commands from its root.

Tested local environment: Windows with Node.js 22.18.0 / npm 10.9.3. The final 0.3.3 candidate passed Windows 2025 and Ubuntu 24.04 CI, including archive reproducibility; see [release verification](RELEASE_VERIFICATION_033.md). Node.js must satisfy `^22.13.0 || >=24`; download it from [nodejs.org](https://nodejs.org/en/download).

```sh
npm ci --ignore-scripts
npm run build
npm run check:build
npm run check:dependencies
npm run check:extension
```

On Windows PowerShell, use `npm.cmd` instead of `npm` if the script execution policy blocks npm's PowerShell shim. These commands do not require Docker, WSL or a compiler.

`dist/firefox/` contains the submitted Firefox extension. Compare its file contents with the unsigned XPI. The build copies first-party JavaScript without minification and generates only `manifest.json`, using the pinned package version and Firefox background contract. Chromium has its own output and is not submitted to Mozilla. `dist/firefox-hashes.json` records every packaged file. ZIP metadata and Mozilla's later signature files are not application source differences.

## Bundled libraries

The build uses the supplied local vendor files, without downloading runtime code. Full notices, exact versions, source URLs, hashes and modifications are in [DEPENDENCIES.md](DEPENDENCIES.md), [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and the vendor `PROVENANCE.json` files.

- FFmpeg wrapper 0.12.10 and core 0.12.6: the wrapper's worker has a documented inherited change making its default core URL local. The existing official core is included unchanged. This submission does not claim a fresh native-code compilation.
- Mediabunny 1.51.0: the supplied bundle contains local MP4/AAC resource guards, cumulative physical metadata/index limits including constant/variable auxiliary `saiz`, PSSH, repeated `senc` and inline/lazy subsample counts, and linear fragment-index duplicate compaction. Complete modified MPL source files, original source identifiers and deterministic bundle/source transformations are included. See [PATCH.md](../extension/vendor/mediabunny/PATCH.md). A fresh bit-for-bit TypeScript compilation is not claimed.
- zip.js 2.20.0: the native bundle is unchanged from the pinned npm archive. Runtime ZIP writing uses STORE and disables web workers.

The submitted 0.3.3 had three known lint warnings. The 0.4.0 candidate adds one warning for its fixed local module import; exact locations, hashes and execution boundaries are documented in [DEPENDENCIES.md](DEPENDENCIES.md). Content security policy permits only bundled scripts, workers and WebAssembly; it does not enable string evaluation or remote scripts.

## Exercise the extension

Load `dist/firefox/manifest.json` temporarily in a separate Firefox/Zen profile. Open a supported media page such as a YouTube watch page or Coub, select an available download option in MendoSave, and check the resulting file. The popup controls Save As, cancellation and manual recovery of prepared package inputs. Source-site availability and formats vary by material.

For a package, use the multiple-selection control and select Files or ZIP. The picker has bounded dragging and full-close controls (disabled during active work/cleanup). The picker is nonmodal: Hide or Escape keeps the selection and active queue; the floating status control reopens it. Cancel waits for cleanup and allows a new run from the same picker. On YouTube, plain TXT, SRT and timed TXT are distinct choices. Timed TXT requires cues attributable to the selected video and caption track; native chapter labels are included only when their video ownership is established. Ambiguous or unavailable captions produce an error rather than another track's text.

Firefox uses a processor iframe owned by the extension background page. A fallback tab is created only if that iframe cannot start; it is inactive, pinned and closed only when its exact ID and URL still match the owned instance. Producer/work ports retain the background and processor while media work, native downloads or cleanup are pending. Idle cleanup releases the owned processor. Chromium uses its native offscreen API. Neither backend adopts or closes a matching user tab.

The extension processes media locally and contacts the selected source site/CDN for media data. There is no analytics, advertising, processing server or Native Messaging. This update adds no permissions or remote libraries. Sensitive page controls require trusted pointer/original keyboard activation; page failure details are projected through bounded redaction before runtime messaging. Permissions and storage are explained in [PRIVACY.md](../PRIVACY.md); current checks and remaining test gaps are in [V032_R2_VERIFICATION.md](V032_R2_VERIFICATION.md), with the earlier baseline in [PHASE4_VERIFICATION.md](PHASE4_VERIFICATION.md).

# Mozilla reviewer build instructions

Prepared submission: MendoSave 0.4.0. The owner accepted the compact interface and authorized Mozilla signing and GitHub distribution on 15-10-2026. Actual submission/signing and final package receipts are recorded in [release verification](RELEASE_VERIFICATION_040.md). Historical 0.3.3 receipts remain in their [separate report](RELEASE_VERIFICATION_033.md).

Add-on ID: `mendosave@mendozie`, self-distributed (unlisted), updating published 0.3.3. No public AMO listing or update server is part of this submission. Media is processed locally; there is no analytics, processing server or Native Messaging.

New functionality: Instagram Reels, videos, photos, complete mixed carousels, author-description TXT and original audio/MP3, using the current website session. Added host permissions are `https://www.instagram.com/*`, `https://*.cdninstagram.com/*` and `https://*.fbcdn.net/*`. Metadata is read through bounded canonical same-origin HTTP in ISOLATED; a session-bound web endpoint fallback is restricted to Instagram. DOM/page messages are not metadata authority. Credentials are not exported. Signed media URLs are fetched without cookies. One fixed local Mediabunny module is exposed by a WAR entry restricted to Instagram; privileged modules are not exposed. MP4 dimensions, packet availability and immutable sample extents are checked against physical `mdat` bytes before saving. See [Instagram verification](INSTAGRAM_VERIFICATION.md) and [privacy](../PRIVACY.md).

## Build the submitted Firefox package

The source archive contains the extension, browser-specific host, build scripts, lockfile, bundled libraries, licenses and provenance. Extract it into an empty directory and run commands from its root.

Tested local environment: Windows with Node.js 22.18.0 / npm 10.9.3. Final Windows 2025 and Ubuntu 24.04 CI and archive reproducibility are recorded for the exact revision in [release verification](RELEASE_VERIFICATION_040.md). Node.js must satisfy `^22.13.0 || >=24`; download it from [nodejs.org](https://nodejs.org/en/download).

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
- Mediabunny 1.51.0: local MP4/AAC metadata/resource guards, cumulative limits including auxiliary encryption, linear fragment-index compaction, immutable packet-extent projection, bounded regular-chunk lookup with a reusable physical-table prefix index, terminal empty-FLAC lookup, and unsigned physically bounded AV1 OBU lengths. All five complete modified MPL source files, original identifiers and deterministic bundle/source transformations are included. See [PATCH.md](../extension/vendor/mediabunny/PATCH.md) and [security review](SECURITY_REVIEW_040.md). A fresh bit-for-bit TypeScript compilation is not claimed.
- zip.js 2.20.0: the native bundle is unchanged from the pinned npm archive. Runtime ZIP writing uses STORE and disables web workers.

The submitted 0.3.3 had three known lint warnings. Version 0.4.0 has four: one additional warning for its fixed local module import; exact locations, hashes and execution boundaries are documented in [DEPENDENCIES.md](DEPENDENCIES.md). Content security policy permits only bundled scripts, workers and WebAssembly; it does not enable string evaluation or remote scripts.

## Exercise the extension

Load `dist/firefox/manifest.json` temporarily in a separate Firefox/Zen profile. Open a supported media page such as a YouTube watch page or Coub, select an available download option in MendoSave, and check the resulting file. The popup controls Save As, cancellation and manual recovery of prepared package inputs. Source-site availability and formats vary by material.

For Instagram, open a public publication/Reel first. Anonymous access may require login depending on the material/site response. Use the normal website login if necessary. Private-account access is limited to the user's existing access; no bypass is supplied, and a real private publication was not tested. Stories, Direct and profile-wide download are outside this release.

For a package, use the multiple-selection control and select Files or ZIP. Compact rows show one primary result; quality and extra audio/TXT options expand separately. Initial selection is empty; Select all chooses primary media results. Multiple qualities remain available and every selected output counts toward 64 files; ZIP retains the 1 GiB cap. Back/reopen of the same static source reuses its validated snapshot and compatible selection. A different source/document and retry after a media error invalidate the corresponding snapshot.

The picker has bounded dragging and full-close controls (disabled during active work/cleanup). The picker is nonmodal: Hide or Escape keeps the selection and active queue; the floating status control reopens it. Cancel waits for cleanup and allows a new run from the same picker. On YouTube, plain TXT, SRT and timed TXT are distinct choices. Timed TXT requires cues attributable to the selected video and caption track; native chapter labels are included only when their video ownership is established. Ambiguous or unavailable captions produce an error rather than another track's text.

Firefox uses a processor iframe owned by the extension background page. A fallback tab is created only if that iframe cannot start; it is inactive, pinned and closed only when its exact ID and URL still match the owned instance. Producer/work ports retain the background and processor while media work, native downloads or cleanup are pending. Idle cleanup releases the owned processor. Chromium uses its native offscreen API. Neither backend adopts or closes a matching user tab.

Sensitive page controls require trusted pointer/original keyboard activation; page failure details are projected through bounded redaction before runtime messaging. Permissions and storage are explained in [PRIVACY.md](../PRIVACY.md); current checks and remaining gaps are in [RELEASE_VERIFICATION_040.md](RELEASE_VERIFICATION_040.md), [UI_B_VERIFICATION.md](UI_B_VERIFICATION.md) and [INSTAGRAM_VERIFICATION.md](INSTAGRAM_VERIFICATION.md). Earlier media checks are retained separately rather than claimed again for the final header/parser correction.

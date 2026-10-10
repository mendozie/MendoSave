# Local Mediabunny parser guards

Updated: 10-10-2026. Upstream: Mediabunny 1.51.0, commit `634186fd5e2dac946bf994a955680b85aceb7709`, MPL-2.0. Original notices and LICENSE are retained.

MendoSave modifies the pinned jsDelivr bundle and the corresponding two full MPL source files supplied here:

- `isobmff-demuxer.ts`: accept only compact sample widths 4/8/16; bound expanded presentation timestamps and retained fragment samples to 1,000,000 objects; validate PCM chunk ranges against actual offsets and bound expanded chunks; skip composition offsets beyond the actual timestamp table.
- `adts-reader.ts`: reject frames shorter than the ADTS header (7 bytes without CRC, 9 with CRC), preventing a reader from repeatedly seeking to the same header.

The budget applies to materialized metadata tables and each retained fragment across tracks/runs. It is not a cap on a whole recording's compact PCM sample count. Valid PCM rechunking and defaults-only fragments remain supported. Files exceeding the metadata budget fail explicitly.

`PROVENANCE.json` records original and modified hashes. The complete upstream source tree is available in the versioned [npm source archive](https://registry.npmjs.org/mediabunny/-/mediabunny-1.51.0.tgz) and [Git commit](https://github.com/Vanilagy/mediabunny/tree/634186fd5e2dac946bf994a955680b85aceb7709). To work with the modified TypeScript source tree, replace `src/isobmff/isobmff-demuxer.ts` and `src/adts/adts-reader.ts` in that source tree with the full files supplied here. Their original relative imports are retained.

The shipped bundle is obtained by deterministic local text transformation of the pinned original, without compiling TypeScript or changing the FFmpeg core. From the MendoSave repository, run:

```text
node scripts/patch-mediabunny.cjs <original-jsdelivr-bundle> <original-isobmff-demuxer.ts> <original-adts-reader.ts>
```

The script checks all three original SHA-256 hashes and unique anchors before writing output. Regression tests reverse the transformations, verify the original hashes, and reapply them to reproduce the distributed files exactly. They also exercise the actual public `Input` parser using controlled valid/malformed media metadata; the allocation budget is scaled down only in the test copy. This verifies the transformation and parser guards. A bit-for-bit TypeScript compilation of the generated jsDelivr bundle was not performed.

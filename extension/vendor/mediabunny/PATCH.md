# Local Mediabunny parser guards

Updated: 13-10-2026. Upstream: Mediabunny 1.51.0, commit `634186fd5e2dac946bf994a955680b85aceb7709`, MPL-2.0. Original notices and LICENSE are retained.

MendoSave modifies the pinned jsDelivr bundle and the corresponding three full MPL source files supplied here:

- `isobmff-demuxer.ts`: accept only compact sample widths 4/8/16; bound expanded presentation timestamps and retained fragment samples to 1,000,000 objects; validate PCM chunk ranges against actual offsets and bound expanded chunks; skip composition offsets beyond the actual timestamp table. Before reading/materializing `stts`, `ctts`, `stsz`, `stz2`, `stss`, `stsc`, `stco`, `co64`, `tfra` and `saiz`, charge a cumulative 4,000,000-entry budget across boxes and tracks. Auxiliary encryption sample counts are charged even with a constant entry size, before retaining them for lazy resolution. Existing-table revisits in `stsc` and `tfra` also consume that budget. Sorted fragment-index duplicates are removed by linear stable compaction instead of repeated array shifting.
- `adts-reader.ts`: reject frames shorter than the ADTS header (7 bytes without CRC, 9 with CRC), preventing a reader from repeatedly seeking to the same header.
- `isobmff-misc.ts`: bound PSSH key IDs by the physical payload and the 4,000,000-entry ceiling before iteration; validate the data length. The shared helper protects both MP4 and HLS callers. MP4 additionally charges key IDs and PSSH boxes to its cumulative budget. Inline `senc` rows/revisits and both inline/lazy encryption subsamples also consume that same demuxer budget before allocation.

The budgets apply to materialized metadata tables/revisits and each retained fragment across tracks/runs. They are not caps on a whole recording's compact PCM sample count: a constant-size `stsz` charges one entry. Valid PCM rechunking and defaults-only fragments remain supported. Files exceeding the metadata budget fail explicitly.

`PROVENANCE.json` records original and modified hashes. The complete upstream source tree is available in the versioned [npm source archive](https://registry.npmjs.org/mediabunny/-/mediabunny-1.51.0.tgz) and [Git commit](https://github.com/Vanilagy/mediabunny/tree/634186fd5e2dac946bf994a955680b85aceb7709). To work with the modified TypeScript source tree, replace `src/isobmff/isobmff-demuxer.ts`, `src/isobmff/isobmff-misc.ts` and `src/adts/adts-reader.ts` with the full files supplied here. Their original relative imports are retained.

The shipped bundle is obtained by deterministic local text transformation of the pinned original, without compiling TypeScript or changing the FFmpeg core. From the MendoSave repository, run:

```text
node scripts/patch-mediabunny.cjs <original-jsdelivr-bundle> <original-isobmff-demuxer.ts> <original-adts-reader.ts> <original-isobmff-misc.ts>
```

The script checks all four original SHA-256 hashes and unique anchors before writing output. Regression tests reverse the transformations, verify the original hashes, and reapply them to reproduce the distributed files exactly. They also exercise the actual public `Input` parser using controlled valid/malformed media metadata; the allocation budget is scaled down only in the test copy. This verifies the transformation and parser guards. A bit-for-bit TypeScript compilation of the generated jsDelivr bundle was not performed.

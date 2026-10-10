// Deterministic local guards for the pinned upstream bundle and original MPL sources.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const originals = {
  bundle: '2db7ec3a0e7a6ddacee901cd38db62a066c8c446bc37e4e38d4047d07a39fc68',
  mp4: 'bde5d41fdd4db0c4574be69e2e02f4732ade675366efaf030f52215a80eb76a8',
  adts: 'b2269b6e2218c16715ad33470560428e4cbab5c8e7c8301edaee6ace5564c2d3',
};
const edits = {
  bundle: [
    [' */\nfunction Kl', ' */\n// Local parser bounds; corresponding MPL source files and PATCH.md accompany this bundle.\nconst MENDO_MAX_EXPANDED_MP4_SAMPLES=1000000;\nfunction Kl'],
    ['const o=U(e),c=F(e),l=N(e,Math.ceil(c*o/8)),u=new j(l);',
      'const o=U(e),c=F(e);if(![4,8,16].includes(o))throw new Error("Invalid MP4 compact sample width");const l=N(e,Math.ceil(c*o/8)),u=new j(l);'],
    ['const l=t.sampleToChunk[c],u=t.sampleToChunk[c+1],d=(u?u.startChunkIndex:t.chunkOffsets.length)-l.startChunkIndex;for(let f=0;f<d;f++){',
      'const l=t.sampleToChunk[c],u=t.sampleToChunk[c+1],mendoEnd=u?u.startChunkIndex:t.chunkOffsets.length,d=mendoEnd-l.startChunkIndex;if(l.startChunkIndex<0||mendoEnd<l.startChunkIndex||mendoEnd>t.chunkOffsets.length)throw new Error("Invalid MP4 chunk range");if(d>MENDO_MAX_EXPANDED_MP4_SAMPLES-o.length)throw new Error("MP4 sample metadata limit");for(let f=0;f<d;f++){'],
    ['for(const n of t.sampleTimingEntries)for(let a=0;a<n.count;a++)t.presentationTimestamps.push({presentationTimestamp:n.startDecodeTimestamp+a*n.delta,sampleIndex:n.startIndex+a});',
      'for(const n of t.sampleTimingEntries){if(n.count>MENDO_MAX_EXPANDED_MP4_SAMPLES-t.presentationTimestamps.length)throw new Error("MP4 sample metadata limit");for(let a=0;a<n.count;a++)t.presentationTimestamps.push({presentationTimestamp:n.startDecodeTimestamp+a*n.delta,sampleIndex:n.startIndex+a});}'],
    ['this.currentFragment.trackData.set(a.id,k));for(let b=0;b<m;b++){',
      'this.currentFragment.trackData.set(a.id,k));if(m>MENDO_MAX_EXPANDED_MP4_SAMPLES-(this.currentFragment.mendoSampleCount||0))throw new Error("MP4 sample metadata limit");this.currentFragment.mendoSampleCount=(this.currentFragment.mendoSampleCount||0)+m;for(let b=0;b<m;b++){'],
    ['for(const n of t.sampleCompositionTimeOffsets)for(let a=0;a<n.count;a++){const o=n.startIndex+a,c=t.presentationTimestamps[o];c&&(c.presentationTimestamp+=n.offset)}',
      'for(const n of t.sampleCompositionTimeOffsets){const mendoCount=Math.max(0,Math.min(n.count,t.presentationTimestamps.length-n.startIndex));for(let a=0;a<mendoCount;a++){const o=n.startIndex+a,c=t.presentationTimestamps[o];c&&(c.presentationTimestamp+=n.offset)}}'],
    ['const u=r.readBits(13);r.skipBits(11);',
      'const u=r.readBits(13);if(u<(a===1?7:9))throw new Error("Invalid ADTS frame length");r.skipBits(11);'],
  ],
  mp4: [
    ['export class IsobmffDemuxer extends Demuxer {', 'const MENDO_MAX_EXPANDED_MP4_SAMPLES = 1_000_000;\n\nexport class IsobmffDemuxer extends Demuxer {'],
    ['type Fragment = {\n\tmoofOffset: number;', 'type Fragment = {\n\tmendoSampleCount?: number;\n\tmoofOffset: number;'],
    ['\t\t\t\tconst fieldSize = readU8(slice); // in bits\n',
      '\t\t\t\tconst fieldSize = readU8(slice); // in bits\n\t\t\t\tif (![4, 8, 16].includes(fieldSize)) throw new Error("Invalid MP4 compact sample width");\n'],
    ['\t\t\t\tconst chunkCount = (nextEntry ? nextEntry.startChunkIndex : sampleTable.chunkOffsets.length)\n\t\t\t\t\t- chunkEntry.startChunkIndex;\n',
      '\t\t\t\tconst endChunkIndex = nextEntry ? nextEntry.startChunkIndex : sampleTable.chunkOffsets.length;\n\t\t\t\tconst chunkCount = endChunkIndex - chunkEntry.startChunkIndex;\n\t\t\t\tif (chunkEntry.startChunkIndex < 0 || endChunkIndex < chunkEntry.startChunkIndex\n\t\t\t\t\t|| endChunkIndex > sampleTable.chunkOffsets.length) throw new Error("Invalid MP4 chunk range");\n\t\t\t\tif (chunkCount > MENDO_MAX_EXPANDED_MP4_SAMPLES - newSampleSizes.length) {\n\t\t\t\t\tthrow new Error("MP4 sample metadata limit");\n\t\t\t\t}\n'],
    ['\t\t\tfor (const entry of sampleTable.sampleTimingEntries) {\n\t\t\t\tfor (let i = 0; i < entry.count; i++) {',
      '\t\t\tfor (const entry of sampleTable.sampleTimingEntries) {\n\t\t\t\tif (entry.count > MENDO_MAX_EXPANDED_MP4_SAMPLES - sampleTable.presentationTimestamps.length) {\n\t\t\t\t\tthrow new Error("MP4 sample metadata limit");\n\t\t\t\t}\n\t\t\t\tfor (let i = 0; i < entry.count; i++) {'],
    ['\t\t\t\tfor (let i = 0; i < sampleCount; i++) {\n\t\t\t\t\tlet sampleDuration: number;',
      '\t\t\t\tif (sampleCount > MENDO_MAX_EXPANDED_MP4_SAMPLES - (this.currentFragment.mendoSampleCount || 0)) {\n\t\t\t\t\tthrow new Error("MP4 sample metadata limit");\n\t\t\t\t}\n\t\t\t\tthis.currentFragment.mendoSampleCount = (this.currentFragment.mendoSampleCount || 0) + sampleCount;\n\t\t\t\tfor (let i = 0; i < sampleCount; i++) {\n\t\t\t\t\tlet sampleDuration: number;'],
    ['\t\t\tfor (const entry of sampleTable.sampleCompositionTimeOffsets) {\n\t\t\t\tfor (let i = 0; i < entry.count; i++) {',
      '\t\t\tfor (const entry of sampleTable.sampleCompositionTimeOffsets) {\n\t\t\t\tconst count = Math.max(0, Math.min(entry.count, sampleTable.presentationTimestamps.length - entry.startIndex));\n\t\t\t\tfor (let i = 0; i < count; i++) {'],
  ],
  adts: [
    ['\tconst frameLength = bitstream.readBits(13);\n',
      '\tconst frameLength = bitstream.readBits(13);\n\tif (frameLength < (protectionAbsence === 1 ? 7 : 9)) throw new Error("Invalid ADTS frame length");\n'],
  ],
};
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function transform(kind, bytes, reverse = false) {
  let text = bytes.toString('utf8');
  for (const [before, after] of reverse ? [...edits[kind]].reverse() : edits[kind]) {
    const from = reverse ? after : before, to = reverse ? before : after;
    if (text.split(from).length !== 2) throw new Error(`Unexpected ${kind} patch anchor`);
    text = text.replace(from, to);
  }
  return Buffer.from(text);
}
if (require.main === module) {
  const inputs = process.argv.slice(2);
  if (inputs.length !== 3) throw new Error('Usage: node scripts/patch-mediabunny.cjs <original-bundle> <original-isobmff-demuxer.ts> <original-adts-reader.ts>');
  const area = path.resolve(__dirname, '../extension/vendor/mediabunny');
  const outputs = ['bundle', 'mp4', 'adts'].map((kind, index) => {
    const bytes = fs.readFileSync(inputs[index]);
    if (hash(bytes) !== originals[kind]) throw new Error(`Unexpected original ${kind} hash`);
    return { file: { bundle: 'mediabunny.min.mjs', mp4: 'isobmff-demuxer.ts', adts: 'adts-reader.ts' }[kind], bytes: transform(kind, bytes) };
  });
  for (const output of outputs) fs.writeFileSync(path.join(area, output.file), output.bytes);
}
module.exports = { originals, transform, hash };

// Deterministic local guards for the pinned upstream bundle and original MPL sources.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const originals = {
  bundle: '2db7ec3a0e7a6ddacee901cd38db62a066c8c446bc37e4e38d4047d07a39fc68',
  mp4: 'bde5d41fdd4db0c4574be69e2e02f4732ade675366efaf030f52215a80eb76a8',
  adts: 'b2269b6e2218c16715ad33470560428e4cbab5c8e7c8301edaee6ace5564c2d3',
  misc: 'b15f691d7d9b17fe518fe9afd678eaa6d2f67eec961cb7a9257cc1c54c9ab4ec',
  flac: '7895b67f19d0bee698b1d9227616ea75589330bb0e5adafeee972f6759194c7a',
  codec: '77f2b6736f24e691ebb1d62b5dee321e8284069857ed5b1c04d2fdbc7fa27519',
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
  misc: [
    ['export const parsePsshBoxContents = (contents: Uint8Array): PsshBox => {\n',
      'const MENDO_MAX_PSSH_KEY_IDS = 4_000_000;\n\nexport const parsePsshBoxContents = (contents: Uint8Array): PsshBox => {\n\tif (contents.length < 24 || (contents[0]! > 0 && contents.length < 28)) {\n\t\tthrow new Error("Invalid MP4 encryption metadata");\n\t}\n'],
    ['\t\tpos += 4;\n\n\t\tif (kidCount > 0) {',
      '\t\tpos += 4;\n\t\tif (kidCount > Math.floor((contents.length - pos - 4) / 16)) {\n\t\t\tthrow new Error("Invalid MP4 encryption metadata");\n\t\t}\n\t\tif (kidCount > MENDO_MAX_PSSH_KEY_IDS) throw new Error("MP4 table metadata limit");\n\n\t\tif (kidCount > 0) {'],
    ['\tconst dataSize = view.getUint32(pos);\n\tpos += 4;\n',
      '\tconst dataSize = view.getUint32(pos);\n\tpos += 4;\n\tif (dataSize > contents.length - pos) throw new Error("Invalid MP4 encryption metadata");\n'],
  ],
  flac: [
    ['\t\t\t\tif (packetIndex === -1) {\n\t\t\t\t\tawait this.demuxer.advanceReader();',
      '\t\t\t\tif (packetIndex === -1) {\n\t\t\t\t\tif (this.demuxer.lastSampleLoaded) return null;\n\t\t\t\t\tawait this.demuxer.advanceReader();'],
  ],
  codec: [
    ['\tconst readLeb128 = (): number | null => {', '\tconst readLeb128 = (): number => {'],
    ['\t\tfor (let i = 0; i < 8; i++) {\n\t\t\tconst byte = bitstream.readAlignedByte();\n\n\t\t\tvalue |= ((byte & 0x7f) << (i * 7));',
      '\t\tfor (let i = 0; i < 8; i++) {\n\t\t\tif (bitstream.getBitsLeft() < 8) throw new Error("Invalid AV1 OBU size");\n\t\t\tconst byte = bitstream.readAlignedByte();\n\n\t\t\tvalue += (byte & 0x7f) * 2 ** (i * 7);\n\t\t\tif (value >= 2 ** 32 - 1) throw new Error("Invalid AV1 OBU size");'],
    ['\t\t\tif (i === 7 && (byte & 0x80)) {\n\t\t\t\treturn null;\n\t\t\t}',
      '\t\t\tif (i === 7 && (byte & 0x80)) {\n\t\t\t\tthrow new Error("Invalid AV1 OBU size");\n\t\t\t}'],
    ['\t\t// Spec requirement\n\t\tif (value >= 2 ** 32 - 1) {\n\t\t\treturn null;\n\t\t}\n\n\t\treturn value;', '\t\treturn value;'],
    ['\t\tif (obuExtension) {\n\t\t\tbitstream.skipBits(8);',
      '\t\tif (obuExtension) {\n\t\t\tif (bitstream.getBitsLeft() < 8) throw new Error("Invalid AV1 OBU size");\n\t\t\tbitstream.skipBits(8);'],
    ['\t\t\tconst obuSizeValue = readLeb128();\n\t\t\tif (obuSizeValue === null) return; // It was invalid\n\t\t\tobuSize = obuSizeValue;', '\t\t\tobuSize = readLeb128();'],
    ['\t\tassert(bitstream.pos % 8 === 0);\n\n\t\tyield {\n\t\t\ttype: obuType,',
      '\t\tif (obuSize > Math.floor(bitstream.getBitsLeft() / 8)) throw new Error("Invalid AV1 OBU size");\n\t\tassert(bitstream.pos % 8 === 0);\n\n\t\tyield {\n\t\t\ttype: obuType,'],
  ],
};
edits.bundle.push([
  'if(s===-1){await this.demuxer.advanceReader();continue}',
  'if(s===-1){if(this.demuxer.lastSampleLoaded)return null;await this.demuxer.advanceReader();continue}',
]);
edits.bundle.push([
  'io=function*(i){const e=new j(i),t=()=>{let r=0;for(let s=0;s<8;s++){const n=e.readAlignedByte();if(r|=(n&127)<<s*7,!(n&128))break;if(s===7&&n&128)return null}return r>=2**32-1?null:r};for(;e.getBitsLeft()>=8;){e.skipBits(1);const r=e.readBits(4),s=e.readBits(1),n=e.readBits(1);e.skipBits(1),s&&e.skipBits(8);let a;if(n){const o=t();if(o===null)return;a=o}else a=Math.floor(e.getBitsLeft()/8);p(e.pos%8===0),yield{type:r,data:i.subarray(e.pos/8,e.pos/8+a)},e.skipBits(a*8)}}',
  'io=function*(i){const e=new j(i),t=()=>{let r=0;for(let s=0;s<8;s++){if(e.getBitsLeft()<8)throw new Error("Invalid AV1 OBU size");const n=e.readAlignedByte();r+=(n&127)*2**(s*7);if(r>=2**32-1)throw new Error("Invalid AV1 OBU size");if(!(n&128))break;if(s===7)throw new Error("Invalid AV1 OBU size")}return r};for(;e.getBitsLeft()>=8;){e.skipBits(1);const r=e.readBits(4),s=e.readBits(1),n=e.readBits(1);e.skipBits(1);if(s){if(e.getBitsLeft()<8)throw new Error("Invalid AV1 OBU size");e.skipBits(8)}const a=n?t():Math.floor(e.getBitsLeft()/8);if(a>Math.floor(e.getBitsLeft()/8))throw new Error("Invalid AV1 OBU size");p(e.pos%8===0),yield{type:r,data:i.subarray(e.pos/8,e.pos/8+a)},e.skipBits(a*8)}}',
]);
// Charge retained physical tables and revisits before allocation/iteration.
// One demuxer budget spans boxes and tracks; compact constant-size tables
// charge one entry regardless of their logical sample count.
edits.bundle.push(
  ['ho=i=>{const e=H(i);let t=0;',
    'ho=i=>{if(i.length<24||(i[0]>0&&i.length<28))throw new Error("Invalid MP4 encryption metadata");const e=H(i);let t=0;'],
  ['const o=e.getUint32(t);if(t+=4,o>0){n=[];',
    'const o=e.getUint32(t);t+=4;if(o>Math.floor((i.length-t-4)/16))throw new Error("Invalid MP4 encryption metadata");if(o>MENDO_MAX_EXPANDED_MP4_SAMPLES*4)throw new Error("MP4 table metadata limit");if(o>0){n=[];'],
  ['const a=e.getUint32(t);return t+=4,{systemId:s,keyIds:n,data:i.slice(t,t+a)}',
    'const a=e.getUint32(t);t+=4;if(a>i.length-t)throw new Error("Invalid MP4 encryption metadata");return{systemId:s,keyIds:n,data:i.slice(t,t+a)}'],
  ['const a=ho(N(e,r.contentSize));this.currentFragment?',
    'const mendoPssh=N(e,r.contentSize),mendoKids=mendoPssh[0]>0&&mendoPssh.length>=24?H(mendoPssh).getUint32(20):0;mendoClaimMp4Table(this,mendoKids+1);const a=ho(mendoPssh);this.currentFragment?'],
  ['p(d!==null);for(let f=0;f<Math.min(u,o.samples.length);f++){',
    'p(d!==null);mendoClaimMp4Table(this,Math.min(u,o.samples.length));for(let f=0;f<Math.min(u,o.samples.length);f++){'],
  ['if(l){const w=le(e);g=[];for(let y=0;y<w;y++){',
    'if(l){const w=le(e);mendoClaimMp4Table(this,w);g=[];for(let y=0;y<w;y++){'],
  ['Ao=async(i,e,t)=>{', 'Ao=async(i,e,t,mendoDemuxer)=>{'],
  ['Ao(this.reader,o.encryptionInfo,a.encryptionAuxInfo)', 'Ao(this.reader,o.encryptionInfo,a.encryptionAuxInfo,this)'],
  ['Ao(this.internalTrack.demuxer.reader,this.internalTrack.encryptionInfo,this.internalTrack.encryptionAuxInfo)',
    'Ao(this.internalTrack.demuxer.reader,this.internalTrack.encryptionInfo,this.internalTrack.encryptionAuxInfo,this.internalTrack.demuxer)'],
  ['if(c>n){const d=le(s);u=[];for(let f=0;f<d;f++){',
    'if(c>n){const d=le(s);mendoClaimMp4Table(mendoDemuxer,d);u=[];for(let f=0;f<d;f++){'],
  ['const MENDO_MAX_EXPANDED_MP4_SAMPLES=1000000;\n',
    'const MENDO_MAX_EXPANDED_MP4_SAMPLES=1000000;\nfunction mendoClaimMp4Table(demuxer,count){const used=demuxer.mendoMetadataEntries||0;if(!Number.isSafeInteger(count)||count<0||count>MENDO_MAX_EXPANDED_MP4_SAMPLES*4-used)throw new Error("MP4 table metadata limit");demuxer.mendoMetadataEntries=used+count;}\n'],
  ['const o=F(e);let c=0,l=0;for(let u=0;u<o;u++){', 'const o=F(e);mendoClaimMp4Table(this,o);let c=0,l=0;for(let u=0;u<o;u++){'],
  ['const o=F(e);let c=0;for(let l=0;l<o;l++){', 'const o=F(e);mendoClaimMp4Table(this,o);let c=0;for(let l=0;l<o;l++){'],
  ['const o=F(e),c=F(e);if(o===0)for(let l=0;l<c;l++){', 'const o=F(e),c=F(e);mendoClaimMp4Table(this,o===0?c:1);if(o===0)for(let l=0;l<c;l++){'],
  ['throw new Error("Invalid MP4 compact sample width");const l=N(e,Math.ceil(c*o/8))', 'throw new Error("Invalid MP4 compact sample width");mendoClaimMp4Table(this,c);const l=N(e,Math.ceil(c*o/8))'],
  ['a.sampleTable.keySampleIndices=[];const o=F(e);', 'a.sampleTable.keySampleIndices=[];const o=F(e);mendoClaimMp4Table(this,o+1);'],
  ['const o=F(e);for(let l=0;l<o;l++){const u=F(e)-1,d=F(e),f=F(e);', 'const o=F(e);mendoClaimMp4Table(this,o+a.sampleTable.sampleToChunk.length);for(let l=0;l<o;l++){const u=F(e)-1,d=F(e),f=F(e);'],
  ['const o=F(e);for(let c=0;c<o;c++){const l=F(e);a.sampleTable.chunkOffsets.push(l)}', 'const o=F(e);mendoClaimMp4Table(this,o);for(let c=0;c<o;c++){const l=F(e);a.sampleTable.chunkOffsets.push(l)}'],
  ['const o=F(e);for(let c=0;c<o;c++){const l=Ue(e);a.sampleTable.chunkOffsets.push(l)}', 'const o=F(e);mendoClaimMp4Table(this,o);for(let c=0;c<o;c++){const l=Ue(e);a.sampleTable.chunkOffsets.push(l)}'],
  ['g=h[u],m=h[d],w=h[f],y=F(e);for(let k=0;k<y;k++){', 'g=h[u],m=h[d],w=h[f],y=F(e);mendoClaimMp4Table(this,y+c.fragmentLookupTable.length);for(let k=0;k<y;k++){'],
  ['const c=U(e),l=F(e);let u=null;c===0&&l>0&&(u=N(e,l));const d=So(a);',
    'const c=U(e),l=F(e);mendoClaimMp4Table(this,l);let u=null;c===0&&l>0&&(u=N(e,l));const d=So(a);'],
  ['for(let k=0;k<c.fragmentLookupTable.length-1;k++){const b=c.fragmentLookupTable[k],T=c.fragmentLookupTable[k+1];b.timestamp===T.timestamp&&(c.fragmentLookupTable.splice(k+1,1),k--)}',
    'let mendoWrite=0;for(const mendoEntry of c.fragmentLookupTable)if(mendoWrite===0||c.fragmentLookupTable[mendoWrite-1].timestamp!==mendoEntry.timestamp)c.fragmentLookupTable[mendoWrite++]=mendoEntry;c.fragmentLookupTable.length=mendoWrite;'],
);
edits.mp4.push(
  ['\t\t\t\tconst psshBox = parsePsshBoxContents(readBytes(slice, boxInfo.contentSize));',
    '\t\t\t\tconst contents = readBytes(slice, boxInfo.contentSize);\n\t\t\t\tconst keyCount = contents[0]! > 0 && contents.length >= 24\n\t\t\t\t\t? toDataView(contents).getUint32(20) : 0;\n\t\t\t\tmendoClaimMp4Table(this, keyCount + 1);\n\t\t\t\tconst psshBox = parsePsshBoxContents(contents);'],
  ['\t\t\t\tfor (let i = 0; i < Math.min(sampleCount, trackData.samples.length); i++) {',
    '\t\t\t\tmendoClaimMp4Table(this, Math.min(sampleCount, trackData.samples.length));\n\t\t\t\tfor (let i = 0; i < Math.min(sampleCount, trackData.samples.length); i++) {'],
  ['\t\t\t\t\t\tconst subsampleCount = readU16Be(slice);\n\t\t\t\t\t\tsubsamples = [];',
    '\t\t\t\t\t\tconst subsampleCount = readU16Be(slice);\n\t\t\t\t\t\tmendoClaimMp4Table(this, subsampleCount);\n\t\t\t\t\t\tsubsamples = [];'],
  ['\t\t\t\t\ttrackData.encryptionAuxInfo,\n\t\t\t\t);', '\t\t\t\t\ttrackData.encryptionAuxInfo,\n\t\t\t\t\tthis,\n\t\t\t\t);'],
  ['\t\t\t\t\tthis.internalTrack.encryptionAuxInfo,\n\t\t\t\t);', '\t\t\t\t\tthis.internalTrack.encryptionAuxInfo,\n\t\t\t\t\tthis.internalTrack.demuxer,\n\t\t\t\t);'],
  ['\taux: SampleEncryptionAuxInfo,\n) => {', '\taux: SampleEncryptionAuxInfo,\n\tdemuxer: IsobmffDemuxer,\n) => {'],
  ['\t\t\tconst subsampleCount = readU16Be(slice);\n\t\t\tsubsamples = [];',
    '\t\t\tconst subsampleCount = readU16Be(slice);\n\t\t\tmendoClaimMp4Table(demuxer, subsampleCount);\n\t\t\tsubsamples = [];'],
  ['const MENDO_MAX_EXPANDED_MP4_SAMPLES = 1_000_000;\n',
    'const MENDO_MAX_EXPANDED_MP4_SAMPLES = 1_000_000;\n\nfunction mendoClaimMp4Table(demuxer: IsobmffDemuxer, count: number) {\n\tif (!Number.isSafeInteger(count) || count < 0\n\t\t|| count > MENDO_MAX_EXPANDED_MP4_SAMPLES * 4 - demuxer.mendoMetadataEntries) {\n\t\tthrow new Error("MP4 table metadata limit");\n\t}\n\tdemuxer.mendoMetadataEntries += count;\n}\n'],
  ['export class IsobmffDemuxer extends Demuxer {\n', 'export class IsobmffDemuxer extends Demuxer {\n\tmendoMetadataEntries = 0;\n'],
  ['\t\t\t\tconst sampleCount = readU32Be(slice);\n\n\t\t\t\tif (sampleSize === 0)', '\t\t\t\tconst sampleCount = readU32Be(slice);\n\t\t\t\tmendoClaimMp4Table(this, sampleSize === 0 ? sampleCount : 1);\n\n\t\t\t\tif (sampleSize === 0)'],
  ['\t\t\t\tconst bytes = readBytes(slice, Math.ceil(sampleCount * fieldSize / 8));', '\t\t\t\tmendoClaimMp4Table(this, sampleCount);\n\t\t\t\tconst bytes = readBytes(slice, Math.ceil(sampleCount * fieldSize / 8));'],
  ['\t\t\t\tconst numberOfEntries = readU32Be(slice);\n', '\t\t\t\tconst numberOfEntries = readU32Be(slice);\n\t\t\t\tmendoClaimMp4Table(this, numberOfEntries + track.fragmentLookupTable.length);\n'],
  ['\t\t\t\tconst defaultSampleInfoSize = readU8(slice);\n\t\t\t\tconst sampleCount = readU32Be(slice);\n',
    '\t\t\t\tconst defaultSampleInfoSize = readU8(slice);\n\t\t\t\tconst sampleCount = readU32Be(slice);\n\t\t\t\tmendoClaimMp4Table(this, sampleCount);\n'],
  ['\t\t\t\tfor (let i = 0; i < track.fragmentLookupTable.length - 1; i++) {\n\t\t\t\t\tconst entry1 = track.fragmentLookupTable[i]!;\n\t\t\t\t\tconst entry2 = track.fragmentLookupTable[i + 1]!;\n\n\t\t\t\t\tif (entry1.timestamp === entry2.timestamp) {\n\t\t\t\t\t\ttrack.fragmentLookupTable.splice(i + 1, 1);\n\t\t\t\t\t\ti--;\n\t\t\t\t\t}\n\t\t\t\t}',
    '\t\t\t\tlet write = 0;\n\t\t\t\tfor (const entry of track.fragmentLookupTable) {\n\t\t\t\t\tif (write === 0 || track.fragmentLookupTable[write - 1]!.timestamp !== entry.timestamp) {\n\t\t\t\t\t\ttrack.fragmentLookupTable[write++] = entry;\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t\ttrack.fragmentLookupTable.length = write;'],
);
for (const [kind, charge] of Object.entries({ stts: 'entryCount', ctts: 'entryCount', stss: 'entryCount + 1',
  stsc: 'entryCount + track.sampleTable.sampleToChunk.length', stco: 'entryCount', co64: 'entryCount' })) {
  // Include the case prefix to keep each original anchor unambiguous.
  const prefix = `\t\t\tcase '${kind}': {\n\t\t\t\tconst track = this.currentTrack;\n\t\t\t\tif (!track) {\n\t\t\t\t\tbreak;\n\t\t\t\t}\n\n\t\t\t\tif (!track.sampleTable) {\n\t\t\t\t\tbreak;\n\t\t\t\t}\n\n`;
  const skip = kind === 'ctts' ? '\t\t\t\tslice.skip(1 + 3); // Version + flags\n\n'
    : kind === 'stsc' ? '\t\t\t\tslice.skip(4);\n\n' : '\t\t\t\tslice.skip(4); // Version + flags\n\n';
  const extra = kind === 'stss' ? '\t\t\t\ttrack.sampleTable.keySampleIndices = [];\n\n' : '';
  const anchor = `${prefix}${skip}${extra}\t\t\t\tconst entryCount = readU32Be(slice);`;
  edits.mp4.push([anchor, `${anchor}\n\t\t\t\tmendoClaimMp4Table(this, ${charge});`]);
}
// Project the demuxer's existing physical sample extent without introducing a
// second index or treating container metadata as validated media ownership.
edits.bundle.push([
  'return this.packetToSampleIndex.set(c,e),c',
  'return Object.defineProperty(c,"mendoMp4Extent",{value:Object.freeze({offset:s.sampleOffset,byteLength:s.sampleSize})}),this.packetToSampleIndex.set(c,e),c',
]);
edits.mp4.push([
  '\t\tthis.packetToSampleIndex.set(packet, sampleIndex);',
  '\t\tObject.defineProperty(packet, "mendoMp4Extent", {\n\t\t\tvalue: Object.freeze({ offset: sampleInfo.sampleOffset, byteLength: sampleInfo.sampleSize }),\n\t\t});\n\n\t\tthis.packetToSampleIndex.set(packet, sampleIndex);',
]);
edits.bundle.push([
  'return this.packetToFragmentLocation.set(l,{fragment:e,sampleIndex:t}),l',
  'return Object.defineProperty(l,"mendoMp4Extent",{value:Object.freeze({offset:n.byteOffset,byteLength:n.byteSize})}),this.packetToFragmentLocation.set(l,{fragment:e,sampleIndex:t}),l',
]);
edits.mp4.push([
  '\t\tthis.packetToFragmentLocation.set(packet, { fragment, sampleIndex });',
  '\t\tObject.defineProperty(packet, "mendoMp4Extent", {\n\t\t\tvalue: Object.freeze({ offset: fragmentSample.byteOffset, byteLength: fragmentSample.byteSize }),\n\t\t});\n\n\t\tthis.packetToFragmentLocation.set(packet, { fragment, sampleIndex });',
]);
// Bound regular MP4 lookup work by the normalized physical sample table.
// One lazy prefix index also avoids rescanning a whole chunk for each packet.
edits.bundle.push(
  ['const MENDO_MAX_EXPANDED_MP4_SAMPLES=1000000;\n',
    'const MENDO_MAX_EXPANDED_MP4_SAMPLES=1000000;\nconst MENDO_MP4_SAMPLE_SIZE_PREFIXES=new WeakMap();\n'],
  ['let g=0,m=f;if(i.sampleSizes.length===1)m+=c*(e-h),g+=c*u.samplesPerChunk;else for(let y=h;y<h+u.samplesPerChunk;y++){const k=i.sampleSizes[y];y<e&&(m+=k),g+=k}',
    'const mendoEnd=h+u.samplesPerChunk;if(!Number.isSafeInteger(d)||d<0||d>=i.chunkOffsets.length||!Number.isSafeInteger(h)||h<0||!Number.isSafeInteger(u.samplesPerChunk)||u.samplesPerChunk<1||!Number.isSafeInteger(mendoEnd)||!Number.isSafeInteger(e)||e<h||e>=mendoEnd)throw new Error("Invalid MP4 chunk range");let g=0,m=f;if(i.sampleSizes.length===1)m+=c*(e-h),g+=c*u.samplesPerChunk;else{if(mendoEnd>i.sampleSizes.length||i.sampleSizes.length>MENDO_MAX_EXPANDED_MP4_SAMPLES*4)throw new Error("Invalid MP4 chunk range");let mendoPrefix=MENDO_MP4_SAMPLE_SIZE_PREFIXES.get(i);if(!mendoPrefix){mendoPrefix=new Float64Array(i.sampleSizes.length+1);for(let mendoIndex=0;mendoIndex<i.sampleSizes.length;mendoIndex++){const mendoSum=mendoPrefix[mendoIndex]+i.sampleSizes[mendoIndex];if(!Number.isSafeInteger(mendoSum)||mendoSum<mendoPrefix[mendoIndex])throw new Error("Invalid MP4 chunk range");mendoPrefix[mendoIndex+1]=mendoSum}MENDO_MP4_SAMPLE_SIZE_PREFIXES.set(i,mendoPrefix)}m+=mendoPrefix[e]-mendoPrefix[h];g=mendoPrefix[mendoEnd]-mendoPrefix[h]}'],
);
edits.mp4.push(
  ['const getSampleInfo = (sampleTable: SampleTable, sampleIndex: number): SampleInfo | null => {',
    'const MENDO_MP4_SAMPLE_SIZE_PREFIXES = new WeakMap<SampleTable, Float64Array>();\n\nconst getSampleInfo = (sampleTable: SampleTable, sampleIndex: number): SampleInfo | null => {'],
  ['\tlet chunkSize = 0;\n\tlet sampleOffset = chunkOffset;',
    '\tconst endSampleIndexOfChunk = startSampleIndexOfChunk + chunkEntry.samplesPerChunk;\n\tif (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= sampleTable.chunkOffsets.length\n\t\t|| !Number.isSafeInteger(startSampleIndexOfChunk) || startSampleIndexOfChunk < 0\n\t\t|| !Number.isSafeInteger(chunkEntry.samplesPerChunk) || chunkEntry.samplesPerChunk < 1\n\t\t|| !Number.isSafeInteger(endSampleIndexOfChunk) || !Number.isSafeInteger(sampleIndex)\n\t\t|| sampleIndex < startSampleIndexOfChunk || sampleIndex >= endSampleIndexOfChunk) {\n\t\tthrow new Error("Invalid MP4 chunk range");\n\t}\n\tlet chunkSize = 0;\n\tlet sampleOffset = chunkOffset;'],
  ['\t\tfor (let i = startSampleIndexOfChunk; i < startSampleIndexOfChunk + chunkEntry.samplesPerChunk; i++) {\n\t\t\tconst sampleSize = sampleTable.sampleSizes[i]!;\n\n\t\t\tif (i < sampleIndex) {\n\t\t\t\tsampleOffset += sampleSize;\n\t\t\t}\n\t\t\tchunkSize += sampleSize;\n\t\t}',
    '\t\tif (endSampleIndexOfChunk > sampleTable.sampleSizes.length\n\t\t\t|| sampleTable.sampleSizes.length > MENDO_MAX_EXPANDED_MP4_SAMPLES * 4) {\n\t\t\tthrow new Error("Invalid MP4 chunk range");\n\t\t}\n\t\tlet prefix = MENDO_MP4_SAMPLE_SIZE_PREFIXES.get(sampleTable);\n\t\tif (!prefix) {\n\t\t\tprefix = new Float64Array(sampleTable.sampleSizes.length + 1);\n\t\t\tfor (let i = 0; i < sampleTable.sampleSizes.length; i++) {\n\t\t\t\tconst sum = prefix[i]! + sampleTable.sampleSizes[i]!;\n\t\t\t\tif (!Number.isSafeInteger(sum) || sum < prefix[i]!) {\n\t\t\t\t\tthrow new Error("Invalid MP4 chunk range");\n\t\t\t\t}\n\t\t\t\tprefix[i + 1] = sum;\n\t\t\t}\n\t\t\tMENDO_MP4_SAMPLE_SIZE_PREFIXES.set(sampleTable, prefix);\n\t\t}\n\t\tsampleOffset += prefix[sampleIndex]! - prefix[startSampleIndexOfChunk]!;\n\t\tchunkSize = prefix[endSampleIndexOfChunk]! - prefix[startSampleIndexOfChunk]!;'],
);
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
  if (inputs.length !== 6) throw new Error('Usage: node scripts/patch-mediabunny.cjs <original-bundle> <original-isobmff-demuxer.ts> <original-adts-reader.ts> <original-isobmff-misc.ts> <original-flac-demuxer.ts> <original-codec-data.ts>');
  const area = path.resolve(__dirname, '../extension/vendor/mediabunny');
  const outputs = ['bundle', 'mp4', 'adts', 'misc', 'flac', 'codec'].map((kind, index) => {
    const bytes = fs.readFileSync(inputs[index]);
    if (hash(bytes) !== originals[kind]) throw new Error(`Unexpected original ${kind} hash`);
    return { file: { bundle: 'mediabunny.min.mjs', mp4: 'isobmff-demuxer.ts', adts: 'adts-reader.ts', misc: 'isobmff-misc.ts', flac: 'flac-demuxer.ts', codec: 'codec-data.ts' }[kind], bytes: transform(kind, bytes) };
  });
  for (const output of outputs) fs.writeFileSync(path.join(area, output.file), output.bytes);
}
module.exports = { originals, transform, hash };

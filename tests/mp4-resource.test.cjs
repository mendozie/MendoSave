const assert = require('node:assert/strict');
const { test } = require('node:test');
let smallBudgetModule;
function smallBudgetLibrary() {
  // Scale only the fixed metadata-object budget; exercise the actual parser
  // with tiny fixtures instead of allocating a million sample objects.
  const source = require('node:fs').readFileSync('extension/vendor/mediabunny/mediabunny.min.mjs', 'utf8')
    .replace('const MENDO_MAX_EXPANDED_MP4_SAMPLES=1000000;', 'const MENDO_MAX_EXPANDED_MP4_SAMPLES=3;');
  return smallBudgetModule ||= import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const mediabunny = smallBudgetLibrary();

test('shipped bundle and modified MPL sources round-trip to pinned originals', () => {
  const { originals, transform, hash } = require('../scripts/patch-mediabunny.cjs');
  for (const [kind, file] of Object.entries({ bundle: 'mediabunny.min.mjs', mp4: 'isobmff-demuxer.ts', adts: 'adts-reader.ts' })) {
    const shipped = require('node:fs').readFileSync(require('node:path').join(__dirname, '../extension/vendor/mediabunny', file));
    const original = transform(kind, shipped, true);
    assert.equal(hash(original), originals[kind]);
    assert.deepEqual(transform(kind, original), shipped);
    assert.throws(() => transform(kind, Buffer.from('unexpected source')), /Unexpected .* patch anchor/);
  }
});

const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf']);
function box(type, payload) {
  const bytes = Buffer.alloc(8 + payload.length);
  bytes.writeUInt32BE(bytes.length); bytes.write(type, 4, 'ascii'); payload.copy(bytes, 8);
  return bytes;
}
function rewriteBoxes(bytes, transform) {
  const output = [];
  for (let at = 0; at < bytes.length;) {
    const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    assert.ok(size >= 8 && at + size <= bytes.length, 'controlled fixture has complete boxes');
    let payload = bytes.subarray(at + 8, at + size);
    if (containers.has(type)) payload = rewriteBoxes(payload, transform);
    output.push(transform(type, payload) || box(type, payload));
    at += size;
  }
  return Buffer.concat(output);
}
async function fixture(lib, fragmented = false) {
  const target = new lib.BufferTarget();
  const output = new lib.Output({ target,
    format: new lib.Mp4OutputFormat({ fastStart: fragmented ? 'fragmented' : 'in-memory' }) });
  const source = new lib.EncodedAudioPacketSource('aac');
  output.addAudioTrack(source);
  await output.start();
  for (let i = 0; i < 2; i++) await source.add(new lib.EncodedPacket(Uint8Array.of(1, 2, 3), 'key', i * 0.02, 0.02), {
    decoderConfig: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1, description: Uint8Array.of(0x11, 0x88) },
  });
  await output.finalize();
  return Buffer.from(target.buffer);
}
async function inspect(lib, bytes) {
  const input = new lib.Input({ formats: lib.ALL_FORMATS, source: new lib.BufferSource(bytes) });
  try { return await input.computeDuration(); } finally { input.dispose(); }
}

test('actual MP4 input bounds physical metadata entries across valid widths and repeated tables', async () => {
  const lib = await mediabunny, original = await fixture(lib);
  for (const width of [4, 8, 16]) {
    const hostile = rewriteBoxes(original, type => {
      if (type !== 'stsz') return;
      const table = Buffer.alloc(12 + Math.ceil(64 * width / 8));
      table[7] = width; table.writeUInt32BE(64, 8);
      return box('stz2', table);
    });
    await assert.rejects(inspect(lib, hostile), /MP4 (?:sample|table) metadata limit/);
  }
  for (const type of ['stts', 'stsc', 'stco']) {
    const hostile = rewriteBoxes(original, (name, payload) => name === type
      ? Buffer.concat(Array.from({ length: 16 }, () => box(name, payload))) : undefined);
    await assert.rejects(inspect(lib, hostile), /MP4 (?:sample|table) metadata limit/);
  }
  const entryBytes = { stts: 8, ctts: 8, stss: 4, stsc: 12, stco: 4, co64: 8 };
  for (const [kind, bytes] of Object.entries(entryBytes)) {
    const table = Buffer.alloc(8 + 64 * bytes); table.writeUInt32BE(64, 4);
    const hostile = rewriteBoxes(original, (name, payload) => name === 'stbl'
      ? box(name, Buffer.concat([payload, box(kind, table)])) : undefined);
    await assert.rejects(inspect(lib, hostile), /MP4 table metadata limit/);
  }
  const variableSizes = rewriteBoxes(original, name => {
    if (name !== 'stsz') return;
    const table = Buffer.alloc(12 + 64 * 4); table.writeUInt32BE(64, 8);
    return box(name, table);
  });
  await assert.rejects(inspect(lib, variableSizes), /MP4 table metadata limit/);
  for (const tracks of [2, 3]) {
    const combined = rewriteBoxes(original, (name, payload) => name === 'trak'
      ? Buffer.concat(Array.from({ length: tracks }, (_, index) => box(name,
        rewriteBoxes(payload, (type, data) => {
          if (type !== 'tkhd') return;
          const header = Buffer.from(data); header.writeUInt32BE(index + 1, 12); return box(type, header);
        })))) : undefined);
    if (tracks === 2) assert.equal(await inspect(lib, combined), 0.04);
    else await assert.rejects(inspect(lib, combined), /MP4 table metadata limit/);
  }
});

function fragmentIndex(bytes, count, copies = 1) {
  let moofOffset = 0;
  for (let at = 0; at < bytes.length; at += bytes.readUInt32BE(at)) {
    if (bytes.toString('ascii', at + 4, at + 8) === 'moof') { moofOffset = at; break; }
  }
  assert.ok(moofOffset);
  const entries = Buffer.alloc(16 + count * 11); entries.writeUInt32BE(1, 4); entries.writeUInt32BE(count, 12);
  for (let i = 0; i < count; i++) { entries.writeUInt32BE(moofOffset, 16 + i * 11 + 4); entries.fill(1, 16 + i * 11 + 8, 16 + i * 11 + 11); }
  const footer = Buffer.alloc(8), tfra = box('tfra', entries);
  footer.writeUInt32BE(8 + tfra.length * copies + 16, 4);
  return Buffer.concat([bytes, box('mfra', Buffer.concat([...Array(copies).fill(tfra), box('mfro', footer)]))]);
}

test('actual sized MP4 input accepts repeated index timestamps and bounds aggregate index entries', async () => {
  const lib = await mediabunny, original = await fixture(lib, true);
  assert.equal(await inspect(lib, fragmentIndex(original, 3)), 0.04);
  await assert.rejects(inspect(lib, fragmentIndex(original, 64)), /MP4 (?:sample|table) metadata limit/);
  assert.equal(await inspect(lib, fragmentIndex(original, 4, 2)), 0.04);
  await assert.rejects(inspect(lib, fragmentIndex(original, 4, 3)), /MP4 table metadata limit/);
});

test('actual MP4 input rejects invalid compact sample widths before expanding sample counts', async () => {
  const lib = await mediabunny;
  const original = await fixture(lib);
  assert.equal(await inspect(lib, original), 0.04);
  for (const width of [4, 8, 16]) {
    const compact = rewriteBoxes(original, (type) => {
      if (type !== 'stsz') return;
      const table = Buffer.alloc(12 + width / 4);
      table[7] = width; table.writeUInt32BE(2, 8);
      if (width === 4) table[12] = 0x33;
      if (width === 8) table.fill(3, 12);
      if (width === 16) { table.writeUInt16BE(3, 12); table.writeUInt16BE(3, 14); }
      return box('stz2', table);
    });
    assert.equal(await inspect(lib, compact), 0.04);
  }
  for (const width of [0, 1, 32]) {
    const hostile = rewriteBoxes(original, (type) => {
      if (type !== 'stsz') return;
      const table = Buffer.alloc(12 + Math.ceil(64 * width / 8));
      table[7] = width; table.writeUInt32BE(64, 8);
      return box('stz2', table);
    });
    await assert.rejects(inspect(lib, hostile), /Invalid MP4 compact sample width/);
  }
});

test('actual PCM input bounds chunk expansion by real chunk offsets', async () => {
  const lib = await mediabunny;
  const target = new lib.BufferTarget();
  const output = new lib.Output({ target, format: new lib.Mp4OutputFormat({ fastStart: 'in-memory' }) });
  const source = new lib.EncodedAudioPacketSource('pcm-s16');
  output.addAudioTrack(source); await output.start();
  await source.add(new lib.EncodedPacket(new Uint8Array(1920), 'key', 0, 0.02), {
    decoderConfig: { codec: 'pcm-s16', sampleRate: 48000, numberOfChannels: 1 },
  });
  await output.finalize();
  const original = Buffer.from(target.buffer);
  assert.equal(await inspect(lib, original), 0.02);
  const hostile = rewriteBoxes(original, (type, payload) => {
    if (type !== 'stsc') return;
    const chunks = Buffer.concat([payload, payload.subarray(8, 20)]);
    chunks.writeUInt32BE(2, 4); chunks.writeUInt32BE(9, 20);
    return box(type, chunks);
  });
  await assert.rejects(inspect(lib, hostile), /Invalid MP4 chunk range/);
});

test('actual MP4 input bounds presentation-table expansion from compact timing counts', async () => {
  const lib = await smallBudgetLibrary();
  const original = await fixture(lib);
  assert.equal(await inspect(lib, original), 0.04);
  const hostile = rewriteBoxes(original, (type, payload) => {
    if (type === 'stts') {
      const timing = Buffer.from(payload); timing.writeUInt32BE(64, 8);
      return box(type, timing);
    }
    if (type === 'stbl') {
      const composition = Buffer.alloc(16); composition.writeUInt32BE(1, 4); composition.writeUInt32BE(64, 8);
      return box(type, Buffer.concat([payload, box('ctts', composition)]));
    }
  });
  await assert.rejects(inspect(lib, hostile), /MP4 sample metadata limit/);
});

test('actual fragmented MP4 input preserves valid defaults and bounds cumulative sample objects', async () => {
  const lib = await smallBudgetLibrary();
  const original = await fixture(lib, true);
  const withDefaultRuns = (counts) => rewriteBoxes(original, (type, payload) => {
    if (type === 'tfhd') {
      const defaults = Buffer.alloc(20); defaults.writeUInt32BE(0x020038);
      defaults.writeUInt32BE(payload.readUInt32BE(4), 4);
      defaults.writeUInt32BE(960, 8); defaults.writeUInt32BE(3, 12);
      return box(type, defaults);
    }
    if (type === 'trun') return Buffer.concat(counts.map((count) => {
      const run = Buffer.alloc(8); run.writeUInt32BE(count, 4);
      return box(type, run);
    }));
  });
  assert.equal(await inspect(lib, withDefaultRuns([2])), 0.04);
  await assert.rejects(inspect(lib, withDefaultRuns([64])), /MP4 sample metadata limit/);
  await assert.rejects(inspect(lib, withDefaultRuns([2, 2])), /MP4 sample metadata limit/);
});

test('surplus composition counts cannot force billions of empty iterations', async () => {
  const lib = await mediabunny;
  const original = await fixture(lib);
  const hostile = rewriteBoxes(original, (type, payload) => {
    if (type !== 'stbl') return;
    const composition = Buffer.alloc(16); composition.writeUInt32BE(1, 4); composition.writeUInt32BE(0xffffffff, 8);
    return box(type, Buffer.concat([payload, box('ctts', composition)]));
  });
  // The original parser iterates over the count even when all sample indices
  // are absent. A terminable child bounds the safe CPU-only reproducer.
  const program = `const lib = await import('./extension/vendor/mediabunny/mediabunny.min.mjs');
    const input = new lib.Input({ formats: lib.ALL_FORMATS, source: new lib.BufferSource(Buffer.from(process.argv[1], 'base64')) });
    try { const duration = await input.computeDuration(); if (duration !== 0.04) throw new Error('Changed valid timing'); }
    finally { input.dispose(); }`;
  const result = require('node:child_process').spawnSync(process.execPath,
    ['--input-type=module', '-e', program, hostile.toString('base64')],
    { cwd: require('node:path').resolve(__dirname, '..'), timeout: 3000, encoding: 'utf8' });
  assert.equal(result.error, undefined, 'sample indices outside the real table must not consume unbounded CPU');
  assert.equal(result.status, 0, result.stderr);
});

test('actual AAC input rejects frame lengths shorter than their ADTS headers', async () => {
  const lib = await mediabunny;
  function adts(length, crc = false) {
    const bytes = Buffer.alloc(Math.max(length, 10));
    bytes.set([0xff, crc ? 0xf0 : 0xf1, 0x4c, 0x40, 0, 0x1f, 0xfc]);
    bytes[3] |= length >> 11 & 3; bytes[4] = length >> 3 & 255; bytes[5] |= length << 5 & 0xe0;
    return bytes;
  }
  const valid = new lib.Input({ formats: lib.ALL_FORMATS, source: new lib.BufferSource(Buffer.concat([adts(10), adts(10)])) });
  try { assert.ok(await valid.getPrimaryAudioTrack()); } finally { valid.dispose(); }
  const validCrc = new lib.Input({ formats: lib.ALL_FORMATS, source: new lib.BufferSource(Buffer.concat([adts(12, true), adts(12, true)])) });
  try { assert.ok(await validCrc.getPrimaryAudioTrack()); } finally { validCrc.dispose(); }
  for (const [length, crc] of [[0, false], [6, false], [8, true]]) {
    const input = new lib.Input({ formats: lib.ALL_FORMATS, source: new lib.BufferSource(adts(length, crc)) });
    try { await assert.rejects(input.getPrimaryAudioTrack(), /Invalid ADTS frame length/); }
    finally { input.dispose(); }
  }
});

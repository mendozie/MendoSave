const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const library = import(pathToFileURL(path.join(process.cwd(), 'extension/vendor/mediabunny/mediabunny.min.mjs')).href);

function box(type, payload) {
  const bytes = Buffer.alloc(8 + payload.length);
  bytes.writeUInt32BE(bytes.length); bytes.write(type, 4, 'ascii'); payload.copy(bytes, 8);
  return bytes;
}
const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
function rewrite(bytes, update) {
  const parts = [];
  for (let at = 0; at < bytes.length;) {
    const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    assert.ok(size >= 8 && at + size <= bytes.length);
    let payload = bytes.subarray(at + 8, at + size);
    if (containers.has(type)) payload = rewrite(payload, update);
    parts.push(update(type, payload) || box(type, payload));
    at += size;
  }
  return Buffer.concat(parts);
}
async function fixture(lib) {
  const target = new lib.BufferTarget();
  const output = new lib.Output({ target, format: new lib.Mp4OutputFormat({ fastStart: false }) });
  const source = new lib.EncodedAudioPacketSource('aac'); output.addAudioTrack(source);
  await output.start();
  for (const [i, data] of [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6, 7)].entries()) {
    await source.add(new lib.EncodedPacket(data, 'key', i * 0.02, 0.02), {
      decoderConfig: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1,
        description: Uint8Array.of(0x11, 0x88) },
    });
  }
  await output.finalize();
  return Buffer.from(target.buffer);
}
async function first(lib, bytes, metadataOnly) {
  const input = new lib.Input({ formats: [lib.MP4], source: new lib.BufferSource(bytes) });
  try {
    const track = await input.getPrimaryAudioTrack();
    return await new lib.EncodedPacketSink(track).getFirstPacket({ metadataOnly });
  } finally { input.dispose(); }
}

test('regular MP4 packet lookup rejects a chunk beyond its physical variable sample table', async () => {
  const lib = await library, valid = await fixture(lib);
  assert.deepEqual((await first(lib, valid, false)).data, Uint8Array.of(1, 2, 3));
  let changed = false;
  const invalid = rewrite(valid, (type, payload) => {
    if (type !== 'stsc') return;
    const value = Buffer.from(payload);
    assert.equal(value.readUInt32BE(4), 1);
    value.writeUInt32BE(3, 12); changed = true;
    return box(type, value);
  });
  assert.ok(changed);
  // Three declared samples versus two physical rows reproduces the bad
  // boundary without executing the original uint32-max synchronous loop.
  for (const metadataOnly of [true, false]) {
    await assert.rejects(first(lib, invalid, metadataOnly), /Invalid MP4 chunk range/);
  }
});

function child(program, bytes, timeout = 3000) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    const lib = await import('./extension/vendor/mediabunny/mediabunny.min.mjs');
    const bytes = fs.readFileSync(0);
    ${program}`], { cwd: path.resolve(__dirname, '..'), input: bytes,
    timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
}
function emptyFlac(tail = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(42);
  bytes.write('fLaC'); bytes[4] = 0x80; bytes.writeUIntBE(34, 5, 3);
  bytes.writeUInt16BE(16, 8); bytes.writeUInt16BE(16, 10);
  bytes.writeBigUInt64BE((8000n << 44n) | (15n << 36n), 18);
  return Buffer.concat([bytes, tail]);
}
test('empty FLAC duration settles after EOF instead of retrying an empty lookup', () => {
  const result = child(`
    const input = new lib.Input({ formats: [lib.FLAC], source: new lib.BufferSource(bytes) });
    try {
      const [track] = await input.getAudioTracks();
      assert.equal(track.codec, 'flac');
      assert.equal(await new lib.EncodedPacketSink(track).getFirstPacket(), null);
      console.log('reached empty timestamp lookup');
      assert.equal(await input.computeDuration(), 0);
    } finally { input.dispose(); }
  `, emptyFlac());
  assert.match(result.stdout, /reached empty timestamp lookup/);
  assert.equal(result.error, undefined, 'a terminal empty FLAC track must settle');
  assert.equal(result.status, 0, result.stderr);
});

async function av1Fixture() {
  const lib = await library;
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/parser-control-av1.mp4'));
  const input = new lib.Input({ formats: [lib.MP4], source: new lib.BufferSource(bytes) });
  try {
    const track = await input.getPrimaryVideoTrack();
    assert.equal(track.codec, 'av1');
    assert.match((await track.getDecoderConfig()).codec, /^av01\./);
    const packet = await new lib.EncodedPacketSink(track).getFirstPacket({ verifyKeyPackets: true });
    assert.equal(packet.type, 'key');
    return { bytes, extent: packet.mendoMp4Extent };
  } finally { input.dispose(); }
}
function av1Packet(fixture, packet, removeConfig = false) {
  const mdat = fixture.bytes.indexOf(Buffer.from('mdat'));
  assert.ok(mdat > 4 && mdat < fixture.bytes.indexOf(Buffer.from('moov')));
  const inside = fixture.extent.offset - mdat - 4;
  const changed = rewrite(fixture.bytes, (type, payload) => {
    if (type === 'mdat') return box(type, Buffer.concat([payload.subarray(0, inside),
      Buffer.from(packet), payload.subarray(inside + fixture.extent.byteLength)]));
    if (type !== 'stsz') return;
    const table = Buffer.from(payload);
    assert.equal(table.readUInt32BE(4), 0);
    assert.equal(table.readUInt32BE(8), 2);
    table.writeUInt32BE(packet.length, 12);
    return box(type, table);
  });
  if (removeConfig) {
    const at = changed.indexOf(Buffer.from('av1C'));
    assert.ok(at >= 4 && changed.indexOf(Buffer.from('av1C'), at + 4) === -1);
    changed.write('free', at, 'ascii');
  }
  return changed;
}
test('AV1 codec probing rejects a length that could rewind the OBU iterator', async () => {
  const fixture = await av1Fixture();
  // Unsigned 0xfffffffa became -6 in the original signed bitwise accumulator.
  const bytes = av1Packet(fixture, [0x02, 0xfa, 0xff, 0xff, 0xff, 0x0f], true);
  const result = child(`
    const input = new lib.Input({ formats: [lib.MP4], source: new lib.BufferSource(bytes) });
    try {
      const track = await input.getPrimaryVideoTrack();
      assert.equal(track.codec, 'av1');
      console.log('reached AV1 codec probe');
      await assert.rejects(track.getDecoderConfig(), /Invalid AV1 OBU size/);
    } finally { input.dispose(); }
  `, bytes);
  assert.match(result.stdout, /reached AV1 codec probe/);
  assert.equal(result.error, undefined, 'malformed OBU lookup must settle');
  assert.equal(result.status, 0, result.stderr);
});

test('MP4 uint32 chunk declarations are rejected through timestamp and key lookup modes', async () => {
  const valid = await fixture(await library);
  for (const count of [0, 0xffffffff]) {
    const bytes = rewrite(valid, (type, payload) => {
      if (type !== 'stsc') return;
      const table = Buffer.from(payload); table.writeUInt32BE(count, 12);
      return box(type, table);
    });
    const result = child(`
      for (const metadataOnly of [false, true]) {
        const input = new lib.Input({ formats: [lib.MP4], source: new lib.BufferSource(bytes) });
        try {
          const track = await input.getPrimaryAudioTrack(), sink = new lib.EncodedPacketSink(track);
          for (const lookup of [() => sink.getFirstPacket({metadataOnly}),
            () => sink.getPacket(Infinity, {metadataOnly}),
            () => sink.getKeyPacket(0, {metadataOnly}), () => input.computeDuration()]) {
            await assert.rejects(lookup(), /Invalid MP4 chunk range/);
          }
        } finally { input.dispose(); }
      }
    `, bytes);
    assert.equal(result.error, undefined, `chunk declaration ${count} must settle`);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('MP4 variable stsz and compact 4/8/16-bit samples retain bytes and seek extents', async () => {
  const lib = await library, valid = await fixture(lib);
  const cases = [valid, ...[4, 8, 16].map(width => rewrite(valid, (type) => {
    if (type !== 'stsz') return;
    const table = Buffer.alloc(12 + width / 4);
    table[7] = width; table.writeUInt32BE(2, 8);
    if (width === 4) table[12] = 0x34;
    else if (width === 8) { table[12] = 3; table[13] = 4; }
    else { table.writeUInt16BE(3, 12); table.writeUInt16BE(4, 14); }
    return box('stz2', table);
  }))];
  for (const bytes of cases) {
    const input = new lib.Input({ formats: [lib.MP4], source: new lib.BufferSource(bytes) });
    try {
      const track = await input.getPrimaryAudioTrack(), sink = new lib.EncodedPacketSink(track);
      const one = await sink.getFirstPacket(), two = await sink.getNextPacket(one);
      assert.deepEqual(one.data, Uint8Array.of(1, 2, 3));
      assert.deepEqual(two.data, Uint8Array.of(4, 5, 6, 7));
      assert.equal(two.mendoMp4Extent.offset, one.mendoMp4Extent.offset + 3);
      assert.deepEqual((await sink.getPacket(0.02)).data, two.data);
      assert.deepEqual((await sink.getKeyPacket(Infinity)).data, two.data);
      assert.deepEqual((await sink.getPacket(0)).data, one.data);
      assert.equal(await sink.getNextPacket(two), null);
      assert.equal(await input.computeDuration(), 0.04);
    } finally { input.dispose(); }
  }
});

test('empty FLAC lookups release the mutex for cold, known-EOF and truncated-tail states', () => {
  const result = child(`
    for (const length of [0, 1, 15, 16, 64]) for (const knownEof of [false, true]) {
      const input = new lib.Input({ formats: [lib.FLAC],
        source: new lib.BufferSource(Buffer.concat([bytes, Buffer.alloc(length)])) });
      try {
        const track = await input.getPrimaryAudioTrack(), sink = new lib.EncodedPacketSink(track);
        if (knownEof) assert.equal(await sink.getFirstPacket(), null);
        assert.equal(await sink.getPacket(-1), null);
        for (const metadataOnly of [false, true]) {
          assert.deepEqual(await Promise.all([
            sink.getPacket(0, {metadataOnly}), sink.getPacket(1, {metadataOnly}),
            sink.getKeyPacket(Infinity, {metadataOnly}), input.computeDuration(),
          ]), [null, null, null, 0]);
        }
      } finally { input.dispose(); }
    }
  `, emptyFlac());
  assert.equal(result.error, undefined, 'empty timestamp operations must terminate and release their lock');
  assert.equal(result.status, 0, result.stderr);
});

test('FLAC valid multi-frame packets, duration and backward/last-packet seeks are preserved', async () => {
  const lib = await library;
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/parser-control.flac'));
  // Independent ffprobe control: five frames at 90/325/560/795/1030,
  // 192 samples each at 8 kHz; the last frame contains 236 bytes.
  for (const unknownDuration of [false, true]) {
    const bytes = Buffer.from(fixture);
    if (unknownDuration) bytes.writeBigUInt64BE(bytes.readBigUInt64BE(18) & ~((1n << 36n) - 1n), 18);
    const input = new lib.Input({ formats: [lib.FLAC], source: new lib.BufferSource(bytes) });
    let sink;
    try {
      const track = await input.getPrimaryAudioTrack(); sink = new lib.EncodedPacketSink(track);
      const packets = [];
      for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) packets.push(packet);
      assert.deepEqual(packets.map(p => p.data.length), [235, 235, 235, 235, 236]);
      assert.deepEqual(Buffer.concat(packets.map(p => Buffer.from(p.data))), fixture.subarray(90));
      assert.equal(await input.computeDuration(), 0.12);
      assert.deepEqual((await sink.getPacket(0.035)).data, packets[1].data);
      assert.deepEqual((await sink.getPacket(0.096)).data, packets[4].data);
      assert.deepEqual((await sink.getPacket(Infinity)).data, packets[4].data);
      assert.deepEqual((await sink.getKeyPacket(1)).data, packets[4].data);
      assert.deepEqual((await sink.getPacket(0)).data, packets[0].data);
      assert.equal((await sink.getPacket(0.035, {metadataOnly: true})).isMetadataOnly, true);
      assert.equal(await sink.getNextPacket(packets[4]), null);
    } finally { input.dispose(); }
    await assert.rejects(sink.getPacket(0), /disposed/i);
  }
});

test('AV1 rejects overflow, alias, truncation and payload overrun in both inspection callers', async () => {
  const fixture = await av1Fixture();
  const cases = [
    [0x02, 0xfa, 0xff, 0xff, 0xff, 0x0f], // signed rewind
    [0x06, 0, 0xf9, 0xff, 0xff, 0xff, 0x0f], // extended-header rewind
    [0x02, 0x80, 0x80, 0x80, 0x80, 0x80, 1], // sixth-byte alias
    [0x02, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 1],
    [0x02, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 1],
    [0x02, 0xff, 0xff, 0xff, 0xff, 0x0f], // numeric limit
    [0x02, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80],
    [0x04], [0x06, 0], [0x02], [0x02, 0x80], [0x02, 1],
  ];
  for (const packet of cases) {
    const result = child(`
      for (const mode of ['codec', 'key', 'direct']) {
        const data = Buffer.from(bytes);
        if (mode === 'codec') data.write('free', data.indexOf(Buffer.from('av1C')), 'ascii');
        const input = new lib.Input({ formats: [lib.MP4], source: new lib.BufferSource(data) });
        try {
          const track = await input.getPrimaryVideoTrack(), sink = new lib.EncodedPacketSink(track);
          if (mode === 'codec') await assert.rejects(track.getDecoderConfig(), /Invalid AV1 OBU size/);
          if (mode === 'key') await assert.rejects(sink.getFirstPacket({verifyKeyPackets: true}), /Invalid AV1 OBU size/);
          if (mode === 'direct') await assert.rejects(track.determinePacketType(await sink.getFirstPacket()), /Invalid AV1 OBU size/);
        } finally { input.dispose(); }
      }
    `, av1Packet(fixture, packet));
    assert.equal(result.error, undefined, `OBU ${Buffer.from(packet).toString('hex')} must settle`);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('AV1 valid padded lengths, extensions, unknown/empty OBUs and size-less final payload remain supported', async () => {
  const lib = await library, fixture = await av1Fixture();
  const original = fixture.bytes.subarray(fixture.extent.offset, fixture.extent.offset + fixture.extent.byteLength);
  const sequence = original.subarray(2, 12), frame = original.subarray(12);
  const cases = [original,
    Buffer.concat([Buffer.from([0x02, 0]), original]),
    Buffer.concat([Buffer.from([0x06, 0, 0, 0x02, 1, 0]), original]),
    Buffer.concat([Buffer.from([0x0e, 0, 10]), sequence, frame]),
    Buffer.concat([Buffer.from([0x0a, 0x8a, ...Array(6).fill(0x80), 0]), sequence, frame]),
    Buffer.concat([original.subarray(0, 12), Buffer.from([0x30]), original.subarray(14)]),
  ];
  for (const packet of cases) for (const removeConfig of [false, true]) {
    const input = new lib.Input({ formats: [lib.MP4], source: new lib.BufferSource(av1Packet(fixture, packet, removeConfig)) });
    try {
      const track = await input.getPrimaryVideoTrack(), sink = new lib.EncodedPacketSink(track);
      assert.equal((await track.getDecoderConfig()).codec, 'av01.0.00M.08');
      const key = await sink.getFirstPacket({verifyKeyPackets: true});
      assert.equal(key.type, 'key');
      assert.equal(await track.determinePacketType(key), 'key');
      const delta = await sink.getNextPacket(key, {verifyKeyPackets: true});
      assert.equal(delta.type, 'delta');
      assert.equal(await track.determinePacketType(delta), 'delta');
      assert.equal(await sink.getNextPacket(delta), null);
      assert.equal(await input.computeDuration(), 0.4);
    } finally { input.dispose(); }
  }
});

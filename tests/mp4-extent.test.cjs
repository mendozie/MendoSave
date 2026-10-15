const assert = require('node:assert/strict');
const { test } = require('node:test');
const mediabunny = import('../extension/vendor/mediabunny/mediabunny.min.mjs');

async function fixture(lib, fragmented) {
  const target = new lib.BufferTarget();
  const output = new lib.Output({ target,
    format: new lib.Mp4OutputFormat({ fastStart: fragmented ? 'fragmented' : 'in-memory' }) });
  const source = new lib.EncodedAudioPacketSource('aac'); output.addAudioTrack(source);
  await output.start();
  for (const [index, data] of [Uint8Array.of(17, 34, 51), Uint8Array.of(68, 85)].entries()) {
    await source.add(new lib.EncodedPacket(data, 'key', index * 0.02, 0.02), {
      decoderConfig: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1, description: Uint8Array.of(17, 136) },
    });
  }
  await output.finalize();
  const bytes = Buffer.from(target.buffer);
  const payloadOffset = bytes.indexOf(Buffer.from('mdat')) + 4;
  assert.ok(payloadOffset > 4);
  assert.deepEqual([...bytes.subarray(payloadOffset, payloadOffset + 5)], [17, 34, 51, 68, 85]);
  return { bytes, expected: [{ offset: payloadOffset, byteLength: 3 }, { offset: payloadOffset + 3, byteLength: 2 }] };
}

async function packets(lib, bytes, metadataOnly) {
  const input = new lib.Input({ formats: lib.ALL_FORMATS, source: new lib.BufferSource(bytes) });
  try {
    const sink = new lib.EncodedPacketSink(await input.getPrimaryAudioTrack()), result = [];
    let packet = await sink.getFirstPacket({ metadataOnly });
    while (packet) { result.push(packet); packet = await sink.getNextPacket(packet, { metadataOnly }); }
    return result;
  } finally { input.dispose(); }
}

test('regular MP4 parser projects the physical extent identically for metadata and actual packets', async () => {
  const lib = await mediabunny, { bytes, expected } = await fixture(lib, false);
  for (const metadataOnly of [true, false]) {
    const result = await packets(lib, bytes, metadataOnly);
    assert.deepEqual(result.map(packet => packet.mendoMp4Extent), expected);
    if (!metadataOnly) assert.deepEqual(result.map(packet => [...packet.data]), [[17, 34, 51], [68, 85]]);
  }
});

test('fragmented MP4 parser projects the physical extent identically for metadata and actual packets', async () => {
  const lib = await mediabunny, { bytes, expected } = await fixture(lib, true);
  for (const metadataOnly of [true, false]) {
    const result = await packets(lib, bytes, metadataOnly);
    assert.deepEqual(result.map(packet => packet.mendoMp4Extent), expected);
    if (!metadataOnly) assert.deepEqual(result.map(packet => [...packet.data]), [[17, 34, 51], [68, 85]]);
  }
});

test('MP4 extent projections are frozen, readonly, nonconfigurable and absent from enumerable packet data', async () => {
  const lib = await mediabunny;
  for (const fragmented of [false, true]) {
    const { bytes, expected } = await fixture(lib, fragmented);
    for (const metadataOnly of [true, false]) {
      const result = await packets(lib, bytes, metadataOnly);
      for (const [index, packet] of result.entries()) {
        const property = Object.getOwnPropertyDescriptor(packet, 'mendoMp4Extent');
        assert.equal(property.enumerable, false); assert.equal(property.writable, false); assert.equal(property.configurable, false);
        assert.equal(Object.keys(packet).includes('mendoMp4Extent'), false);
        assert.equal(Object.isFrozen(packet.mendoMp4Extent), true);
        assert.equal(Reflect.set(packet, 'mendoMp4Extent', {}), false);
        assert.equal(Reflect.deleteProperty(packet, 'mendoMp4Extent'), false);
        assert.equal(Reflect.set(packet.mendoMp4Extent, 'offset', 12345), false);
        assert.equal(Reflect.deleteProperty(packet.mendoMp4Extent, 'byteLength'), false);
        assert.deepEqual(packet.mendoMp4Extent, expected[index]);
      }
    }
  }
});

test('corrupt regular and fragmented sample offsets are projected without claiming mdat ownership', async () => {
  const lib = await mediabunny;
  for (const fragmented of [false, true]) {
    const { bytes } = await fixture(lib, fragmented);
    const corrupted = Buffer.from(bytes);
    if (fragmented) {
      const trun = corrupted.indexOf(Buffer.from('trun')), moof = corrupted.indexOf(Buffer.from('moof')) - 4;
      assert.ok(trun > 0 && moof > 0); assert.equal(corrupted.readUInt32BE(trun + 4) & 1, 1);
      corrupted.writeInt32BE(-moof, trun + 12);
    } else {
      const stco = corrupted.indexOf(Buffer.from('stco')); assert.ok(stco > 0);
      corrupted.writeUInt32BE(0, stco + 12);
    }
    for (const metadataOnly of [true, false]) {
      const result = await packets(lib, corrupted, metadataOnly);
      assert.deepEqual(result.map(packet => packet.mendoMp4Extent),
        [{ offset: 0, byteLength: 3 }, { offset: 3, byteLength: 2 }]);
      if (!metadataOnly) assert.deepEqual([...result[0].data], [0, 0, 0]);
    }
  }
});

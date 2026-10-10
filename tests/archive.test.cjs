const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { safeName, uniqueNames, write } = require('../extension/archive.js');

function memoryOutput(sink = {}) {
  const chunks = [];
  let closed = false;
  let aborted = false;
  return {
    stream: new WritableStream({
      async write(chunk) { await sink.write?.(chunk); chunks.push(Buffer.from(chunk)); },
      async close() { await sink.close?.(); closed = true; },
      async abort(error) { aborted = true; await sink.abort?.(error); },
    }),
    get bytes() { return Buffer.concat(chunks); },
    get closed() { return closed; },
    get aborted() { return aborted; },
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Independent PKZIP STORE reader: central directory -> local header -> raw bytes.
// It neither imports zip.js nor uses MendoArchive to obtain expected data.
function extractStore(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 20), 0);
  let count = bytes.readUInt16LE(end + 10);
  const entries = [];
  let cursor = bytes.readUInt32LE(end + 16);
  let directoryEnd = end;
  if (count === 0xffff || cursor === 0xffffffff) {
    assert.equal(bytes.readUInt32LE(end - 20), 0x07064b50);
    const zip64End = Number(bytes.readBigUInt64LE(end - 12));
    assert.equal(bytes.readUInt32LE(zip64End), 0x06064b50);
    count = Number(bytes.readBigUInt64LE(zip64End + 32));
    cursor = Number(bytes.readBigUInt64LE(zip64End + 48));
    directoryEnd = zip64End;
  }
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    assert.equal(bytes.readUInt16LE(cursor + 10), 0, 'ZIP compression method must be STORE');
    let size = bytes.readUInt32LE(cursor + 24);
    let compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    let offset = bytes.readUInt32LE(cursor + 42);
    if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) {
      let extraCursor = cursor + 46 + nameLength;
      const extraEnd = extraCursor + extraLength;
      let found = false;
      while (extraCursor < extraEnd) {
        const id = bytes.readUInt16LE(extraCursor);
        const length = bytes.readUInt16LE(extraCursor + 2);
        if (id === 1) {
          let field = extraCursor + 4;
          if (size === 0xffffffff) { size = Number(bytes.readBigUInt64LE(field)); field += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(bytes.readBigUInt64LE(field)); field += 8; }
          if (offset === 0xffffffff) offset = Number(bytes.readBigUInt64LE(field));
          found = true;
          break;
        }
        extraCursor += length + 4;
      }
      assert.equal(found, true, 'ZIP64 fields must have a size/offset record');
    }
    assert.equal(compressedSize, size, 'STORE must retain data size');
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const dataOffset = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const data = bytes.subarray(dataOffset, dataOffset + size);
    assert.equal(crc32(data), bytes.readUInt32LE(cursor + 16), 'independent CRC-32');
    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, directoryEnd);
  return entries;
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('archive names preserve Unicode while removing traversal and Windows special names', () => {
  assert.equal(safeName('Видео 🎬.mp4'), 'Видео 🎬.mp4');
  assert.equal(safeName('../../C:\\temp\\movie:1?.mp4 '), '_.._C__temp_movie_1_.mp4');
  assert.equal(safeName('CON.txt'), '_CON.txt');
  assert.equal(safeName('lpt¹.mp3'), '_lpt¹.mp3');
  assert.equal(safeName('. ..'), 'file');
  assert.equal(safeName('Cafe\u0301.mp4'), 'Café.mp4');
  assert.equal(safeName('\u0000a\u202Eb.mp4'), '_a_b.mp4');
  assert.throws(() => safeName(null), TypeError);
  assert.throws(() => safeName({ toString() { return 'trusted.mp4'; } }), TypeError);
});

test('archive collisions are deterministic after NFC, Windows sanitization and case folding', () => {
  assert.deepEqual(uniqueNames(['A.mp4', 'a.mp4', 'A (2).mp4', 'a.mp4', 'Cafe\u0301.srt', 'CAFÉ.srt', '../a.mp4', '..\\a.mp4']),
    ['A.mp4', 'a (2).mp4', 'A (2) (2).mp4', 'a (3).mp4', 'Café.srt', 'CAFÉ (2).srt', '_a.mp4', '_a (2).mp4']);
  assert.deepEqual(uniqueNames(['file', 'FILE']), ['file', 'FILE (2)']);
  assert.throws(() => uniqueNames('file'), TypeError);
});

test('long Unicode archive names and collision suffixes stay inside a bounded Windows filename', () => {
  const name = `${'🎬'.repeat(150)}.mp4`;
  const names = uniqueNames([name, name, name]);
  assert.equal(new Set(names).size, 3);
  for (const value of names) {
    assert.ok(Buffer.byteLength(value, 'utf8') <= 180);
    assert.ok(value.endsWith('.mp4'));
    assert.ok(!value.includes('\ufffd'));
    assert.equal(safeName(value), value);
  }
});

test('STORE archive extraction matches original media bytes and deterministic safe names', async () => {
  const inputs = [
    { name: 'Видео 🎬.mp4', bytes: Buffer.from([0, 1, 2, 0xff, 0, 0x7f]) },
    { name: 'видео 🎬.mp4', bytes: Buffer.from('second unchanged compressed media payload') },
    { name: '../Субтитры.srt', bytes: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nПривет\n', 'utf8') },
  ];
  const output = memoryOutput();
  const progress = [];
  const result = await write(inputs.map(({ name, bytes }) => ({ name, blob: new Blob([bytes]) })), output.stream,
    { onProgress: (event) => progress.push(event) });
  assert.equal(output.closed, true);
  assert.equal(output.aborted, false);
  assert.equal(output.stream.locked, false);
  assert.equal(result.bytes, output.bytes.length);
  assert.deepEqual(result.entries, [
    { name: 'Видео 🎬.mp4', size: 6 },
    { name: 'видео 🎬 (2).mp4', size: inputs[1].bytes.length },
    { name: '_Субтитры.srt', size: inputs[2].bytes.length },
  ]);
  const extracted = extractStore(output.bytes);
  assert.deepEqual(extracted.map(({ name }) => name), result.entries.map(({ name }) => name));
  extracted.forEach(({ data }, index) => {
    assert.deepEqual(data, inputs[index].bytes);
    assert.equal(hash(data), hash(inputs[index].bytes));
  });
  assert.ok(progress.length > 0);
});

test('invalid or unbounded archive requests are rejected before taking ownership of output', async () => {
  const valid = [{ name: 'video.mp4', blob: new Blob(['video']) }];
  const invalidEntries = [[], null, 'file', [null], [{ name: 'empty.mp4', blob: new Blob() }],
    [{ name: 'video.mp4', blob: 'not a Blob' }], [{ name: '', blob: new Blob(['data']) }],
    [{ name: {}, blob: new Blob(['data']) }], new Array(1001).fill(valid[0])];
  for (const entries of invalidEntries) {
    const output = memoryOutput();
    await assert.rejects(write(entries, output.stream));
    assert.equal(output.bytes.length, 0);
    assert.equal(output.closed, false);
    assert.equal(output.aborted, false);
    assert.equal(output.stream.locked, false);
  }
  for (const maxBytes of [0, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, '100']) {
    const output = memoryOutput();
    await assert.rejects(write(valid, output.stream, { maxBytes }));
    assert.equal(output.bytes.length, 0);
    assert.equal(output.stream.locked, false);
  }
  await assert.rejects(write(valid, {}), TypeError);
  await assert.rejects(write(valid, memoryOutput().stream, { onProgress: 'progress' }), TypeError);
  await assert.rejects(write(valid, memoryOutput().stream, { signal: { aborted: false } }), TypeError);
});

test('archive quota bounds final output including ZIP overhead and aborts an incomplete stream', async () => {
  const entries = [{ name: 'video.mp4', blob: new Blob([new Uint8Array(1000)]) }];
  const tooSmall = memoryOutput();
  await assert.rejects(write(entries, tooSmall.stream, { maxBytes: 999 }), { name: 'QuotaExceededError' });
  assert.equal(tooSmall.bytes.length, 0);
  assert.equal(tooSmall.aborted, false, 'preflight failure leaves stream ownership with caller');
  const overhead = memoryOutput();
  await assert.rejects(write(entries, overhead.stream, { maxBytes: 1100 }), { name: 'QuotaExceededError' });
  assert.ok(overhead.bytes.length <= 1100);
  assert.equal(overhead.closed, false);
  assert.equal(overhead.aborted, true);
  assert.equal(overhead.stream.locked, false);
  const fitting = memoryOutput();
  const complete = await write(entries, fitting.stream, { maxBytes: 2000 });
  const exact = memoryOutput();
  await write(entries, exact.stream, { maxBytes: complete.bytes });
  assert.equal(exact.closed, true);
  assert.equal(exact.bytes.length, complete.bytes);
  assert.deepEqual(extractStore(exact.bytes)[0].data, Buffer.alloc(1000));
});

test('abort before and during packing never closes or returns a partial archive as success', async () => {
  const before = new AbortController();
  before.abort();
  const untouched = memoryOutput();
  const entries = [{ name: 'first.mp4', blob: new Blob([new Uint8Array(1024 * 1024)]) },
    { name: 'second.mp4', blob: new Blob(['second']) }];
  await assert.rejects(write(entries, untouched.stream, { signal: before.signal }), { name: 'AbortError' });
  assert.equal(untouched.bytes.length, 0);
  assert.equal(untouched.aborted, false);
  assert.equal(untouched.stream.locked, false);
  const during = new AbortController();
  let writes = 0;
  const interrupted = memoryOutput({ write() { if (++writes === 2) during.abort(); } });
  await assert.rejects(write(entries, interrupted.stream, { signal: during.signal }), { name: 'AbortError' });
  assert.equal(interrupted.closed, false);
  assert.equal(interrupted.aborted, true);
  assert.equal(interrupted.stream.locked, false);
  assert.ok(interrupted.bytes.length < entries[0].blob.size, 'cancellation stops during the first large file');
});

test('progress advances inside a large file while preserving sequential entry order', async () => {
  const events = [];
  const output = memoryOutput();
  await write([{ name: 'first.mp4', blob: new Blob([new Uint8Array(2 * 1024 * 1024)]) },
    { name: 'second.mp4', blob: new Blob(['done']) }], output.stream,
  { onProgress: (event) => events.push(event) });
  assert.ok(events.some((event) => event.completedBytes > 0 && event.completedBytes < 2 * 1024 * 1024
    && event.entriesCompleted === 0));
  for (let index = 0; index < events.length; index++) {
    assert.equal(events[index].totalBytes, 2 * 1024 * 1024 + 4);
    assert.equal(events[index].totalEntries, 2);
    if (index) {
      assert.ok(events[index].completedBytes >= events[index - 1].completedBytes);
      assert.ok(events[index].bytesWritten >= events[index - 1].bytesWritten);
      assert.ok(events[index].entriesCompleted >= events[index - 1].entriesCompleted);
    }
  }
  assert.equal(events.at(-1).completedBytes, 2 * 1024 * 1024 + 4);
  assert.equal(events.at(-1).entriesCompleted, 2);
  assert.equal(events.at(-1).bytesWritten, output.bytes.length);
  assert.deepEqual(extractStore(output.bytes).map(({ name }) => name), ['first.mp4', 'second.mp4']);
});

test('a failing byte progress callback rejects instead of being swallowed by the ZIP library', async () => {
  const progressError = new Error('Progress callback failed');
  let reported = false;
  const output = memoryOutput();
  await assert.rejects(write([{ name: 'file.mp4', blob: new Blob([new Uint8Array(2 * 1024 * 1024)]) }], output.stream,
    { async onProgress(event) {
      if (!reported && event.completedBytes > 0 && event.completedBytes < event.totalBytes) {
        reported = true;
        throw progressError;
      }
    } }), (error) => error === progressError);
  assert.equal(output.closed, false);
  assert.equal(output.aborted, true);
  assert.equal(output.stream.locked, false);
});

test('non-Error progress rejections also stop packaging', async () => {
  const output = memoryOutput();
  let firstProgress = true;
  await assert.rejects(write([{ name: 'file.mp4', blob: new Blob([new Uint8Array(1024 * 1024)]) }], output.stream,
    { onProgress() { if (firstProgress) { firstProgress = false; return Promise.reject(false); } } }),
  (error) => error === false);
  assert.equal(output.closed, false);
  assert.equal(output.aborted, true);
});

test('a truncated Blob source cannot become a successful partial archive', async () => {
  class TruncatedBlob extends Blob {
    stream() { return new Blob(['short']).stream(); }
  }
  const output = memoryOutput();
  await assert.rejects(write([{ name: 'whole.mp4', blob: new TruncatedBlob(['full source content']) }], output.stream),
    /source size/i);
  assert.equal(output.closed, false);
  assert.equal(output.aborted, true);
  assert.equal(output.stream.locked, false);
});

test('read errors, sink quota and close errors reject without finalizing a partial package', async () => {
  const sourceError = new DOMException('Source file cannot be read', 'NotReadableError');
  class BrokenBlob extends Blob {
    stream() {
      return new ReadableStream({ start(controller) { controller.error(sourceError); } });
    }
  }
  const source = memoryOutput();
  await assert.rejects(write([{ name: 'first.mp4', blob: new Blob(['first']) },
    { name: 'broken.mp4', blob: new BrokenBlob(['broken']) }], source.stream), (error) => error === sourceError);
  assert.ok(source.bytes.length > 0, 'first file was already written');
  assert.equal(source.closed, false);
  assert.equal(source.aborted, true);
  assert.equal(source.stream.locked, false);
  const quotaError = new DOMException('Disk quota', 'QuotaExceededError');
  const disk = memoryOutput({ write() { throw quotaError; } });
  await assert.rejects(write([{ name: 'file.mp4', blob: new Blob(['file']) }], disk.stream),
    (error) => error === quotaError);
  assert.equal(disk.closed, false);
  assert.equal(disk.stream.locked, false);
  const closeError = new Error('Cannot commit output file');
  const closing = memoryOutput({ close() { throw closeError; } });
  await assert.rejects(write([{ name: 'file.mp4', blob: new Blob(['file']) }], closing.stream),
    (error) => error === closeError);
  assert.equal(closing.closed, false);
  assert.equal(closing.stream.locked, false);
});

test('case folding and malformed Unicode cannot create duplicate archive extraction names', () => {
  assert.deepEqual(uniqueNames(['σ.srt', 'ς.srt', '\ud800.mp4', '\ud801.mp4']),
    ['σ.srt', 'ς (2).srt', '\ufffd.mp4', '\ufffd (2).mp4']);
});

test('safe archive names do not expose Windows console devices or regain leading dots on reuse', () => {
  assert.equal(safeName('CONIN$'), '_CONIN$');
  assert.equal(safeName('CONOUT$.mp4'), '_CONOUT$.mp4');
  assert.equal(safeName('.. .. title.mp4'), 'title.mp4');
  assert.equal(safeName(safeName('.. .. title.mp4')), 'title.mp4');
});

test('browser scripts write STORE without workers, network or dynamic code execution', async () => {
  let workers = 0;
  let requests = 0;
  const context = vm.createContext({
    Blob, ReadableStream, WritableStream, TransformStream, TextEncoder, TextDecoder,
    AbortSignal, DOMException, URL, setTimeout, clearTimeout,
    Worker: class { constructor() { workers++; throw new Error('Workers forbidden'); } },
    fetch() { requests++; throw new Error('Network forbidden'); },
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(readFileSync(require.resolve('../extension/vendor/zipjs/zip-native.min.js'), 'utf8'), context);
  vm.runInContext(readFileSync(require.resolve('../extension/archive.js'), 'utf8'), context);
  const output = memoryOutput();
  await context.MendoArchive.write([{ name: 'offline.mp4', blob: new Blob(['offline bytes']) }], output.stream);
  assert.deepEqual(extractStore(output.bytes)[0].data, Buffer.from('offline bytes'));
  assert.equal(workers, 0);
  assert.equal(requests, 0);
});

test('pinned native library emits independently readable ZIP64 using a small forced fixture', async () => {
  const zip = require('../extension/vendor/zipjs/zip-native.min.js');
  const output = memoryOutput();
  const archive = new zip.ZipWriter(output.stream, { level: 0, useWebWorkers: false, zip64: true });
  await archive.add('zip64.mp4', new zip.BlobReader(new Blob(['exact ZIP64 payload'])));
  await archive.close();
  const bytes = output.bytes;
  assert.equal(bytes.readUInt32LE(bytes.length - 42), 0x07064b50);
  assert.deepEqual(extractStore(bytes), [{ name: 'zip64.mp4', data: Buffer.from('exact ZIP64 payload') }]);
});

test('bundled library and license retain the pinned source hashes', () => {
  const provenance = require('../extension/vendor/zipjs/PROVENANCE.json');
  assert.equal(provenance.version, '2.20.0');
  assert.equal(provenance.commit, '38508528fe00b094447d9122b7725ab412149e2d');
  for (const entry of provenance.files) {
    const bytes = readFileSync(require.resolve(`../extension/vendor/zipjs/${entry.path}`));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(hash(bytes), entry.sha256);
  }
});

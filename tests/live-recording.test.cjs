const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

const mediabunny = import('../extension/vendor/mediabunny/mediabunny.min.mjs');
// Own 3180-byte synthetic VP8/Opus fixture: FFmpeg 9.0.2 testsrc2 32x32/5fps
// + 440Hz sine, 0.6s; vendor packet-copy sets video timestamps to 0,200,200ms.
// It contains no captured site media or private metadata.
const recordingFixture = fs.readFileSync('tests/fixtures/raw-recording.webm');

async function packets(blob) {
  const lib = await mediabunny;
  const input = new lib.Input({ formats: lib.ALL_FORMATS, source: new lib.BlobSource(blob) });
  try {
    return await Promise.all((await input.getTracks()).map(async (track) => {
      const result = [];
      for await (const packet of new lib.EncodedPacketSink(track).packets()) {
        result.push({ timestamp: packet.timestamp, bytes: Buffer.from(packet.data) });
      }
      return { type: track.type, codec: track.codec, packets: result };
    }));
  } finally { input.dispose(); }
}

async function assertFinalized(blob, original = new Blob([recordingFixture])) {
  const before = await packets(original);
  const after = await packets(blob);
  for (const track of before) {
    const actual = after.find((entry) => entry.type === track.type);
    assert.equal(actual.codec, track.codec);
    assert.deepEqual(actual.packets.map((packet) => packet.bytes), track.packets.map((packet) => packet.bytes));
    if (track.type === 'audio') assert.deepEqual(actual.packets, track.packets);
    else assert.deepEqual(actual.packets.map((packet) => Math.round(packet.timestamp * 1000)), [0, 200, 201]);
  }
}

function host({ writeBarrier, outputBarrier, outputSinkBarriers, downloadState, saveError, dependency = mediabunny, outputFault, Clock = Date, fastStall, fastRetries } = {}) {
  let messageListener, connectListener;
  const timers = new Set();
  const dirs = new Map();
  const urls = new Map();
  const saves = [];
  const commits = [];
  const recoveryEntries = [];
  let urlId = 0;
  const storage = { async getDirectory() { return { async getDirectoryHandle(name) {
    if (!dirs.has(name)) {
      const files = new Map();
      dirs.set(name, {
        async *keys() { yield* files.keys(); },
        async removeEntry(key) {
          if (files.get(key)?.isLocked()) throw new Error('output is still locked');
          files.delete(key);
        },
        async getFileHandle(key, options = {}) {
          if (key.endsWith('-out.webm')) await outputBarrier;
          if (!files.has(key)) {
            if (!options.create) throw new Error('missing file');
            let committed = new Blob([]), locked = false;
            const barriers = key.endsWith('-out.webm') ? outputSinkBarriers : undefined;
            files.set(key, {
              isLocked: () => locked,
              async createWritable() {
                locked = Boolean(barriers);
                let bytes = new Uint8Array();
                return {
                  async write(chunk) {
                    await writeBarrier;
                    await barriers?.write;
                    const position = chunk.type === 'write' ? chunk.position : bytes.length;
                    const data = chunk.type === 'write' ? chunk.data : chunk;
                    const part = data instanceof Blob ? new Uint8Array(await data.slice().arrayBuffer()) : new Uint8Array(data);
                    const next = new Uint8Array(Math.max(bytes.length, position + part.length));
                    next.set(bytes); next.set(part, position); bytes = next;
                  },
                  async close() {
                    await barriers?.close;
                    const data = key.endsWith('-out.webm') && outputFault ? outputFault(bytes) : bytes;
                    committed = new Blob([data]); commits.push({ name: key, blob: committed });
                    locked = false;
                  },
                  async abort() { await barriers?.abort; locked = false; },
                };
              },
              async getFile() {
                const file = new Blob([committed]);
                // BlobSource must read slices, not materialize the entire OPFS file.
                file.arrayBuffer = () => { throw new Error('whole OPFS file read forbidden'); };
                return file;
              },
            });
          }
          return files.get(key);
        },
      });
    }
    return dirs.get(name);
  } }; } };
  const runtime = {
    id: 'mendosave@test', getURL: (name) => `moz-extension://test/${name}`,
    onMessage: { addListener(fn) { messageListener = fn; } },
    onConnect: { addListener(fn) { connectListener = fn; } },
    async sendMessage(message) {
      if (message.t === 'mendosave-recovery-read') return { ok: true, entries: recoveryEntries, maxEntries: 320 };
      if (message.t === 'mendosave-recovery-write') { recoveryEntries.splice(0, recoveryEntries.length, ...message.entries); return { ok: true }; }
      if (message.t === 'mendosave-save') {
        if (saveError) throw saveError;
        saves.push({ filename: message.filename, blob: urls.get(message.url) });
        return { ok: true, id: saves.length };
      }
      if (message.t === 'mendosave-download-state') return downloadState ? downloadState() : { ok: true, state: 'complete' };
      return { ok: true };
    },
  };
  const context = vm.createContext({
    location: new URL('moz-extension://test/offscreen.html#mendosave-host=fixture'),
    chrome: { runtime }, navigator: { storage }, Blob, Uint8Array, ArrayBuffer, atob,
    Date: Clock, console, TextDecoder, WritableStream, mediabunnyDependency: dependency,
    URL: class extends URL {
      static createObjectURL(blob) { const url = `blob:test/${++urlId}`; urls.set(url, blob); return url; }
      static revokeObjectURL(url) { urls.delete(url); }
    },
    FFmpegWASM: { FFmpeg: class { on() {} async load() {} } },
    setTimeout(fn, ms) {
      const timer = setTimeout(() => {
        if (fastStall && ms === 5_000) Clock.advance(181_000);
        fn();
      }, (fastStall && ms === 5_000) || fastRetries ? 2 : ms);
      // Awaited download/retry/stall work needs a live event loop, just as it
      // has in the browser. host.close() clears task timers after each test.
      timers.add(timer); return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    setInterval(fn, ms) { const timer = setInterval(fn, ms); timer.unref(); timers.add(timer); return timer; },
    clearInterval(timer) { clearInterval(timer); timers.delete(timer); },
  });
  Object.assign(context, { File, AbortController, AbortSignal, DOMException, WritableStream, ReadableStream, crypto, MendoArchive: require('../extension/archive.js') });
  vm.runInContext(fs.readFileSync('extension/package_host.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('extension/package_io.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('extension/offscreen.js', 'utf8'), context);
  // Replace only extension module loading; parsing and packet copy use the pinned vendor.
  vm.runInContext('mediabunnyLoad = mediabunnyDependency;', context);
  const sender = { id: runtime.id, tab: { id: 7, url: 'https://www.twitch.tv/channel' },
    url: 'https://www.twitch.tv/channel', frameId: 0, documentId: 'document7' };
  const message = (payload, owner = sender) => new Promise((resolve) => {
    if (!messageListener({ instanceId: 'fixture', ...payload }, owner, resolve)) resolve(undefined);
  });
  function connect(owner = sender, jobId = 'record7') {
    let disconnected;
    const replies = [];
    const port = { name: `mendosave-twitch-recording:${jobId}`, sender: owner, replies,
      onDisconnect: { addListener(fn) { disconnected = fn; } },
      postMessage(value) { replies.push(value); },
      disconnect() { disconnected?.(); },
    };
    connectListener?.(port);
    return port;
  }
  return { message, connect, sender, saves, commits, dirs, urls, recoveryEntries,
    async settle() { await new Promise((resolve) => setTimeout(resolve, 20)); },
    close() { for (const timer of timers) { clearTimeout(timer); clearInterval(timer); } },
  };
}
const begin = { t: 'mendosave-live-begin', jobId: 'record7', rawRecording: true,
  filename: 'Twitch - channel - recording.webm', mime: 'video/webm;codecs=vp8,opus' };
const chunk = { t: 'mendosave-live-chunk', jobId: 'record7', track: 'video',
  mime: begin.mime, b64: recordingFixture.toString('base64') };

test('raw live begin rejects unsupported envelopes and untrusted recording owners', async () => {
  for (const [change, owner] of [
    [{ mime: 'audio/mpeg' }], [{ filename: '../record.webm' }],
    [{ filename: 'a'.repeat(251) + '.webm' }], [{ rawRecording: 'true' }],
    [{}, { url: 'https://www.youtube.com/watch?v=fixture' }], [{}, { frameId: 1 }],
  ]) {
    const app = host();
    try {
      const result = await app.message({ ...begin, ...change }, { ...app.sender, ...owner });
      assert.equal(result.ok, false, JSON.stringify([change, owner]));
    } finally { app.close(); }
  }
});

test('normal raw live finish finalizes WebM, preserves packets and corrects video timestamps only', async () => {
  const app = host();
  try {
    assert.equal((await app.message({ ...begin })).ok, true);
    const port = app.connect();
    assert.equal(port.replies[0]?.ok, true);
    assert.equal((await app.message({ ...chunk, b64: recordingFixture.toString('base64') })).ok, true);
    assert.equal((await app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId, filename: 'changed.mp3' })).ok, true);
    port.disconnect();
    await app.settle();
    assert.equal(app.saves.length, 1);
    assert.equal(app.saves[0].filename, begin.filename);
    await assertFinalized(app.saves[0].blob);
    assert.deepEqual(Buffer.from(await app.commits.find((entry) => entry.name === 'record7-video.bin').blob.arrayBuffer()), recordingFixture);
  } finally { app.close(); }
});

test('port teardown finalizes a truncated EBML tail once with an explicit partial name', async () => {
  const app = host();
  try {
    await app.message({ ...begin });
    const port = app.connect();
    assert.equal(port.replies[0]?.ok, true);
    // Like the native teardown fixture, all complete packets plus a partial header.
    await app.message({ ...chunk, b64: Buffer.concat([recordingFixture, Buffer.from([0xa3])]).toString('base64') });
    port.disconnect();
    port.disconnect();
    await app.settle();
    assert.equal(app.saves.length, 1);
    assert.match(app.saves[0].filename, /\[частичная запись\]\.webm$/);
    await assertFinalized(app.saves[0].blob);
  } finally { app.close(); }
});

test('an incomplete final block preserves every complete packet in known and unknown-sized clusters', async (t) => {
  // Independently counted by FFprobe 9.0.2: this accepted prefix contains
  // 3 complete VP8 and 30 complete Opus packets, followed by an incomplete block.
  const expected = await packets(new Blob([recordingFixture]));
  for (const unknownSize of [false, true]) {
    await t.test(unknownSize ? 'unknown size' : 'known size', async () => {
      const bytes = Buffer.from(recordingFixture.subarray(0, -100));
      // Fixture Cluster ID is at 310, with its five-byte size at 314.
      if (unknownSize) bytes.set([0x0f, 0xff, 0xff, 0xff, 0xff], 314);
      const app = host();
      try {
        await app.message({ ...begin }); const port = app.connect();
        assert.equal((await app.message({ ...chunk, b64: bytes.toString('base64') })).ok, true);
        const result = await app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId, interrupted: false });
        assert.equal(result.ok, true, result.error);
        assert.equal(result.partial, true);
        port.disconnect(); port.disconnect();
        assert.equal(app.saves.length, 1);
        assert.match(app.saves[0].filename, /\[частичная запись\]\.webm$/);
        const actual = await packets(app.saves[0].blob);
        for (const track of expected) {
          const saved = actual.find((entry) => entry.type === track.type);
          const count = track.type === 'video' ? 3 : 30;
          assert.equal(saved.packets.length, count);
          assert.deepEqual(saved.packets.map((packet) => packet.bytes), track.packets.slice(0, count).map((packet) => packet.bytes));
          if (track.type === 'audio') assert.deepEqual(saved.packets, track.packets.slice(0, count));
          else assert.deepEqual(saved.packets.map((packet) => Math.round(packet.timestamp * 1000)), [0, 200, 201]);
        }
      } finally { app.close(); }
    });
  }
});

test('teardown drains a host-owned pending write before closing its writer or saving', async () => {
  let finish;
  const app = host({ writeBarrier: new Promise((resolve) => { finish = resolve; }) });
  try {
    await app.message({ ...begin });
    const port = app.connect();
    const appended = app.message({ ...chunk });
    port.disconnect();
    await app.settle();
    assert.equal(app.saves.length, 0);
    finish();
    assert.equal((await appended).ok, true);
    await app.settle();
    assert.equal(app.saves.length, 1);
    await assertFinalized(app.saves[0].blob);
  } finally { finish(); app.close(); }
});

test('a foreign tab, frame or document cannot bind or finalize a raw recording', async () => {
  const app = host();
  try {
    await app.message({ ...begin });
    const port = app.connect();
    for (const fields of [{ tab: { id: 8 } }, { frameId: 1 }, { documentId: 'document8' }]) {
      const sender = { ...app.sender, ...fields };
      const foreign = app.connect(sender);
      assert.equal(foreign.replies[0]?.ok, false);
      foreign.disconnect();
      assert.equal((await app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId }, sender)).ok, false);
    }
    assert.equal((await app.message({ ...chunk })).ok, true);
    await app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId });
    port.disconnect();
    await app.settle();
    assert.equal(app.saves.length, 1);
  } finally { app.close(); }
});

test('raw recording refuses a separate audio track or changed MIME without losing its accepted video bytes', async () => {
  const app = host();
  try {
    await app.message({ ...begin });
    const port = app.connect();
    await app.message({ ...chunk });
    for (const change of [{ track: 'audio' }, { mime: 'video/mp4' }]) {
      assert.equal((await app.message({ ...chunk, ...change })).ok, false);
    }
    assert.equal((await app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId, interrupted: 'yes' })).ok, false);
    await app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId });
    port.disconnect();
    assert.equal(app.saves.length, 1);
    await assertFinalized(app.saves[0].blob);
  } finally { app.close(); }
});

test('legacy single-track YouTube live keeps its original filename and bytes without a recording Port', async () => {
  const app = host();
  const sender = { ...app.sender, url: 'https://www.youtube.com/watch?v=fixture' };
  try {
    assert.equal((await app.message({ t: begin.t, jobId: begin.jobId }, sender)).ok, true);
    assert.equal((await app.message({ ...chunk }, sender)).ok, true);
    const result = await app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId, filename: 'YouTube live.webm' }, sender);
    assert.equal(result.ok, true);
    assert.equal(app.saves.length, 1);
    assert.equal(app.saves[0].filename, 'YouTube live.video.webm');
    assert.deepEqual(Buffer.from(await app.saves[0].blob.slice().arrayBuffer()), Buffer.from(chunk.b64, 'base64'));
  } finally { app.close(); }
});

test('an empty disconnected recording releases its slot without creating a download', async () => {
  const app = host();
  try {
    await app.message({ ...begin });
    app.connect().disconnect();
    await app.settle();
    assert.equal(app.saves.length, 0);
    assert.equal((await app.message({ ...begin })).ok, true);
    await app.message({ t: 'mendosave-live-abort', jobId: begin.jobId });
  } finally { app.close(); }
});

async function liveFiles(app) {
  const result = [];
  for await (const name of app.dirs.get('mendosave-live').keys()) result.push(name);
  return result.sort();
}

test('raw input and finalized output stay alive until actual download complete, then clean up once', async () => {
  let complete = false;
  const app = host({ downloadState: () => ({ ok: true, state: complete ? 'complete' : 'in_progress' }) });
  try {
    await app.message({ ...begin });
    const port = app.connect();
    await app.message({ ...chunk });
    const finished = app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId });
    await app.settle();
    port.disconnect();
    assert.equal(app.saves.length, 1);
    assert.equal(app.urls.size, 1);
    assert.deepEqual(await liveFiles(app), ['record7-out.webm', 'record7-video.bin']);
    complete = true;
    assert.equal((await finished).ok, true);
    assert.equal(app.saves.length, 1);
    assert.equal(app.urls.size, 0);
    assert.deepEqual(await liveFiles(app), []);
  } finally { complete = true; app.close(); }
});

test('invalid raw input never downloads and retains accepted source bytes', async () => {
  const app = host();
  const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  try {
    await app.message({ ...begin }); app.connect();
    await app.message({ ...chunk, b64: bytes.toString('base64') });
    const result = await app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId });
    assert.equal(result.ok, false);
    assert.equal(app.saves.length, 0);
    assert.deepEqual(await liveFiles(app), ['record7-video.bin']);
    assert.deepEqual(Buffer.from(await app.commits[0].blob.arrayBuffer()), bytes);
  } finally { app.close(); }
});

test('empty or truncated output is refused, failed output removed and raw source retained', async (t) => {
  for (const [name, fault] of [['empty', () => new Uint8Array()], ['truncated', (bytes) => bytes.subarray(0, 100)]]) {
    await t.test(name, async () => {
      const app = host({ outputFault: fault });
      try {
        await app.message({ ...begin }); app.connect(); await app.message({ ...chunk });
        assert.equal((await app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId })).ok, false);
        assert.equal(app.saves.length, 0);
        assert.deepEqual(await liveFiles(app), ['record7-video.bin']);
      } finally { app.close(); }
    });
  }
});

test('delivery error keeps both raw input and ready output without reporting success or retrying download', async () => {
  const app = host({ saveError: new Error('download permission denied') });
  try {
    await app.message({ ...begin }); app.connect(); await app.message({ ...chunk });
    const result = await app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId });
    assert.equal(result.ok, false);
    assert.equal(app.saves.length, 0);
    assert.equal(app.urls.size, 0);
    assert.deepEqual(await liveFiles(app), ['record7-out.webm', 'record7-video.bin']);
    await assertFinalized(app.commits.find((entry) => entry.name === 'record7-out.webm').blob);
  } finally { app.close(); }
});

test('sleeping worker parks the finalized WebM once while preserving raw source and port idempotence', async () => {
  const app = host({ saveError: new Error('Could not establish connection. Receiving end does not exist.'), fastRetries: true });
  try {
    await app.message({ ...begin }); const port = app.connect(); await app.message({ ...chunk });
    const result = await app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId });
    port.disconnect(); port.disconnect(); await app.settle();
    assert.equal(result.ok, false);
    assert.equal(result.recovered, true);
    assert.equal(app.saves.length, 0);
    assert.equal(app.recoveryEntries.length, 1);
    assert.equal(app.recoveryEntries[0].filename, begin.filename);
    assert.deepEqual(await liveFiles(app), ['record7-out.webm', 'record7-video.bin']);
    const parked = app.commits.find((entry) => entry.name === app.recoveryEntries[0].id);
    await assertFinalized(parked.blob);
  } finally { app.close(); }
});

test('stalled packet reads are cancelled without a download and retain the disk prefix', async () => {
  const lib = await mediabunny;
  const never = new Promise(() => {});
  class StalledSink { async *packets() { yield await never; } }
  let now = 0;
  class Clock extends Date { static now() { return now; } static advance(ms) { now += ms; } }
  const app = host({ dependency: Promise.resolve({ ...lib, EncodedPacketSink: StalledSink }), Clock, fastStall: true });
  try {
    await app.message({ ...begin }); app.connect(); await app.message({ ...chunk });
    const result = await Promise.race([
      app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('stall guard failed')), 500)),
    ]);
    assert.equal(result.ok, false);
    assert.match(result.error, /180 секунд/);
    assert.equal(app.saves.length, 0);
    assert.deepEqual(await liveFiles(app), ['record7-video.bin']);
  } finally { app.close(); }
});

test('a stalled OPFS output creation cannot recreate a failed output after the guard returns', async () => {
  let release;
  let now = 0;
  class Clock extends Date { static now() { return now; } static advance(ms) { now += ms; } }
  const app = host({ outputBarrier: new Promise((resolve) => { release = resolve; }), Clock, fastStall: true });
  try {
    await app.message({ ...begin }); app.connect(); await app.message({ ...chunk });
    const result = await app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId });
    assert.equal(result.ok, false);
    assert.match(result.error, /180 секунд/);
    release(); await app.settle();
    assert.equal(app.saves.length, 0);
    assert.deepEqual(await liveFiles(app), ['record7-video.bin']);
  } finally { release(); app.close(); }
});

test('stalled OPFS writes and close return without waiting for cancellation and remove the output after unlock', async (t) => {
  for (const operation of ['write', 'close']) {
    await t.test(operation, async () => {
      let release, deadline;
      const blocked = new Promise((resolve) => { release = resolve; });
      let now = 0;
      class Clock extends Date { static now() { return now; } static advance(ms) { now += ms; } }
      const app = host({ outputSinkBarriers: { [operation]: blocked, abort: blocked }, Clock, fastStall: true, fastRetries: true });
      try {
        await app.message({ ...begin }); app.connect(); await app.message({ ...chunk });
        const result = await Promise.race([
          app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId }),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('cleanup blocked the stall response')), 500); }),
        ]);
        assert.equal(result.ok, false);
        assert.match(result.error, /180 секунд/);
        assert.equal(app.saves.length, 0);
        assert.deepEqual(Buffer.from(await app.commits.find((entry) => entry.name === 'record7-video.bin').blob.arrayBuffer()), recordingFixture);
        release(); await app.settle();
        assert.deepEqual(await liveFiles(app), ['record7-video.bin']);
        assert.equal(app.saves.length, 0);
        await app.message({ ...begin, jobId: 'record8' }); app.connect(app.sender, 'record8');
        await app.message({ ...chunk, jobId: 'record8' });
        assert.equal((await app.message({ t: 'mendosave-live-finalize', jobId: 'record8' })).ok, true);
        await assertFinalized(app.saves[0].blob);
      } finally { clearTimeout(deadline); release(); await app.settle(); app.close(); }
    });
  }
});

test('a video-only capture saves normal and partial files despite a configured audio codec', async (t) => {
  const lib = await mediabunny;
  const input = new lib.Input({ formats: lib.ALL_FORMATS, source: new lib.BlobSource(new Blob([recordingFixture])) });
  let videoOnly;
  try {
    const video = (await input.getTracks()).find((track) => track.type === 'video');
    const target = new lib.BufferTarget();
    const output = new lib.Output({ format: new lib.WebMOutputFormat(), target });
    const source = new lib.EncodedVideoPacketSource(video.codec);
    output.addVideoTrack(source); await output.start();
    let first = true;
    for await (const packet of new lib.EncodedPacketSink(video).packets()) {
      await source.add(packet, first ? { decoderConfig: await video.getDecoderConfig() } : undefined);
      first = false;
    }
    source.close(); await output.finalize();
    videoOnly = new Blob([target.buffer]);
  } finally { input.dispose(); }
  assert.deepEqual((await packets(videoOnly)).map((track) => track.type), ['video']);
  const b64 = Buffer.from(await videoOnly.arrayBuffer()).toString('base64');
  for (const interrupted of [false, true]) {
    await t.test(interrupted ? 'partial' : 'normal', async () => {
      const app = host();
      try {
        await app.message({ ...begin }); app.connect();
        await app.message({ ...chunk, b64 });
        const result = await app.message({ t: 'mendosave-live-finalize', jobId: begin.jobId, interrupted });
        assert.equal(result.ok, true, result.error);
        assert.equal(result.partial, interrupted);
        assert.equal(app.saves.length, 1);
        assert.deepEqual((await packets(app.saves[0].blob)).map((track) => track.type), ['video']);
        await assertFinalized(app.saves[0].blob, videoOnly);
        assert.deepEqual(await liveFiles(app), []);
      } finally { app.close(); }
    });
  }
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

function processorContext(sendMessage, Engine, Clock = Date, Worker, State = {}) {
  let listener;
  const chrome = {
    runtime: {
      id: 'mendosave@test', getURL: (path) => `moz-extension://test/${path}`,
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) {
        if (message.t === 'mendosave-recovery-read') return { ok: true, entries: State.entries || [] };
        return sendMessage ? sendMessage(message) : { ok: true };
      },
    },
  };
  const timers = new Set();
  const context = vm.createContext({
    chrome, URL: State.URL || URL, console, TextDecoder, Uint8Array, ArrayBuffer, atob, Blob, Date: Clock, Worker,
    FFmpegWASM: { FFmpeg: Engine || class {
      on() {} async load() {} terminate() {}
      async writeFile() {} async deleteFile() {} async exec() { return 0; }
      async readFile() { return new Uint8Array([255, 251, 144, 0, 1, 2, 3]); }
    } },
    navigator: { storage: State.storage || {} },
    setTimeout(fn, delay) { const timer = setTimeout(fn, State.fastTimers ? 0 : delay); timer.unref(); return timer; }, clearTimeout,
    setInterval(fn, delay) { const timer = setInterval(fn, delay); timer.unref(); timers.add(timer); return timer; },
    clearInterval(timer) { clearInterval(timer); timers.delete(timer); },
  });
  Object.assign(context, { File, AbortController, AbortSignal, DOMException, WritableStream, ReadableStream, crypto, MendoArchive: require('../extension/archive.js') });
  vm.runInContext(fs.readFileSync('extension/package_host.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('extension/package_io.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('extension/offscreen.js', 'utf8'), context);
  const message = (payload, tabId = 7) => new Promise((resolve) => {
    const accepted = listener(payload, { id: chrome.runtime.id, tab: { id: tabId, url: 'https://www.youtube.com/watch?v=fixture' } }, resolve);
    // Synchronous handlers send a response before returning false.
    if (!accepted) resolve(undefined);
  });
  return { message, close() { for (const timer of timers) clearInterval(timer); } };
}

test('a different tab cannot append data to an existing media job', async () => {
  const processor = processorContext();
  try {
    const begun = await processor.message({ t: 'mendosave-begin', jobId: 'job7', tabId: 7, format: 'mp3' });
    assert.equal(begun.ok, true);
    const foreign = await processor.message({ t: 'mendosave-chunk', jobId: 'job7', track: 'audio', b64: 'AQID' }, 8);
    assert.equal(foreign.ok, false);
    const own = await processor.message({ t: 'mendosave-chunk', jobId: 'job7', track: 'audio', b64: 'AQID' });
    assert.equal(own.ok, true);
    await processor.message({ t: 'mendosave-abort', jobId: 'job7' });
  } finally { processor.close(); }
});

test('staged media cannot be replaced, adopted or cancelled by another tab', async () => {
  const processor = processorContext();
  try {
    assert.equal((await processor.message({ t: 'mendosave-stage-open', jobId: 'job7' })).ok, true);
    assert.equal((await processor.message({ t: 'mendosave-stage', jobId: 'job7', track: 'audio', b64: 'AQID' })).ok, true);
    for (const t of ['mendosave-stage-open', 'mendosave-begin', 'mendosave-abort']) {
      assert.equal((await processor.message({ t, jobId: 'job7', format: 'mp3' }, 8)).ok, false, t);
    }
    assert.equal((await processor.message({ t: 'mendosave-stage', jobId: 'job7', track: 'audio', b64: 'AQID' })).ok, true);
    await processor.message({ t: 'mendosave-abort', jobId: 'job7' });
  } finally { processor.close(); }
});

test('invalid chunk envelopes cannot fill the processor buffers', async () => {
  const processor = processorContext();
  try {
    assert.equal((await processor.message({ t: 'mendosave-begin', jobId: 'job7', format: 'mp3' })).ok, true);
    for (const b64 of [42, '', 'A'.repeat(6 * 1024 * 1024)]) {
      assert.equal((await processor.message({ t: 'mendosave-chunk', jobId: 'job7', track: 'audio', b64 })).ok, false);
    }
    await processor.message({ t: 'mendosave-abort', jobId: 'job7' });
  } finally { processor.close(); }
});

test('invalid job parameters are rejected before claiming the processor', async () => {
  const processor = processorContext();
  try {
    for (const invalid of [{ filename: {} }, { duration: Infinity }, { scaleHeight: -1 }, { videoSize: -1 }]) {
      assert.equal((await processor.message({ t: 'mendosave-begin', jobId: 'bad', format: 'mp4', ...invalid })).ok, false);
    }
    assert.equal((await processor.message({ t: 'mendosave-begin', jobId: 'good', format: 'mp3' })).ok, true);
    await processor.message({ t: 'mendosave-abort', jobId: 'good' });
  } finally { processor.close(); }
});

test('a stalled ffmpeg worker is terminated and the next job can begin', async () => {
  let started, rejectEngine, terminated = 0, clock = Date.now();
  const executing = new Promise(resolve => { started = resolve; });
  const result = new Promise((_, reject) => { rejectEngine = reject; });
  const keepAlive = setTimeout(() => {}, 1500);
  class Clock extends Date { static now() { return clock; } }
  const processor = processorContext(() => ({ ok: true }), class {
    on() {} async load() {} async writeFile() {} async deleteFile() {}
    async exec() { started(); return result; }
    terminate() { terminated++; rejectEngine(new Error('worker terminated')); }
  }, Clock);
  try {
    await processor.message({ t: 'mendosave-begin', jobId: 'job7', format: 'mp3', audioMime: 'audio/mpeg' });
    await processor.message({ t: 'mendosave-chunk', jobId: 'job7', track: 'audio', b64: '//uQAAECAw==' });
    const finalized = processor.message({ t: 'mendosave-finalize', jobId: 'job7' });
    await executing;
    clock += 91_000;
    // The watchdog timer is real; only elapsed processing time is simulated.
    const response = await finalized;
    assert.equal(response.ok, false);
    assert.equal(terminated, 1);
    assert.equal((await processor.message({ t: 'mendosave-begin', jobId: 'job8', format: 'mp3' })).ok, true);
    await processor.message({ t: 'mendosave-abort', jobId: 'job8' });
  } finally { clearTimeout(keepAlive); processor.close(); }
});

test('cancelling an executing processor job cannot save its later output', async () => {
  let finishEngine;
  let started;
  const executing = new Promise((resolve) => { started = resolve; });
  const engineResult = new Promise((resolve) => { finishEngine = resolve; });
  let saves = 0;
  const processor = processorContext((message) => {
    if (message.t === 'mendosave-save') { saves++; return { ok: true, id: 42 }; }
    if (message.t === 'mendosave-download-state') return { ok: true, state: 'complete' };
    return { ok: true };
  }, class {
    on() {} async load() {} async writeFile() {} async deleteFile() {}
    async exec() { started(); return engineResult; }
    terminate() { finishEngine(1); }
    async readFile() { return new Uint8Array([255, 251, 144, 0, 1, 2, 3]); }
  });
  try {
    await processor.message({ t: 'mendosave-begin', jobId: 'job7', tabId: 7,
      format: 'mp3', audioMime: 'audio/mpeg', filename: 'test.mp3' });
    await processor.message({ t: 'mendosave-chunk', jobId: 'job7', track: 'audio', b64: '//uQAAECAw==' });
    const finalized = processor.message({ t: 'mendosave-finalize', jobId: 'job7' });
    await executing;
    assert.equal((await processor.message({ t: 'mendosave-abort', jobId: 'job7' })).ok, true);
    finishEngine(0);
    assert.equal((await finalized).ok, false);
    assert.equal(saves, 0);
  } finally { processor.close(); }
});

test('cancelling a waiting mux worker releases the job without a stall timeout', async () => {
  const processor = processorContext(undefined, undefined, Date, class { postMessage() {} terminate() {} });
  try {
    await processor.message({ t: 'mendosave-begin', jobId: 'job7', format: 'mp4', videoSize: 3, audioSize: 3 });
    const finalized = processor.message({ t: 'mendosave-finalize', jobId: 'job7' });
    await new Promise(resolve => setTimeout(resolve, 10));
    await processor.message({ t: 'mendosave-abort', jobId: 'job7' });
    const result = await Promise.race([finalized, new Promise(resolve => setTimeout(() => resolve('still waiting'), 100))]);
    assert.equal(result.cancelled, true);
    assert.equal((await processor.message({ t: 'mendosave-begin', jobId: 'job8', format: 'mp3' })).ok, true);
    await processor.message({ t: 'mendosave-abort', jobId: 'job8' });
  } finally { processor.close(); }
});

test('a processed file is successful only after the browser finishes its download', async () => {
  let complete;
  const completion = new Promise((resolve) => { complete = resolve; });
  const processor = processorContext((message) => {
    if (message.t === 'mendosave-save') return { ok: true, id: 42 };
    if (message.t === 'mendosave-download-state') return completion;
    return { ok: true };
  });
  let settled = false;
  try {
    assert.equal((await processor.message({ t: 'mendosave-begin', jobId: 'job7', tabId: 7,
      format: 'mp3', audioFormat: 'mp3', audioMime: 'audio/mpeg', filename: 'test.mp3' })).ok, true);
    assert.equal((await processor.message({ t: 'mendosave-chunk', jobId: 'job7', track: 'audio', b64: '//uQAAECAw==' })).ok, true);
    const finalized = processor.message({ t: 'mendosave-finalize', jobId: 'job7' }).then((response) => { settled = true; return response; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
    complete({ ok: true, state: 'complete' });
    assert.equal((await finalized).ok, true);
  } finally { complete({ ok: true, state: 'complete' }); processor.close(); }
});

test('rebranding preserves a ready file parked by version 0.1 in OPFS', async () => {
  const entries = [{ id: 'legacy.bin', filename: 'ready.mp4', bytes: 6, type: 'video/mp4', createdAt: Date.now(), savedAt: 0 }];
  const bytes = new Blob(['legacy'], { type: 'video/mp4' });
  let saves = 0, written;
  const storage = { async getDirectory() { return { async getDirectoryHandle(name) { return {
    async getFileHandle(id) { if (name !== 'nvs-recovered' || id !== 'legacy.bin') throw new Error('NotFoundError'); return { async getFile() { return bytes; } }; },
    async removeEntry() {},
  }; } }; } };
  const state = { entries, storage };
  const processor = processorContext(message => {
    if (message.t === 'mendosave-save') { saves++; return { ok: true, id: 42 }; }
    if (message.t === 'mendosave-download-state') return { ok: true, state: 'complete' };
    if (message.t === 'mendosave-recovery-write') { written = message.entries; state.entries = message.entries; }
    return { ok: true };
  }, undefined, Date, undefined, state);
  try {
    const result = await processor.message({ t: 'mendosave-flush' });
    assert.equal(result.ok, true);
    assert.equal(saves, 1);
    assert.equal(written.length, 1);
    assert.ok(written[0].savedAt);
    assert.equal(await bytes.text(), 'legacy');
    const repeated = await Promise.all([processor.message({ t: 'mendosave-flush' }), processor.message({ t: 'mendosave-flush' })]);
    assert.equal(repeated.every(result => result.ok && result.saved === 0), true);
    assert.equal(saves, 1, 'completed recovery is not handed to the browser again');
  } finally { processor.close(); }
});

test('an interrupted browser download reports failure and releases the processing slot', async () => {
  let saves = 0, revocations = 0;
  class BlobURL extends URL {
    static createObjectURL() { return 'blob:moz-extension://test/interrupted'; }
    static revokeObjectURL() { revocations++; }
  }
  const processor = processorContext(message => {
    if (message.t === 'mendosave-save') { saves++; return { ok: true, id: 42 }; }
    if (message.t === 'mendosave-download-state') return { ok: true, state: 'interrupted', error: 'FILE_NO_SPACE' };
    return { ok: true };
  }, undefined, Date, undefined, { URL: BlobURL });
  try {
    await processor.message({ t: 'mendosave-begin', jobId: 'job7', format: 'mp3', audioMime: 'audio/mpeg' });
    await processor.message({ t: 'mendosave-chunk', jobId: 'job7', track: 'audio', b64: '//uQAAECAw==' });
    const result = await processor.message({ t: 'mendosave-finalize', jobId: 'job7' });
    assert.equal(result.ok, false); assert.match(result.error, /FILE_NO_SPACE/);
    assert.equal(result.recovered, undefined); assert.equal(saves, 1); assert.equal(revocations, 1);
    assert.equal((await processor.message({ t: 'mendosave-begin', jobId: 'job8', format: 'mp3' })).ok, true);
    await processor.message({ t: 'mendosave-abort', jobId: 'job8' });
  } finally { processor.close(); }
});

test('ready output survives a paused or slow browser download beyond 30 minutes without duplicate saves', async (t) => {
  for (const paused of [true, false]) await t.test(paused ? 'paused' : 'slow in progress', async () => {
    let clock = Date.now(), saves = 0, polls = 0, settled = false, settledResult;
    let queried, finishDownload;
    const queriedState = new Promise(resolve => { queried = resolve; });
    const completion = new Promise(resolve => { finishDownload = resolve; });
    const revoked = [], deleted = [];
    class Clock extends Date { static now() { return clock; } }
    class BlobURL extends URL {
      static createObjectURL() { return 'blob:moz-extension://test/ready'; }
      static revokeObjectURL(url) { revoked.push(url); }
    }
    const processor = processorContext(message => {
      if (message.t === 'mendosave-save') { saves++; return { ok: true, id: 42 }; }
      if (message.t === 'mendosave-download-state') {
        if (++polls === 1) {
          clock += 31 * 60_000;
          queried();
          return { ok: true, state: 'in_progress', paused, bytesReceived: 1, totalBytes: 7 };
        }
        return completion;
      }
      return { ok: true };
    }, class {
      on() {} async load() {} terminate() {}
      async writeFile() {} async deleteFile(name) { deleted.push(name); }
      async exec() { return 0; }
      async readFile() { return new Uint8Array([255, 251, 144, 0, 1, 2, 3]); }
    }, Clock, undefined, { URL: BlobURL });
    const keepAlive = setTimeout(() => {}, 2000);
    try {
      await processor.message({ t: 'mendosave-begin', jobId: 'slow', format: 'mp3', audioMime: 'audio/mpeg' });
      await processor.message({ t: 'mendosave-chunk', jobId: 'slow', track: 'audio', b64: '//uQAAECAw==' });
      const finalized = processor.message({ t: 'mendosave-finalize', jobId: 'slow' })
        .then(result => { settled = true; settledResult = result; return result; });
      await queriedState;
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(settled, false, `in_progress output must remain owned after 31 minutes: ${JSON.stringify({
        result: settledResult, saves, revoked: revoked.length, deleted,
      })}`);
      assert.equal(revoked.length, 0, 'browser may still read the Blob URL');
      assert.equal(deleted.length, 0, 'finished processor output must remain available');
      finishDownload({ ok: true, state: 'complete' });
      assert.equal((await finalized).ok, true);
      assert.equal(saves, 1);
      assert.equal(revoked.length, 1);
      assert.ok(deleted.length > 0, 'completion releases processor files');
      assert.equal((await processor.message({ t: 'mendosave-begin', jobId: 'next', format: 'mp3' })).ok, true);
      await processor.message({ t: 'mendosave-abort', jobId: 'next' });
    } finally { finishDownload({ ok: true, state: 'complete' }); clearTimeout(keepAlive); processor.close(); }
  });
});

test('explicit cancellation stops an accepted paused download before releasing its Blob URL and job', async () => {
  let queried, allowCancel, saves = 0, cancellations = 0;
  const stateQueried = new Promise(resolve => { queried = resolve; });
  const cancellation = new Promise(resolve => { allowCancel = resolve; });
  const revoked = [];
  class BlobURL extends URL {
    static createObjectURL() { return 'blob:moz-extension://test/cancel'; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const processor = processorContext(message => {
    if (message.t === 'mendosave-save') { saves++; return { ok: true, id: 42 }; }
    if (message.t === 'mendosave-download-state') { queried(); return { ok: true, state: 'in_progress', paused: true }; }
    if (message.t === 'mendosave-download-cancel') { cancellations++; assert.equal(message.id, 42); return cancellation; }
    return { ok: true };
  }, undefined, Date, undefined, { URL: BlobURL });
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await processor.message({ t: 'mendosave-begin', jobId: 'cancel', format: 'mp3', audioMime: 'audio/mpeg' });
    await processor.message({ t: 'mendosave-chunk', jobId: 'cancel', track: 'audio', b64: '//uQAAECAw==' });
    const finalized = processor.message({ t: 'mendosave-finalize', jobId: 'cancel' });
    await stateQueried;
    assert.equal((await processor.message({ t: 'mendosave-abort', jobId: 'cancel' })).ok, true);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(cancellations, 1);
    assert.equal(revoked.length, 0, 'the Blob is retained until the browser cancellation request settles');
    allowCancel({ ok: true });
    const result = await finalized;
    assert.equal(result.ok, false); assert.equal(result.cancelled, true);
    assert.equal(result.recovered, undefined);
    assert.equal(revoked.length, 1); assert.equal(saves, 1);
    assert.equal((await processor.message({ t: 'mendosave-begin', jobId: 'next', format: 'mp3' })).ok, true);
    await processor.message({ t: 'mendosave-abort', jobId: 'next' });
  } finally { allowCancel({ ok: true }); clearTimeout(keepAlive); processor.close(); }
});

test('unreachable worker still parks exact ready bytes and recovery flush saves them only once', async () => {
  const files = new Map(), state = { entries: [], fastTimers: true };
  state.storage = { async getDirectory() { return { async getDirectoryHandle(name) {
    if (name !== 'nvs-recovered') throw new Error('NotFoundError');
    return { async getFileHandle(id, options) {
      if (!options?.create && !files.has(id)) throw new Error('NotFoundError');
      return { async createWritable() { return {
        async write(blob) { files.set(id, new Blob([files.get(id) || [], blob])); }, async close() {}, async abort() {},
      }; }, async getFile() { return files.get(id); } };
    }, async removeEntry(id) { files.delete(id); } };
  } }; } };
  let available = false, refused = 0, saves = 0;
  const processor = processorContext(message => {
    if (message.t === 'mendosave-save') {
      if (!available) { refused++; throw new Error('Could not establish connection. Receiving end does not exist.'); }
      saves++; return { ok: true, id: 42 };
    }
    if (message.t === 'mendosave-download-state') return { ok: true, state: 'complete' };
    if (message.t === 'mendosave-recovery-write') state.entries = message.entries;
    return { ok: true };
  }, undefined, Date, undefined, state);
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await processor.message({ t: 'mendosave-begin', jobId: 'park', filename: 'ready.mp3', format: 'mp3', audioMime: 'audio/mpeg' });
    await processor.message({ t: 'mendosave-chunk', jobId: 'park', track: 'audio', b64: '//uQAAECAw==' });
    const result = await processor.message({ t: 'mendosave-finalize', jobId: 'park' });
    assert.equal(result.ok, false); assert.equal(result.recovered, true);
    assert.equal(refused, 9); assert.equal(saves, 0);
    assert.equal(state.entries.length, 1); assert.equal(state.entries[0].savedAt, 0);
    assert.deepEqual(Buffer.from(await files.get(state.entries[0].id).arrayBuffer()), Buffer.from([255, 251, 144, 0, 1, 2, 3]));
    assert.equal((await processor.message({ t: 'mendosave-begin', jobId: 'next', format: 'mp3' })).ok, true);
    await processor.message({ t: 'mendosave-abort', jobId: 'next' });
    available = true;
    const results = await Promise.all([processor.message({ t: 'mendosave-flush' }), processor.message({ t: 'mendosave-flush' })]);
    assert.equal(results.every(response => response.ok), true);
    assert.equal(saves, 1); assert.ok(state.entries[0].savedAt);
  } finally { clearTimeout(keepAlive); processor.close(); }
});

function recoveryFixture(onSave, onIndexWrite = () => {}) {
  const files = new Map(), state = { entries: [], fastTimers: true };
  state.storage = { async getDirectory() { return { async getDirectoryHandle(name) {
    if (name !== 'nvs-recovered') throw new Error('NotFoundError');
    return { async getFileHandle(id, options) {
      if (!options?.create && !files.has(id)) throw new Error('NotFoundError');
      return { async createWritable() { return {
        async write(blob) { files.set(id, new Blob([files.get(id) || [], blob])); }, async close() {}, async abort() {},
      }; }, async getFile() { return files.get(id); } };
    }, async removeEntry(id) { files.delete(id); } };
  } }; } };
  const processor = processorContext(message => {
    if (message.t === 'mendosave-save') return onSave(message);
    if (message.t === 'mendosave-download-state') return { ok: true, state: 'complete' };
    if (message.t === 'mendosave-recovery-write') { onIndexWrite(message); state.entries = message.entries; }
    return { ok: true };
  }, undefined, Date, undefined, state);
  function park(id) {
    files.set(id, new Blob(['ready bytes']));
    state.entries.push({ id, filename: `${id}.mp4`, createdAt: Date.now(), savedAt: 0 });
  }
  return { processor, files, state, park };
}

test('cancelling recovery stops further native dialogs and automatic retry of the remaining files', async () => {
  let saves = 0;
  const { processor, state, park } = recoveryFixture(() => { saves++; return { ok: false, cancelled: true, error: 'Download canceled by the user' }; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    park('first'); park('second');
    const result = await processor.message({ t: 'mendosave-flush', manual: true });
    assert.equal(result.cancelled, true);
    assert.equal(saves, 1);
    assert.equal(state.entries.length, 2);
    assert.ok(state.entries.every(entry => entry.manualOnly && !entry.savedAt));
    await processor.message({ t: 'mendosave-flush' });
    assert.equal(saves, 1);
  } finally { processor.close(); }
});

test('recovery flush preserves a ready file prepared while an earlier native save is pending', async () => {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const { processor, state, files, park } = recoveryFixture(async message => {
    if (message.filename === 'first.mp4') { entered(); await pending; return { ok: true, id: 42 }; }
    throw new Error('Could not establish connection. Receiving end does not exist.');
  });
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await new Promise(resolve => setImmediate(resolve)); park('first');
    const flushing = processor.message({ t: 'mendosave-flush', manual: true });
    await started;
    await processor.message({ t: 'mendosave-begin', jobId: 'new', filename: 'new.mp3', format: 'mp3', audioMime: 'audio/mpeg' });
    await processor.message({ t: 'mendosave-chunk', jobId: 'new', track: 'audio', b64: '//uQAAECAw==' });
    const result = await processor.message({ t: 'mendosave-finalize', jobId: 'new' });
    assert.equal(result.recovered, true);
    assert.equal(state.entries.length, 2);
    const newId = state.entries.find(entry => entry.filename === 'new.mp3').id;
    finish(); await flushing;
    assert.equal(state.entries.some(entry => entry.id === newId && !entry.savedAt), true);
    assert.equal(files.has(newId), true);
    assert.ok(state.entries.find(entry => entry.id === 'first').savedAt);
  } finally { finish(); clearTimeout(keepAlive); processor.close(); }
});

test('recovery records the saved prefix before waiting for the next native dialog', async () => {
  let entered, cancel;
  const second = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { cancel = resolve; });
  const { processor, state, park } = recoveryFixture(async message => {
    if (message.filename === 'first.mp4') return { ok: true, id: 42 };
    entered(); return pending;
  });
  try {
    await new Promise(resolve => setImmediate(resolve)); park('first'); park('second');
    const flushing = processor.message({ t: 'mendosave-flush', manual: true });
    await second;
    assert.ok(state.entries.find(entry => entry.id === 'first').savedAt);
    cancel({ ok: false, cancelled: true, error: 'Download canceled by the user' });
    const result = await flushing;
    assert.equal(result.saved, 1); assert.equal(result.pending, 1); assert.equal(result.cancelled, true);
  } finally { cancel({ ok: false, cancelled: true }); processor.close(); }
});

test('a transient recovery index failure after a saved file does not download it again', async () => {
  let saves = 0, writes = 0;
  const { processor, state, park } = recoveryFixture(() => { saves++; return { ok: true, id: 42 }; }, () => {
    if (++writes === 1) throw new Error('storage temporarily unavailable');
  });
  try {
    await new Promise(resolve => setImmediate(resolve)); park('first');
    const result = await processor.message({ t: 'mendosave-flush', manual: true });
    assert.equal(result.saved, 1); assert.equal(result.pending, 0);
    assert.ok(state.entries[0].savedAt);
    await processor.message({ t: 'mendosave-flush', manual: true });
    assert.equal(saves, 1);
  } finally { processor.close(); }
});

test('unsaved manual recovery survives automatic expiry and remains explicitly saveable', async () => {
  let saves = 0;
  const { processor, state, files, park } = recoveryFixture(() => { saves++; return { ok: true, id: 42 }; });
  try {
    await new Promise(resolve => setImmediate(resolve)); park('ready-package');
    Object.assign(state.entries[0], { manualOnly: true, createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });
    const automatic = await processor.message({ t: 'mendosave-flush' });
    assert.equal(automatic.pending, 1);
    assert.equal(saves, 0);
    assert.equal(files.has('ready-package'), true);
    assert.equal(state.entries.length, 1);
    const manual = await processor.message({ t: 'mendosave-flush', manual: true });
    assert.equal(manual.saved, 1);
    assert.equal(manual.pending, 0);
    assert.ok(state.entries[0].savedAt);
  } finally { processor.close(); }
});

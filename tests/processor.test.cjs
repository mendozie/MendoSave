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
    chrome, URL, console, TextDecoder, Uint8Array, ArrayBuffer, atob, Blob, Date: Clock, Worker,
    FFmpegWASM: { FFmpeg: Engine || class {
      on() {} async load() {} terminate() {}
      async writeFile() {} async deleteFile() {} async exec() { return 0; }
      async readFile() { return new Uint8Array([255, 251, 144, 0, 1, 2, 3]); }
    } },
    navigator: { storage: State.storage || {} },
    setTimeout(fn, delay) { const timer = setTimeout(fn, delay); timer.unref(); return timer; }, clearTimeout,
    setInterval(fn, delay) { const timer = setInterval(fn, delay); timer.unref(); timers.add(timer); return timer; },
    clearInterval(timer) { clearInterval(timer); timers.delete(timer); },
  });
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
  } finally { processor.close(); }
});

test('an interrupted browser download reports failure and releases the processing slot', async () => {
  const processor = processorContext(message => message.t === 'mendosave-save' ? { ok: true, id: 42 }
    : message.t === 'mendosave-download-state' ? { ok: true, state: 'interrupted', error: 'FILE_NO_SPACE' } : { ok: true });
  try {
    await processor.message({ t: 'mendosave-begin', jobId: 'job7', format: 'mp3', audioMime: 'audio/mpeg' });
    await processor.message({ t: 'mendosave-chunk', jobId: 'job7', track: 'audio', b64: '//uQAAECAw==' });
    assert.equal((await processor.message({ t: 'mendosave-finalize', jobId: 'job7' })).ok, false);
    assert.equal((await processor.message({ t: 'mendosave-begin', jobId: 'job8', format: 'mp3' })).ok, true);
    await processor.message({ t: 'mendosave-abort', jobId: 'job8' });
  } finally { processor.close(); }
});

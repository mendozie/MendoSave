const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../extension/package_queue.js');

test('a format package runs exactly the selected files, one at a time, before final saving', async () => {
  const calls = [];
  let active = 0;
  const items = ['video 720p', 'audio MP3', 'subtitles SRT'].map(label => ({
    id: label, label, async run() {
      assert.equal(active++, 0);
      calls.push(label);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return `${label}.file`;
    },
  }));
  const result = await run(items, {
    async start() { calls.push('start'); }, async next(index) { calls.push(`next:${index}`); },
    async complete(index) { calls.push(`done:${index}`); }, async finish() { calls.push('save'); return { filename: 'bundle.zip' }; },
    async cancel() { calls.push('cancel'); },
  });
  assert.deepEqual(calls, ['start', 'next:0', 'video 720p', 'done:0', 'next:1', 'audio MP3', 'done:1', 'next:2', 'subtitles SRT', 'done:2', 'save']);
  assert.equal(result.phase, 'complete');
  assert.equal(result.results.length, 3);
  assert.equal(result.filename, 'bundle.zip');
});

test('a swallowed adapter failure cannot count as success or produce a partial ZIP', async () => {
  const calls = [];
  const result = await run([{ id: 'video', async run() { return undefined; } }, { id: 'audio', async run() { calls.push('audio'); return true; } }], {
    async start() {}, async next() {}, async complete() { calls.push('complete'); },
    async finish() { calls.push('ZIP'); }, async cancel() { calls.push('cancel'); },
  });
  assert.equal(result.phase, 'error');
  assert.deepEqual(calls, ['cancel']);
});

test('cancellation keeps completed files and never starts a following format or ZIP', async () => {
  const signal = new AbortController();
  const calls = [];
  const result = await run([
    { id: 'video', async run() { return 'video.mp4'; } },
    { id: 'audio', async run() { signal.abort(); return 'audio.mp3'; } },
    { id: 'sub', async run() { calls.push('sub'); } },
  ], {
    signal: signal.signal, async start() {}, async next() {}, async complete(index) { calls.push(`done:${index}`); },
    async finish() { calls.push('ZIP'); }, async cancel() { calls.push('cancel'); },
  });
  assert.equal(result.phase, 'cancelled');
  assert.deepEqual(result.results, [{ id: 'video', filename: 'video.mp4' }]);
  assert.deepEqual(calls, ['done:0', 'cancel']);
});

test('cancellation while final saving settles cannot report a completed package', async () => {
  const controller = new AbortController();
  let reason;
  const result = await run([{ id: 'text', async run() { return 'text.txt'; } }], {
    signal: controller.signal, async start() {}, async next() {}, async complete() {},
    async finish() { controller.abort(); return { filename: 'bundle.zip' }; },
    async cancel(value) { reason = value; },
  });
  assert.equal(result.phase, 'cancelled');
  assert.equal(reason, 'cancelled');
  assert.deepEqual(result.results, [{ id: 'text', filename: 'text.txt' }]);
});

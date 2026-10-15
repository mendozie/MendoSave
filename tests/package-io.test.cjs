const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture } = require('./package-io-harness.cjs');
const sender = { id: 'mendo@test', tab: { id: 7 }, frameId: 0, documentId: 'doc7' };
const plan = { t: 'mendosave-package-begin', packageId: 'package7', mode: 'files', title: 'Test',
  items: [{ id: 'mp4', label: 'MP4' }] };

test('package routes bind actual sender ownership and decline unrelated routes', async () => {
  const { io } = fixture();
  assert.equal(io.handle({ t: 'elsewhere' }, sender), undefined);
  assert.equal((await io.handle(plan, sender)).ok, true);
  assert.equal(io.jobsActive(), true);
  assert.equal((await io.handle({ t: 'mendosave-package-next', packageId: 'package7', index: 0 },
    { ...sender, documentId: 'newdoc' })).ok, false);
  assert.equal((await io.handle({ t: 'mendosave-package-next', packageId: 'package7', index: 0 }, sender)).ok, true);
});

test('cancelling package admission drains a late reservation before another package can start', async () => {
  let enter, resolveReservation, held = false, releases = 0, calls = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const pending = new Promise(resolve => { resolveReservation = resolve; });
  const { io } = fixture({ async reservePackage() {
    assert.equal(held, false, 'an earlier package must release its admission lease');
    held = true;
    if (++calls === 1) { enter(); await pending; }
    return () => { held = false; releases++; };
  } });
  const starting = io.handle(plan, sender);
  const prematureNext = io.handle({ t: 'mendosave-package-next', packageId: plan.packageId, index: 0 }, sender);
  try {
    await entered;
    assert.equal((await prematureNext).ok, false, 'a packet queued immediately after begin cannot bypass admission');
    assert.equal((await io.handle({ t: 'mendosave-package-next', packageId: plan.packageId, index: 0 }, sender)).ok, false);
    assert.equal((await io.handle({ t: 'mendosave-package-cancel', packageId: plan.packageId }, sender)).ok, true);
    assert.equal((await io.handle({ ...plan, packageId: 'tooEarly' }, sender)).ok, false);
    resolveReservation();
    assert.equal((await starting).cancelled, true);
    assert.equal(releases, 1); assert.equal(io.jobsActive(), false);
    assert.equal((await io.handle({ ...plan, packageId: 'afterCleanup' }, sender)).ok, true);
    await io.handle({ t: 'mendosave-package-cancel', packageId: 'afterCleanup' }, sender);
    assert.equal(releases, 2); assert.equal(held, false);
  } finally { resolveReservation(); }
});

test('failed admission and failed ZIP saving both release capacity for the next valid package', async () => {
  let held = false, rejectAdmission = true, releases = 0;
  const { io } = fixture({ async reservePackage() {
    if (rejectAdmission) { rejectAdmission = false; throw new Error('admission storage unavailable'); }
    assert.equal(held, false); held = true;
    return () => { held = false; releases++; };
  }, async saveBlob() { throw new Error('native save failed'); } });
  const zipPlan = { ...plan, mode: 'zip', items: [...plan.items, { id: 'text', label: 'Text' }] };
  const failed = await io.handle(zipPlan, sender);
  assert.equal(failed.ok, false); assert.match(failed.error, /admission storage unavailable/);
  assert.equal(io.jobsActive(), false);
  assert.equal((await io.handle(zipPlan, sender)).ok, true);
  for (let index = 0; index < 2; index++) {
    await io.handle({ t: 'mendosave-package-next', packageId: plan.packageId, index }, sender);
    await io.output({ tabId: 7, frameId: 0, documentId: 'doc7' }, plan.packageId, index, new Blob(['ready bytes']), `item${index}.txt`);
    await io.handle({ t: 'mendosave-package-complete', packageId: plan.packageId, index }, sender);
  }
  const finishing = await io.handle({ t: 'mendosave-package-finish', packageId: plan.packageId }, sender);
  assert.equal(finishing.ok, false); assert.match(finishing.error, /native save failed/);
  assert.equal(held, false); assert.equal(releases, 1);
  assert.equal((await io.handle({ ...zipPlan, packageId: 'afterFailure' }, sender)).ok, true);
  await io.handle({ t: 'mendosave-package-cancel', packageId: 'afterFailure' }, sender);
  assert.equal(releases, 2);
});

const transferId = '12345678-1234-4234-8234-123456789012';
const opening = { t: 'mendosave-blob-open', transferId, filename: 'video.mp4', mime: 'video/mp4', size: 5 };
test('single Blob handoff writes exact bytes to OPFS and saves once after complete delivery', async () => {
  const { io, saved, files } = fixture();
  assert.equal((await io.handle(opening, sender))?.ok, true);
  assert.equal((await io.handle({ t: 'mendosave-blob-chunk', transferId, sequence: 0,
    data: Buffer.from('hello').toString('base64') }, sender)).ok, true);
  assert.equal(saved.length, 0);
  const response = await io.handle({ t: 'mendosave-blob-finish', transferId }, sender);
  assert.equal(response.ok, true, response.error);
  assert.equal(response.id, 42);
  assert.equal(await saved[0].blob.text(), 'hello');
  assert.equal(files.size, 0);
  assert.equal(io.jobsActive(), false);
});

test('Blob transfer rejects foreign documents, partial output and invalid sequence without saving', async () => {
  const { io, files, saved } = fixture();
  await io.handle(opening, sender);
  assert.equal((await io.handle({ t: 'mendosave-blob-chunk', transferId, sequence: 0, data: 'aGVsbG8=' },
    { ...sender, tab: { id: 8 } })).ok, false);
  assert.equal(files.size, 1);
  assert.equal((await io.handle({ t: 'mendosave-blob-finish', transferId }, sender)).ok, false);
  assert.equal(files.size, 0);
  assert.equal(saved.length, 0);
  await io.handle(opening, sender);
  assert.equal((await io.handle({ t: 'mendosave-blob-chunk', transferId, sequence: 1, data: 'aA==' }, sender)).ok, false);
  assert.equal(files.size, 0);
});

test('bound document port cancellation retains completed ZIP prefix and never saves partial ZIP', async () => {
  const { io, saved } = fixture();
  await io.handle({ ...plan, mode: 'zip', items: [...plan.items, { id: 'mp3', label: 'MP3' }] }, sender);
  await io.handle({ t: 'mendosave-package-next', packageId: 'package7', index: 0 }, sender);
  await io.host.output({ tabId: 7, frameId: 0, documentId: 'doc7' }, 'package7', new File(['media'], 'video.mp4'), 'video.mp4');
  const retained = io.host.active.entries;
  let disconnect;
  assert.equal(io.connect({ name: 'mendosave-package:package7', sender,
    onDisconnect: { addListener(callback) { disconnect = callback; } } }), true);
  await disconnect();
  assert.equal(io.host.active, null);
  assert.equal(retained.length, 1);
  assert.equal(saved.length, 0);
});

test('background source save streams HTTPS into OPFS and applies package ownership before fetching', async () => {
  const requests = [];
  const { io, saved, files } = fixture({ fetch: async (url, options) => {
    requests.push({ url, options });
    return new Response(new Blob(['hello']), { headers: { 'content-length': '5', 'content-type': 'video/mp4' } });
  } });
  await io.handle(plan, sender);
  await io.handle({ t: 'mendosave-package-next', packageId: 'package7', index: 0 }, sender);
  const message = { t: 'mendosave-save-source', packageId: 'package7', packageIndex: 0,
    sourceOwner: { tabId: 7, frameId: 0, documentId: 'doc7' }, url: 'https://example.test/media', filename: 'video.mp4' };
  assert.equal((await io.handle(message, sender))?.ok, false);
  assert.equal(requests.length, 0);
  const response = await io.handle(message, { id: 'mendo@test', url: 'moz-extension://test/_generated_background_page.html' });
  assert.equal(response.ok, true);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(await saved[0].blob.text(), 'hello');
  assert.equal(files.size, 0);
});

test('ZIP finish streams exact entries into OPFS and keeps archive until native save completes', async () => {
  let release;
  let submitted;
  const native = new Promise(resolve => { release = resolve; });
  const { io, files } = fixture({ saveBlob: async blob => { submitted = blob; await native; return 42; } });
  await io.handle({ ...plan, mode: 'zip', items: [...plan.items, { id: 'mp3', label: 'MP3' }] }, sender);
  const owner = { tabId: 7, frameId: 0, documentId: 'doc7' };
  for (const [index, text] of ['exact video', 'exact audio'].entries()) {
    await io.handle({ t: 'mendosave-package-next', packageId: 'package7', index }, sender);
    await io.host.output(owner, 'package7', new File([text], 'same.mp4'), 'same.mp4');
    await io.handle({ t: 'mendosave-package-complete', packageId: 'package7', index }, sender);
  }
  const pending = io.handle({ t: 'mendosave-package-finish', packageId: 'package7' }, sender);
  for (let i = 0; i < 30 && !submitted; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(submitted, 'archive reaches native save');
  assert.equal([...files.keys()].some(key => key.startsWith('mendo-archives/')), true);
  assert.equal((await io.handle({ t: 'mendosave-package-finish', packageId: 'package7' }, sender)).ok, false);
  assert.equal([...files.keys()].some(key => key.startsWith('mendo-archives/')), true, 'duplicate finish must not delete pending native archive');
  release();
  assert.equal((await pending).ok, true);
  assert.equal(files.size, 0);
  const zip = require('../extension/vendor/zipjs/zip-native.min.js');
  const reader = new zip.ZipReader(new zip.BlobReader(submitted));
  const entries = await reader.getEntries();
  assert.deepEqual(entries.map(entry => entry.filename), ['same.mp4', 'same (2).mp4']);
  assert.equal(await entries[0].getData(new zip.TextWriter()), 'exact video');
  assert.equal(await entries[1].getData(new zip.TextWriter()), 'exact audio');
  await reader.close();
});

test('Blob limits and insufficient quota fail before native save and abort removes the spool', async () => {
  const { io, files, saved } = fixture();
  for (const patch of [{ size: 0 }, { size: 1024 ** 3 + 1 }, { mime: 'invalid' }, { transferId: '../outside' }]) {
    assert.equal((await io.handle({ ...opening, ...patch }, sender)).ok, false);
  }
  assert.equal(files.size, 0);
  await io.handle(opening, sender);
  const cancelled = await io.handle({ t: 'mendosave-blob-abort', transferId }, sender);
  assert.equal(cancelled.cancelled, true);
  assert.equal(files.size, 0);
  assert.equal(saved.length, 0);
  const full = fixture({ storage: { estimate: async () => ({ usage: 100, quota: 100 }),
    getDirectory: async () => { throw new Error('quota must stop directory creation'); } } });
  assert.match((await full.io.handle(opening, sender)).error, /Недостаточно места/);
});

test('source rejects unsafe URLs, mismatched lengths and document ownership before saving', async () => {
  let fetches = 0;
  const { io, files, saved } = fixture({ fetch: async () => { fetches++;
    return new Response('short', { headers: { 'content-length': '10' } }); } });
  await io.handle(plan, sender);
  await io.handle({ t: 'mendosave-package-next', packageId: 'package7', index: 0 }, sender);
  const request = { t: 'mendosave-save-source', packageId: 'package7', packageIndex: 0, filename: 'video.mp4',
    sourceOwner: { tabId: 7, frameId: 0, documentId: 'doc7' } };
  const bg = { id: 'mendo@test' };
  for (const url of ['file:///secret', 'https://127.0.0.1/media', 'https://10.1.2.3/media',
    'https://user:pass@example.test/media', 'https://example.test:444/media', 'https://[::1]/media']) {
    assert.equal((await io.handle({ ...request, url }, bg)).ok, false);
  }
  assert.equal(fetches, 0);
  assert.equal((await io.handle({ ...request, url: 'https://example.test/media',
    sourceOwner: { ...request.sourceOwner, documentId: 'other' } }, bg)).ok, false);
  assert.equal(fetches, 0);
  assert.equal((await io.handle({ ...request, url: 'https://example.test/media' }, bg)).ok, false);
  assert.equal(files.size, 0);
  assert.equal(saved.length, 0);
});

test('package cancellation during source stream returns cancelled and clears OPFS without output', async () => {
  let waiting, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { io, files, saved } = fixture({ fetch: async (_url, { signal }) => {
    return new Response(new ReadableStream({
      start(controller) {
        waiting = controller;
        controller.enqueue(new TextEncoder().encode('first'));
        signal.addEventListener('abort', () => controller.error(signal.reason));
        started();
      },
    }), { headers: { 'content-type': 'video/mp4' } });
  } });
  await io.handle(plan, sender);
  await io.handle({ t: 'mendosave-package-next', packageId: 'package7', index: 0 }, sender);
  const pending = io.handle({ t: 'mendosave-save-source', packageId: 'package7', packageIndex: 0, filename: 'video.mp4',
    sourceOwner: { tabId: 7, frameId: 0, documentId: 'doc7' }, url: 'https://example.test/media' }, { id: 'mendo@test' });
  await ready;
  assert.ok(waiting);
  await io.handle({ t: 'mendosave-package-cancel', packageId: 'package7' }, sender);
  assert.equal((await pending).cancelled, true);
  assert.equal(files.size, 0);
  assert.equal(saved.length, 0);
  assert.equal(io.jobsActive(), false);
});

test('failed ZIP save clears temporary archive and retains prepared prefix for recovery', async () => {
  let discarded = 0;
  const { io, files } = fixture({ saveBlob: async () => { const error = new Error('picker cancelled');
    error.cancelled = true; throw error; }, discard: async () => discarded++ });
  await io.handle({ ...plan, mode: 'zip', items: [...plan.items, { id: 'mp3', label: 'MP3' }] }, sender);
  const owner = { tabId: 7, frameId: 0, documentId: 'doc7' };
  for (let index = 0; index < 2; index++) {
    await io.handle({ t: 'mendosave-package-next', packageId: 'package7', index }, sender);
    await io.host.output(owner, 'package7', new File(['media'], 'file.mp4'), 'file.mp4');
    await io.handle({ t: 'mendosave-package-complete', packageId: 'package7', index }, sender);
  }
  const prefix = io.host.active.entries;
  assert.equal((await io.handle({ t: 'mendosave-package-finish', packageId: 'package7' }, sender)).cancelled, true);
  assert.equal(prefix.length, 2);
  assert.equal(discarded, 0);
  assert.equal(files.size, 0);
});

test('aborting a Blob handoff clears only that transfer and leaves its package cancellable', async () => {
  const { io, files } = fixture();
  await io.handle(plan, sender);
  await io.handle({ t: 'mendosave-package-next', packageId: 'package7', index: 0 }, sender);
  await io.handle({ ...opening, packageId: 'package7', packageIndex: 0 }, sender);
  assert.equal((await io.handle({ t: 'mendosave-blob-abort', transferId }, sender)).cancelled, true);
  assert.equal(files.size, 0);
  assert.equal(io.host.active.controller.signal.aborted, false, 'Blob transport failure must not mutate package cancellation state');
  assert.equal((await io.handle({ t: 'mendosave-package-cancel', packageId: 'package7' }, sender)).ok, true);
});

test('late Blob from a previous package position cannot occupy the current item', async () => {
  const { io, files } = fixture();
  await io.handle({ ...plan, mode: 'zip', items: [...plan.items, { id: 'mp3', label: 'MP3' }] }, sender);
  await io.handle({ t: 'mendosave-package-next', packageId: 'package7', index: 0 }, sender);
  assert.equal((await io.handle({ ...opening, packageId: 'package7', packageIndex: 0 }, sender)).ok, true);
  await io.host.output({ tabId: 7, frameId: 0, documentId: 'doc7' }, 'package7', new File(['first'], 'first.mp4'), 'first.mp4');
  await io.handle({ t: 'mendosave-package-complete', packageId: 'package7', index: 0 }, sender);
  await io.handle({ t: 'mendosave-package-next', packageId: 'package7', index: 1 }, sender);
  assert.equal((await io.handle({ t: 'mendosave-blob-chunk', transferId, sequence: 0, data: 'aGVsbG8=', packageIndex: 0 }, sender)).ok, false);
  assert.equal((await io.handle({ t: 'mendosave-blob-finish', transferId }, sender)).ok, false);
  assert.equal(io.host.active.entries.length, 1);
  assert.equal(files.size, 0);
});

test('one package position permits one Blob or source producer and rejects a stale source index', async () => {
  let fetches = 0;
  const { io } = fixture({ fetch: async () => { fetches++; throw new Error('unexpected fetch'); } });
  await io.handle(plan, sender);
  await io.handle({ t: 'mendosave-package-next', packageId: 'package7', index: 0 }, sender);
  await io.handle({ ...opening, packageId: 'package7', packageIndex: 0 }, sender);
  assert.equal((await io.handle({ ...opening, transferId: '22345678-1234-4234-8234-123456789012',
    packageId: 'package7', packageIndex: 0 }, sender)).ok, false);
  for (const packageIndex of [undefined, 0, 1]) {
    assert.equal((await io.handle({ t: 'mendosave-save-source', packageId: 'package7', packageIndex,
      sourceOwner: { tabId: 7, frameId: 0, documentId: 'doc7' }, filename: 'video.mp4',
      url: 'https://example.test/media' }, { id: 'mendo@test' })).ok, false);
  }
  assert.equal(fetches, 0);
  await io.handle({ t: 'mendosave-blob-abort', transferId }, sender);
});

test('standalone transfer binds a document port and disconnect releases OPFS and active slot', async () => {
  const { io, files } = fixture();
  await io.handle(opening, sender);
  assert.equal(io.connect({ name: `mendosave-transfer:${transferId}`, sender: { ...sender, documentId: 'other' },
    disconnect() {}, onDisconnect: { addListener() { throw new Error('foreign port accepted'); } } }), false);
  let disconnected;
  assert.equal(io.connect({ name: `mendosave-transfer:${transferId}`, sender,
    onDisconnect: { addListener(callback) { disconnected = callback; } } }), true);
  await disconnected();
  assert.equal(files.size, 0);
  assert.equal(io.jobsActive(), false);
  assert.equal((await io.handle({ t: 'mendosave-blob-finish', transferId }, sender)).ok, false);
});

test('unconnected transfer expires but a pending native Save As has no transfer timeout', async () => {
  const abandoned = fixture();
  await abandoned.io.handle(opening, sender);
  assert.equal(abandoned.timers.size, 1);
  await [...abandoned.timers.values()][0]();
  assert.equal(abandoned.files.size, 0);
  assert.equal(abandoned.io.jobsActive(), false);
  let release, saving;
  const enteredSaving = new Promise(resolve => { saving = resolve; });
  const native = new Promise(resolve => { release = resolve; });
  const { io, files, timers } = fixture({ saveBlob: async () => { saving(); await native; return 42; } });
  await io.handle(opening, sender);
  let disconnected;
  io.connect({ name: `mendosave-transfer:${transferId}`, sender,
    onDisconnect: { addListener(callback) { disconnected = callback; } } });
  await io.handle({ t: 'mendosave-blob-chunk', transferId, sequence: 0, data: 'aGVsbG8=' }, sender);
  const pending = io.handle({ t: 'mendosave-blob-finish', transferId }, sender);
  await enteredSaving;
  assert.equal(timers.size, 0);
  await disconnected();
  assert.equal(files.size, 1, 'Save As retains the completed spool');
  assert.equal(io.jobsActive(), true);
  release();
  assert.equal((await pending).ok, true);
  assert.equal(files.size, 0);
});

test('startup sweep removes owned temporary UUID files and preserves recovery and unknown files', async () => {
  const { io, files } = fixture();
  files.set(`mendo-transfer/${transferId}.bin`, new Uint8Array([1]));
  files.set(`mendo-archives/${transferId}.bin`, new Uint8Array([2]));
  files.set(`mendo-outputs/${transferId}.bin`, new Uint8Array([3]));
  files.set('mendo-transfer/unknown.bin', new Uint8Array([4]));
  files.set(`mendo-transfer/nested/${transferId}.bin`, new Uint8Array([5]));
  assert.equal((await io.initialize()).removed, 2);
  assert.equal(files.size, 3);
  assert.equal(files.get(`mendo-outputs/${transferId}.bin`)[0], 3);
  await io.initialize();
  await io.handle(opening, sender);
  await assert.rejects(() => io.sweep(), /выполняется/);
  assert.equal(files.size, 4);
  await io.handle({ t: 'mendosave-blob-abort', transferId }, sender);
});

test('direct output and external work cannot compete with an IO producer for the same position', async () => {
  let busy = true;
  const { io, files } = fixture({ positionBusy: () => busy });
  const owner = { tabId: 7, frameId: 0, documentId: 'doc7' };
  await io.handle(plan, sender);
  await io.handle({ t: 'mendosave-package-next', packageId: 'package7', index: 0 }, sender);
  assert.equal((await io.handle({ ...opening, packageId: 'package7', packageIndex: 0 }, sender)).ok, false);
  assert.equal(files.size, 0);
  busy = false;
  assert.equal(io.positionAvailable(owner, 'package7', 0), true);
  assert.throws(() => io.positionAvailable(owner, 'package7', 1), /позиции/);
  await io.handle({ ...opening, packageId: 'package7', packageIndex: 0 }, sender);
  assert.throws(() => io.positionAvailable(owner, 'package7', 0), /producer/);
  await assert.rejects(() => io.output(owner, 'package7', 0, new Blob(['wrong']), 'wrong.mp4'), /producer/);
  await io.handle({ t: 'mendosave-blob-abort', transferId }, sender);
  assert.equal((await io.output(owner, 'package7', 0, new Blob(['right']), 'right.mp4')).ok, true);
});

test('work admitted immediately before initialization cannot create a spool during sweeping', async () => {
  let release, entered;
  const sweepStarted = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const base = fixture();
  const { io } = fixture({ storage: {
    estimate: async () => ({ usage: 0, quota: 8 * 1024 ** 3 }),
    getDirectory: async () => { entered(); await blocked; return base.storage.getDirectory(); },
  } });
  assert.equal(base.files.size, 0);
  const pendingOpen = io.handle(opening, sender);
  const starting = io.initialize();
  await sweepStarted;
  release();
  const result = await pendingOpen;
  assert.match(result.error, /очища/);
  await starting;
  assert.equal(base.files.size, 0);
  assert.equal(io.jobsActive(), false);
});

test('disconnect during an OPFS write cancels the chunk and waits to clean the active writer', async () => {
  let release, writing;
  const started = new Promise(resolve => { writing = resolve; });
  const writingGate = new Promise(resolve => { release = resolve; });
  const { io, files, saved } = fixture({ beforeWrite: async () => { writing(); await writingGate; } });
  await io.handle(opening, sender);
  let disconnected;
  io.connect({ name: `mendosave-transfer:${transferId}`, sender,
    onDisconnect: { addListener(callback) { disconnected = callback; } } });
  const chunk = io.handle({ t: 'mendosave-blob-chunk', transferId, sequence: 0, data: 'aGVsbG8=' }, sender);
  await started;
  const cleanup = disconnected();
  assert.equal(files.size, 1);
  assert.equal(io.jobsActive(), true);
  release();
  assert.equal((await chunk).cancelled, true);
  await cleanup;
  assert.equal(files.size, 0);
  assert.equal(saved.length, 0);
  assert.equal(io.jobsActive(), false);
});

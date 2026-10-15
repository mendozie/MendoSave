const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PackageHost } = require('../extension/package_host.js');
const owner = { tabId: 7, frameId: 0, documentId: 'doc7' };
const plan = { packageId: 'package7', mode: 'zip', title: 'Test', items: [{ id: 'mp4', label: '720p MP4' }, { id: 'mp3', label: 'MP3' }] };

test('packages accept all 64 outputs and reject 65 before claiming the host', async t => {
  for (const mode of ['files', 'zip']) await t.test(mode, async () => {
    const saved = [], archived = [];
    const host = new PackageHost({ names: names => names,
      async prepare(blob, filename) { return { blob, filename }; },
      async archive(entries) { archived.push(...entries.map(entry => entry.filename)); return new Blob(['zip']); },
      async save(_blob, filename) { saved.push(filename); return saved.length; }, async discard() {},
    });
    const items = Array.from({ length: 65 }, (_, index) => ({ id: `item-${index}`, label: `Item ${index}` }));
    await assert.rejects(() => host.begin(owner, { ...plan, mode, items }), /Некорректный план/);
    assert.deepEqual(saved, []); assert.deepEqual(archived, []);
    assert.deepEqual(await host.begin(owner, { ...plan, mode, items: items.slice(0, 64) }), { ok: true });
    for (let index = 0; index < 64; index++) {
      host.next(owner, { packageId: plan.packageId, index });
      await host.output(owner, plan.packageId, new Blob([`bytes-${index}`]), `item-${index}.txt`);
      host.complete(owner, { packageId: plan.packageId, index });
    }
    assert.equal((await host.finish(owner, { packageId: plan.packageId })).count, 64);
    const expected = items.slice(0, 64).map(item => `${item.id}.txt`);
    assert.deepEqual(mode === 'zip' ? archived : saved, expected, 'every selected output reaches its destination in order');
    if (mode === 'zip') assert.deepEqual(saved, ['Test.zip']);
  });
});

test('format queue state is bound to the top-frame document and cannot be changed from another tab', async () => {
  const host = new PackageHost({});
  await host.begin(owner, plan);
  for (const foreign of [{ ...owner, tabId: 8 }, { ...owner, frameId: 1 }, { ...owner, documentId: 'reloaded' }]) {
    await assert.rejects(async () => host.next(foreign, { packageId: 'package7', index: 0 }), /принадлежит/);
  }
  assert.deepEqual(host.next(owner, { packageId: 'package7', index: 0 }), { ok: true });
});

test('failed preparation and disk quota never advance the queue or publish a partial archive', async () => {
  let archives = 0, prepares = 0;
  const host = new PackageHost({ maxBytes: 65540, names: names => names,
    async prepare() { prepares++; throw new Error('QuotaExceededError'); }, async archive() { archives++; },
  });
  await host.begin(owner, plan);
  host.next(owner, { packageId: plan.packageId, index: 0 });
  await assert.rejects(() => host.output(owner, plan.packageId, new Blob(['large']), 'video.mp4'), /лимит/);
  await assert.rejects(() => host.output(owner, plan.packageId, new Blob(['fits']), 'video.mp4'), /QuotaExceeded/);
  assert.throws(() => host.complete(owner, { packageId: plan.packageId, index: 0 }), /не завершён/);
  assert.throws(() => host.next(owner, { packageId: plan.packageId, index: 1 }), /порядок/);
  await assert.rejects(() => host.finish(owner, { packageId: plan.packageId }), /не завершён/);
  assert.equal(prepares, 1); assert.equal(archives, 0);
});

test('cancel during preparation retains the ready prefix, aborts current work and forbids later output', async () => {
  const prepared = [], discarded = [], saved = [];
  let aborted = 0;
  const host = new PackageHost({ names: names => names,
    async prepare(blob, filename) { prepared.push(filename); return { blob, filename }; },
    async save() { saved.push('saved'); }, async discard(entries) { discarded.push(entries); },
    async cancelWork() { aborted++; },
  });
  await host.begin(owner, plan);
  host.next(owner, { packageId: plan.packageId, index: 0 });
  await host.output(owner, plan.packageId, new Blob(['video']), 'video.mp4');
  host.complete(owner, { packageId: plan.packageId, index: 0 });
  await host.cancel(owner, { packageId: plan.packageId });
  await assert.rejects(() => host.output(owner, plan.packageId, new Blob(['audio']), 'audio.mp3'));
  assert.deepEqual(prepared, ['video.mp4']);
  assert.deepEqual(discarded, []);
  assert.deepEqual(saved, []);
  assert.equal(aborted, 1);
  assert.equal((await host.begin(owner, { ...plan, packageId: 'retry' })).ok, true);
});

test('ZIP receives the exact prepared files only after every selected position completes', async () => {
  const archived = [], saved = [];
  const host = new PackageHost({
    names: names => names, async prepare(blob, filename) { return { blob, filename, id: filename }; },
    async archive(entries) { for (const entry of entries) archived.push([entry.filename, await entry.blob.text()]); return new Blob(['zip']); },
    async save(blob, name) { saved.push([await blob.text(), name]); }, async discard() {},
  });
  await host.begin(owner, plan);
  host.next(owner, { packageId: plan.packageId, index: 0 });
  await host.output(owner, plan.packageId, new Blob(['exact video']), 'video.mp4');
  host.complete(owner, { packageId: plan.packageId, index: 0 });
  await assert.rejects(() => host.finish(owner, { packageId: plan.packageId }), /не завершён/);
  assert.deepEqual(saved, []);
  host.next(owner, { packageId: plan.packageId, index: 1 });
  await host.output(owner, plan.packageId, new Blob(['exact audio']), 'audio.mp3');
  host.complete(owner, { packageId: plan.packageId, index: 1 });
  assert.equal((await host.finish(owner, { packageId: plan.packageId })).ok, true);
  assert.deepEqual(archived, [['video.mp4', 'exact video'], ['audio.mp3', 'exact audio']]);
  assert.deepEqual(saved, [['zip', 'Test.zip']]);
});

test('cancel during ZIP saving retains prepared inputs and blocks a new package until saving settles', async () => {
  let releaseSave, startedSave, discarded = false;
  const saving = new Promise(resolve => { startedSave = resolve; });
  const saveResult = new Promise(resolve => { releaseSave = resolve; });
  const host = new PackageHost({ names: names => names,
    async prepare(blob, filename) { return { blob, filename }; },
    async archive() { return new Blob(['zip']); },
    async save() { startedSave(); return saveResult; },
    async discard() { discarded = true; }, async cancelWork() {},
  });
  await host.begin(owner, plan);
  for (let index = 0; index < 2; index++) {
    host.next(owner, { packageId: plan.packageId, index });
    await host.output(owner, plan.packageId, new Blob(['prepared']), `item${index}.txt`);
    host.complete(owner, { packageId: plan.packageId, index });
  }
  const finishing = host.finish(owner, { packageId: plan.packageId });
  await saving;
  await host.cancel(owner, { packageId: plan.packageId });
  await assert.rejects(() => host.begin(owner, { ...plan, packageId: 'next-package' }), /выполняется/);
  releaseSave(42);
  await assert.rejects(() => finishing, /отменён/);
  assert.equal(discarded, false, 'cancellation cannot discard the recoverable inputs');
  assert.equal((await host.begin(owner, { ...plan, packageId: 'next-package' })).ok, true);
});

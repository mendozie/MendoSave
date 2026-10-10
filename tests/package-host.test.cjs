const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PackageHost } = require('../extension/package_host.js');
const owner = { tabId: 7, frameId: 0, documentId: 'doc7' };
const plan = { packageId: 'package7', mode: 'zip', title: 'Test', items: [{ id: 'mp4', label: '720p MP4' }, { id: 'mp3', label: 'MP3' }] };

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

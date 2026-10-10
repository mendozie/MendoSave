const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createArchive, verifyArchive } = require('../scripts/release.cjs');
const { execFileSync } = require('node:child_process');

test('release archive bytes agree across builder timezones', () => {
  const program = "require('./scripts/release.cjs').createArchive([{path:'a',bytes:Buffer.from('x')}]).then(b=>process.stdout.write(require('node:crypto').createHash('sha256').update(b).digest('hex')))";
  const result = (TZ) => execFileSync(process.execPath, ['-e', program], {
    cwd: require('node:path').resolve(__dirname, '..'), env: { ...process.env, TZ }, encoding: 'utf8',
  });
  assert.equal(result('UTC'), result('Europe/Moscow'));
});

test('release archive preserves exact bytes and is reproducible independent of input order', async () => {
  const files = [{ path: 'manifest.json', bytes: Buffer.from('{"version":"0.3.0"}') },
    { path: 'icons/🎬.png', bytes: Buffer.from([0, 255, 1, 2]) }];
  const archive = await createArchive(files);
  assert.deepEqual(await createArchive([...files].reverse()), archive);
  await verifyArchive(archive, files);
  await assert.rejects(verifyArchive(archive, [{ ...files[0], bytes: Buffer.from('tampered') }, files[1]]), /bytes/);
  await assert.rejects(verifyArchive(archive, files.slice(0, 1)), /inventory/);
});

test('release archives reject traversal, duplicate names and private payload paths', async () => {
  for (const path of ['../secret', '/secret', 'C:/secret', '.local/profile.json', 'node_modules/module.js', 'a\\b']) {
    await assert.rejects(createArchive([{ path, bytes: Buffer.from('x') }]), /path/);
  }
  await assert.rejects(createArchive([{ path: 'a', bytes: Buffer.from('1') }, { path: 'a', bytes: Buffer.from('2') }]), /duplicate/);
});

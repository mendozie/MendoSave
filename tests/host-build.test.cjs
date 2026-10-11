const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkBuild } = require('../scripts/check-build.cjs');

for (const target of ['firefox', 'chromium']) test(`${target} build binds its exact bundled backend and rejects extra hiding privilege`, () => {
  const area = path.resolve('.local/qa/next031/host-build'); fs.mkdirSync(area, { recursive: true });
  const root = fs.mkdtempSync(path.join(area, `${target}-`)); const output = path.join(root, 'dist', target);
  fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(path.join(root, 'extension')); fs.mkdirSync(path.join(root, 'browser-hosts'));
  const backend = fs.readFileSync(`browser-hosts/${target}.js`, 'utf8'); fs.writeFileSync(path.join(root, 'browser-hosts', `${target}.js`), backend);
  const manifest = { manifest_version: 3, name: 'MendoSave', version: '0.3.1', permissions: ['downloads', 'storage'],
    background: target === 'firefox' ? { scripts: ['browser-host.js', 'platform.js', 'background.js'] } : { service_worker: 'background.js' },
    ...(target === 'firefox' ? { browser_specific_settings: { gecko: { id: 'mendosave@mendozie' } } } : {}),
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'" } };
  const entries = { 'manifest.json': JSON.stringify(manifest), 'browser-host.js': backend,
    'platform.js': 'globalThis.host = true;', 'background.js': 'globalThis.ready = true;', LICENSE: 'license', 'THIRD_PARTY_NOTICES.md': 'notice' };
  for (const name of ['platform.js', 'background.js']) fs.writeFileSync(path.join(root, 'extension', name), entries[name]);
  function save() {
    for (const [name, value] of Object.entries(entries)) fs.writeFileSync(path.join(output, name), value);
    fs.writeFileSync(path.join(root, 'dist', `${target}-hashes.json`), JSON.stringify(Object.entries(entries).map(([name, value]) =>
      ({ path: name, sha256: crypto.createHash('sha256').update(value).digest('hex') }))));
  }
  save(); assert.deepEqual(checkBuild(root, target, '0.3.1'), []);
  entries['browser-host.js'] = 'globalThis.wrongBackend = true;'; save();
  assert.ok(checkBuild(root, target, '0.3.1').some(error => error.includes('stale or missing')));
  entries['browser-host.js'] = backend; manifest.permissions.push('tabHide'); entries['manifest.json'] = JSON.stringify(manifest); save();
  assert.ok(checkBuild(root, target, '0.3.1').includes('unapproved external integration'));
  if (target === 'firefox') {
    manifest.permissions.pop(); manifest.background.scripts.reverse(); entries['manifest.json'] = JSON.stringify(manifest); save();
    assert.ok(checkBuild(root, target, '0.3.1').includes('Firefox backend script order mismatch'));
  }
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { checkVendor, checkLock, checkAudit, checkRuntimePins } = require('../scripts/check-dependencies.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mendosave-deps-'));
  for (const name of ['ffmpeg', 'mediabunny', 'zipjs']) {
    const dir = path.join(root, 'extension/vendor', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'LICENSE'), 'abc');
    fs.writeFileSync(path.join(dir, 'PROVENANCE.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT',
      files: [{ path: 'LICENSE', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }] }));
  }
  return root;
}

test('vendor bytes are checked against a recorded hash, including license bytes', () => {
  const root = fixture();
  assert.deepEqual(checkVendor(root), []);
  fs.writeFileSync(path.join(root, 'extension/vendor/mediabunny/LICENSE'), 'abd');
  assert.ok(checkVendor(root).some(error => error.includes('hash mismatch')));
});

test('tooling lockfile rejects floating direct versions and mismatched resolutions', () => {
  const root = fixture();
  const manifest = { devDependencies: { tool: '1.2.3' } };
  const lock = { lockfileVersion: 3, packages: { '': { devDependencies: manifest.devDependencies },
    'node_modules/tool': { version: '1.2.3', resolved: 'https://registry.npmjs.org/tool/-/tool-1.2.3.tgz', integrity: 'sha512-YWJj' } } };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  assert.deepEqual(checkLock(root), []);
  manifest.devDependencies.tool = '^1.2.3';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  assert.ok(checkLock(root).some(error => error.includes('exact version')));
  manifest.devDependencies.tool = '1.2.3';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  lock.packages['node_modules/tool'].version = '1.2.4';
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  assert.ok(checkLock(root).some(error => error.includes('resolution mismatch')));
});

function auditedTooling() {
  const fixAvailable = { name: 'web-ext', version: '5.1.0', isSemVerMajor: true };
  const vulnerabilities = {
    'node-forge': { name: 'node-forge', severity: 'high', nodes: ['node_modules/node-forge'], effects: ['@devicefarmer/adbkit'], fixAvailable,
      via: [{ name: 'node-forge', dependency: 'node-forge', range: '<=1.4.0', url: 'https://github.com/advisories/GHSA-86w9-cpqp-85rv' }] },
    '@devicefarmer/adbkit': { name: '@devicefarmer/adbkit', severity: 'high', nodes: ['node_modules/@devicefarmer/adbkit'], effects: ['web-ext'], via: ['node-forge'], fixAvailable },
    'web-ext': { name: 'web-ext', severity: 'high', nodes: ['node_modules/web-ext'], effects: [], via: ['@devicefarmer/adbkit'], fixAvailable },
  };
  return { report: { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { total: 3, high: 3 } } },
    lock: { packages: { 'node_modules/node-forge': { version: '1.4.0' }, 'node_modules/@devicefarmer/adbkit': { version: '3.3.9' }, 'node_modules/web-ext': { version: '10.7.0' } } } };
}

test('audit exception permits only the reviewed tooling path and rejects a new advisory or available compatible fix', () => {
  const { report, lock } = auditedTooling();
  assert.deepEqual(checkAudit(report, lock, true), []);
  assert.ok(checkAudit(report, lock, false).length, 'runtime audit has no exceptions');
  report.vulnerabilities['node-forge'].via.push({ name: 'node-forge', url: 'https://github.com/advisories/GHSA-new' });
  assert.ok(checkAudit(report, lock, true).length, 'new advisories must fail');
  report.vulnerabilities['node-forge'].via.pop();
  report.vulnerabilities['node-forge'].fixAvailable = { name: 'node-forge', version: '1.4.1', isSemVerMajor: false };
  assert.ok(checkAudit(report, lock, true).length, 'a newly compatible fix ends the exception');
});

test('vendor inventory rejects hidden additions, traversal records and missing license records', () => {
  const root = fixture();
  const dir = path.join(root, 'extension/vendor/zipjs');
  fs.writeFileSync(path.join(dir, 'extra.js'), 'abc');
  assert.ok(checkVendor(root).some(error => error.includes('unrecorded vendor file')));
  const file = path.join(dir, 'PROVENANCE.json');
  const provenance = JSON.parse(fs.readFileSync(file, 'utf8'));
  provenance.files[0].path = '../LICENSE';
  fs.writeFileSync(file, JSON.stringify(provenance));
  const errors = checkVendor(root);
  assert.ok(errors.some(error => error.includes('invalid or duplicate')));
  assert.ok(errors.some(error => error.includes('no recorded license')));
});

test('audit gate rejects invalid reports and broadened exception paths or versions', () => {
  assert.ok(checkAudit({ error: { code: 'ENOAUDIT' } }).length);
  const { report, lock } = auditedTooling();
  report.vulnerabilities['node-forge'].nodes.push('node_modules/other/node_modules/node-forge');
  assert.ok(checkAudit(report, lock, true).length);
  report.vulnerabilities['node-forge'].nodes.pop();
  lock.packages['node_modules/node-forge'].version = '1.3.0';
  assert.ok(checkAudit(report, lock, true).length);
  assert.deepEqual(checkAudit({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }, {}, false), []);
});

test('runtime advisory manifest must describe the versions actually recorded in vendor provenance', () => {
  const root = fixture();
  for (const name of ['ffmpeg', 'mediabunny', 'zipjs']) {
    const file = path.join(root, 'extension/vendor', name, 'PROVENANCE.json');
    const provenance = JSON.parse(fs.readFileSync(file));
    provenance.packages = [{ name, version: '1.0.0' }];
    fs.writeFileSync(file, JSON.stringify(provenance));
  }
  const dir = path.join(root, 'scripts/runtime-audit');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { ffmpeg: '1.0.0', mediabunny: '1.0.0', zipjs: '1.0.0' } }));
  assert.deepEqual(checkRuntimePins(root), []);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { ffmpeg: '1.0.0', mediabunny: '1.0.1', zipjs: '1.0.0' } }));
  assert.ok(checkRuntimePins(root).length, 'auditing a newer version cannot hide an older shipped version');
});

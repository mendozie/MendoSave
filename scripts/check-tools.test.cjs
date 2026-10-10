const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkBuild } = require('./check-build.cjs');
const { inspectText } = require('./check-outgoing.cjs');
const { createRequire } = require('node:module');
const fixtureArea = path.resolve(__dirname, '../.local/qa/phase2/checks/fixtures');
fs.mkdirSync(fixtureArea, { recursive: true });

test('build check rejects missing references, changed bytes, and unexpected files', () => {
  const root = fs.mkdtempSync(path.join(fixtureArea, 'build-'));
    const output = path.join(root, 'dist', 'firefox');
    fs.mkdirSync(output, { recursive: true });
    const manifest = { manifest_version: 3, name: 'MendoSave', version: '0.2.0',
      permissions: ['downloads'], background: { scripts: ['background.js'] },
      content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'" },
      browser_specific_settings: { gecko: { id: 'mendosave@mendozie' } } };
    const entries = { 'manifest.json': JSON.stringify(manifest), 'background.js': 'globalThis.ready = true;', LICENSE: 'license', 'THIRD_PARTY_NOTICES.md': 'notice' };
    for (const [name, text] of Object.entries(entries)) fs.writeFileSync(path.join(output, name), text);
    const hashes = Object.entries(entries).map(([name, text]) => ({ path: name, sha256: crypto.createHash('sha256').update(text).digest('hex') }));
    fs.writeFileSync(path.join(root, 'dist', 'firefox-hashes.json'), JSON.stringify(hashes));
    assert.deepEqual(checkBuild(root, 'firefox', '0.2.0'), []);
    fs.writeFileSync(path.join(output, 'background.js'), 'changed');
    assert.ok(checkBuild(root, 'firefox', '0.2.0').some((error) => error.includes('hash mismatch')));
    fs.mkdirSync(path.join(root, 'extension'));
    fs.writeFileSync(path.join(root, 'extension', 'background.js'), entries['background.js']);
    hashes.find((entry) => entry.path === 'background.js').sha256 = crypto.createHash('sha256').update('changed').digest('hex');
    fs.writeFileSync(path.join(root, 'dist', 'firefox-hashes.json'), JSON.stringify(hashes));
    assert.ok(checkBuild(root, 'firefox', '0.2.0').some((error) => error.includes('stale build differs from source')));
    manifest.background.scripts = ['missing.js'];
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest));
    assert.ok(checkBuild(root, 'firefox', '0.2.0').some((error) => error.includes('missing reference')));
    fs.writeFileSync(path.join(output, 'profile.json'), '{}');
    assert.ok(checkBuild(root, 'firefox', '0.2.0').some((error) => error.includes('unexpected file')));
});

test('build check rejects remote entrypoints, unsafe CSP and traversal', () => {
  const root = fs.mkdtempSync(path.join(fixtureArea, 'invalid-'));
    const output = path.join(root, 'dist', 'chromium');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'MendoSave', version: '0.2.0',
      background: { service_worker: '../escape.js' }, action: { default_popup: 'https://example.test/popup.html' },
      content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval' https://example.test" } }));
    fs.writeFileSync(path.join(root, 'dist', 'chromium-hashes.json'), '[]');
    const errors = checkBuild(root, 'chromium', '0.2.0');
    assert.ok(errors.some((error) => error.includes('non-local reference')));
    assert.ok(errors.some((error) => error.includes('CSP')));
});

test('build check accepts the permanent Firefox identity and rejects development or foreign identities', () => {
  const root = fs.mkdtempSync(path.join(fixtureArea, 'identity-'));
  const output = path.join(root, 'dist', 'firefox');
  fs.mkdirSync(output, { recursive: true });
  for (const id of ['mendosave@mendozie', 'mendosave-dev@mendozie.local', 'foreign@example.test']) {
    const manifest = { manifest_version: 3, name: 'MendoSave', version: '0.3.0',
      permissions: ['downloads'], background: { scripts: ['background.js'] },
      content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'" },
      browser_specific_settings: { gecko: { id } } };
    const entries = { 'manifest.json': JSON.stringify(manifest), 'background.js': 'globalThis.ready = true;',
      LICENSE: 'license', 'THIRD_PARTY_NOTICES.md': 'notice' };
    for (const [name, text] of Object.entries(entries)) fs.writeFileSync(path.join(output, name), text);
    fs.writeFileSync(path.join(root, 'dist', 'firefox-hashes.json'), JSON.stringify(Object.entries(entries)
      .map(([name, text]) => ({ path: name, sha256: crypto.createHash('sha256').update(text).digest('hex') }))));
    const errors = checkBuild(root, 'firefox', '0.3.0');
    if (id === 'mendosave@mendozie') assert.deepEqual(errors, []);
    else assert.ok(errors.includes('Firefox add-on identity mismatch'), `Accepted ${id}`);
  }
});

test('build check rejects duplicate CSP directives instead of accepting the final safe value', () => {
  const root = fs.mkdtempSync(path.join(fixtureArea, 'csp-'));
  const output = path.join(root, 'dist', 'chromium');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'MendoSave', version: '0.2.0',
    background: { service_worker: 'background.js' }, content_security_policy: { extension_pages:
      "script-src https://example.test; script-src 'self'; object-src 'self'; worker-src 'self'" } }));
  fs.writeFileSync(path.join(root, 'dist', 'chromium-hashes.json'), '[]');
  assert.ok(checkBuild(root, 'chromium', '0.2.0').some((error) => error.includes('duplicate CSP directive')));
});

test('outgoing check detects private paths and tokens without printing values', () => {
  const privatePath = ['C:', 'Users', 'example', 'profile'].join('\\');
  const token = 'gh' + 'p_' + 'a'.repeat(36);
  const signedUrl = 'https://example.test/media?' + ['X-Amz', 'Signature'].join('-') + '=abc';
  const findings = inspectText(`${privatePath}\n${token}\n${signedUrl}`);
  assert.deepEqual(findings.map(({ kind }) => kind), ['private-path', 'token', 'signed-url']);
  assert.ok(!JSON.stringify(findings).includes(token));
  assert.equal(inspectText(privatePath.replaceAll('\\', '\\\\'))[0].kind, 'private-path');
  assert.deepEqual(inspectText('docs/guide.md\nhttps://www.youtube.com/watch?v=fixture\nprocess.env.TOKEN'), []);
});

test('fx-runner shell-quote rejects comment newline injection and parses a quoted browser command', () => {
  const runnerRequire = createRequire(require.resolve('fx-runner/package.json'));
  const quote = runnerRequire('shell-quote');
  assert.throws(() => quote.quote([{ comment: 'fixture' }, 'line\nnext']), TypeError);
  assert.deepEqual(quote.parse('"browser path/firefox.exe" -profile "profile path" -no-remote'),
    ['browser path/firefox.exe', '-profile', 'profile path', '-no-remote']);
});

test('ESLint catches missing bindings and excludes vendor while keeping unused values visible', async () => {
  const { ESLint } = require('eslint');
  const lint = new ESLint({ cwd: path.resolve(__dirname, '..') });
  const [result] = await lint.lintText('missingBinding(); const unused = 1;', { filePath: 'extension/platform.js' });
  assert.ok(result.messages.some(({ ruleId, severity }) => ruleId === 'no-undef' && severity === 2));
  assert.ok(result.messages.some(({ ruleId, severity }) => ruleId === 'no-unused-vars' && severity === 1));
  assert.equal(await lint.isPathIgnored('extension/vendor/ffmpeg/ffmpeg.js'), true);
});

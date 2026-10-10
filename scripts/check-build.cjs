const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function checkBuild(root, target, version) {
  const output = path.resolve(root, 'dist', target);
  const errors = [];
  const files = new Map();
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const name = path.relative(output, file).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) { errors.push(`${name}: symlink in build`); continue; }
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile()) files.set(name, fs.readFileSync(file));
      else errors.push(`${name}: non-regular file`);
    }
  }
  if (!fs.existsSync(output) || fs.lstatSync(output).isSymbolicLink()) return ['missing or linked build directory'];
  if (!fs.realpathSync(output).startsWith(fs.realpathSync(root) + path.sep)) return ['build directory outside repository'];
  collect(output);
  let manifest;
  let hashes;
  try {
    manifest = JSON.parse(files.get('manifest.json')?.toString('utf8'));
    hashes = JSON.parse(fs.readFileSync(path.join(root, 'dist', `${target}-hashes.json`), 'utf8'));
    if (!Array.isArray(hashes)) throw new Error('hash inventory is not an array');
  } catch { return [...errors, 'invalid manifest or hash inventory']; }
  const expected = new Set();
  for (const entry of hashes) {
    if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || expected.has(entry.path)) {
      errors.push('invalid or duplicated hash entry'); continue;
    }
    expected.add(entry.path);
    const bytes = files.get(entry.path);
    if (!bytes) errors.push(`${entry.path}: missing hashed file`);
    else if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) errors.push(`${entry.path}: hash mismatch`);
  }
  for (const name of files.keys()) if (!expected.has(name)) errors.push(`${name}: unexpected file`);
  const source = path.join(root, 'extension');
  if (fs.existsSync(source)) {
    function compare(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        const name = path.relative(source, file).replaceAll('\\', '/');
        if (entry.isSymbolicLink()) { errors.push(`${name}: symlink in source`); continue; }
        if (entry.isDirectory()) compare(file);
        else if (entry.isFile() && name !== 'manifest.json' && !/^musify\.(?:js|css)$/.test(name)) {
          if (!files.has(name)) errors.push(`${name}: source file missing from build`);
          else if (!files.get(name).equals(fs.readFileSync(file))) errors.push(`${name}: stale build differs from source`);
        }
      }
    }
    compare(source);
    if (target === 'chromium') {
      const backend = path.join(root, 'browser-hosts', 'chromium.js');
      if (!files.get('browser-host.js')?.equals(fs.readFileSync(backend))) errors.push('browser-host.js: stale or missing Chromium backend');
    }
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) if (!files.has(name)) errors.push(`${name}: missing license`);
  if (manifest.manifest_version !== 3 || manifest.name !== 'MendoSave' || manifest.version !== version) errors.push('manifest identity/version mismatch');
  if (manifest.update_url || manifest.externally_connectable || (manifest.permissions || []).includes('nativeMessaging')) errors.push('unapproved external integration');
  if ((manifest.host_permissions || []).some((host) => /github\.com|githubusercontent\.com/.test(host))) errors.push('upstream update host permission');
  if (target === 'firefox') {
    if (manifest.background?.service_worker || !manifest.background?.scripts?.length || !manifest.browser_specific_settings?.gecko?.id || (manifest.permissions || []).includes('offscreen')) errors.push('Firefox host contract mismatch');
  } else if (target === 'chromium' && (!manifest.background?.service_worker || manifest.background?.scripts)) errors.push('Chromium host contract mismatch');
  const csp = manifest.content_security_policy?.extension_pages || '';
  const directives = new Map();
  for (const part of csp.split(';').filter((part) => part.trim())) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (directives.has(name)) errors.push(`${name}: duplicate CSP directive`);
    else directives.set(name, values);
  }
  for (const [directive, allowed] of [['script-src', ["'self'", "'wasm-unsafe-eval'"]], ['object-src', ["'self'", "'none'"]], ['worker-src', ["'self'"]]]) {
    const values = directives.get(directive);
    if (!values?.length || !values.every((value) => allowed.includes(value))) errors.push(`${directive}: unsafe or missing CSP`);
  }
  function reference(name, owner = 'manifest.json') {
    if (typeof name !== 'string' || !name || /[\\?#]/.test(name) || name.startsWith('/') || /(^|\/)\.\.?($|\/)/.test(name) || /^[a-z][a-z\d+.-]*:/i.test(name)) {
      errors.push(`${owner}: non-local reference`); return;
    }
    const resolved = path.posix.join(path.posix.dirname(owner), name);
    if (!files.has(resolved)) errors.push(`${owner}: missing reference ${name}`);
  }
  for (const name of [...(manifest.background?.scripts || []), manifest.background?.service_worker, manifest.action?.default_popup,
    ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {})].filter(Boolean)) reference(name);
  for (const script of manifest.content_scripts || []) for (const name of [...(script.js || []), ...(script.css || [])]) reference(name);
  for (const [name, bytes] of files) if (name.endsWith('.html')) {
    const text = bytes.toString('utf8');
    for (const match of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) reference(match[1], name);
  }
  for (const name of files.keys()) if (/(^|\/)(?:node_modules|\.local|\.git|profiles?)(\/|$)|^musify\.(?:js|css)$|\.(?:map|env|xpi|zip)$/.test(name)) errors.push(`${name}: development/private artifact`);
  return errors;
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const { version } = require('../package.json');
  for (const target of ['firefox', 'chromium']) {
    const errors = checkBuild(root, target, version);
    if (errors.length) { for (const error of errors) console.error(`${target}: ${error}`); process.exitCode = 1; }
    else console.log(`${target}: manifest, references, CSP, inventory hashes and build hygiene passed`);
  }
}
module.exports = { checkBuild };

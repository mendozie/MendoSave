const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

function checkVendor(root) {
  const errors = [];
  const vendor = path.join(root, 'extension/vendor');
  for (const name of ['ffmpeg', 'mediabunny', 'zipjs']) {
    const dir = path.join(vendor, name);
    let provenance;
    try {
      const file = path.join(dir, 'PROVENANCE.json');
      if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()
        || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('linked provenance');
      provenance = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch { errors.push(`${name}: missing or invalid provenance`); continue; }
    if (!provenance.name || !provenance.version || !provenance.license || !Array.isArray(provenance.files)) {
      errors.push(`${name}: incomplete provenance`); continue;
    }
    const expected = new Set(['PROVENANCE.json']);
    for (const entry of provenance.files) {
      if (!entry || typeof entry.path !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(entry.path)
        || entry.path === '.' || entry.path === '..' || expected.has(entry.path)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        errors.push(`${name}: invalid or duplicate file entry`); continue;
      }
      expected.add(entry.path);
      const file = path.join(dir, entry.path);
      try {
        if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('not a regular file');
        const bytes = fs.readFileSync(file);
        if (bytes.length !== entry.bytes) errors.push(`${name}/${entry.path}: size mismatch`);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) errors.push(`${name}/${entry.path}: hash mismatch`);
      } catch { errors.push(`${name}/${entry.path}: missing or non-regular file`); }
    }
    if (![...expected].some(file => /^(?:LICENSE(?:\.|$)|COPYING)/.test(file))) errors.push(`${name}: no recorded license`);
    for (const entry of fs.readdirSync(dir)) if (!expected.has(entry)) errors.push(`${name}/${entry}: unrecorded vendor file`);
  }
  if (fs.existsSync(vendor)) for (const name of fs.readdirSync(vendor)) {
    if (!['ffmpeg', 'mediabunny', 'zipjs'].includes(name)) errors.push(`${name}: unreviewed vendor component`);
  }
  return errors;
}
function checkLock(root) {
  const errors = [];
  let manifest, lock;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    if (lock.lockfileVersion !== 3 || !lock.packages?.['']) throw new Error('unsupported lock');
  } catch { return ['missing or invalid dependency manifest/lockfile']; }
  for (const kind of ['dependencies', 'devDependencies']) {
    const direct = manifest[kind] || {};
    if (JSON.stringify(Object.entries(direct).sort()) !== JSON.stringify(Object.entries(lock.packages[''][kind] || {}).sort())) errors.push(`${kind}: lockfile manifest mismatch`);
    for (const [name, version] of Object.entries(direct)) {
      if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) errors.push(`${name}: direct dependency requires exact version`);
      if (lock.packages[`node_modules/${name}`]?.version !== version) errors.push(`${name}: resolution mismatch`);
    }
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (entry.link || !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved || '') || !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity || '')) errors.push(`${name}: unreviewed source or missing integrity`);
  }
  if (manifest.overrides?.['fx-runner']?.['shell-quote'] !== undefined) {
    if (manifest.overrides['fx-runner']['shell-quote'] !== '1.11.0') errors.push('shell-quote: reviewed override changed');
    for (const [name, entry] of Object.entries(lock.packages)) if (/(^|\/)node_modules\/shell-quote$/.test(name) && entry.version !== '1.11.0') errors.push(`${name}: unsafe shell-quote resolution`);
  }
  return errors;
}
function checkAudit(report, lock, allowTooling = false) {
  if (!report || report.error || report.auditReportVersion !== 2 || !report.vulnerabilities
    || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)
    || report.metadata?.vulnerabilities?.total !== Object.keys(report.vulnerabilities).length) return ['invalid or incomplete npm audit report'];
  const errors = [];
  const reviewed = {
    'node-forge': { version: '1.4.0', effects: ['@devicefarmer/adbkit'] },
    '@devicefarmer/adbkit': { version: '3.3.9', effects: ['web-ext'], via: ['node-forge'] },
    'web-ext': { version: '10.7.0', effects: [], via: ['@devicefarmer/adbkit'] },
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [name, finding] of Object.entries(report.vulnerabilities)) {
    const policy = reviewed[name];
    const node = `node_modules/${name}`;
    const fix = finding.fixAvailable;
    const via = name === 'node-forge'
      ? finding.via?.length === 1 && finding.via[0]?.name === 'node-forge' && finding.via[0]?.dependency === 'node-forge'
        && finding.via[0]?.range === '<=1.4.0' && finding.via[0]?.url === 'https://github.com/advisories/GHSA-86w9-cpqp-85rv'
      : same(finding.via, policy?.via);
    if (!allowTooling || !policy || finding.name !== name || finding.severity !== 'high'
      || !same(finding.nodes, [node]) || !same(finding.effects, policy.effects) || !via
      || lock?.packages?.[node]?.version !== policy.version
      || fix?.name !== 'web-ext' || fix?.version !== '5.1.0' || fix?.isSemVerMajor !== true) {
      errors.push(`${name}: unreviewed vulnerability, path, version or fix`);
    }
  }
  return errors;
}

function audit(root, allowTooling) {
  const { spawnSync } = require('node:child_process');
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  // Invoke npm's JS entry point directly; no shell interpolation or lifecycle scripts.
  if (!fs.existsSync(npmCli)) return ['npm CLI unavailable; run through npm run audit:dependencies'];
  const result = spawnSync(process.execPath, [npmCli, 'audit', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || ![0, 1].includes(result.status)) return ['npm audit failed to produce a supported report'];
  try {
    const report = JSON.parse(result.stdout);
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const errors = checkAudit(report, lock, allowTooling);
    console.log(`${allowTooling ? 'tooling' : 'runtime'} audit: ${Object.keys(report.vulnerabilities || {}).length} entries${allowTooling ? '; only the reviewed node-forge chain may be excepted' : '; no exceptions'}`);
    return errors;
  } catch { return ['npm audit failed to produce valid JSON']; }
}

function checkRuntimePins(root) {
  try {
    const expected = {};
    for (const name of ['ffmpeg', 'mediabunny', 'zipjs']) {
      const provenance = JSON.parse(fs.readFileSync(path.join(root, 'extension/vendor', name, 'PROVENANCE.json'), 'utf8'));
      if (!Array.isArray(provenance.packages) || !provenance.packages.length) throw new Error('missing package pins');
      for (const pin of provenance.packages) {
        if (typeof pin.name !== 'string' || typeof pin.version !== 'string' || Object.hasOwn(expected, pin.name)) throw new Error('invalid package pin');
        expected[pin.name] = pin.version;
      }
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts/runtime-audit/package.json'), 'utf8'));
    if (JSON.stringify(Object.entries(expected).sort()) !== JSON.stringify(Object.entries(manifest.dependencies || {}).sort())) return ['runtime audit versions differ from vendor provenance'];
    return [];
  } catch { return ['missing or invalid runtime audit package pins']; }
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const runtime = path.join(root, 'scripts/runtime-audit');
  const errors = [...checkVendor(root), ...checkLock(root), ...checkLock(runtime), ...checkRuntimePins(root)];
  if (process.argv.includes('--audit')) errors.push(...audit(root, true), ...audit(runtime, false));
  for (const arg of process.argv.slice(2)) if (arg !== '--audit') errors.push('unsupported check-dependencies argument');
  for (const error of errors) console.error(error);
  if (!errors.length) console.log('Dependency provenance, license hashes and exact lockfiles passed');
  process.exitCode = errors.length ? 1 : 0;
}
module.exports = { checkVendor, checkLock, checkAudit, checkRuntimePins };

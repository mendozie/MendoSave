const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const zip = require('../extension/vendor/zipjs/zip-native.min.js');
const { checkBuild } = require('./check-build.cjs');
const { scan } = require('./check-outgoing.cjs');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function validateFiles(files) {
  const seen = new Set();
  for (const file of files) {
    if (typeof file.path !== 'string' || !file.path || /[\\:]/.test(file.path)
      || Array.from(file.path).some((character) => character.charCodeAt(0) < 32)
      || file.path.startsWith('/') || file.path.split('/').some((part) => !part || part === '.' || part === '..')
      || /^(?:\.local|\.git|node_modules|dist|artifacts|web-ext-artifacts)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/.test(file.path)) {
      throw new Error('Unsafe archive path');
    }
    if (seen.has(file.path)) throw new Error('Archive contains duplicate path');
    seen.add(file.path);
    if (!Buffer.isBuffer(file.bytes)) throw new Error('Archive input must be bytes');
  }
}

async function createArchive(files) {
  validateFiles(files);
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { level: 0, useWebWorkers: false });
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    await writer.add(file.path, new zip.Uint8ArrayReader(file.bytes), {
      lastModDate: new Date(2000, 0, 1, 0, 0, 0), extendedTimestamp: false,
      msDosCompatible: true, extraField: new Map(),
    });
  }
  return Buffer.from(await writer.close());
}

async function verifyArchive(bytes, files) {
  validateFiles(files);
  const reader = new zip.ZipReader(new zip.Uint8ArrayReader(bytes), { useWebWorkers: false });
  try {
    const entries = await reader.getEntries();
    const expected = new Map(files.map((file) => [file.path, file.bytes]));
    if (entries.length !== expected.size) throw new Error('Archive inventory mismatch');
    for (const entry of entries) {
      if (!expected.has(entry.filename) || entry.directory) throw new Error('Archive inventory mismatch');
      const actual = Buffer.from(await entry.getData(new zip.Uint8ArrayWriter(), { checkSignature: true }));
      if (!actual.equals(expected.get(entry.filename))) throw new Error('Archive bytes mismatch');
      expected.delete(entry.filename);
    }
  } finally { await reader.close(); }
}

async function release(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 });
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid package version');
  for (const target of ['firefox', 'chromium']) {
    const errors = checkBuild(root, target, version);
    if (errors.length) throw new Error(`${target}: ${errors.join('; ')}`);
  }
  const outgoing = scan(root);
  if (outgoing.findings.length) throw new Error('Outgoing scan failed; run check:outgoing for locations');
  const output = path.join(root, 'artifacts', `mendosave-${version}`);
  fs.mkdirSync(output, { recursive: true });
  if (fs.realpathSync(output) !== output) throw new Error('Linked release directory');
  const results = [];
  async function save(name, files) {
    const bytes = await createArchive(files);
    await verifyArchive(bytes, files);
    const file = path.join(output, name);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Linked release file');
    fs.writeFileSync(file, bytes);
    await verifyArchive(fs.readFileSync(file), files);
    results.push({ path: name, bytes: bytes.length, sha256: sha256(bytes),
      files: files.map((entry) => ({ path: entry.path, bytes: entry.bytes.length, sha256: sha256(entry.bytes) })) });
  }
  for (const target of ['firefox', 'chromium']) {
    const inventory = JSON.parse(fs.readFileSync(path.join(root, 'dist', `${target}-hashes.json`), 'utf8'));
    await save(`mendosave-${version}-${target}-unsigned.${target === 'firefox' ? 'xpi' : 'zip'}`,
      inventory.map((entry) => ({ path: entry.path, bytes: fs.readFileSync(path.join(root, 'dist', target, entry.path)) })));
  }
  const sourceFiles = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort();
  await save(`mendosave-${version}-source.zip`, sourceFiles.map((name) => ({ path: name, bytes: fs.readFileSync(path.join(root, name)) })));
  const receipt = { version, revision: git('rev-parse', 'HEAD').trim(),
    dirty: Boolean(git('status', '--porcelain').trim()), signed: false, artifacts: results };
  const manifestBytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'release-manifest.json'), manifestBytes);
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), [...results.map((entry) => `${entry.sha256}  ${entry.path}`),
    `${sha256(manifestBytes)}  release-manifest.json`].join('\n') + '\n');
  console.log(`Prepared ${results.length} unsigned archives; extracted bytes verified. ${path.relative(root, output)}`);
}
if (require.main === module) release(path.resolve(__dirname, '..')).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { createArchive, verifyArchive };

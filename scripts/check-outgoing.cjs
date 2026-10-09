const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const patterns = [
  ['private-path', /(?:[a-z]:[\\/]+(?:Users|Projects|Codex|Documents and Settings)[\\/]+[a-z\d._ -]*|file:\/\/\/(?:[a-z]:\/|Users\/|home\/)[^\s"'<>)]*|\\\\[a-z\d._-]+\\[a-z\d._-]+|\/Users\/[a-z\d._-]+\/|\/home\/[a-z\d._-]+\/)/i],
  ['token', /\b(?:gh[pousr]_[a-z\d]{30,}|github_pat_[a-z\d_]{30,}|sk-(?:proj-)?[a-z\d_-]{30,}|AKIA[A-Z\d]{16})\b/i],
  ['private-key', new RegExp('-----BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----')],
  ['signed-url', /https?:\/\/[^\s"'<>]+[?&](?:X-Amz-Signature|X-Goog-Signature|sig|signature|token|access_token)=[^\s"'<>]+/i],
];

function inspectText(text) {
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) for (const [kind, pattern] of patterns) {
    if (pattern.test(line)) findings.push({ line: index + 1, kind });
  }
  return findings;
}

function scan(root, history) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const findings = [];
  let checked = 0;
  let skippedBinary = 0;
  let reviewedFixtures = 0;
  let upstreamBuildPaths = 0;
  const seen = new Set();
  const excluded = (name) => /^(?:\.local|node_modules|dist|artifacts|web-ext-artifacts|\.git)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/.test(name);
  function inspect(name, bytes, source) {
    if (bytes.includes(0)) { skippedBinary++; return; }
    checked++;
    const text = bytes.toString('utf8');
    const lines = text.split(/\r?\n/);
    for (const finding of inspectText(text)) {
      // Reviewed negative fixtures and preserved upstream build paths are counted,
      // rather than hiding whole tests or vendored files from secret inspection.
      const line = lines[finding.line - 1];
      const upstreamPath = 'file://' + ['', 'home', 'jeromewu', 'ffmpeg.wasm', 'packages', 'ffmpeg', 'dist', 'esm', 'classes.js'].join('/');
      if (finding.kind === 'private-path' && name === 'extension/vendor/ffmpeg/ffmpeg.js'
        && crypto.createHash('sha256').update(bytes).digest('hex') === 'a4c09a1997ac582a735fc21e20f9913df4af6dde4ebb373f1d714a4b6e7616f1'
        && [...line.matchAll(new RegExp(patterns[0][1].source, 'ig'))].every((match) => match[0] === upstreamPath)) { upstreamBuildPaths++; continue; }
      const filesystemFixture = ['file:', '', '/C:/private.txt'].join('/');
      const pathMatches = finding.kind === 'private-path' ? [...line.matchAll(new RegExp(patterns[0][1].source, 'ig'))] : [];
      if (finding.kind === 'private-path' && name === 'tests/background.test.cjs' && pathMatches.every((match) => match[0] === filesystemFixture)) { reviewedFixtures++; continue; }
      const diagnosticsPath = ['C:', 'Users', 'alice'].join('\\\\');
      if (finding.kind === 'private-path' && name === 'tests/diagnostics.test.cjs' && pathMatches.every((match) => match[0] === diagnosticsPath)) { reviewedFixtures++; continue; }
      if (finding.kind === 'signed-url' && /^tests\/diagnostics\.test\.cjs$/.test(name)) {
        const urls = line.match(/https?:\/\/[^\s"'<>]+/g) || [];
        const pageFixture = 'https://www.youtube.com/watch?v=id&' + ['token', 'page-secret'].join('=') + '#page-fragment';
        if (urls.length && urls.every((url) => url === pageFixture || /^(?:[a-z\d-]+\.)*example(?:\.(?:org|com|test))?$/.test(new URL(url).hostname))) { reviewedFixtures++; continue; }
      }
      findings.push(`${source}:${name}:${finding.line}: ${finding.kind}`);
    }
  }
  if (history) {
    const revision = git('rev-parse', '--verify', '--end-of-options', `${history}^{commit}`).trim();
    for (const commit of git('rev-list', revision).trim().split('\n').filter(Boolean)) {
      for (const entry of git('ls-tree', '-rz', '--full-tree', commit).split('\0').filter(Boolean)) {
        const [header, name] = entry.split('\t');
        const [mode, type, object] = header.split(' ');
        if (excluded(name)) { findings.push(`${commit.slice(0, 12)}:${name}: excluded/private file in outgoing set`); continue; }
        if (type !== 'blob' || mode === '120000') { findings.push(`${commit}:${name}: non-regular outgoing file`); continue; }
        const key = `${name}:${object}`;
        if (seen.has(key)) continue;
        seen.add(key);
        inspect(name, execFileSync('git', ['cat-file', 'blob', object], { cwd: root, maxBuffer: 128 * 1024 * 1024 }), commit.slice(0, 12));
      }
    }
  } else {
    for (const name of git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
      if (excluded(name)) { findings.push(`${name}: excluded/private file in outgoing set`); continue; }
      const file = path.resolve(root, name);
      if (!fs.existsSync(file)) continue;
      if (fs.lstatSync(file).isSymbolicLink()) { findings.push(`${name}: symlink in outgoing set`); continue; }
      if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) { findings.push(`${name}: outgoing file outside repository`); continue; }
      inspect(name, fs.readFileSync(file), 'working-tree');
    }
  }
  return { findings, checked, skippedBinary, reviewedFixtures, upstreamBuildPaths };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const historyArg = args.find((arg) => arg.startsWith('--history='));
  if (args.length !== 1 || (args[0] !== '--all' && !historyArg)) throw new Error('Usage: node scripts/check-outgoing.cjs --all | --history=<revision>');
  const result = scan(path.resolve(__dirname, '..'), historyArg?.slice('--history='.length));
  for (const finding of result.findings) console.error(finding);
  console.log(`Outgoing scan: ${result.checked} text blobs checked, ${result.skippedBinary} binary blobs skipped, ${result.findings.length} findings, ${result.reviewedFixtures} reviewed fixture matches, ${result.upstreamBuildPaths} preserved upstream build-path matches; values are never printed`);
  if (result.findings.length) process.exitCode = 1;
}
module.exports = { inspectText, scan };

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { checkBuild } = require('./check-build.cjs');
const reviewed = [
  { code: 'UNSAFE_VAR_ASSIGNMENT', file: 'vendor/ffmpeg/814.ffmpeg.js', line: 1, column: 1124,
    sha256: '6fdceaa2bb9765257a5474fd86f4a90c67995d9b8c63df3a7e92f264cda8be71' },
  { code: 'DANGEROUS_EVAL', file: 'vendor/ffmpeg/ffmpeg.js', line: 1, column: 444,
    sha256: 'a4c09a1997ac582a735fc21e20f9913df4af6dde4ebb373f1d714a4b6e7616f1' },
  { code: 'UNSAFE_VAR_ASSIGNMENT', file: 'vendor/zipjs/zip-native.min.js', line: 1, column: 63468,
    sha256: '312496a273c1782970ae68ccfe10ba9782766bf0a53d789512526aa92f7b62cb' },
];

function assessLint(report) {
  if (!report || !report.summary || !['errors', 'notices', 'warnings'].every((key) => Array.isArray(report[key]))) {
    return ['Invalid web-ext report'];
  }
  const errors = [];
  for (const key of ['errors', 'notices', 'warnings']) if (report.summary[key] !== report[key].length) errors.push('Inconsistent web-ext report');
  if (report.errors.length || report.notices.length) errors.push('web-ext errors or notices');
  const seen = new Set();
  for (const warning of report.warnings) {
    const known = reviewed.find((entry) => ['code', 'file', 'line', 'column'].every((key) => warning[key] === entry[key]));
    if (!known || seen.has(known.file)) errors.push('Unreviewed or duplicate web-ext warning');
    else seen.add(known.file);
  }
  return errors;
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const errors = checkBuild(root, 'firefox', require('../package.json').version);
  for (const entry of reviewed) {
    const bytes = fs.readFileSync(path.join(root, 'dist/firefox', entry.file));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) errors.push('Reviewed vendor warning bytes changed');
  }
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/web-ext/bin/web-ext.js'), 'lint', '--source-dir', 'dist/firefox', '--output', 'json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 ** 2,
  });
  try {
    const report = JSON.parse(result.stdout);
    errors.push(...assessLint(report));
    if (result.error || result.status !== 0) errors.push('web-ext process failed');
    console.log(`web-ext: ${report.errors.length} errors, ${report.notices.length} notices, ${report.warnings.length} reviewed warnings (visible; strict lint still rejects them)`);
    for (const entry of report.warnings) console.log(`${entry.file}:${entry.line}:${entry.column} ${entry.code}`);
  } catch { errors.push('web-ext failed to produce valid JSON'); }
  for (const error of errors) console.error(error);
  process.exitCode = errors.length ? 1 : 0;
}
module.exports = { assessLint };

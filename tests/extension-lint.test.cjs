const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessLint } = require('../scripts/check-extension.cjs');
const expected = [
  { code: 'UNSAFE_VAR_ASSIGNMENT', file: 'vendor/ffmpeg/814.ffmpeg.js', line: 1, column: 1124 },
  { code: 'DANGEROUS_EVAL', file: 'vendor/ffmpeg/ffmpeg.js', line: 1, column: 444 },
  { code: 'UNSAFE_VAR_ASSIGNMENT', file: 'vendor/zipjs/zip-native.min.js', line: 1, column: 63468 },
];
const report = (warnings = expected) => ({ summary: { errors: 0, notices: 0, warnings: warnings.length }, errors: [], notices: [], warnings });

test('extension lint permits reviewed vendor locations and fails new warnings, errors and invalid reports', () => {
  assert.deepEqual(assessLint(report()), []);
  assert.ok(assessLint(report([...expected, { code: 'DANGEROUS_EVAL', file: 'background.js', line: 8, column: 1 }])).length);
  assert.ok(assessLint({ ...report(), errors: [{ code: 'BAD_MANIFEST' }] }).length);
  assert.ok(assessLint({ ...report(), notices: [{ code: 'UNKNOWN_PERMISSION' }] }).length);
  assert.ok(assessLint({ ...report(), summary: { errors: 0, notices: 0, warnings: 0 } }).length);
  assert.ok(assessLint(null).length);
});

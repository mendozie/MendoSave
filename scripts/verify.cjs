const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const npmCli = process.env.npm_execpath;
if (!npmCli || !fs.existsSync(npmCli)) throw new Error('Run this pipeline through npm run verify');
const checks = ['test', 'lint:js', 'check:dependencies', 'audit:dependencies', 'build', 'check:build', 'check:extension', 'check:outgoing'];
const receipt = { executedAt: new Date().toISOString(), node: process.version, checks: [] };
const area = path.join(root, '.local/qa/phase4');
fs.mkdirSync(area, { recursive: true });
function run(label, args) {
  console.log(`\n${label}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  receipt.checks.push({ command: label, exitCode: result.status, signal: result.signal, failedToStart: Boolean(result.error) });
  fs.writeFileSync(path.join(area, 'pipeline.json'), JSON.stringify(receipt, null, 2) + '\n');
  if (result.error || result.status !== 0) { process.exitCode = 1; return false; }
  return true;
}
for (const check of checks) if (!run(`npm run ${check}`, [npmCli, 'run', check])) process.exit(1);
if (!run('outgoing reachable history', ['scripts/check-outgoing.cjs', '--history=HEAD'])) process.exit(1);
run('unsigned candidate archives', ['scripts/release.cjs']);

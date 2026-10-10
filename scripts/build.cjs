const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'extension');
const original = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));

for (const target of ['firefox', 'chromium']) {
  const output = path.join(root, 'dist', target);
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(source, output, { recursive: true, filter: (file) => !/musify\.(js|css)$/.test(file) });
  const manifest = structuredClone(original);
  manifest.name = 'MendoSave';
  manifest.version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  manifest.description = 'Локальное сохранение видео, аудио и субтитров. Разрабатываемая версия.';
  manifest.host_permissions = manifest.host_permissions.filter((host) => !/github/.test(host));
  if (target === 'firefox') {
    manifest.permissions = manifest.permissions.filter((permission) => permission !== 'offscreen');
    manifest.background = { scripts: ['platform.js', 'diagnostics.js', 'background.js'] };
    manifest.browser_specific_settings = { gecko: {
      id: 'mendosave@mendozie', strict_min_version: '157.0',
      data_collection_permissions: { required: ['none'] },
    } };
    delete manifest.cross_origin_embedder_policy;
    delete manifest.cross_origin_opener_policy;
  } else {
    fs.copyFileSync(path.join(root, 'browser-hosts', 'chromium.js'), path.join(output, 'browser-host.js'));
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(root, name), path.join(output, name));
  const files = [];
  function collect(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) collect(file);
      else files.push({ path: path.relative(output, file).replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    }
  }
  collect(output);
  const expected = new Set(['LICENSE', 'THIRD_PARTY_NOTICES.md', ...(target === 'chromium' ? ['browser-host.js'] : [])]);
  function expectSource(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) expectSource(file);
      else if (!/musify\.(js|css)$/.test(file)) expected.add(path.relative(source, file).replaceAll('\\', '/'));
    }
  }
  expectSource(source);
  const unexpected = files.filter((file) => !expected.has(file.path));
  if (unexpected.length) throw new Error(`Unexpected files in dist/${target}: ${unexpected.map((file) => file.path).join(', ')}`);
  fs.writeFileSync(path.join(root, 'dist', `${target}-hashes.json`), JSON.stringify(files, null, 2) + '\n');
  console.log(`${target}: ${files.length} files, ${manifest.version}`);
}

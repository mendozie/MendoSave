const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const settingIds = ['save-as', 'yt-quality', 'yt-lock', 'tw-quality', 'tw-lock'];
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function popup(initial, loadGate) {
  const { document, window } = parseHTML(fs.readFileSync('extension/popup.html', 'utf8'));
  // Linkedom only exposes a getter for select.value; browsers also accept
  // assignments. Model that DOM boundary before running the real scripts.
  for (const select of document.querySelectorAll('select')) {
    Object.defineProperty(select, 'value', { value: '', writable: true });
  }
  const initiallyDisabled = settingIds.map(id => document.getElementById(id).disabled);
  const data = { nova_settings: initial };
  const context = vm.createContext({ document, window, screen: { width: 1920, height: 1080 },
    chrome: { runtime: { getManifest: () => ({ version: '0.3.2' }) }, storage: { local: {
      async get(key) {
        if (key === 'nova_settings') await loadGate;
        return { [key]: data[key] };
      },
      async set(value) { Object.assign(data, value); },
    } } } });
  vm.runInContext(fs.readFileSync('extension/settings.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('extension/popup.js', 'utf8'), context);
  return { document, window, initiallyDisabled, data, settings: context.MendoSaveSettings };
}

test('popup waits for saved preferences before any settings control can be changed', async () => {
  const loading = deferred();
  const app = popup({ saveAs: true, youtubeQuality: 1440, youtubeLock: false,
    twitchQuality: 720, twitchLock: true }, loading.promise);
  assert.deepEqual(app.initiallyDisabled, [true, true, true, true, true],
    'controls must be unavailable from the first render while saved preferences are unknown');
  assert.equal(settingIds.every(id => app.document.getElementById(id).disabled), true);

  loading.resolve();
  await tick();
  assert.equal(settingIds.every(id => !app.document.getElementById(id).disabled), true);
  assert.equal(app.document.getElementById('save-as').checked, true);
  assert.equal(app.document.getElementById('yt-quality').value, '1440');
  assert.equal(app.document.getElementById('yt-lock').checked, false);
  assert.equal(app.document.getElementById('tw-quality').value, '720');
  assert.equal(app.document.getElementById('tw-lock').checked, true);

  const picker = app.document.getElementById('save-as');
  picker.checked = false;
  picker.dispatchEvent(new app.window.Event('change'));
  await tick();
  const reopened = popup(app.data.nova_settings);
  await tick();
  assert.equal(reopened.document.getElementById('save-as').checked, false);
  assert.equal(reopened.document.getElementById('yt-quality').value, '1440');
  assert.equal(reopened.document.getElementById('tw-quality').value, '720');
  assert.match(app.document.getElementById('settings-hint').textContent, /Сохранено/);
});

test('a failed settings read leaves controls unavailable and shows an actionable error', async () => {
  const loading = deferred();
  const app = popup({ saveAs: true, youtubeQuality: 1440 }, loading.promise);
  loading.reject(new Error('Storage read failed'));
  await tick();
  assert.match(app.document.getElementById('settings-hint').textContent, /Настройки недоступны.*Storage read failed/);
  assert.match(app.document.getElementById('settings-hint').textContent, /снова открой окно расширения/);
  assert.equal(settingIds.every(id => app.document.getElementById(id).disabled), true);
  assert.equal(app.data.nova_settings.saveAs, true, 'failed loading must not replace saved preferences');
  const reopened = popup(app.data.nova_settings);
  await tick();
  assert.equal(reopened.document.getElementById('save-as').disabled, false);
  assert.equal(reopened.document.getElementById('save-as').checked, true);
});

test('a popup with no chosen preferences becomes ready with the existing Downloads and player defaults', async () => {
  const app = popup(undefined);
  await tick();
  assert.equal(settingIds.every(id => !app.document.getElementById(id).disabled), true);
  assert.equal(app.document.getElementById('save-as').checked, false);
  assert.equal(app.document.getElementById('yt-quality').value, 'auto');
  assert.equal(app.document.getElementById('yt-lock').checked, true);
  assert.equal(app.document.getElementById('tw-quality').value, 'auto');
  assert.equal(app.document.getElementById('tw-lock').checked, true);
});

test('ordinary page settings readers keep their default fallback when storage is unavailable', async () => {
  const loading = deferred();
  const app = popup(undefined, loading.promise);
  loading.reject(new Error('Storage unavailable'));
  const preferences = await app.settings.load();
  assert.deepEqual(JSON.parse(JSON.stringify(preferences)), {
    saveAs: false, youtubeQuality: 'auto', youtubeLock: true, twitchQuality: 'auto', twitchLock: true,
  });
  await tick();
  assert.match(app.document.getElementById('settings-hint').textContent, /Настройки недоступны/);
});

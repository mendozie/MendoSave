const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function settingsContext(initial = {}) {
  const data = { nova_settings: initial };
  const context = vm.createContext({ chrome: { storage: { local: {
    async get(key) { return { [key]: data[key] }; },
    async set(value) { Object.assign(data, value); },
  } } } });
  vm.runInContext(fs.readFileSync('extension/settings.js', 'utf8'), context);
  return { settings: context.MendoSaveSettings, data };
}

test('save location defaults to Downloads and only a stored boolean enables the picker', async () => {
  const { settings } = settingsContext();
  assert.equal(settings.DEFAULTS.saveAs, false);
  assert.equal((await settings.load()).saveAs, false);
  assert.equal(settings.normalize({ saveAs: true }).saveAs, true);
  for (const saveAs of [false, 'true', 1, null, undefined, {}]) {
    assert.equal(settings.normalize({ saveAs }).saveAs, false);
  }
});

test('saving location and quality together preserves both choices after reopening settings', async () => {
  const { settings, data } = settingsContext({ youtubeQuality: 1440, youtubeLock: false,
    twitchQuality: 720, twitchLock: false });
  await Promise.all([settings.save({ saveAs: true }), settings.save({ twitchQuality: 1080 })]);
  const reopened = settingsContext(data.nova_settings).settings;
  assert.deepEqual(JSON.parse(JSON.stringify(await reopened.load())), {
    saveAs: true, youtubeQuality: 1440, youtubeLock: false, twitchQuality: 1080, twitchLock: false,
  });
  await settings.save({ saveAs: false });
  assert.equal((await settings.load()).saveAs, false);
  assert.equal((await settings.load()).youtubeQuality, 1440);
});

test('popup loads and persists the save picker checkbox without resetting player quality', async () => {
  const { document, window } = parseHTML(fs.readFileSync('extension/popup.html', 'utf8'));
  const data = { nova_settings: { saveAs: true, youtubeQuality: 1440, youtubeLock: false,
    twitchQuality: 720, twitchLock: true } };
  const context = vm.createContext({ document, window, screen: { width: 1920, height: 1080 },
    chrome: { runtime: { getManifest: () => ({ version: '0.2.0' }) }, storage: { local: {
      async get(key) { return { [key]: data[key] }; },
      async set(value) { Object.assign(data, value); },
    } } } });
  vm.runInContext(fs.readFileSync('extension/settings.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('extension/popup.js', 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));
  const picker = document.getElementById('save-as');
  assert.ok(picker, 'popup exposes the save picker checkbox');
  assert.equal(picker.type, 'checkbox');
  assert.equal(picker.checked, true);
  assert.equal(document.querySelector('label[for="save-as"]').textContent.trim(), 'Спрашивать, куда сохранить');
  picker.checked = false;
  picker.dispatchEvent(new window.Event('change'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(data.nova_settings.saveAs, false);
  assert.equal(data.nova_settings.youtubeQuality, 1440);
  assert.equal(data.nova_settings.youtubeLock, false);
  assert.equal(data.nova_settings.twitchQuality, 720);
  assert.equal(data.nova_settings.twitchLock, true);
  assert.match(document.getElementById('settings-hint').textContent, /Сохранено/);
});

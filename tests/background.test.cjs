const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

function browserContext(overrides = {}) {
  const listeners = {};
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const data = {};
  const storage = {
    async get(key) { return key ? { [key]: data[key] } : { ...data }; },
    async set(values) { Object.assign(data, values); },
    async remove(key) { delete data[key]; },
  };
  const network = [];
  const chrome = {
    runtime: {
      id: 'mendosave@test', getURL: (path) => `moz-extension://test/${path}`,
      getManifest: () => ({ version: '0.1.0' }),
      onInstalled: event('install'), onStartup: event('startup'), onMessage: event('message'),
    },
    storage: { local: storage, session: storage },
    alarms: { create() {}, onAlarm: event('alarm') },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setBadgeTextColor() {} },
    downloads: { async download() { return 1; }, async search() { return []; } },
    tabs: { onRemoved: event('tabRemoved'), async query() { return []; } },
    ...overrides,
  };
  const context = vm.createContext({
    chrome, URL, console, setTimeout, clearTimeout, AbortSignal,
    MendoProcessorHost: { async ensure() {} },
    navigator: { userAgent: 'test' },
    fetch: async (url) => { network.push(url); throw new Error('unexpected network'); },
  });
  if (fs.existsSync('extension/platform.js')) vm.runInContext(fs.readFileSync('extension/platform.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);
  const message = (payload, sender = { id: chrome.runtime.id, tab: { id: 7, url: 'https://www.youtube.com/watch?v=fixture' } }) =>
    new Promise((resolve) => {
      const accepted = listeners.message(payload, sender, resolve);
      if (!accepted) resolve(undefined);
    });
  return { listeners, chrome, data, network, message };
}

test('temporary installation and startup never contact the upstream updater', async () => {
  const browser = browserContext();
  browser.listeners.install({ temporary: true });
  browser.listeners.startup();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(browser.network, []);
});

module.exports = { browserContext };

test('ensuring the processor in Gecko reuses one extension tab for concurrent requests', async () => {
  let created = 0;
  const processor = [];
  const browser = browserContext({
    tabs: {
      onRemoved: { addListener() {} },
      async query() { return processor; },
      async create(options) { created++; const tab = { id: 19, ...options }; processor.push(tab); return tab; },
    },
  });
  browser.chrome.runtime.sendMessage = async (message) => message.t === 'nova-host-probe' ? { ok: true } : undefined;
  const responses = await Promise.all([browser.message({ t: 'nova-ensure' }), browser.message({ t: 'nova-ensure' })]);
  assert.equal(responses.every((result) => result.ok), true);
  assert.equal(created, 1);
  assert.equal(processor[0].active, false);
  assert.equal(processor[0].url, 'moz-extension://test/offscreen.html');
});

test('Chromium reuses its offscreen context when hasDocument is unavailable', async () => {
  let created = 0;
  const context = vm.createContext({ chrome: {
    runtime: { async getContexts(query) {
      assert.equal(query.contextTypes[0], 'OFFSCREEN_DOCUMENT');
      return [{ documentUrl: query.documentUrls[0] }];
    } },
    offscreen: { async createDocument() { created++; } },
  } });
  vm.runInContext(fs.readFileSync('browser-hosts/chromium.js', 'utf8'), context);
  await context.MendoHostBackend.open('chrome-extension://test/offscreen.html');
  assert.equal(created, 0);
});

test('the processor accesses recovery storage through runtime while a content page cannot', async () => {
  const browser = browserContext();
  const sender = { id: browser.chrome.runtime.id, url: 'moz-extension://test/offscreen.html' };
  const entry = { id: 'file.bin', filename: 'result.mp4', type: 'video/mp4', bytes: 12, createdAt: 1, savedAt: 0 };
  assert.equal((await browser.message({ t: 'nova-recovery-write', entries: [entry] }, sender))?.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify((await browser.message({ t: 'nova-recovery-read' }, sender)).entries)), [entry]);
  assert.equal((await browser.message({ t: 'nova-recovery-write', entries: [] })).ok, false);
});

test('subtitle data URLs are saved by the bundled Blob host instead of downloads.download', async () => {
  const browser = browserContext({ downloads: {
    async download({ url }) { assert.equal(url.startsWith('data:'), false); return 42; },
  } });
  browser.chrome.runtime.sendMessage = async (message) => {
    if (message.t === 'nova-host-probe') return { ok: true };
    assert.equal(message.t, 'nova-save-text');
    assert.equal(message.text, '\uFEFF1\n00:00:00,000 --> 00:00:01,000\nHello\n');
    assert.equal(message.type, 'application/x-subrip');
    return { ok: true, id: 42 };
  };
  browser.chrome.tabs.create = async () => ({ id: 19 });
  const text = '\uFEFF1\n00:00:00,000 --> 00:00:01,000\nHello\n';
  const saved = await browser.message({ t: 'nova-save', filename: 'captions.srt',
    url: `data:application/x-subrip;charset=utf-8,${encodeURIComponent(text)}` });
  assert.equal(saved.ok, true);
  assert.equal(saved.id, 42);
});

test('download status and cancellation belong to the sender that requested the file', async () => {
  let cancelled = 0;
  const browser = browserContext({ downloads: {
    async download() { return 42; }, async search() { return [{ id: 42, state: 'in_progress' }]; },
    async cancel() { cancelled++; },
  } });
  const sender = { id: browser.chrome.runtime.id, url: 'moz-extension://test/offscreen.html' };
  assert.equal((await browser.message({ t: 'nova-save', url: 'blob:moz-extension://test/output', filename: 'video.mp4' }, sender)).ok, true);
  assert.equal((await browser.message({ t: 'nova-download-state', id: 42 })).ok, false);
  assert.equal((await browser.message({ t: 'nova-download-cancel', id: 42 }))?.ok, false);
  assert.equal(cancelled, 0);
  assert.equal((await browser.message({ t: 'nova-download-cancel', id: 42 }, sender))?.ok, true);
  assert.equal(cancelled, 1);
});

test('downloads reject filesystem URLs and foreign extension blobs', async () => {
  let saves = 0;
  const browser = browserContext({ downloads: { async download() { saves++; return 42; } } });
  for (const url of ['file:///C:/private.txt', 'javascript:alert(1)', 'blob:moz-extension://other/file']) {
    assert.equal((await browser.message({ t: 'nova-save', url, filename: 'media.mp4' })).ok, false);
  }
  assert.equal(saves, 0);
});

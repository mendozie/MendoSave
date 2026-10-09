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
  vm.runInContext(fs.readFileSync('extension/diagnostics.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);
  const message = (payload, sender = { id: chrome.runtime.id, tab: { id: 7, url: 'https://www.youtube.com/watch?v=fixture' } }) =>
    new Promise((resolve) => {
      const accepted = listeners.message(payload, sender, resolve);
      if (!accepted) resolve(undefined);
    });
  return { listeners, chrome, data, network, message };
}

module.exports = { browserContext };

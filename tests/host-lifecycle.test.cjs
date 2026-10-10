const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const tick = () => new Promise(resolve => setImmediate(resolve));
function port(name, sender) {
  const messages = [], messageListeners = [], disconnectListeners = [];
  return { name, sender, messages, disconnected: false,
    onMessage: { addListener(fn) { messageListeners.push(fn); } },
    onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } },
    postMessage(message) { messages.push(message); },
    receive(message) { for (const fn of messageListeners) fn(message); },
    disconnect() { if (this.disconnected) return; this.disconnected = true; for (const fn of disconnectListeners) fn(); },
  };
}
function hostFixture({ seal } = {}) {
  let opens = 0, closes = 0, currentUrl, responds = true;
  const chrome = { runtime: { id: 'test', getURL: path => `moz-extension://test/${path}`,
    async sendMessage(message) {
      if (!currentUrl || !responds) return undefined;
      if (message.t === 'mendosave-host-close') return seal ? seal(message) : { ok: true };
      return { ok: true, instanceId: message.instanceId, revision: 0, active: false };
    } }, tabs: {} };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout,
    MendoHostBackend: { async open(url) { opens++; currentUrl = url; return { url, owned: true, async close() { closes++; if (currentUrl === url) currentUrl = undefined; } }; } } });
  vm.runInContext(fs.readFileSync('extension/platform.js', 'utf8'), context);
  const host = context.MendoProcessorHost;
  const producer = () => port('mendosave-producer', { id: 'test', tab: { id: 7 }, frameId: 0, url: 'https://example.org/' });
  return { host, producer, vanish() { currentUrl = undefined; }, responding(value) { responds = value; }, get opens() { return opens; }, get closes() { return closes; } };
}

test('new admission recreates an idle host lost after idle ACK while a producer still reserves it', async () => {
  const f = hostFixture(), first = f.producer(); f.host.connect(first); await tick();
  const oldId = first.messages[0].instanceId;
  const work = port('mendosave-processor', { id: 'test', url: `moz-extension://test/offscreen.html#mendosave-host=${oldId}` });
  f.host.connect(work); work.receive({ instanceId: oldId, revision: 1, active: false });
  assert.equal(work.messages[0].t, 'mendosave-idle-ack'); work.disconnect();
  f.vanish(); first.disconnect(); await tick();
  const next = f.producer(); f.host.connect(next); await tick();
  assert.equal(next.messages[0].ok, true);
  assert.notEqual(next.messages[0].instanceId, oldId);
  assert.equal(f.opens, 2);
  next.disconnect(); await tick();
});

test('an admission health check rejects old producers and shares the replacement across new producers', async () => {
  const f = hostFixture(), first = f.producer(); f.host.connect(first); await tick();
  const oldId = first.messages[0].instanceId; f.vanish();
  const next = f.producer(), parallel = f.producer(); f.host.connect(next); f.host.connect(parallel); await tick();
  assert.equal(first.disconnected, true);
  assert.equal(next.messages[0].ok, true);
  assert.notEqual(next.messages[0].instanceId, oldId);
  assert.equal(next.messages[0].instanceId, parallel.messages[0].instanceId);
  assert.equal(f.opens, 2);
  next.disconnect(); parallel.disconnect(); await tick();
});

test('Chromium revalidation preserves an unknown existing context and recreates only after it disappears', async () => {
  let documentUrl = 'chrome-extension://test/offscreen.html#mendosave-host=unknown', responds = true, created = 0, closed = 0;
  const chrome = { runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`,
    async getContexts() { return documentUrl ? [{ documentUrl }] : []; },
    async sendMessage(message) { return documentUrl && responds ? { ok: true, instanceId: message.instanceId, active: false } : undefined; } },
    offscreen: { async createDocument({ url }) { created++; documentUrl = url; responds = true; }, async closeDocument() { closed++; documentUrl = undefined; } } };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout });
  for (const file of ['browser-hosts/chromium.js', 'extension/platform.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const source = () => port('mendosave-producer', { id: 'test', tab: { id: 7 } });
  const first = source(); context.MendoProcessorHost.connect(first); await tick(); assert.equal(first.messages[0].instanceId, 'unknown');
  responds = false; const refused = source(); context.MendoProcessorHost.connect(refused); await tick();
  assert.equal(refused.messages[0].ok, false); assert.equal(refused.disconnected, true);
  assert.equal(first.disconnected, false); assert.equal(created, 0); assert.equal(closed, 0);
  documentUrl = undefined; const next = source(); context.MendoProcessorHost.connect(next); await tick();
  assert.equal(next.messages[0].ok, true); assert.notEqual(next.messages[0].instanceId, 'unknown');
  assert.equal(first.disconnected, true); assert.equal(created, 1); assert.equal(closed, 0);
  next.disconnect(); await tick(); assert.equal(closed, 1);
});

test('producer admission spans ensure-to-begin and concurrent producers share one host', async () => {
  const f = hostFixture(); const first = f.producer(), second = f.producer();
  f.host.connect(first); f.host.connect(second);
  await tick();
  assert.equal(f.opens, 1); assert.equal(first.messages[0].ok, true);
  assert.equal(first.messages[0].instanceId, second.messages[0].instanceId);
  assert.equal(f.closes, 0);
  first.disconnect(); await tick(); assert.equal(f.closes, 0);
  second.disconnect(); await tick(); assert.equal(f.closes, 1);
});

test('new admission cancels a stale close confirmation and later idle closes the same instance', async () => {
  let confirm;
  const f = hostFixture({ seal: () => new Promise(resolve => { confirm = resolve; }) });
  const first = f.producer(); f.host.connect(first); await tick(); first.disconnect(); await tick();
  const next = f.producer(); f.host.connect(next); confirm({ ok: true }); await tick();
  assert.equal(f.closes, 0); assert.equal(f.opens, 1); assert.equal(next.messages[0].ok, true);
  next.disconnect(); await tick(); confirm({ ok: true }); await tick(); assert.equal(f.closes, 1);
});

test('a lost close/probe response cannot forget work admitted by a live processor port during disposal', async () => {
  let confirm;
  const f = hostFixture({ seal: () => new Promise(resolve => { confirm = resolve; }) });
  const first = f.producer(); f.host.connect(first); await tick(); const id = first.messages[0].instanceId;
  first.disconnect(); await tick();
  const work = port('mendosave-processor', { id: 'test', url: `moz-extension://test/offscreen.html#mendosave-host=${id}` });
  f.host.connect(work); work.receive({ instanceId: id, revision: 1, active: true });
  f.responding(false); confirm(undefined); await tick();
  f.responding(true); const next = f.producer(); f.host.connect(next); await tick();
  assert.equal(next.messages[0].instanceId, id); assert.equal(f.opens, 1); assert.equal(f.closes, 0);
  work.receive({ instanceId: id, revision: 2, active: false }); work.disconnect(); next.disconnect();
  await tick(); confirm({ ok: true }); await tick();
});

test('processor port authenticates the exact instance URL and keeps work alive after producer release', async () => {
  const f = hostFixture(); const source = f.producer(); f.host.connect(source); await tick();
  const id = source.messages[0].instanceId, url = `moz-extension://test/offscreen.html#mendosave-host=${id}`;
  assert.equal(f.host.isProcessor({ id: 'test', url }), true);
  for (const rejected of ['moz-extension://test/offscreen.html#foreign', 'moz-extension://test/offscreen.html', `${url}extra`, 'https://example.org/offscreen.html']) {
    assert.equal(f.host.isProcessor({ id: 'test', url: rejected }), false);
  }
  const bad = port('mendosave-processor', { id: 'test', url: 'moz-extension://test/offscreen.html#foreign' });
  f.host.connect(bad); assert.equal(bad.disconnected, true);
  const work = port('mendosave-processor', { id: 'test', url }); f.host.connect(work);
  work.receive({ instanceId: id, revision: 1, active: true }); source.disconnect(); await tick();
  assert.equal(f.closes, 0);
  work.receive({ instanceId: id, revision: 2, active: false }); work.disconnect(); await tick();
  assert.equal(f.closes, 1);
});

test('internal operation reservation keeps the host through delayed saving and cleanup', async () => {
  const f = hostFixture(); let complete;
  const done = f.host.withHost(() => new Promise(resolve => { complete = resolve; })); await tick();
  assert.equal(f.closes, 0); complete(42); assert.equal(await done, 42); await tick(); assert.equal(f.closes, 1);
});

function delayedBackendFixture(kind) {
  let documentUrl, responds = true, opens = 0, closes = 0, delayed, pending;
  const storage = {};
  const ownershipRead = async () => {
    if (delayed) {
      delayed = false;
      await new Promise(resolve => { pending = resolve; });
    }
  };
  const chrome = {
    runtime: {
      id: 'test', getURL: path => `${kind === 'chromium' ? 'chrome' : 'moz'}-extension://test/${path}`,
      async getContexts() { await ownershipRead(); return documentUrl ? [{ documentUrl }] : []; },
      async sendMessage(message) {
        return responds && documentUrl ? { ok: true, instanceId: message.instanceId, revision: 0, active: false } : undefined;
      },
    },
    storage: { session: {
      async get(key) { return { [key]: storage[key] }; },
      async set(values) { Object.assign(storage, values); },
      async remove(key) { delete storage[key]; },
    } },
    offscreen: {
      async createDocument({ url }) { opens++; documentUrl = url; },
      async closeDocument() { closes++; documentUrl = undefined; },
    },
    tabs: {
      async create({ url }) { opens++; documentUrl = url; return { id: 19 }; },
      async get(id) { await ownershipRead(); return documentUrl ? { id, url: documentUrl } : null; },
      async remove() { closes++; documentUrl = undefined; },
    },
  };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout,
    document: { createElement() { throw new Error('Test the Firefox tab fallback'); } },
  });
  for (const file of [`browser-hosts/${kind}.js`, 'extension/platform.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  return {
    host: context.MendoProcessorHost,
    producer: () => port('mendosave-producer', { id: 'test', tab: { id: 7 } }),
    holdOwnershipRead() { delayed = true; }, releaseOwnershipRead() { assert.equal(typeof pending, 'function'); pending(); },
    responding(value) { responds = value; },
    get opens() { return opens; }, get closes() { return closes; },
  };
}

for (const backend of ['chromium', 'firefox']) {
  test(`${backend} health disposal preserves work admitted during its awaited ownership read`, async () => {
    const f = delayedBackendFixture(backend), first = f.producer(); f.host.connect(first); await tick();
    const instance = f.host.instance, id = first.messages[0].instanceId;
    f.responding(false); f.holdOwnershipRead();
    const next = f.producer(); f.host.connect(next); await tick();
    const work = port('mendosave-processor', { id: 'test', url: instance.url }); f.host.connect(work);
    work.receive({ instanceId: id, revision: 1, active: true });
    f.responding(true); f.releaseOwnershipRead(); await tick();
    assert.equal(f.closes, 0, 'the active old context must survive the awaited close');
    assert.equal(f.opens, 1); assert.equal(first.disconnected, false);
    assert.equal(next.messages[0].ok, true); assert.equal(next.messages[0].instanceId, id);
    first.disconnect(); next.disconnect();
    work.receive({ instanceId: id, revision: 2, active: false }); work.disconnect(); await tick();
    assert.equal(f.closes, 1, 'the final idle still releases the same context');
  });

  test(`${backend} idle disposal rechecks new reservations after its awaited ownership read`, async () => {
    const f = delayedBackendFixture(backend), first = f.producer(); f.host.connect(first); await tick();
    const id = first.messages[0].instanceId;
    f.holdOwnershipRead(); first.disconnect(); await tick();
    const next = f.producer(); f.host.connect(next);
    f.releaseOwnershipRead(); await tick();
    assert.equal(f.closes, 0); assert.equal(f.opens, 1);
    assert.equal(next.messages[0].ok, true); assert.equal(next.messages[0].instanceId, id);
    next.disconnect(); await tick(); assert.equal(f.closes, 1);
  });
}

function firefoxFixture({ fail = false, navigated = false } = {}) {
  const frames = [], tabs = [], removed = [];
  const context = vm.createContext({ document: { createElement() { return { remove() { this.removed = true; } }; },
    body: { append(frame) { if (fail) throw new Error('DOM unavailable'); frames.push(frame); } } },
    chrome: { tabs: { async create(options) { const tab = { id: 19, ...options }; tabs.push(tab); return tab; },
      async get(id) { return { id, url: navigated ? 'https://example.org/' : tabs[0].url }; },
      async remove(id) { removed.push(id); } } } });
  vm.runInContext(fs.readFileSync('browser-hosts/firefox.js', 'utf8'), context);
  return { backend: context.MendoHostBackend, frames, tabs, removed };
}
test('Firefox uses a hidden same-extension iframe with no service tab', async () => {
  const f = firefoxFixture(); const handle = await f.backend.open('moz-extension://test/offscreen.html#mendosave-host=one');
  assert.equal(f.frames.length, 1); assert.equal(f.frames[0].hidden, true); assert.equal(f.tabs.length, 0);
  await handle.close(); assert.equal(f.frames[0].removed, true);
});
test('Firefox fallback closes only its created unchanged service tab', async () => {
  const f = firefoxFixture({ fail: true }); const handle = await f.backend.open('moz-extension://test/offscreen.html#mendosave-host=one');
  assert.equal(f.tabs[0].active, false); await handle.close(); assert.deepEqual(f.removed, [19]);
  const changed = firefoxFixture({ fail: true, navigated: true }); const other = await changed.backend.open('moz-extension://test/offscreen.html#mendosave-host=two');
  await other.close(); assert.deepEqual(changed.removed, []);
});

test('unresponsive iframe startup falls back once with a fresh instance and disposes the failed owned frame', async () => {
  let frames = 0, tabs = 0, removed = 0;
  const context = vm.createContext({ URL, setTimeout(fn) { fn(); }, clearTimeout,
    chrome: { runtime: { id: 'test', getURL: path => `moz-extension://test/${path}`,
      async sendMessage(message) { return tabs ? { ok: true, instanceId: message.instanceId, active: false } : undefined; } } },
    MendoHostBackend: { async open(url) { frames++; return { url, kind: 'iframe', owned: true, async close() { removed++; } }; },
      async fallback(url) { tabs++; return { url, kind: 'tab', owned: true, async close() {} }; } } });
  vm.runInContext(fs.readFileSync('extension/platform.js', 'utf8'), context);
  const source = port('mendosave-producer', { id: 'test', tab: { id: 7 } }); context.MendoProcessorHost.connect(source); await tick();
  assert.equal(source.messages[0].ok, true); assert.equal(frames, 1); assert.equal(tabs, 1); assert.equal(removed, 1);
});

test('Chromium restart restores the browser-owned instance and never disposes a legacy unknown context', async () => {
  const original = 'chrome-extension://test/offscreen.html#mendosave-host=restored'; let created = 0, closed = 0;
  const chrome = { runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`,
    async getContexts() { return [{ documentUrl: original }]; },
    async sendMessage(message) { return { ok: true, instanceId: message.instanceId, active: true }; } },
    offscreen: { async createDocument() { created++; }, async closeDocument() { closed++; } } };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout });
  for (const file of ['browser-hosts/chromium.js', 'extension/platform.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  assert.equal(await context.MendoProcessorHost.restore({ id: 'test', url: original }), true);
  assert.equal(context.MendoProcessorHost.instance.id, 'restored'); assert.equal(created, 0);
  assert.equal(await context.MendoProcessorHost.restore({ id: 'test', url: `${original}foreign` }), false);
  chrome.runtime.getContexts = async () => [{ documentUrl: 'chrome-extension://test/offscreen.html' }];
  const legacy = await context.MendoHostBackend.open(original); assert.equal(legacy.owned, false); await legacy.close(); assert.equal(closed, 0);
});

test('Chromium idle disposal requires recorded creation ownership as well as the exact browser context', async () => {
  let documentUrl, closed = 0; const data = {};
  const chrome = { runtime: { getURL: path => `chrome-extension://test/${path}`,
    async getContexts() { return documentUrl ? [{ documentUrl }] : []; } },
    storage: { session: { async get(key) { return { [key]: data[key] }; }, async set(values) { Object.assign(data, values); }, async remove(key) { delete data[key]; } } },
    offscreen: { async createDocument({ url }) { documentUrl = url; }, async closeDocument() { closed++; documentUrl = undefined; } } };
  const context = vm.createContext({ chrome, URL }); vm.runInContext(fs.readFileSync('browser-hosts/chromium.js', 'utf8'), context);
  const ownedUrl = 'chrome-extension://test/offscreen.html#mendosave-host=owned';
  await context.MendoHostBackend.open(ownedUrl);
  const restored = await context.MendoHostBackend.open('chrome-extension://test/offscreen.html#mendosave-host=new');
  assert.equal(restored.owned, true); await restored.close(); assert.equal(closed, 1);
  documentUrl = 'chrome-extension://test/offscreen.html#mendosave-host=unknown';
  const unknown = await context.MendoHostBackend.open(ownedUrl); assert.equal(unknown.owned, false); await unknown.close(); assert.equal(closed, 1);
});

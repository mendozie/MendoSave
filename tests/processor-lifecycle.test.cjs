const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function ports(sender) {
  function endpoint() {
    const messages = [], disconnects = [];
    return { sender, onMessage: { addListener(fn) { messages.push(fn); } }, onDisconnect: { addListener(fn) { disconnects.push(fn); } },
      postMessage(message) { queueMicrotask(() => { if (!this.peer.closed) for (const fn of this.peer.messages) fn(message); }); },
      disconnect() { if (this.closed) return; this.closed = this.peer.closed = true; for (const fn of [...disconnects, ...this.peer.disconnects]) fn(); },
      messages, disconnects };
  }
  const a = endpoint(), b = endpoint(); a.peer = b; b.peer = a; return [a, b];
}
function fixture({ closeWriter, save, load, writeIndex } = {}) {
  const timers = new Set(), timeouts = new Map(), files = new Map(), contexts = [];
  let processorListener, url, closes = 0, entries = [], downloadState = 'complete';
  const directory = { async *keys() { for (const name of files.keys()) yield name; },
    async *entries() { for (const name of files.keys()) yield [name, { kind: 'file' }]; },
    async getDirectoryHandle() { return this; }, async removeEntry(name) { files.delete(name); },
    async getFileHandle(name, options) {
      if (!files.has(name)) { if (!options?.create) throw new Error('missing'); files.set(name, []); }
      return { async getFile() { return new File(files.get(name), name); }, async createWritable() {
        return { async write(bytes) { files.get(name).push(bytes); }, async close() { if (closeWriter) await closeWriter(); }, async abort() { if (closeWriter) await closeWriter(); },
          getWriter() { const self = this; return { write: bytes => self.write(bytes), close: () => self.close(), abort: () => self.abort(), releaseLock() {} }; } };
      } };
    } };
  const runtime = { id: 'test', getURL: path => `moz-extension://test/${path}` };
  const backgroundSender = { id: 'test', url: 'moz-extension://test/_generated_background_page.html#background' };
  const invoke = (message, sender) => new Promise(resolve => {
    const accepted = processorListener(message, sender, resolve); if (!accepted) resolve(undefined);
  });
  const platform = vm.createContext({ URL, setTimeout, clearTimeout, chrome: { runtime: { ...runtime,
    sendMessage: message => invoke(message, backgroundSender) } }, MendoHostBackend: { async open(nextUrl) {
    url = nextUrl;
    const processorRuntime = { ...runtime, onMessage: { addListener(fn) { processorListener = fn; } }, onConnect: { addListener(fn) { this.listener = fn; } },
      connect({ name }) { const [client, server] = ports({ id: 'test', url }); server.name = name; host.connect(server); return client; },
      async sendMessage(message) {
        if (message.t === 'mendosave-recovery-read') return { ok: true, entries };
        if (message.t === 'mendosave-recovery-write') { if (writeIndex) await writeIndex(); entries = message.entries; return { ok: true }; }
        if (message.t === 'mendosave-save') return save ? save(message) : { ok: true, id: 42 };
        if (message.t === 'mendosave-download-state') return { ok: true, state: downloadState, paused: true };
        return { ok: true };
      } };
    const context = vm.createContext({ chrome: { runtime: processorRuntime }, location: new URL(url), navigator: { storage: { async getDirectory() { return directory; }, async estimate() { return { quota: 1e10, usage: 0 }; } } },
      FFmpegWASM: { FFmpeg: class { on() {} async load() { if (load) await load(); } terminate() {} async exec() { return 0; }
        async writeFile() {} async deleteFile() {} async readFile() { return new Uint8Array([255, 251, 144, 0, 1, 2, 3]); } } },
      URL, File, Blob, console, TextDecoder, Uint8Array, ArrayBuffer, atob, AbortController, AbortSignal, DOMException,
      WritableStream, ReadableStream, crypto, MendoArchive: require('../extension/archive.js'),
      setTimeout(fn, delay) { const timer = setTimeout(fn, delay); timers.add(timer); timeouts.set(timer, { fn, delay }); return timer; },
      clearTimeout(timer) { clearTimeout(timer); timeouts.delete(timer); },
      setInterval(fn, delay) { const timer = setInterval(fn, delay); timer.unref(); timers.add(timer); return timer; }, clearInterval });
    for (const file of ['package_host.js', 'package_io.js', 'offscreen.js']) vm.runInContext(fs.readFileSync(`extension/${file}`, 'utf8'), context);
    contexts.push(processorRuntime);
    return { url, owned: true, async close() { closes++; } };
  } } });
  vm.runInContext(fs.readFileSync('extension/platform.js', 'utf8'), platform);
  const host = platform.MendoProcessorHost;
  async function acquire() {
    const [client, server] = ports({ id: 'test', tab: { id: 7 }, frameId: 0, documentId: 'page' }); server.name = 'mendosave-producer';
    const ready = new Promise(resolve => client.onMessage.addListener(resolve)); host.connect(server); assert.equal((await ready).ok, true); return client;
  }
  const sender = { id: 'test', tab: { id: 7, url: 'https://www.youtube.com/watch?v=fixture' }, frameId: 0, documentId: 'page' };
  const targeted = message => ({ instanceId: new URL(url).hash.slice('#mendosave-host='.length), ...message });
  return { host, acquire, files, get closes() { return closes; }, get url() { return url; },
    state(value) { downloadState = value; }, message: message => invoke(targeted(message), sender),
    raw: message => invoke(message, sender),
    text: text => invoke(targeted({ t: 'mendosave-save-text', text, type: 'text/plain', filename: 'captions.txt' }), backgroundSender),
    flush: () => invoke(targeted({ t: 'mendosave-flush', manual: true }), backgroundSender),
    expireTransfers() { for (const [timer, value] of timeouts) if (value.delay === 60000) { clearTimeout(timer); value.fn(); } },
    park() { files.set('recovered.bin', [new Uint8Array([1, 2, 3])]); entries = [{ id: 'recovered.bin', filename: 'ready.mp4', type: 'video/mp4', bytes: 3, createdAt: Date.now(), savedAt: 0 }]; },
    connect(name) { const [client, server] = ports(sender); server.name = name; contexts.at(-1).onConnect.listener(server); return client; },
    stop() { for (const timer of timers) { clearTimeout(timer); clearInterval(timer); } },
  };
}

test('only the selected processor instance admits work and untagged commands cannot mutate either host', async () => {
  const selected = fixture(), unknown = fixture(); try {
    const selectedSource = await selected.acquire(), unknownSource = await unknown.acquire();
    const begin = { t: 'mendosave-stage-open', jobId: 'bound' };
    assert.equal(await selected.raw(begin), undefined);
    assert.equal(await unknown.raw(begin), undefined);
    const instanceId = new URL(selected.url).hash.slice('#mendosave-host='.length);
    assert.equal(await unknown.raw({ ...begin, instanceId }), undefined);
    assert.equal((await selected.raw({ ...begin, instanceId })).ok, true);
    assert.equal(await selected.raw({ t: 'mendosave-abort', jobId: 'bound' }), undefined);
    assert.equal((await selected.message({ t: 'mendosave-stage', jobId: 'bound', track: 'audio', b64: 'AQ==' })).ok, true);
    await selected.message({ t: 'mendosave-abort', jobId: 'bound' });
    selectedSource.disconnect(); unknownSource.disconnect(); await tick();
    assert.equal(selected.closes, 1); assert.equal(unknown.closes, 1);
  } finally { selected.stop(); unknown.stop(); }
});

test('staging retains actual host after producer disconnect and abort allows idle disposal/recreation', async () => {
  const f = fixture(); try {
    const source = await f.acquire(); await f.message({ t: 'mendosave-stage-open', jobId: 'stage' }); source.disconnect(); await tick();
    assert.equal(f.closes, 0); assert.equal(f.host.instance.active, true);
    await f.message({ t: 'mendosave-stage', jobId: 'stage', track: 'audio', b64: 'AQ==' });
    await f.message({ t: 'mendosave-abort', jobId: 'stage' }); await tick(); assert.equal(f.closes, 1);
    const previous = f.url; const next = await f.acquire(); assert.notEqual(f.url, previous); next.disconnect(); await tick(); assert.equal(f.closes, 2);
  } finally { f.stop(); }
});
test('TXT SaveAs and paused download retain host until complete even after producer release', async () => {
  const picker = deferred(); const f = fixture({ save: () => picker.promise }); try {
    const source = await f.acquire(); const saving = f.text('captions'); source.disconnect(); await tick(); assert.equal(f.closes, 0);
    f.state('in_progress'); picker.resolve({ ok: true, id: 42 }); await tick(); assert.equal(f.closes, 0);
    f.state('complete'); assert.equal((await saving).ok, true); await tick(); assert.equal(f.closes, 1);
  } finally { f.stop(); }
});
test('detached spool abort waits for writer close and file removal before actual disposal', async () => {
  const closing = deferred(); const f = fixture({ closeWriter: () => closing.promise }); try {
    const source = await f.acquire();
    await f.message({ t: 'mendosave-begin', jobId: 'spool', muxed: true, expectedBytes: 300_000_000 }); await tick();
    await f.message({ t: 'mendosave-abort', jobId: 'spool' }); source.disconnect(); await tick();
    assert.equal(f.closes, 0); assert.equal(f.files.has('spool.ts'), true);
    closing.resolve(); await tick(); assert.equal(f.files.has('spool.ts'), false); assert.equal(f.closes, 1);
  } finally { closing.resolve(); f.stop(); }
});
test('transfer disconnect retains host through writer cleanup then disposes without heartbeat tick', async () => {
  const closing = deferred(); const f = fixture({ closeWriter: () => closing.promise }); try {
    const source = await f.acquire(), transferId = '00000000-0000-4000-8000-000000000001';
    assert.equal((await f.message({ t: 'mendosave-blob-open', transferId, filename: 'audio.mp3', mime: 'audio/mpeg', size: 1 })).ok, true);
    const transfer = f.connect(`mendosave-transfer:${transferId}`); transfer.disconnect(); source.disconnect(); await tick();
    assert.equal(f.closes, 0); assert.ok(f.files.size > 0);
    closing.resolve(); await tick(); assert.equal(f.files.size, 0); assert.equal(f.closes, 1);
  } finally { closing.resolve(); f.stop(); }
});
test('warmup keeps the host while engine load is pending', async () => {
  const loading = deferred(); const f = fixture({ load: () => loading.promise }); try {
    const source = await f.acquire(); const warming = f.message({ t: 'mendosave-warmup' }); source.disconnect(); await tick(); assert.equal(f.closes, 0);
    loading.resolve(); await warming; await tick(); assert.equal(f.closes, 1);
  } finally { loading.resolve(); f.stop(); }
});

test('a parallel live job keeps the host after staging finishes and releases it after live cleanup', async () => {
  const closing = deferred(); const f = fixture({ closeWriter: () => closing.promise }); try {
    const source = await f.acquire(); await f.message({ t: 'mendosave-stage-open', jobId: 'stage' });
    assert.equal((await f.message({ t: 'mendosave-live-begin', jobId: 'live' })).ok, true);
    await f.message({ t: 'mendosave-live-chunk', jobId: 'live', track: 'audio', b64: 'AQ==', mime: 'audio/webm' });
    await f.message({ t: 'mendosave-abort', jobId: 'stage' }); source.disconnect(); await tick(); assert.equal(f.closes, 0);
    const aborting = f.message({ t: 'mendosave-live-abort', jobId: 'live' }); await tick(); assert.equal(f.closes, 0);
    closing.resolve(); await aborting; await tick(); assert.equal(f.closes, 1);
  } finally { closing.resolve(); f.stop(); }
});

test('recovery keeps the host until its completed download has a durable saved index', async () => {
  const index = deferred(); const f = fixture({ writeIndex: () => index.promise }); try {
    const source = await f.acquire(); f.park(); const flushing = f.flush(); source.disconnect(); await tick();
    assert.equal(f.closes, 0); index.resolve(); assert.equal((await flushing).saved, 1); await tick(); assert.equal(f.closes, 1);
  } finally { index.resolve(); f.stop(); }
});

test('transfer TTL cleanup actually releases the host after delayed writer abort', async () => {
  const closing = deferred(); const f = fixture({ closeWriter: () => closing.promise }); try {
    const source = await f.acquire(), transferId = '00000000-0000-4000-8000-000000000002';
    await f.message({ t: 'mendosave-blob-open', transferId, filename: 'audio.mp3', mime: 'audio/mpeg', size: 1 });
    source.disconnect(); f.expireTransfers(); await tick(); assert.equal(f.closes, 0);
    closing.resolve(); await tick(); assert.equal(f.files.size, 0); assert.equal(f.closes, 1);
  } finally { closing.resolve(); f.stop(); }
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function pageHook() {
  const { document, window: domWindow } = parseHTML('<html><body><div id="movie_player"><video></video></div></body></html>');
  // linkedom's defaultView proxies globals. Each hook needs its own page realm
  // so installed guards and wrapped constructors cannot leak between tests.
  const window = new domWindow.EventTarget();
  window.Event = domWindow.Event;
  const player = document.getElementById('movie_player');
  player.getPlaybackQuality = () => 'small';
  player.getAvailableQualityLevels = () => [];
  const media = player.querySelector('video');
  Object.assign(media, { currentTime: 0, duration: 19, paused: true, buffered: { length: 0 }, playbackRate: 1 });
  media.pause = () => { media.paused = true; };
  media.play = async () => { media.paused = false; };
  class SourceBuffer { appendBuffer() {} }
  class MediaSource {
    addSourceBuffer() { return new SourceBuffer(); }
    static isTypeSupported() { return true; }
  }
  class HTMLMediaElement { canPlayType() { return 'probably'; } }
  class Worker {
    constructor(url, options) { this.url = url; this.options = options; this.listeners = []; this.requests = []; }
    addEventListener(type, callback) { this.listeners.push({ type, callback }); }
    removeEventListener(type, callback) { this.listeners = this.listeners.filter((entry) => entry.type !== type || entry.callback !== callback); }
    postMessage(message) {
      this.requests.push(message);
      if (message.__mendosaveWorkerRemove) {
        if (!this.terminated) this.emit({ __mendosaveWorkerRemoved: true, streamId: message.streamId, removed: true });
        this.onRemove?.();
      }
    }
    terminate() {
      if (!(this instanceof Worker)) throw new TypeError('incompatible Worker receiver');
      this.terminated = true;
      return undefined;
    }
    emit(data) {
      for (const entry of [...this.listeners]) {
        if (entry.type !== 'message') continue;
        let stopped = false;
        entry.callback({ data, stopImmediatePropagation() { stopped = true; } });
        if (stopped) break;
      }
    }
  }
  const blobs = new Map();
  class HookURL extends URL {
    static createObjectURL(blob) { const url = `blob:fixture-${blobs.size + 1}`; blobs.set(url, blob); return url; }
    static revokeObjectURL(url) { blobs.delete(url); }
  }
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  class HookDate extends Date { static now() { return now; } }
  const posts = [];
  Object.assign(window, { MediaSource, SourceBuffer, Worker, postMessage: (message) => posts.push(message) });
  const location = new HookURL('https://music.youtube.com/watch?v=fixture01');
  const context = vm.createContext({ document, window, location, MediaSource, SourceBuffer, HTMLMediaElement,
    URL: HookURL, URLSearchParams, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder, Blob,
    Date: HookDate, performance: { now: () => now }, screen: { width: 1920, height: 1080 }, navigator: { userAgent: 'test' },
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay = 0) { const id = nextTimerId++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return nextTimerId++; }, clearInterval() {},
  });
  vm.runInContext(fs.readFileSync('extension/content_hook.js', 'utf8'), context);
  function send(cmd, reqId, details = {}) {
    const event = new window.Event('message');
    Object.assign(event, { source: window, origin: location.origin,
      data: { __mendosave_to_hook: true, cmd, reqId, ...details } });
    window.dispatchEvent(event);
  }
  function reply(reqId) { return posts.find((message) => message.__mendosave_from_hook === true && message.reqId === reqId && 'ok' in message); }
  let navigation = 1;
  function navigate() { location.search = `?v=fixture${++navigation}`; document.dispatchEvent(new window.Event('yt-navigate-finish')); }
  function drain(reqId) { send('drain-captured', reqId); assert.equal(reply(reqId)?.ok, true); return reply(reqId).tracks; }
  async function runUntil(predicate) {
    for (let step = 0; step < 2000; step++) {
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      if (predicate()) return;
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(next, 'the public download must continue or respond');
      timers.delete(next[0]); now = next[1].at; next[1].callback();
    }
    assert.fail('public download did not finish within the bounded simulated clock');
  }
  return { window, Worker, navigate, drain, send, reply, runUntil, blobs };
}

function box(type, payload) {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(Buffer.from(type, 'ascii'), 4); bytes.set(payload, 8);
  return bytes;
}
const audioInit = box('ftyp', Uint8Array.of(0x69, 0x73, 0x6f, 0x6d));
const audioMedia = box('moof', Uint8Array.of(1, 2, 3, 4));
function append(worker, bytes, streamId = 1) {
  worker.emit({ __mendosaveMseSegment: true, streamId, kind: 'audio', mime: 'audio/mp4', bytes: bytes.buffer });
}

test('after terminate and SPA navigation the public capture routes range removal only to a live worker', async () => {
  const hook = pageHook();
  const ended = new hook.window.Worker('https://music.youtube.com/worker.js');
  const live = new hook.window.Worker('https://music.youtube.com/worker.js');
  append(ended, audioInit); append(live, audioInit);
  ended.terminate(); hook.navigate();
  ended.onRemove = live.onRemove = () => hook.send('download-cancel', 99);
  hook.send('download', 1, { format: 'mp3', end: 'full' });
  await hook.runUntil(() => Boolean(hook.reply(1)));
  assert.equal(ended.requests.length, 0, 'a terminated worker is no longer a capture candidate');
  assert.ok(live.requests.some((request) => request.__mendosaveWorkerRemove), 'the reusable live worker remains a capture candidate');
  assert.equal(hook.reply(1).ok, false, 'the fixture cancels after observing the range-removal boundary');
});

test('a live worker reuses its decoder init after SPA navigation without re-appending init', () => {
  const hook = pageHook();
  const worker = new hook.window.Worker('https://music.youtube.com/worker.js');
  append(worker, audioInit); hook.navigate(); append(worker, audioMedia);
  assert.deepEqual([...new Uint8Array(hook.drain(1).audio)], [...audioInit, ...audioMedia]);
});

test('prototype terminate preserves the native result and receiver check and prevents late relays', () => {
  const hook = pageHook();
  const worker = new hook.window.Worker('https://music.youtube.com/worker.js', { type: 'module', name: 'fixture' });
  assert.ok(worker instanceof hook.Worker);
  assert.ok(worker instanceof hook.window.Worker);
  assert.deepEqual(worker.options, { type: 'module', name: 'fixture' });
  append(worker, audioInit);
  assert.equal(hook.window.Worker.prototype.terminate.call(worker), undefined);
  assert.equal(worker.terminate(), undefined, 'repeated termination stays native-compatible');
  assert.throws(() => hook.window.Worker.prototype.terminate.call({}), TypeError);
  hook.navigate(); append(worker, audioInit); append(worker, audioMedia);
  assert.deepEqual(Object.keys(hook.drain(1)), [], 'a queued relay cannot recreate an ended worker transport');
  const fresh = new hook.window.Worker('https://music.youtube.com/worker.js');
  append(fresh, audioMedia);
  assert.deepEqual(Object.keys(hook.drain(2)), [], 'an ended worker init cannot seed a new stream without init');
});

async function workerRealm(hook, worker) {
  const source = await hook.blobs.get(worker.url).text();
  const listeners = new Map();
  const self = {
    location: new URL('https://music.youtube.com/worker.js'),
    postMessage(data) { worker.emit(data); },
    addEventListener(type, callback) { const callbacks = listeners.get(type) || []; callbacks.push(callback); listeners.set(type, callbacks); },
    close() { self.closed = true; },
  };
  class SourceBuffer {
    constructor() { this.updating = false; this.buffered = { length: 1, start: () => 0, end: () => 19 }; }
    appendBuffer() {
      if (!this.owner.sourceBuffers.includes(this)) throw new Error('source buffer is not attached');
      if (this.owner.readyState === 'ended') { this.owner.readyState = 'open'; this.owner.emit('sourceopen'); }
      return 'native-append';
    }
    remove() { this.buffered = { length: 0 }; }
  }
  class MediaSource {
    constructor() { this.sourceBuffers = []; this.readyState = 'open'; this.listeners = new Map(); }
    addEventListener(type, callback) { const callbacks = this.listeners.get(type) || []; callbacks.push(callback); this.listeners.set(type, callbacks); }
    addSourceBuffer() { const buffer = new SourceBuffer(); buffer.owner = this; this.sourceBuffers.push(buffer); return buffer; }
    removeSourceBuffer(buffer) {
      const index = this.sourceBuffers.indexOf(buffer);
      if (index < 0) throw new Error('source buffer is not attached');
      this.sourceBuffers.splice(index, 1);
      return 'native-remove';
    }
    emit(type) { for (const callback of this.listeners.get(type) || []) callback.call(this); }
    endOfStream() { this.readyState = 'ended'; this.emit('sourceended'); }
    detach({ deferEvent = false } = {}) {
      this.sourceBuffers.length = 0; this.readyState = 'closed';
      if (!deferEvent) this.emit('sourceclose');
    }
  }
  Object.assign(self, { MediaSource, SourceBuffer });
  vm.runInContext(source, vm.createContext({ self, URL, Uint8Array, ArrayBuffer, importScripts() {}, setTimeout() {} }));
  return { self, MediaSource };
}

test('native SourceBuffer removal retires only its worker stream from public capture', async () => {
  const hook = pageHook();
  const worker = new hook.window.Worker('https://music.youtube.com/worker.js');
  const realm = await workerRealm(hook, worker);
  const source = new realm.MediaSource();
  const removed = source.addSourceBuffer('audio/mp4');
  const reused = source.addSourceBuffer('audio/mp4');
  removed.appendBuffer(audioInit); reused.appendBuffer(audioInit);
  assert.equal(source.removeSourceBuffer(removed), 'native-remove');
  assert.throws(() => source.removeSourceBuffer(removed), /not attached/);
  assert.throws(() => removed.appendBuffer(audioMedia), /not attached/);
  hook.navigate();
  worker.onRemove = () => hook.send('download-cancel', 99);
  hook.send('download', 1, { format: 'mp3', end: 'full' });
  await hook.runUntil(() => Boolean(hook.reply(1)));
  assert.deepEqual(worker.requests.filter((request) => request.__mendosaveWorkerRemove).map((request) => request.streamId), [2]);
  assert.equal(reused.appendBuffer(audioMedia), 'native-append');
  assert.deepEqual([...new Uint8Array(hook.drain(2).audio)], [...audioInit, ...audioMedia]);
});

test('sourceclose retires detached streams and their init while sourceended permits reuse', async () => {
  const hook = pageHook();
  const worker = new hook.window.Worker('https://music.youtube.com/worker.js');
  const realm = await workerRealm(hook, worker);
  const closedSource = new realm.MediaSource();
  const closed = closedSource.addSourceBuffer('audio/mp4');
  closed.appendBuffer(audioInit); closedSource.detach(); hook.navigate();
  assert.throws(() => closed.appendBuffer(audioMedia), /not attached/);
  const freshSource = new realm.MediaSource();
  const fresh = freshSource.addSourceBuffer('audio/mp4');
  fresh.appendBuffer(audioMedia);
  assert.deepEqual(Object.keys(hook.drain(1)), [], 'a detached stream cannot supply init to a fresh stream');
  fresh.appendBuffer(audioInit); freshSource.endOfStream(); hook.navigate();
  assert.equal(fresh.appendBuffer(audioMedia), 'native-append');
  assert.equal(freshSource.readyState, 'open');
  assert.deepEqual([...new Uint8Array(hook.drain(2).audio)], [...audioInit, ...audioMedia]);
  worker.onRemove = () => hook.send('download-cancel', 99);
  // A fresh navigation discards captured bytes but keeps the reopened stream
  // eligible for range requests, which must not revive the detached stream.
  hook.navigate();
  hook.send('download', 3, { format: 'mp3', end: 'full' });
  await hook.runUntil(() => Boolean(hook.reply(3)));
  const removals = worker.requests.filter((request) => request.__mendosaveWorkerRemove);
  assert.ok(removals.length > 0, 'the reopened stream must remain a range-removal candidate');
  assert.ok(removals.every((request) => request.streamId === 2));
});

test('a delayed sourceclose event cannot retire new buffers added after reattachment', async () => {
  const hook = pageHook();
  const worker = new hook.window.Worker('https://music.youtube.com/worker.js');
  const realm = await workerRealm(hook, worker);
  const source = new realm.MediaSource();
  const old = source.addSourceBuffer('audio/mp4');
  old.appendBuffer(audioInit); source.detach({ deferEvent: true });
  source.readyState = 'open';
  const fresh = source.addSourceBuffer('audio/mp4');
  fresh.appendBuffer(audioInit);
  source.emit('sourceclose'); hook.navigate(); fresh.appendBuffer(audioMedia);
  assert.deepEqual([...new Uint8Array(hook.drain(1).audio)], [...audioInit, ...audioMedia]);
});

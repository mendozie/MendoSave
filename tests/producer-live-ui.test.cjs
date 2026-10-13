const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const espree = require('espree');
const { parseHTML } = require('./user-dom.cjs');
const { producerPorts } = require('./producer-port-harness.cjs');
const { create: createPackageUI } = require('../extension/package_ui.js');

const source = fs.readFileSync('extension/content_ui.js', 'utf8');
const declarations = espree.parse(source, { ecmaVersion: 'latest', range: true }).body[0].expression.callee.body.body;
const flow = declarations.filter(node => node.type === 'FunctionDeclaration' && ['getToast', 'startLiveRecording', 'sendRuntimeMessage'].includes(node.id.name))
  .map(node => source.slice(...node.range)).join('\n');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function live() {
  const { window, document } = parseHTML('<html><body></body></html>');
  const producers = producerPorts({ autoAck: false });
  const capture = deferred(), finalize = deferred(), abort = deferred(), chunk = deferred();
  const messages = [], hooks = [], runtimeListeners = new Set(), timers = new Map();
  let timerId = 0;
  let delayAbort = false, delayChunk = false;
  const dispatch = async message => {
    messages.push(message);
    if (/^mendosave-live-/.test(message.t)) assert.equal(message.instanceId, 'processor-fixture');
    if (message.t === 'mendosave-live-finalize') return finalize.promise;
    if (message.t === 'mendosave-live-abort' && delayAbort) return abort.promise;
    if (message.t === 'mendosave-live-chunk' && delayChunk) return chunk.promise;
    return { ok: true, tabId: 7 };
  };
  const context = vm.createContext({ window, document, crypto, console,
    location: new URL('https://www.youtube.com/watch?v=fixtureLive'), TRANSFER_CHUNK_SIZE: 4 * 1024 ** 2,
    MendoPackageUI: createPackageUI({ runtime: { connect: producers.connect, sendMessage: dispatch } }),
    chrome: { runtime: { onMessage: { addListener(fn) { runtimeListeners.add(fn); }, removeListener(fn) { runtimeListeners.delete(fn); } } } },
    createElement(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text != null) element.textContent = text; return element; },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    removeLivePanel() {}, renderLivePanel() {}, safeFilename: value => value,
    ownedTransferChunk: (buffer, offset) => new Uint8Array(buffer).slice(offset, offset + 4 * 1024 ** 2),
    encodeBase64: bytes => Buffer.from(bytes).toString('base64'), reportError: async () => {},
    callHook(command) { hooks.push(command); return command === 'live-start' ? capture.promise : Promise.resolve({}); },
    sendWorkerMessage: dispatch,
  });
  context.MendoMenu = require('../extension/menu.js');
  context.MendoDiagnostics = require('../extension/diagnostics.js');
  vm.runInContext(`let downloadInProgress = false, liveJob = null, toastHideTimer; ${flow}`, context);
  const settle = async () => { for (let n = 0; n < 6; n++) await new Promise(setImmediate); };
  return { context, producers, capture, finalize, abort, chunk, messages, hooks, runtimeListeners, settle,
    text: () => document.querySelector('.mendosave-toast-txt')?.textContent,
    visible: () => document.getElementById('mendosave-toast')?.classList.contains('show'),
    expire(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } },
    delayAbort() { delayAbort = true; }, delayChunk() { delayChunk = true; },
    run: () => context.startLiveRecording({ title: 'Fixture', videoId: 'fixtureLive' }, 'now'),
    deliver(bytes = Uint8Array.of(1, 2, 3)) {
      const event = new window.Event('message');
      Object.assign(event, { source: window, origin: context.location.origin,
        data: { __mendosave_live_chunk: true, kind: 'video', buffer: bytes.buffer, mime: 'video/mp4' } });
      window.dispatchEvent(event);
    },
  };
}

test('YouTube live ignores pre-ready chunks, waits for ACK and releases only after finalize', async () => {
  const h = live();
  const running = h.run(); h.deliver(); await h.settle();
  assert.equal(h.messages.length, 0, 'unstarted recording cannot process page chunks or ensure');
  assert.equal(h.hooks.includes('live-start'), false);
  const producer = h.producers.ports[0]; assert.ok(producer);
  producer.receive({ ok: true, instanceId: 'processor-fixture' }); await h.settle();
  h.deliver(); await h.settle();
  assert.equal(h.messages.filter(message => message.t === 'mendosave-live-chunk').length, 1);
  h.capture.resolve({ durationSeconds: 2, videoMime: 'video/mp4' }); await h.settle();
  assert.equal(h.messages.filter(message => message.t === 'mendosave-live-finalize').length, 1);
  h.deliver(); await h.settle();
  assert.equal(h.messages.filter(message => message.t === 'mendosave-live-chunk').length, 1, 'finished capture cannot append after finalize began');
  assert.equal(producer.disconnected, false);
  const pendingNotice = h.text();
  assert.equal(await h.run(), false, 'finalizing workflow rejects a second recording');
  assert.equal(h.text(), pendingNotice, 'refused duplicate keeps the active toast owner');
  h.finalize.resolve({ ok: true, filename: 'saved.mp4' }); assert.equal(await running, true);
  assert.equal(producer.disconnected, true);
  assert.equal(h.runtimeListeners.size, 0);
});

test('actual YouTube live toast can hide during capture then show final progress and saved/error result', async t => {
  for (const succeeds of [true, false]) await t.test(succeeds ? 'saved' : 'save failed', async () => {
    const h = live(), running = h.run();
    h.producers.ports[0].receive({ ok: true, instanceId: 'processor-fixture' }); await h.settle();
    h.expire(800); assert.equal(h.visible(), false, 'live panel replaces temporary preparation notice');
    h.capture.resolve({ durationSeconds: 2, videoMime: 'video/mp4' }); await h.settle();
    assert.equal(h.text(), 'Собираю файл записи…');
    assert.equal(h.visible(), true);
    h.finalize.resolve(succeeds ? { ok: true, filename: 'saved.mp4' } : { ok: false, error: 'disk unavailable' });
    assert.equal(await running, succeeds);
    assert.match(h.text(), succeeds ? /Готово: saved\.mp4/ : /Ошибка записи эфира: disk unavailable/);
    assert.equal(h.visible(), true);
    for (const listener of h.runtimeListeners) listener({ t: 'mendosave-progress', status: 'late', value: .5 });
    assert.doesNotMatch(h.text(), /late/);
  });
});

test('YouTube live waits for pending transfers and abort cleanup before releasing a failed producer workflow', async () => {
  const h = live(); h.delayChunk(); h.delayAbort();
  const running = h.run();
  const producer = h.producers.ports[0]; producer.receive({ ok: true, instanceId: 'processor-fixture' });
  await h.settle(); h.deliver(); await h.settle();
  h.capture.reject(new Error('capture failed')); await h.settle();
  assert.equal(h.messages.some(message => message.t === 'mendosave-live-abort'), false, 'drain must finish before abort');
  assert.equal(producer.disconnected, false);
  h.chunk.resolve({ ok: true }); await h.settle();
  assert.equal(h.messages.some(message => message.t === 'mendosave-live-abort'), true);
  assert.equal(producer.disconnected, false);
  h.abort.resolve({ ok: true }); assert.equal(await running, false);
  assert.equal(producer.disconnected, true);
});

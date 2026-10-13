const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const espree = require('espree');
const { parseHTML, UserEvent } = require('./user-dom.cjs');
const { producerPorts } = require('./producer-port-harness.cjs');
const { create: createPackageUI } = require('../extension/package_ui.js');

const source = fs.readFileSync('extension/content_ui.js', 'utf8');
const declarations = espree.parse(source, { ecmaVersion: 'latest', range: true }).body[0].expression.callee.body.body;
const names = new Set(['getToast', 'startDownload', 'tryDownloadViaSabr', 'mediaResponseError', 'sendRuntimeMessage']);
const flow = declarations.filter((node) => node.type === 'FunctionDeclaration' && names.has(node.id.name))
  .map((node) => source.slice(...node.range)).join('\n');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(packageRun = true, autoAck = true) {
  const { window, document } = parseHTML('<html><body></body></html>');
  const capture = deferred(), capturing = deferred(), warmup = deferred();
  const timers = new Map(), runtimeListeners = new Set(), signalListeners = new Set();
  const controller = new AbortController();
  const producers = producerPorts({ autoAck });
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, handler, options) => { signalListeners.add(handler); add(type, handler, options); };
  controller.signal.removeEventListener = (type, handler) => { signalListeners.delete(handler); remove(type, handler); };
  let nextTimer = 0, onCapture, stopped = 0, packageCancellations = 0, saved = 0;
  const messages = [], hooks = [];
  const producerUI = createPackageUI({ runtime: { connect: producers.connect, async sendMessage(message) {
    messages.push(message);
    if (message.t === 'mendosave-abort') assert.equal(message.instanceId, 'processor-fixture');
    return { ok: true };
  } } });
  const packageUI = { running: packageRun, signal: packageRun ? controller.signal : null,
    acquireProcessor: options => producerUI.acquireProcessor(options),
    send: message => producerUI.send(message),
    cancel() { packageCancellations++; controller.abort(); },
  };
  const context = vm.createContext({ document, window, AbortController, URL, crypto,
    location: new URL('https://www.youtube.com/watch?v=fixtureVideo'),
    IS_MUSIC: false, IS_SHORTS: () => true,
    MendoPackageUI: packageUI,
    chrome: { storage: { local: { async get() { return {}; } } },
      runtime: { onMessage: { addListener(handler) { runtimeListeners.add(handler); }, removeListener(handler) { runtimeListeners.delete(handler); } } } },
    setTimeout(handler) { const id = ++nextTimer; timers.set(id, handler); return id; },
    clearTimeout(id) { timers.delete(id); },
    createElement(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; },
    activeMediaElement: () => null, audioFormatMeta: () => ({ title: 'MP3', extension: '.mp3' }),
    clearReloadGuard: async () => {}, clearQueue: async () => {},
    sessionStorage: { removeItem() {} },
    safeFilename: (value) => value, sabrCarriesAudio: () => false,
    warmupMediaProcessor: () => warmup.promise,
    startTrackStaging: () => ({ async stop() { stopped++; return { failed: true }; } }),
    callHook(command, payload, progress) {
      hooks.push(command);
      if (command === 'download') { onCapture = progress; capturing.resolve(); return capture.promise; }
      return Promise.resolve({});
    },
    muxViaOffscreen: async () => { saved++; return { ok: true, filename: 'fixture.mp4' }; },
    reportError: async () => {}, console,
  });
  context.MendoMenu = require('../extension/menu.js');
  context.MendoDiagnostics = require('../extension/diagnostics.js');
  vm.runInContext(`let toastHideTimer, downloadInProgress = false; ${flow}`, context);
  const info = { title: 'Fixture', duration: 10, videoId: 'fixtureVideo', isLive: false };
  return { context, document, info, capture, capturing, warmup, controller, timers, runtimeListeners, signalListeners, messages, hooks, producers,
    stopped: () => stopped, saved: () => saved, packageCancellations: () => packageCancellations,
    progress: (message) => onCapture?.(message),
    text: () => document.querySelector('.mendosave-toast-txt')?.textContent,
    clickCancel() { document.querySelector('.mendosave-toast-cancel').dispatchEvent(new UserEvent('click')); },
    runTimers() { for (const [id, handler] of [...timers]) { timers.delete(id); handler(); } },
    run() { return context.startDownload({ format: 'mp4', height: 720 }, info); },
  };
}

test('detached YouTube warmup owns readiness and the ensure-to-warmup gap until its native work settles', async () => {
  const warmupNames = new Set(['warmupMediaProcessor', 'sendRuntimeMessage', 'sendWorkerMessage', 'isWorkerAsleep']);
  const warmupSource = declarations.filter(node => (node.type === 'FunctionDeclaration' && warmupNames.has(node.id.name))
    || (node.type === 'VariableDeclaration' && node.declarations.some(item => item.id.name === 'WORKER_RETRY_DELAYS')))
    .map(node => source.slice(...node.range)).join('\n');
  const producers = producerPorts({ autoAck: false }), messages = [];
  const ensure = deferred(), warmup = deferred();
  const context = vm.createContext({
    setTimeout() {}, clearTimeout() {},
    MendoPackageUI: createPackageUI({ runtime: { connect: producers.connect, sendMessage(message) {
      messages.push(message.t);
      assert.equal(message.instanceId, message.t === 'mendosave-warmup' ? 'processor-fixture' : undefined);
      return message.t === 'mendosave-ensure' ? ensure.promise : warmup.promise;
    } } }),
  });
  vm.runInContext(warmupSource, context);
  const running = context.warmupMediaProcessor(); await new Promise(setImmediate);
  assert.deepEqual(messages, [], 'warmup is independently safe if its parent workflow finishes early');
  const producer = producers.ports[0]; producer.receive({ ok: true, instanceId: 'processor-fixture' });
  await new Promise(setImmediate); assert.deepEqual(messages, ['mendosave-ensure']);
  assert.equal(producer.disconnected, false);
  ensure.resolve({ ok: true }); await new Promise(setImmediate);
  assert.deepEqual(messages, ['mendosave-ensure', 'mendosave-warmup']);
  assert.equal(producer.disconnected, false);
  warmup.resolve({ ok: true }); await running;
  assert.equal(producer.disconnected, true);
});

test('YouTube capture and processor warmup await producer readiness and lease survives final async cleanup', async () => {
  const h = harness(false, false);
  let cleanup;
  const pending = new Promise(resolve => { cleanup = resolve; });
  let stops = 0;
  h.context.startTrackStaging = () => ({ async stop() { if (++stops === 2) await pending; return { failed: true }; } });
  const running = h.run();
  await new Promise(setImmediate);
  assert.equal(h.hooks.includes('download'), false, 'capture must await host ready ACK');
  assert.equal(h.producers.ports.length, 1);
  h.producers.ports[0].receive({ ok: true, instanceId: 'processor-fixture' });
  await h.capturing.promise;
  h.capture.resolve({ actualHeight: 720, _v: new ArrayBuffer(1), _a: new ArrayBuffer(1) });
  while (stops < 2) await new Promise(setImmediate);
  assert.equal(h.producers.ports[0].disconnected, false);
  assert.equal(await h.run(), 'busy', 'final cleanup still owns the single workflow');
  cleanup();
  assert.equal(await running, true);
  assert.equal(h.producers.ports[0].disconnected, true);
});

test('YouTube cancellation before ready ACK waits for playlist cleanup and does not start processor work', async () => {
  const h = harness(false, false);
  let cleaned;
  const cleanup = new Promise(resolve => { cleaned = resolve; });
  h.context.clearQueue = () => cleanup;
  const running = h.run(); await new Promise(setImmediate);
  h.clickCancel(); await new Promise(setImmediate);
  assert.equal(h.producers.ports[0].disconnected, true);
  assert.equal(h.messages.length, 0);
  assert.equal(h.hooks.length, 0);
  assert.equal(await h.run(), 'busy');
  cleaned(); assert.equal(await running, false);
  h.producers.ports[0].receive({ ok: true, instanceId: 'stale-processor' });
  assert.equal(h.hooks.length, 0);
});

test('package cancellation updates the delivered toast before propagating cancellation and detaches job listeners', async () => {
  const h = harness();
  const running = h.run();
  await h.capturing.promise;
  h.controller.abort();
  const error = new Error('capture cancelled'); error.details = { cancelled: true };
  h.capture.reject(error);
  await assert.rejects(running, (caught) => caught.name === 'AbortError' || caught.cancelled === true);
  assert.equal(h.text(), 'Загрузка отменена');
  assert.equal(h.document.querySelector('.mendosave-toast-cancel').hidden, true);
  assert.equal(h.runtimeListeners.size, 0);
  assert.equal(h.signalListeners.size, 0);
  assert.ok(h.stopped() > 0);
  h.runTimers();
  assert.equal(h.document.getElementById('mendosave-toast').classList.contains('show'), false);
});

test('an old toast lease cannot overwrite, hide or cancel the next visible notification', () => {
  const h = harness(false);
  const old = h.context.getToast();
  old.beginStages('Old job', [{ id: 'capture', label: 'Old capture' }]);
  old.hide(4000);
  const queuedHide = [...h.timers.values()][0];
  const current = h.context.getToast();
  current.beginStages('New job', [{ id: 'capture', label: 'New capture' }]);
  let cancelled = 0;
  current.setCancel(() => { cancelled++; });
  old.set('Stale success', 1);
  old.beginStages('Stale preparation', [{ id: 'capture', label: 'Stale' }]);
  old.stage('capture', 1, 'done');
  old.setCancel(null);
  old.hide();
  queuedHide();
  assert.equal(h.text(), 'New job');
  assert.equal(h.document.querySelector('.mendosave-stage-label').textContent, 'New capture');
  assert.equal(h.document.getElementById('mendosave-toast').classList.contains('show'), true);
  h.clickCancel();
  assert.equal(cancelled, 1);
});

test('a terminal toast is sealed against updates while its dismissal delay runs', () => {
  const h = harness(false);
  const toast = h.context.getToast();
  toast.set('Загрузка отменена', 1);
  toast.hide(4000);
  toast.set('Late completion', 1);
  toast.beginStages('Late warmup', [{ id: 'engine', label: 'Engine' }]);
  toast.setCancel(() => {});
  assert.equal(h.text(), 'Загрузка отменена');
  assert.equal(h.document.querySelector('.mendosave-toast-cancel').hidden, true);
  h.runTimers();
  assert.equal(h.document.getElementById('mendosave-toast').classList.contains('show'), false);
});

test('floating Cancel aborts the whole package and late capture completion cannot save a file', async () => {
  const h = harness();
  const running = h.run();
  await h.capturing.promise;
  h.clickCancel();
  assert.equal(h.packageCancellations(), 1);
  assert.equal(h.controller.signal.aborted, true);
  assert.equal(h.text(), 'Отмена загрузки…');
  h.progress({ phase: 'direct-audio', progress: 1 });
  h.capture.resolve({ actualHeight: 720, _v: new ArrayBuffer(1), _a: new ArrayBuffer(1) });
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(h.saved(), 0);
  assert.equal(h.text(), 'Загрузка отменена');
  assert.ok(h.hooks.includes('sabr-cancel'));
});

test('late warmup, capture and already-dispatched runtime progress leave a later toast untouched', async () => {
  const h = harness();
  const running = h.run();
  await h.capturing.promise;
  const oldRuntimeProgress = [...h.runtimeListeners][0];
  h.controller.abort();
  h.capture.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  await assert.rejects(running, { name: 'AbortError' });
  const current = h.context.getToast();
  current.beginStages('Следующая загрузка', [{ id: 'process', label: 'Новая обработка' }]);
  current.setCancel(() => {});
  h.warmup.resolve();
  await Promise.resolve();
  h.progress({ phase: 'direct-audio', progress: 1 });
  oldRuntimeProgress({ t: 'mendosave-progress', jobId: h.messages.find((message) => message.t === 'mendosave-abort').jobId, value: 1, status: 'Late old encoder' });
  h.runTimers();
  assert.equal(h.text(), 'Следующая загрузка');
  assert.equal(h.document.querySelector('.mendosave-stage-label').textContent, 'Новая обработка');
  assert.equal(h.document.querySelector('.mendosave-toast-cancel').hidden, false);
});

test('package errors replace preparation progress and preserve cause without scheduling automatic reload', async () => {
  const h = harness();
  const running = h.run();
  await h.capturing.promise;
  const error = new Error('страница будет обновлена, загрузка продолжится автоматически');
  error.details = { reloadRequired: true, reason: 'capture-stalled' };
  h.capture.reject(error);
  await assert.rejects(running, (terminal) => terminal.cause === error && terminal.details.reason === 'capture-stalled' && /Автоматическое обновление и продолжение не выполнялись/.test(terminal.message));
  assert.match(h.text(), /Пакет остановлен/);
  assert.equal(h.messages.some((message) => ['mendosave-set-reload-download', 'mendosave-reload-tab'].includes(message.t)), false);
  assert.equal(h.signalListeners.size + h.runtimeListeners.size, 0);
  h.runTimers();
  assert.equal(h.document.getElementById('mendosave-toast').classList.contains('show'), false);
});

test('an already-aborted package never starts capture and still releases its listeners', async () => {
  const h = harness();
  h.controller.abort();
  await assert.rejects(h.run(), { name: 'AbortError' });
  assert.equal(h.hooks.includes('download'), false);
  assert.equal(h.signalListeners.size + h.runtimeListeners.size, 0);
  assert.equal(h.text(), 'Загрузка отменена');
});

test('refusing a second single download leaves the ongoing toast and completion notification usable', async () => {
  const h = harness(false);
  const first = h.run();
  await h.capturing.promise;
  assert.equal(await h.run(), 'busy');
  assert.equal(h.document.querySelector('.mendosave-toast-cancel').hidden, false);
  h.capture.resolve({ actualHeight: 720, _v: new ArrayBuffer(1), _a: new ArrayBuffer(1) });
  assert.equal(await first, true);
  assert.equal(h.text(), 'Готово: fixture.mp4');
});

test('package Cancel remains available during processing and a late successful response stays cancelled', async () => {
  const h = harness();
  const processing = deferred(), finished = deferred();
  let reportProgress;
  h.context.muxViaOffscreen = async (_job, onStage) => { reportProgress = onStage; processing.resolve(); return finished.promise; };
  const running = h.run();
  await h.capturing.promise;
  h.capture.resolve({ actualHeight: 720, _v: new ArrayBuffer(1), _a: new ArrayBuffer(1) });
  await processing.promise;
  assert.equal(h.document.querySelector('.mendosave-toast-cancel').hidden, false);
  h.clickCancel();
  reportProgress('process', 1, 'done', 'Late processor');
  assert.equal(h.text(), 'Отмена загрузки…');
  finished.resolve({ ok: true, filename: 'late.mp4' });
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(h.text(), 'Загрузка отменена');
  assert.equal(h.runtimeListeners.size + h.signalListeners.size, 0);
});

test('SABR progress and fallback are terminal after package cancellation, preserving its cancel control during processing', async () => {
  const h = harness();
  let cancelled = false;
  const notification = h.context.getToast();
  notification.beginStages('SABR', [{ id: 'capture', label: 'Capture' }]);
  let clicks = 0;
  notification.setCancel(() => { clicks++; });
  h.context.downloadViaSabr = async (job, onStage) => {
    job.onProcessing();
    assert.equal(h.document.querySelector('.mendosave-toast-cancel').hidden, false);
    cancelled = true;
    onStage('capture', 1, 'done', 'Late SABR');
    throw new Error('SABR declined after cancel');
  };
  await assert.rejects(h.context.tryDownloadViaSabr({ jobId: 'fixture-sabr', info: h.info, height: 720,
    notification, keepCancel: true, isCancelled: () => cancelled }), { name: 'AbortError' });
  assert.equal(h.document.querySelector('.mendosave-stage-label').textContent, 'Capture');
  assert.equal(h.messages.some((message) => message.tag === 'sabr'), false, 'cancellation cannot be logged as a normal fallback');
  h.clickCancel();
  assert.equal(clicks, 1);
});

test('a declined SABR processing attempt restores single-download cancellation before capture fallback', async () => {
  const h = harness(false);
  h.context.IS_SHORTS = () => false;
  h.context.downloadViaSabr = async (job) => {
    job.onProcessing();
    assert.equal(h.document.querySelector('.mendosave-toast-cancel').hidden, true);
    throw new Error('SABR output is shorter than the requested source');
  };
  const running = h.run();
  await h.capturing.promise;
  assert.equal(h.document.querySelector('.mendosave-toast-cancel').hidden, false, 'MSE fallback must regain its actual Cancel control');
  h.clickCancel();
  assert.equal(h.text(), 'Отмена загрузки…');
  assert.ok(h.hooks.includes('download-cancel'));
  assert.ok(h.hooks.includes('sabr-cancel'));
  assert.equal(h.messages.filter(message => message.t === 'mendosave-abort').length, 2);
  h.capture.reject(Object.assign(new Error('capture cancelled'), { name: 'AbortError' }));
  assert.equal(await running, false);
  assert.equal(h.saved(), 0);
  assert.equal(h.producers.ports[0].disconnected, true);
  assert.equal(h.text(), 'Загрузка отменена');
});

test('cancellation during final async cleanup cannot be replaced by a success notification', async () => {
  const h = harness();
  let guards = 0;
  h.context.clearReloadGuard = async () => { if (++guards === 2) h.controller.abort(); };
  const running = h.run();
  await h.capturing.promise;
  h.capture.resolve({ actualHeight: 720, _v: new ArrayBuffer(1), _a: new ArrayBuffer(1) });
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(h.text(), 'Загрузка отменена');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML, UserEvent } = require('./user-dom.cjs');
const { create: createUI } = require('../extension/package_ui.js');
const { producerPorts } = require('./producer-port-harness.cjs');
function create(options) {
  return createUI({ ...options, runtime: { connect: producerPorts().connect, ...options.runtime } });
}
const fs = require('node:fs');
const vm = require('node:vm');

test('Blob preparation waits for producer readiness and retains its lease until native finish settles', async () => {
  const transport = producerPorts({ autoAck: false }), calls = [];
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const ui = create({ runtime: { connect: transport.connect,
    async sendMessage(message) {
      if (message.t.startsWith('mendosave-blob-')) assert.equal(message.instanceId, 'processor-fixture');
      calls.push(message.t); if (message.t === 'mendosave-blob-finish') await pending; return { ok: true, filename: 'clip.mp4' };
    },
  } });
  const saving = ui.saveBlob(new Blob(['bytes']), 'clip.mp4');
  await new Promise(setImmediate);
  assert.deepEqual(calls, [], 'no ensure, transfer or save before host ready ACK');
  const producer = transport.ports.find(port => port.name === 'mendosave-producer');
  assert.ok(producer);
  producer.receive({ ok: true, instanceId: 'processor-fixture' });
  await new Promise(setImmediate);
  assert.equal(calls.at(-1), 'mendosave-blob-finish');
  assert.equal(producer.disconnected, false, 'Save As finish still owns the idle host gap');
  finish();
  assert.equal(await saving, 'clip.mp4');
  assert.equal(producer.disconnected, true);
});

test('one package producer covers readiness, gaps between items and asynchronous package finish', async () => {
  const { document } = parseHTML('<html><body><div id="menu"></div></body></html>');
  const transport = producerPorts({ autoAck: false }), calls = [];
  let next, finish;
  const nextGap = new Promise(resolve => { next = resolve; });
  const finishing = new Promise(resolve => { finish = resolve; });
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: {
    connect: transport.connect,
    async sendMessage(message) {
      if (message.t.startsWith('mendosave-package-')) assert.equal(message.instanceId, 'processor-fixture');
      calls.push(message.t);
      if (message.t === 'mendosave-package-next' && message.index === 1) await nextGap;
      if (message.t === 'mendosave-package-finish') await finishing;
      return { ok: true };
    },
  } });
  ui.add(document.getElementById('menu'), { title: 'Clip', options: ['video', 'audio'].map(id => ({ id, label: id, async run() { calls.push(id); return `${id}.file`; } })) });
  document.querySelector('.mendo-package-open').click();
  for (const input of document.querySelectorAll('input')) { input.checked = true; input.dispatchEvent(new document.defaultView.Event('change')); }
  document.querySelector('[data-mode="files"]').click();
  await new Promise(setImmediate);
  assert.deepEqual(calls, [], 'no package setup before processor ACK');
  const producer = transport.ports.find(port => port.name === 'mendosave-producer');
  producer.receive({ ok: true, instanceId: 'processor-fixture' });
  while (calls.filter(name => name === 'mendosave-package-next').length < 2) await new Promise(setImmediate);
  assert.equal(producer.disconnected, false, 'host remains reserved between separate files');
  next();
  while (!calls.includes('mendosave-package-finish')) await new Promise(setImmediate);
  assert.equal(producer.disconnected, false, 'package save cleanup is still pending');
  finish();
  while (ui.running) await new Promise(setImmediate);
  assert.equal(producer.disconnected, true);
  assert.equal(transport.ports.filter(port => port.name === 'mendosave-producer').length, 1);
});

test('producer acquisition aborts a pending ACK and ignores its late response without touching the next lease', async () => {
  const transport = producerPorts({ autoAck: false }), controller = new AbortController();
  const ui = create({ runtime: { connect: transport.connect } });
  const acquiring = ui.acquireProcessor({ signal: controller.signal });
  controller.abort();
  await assert.rejects(acquiring, { name: 'AbortError' });
  assert.equal(transport.ports[0].disconnected, true);
  let broken = 0;
  const next = ui.acquireProcessor({ onDisconnect() { broken++; } });
  transport.ports[0].receive({ ok: true, instanceId: 'stale-processor' });
  transport.ports[1].receive({ ok: true, instanceId: 'next-processor' });
  const lease = await next;
  assert.equal(lease.instanceId, 'next-processor');
  assert.equal(transport.ports[1].disconnected, false);
  lease.release(); lease.release();
  assert.equal(broken, 0, 'intentional release is not host failure');
});

test('producer sends bind processor packets to the acquired instance without tagging background-only routes', async () => {
  const transport = producerPorts({ autoAck: false }), calls = [];
  const ui = create({ runtime: { connect: transport.connect,
    async sendMessage(message) { calls.push(message); return { ok: true }; },
  } });
  const firstReady = ui.acquireProcessor(); transport.ports[0].receive({ ok: true, instanceId: 'old-processor' });
  const first = await firstReady;
  assert.equal(typeof first.send, 'function', 'lease owns its immutable sender');
  await first.send({ t: 'mendosave-stage-open', jobId: 'old-job' });
  first.release();
  const secondReady = ui.acquireProcessor(); transport.ports[1].receive({ ok: true, instanceId: 'new-processor' });
  const second = await secondReady;
  await second.send({ t: 'mendosave-stage-open', jobId: 'new-job' });
  await first.send({ t: 'mendosave-abort', jobId: 'old-job' });
  await second.send({ t: 'mendosave-ensure' }); await second.send({ t: 'mendosave-log', text: 'bounded' });
  assert.deepEqual(calls.map(message => [message.t, message.instanceId]), [
    ['mendosave-stage-open', 'old-processor'], ['mendosave-stage-open', 'new-processor'],
    ['mendosave-abort', 'old-processor'], ['mendosave-ensure', undefined], ['mendosave-log', undefined],
  ]);
  await assert.rejects(first.send({ t: 'mendosave-chunk', jobId: 'old-job' }), /lease|producer/i);
  await assert.rejects(ui.send({ t: 'mendosave-stage-open', jobId: 'unbound' }), /producer/i);
  second.release();
});

test('failed or invalid ACK and early disconnect reject the producer reservation', async (t) => {
  for (const failure of ['invalid', 'error', 'disconnect']) await t.test(failure, async () => {
    const transport = producerPorts({ autoAck: false });
    const ui = create({ runtime: { connect: transport.connect } });
    const acquiring = ui.acquireProcessor();
    if (failure === 'disconnect') transport.ports[0].disconnect();
    else transport.ports[0].receive(failure === 'error' ? { ok: false, error: 'host unavailable' } : { ok: true, instanceId: '' });
    await assert.rejects(acquiring);
    assert.equal(transport.ports[0].disconnected, true);
  });
});

test('producer readiness timeout disconnects the reservation and ignores a late ACK', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = producerPorts({ autoAck: false });
  const ui = create({ runtime: { connect: transport.connect } });
  let broken = 0;
  const acquiring = ui.acquireProcessor({ onDisconnect() { broken++; } });
  const rejected = assert.rejects(acquiring, /готовность вовремя/);
  t.mock.timers.tick(29_999);
  assert.equal(transport.ports[0].disconnected, false);
  t.mock.timers.tick(1); await rejected;
  assert.equal(transport.ports[0].disconnected, true);
  transport.ports[0].receive({ ok: true, instanceId: 'late-processor' });
  assert.equal(broken, 0);
});

test('a ready producer stays reserved after caller abort until its explicit cleanup release', async () => {
  const transport = producerPorts(), controller = new AbortController();
  let failures = 0;
  const ui = create({ runtime: { connect: transport.connect } });
  const lease = await ui.acquireProcessor({ signal: controller.signal, onDisconnect() { failures++; } });
  controller.abort();
  assert.equal(transport.ports[0].disconnected, false, 'caller owns the abort cleanup lifetime');
  transport.ports[0].disconnect(); transport.ports[0].disconnect();
  assert.equal(failures, 1, 'unexpected host loss is delivered only once');
  lease.release();
});

test('missing connect fails producer acquisition instead of starting a legacy unleased processor', async () => {
  const ui = createUI({ runtime: {} });
  await assert.rejects(ui.acquireProcessor(), /connect/);
});

test('Blob host loss during asynchronous byte reading prevents a later chunk or finish', async () => {
  const transport = producerPorts(), calls = [];
  let read;
  const reading = new Promise(resolve => { read = resolve; });
  const blob = { type: 'video/mp4', size: 3, slice: () => ({ arrayBuffer: () => reading }) };
  const ui = create({ runtime: { connect: transport.connect,
    async sendMessage(message) { calls.push(message.t); return { ok: true }; },
  } });
  const saving = ui.saveBlob(blob, 'clip.mp4');
  const rejected = assert.rejects(saving, /Связь с обработчиком/);
  while (!calls.includes('mendosave-blob-open')) await new Promise(setImmediate);
  transport.ports[0].disconnect(); read(Uint8Array.of(1, 2, 3).buffer); await rejected;
  assert.deepEqual(calls, ['mendosave-ensure', 'mendosave-blob-open', 'mendosave-blob-abort']);
});

test('Blob transfer ID creation failure releases a ready producer without opening host transfer state', async () => {
  const transport = producerPorts(), calls = [];
  const context = vm.createContext({ module: { exports: {} }, AbortController, setTimeout, clearTimeout,
    crypto: { randomUUID() { throw new Error('UUID unavailable'); } },
  });
  vm.runInContext(fs.readFileSync('extension/package_ui.js', 'utf8'), context);
  const ui = context.module.exports.create({ runtime: { connect: transport.connect,
    async sendMessage(message) { calls.push(message.t); return { ok: true }; },
  } });
  await assert.rejects(ui.saveBlob(new Blob(['bytes']), 'clip.mp4'), /UUID unavailable/);
  assert.equal(transport.ports[0].disconnected, true);
  assert.deepEqual(calls, []);
});

test('Blob abort cleanup settles before releasing its processor lease', async () => {
  const transport = producerPorts(), calls = [];
  let cleanup;
  const aborting = new Promise(resolve => { cleanup = resolve; });
  const ui = create({ runtime: { connect: transport.connect,
    async sendMessage(message) {
      calls.push(message.t);
      if (message.t === 'mendosave-blob-chunk') throw new Error('write failed');
      if (message.t === 'mendosave-blob-abort') await aborting;
      return { ok: true };
    },
  } });
  const saving = ui.saveBlob(new Blob(['bytes']), 'clip.mp4');
  const rejected = assert.rejects(saving, /write failed/);
  while (!calls.includes('mendosave-blob-abort')) await new Promise(setImmediate);
  assert.equal(transport.ports[0].disconnected, false);
  cleanup(); await rejected;
  assert.equal(transport.ports[0].disconnected, true);
});

test('package early producer disconnect prevents overlap until cancellation cleanup settles and ignores stale ACK', async () => {
  const { document } = parseHTML('<html><body><div id="menu"></div></body></html>');
  const transport = producerPorts({ autoAck: false }), calls = [];
  let cleanup, items = 0;
  const pending = new Promise(resolve => { cleanup = resolve; });
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: {
    connect: transport.connect,
    async sendMessage(message) { calls.push(message.t); if (message.t === 'mendosave-package-cancel') await pending; return { ok: true }; },
  } });
  ui.add(document.getElementById('menu'), { title: 'Clip', options: ['video', 'audio'].map(id => ({ id, label: id,
    async run() {
      if (++items === 1) await new Promise((resolve, reject) => ui.signal.addEventListener('abort', () => {
        const error = new Error('cancelled'); error.name = 'AbortError'; reject(error);
      }, { once: true }));
      return `${id}.file`;
    },
  })) });
  document.querySelector('.mendo-package-open').click();
  const input = document.querySelector('input'); input.checked = true; input.dispatchEvent(new document.defaultView.Event('change'));
  const start = document.querySelector('[data-mode="files"]'); start.click();
  transport.ports[0].receive({ ok: true, instanceId: 'old-processor' });
  while (!items) await new Promise(setImmediate);
  transport.ports[0].disconnect(); await new Promise(setImmediate);
  assert.equal(ui.running, true);
  assert.equal(calls.includes('mendosave-package-cancel'), true);
  start.click(); assert.equal(transport.ports.filter(port => port.name === 'mendosave-producer').length, 1);
  assert.equal(items, 1);
  cleanup(); while (ui.running) await new Promise(setImmediate);
  start.click(); transport.ports[0].receive({ ok: true, instanceId: 'stale-processor' });
  await new Promise(setImmediate); assert.equal(items, 1);
  const nextProducer = transport.ports.filter(port => port.name === 'mendosave-producer')[1];
  nextProducer.receive({ ok: true, instanceId: 'new-processor' });
  while (ui.running) await new Promise(setImmediate);
  assert.equal(items, 2);
  assert.equal(nextProducer.disconnected, true);
});

test('page Blob bytes go through the owned host before reporting a saved file', async () => {
  const calls = [];
  const ui = create({ runtime: { async sendMessage(message) { calls.push(message); return { ok: true, filename: message.filename || 'clip.mp4', id: 42 }; } } });
  assert.equal(await ui.saveBlob(new Blob([new Uint8Array([1, 2, 255])], { type: 'video/mp4' }), 'clip.mp4'), 'clip.mp4');
  assert.deepEqual(calls.map(message => message.t), ['mendosave-ensure', 'mendosave-blob-open', 'mendosave-blob-chunk', 'mendosave-blob-finish']);
  assert.equal(calls[1].size, 3);
  assert.equal(calls[2].data, 'AQL/');
  assert.equal(calls[2].sequence, 0);
  assert.equal(calls[1].transferId, calls[3].transferId);
});

test('Gecko foreign Blob buffers preserve exact bytes across bounded transfer chunks', async () => {
  const foreignBuffers = new WeakSet(), calls = [];
  function ContentUint8Array(input, offset, length) {
    const view = new Uint8Array(input, offset, length);
    if (foreignBuffers.has(input)) Object.defineProperty(view, 'constructor', {
      get() { throw new Error('Permission denied to access property "constructor"'); },
    });
    return view;
  }
  const source = Uint8Array.from({ length: 1024 ** 2 + 13 }, (_, i) => (i * 13 + 17) & 255);
  const blob = new Blob([source], { type: 'video/mp4' });
  const slice = blob.slice.bind(blob);
  blob.slice = (...args) => {
    const part = slice(...args), read = part.arrayBuffer.bind(part);
    part.arrayBuffer = async () => { const buffer = await read(); foreignBuffers.add(buffer); return buffer; };
    return part;
  };
  const context = vm.createContext({ module: { exports: {} }, Uint8Array: ContentUint8Array, crypto, btoa,
    AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync('extension/package_ui.js', 'utf8'), context);
  const ui = context.module.exports.create({ runtime: {
    connect: producerPorts().connect,
    async sendMessage(message) { calls.push(message); return { ok: true, filename: 'foreign.mp4' }; },
  } });
  assert.equal(await ui.saveBlob(blob, 'foreign.mp4'), 'foreign.mp4');
  const chunks = calls.filter(message => message.t === 'mendosave-blob-chunk');
  assert.deepEqual(chunks.map(message => message.sequence), [0, 1]);
  assert.deepEqual(Buffer.concat(chunks.map(message => Buffer.from(message.data, 'base64'))), Buffer.from(source));
  assert.equal(calls.some(message => message.t === 'mendosave-blob-abort'), false);
  assert.equal(calls.at(-1).t, 'mendosave-blob-finish');
});

test('checkboxes keep the menu open and start only the explicitly selected formats in order', async () => {
  const { document } = parseHTML('<html><body><div id="menu"></div></body></html>');
  const calls = [];
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: {
    async sendMessage(message) { calls.push(message.t); return { ok: true }; },
  } });
  ui.add(document.getElementById('menu'), { title: 'Clip', close() {}, options: ['720p', 'MP3', 'SRT'].map(label => ({
    id: label, label, async run() { calls.push(label); return `${label}.file`; },
  })) });
  document.querySelector('.mendo-package-open').click();
  const inputs = [...document.querySelectorAll('.mendo-package-dialog input')];
  inputs[0].checked = true; inputs[1].checked = true;
  inputs[1].dispatchEvent(new document.defaultView.Event('change'));
  assert.ok(document.querySelector('.mendo-package-dialog'));
  document.querySelector('[data-mode="files"]').click();
  while (ui.running) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.filter(call => ['720p', 'MP3', 'SRT'].includes(call)), ['720p', 'MP3']);
  assert.equal(document.querySelector('[role="status"]').textContent.includes('Готово'), true);
});

test('cancellation during host startup, the next item and final ZIP saving unlocks the same picker after the pending operation settles', async (t) => {
  for (const phase of ['start', 'next', 'finish']) await t.test(phase, async () => {
    const { document } = parseHTML('<html><body><div id="menu"></div></body></html>');
    let release, reached, blocked = false;
    const pending = new Promise(resolve => { release = resolve; });
    const gate = new Promise(resolve => { reached = resolve; });
    const calls = [];
    const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: {
      async sendMessage(message) {
        calls.push(message);
        const target = phase === 'start' ? message.t === 'mendosave-package-begin'
          : phase === 'next' ? message.t === 'mendosave-package-next' && message.index === 1
            : message.t === 'mendosave-package-finish';
        if (target && !blocked) { blocked = true; reached(); await pending; }
        return { ok: true, filename: 'clip.zip' };
      },
    } });
    ui.add(document.getElementById('menu'), { title: 'Clip', options: ['video', 'audio'].map(id => ({ id, label: id, async run() { return `${id}.file`; } })) });
    document.querySelector('.mendo-package-open').click();
    const dialog = document.querySelector('dialog'), inputs = [...dialog.querySelectorAll('input')];
    for (const input of inputs) { input.checked = true; input.dispatchEvent(new document.defaultView.Event('change')); }
    dialog.querySelector('[data-mode="zip"]').click();
    await gate;
    dialog.querySelector('[data-action="cancel"]').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.running, true);
    assert.equal(inputs.every(input => input.disabled), true);
    assert.equal(dialog.querySelector('[data-action="back"]').disabled, true, 'pending cleanup cannot return to a new single job');
    assert.equal(dialog.querySelector('[data-action="close"]').disabled, true);
    assert.equal(document.querySelector('.mendo-package-resume [data-action="close"]').disabled, true);
    dialog.querySelector('[data-action="back"]').click();
    assert.ok(dialog.isConnected);
    dialog.querySelector('[data-mode="files"]').click();
    assert.equal(calls.filter(message => message.t === 'mendosave-package-begin').length, 1);
    release();
    while (ui.running) await new Promise(resolve => setImmediate(resolve));
    assert.match(dialog.querySelector('[role="status"]').textContent, /Пакет отменён/);
    assert.equal(inputs.every(input => input.checked && !input.disabled), true);
    assert.equal(dialog.querySelector('[data-action="back"]').disabled, false);
    assert.equal(dialog.querySelector('[data-action="close"]').disabled, false);
    assert.equal(document.querySelector('.mendo-package-resume [data-action="close"]').disabled, false);
    assert.equal(dialog.querySelector('[data-mode="zip"]').disabled, false);
    dialog.querySelector('[data-mode="files"]').click();
    while (ui.running) await new Promise(resolve => setImmediate(resolve));
    assert.equal(document.querySelector('dialog'), dialog);
    assert.match(dialog.querySelector('[role="status"]').textContent, /Готово: 2 файлов/);
    const packages = calls.filter(message => message.t === 'mendosave-package-begin');
    assert.equal(packages.length, 2);
    assert.notEqual(packages[0].packageId, packages[1].packageId);
  });
});

test('a hidden package error remains visible on the resume control and reopens the editable picker', async () => {
  const { document } = parseHTML('<html><body><div id="menu"></div></body></html>');
  let reject, entered;
  const pending = new Promise((resolve, no) => { reject = no; });
  const started = new Promise(resolve => { entered = resolve; });
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: { async sendMessage() { return { ok: true }; } } });
  ui.add(document.getElementById('menu'), { title: 'Clip', options: [
    { id: 'fail', label: 'video', async run() { entered(); return pending; } },
    { id: 'audio', label: 'audio', async run() { return 'audio.file'; } },
  ] });
  document.querySelector('.mendo-package-open').click();
  const dialog = document.querySelector('dialog'), input = dialog.querySelector('input');
  input.checked = true; input.dispatchEvent(new document.defaultView.Event('change'));
  dialog.querySelector('[data-mode="files"]').click();
  await started;
  dialog.querySelector('[data-action="hide"]').click();
  reject(new Error('source unavailable'));
  while (ui.running) await new Promise(resolve => setImmediate(resolve));
  const resume = document.querySelector('.mendo-package-resume');
  assert.equal(resume.hidden, false);
  assert.match(resume.textContent, /Ошибка: source unavailable/);
  resume.click();
  assert.equal(document.querySelector('dialog'), dialog);
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(input.checked && !input.disabled, true);
  assert.equal(dialog.querySelector('[data-mode="files"]').disabled, false);
});

test('an idle hidden picker is reused for the same material and replaced for a different material even with an equal title', async () => {
  const { document } = parseHTML('<html><body><div id="menu"></div></body></html>');
  const ran = [];
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: { async sendMessage() { return { ok: true }; } } });
  const add = (source) => ui.add(document.getElementById('menu'), { title: 'Same title', source,
    options: ['video', 'audio'].map(id => ({ id, label: id, async run() { ran.push(source); return `${source}.${id}`; } })) });
  const first = add('material-A'); first.click();
  const old = document.querySelector('dialog'), input = old.querySelector('input');
  input.checked = true; input.dispatchEvent(new document.defaultView.Event('change'));
  old.querySelector('[data-action="hide"]').click();
  add('material-A').click();
  assert.equal(document.querySelector('dialog'), old);
  assert.equal(input.checked, true);
  old.querySelector('[data-action="hide"]').click();
  add('material-B').click();
  const next = document.querySelector('dialog');
  assert.notEqual(next, old);
  assert.equal(document.querySelectorAll('dialog').length, 1);
  assert.equal(document.querySelectorAll('.mendo-package-resume').length, 1);
  const selection = next.querySelector('input');
  assert.equal(Boolean(selection.checked), false);
  selection.checked = true; selection.dispatchEvent(new document.defaultView.Event('change'));
  next.querySelector('[data-mode="files"]').click();
  while (ui.running) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ran, ['material-B']);
});

test('a restarted picker replaces its previous terminal status before awaiting host startup', async () => {
  const { document } = parseHTML('<html><body><div id="menu"></div></body></html>');
  let hold = false, release;
  const pending = new Promise(resolve => { release = resolve; });
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: {
    async sendMessage(message) { if (hold && message.t === 'mendosave-ensure') await pending; return { ok: true }; },
  } });
  ui.add(document.getElementById('menu'), { title: 'Clip', options: ['video', 'audio'].map(id => ({ id, label: id, async run() { return `${id}.file`; } })) });
  document.querySelector('.mendo-package-open').click();
  const dialog = document.querySelector('dialog'), input = dialog.querySelector('input');
  input.checked = true; input.dispatchEvent(new document.defaultView.Event('change'));
  dialog.querySelector('[data-mode="files"]').click();
  while (ui.running) await new Promise(resolve => setImmediate(resolve));
  assert.match(dialog.querySelector('[role="status"]').textContent, /Готово/);
  hold = true;
  dialog.querySelector('[data-mode="files"]').click();
  assert.equal(ui.running, true);
  assert.doesNotMatch(dialog.querySelector('[role="status"]').textContent, /Готово|Ошибка|Пакет отменён/);
  assert.match(document.querySelector('.mendo-package-resume').textContent, /Подготавливаю пакет/);
  release();
  while (ui.running) await new Promise(resolve => setImmediate(resolve));
});

test('opening the picker captures the currently selected format settings', async () => {
  const { document } = parseHTML('<html><body><div id="menu"></div></body></html>');
  let codec = false;
  const ran = [];
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: {
    async sendMessage() { return { ok: true }; },
  } });
  const opener = ui.add(document.getElementById('menu'), { title: 'Clip', close() {}, options() {
    const selectedCodec = codec;
    return [{ id: 'video', label: selectedCodec ? 'H.264/AAC' : 'Original', async run() { ran.push(selectedCodec); return 'video.mp4'; } },
      { id: 'audio', label: 'MP3', async run() { return 'audio.mp3'; } }];
  } });
  assert.ok(opener);
  codec = true; opener.click();
  assert.match(document.querySelector('.mendo-package-list').textContent, /H.264\/AAC/);
  codec = false;
  const input = document.querySelector('.mendo-package-dialog input');
  input.checked = true; input.dispatchEvent(new document.defaultView.Event('change'));
  document.querySelector('[data-mode="files"]').click();
  while (ui.running) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ran, [true]);
});

test('cancelled files and ZIP can be edited and restarted in the same picker only after cancellation settles', async (t) => {
  for (const mode of ['files', 'zip']) await t.test(mode, async () => {
    const { document } = parseHTML('<html><body><div id="menu"></div></body></html>');
    const calls = [], signals = [];
    let releaseCancellation;
    const cancellation = new Promise(resolve => { releaseCancellation = resolve; });
    const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: {
      async sendMessage(message) {
        calls.push(message);
        if (message.t === 'mendosave-package-cancel') await cancellation;
        return { ok: true, filename: 'clip.zip' };
      },
    } });
    let attempts = 0;
    ui.add(document.getElementById('menu'), { title: 'Clip', options: [
      { id: 'video', label: 'Video', async run() {
        signals.push(ui.signal);
        if (++attempts === 1) await new Promise((resolve, reject) => {
          ui.signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); }, { once: true });
        });
        return 'video.mp4';
      } },
      { id: 'text', label: 'TXT', async run() { return 'text.txt'; } },
    ] });
    document.querySelector('.mendo-package-open').click();
    const dialog = document.querySelector('.mendo-package-dialog');
    const inputs = [...dialog.querySelectorAll('input')];
    for (const input of inputs) { input.checked = true; input.dispatchEvent(new document.defaultView.Event('change')); }
    dialog.querySelector(`[data-mode="${mode}"]`).click();
    while (!signals.length) await new Promise(resolve => setImmediate(resolve));
    [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Отменить пакет').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.running, true, 'pending cancellation keeps the old run owned');
    assert.ok(inputs.every(input => input.disabled));
    dialog.querySelector('[data-mode="files"]').click();
    assert.equal(attempts, 1, 'a second run cannot overlap cancellation');
    releaseCancellation();
    while (ui.running) await new Promise(resolve => setImmediate(resolve));
    assert.ok(inputs.every(input => !input.disabled), 'selection becomes editable after cancellation');
    assert.ok(inputs.every(input => input.checked), 'the previous selection is retained');
    assert.equal(dialog.querySelector('[data-mode="files"]').disabled, false);
    assert.equal(dialog.querySelector('[data-mode="zip"]').disabled, false);
    assert.match(dialog.querySelector('[role="status"]').textContent, /Пакет отменён/);
    dialog.querySelector(`[data-mode="${mode === 'files' ? 'zip' : 'files'}"]`).click();
    while (ui.running) await new Promise(resolve => setImmediate(resolve));
    assert.equal(document.querySelector('.mendo-package-dialog'), dialog);
    assert.match(dialog.querySelector('[role="status"]').textContent, /Готово/);
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0], signals[1]);
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    const starts = calls.filter(message => message.t === 'mendosave-package-begin');
    assert.equal(starts.length, 2);
    assert.notEqual(starts[0].packageId, starts[1].packageId);
  });
});

test('Hide and Escape keep one nonmodal package running and expose its hidden completion', async () => {
  const { document } = parseHTML('<html><body><div id="menu"></div><button id="page">Page control</button></body></html>');
  const createElement = document.createElement.bind(document);
  let modalCalls = 0, release;
  document.createElement = name => {
    const element = createElement(name);
    if (name === 'dialog') {
      element.showModal = () => { modalCalls++; element.setAttribute('open', ''); };
      element.show = () => element.setAttribute('open', '');
      element.close = () => element.removeAttribute('open');
    }
    return element;
  };
  const calls = [];
  const processing = new Promise(resolve => { release = resolve; });
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: {
    async sendMessage(message) { calls.push(message); return { ok: true }; },
  } });
  const opener = ui.add(document.getElementById('menu'), { title: 'Clip', options: [
    { id: 'video', label: 'Video', async run() { await processing; return 'video.mp4'; } },
    { id: 'text', label: 'TXT', async run() { return 'text.txt'; } },
  ] });
  opener.click();
  const dialog = document.querySelector('.mendo-package-dialog');
  assert.equal(modalCalls, 0, 'the picker does not make the page inert');
  const input = dialog.querySelector('input');
  input.checked = true; input.dispatchEvent(new document.defaultView.Event('change'));
  dialog.querySelector('[data-mode="files"]').click();
  while (!calls.some(message => message.t === 'mendosave-package-next')) await new Promise(resolve => setImmediate(resolve));
  const originalSignal = ui.signal;
  dialog.querySelector('[data-action="hide"]').click();
  assert.equal(dialog.hasAttribute('open'), false);
  assert.equal(ui.running, true);
  assert.equal(originalSignal.aborted, false);
  opener.click();
  assert.equal(document.querySelectorAll('.mendo-package-dialog').length, 1);
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(ui.signal, originalSignal);
  const escape = new UserEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(escape, 'key', { value: 'Escape' });
  dialog.dispatchEvent(escape);
  assert.equal(dialog.hasAttribute('open'), false);
  release();
  while (ui.running) await new Promise(resolve => setImmediate(resolve));
  const resume = document.querySelector('.mendo-package-resume');
  assert.equal(resume.hidden, false);
  assert.match(resume.textContent, /Готово/);
  resume.click();
  assert.equal(dialog.hasAttribute('open'), true);
  assert.match(dialog.querySelector('[role="status"]').textContent, /Готово/);
  assert.equal(calls.filter(message => message.t === 'mendosave-package-begin').length, 1);
  assert.equal(calls.some(message => message.t === 'mendosave-package-cancel'), false);
});

test('late old runtime responses and progress cannot attach to the restarted package', async () => {
  const { document } = parseHTML('<html><body><div id="menu"></div></body></html>');
  const listeners = new Set();
  let oldResponse, finishNewRun, attempts = 0;
  const staleBegin = new Promise(resolve => { oldResponse = resolve; });
  const newRun = new Promise(resolve => { finishNewRun = resolve; });
  let oldSend;
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: {
    onMessage: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
    async sendMessage(message) { if (message.jobId === 'old-job') return staleBegin; return { ok: true }; },
  } });
  ui.add(document.getElementById('menu'), { title: 'Clip', options: [
    { id: 'video', label: 'Video', async run() {
      if (++attempts === 1) {
        const producer = await ui.acquireProcessor({ signal: ui.signal });
        oldSend = producer.send({ t: 'mendosave-begin', jobId: 'old-job' }).catch(error => error);
        try {
          await new Promise((resolve, reject) => ui.signal.addEventListener('abort', () => {
            const error = new Error('cancelled'); error.name = 'AbortError'; reject(error);
          }, { once: true }));
        } finally { producer.release(); }
      } else await newRun;
      return 'video.mp4';
    } },
    { id: 'text', label: 'TXT', async run() { return 'text.txt'; } },
  ] });
  document.querySelector('.mendo-package-open').click();
  const dialog = document.querySelector('dialog');
  const input = dialog.querySelector('input'); input.checked = true; input.dispatchEvent(new document.defaultView.Event('change'));
  dialog.querySelector('[data-mode="files"]').click();
  while (!oldSend) await new Promise(resolve => setImmediate(resolve));
  dialog.querySelector('[data-action="cancel"]').click();
  while (ui.running) await new Promise(resolve => setImmediate(resolve));
  dialog.querySelector('[data-mode="files"]').click();
  while (attempts < 2) await new Promise(resolve => setImmediate(resolve));
  oldResponse({ ok: true }); await oldSend;
  const status = dialog.querySelector('[role="status"]');
  const before = status.textContent;
  for (const listener of listeners) listener({ t: 'mendosave-progress', jobId: 'old-job', value: .97, status: 'OLD RUN' });
  assert.equal(status.textContent, before);
  finishNewRun();
  while (ui.running) await new Promise(resolve => setImmediate(resolve));
  assert.equal(listeners.size, 0);
});

test('Back reconstructs the current source menu and focuses a live opener without starting work', async () => {
  const { document } = parseHTML('<html><body></body></html>');
  const packets = [], ran = [];
  let source = 'material-A', focused;
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: {
    async sendMessage(message) { packets.push(message); return { ok: true }; },
  } });
  const render = () => {
    const menu = document.createElement('div'); menu.dataset.source = source; document.body.append(menu);
    const opener = ui.add(menu, { title: 'Same title', source, close() { menu.remove(); },
      back() { return render(); }, options: ['video', 'audio'].map(id => ({ id, label: `${source} ${id}`,
        async run() { ran.push(source); return `${id}.file`; } })) });
    opener.focus = () => { focused = opener; };
    return opener;
  };
  const oldOpener = render(); oldOpener.click();
  assert.equal(oldOpener.isConnected, false);
  const back = document.querySelector('[data-action="back"]');
  assert.ok(back, 'the header provides an explicit return action');
  assert.equal(back.textContent, '← Назад');
  assert.equal(document.querySelector('[data-action="cancel"]').hidden, true, 'idle footer has no equal Close action');
  source = 'material-B'; back.click(); await new Promise(setImmediate);
  const liveOpener = document.querySelector('.mendo-package-open');
  assert.ok(liveOpener?.isConnected); assert.ok(focused === liveOpener);
  assert.equal(liveOpener.parentElement.dataset.source, 'material-B');
  assert.equal(document.querySelectorAll('dialog').length, 0);
  assert.equal(document.querySelectorAll('.mendo-package-resume').length, 0);
  assert.deepEqual(packets, []); assert.deepEqual(ran, []);
});

test('returning to the picker refreshes idle settings and retains only compatible choices for that source', async () => {
  const { document } = parseHTML('<html><body></body></html>');
  let codec = 'original', language = 'en', source = 'A', focus;
  const ran = [];
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: {
    async sendMessage() { return { ok: true }; },
  } });
  const render = () => {
    const menu = document.createElement('div'); document.body.append(menu);
    const opener = ui.add(menu, { title: 'Same title', source, close() { menu.remove(); }, back() { return render(); }, options() {
      const capturedCodec = codec, capturedLanguage = language;
      return [
        { id: 'video', label: capturedCodec, async run() { ran.push(capturedCodec); return 'video.mp4'; } },
        { id: 'subtitle', compatibilityKey: `subtitle:${capturedLanguage}`, label: capturedLanguage,
          async run() { ran.push(capturedLanguage); return 'subtitle.txt'; } },
      ];
    } });
    opener.focus = () => { focus = opener; }; return opener;
  };
  render().click();
  for (const input of document.querySelectorAll('input')) { input.checked = true; input.dispatchEvent(new document.defaultView.Event('change')); }
  document.querySelector('[data-action="back"]')?.click(); await new Promise(setImmediate);
  assert.ok(document.querySelector('.mendo-package-open'), 'Back returns to single choices');
  codec = 'H.264/AAC'; language = 'ru'; focus.click();
  let inputs = [...document.querySelectorAll('input')];
  assert.equal(inputs[0].checked, true, 'compatible video choice survives refreshed codec settings');
  assert.equal(Boolean(inputs[1].checked), false, 'a changed subtitle track is a different choice');
  assert.match(document.querySelector('.mendo-package-list').textContent, /H\.264\/AAC/);
  document.querySelector('[data-mode="files"]').click();
  while (ui.running) await new Promise(setImmediate);
  assert.deepEqual(ran, ['H.264/AAC'], 'the new plan uses current settings');
  document.querySelector('[data-action="back"]').click(); await new Promise(setImmediate);
  source = 'B'; render().click(); inputs = [...document.querySelectorAll('input')];
  assert.ok(inputs.every(input => !input.checked), 'equal titles cannot transfer selection to another source');
});

test('late queue callbacks cannot replace a newer run status or prepared row', async () => {
  const { document } = parseHTML('<html><body><div id="menu"></div></body></html>');
  const callbacks = [], calls = [];
  let finishText, textEntered;
  const textPending = new Promise(resolve => { finishText = resolve; });
  const entered = new Promise(resolve => { textEntered = resolve; });
  const queue = require('../extension/package_queue.js');
  const ui = create({ document, queue: { run(items, effects) { callbacks.push(effects); return queue.run(items, effects); } }, runtime: {
    async sendMessage(message) { calls.push(message); return { ok: true }; },
  } });
  ui.add(document.getElementById('menu'), { title: 'Clip', options: [
    { id: 'video', label: 'Video', async run() { return 'video.mp4'; } },
    { id: 'text', label: 'Text', async run() { textEntered(); await textPending; return 'text.txt'; } },
  ] });
  document.querySelector('.mendo-package-open').click();
  const dialog = document.querySelector('dialog'), inputs = [...dialog.querySelectorAll('input')];
  const change = (input, checked) => { input.checked = checked; input.dispatchEvent(new document.defaultView.Event('change')); };
  change(inputs[0], true); dialog.querySelector('[data-mode="files"]').click();
  while (ui.running) await new Promise(setImmediate);
  change(inputs[0], false); change(inputs[1], true); dialog.querySelector('[data-mode="files"]').click(); await entered;
  const status = dialog.querySelector('[role="status"]'), before = status.textContent;
  callbacks[0].onChange({ phase: 'processing', index: 0 });
  assert.equal(status.textContent, before, 'a completed run cannot re-publish its old choice');
  await assert.rejects(callbacks[0].complete(0), { name: 'AbortError' });
  assert.equal(status.textContent, before);
  assert.equal(dialog.querySelector('[data-action="back"]').disabled, true);
  finishText(); while (ui.running) await new Promise(setImmediate);
  assert.equal(dialog.querySelector('[data-action="back"]').disabled, false);
  assert.equal(calls.filter(message => message.t === 'mendosave-package-begin').length, 2);
});

test('Back activation cannot bubble into the freshly restored menu outside-click listener', async () => {
  const { document } = parseHTML('<html><body></body></html>');
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: { async sendMessage() { return { ok: true }; } } });
  let liveMenu;
  const render = () => {
    const menu = document.createElement('div'); document.body.append(menu); liveMenu = menu;
    const onOutside = event => { if (!menu.contains(event.target)) { menu.remove(); document.removeEventListener('click', onOutside); } };
    document.addEventListener('click', onOutside);
    return ui.add(menu, { title: 'Clip', close() { menu.remove(); document.removeEventListener('click', onOutside); }, back: render,
      options: ['video', 'audio'].map(id => ({ id, label: id, async run() { return `${id}.file`; } })) });
  };
  render().click();
  document.querySelector('[data-action="back"]').click(); await new Promise(setImmediate);
  assert.equal(liveMenu.isConnected, true, 'the old Back click cannot dismiss the new menu');
  assert.equal(document.querySelectorAll('.mendo-package-open').length, 1);
});

test('format group headings retain choice order and run only checked formats in their original order', async () => {
  const { document } = parseHTML('<html><body><div id="menu"></div></body></html>');
  const ran = [];
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: { async sendMessage() { return { ok: true }; } } });
  ui.add(document.getElementById('menu'), { title: 'Clip', options: [
    ['video-720', 'Видео', '720p'], ['audio-mp3', 'Аудио', 'MP3'], ['sub-srt', 'Субтитры', 'SRT · RU · с таймкодами'],
  ].map(([id, group, label]) => ({ id, group, label, async run() { ran.push(id); return `${id}.file`; } })) });
  document.querySelector('.mendo-package-open').click();
  const list = document.querySelector('.mendo-package-list');
  assert.deepEqual([...list.querySelectorAll('.mendo-package-group')].map(heading => heading.textContent), ['Видео', 'Аудио', 'Субтитры']);
  const inputs = [...list.querySelectorAll('input')];
  assert.deepEqual(inputs.map(input => input.value), ['video-720', 'audio-mp3', 'sub-srt']);
  for (const input of [inputs[0], inputs[2]]) { input.checked = true; input.dispatchEvent(new document.defaultView.Event('change')); }
  document.querySelector('[data-mode="files"]').click();
  while (ui.running) await new Promise(setImmediate);
  assert.deepEqual(ran, ['video-720', 'sub-srt']);
  assert.equal(inputs[1].checked, false);
  assert.equal(list.querySelectorAll('.mendo-package-group').length, 3);
});

function floatingPicker({ run, send } = {}) {
  const { document, window } = parseHTML('<html><body><div id="menu"></div></body></html>');
  window.innerWidth = 1000; window.innerHeight = 800;
  const packets = [], ran = [];
  let returned = 0;
  const ui = create({ document, queue: require('../extension/package_queue.js'), runtime: {
    async sendMessage(message) { packets.push(message); return send ? send(message) : { ok: true }; },
  } });
  const opener = ui.add(document.getElementById('menu'), { title: 'Clip', source: 'clip', back() { returned++; return opener; }, options: ['video', 'audio'].map(id => ({
    id, label: id, async run() { ran.push(id); return run ? run(id, ui) : `${id}.file`; },
  })) });
  opener.click();
  const dialog = document.querySelector('dialog');
  // Layout is a browser boundary. Model the existing CSS max-width/max-height
  // and read the delivered inline placement; do not call a private drag helper.
  dialog.getBoundingClientRect = () => {
    const width = Math.min(480, window.innerWidth - 24), height = Math.min(400, window.innerHeight - 24);
    const left = Number.isFinite(parseFloat(dialog.style.left)) ? parseFloat(dialog.style.left) : (window.innerWidth - width) / 2;
    const top = Number.isFinite(parseFloat(dialog.style.top)) ? parseFloat(dialog.style.top) : (window.innerHeight - height) / 2;
    return { left, top, right: left + width, bottom: top + height, width, height };
  };
  const pointer = (target, type, properties = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 7, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      isPrimary: true, pointerType: 'mouse', clientX: 300, clientY: 220, ...properties });
    target.dispatchEvent(event); return event;
  };
  return { document, window, ui, opener, dialog, packets, ran, pointer, returned: () => returned,
    point: () => [parseFloat(dialog.style.left), parseFloat(dialog.style.top)] };
}

test('the package window follows a primary mouse drag without starting or cancelling work', () => {
  const h = floatingPicker();
  const handle = h.dialog.querySelector('.mendo-package-drag-handle');
  assert.ok(handle, 'a separate empty header area lets the user move the window');
  const captures = new Set();
  handle.setPointerCapture = id => captures.add(id);
  handle.releasePointerCapture = id => captures.delete(id);
  h.pointer(handle, 'pointerdown');
  assert.equal(captures.has(7), true);
  h.pointer(h.document, 'pointermove', { clientX: 500, clientY: 320 });
  assert.deepEqual(h.point(), [460, 300]);
  h.pointer(h.document, 'pointerup');
  assert.equal(captures.size, 0);
  h.pointer(h.document, 'pointermove', { clientX: 700, clientY: 600 });
  assert.deepEqual(h.point(), [460, 300], 'release stops movement');
  assert.equal(h.ui.running, false);
  assert.deepEqual(h.packets, []); assert.deepEqual(h.ran, []);
});

test('a dragged package stays within every viewport edge after narrow resize and hide/reopen', () => {
  const h = floatingPicker(), handle = h.dialog.querySelector('.mendo-package-drag-handle');
  h.pointer(handle, 'pointerdown');
  h.pointer(h.document, 'pointermove', { clientX: 3000, clientY: 3000 });
  assert.deepEqual(h.point(), [508, 388]);
  assert.equal(h.dialog.getBoundingClientRect().right, 988);
  assert.equal(h.dialog.getBoundingClientRect().bottom, 788);
  h.pointer(h.document, 'pointermove', { clientX: -3000, clientY: -3000 });
  assert.deepEqual(h.point(), [12, 12]);
  h.pointer(h.document, 'pointerup');
  h.pointer(handle, 'pointerdown', { clientX: 100, clientY: 40 });
  h.pointer(h.document, 'pointermove', { clientX: 500, clientY: 340 });
  assert.deepEqual(h.point(), [412, 312]);
  h.dialog.querySelector('[data-action="hide"]').click();
  const resume = h.document.querySelector('.mendo-package-resume');
  assert.equal(resume.hidden, false);
  h.pointer(h.document, 'pointermove', { clientX: -3000, clientY: -3000 });
  assert.deepEqual(h.point(), [412, 312], 'hide releases the active drag');
  h.window.innerWidth = 360; h.window.innerHeight = 300;
  h.window.dispatchEvent(new h.window.Event('resize'));
  resume.click();
  assert.deepEqual(h.point(), [12, 12]);
  assert.equal(h.dialog.getBoundingClientRect().right, 348);
  assert.equal(h.dialog.getBoundingClientRect().bottom, 288);
  assert.equal(h.dialog.hasAttribute('open'), true);
  h.window.innerWidth = 640; h.window.innerHeight = 480;
  h.window.dispatchEvent(new h.window.Event('resize'));
  assert.deepEqual(h.point(), [12, 12], 'expanding the viewport keeps the current user placement');
  assert.deepEqual(h.packets, []);
});

test('package drag ignores buttons, secondary mouse presses and unrelated pointers, and stops on cancellation', () => {
  const h = floatingPicker(), handle = h.dialog.querySelector('.mendo-package-drag-handle');
  const child = h.document.createElement('button'); handle.append(child);
  for (const [target, properties] of [[handle, { button: 2, buttons: 2 }], [handle, { isPrimary: false }],
    [child, {}], [h.dialog.querySelector('[data-action="back"]'), {}], [h.dialog.querySelector('[data-action="close"]'), {}], [h.dialog.querySelector('input'), {}]]) {
    h.pointer(target, 'pointerdown', properties);
    h.pointer(h.document, 'pointermove', { clientX: 2000, clientY: 2000 });
    const box = h.dialog.getBoundingClientRect();
    assert.deepEqual([box.left, box.top], [260, 200]);
  }
  h.pointer(handle, 'pointerdown');
  h.pointer(h.document, 'pointermove', { pointerId: 8, clientX: 2000, clientY: 2000 });
  h.pointer(h.document, 'pointerup', { pointerId: 8 });
  assert.deepEqual(h.point(), [260, 200]);
  h.pointer(h.document, 'pointermove', { clientX: 400, clientY: 280 });
  assert.deepEqual(h.point(), [360, 260]);
  h.pointer(h.document, 'pointercancel');
  h.pointer(h.document, 'pointermove', { clientX: 2000, clientY: 2000 });
  assert.deepEqual(h.point(), [360, 260]);
  assert.equal(h.dialog.classList.contains('mendo-package-dragging'), false);
  h.pointer(handle, 'pointerdown'); h.pointer(handle, 'lostpointercapture');
  h.pointer(h.document, 'pointermove', { clientX: 2000, clientY: 2000 });
  assert.deepEqual(h.point(), [360, 260]);
  assert.deepEqual(h.packets, []); assert.deepEqual(h.ran, []);
});

test('losing window focus during a package drag releases capture and ignores subsequent movement', () => {
  const h = floatingPicker(), handle = h.dialog.querySelector('.mendo-package-drag-handle');
  const captures = new Set();
  handle.setPointerCapture = id => captures.add(id);
  handle.releasePointerCapture = id => captures.delete(id);
  h.pointer(handle, 'pointerdown');
  h.window.dispatchEvent(new h.window.Event('blur'));
  assert.equal(captures.size, 0, 'switching windows must not leave the gesture captured');
  h.pointer(h.document, 'pointermove', { clientX: 2000, clientY: 2000 });
  assert.deepEqual(h.point(), [260, 200]);
});

test('idle package close disposes the entire UI and allows a fresh picker without reopening the source menu', () => {
  const h = floatingPicker(), close = h.dialog.querySelector('[data-action="close"]');
  assert.ok(close, 'the window has a distinct × close button');
  assert.equal(Boolean(close.disabled), false);
  assert.match(close.getAttribute('aria-label'), /Закрыть/);
  const input = h.dialog.querySelector('input');
  input.checked = true; input.dispatchEvent(new h.window.Event('change'));
  const handle = h.dialog.querySelector('.mendo-package-drag-handle'), captures = new Set();
  handle.setPointerCapture = id => captures.add(id); handle.releasePointerCapture = id => captures.delete(id);
  h.pointer(handle, 'pointerdown'); h.pointer(h.document, 'pointermove', { clientX: 500, clientY: 320 });
  const previousPlacement = h.point();
  close.click();
  assert.equal(h.document.querySelectorAll('dialog,.mendo-package-resume').length, 0);
  assert.equal(captures.size, 0, 'closing releases the pointer gesture');
  assert.equal(h.ui.running, false); assert.equal(h.returned(), 0);
  assert.deepEqual(h.packets, []); assert.deepEqual(h.ran, []);
  h.opener.click();
  const next = h.document.querySelector('dialog');
  assert.notEqual(next, h.dialog, 'full close drops the old picker');
  assert.equal(next.hasAttribute('open'), true);
  assert.equal(Boolean(next.querySelector('input').checked), true, 'compatible choices remain remembered');
  assert.ok(!next.style.left, 'a fresh picker starts centered');
  close.click();
  h.pointer(handle, 'pointerdown'); h.pointer(h.document, 'pointermove', { clientX: -2000, clientY: -2000 });
  h.window.innerWidth = 360; h.window.innerHeight = 300; h.window.dispatchEvent(new h.window.Event('resize'));
  assert.equal(next.isConnected, true, 'events from a disposed picker cannot close the new UI');
  assert.deepEqual(h.point(), previousPlacement, 'disposed resize and pointer listeners are released');
});

test('both package close buttons remain disabled through running and cancellation cleanup while Hide and Cancel work', async () => {
  let entered, releaseCleanup;
  const started = new Promise(resolve => { entered = resolve; });
  const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  const h = floatingPicker({
    run(_id, ui) { return new Promise((_, reject) => {
      ui.signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); }, { once: true });
      entered();
    }); },
    async send(message) { if (message.t === 'mendosave-package-cancel') await cleanup; return { ok: true }; },
  });
  try {
    const input = h.dialog.querySelector('input'); input.checked = true; input.dispatchEvent(new h.window.Event('change'));
    h.dialog.querySelector('[data-mode="files"]').click(); await started;
    const close = h.dialog.querySelector('[data-action="close"]');
    assert.equal(close.disabled, true);
    assert.match(close.title, /недоступно.*завершения/);
    assert.match(close.getAttribute('aria-label'), /недоступно.*завершения/);
    const signal = h.ui.signal;
    const handle = h.dialog.querySelector('.mendo-package-drag-handle');
    h.pointer(handle, 'pointerdown'); h.pointer(h.document, 'pointermove', { clientX: 500, clientY: 320 }); h.pointer(h.document, 'pointerup');
    assert.equal(h.ui.signal, signal); assert.equal(signal.aborted, false, 'drag never cancels the job');
    assert.equal(h.packets.filter(message => message.t === 'mendosave-package-begin').length, 1);
    close.click();
    assert.equal(h.dialog.isConnected, true);
    h.dialog.querySelector('[data-action="hide"]').click();
    const chip = h.document.querySelector('.mendo-package-resume'), chipClose = chip.querySelector('[data-action="close"]');
    assert.ok(chipClose, 'the resume chip provides its own ×');
    assert.equal(chipClose.disabled, true);
    assert.match(chipClose.title, /недоступно.*завершения/);
    assert.equal(chip.hidden, false);
    chipClose.click();
    assert.equal(h.dialog.hasAttribute('open'), false, 'disabled × cannot reopen or dismiss the active UI');
    assert.equal(chip.isConnected && h.ui.running, true);
    assert.equal(h.packets.some(message => /cancel|abort/.test(message.t)), false);
    const reopen = chip.querySelector('[data-action="resume"]'); assert.ok(reopen); reopen.click();
    const cancel = h.dialog.querySelector('[data-action="cancel"]');
    assert.equal(cancel.hidden, false); assert.equal(cancel.disabled, false);
    cancel.click(); await new Promise(setImmediate);
    assert.equal(signal.aborted, true); assert.equal(h.ui.running, true);
    assert.equal(close.disabled && chipClose.disabled, true, 'pending cancellation cleanup still owns both controls');
    close.click(); h.dialog.querySelector('[data-action="hide"]').click(); chipClose.click();
    assert.equal(h.dialog.isConnected && chip.isConnected, true);
    releaseCleanup(); while (h.ui.running) await new Promise(setImmediate);
    assert.equal(close.disabled || chipClose.disabled, false);
    assert.match(chip.textContent, /Пакет отменён/);
    chipClose.click();
    assert.equal(h.document.querySelectorAll('dialog,.mendo-package-resume').length, 0);
    assert.equal(h.returned(), 0);
  } finally {
    if (h.ui.running) void h.ui.cancel();
    releaseCleanup(); while (h.ui.running) await new Promise(setImmediate);
  }
});

test('a visible dragged package refits on resize and ends the active gesture', () => {
  const h = floatingPicker(), handle = h.dialog.querySelector('.mendo-package-drag-handle'), captures = new Set();
  handle.setPointerCapture = id => captures.add(id); handle.releasePointerCapture = id => captures.delete(id);
  h.pointer(handle, 'pointerdown'); h.pointer(h.document, 'pointermove', { clientX: 500, clientY: 320 });
  assert.deepEqual(h.point(), [460, 300]);
  h.window.innerWidth = 360; h.window.innerHeight = 300; h.window.dispatchEvent(new h.window.Event('resize'));
  assert.equal(captures.size, 0);
  assert.deepEqual(h.point(), [12, 12]);
  h.pointer(h.document, 'pointermove', { clientX: -2000, clientY: -2000 });
  assert.deepEqual(h.point(), [12, 12]);
  assert.deepEqual(h.packets, []);
});

test('idle, completed and failed hidden packages close completely from the chip and reopen a fresh plan', async t => {
  for (const phase of ['idle', 'complete', 'failed']) await t.test(phase, async () => {
    const h = floatingPicker({ run() { if (phase === 'failed') throw new Error('fixture failure'); return 'video.file'; } });
    if (phase !== 'idle') {
      const input = h.dialog.querySelector('input'); input.checked = true; input.dispatchEvent(new h.window.Event('change'));
      h.dialog.querySelector('[data-mode="files"]').click(); while (h.ui.running) await new Promise(setImmediate);
      assert.match(h.dialog.querySelector('[role="status"]').textContent, phase === 'complete' ? /Готово/ : /Ошибка/);
    }
    h.dialog.querySelector('[data-action="hide"]').click();
    const chip = h.document.querySelector('.mendo-package-resume'), close = chip.querySelector('[data-action="close"]');
    assert.equal(chip.getAttribute('role'), 'group');
    assert.equal(chip.querySelectorAll('button').length, 2);
    assert.equal(chip.querySelector('button button'), null, 'native reopen and close controls are siblings');
    assert.equal(close.disabled, false);
    const packetCount = h.packets.length, runCount = h.ran.length;
    close.click();
    assert.equal(h.document.querySelectorAll('dialog,.mendo-package-resume').length, 0);
    assert.equal(h.returned(), 0); assert.equal(h.packets.length, packetCount); assert.equal(h.ran.length, runCount);
    h.opener.click();
    const next = h.document.querySelector('dialog');
    assert.notEqual(next, h.dialog); assert.equal(h.document.querySelectorAll('dialog').length, 1);
    assert.match(next.querySelector('[role="status"]').textContent, /Выберите файлы/);
    chip.click(); close.click();
    assert.equal(next.isConnected, true, 'disposed chip events cannot reopen or close a newer picker');
    assert.equal(h.document.querySelectorAll('.mendo-package-resume').length, 1);
  });
});

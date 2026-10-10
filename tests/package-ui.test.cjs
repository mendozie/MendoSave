const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { create } = require('../extension/package_ui.js');
const fs = require('node:fs');
const vm = require('node:vm');

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
  const context = vm.createContext({ module: { exports: {} }, Uint8Array: ContentUint8Array, crypto, btoa });
  vm.runInContext(fs.readFileSync('extension/package_ui.js', 'utf8'), context);
  const ui = context.module.exports.create({ runtime: {
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

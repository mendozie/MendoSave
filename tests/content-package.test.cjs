const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const espree = require('espree');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync('extension/content_ui.js', 'utf8');
const tree = espree.parse(source, { ecmaVersion: 'latest', range: true });
const declarations = tree.body[0].expression.callee.body.body;
// Execute the delivered menu actions and both media routes. Bootstrap and page
// bridge transport are replaced at their existing DOM/runtime boundary.
const names = new Set(['addDownloadItems', 'addSubtitleItems', 'addRadioSelector', 'addFormatSelector',
  'openMenu', 'videoIdFromLocation', 'startDownload', 'tryDownloadViaSabr', 'downloadViaSabr',
  'downloadSubtitles', 'encodeBase64', 'snapshotPackageOptions', 'mediaResponseError',
  'buildTimedSubtitles', 'normalizeCues', 'formatCueTime']);
const constants = new Set(['TRANSFER_CHUNK_SIZE', 'HAS_NATIVE_BASE64', 'SUBTITLE_OUTPUTS']);
const flowSource = declarations.filter(node => (node.type === 'FunctionDeclaration' && names.has(node.id.name))
  || (node.type === 'VariableDeclaration' && node.declarations.some(item => constants.has(item.id.name))))
  .map(node => source.slice(...node.range)).join('\n');

function harness(finalize = () => ({ ok: true, filename: 'fixture.mp4' })) {
  const { window, document } = parseHTML('<html><body></body></html>');
  const info = { title: 'Fixture', videoId: 'fixtureVideo', duration: 10, heights: [720], isLive: false };
  const messages = [], hooks = [], notifications = [];
  const settings = { transcode: false };
  let captureSaves = 0, picker;
  const toast = { set: (text) => notifications.push(text), hide() {}, setCancel() {}, beginStages() {}, stage() {} };
  const context = vm.createContext({ document, window, URL, Uint8Array, crypto, btoa,
    location: new URL('https://www.youtube.com/watch?v=fixtureVideo'),
    IS_MUSIC: false, IS_SHORTS: () => false, BUTTON_ID: 'download-button',
    console: { warn() {}, error() {} }, setTimeout() {},
    MendoMediaPlan: require('../extension/media_plan.js'),
    MendoMenu: { bind() {}, place() {} },
    MendoPackageUI: { running: false, signal: null, add(_menu, value) { picker = value; } },
    chrome: { storage: { local: {
      async get() { return { ...settings }; }, async set(value) { Object.assign(settings, value); },
    } }, runtime: { onMessage: { addListener() {}, removeListener() {} } } },
    createElement(tag, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text) element.textContent = text;
      return element;
    },
    createHeading(text) { const element = document.createElement('div'); element.textContent = text; return element; },
    createBrandHeading() { return document.createElement('div'); },
    setItemLabel(element, label, note) { element.textContent = `${label} ${note}`; },
    closeMenu() {}, closeMenuOnOutsideClick() {}, playlistIdFromLocation: () => '',
    audioFormatsFor: () => [{ id: 'mp3', title: 'MP3', note: 'VBR' }],
    audioFormatMeta: () => ({ title: 'MP3', extension: '.mp3' }),
    activeMediaElement: () => null, clearReloadGuard: async () => {},
    safeFilename: value => value, reportError: async () => {}, sabrCarriesAudio: () => false,
    getToast: () => toast, warmupMediaProcessor: async () => {},
    startTrackStaging: () => ({ stop: async () => ({ failed: true }) }),
    muxViaOffscreen: async () => { captureSaves++; return { ok: true, filename: 'capture.mp4' }; },
    sendWorkerMessage: async (message) => { messages.push(message); return { ok: true }; },
    sendRuntimeMessage: async (message) => {
      messages.push(message);
      if (message.t === 'mendosave-register-job') return { ok: true, tabId: 7 };
      if (message.t === 'mendosave-finalize') return finalize();
      return { ok: true };
    },
    callHook: async (command) => {
      hooks.push(command);
      if (command === 'info') return info;
      if (command === 'subs-available') return { available: true, lang: 'en' };
      if (command === 'subtitles') return { lang: 'en', text: 'Fixture subtitle' };
      if (command === 'sabr-start') return { tracks: {
        video: { size: 1, height: 720, mime: 'video/mp4' }, audio: { size: 1, mime: 'audio/mp4' },
      } };
      if (command === 'sabr-drain') return { done: true, chunks: [
        { track: 'video', bytes: [1] }, { track: 'audio', bytes: [2] },
      ] };
      if (command === 'download') return { _v: Uint8Array.of(1).buffer, _a: Uint8Array.of(2).buffer,
        actualHeight: 720, video: { mime: 'video/mp4' }, audio: { mime: 'audio/mp4' }, duration: 10 };
      return {};
    },
  });
  vm.runInContext(`let menu, menuOpening = false, downloadInProgress = false;
    let packageOptions = [], packageTranscode = false;
    ${flowSource}`, context);
  return { context, document, info, messages, hooks, notifications, settings,
    captureSaves: () => captureSaves,
    picker: () => picker,
    async openMenu() { await context.openMenu({ stopPropagation() {} }); assert.ok(picker); },
    click(element) { element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); },
    snapshot() { return typeof picker.options === 'function' ? picker.options() : picker.options; },
  };
}

test('package codec matches the radio choice when the picker opens and remains fixed for its jobs', async () => {
  const h = harness();
  await h.openMenu();
  const radios = [...h.document.querySelectorAll('.mendosave-menu-radio')];
  h.click(radios[1]);
  const selected = h.snapshot().find(option => option.id === 'video-720');
  assert.match(selected.label, /H\.264\/AAC/);
  h.click(radios[0]);
  h.context.MendoPackageUI.running = true;
  assert.equal(await selected.run(), true);
  const begin = h.messages.find(message => message.t === 'mendosave-begin');
  assert.equal(begin.transcode, true, 'codec comes from the picker snapshot, not a later radio or storage value');
});

test('original codec snapshot remains original after the setting later changes to transcoding', async () => {
  const h = harness();
  h.settings.transcode = true;
  await h.openMenu();
  const radios = [...h.document.querySelectorAll('.mendosave-menu-radio')];
  h.click(radios[0]);
  const selected = h.snapshot().find(option => option.id === 'video-720');
  assert.match(selected.label, /исходные кодеки/);
  h.click(radios[1]);
  h.context.MendoPackageUI.running = true;
  await selected.run();
  assert.equal(h.messages.find(message => message.t === 'mendosave-begin').transcode, false);
});

test('SRT download preserves actual cue times instead of extending short lines into later cues', async () => {
  const h = harness();
  h.context.callHook = async () => ({ lang: 'en', cues: [
    { start: 1, end: 1.25, text: 'A long spoken line in a short interval.' },
    { start: 1.5, end: 1.75, text: 'Second short line.' },
    { start: 2, end: 2.2, text: 'Last short line.' },
  ] });
  assert.equal(await h.context.downloadSubtitles(h.info, 'srt'), 'Fixture [en].srt');
  const saved = h.messages.find((message) => message.t === 'mendosave-save');
  const content = decodeURIComponent(saved.url.slice(saved.url.indexOf(',') + 1));
  assert.match(content, /00:00:01,000 --> 00:00:01,250/);
  assert.match(content, /00:00:01,500 --> 00:00:01,750/);
  assert.match(content, /00:00:02,000 --> 00:00:02,200/);
});

test('package rejects changed SPA material before any video, audio or subtitle operation', async (t) => {
  for (const id of ['video-720', 'audio-mp3', 'sub-txt']) await t.test(id, async () => {
    const h = harness();
    await h.openMenu();
    const selected = h.snapshot().find(option => option.id === id);
    h.context.location = new URL('https://www.youtube.com/watch?v=otherVideo');
    h.context.MendoPackageUI.running = true;
    await assert.rejects(async () => selected.run(), /Материал.*изменился/);
    assert.equal(h.messages.length, 0, 'no job or save belongs to a different source');
    assert.equal(h.hooks.some(command => ['download', 'sabr-start', 'subtitles'].includes(command)), false);
  });
});

test('SABR user cancellation never falls back to capture or a second save with the shared module absent', async (t) => {
  const variants = {
    AbortError() { const error = new Error('dialog canceled'); error.name = 'AbortError'; throw error; },
    cancelledFlag() { const error = new Error('dialog canceled'); error.cancelled = true; throw error; },
    cancelledDetails() { const error = new Error('dialog canceled'); error.details = { cancelled: true }; throw error; },
    response() { return { ok: false, error: 'dialog canceled', cancelled: true }; },
  };
  for (const [name, finalize] of Object.entries(variants)) await t.test(name, async () => {
    const h = harness(finalize);
    delete h.context.MendoPackageUI;
    assert.equal(await h.context.startDownload({ format: 'mp4', height: 720 }, h.info), false);
    assert.equal(h.captureSaves(), 0, 'cancellation is terminal rather than a route refusal');
    assert.equal(h.hooks.includes('download'), false);
    assert.equal(h.messages.filter(message => message.t === 'mendosave-finalize').length, 1);
    assert.ok(h.notifications.includes('Загрузка отменена'));
  });
});

test('ordinary SABR refusal retains the existing capture fallback', async () => {
  const h = harness(() => ({ ok: false, error: 'unsupported media' }));
  delete h.context.MendoPackageUI;
  assert.equal(await h.context.startDownload({ format: 'mp4', height: 720 }, h.info), true);
  assert.equal(h.captureSaves(), 1);
  assert.ok(h.hooks.includes('download'));
});

test('capture response preserves native save cancellation when the shared module is absent', async () => {
  const h = harness(() => ({ ok: false, error: 'unsupported media' }));
  delete h.context.MendoPackageUI;
  h.context.muxViaOffscreen = async () => ({ ok: false, cancelled: true, error: 'dialog canceled' });
  assert.equal(await h.context.startDownload({ format: 'mp4', height: 720 }, h.info), false);
  assert.ok(h.hooks.includes('download'));
  assert.ok(h.notifications.includes('Загрузка отменена'));
  assert.equal(h.notifications.some(text => text.startsWith('Готово:')), false);
});

test('subtitle response preserves native save cancellation when the shared module is absent', async () => {
  const h = harness();
  delete h.context.MendoPackageUI;
  h.context.sendWorkerMessage = async (message) => {
    h.messages.push(message);
    return { ok: false, cancelled: true, error: 'dialog canceled' };
  };
  assert.equal(await h.context.downloadSubtitles(h.info, 'txt'), false);
  assert.equal(h.messages.filter(message => message.t === 'mendosave-save').length, 1);
  assert.ok(h.notifications.includes('Сохранение отменено'));
});

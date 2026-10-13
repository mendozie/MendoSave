const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const espree = require('espree');
const { parseHTML, UserEvent } = require('./user-dom.cjs');
const { producerPorts } = require('./producer-port-harness.cjs');
const { fixture: packageIO } = require('./package-io-harness.cjs');
const { create: createPackageUI } = require('../extension/package_ui.js');

const source = fs.readFileSync('extension/content_ui.js', 'utf8');
const tree = espree.parse(source, { ecmaVersion: 'latest', range: true });
const declarations = tree.body[0].expression.callee.body.body;
// Execute the delivered menu actions and both media routes. Bootstrap and page
// bridge transport are replaced at their existing DOM/runtime boundary.
const names = new Set(['addDownloadItems', 'addSubtitleItems', 'addRadioSelector', 'addFormatSelector',
  'openMenu', 'closeMenu', 'videoIdFromLocation', 'startDownload', 'tryDownloadViaSabr', 'downloadViaSabr',
  'downloadSubtitles', 'encodeBase64', 'snapshotPackageOptions', 'mediaResponseError',
  'snapshotSubtitleSource', 'subtitleSourcesMatch',
  'buildTimedSubtitles', 'normalizeCues', 'formatCueTime', 'safeFilename']);
const constants = new Set(['TRANSFER_CHUNK_SIZE', 'HAS_NATIVE_BASE64', 'SUBTITLE_OUTPUTS', 'SUBTITLE_OUTPUT_MAX_BYTES']);
const flowSource = declarations.filter(node => (node.type === 'FunctionDeclaration' && names.has(node.id.name))
  || (node.type === 'VariableDeclaration' && node.declarations.some(item => constants.has(item.id.name))))
  .map(node => source.slice(...node.range)).join('\n');

function harness(finalize = () => ({ ok: true, filename: 'fixture.mp4' })) {
  const { window, document } = parseHTML('<html><body></body></html>');
  const info = { title: 'Fixture', videoId: 'fixtureVideo', sourceRevision: 1, duration: 10, heights: [720], isLive: false };
  const subtitleState = { videoId: info.videoId, lang: 'en', trackId: 'fixture:en', revision: 1, chaptersAvailable: true };
  const availability = () => ({ available: true, lang: subtitleState.lang, chaptersAvailable: subtitleState.chaptersAvailable,
    source: { videoId: subtitleState.videoId, lang: subtitleState.lang, trackId: subtitleState.trackId, revision: subtitleState.revision } });
  const messages = [], hooks = [], notifications = [];
  const settings = { transcode: false };
  let captureSaves = 0, picker;
  const toast = { set: (text) => notifications.push(text), hide() {}, setCancel() {}, beginStages() {}, stage() {} };
  const producerUI = createPackageUI({ runtime: { connect: producerPorts().connect } });
  const context = vm.createContext({ document, window, URL, Blob, Uint8Array, crypto, btoa, AbortController, TextEncoder,
    location: new URL('https://www.youtube.com/watch?v=fixtureVideo'),
    IS_MUSIC: false, IS_SHORTS: () => false, BUTTON_ID: 'download-button',
    console: { warn() {}, error() {} }, setTimeout() {},
    MendoMediaPlan: require('../extension/media_plan.js'),
    MendoMenu: { ...require('../extension/menu.js'), bind() {}, place() {} },
    MendoDiagnostics: require('../extension/diagnostics.js'),
    MendoPackageUI: { running: false, signal: null, acquireProcessor: options => producerUI.acquireProcessor(options), add(_menu, value) { picker = value; } },
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
    setItemLabel(element, label, note) { element.textContent = `${label}${note ? ` ${note}` : ''}`; },
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
    callHook: async (command, payload) => {
      hooks.push(command);
      if (command === 'info') return info;
      if (command === 'subs-available') return availability();
      if (command === 'subtitles') return { videoId: payload.source.videoId, source: { ...payload.source }, lang: payload.source.lang, text: 'Fixture subtitle' };
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
  vm.runInContext(`let menu, menuOpening = false, menuRequest = 0, downloadInProgress = false;
    let packageOptions = [], packageTranscode = false;
    ${flowSource}`, context);
  return { context, document, info, messages, hooks, notifications, settings,
    subtitleState, availability,
    subtitles(value, language = value.lang || subtitleState.lang) {
      subtitleState.lang = language; subtitleState.trackId = `fixture:${language}`;
      context.callHook = async (command, payload) => {
        hooks.push(command);
        if (command === 'info') return info;
        if (command === 'subs-available') return availability();
        assert.equal(command, 'subtitles');
        const reply = typeof value === 'function' ? await value(command, payload) : value;
        return { videoId: payload.source.videoId, source: { ...payload.source }, lang: payload.source.lang, ...reply };
      };
    },
    captureSaves: () => captureSaves,
    picker: () => picker,
    async openMenu() { await context.openMenu({ stopPropagation() {} }); assert.ok(picker); },
    click(element) { element.dispatchEvent(new UserEvent('click', { bubbles: true, cancelable: true })); },
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
  h.subtitles({ lang: 'en', cues: [
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

test('single-menu SRT preserves exact milliseconds from the native transcript', async () => {
  const h = harness();
  h.info.duration = 19.013042;
  h.subtitles({ cues: [
    { start: 1.2, end: 3.36, text: 'First.' },
    { start: 5.318, end: 7.974, text: 'Second.' },
    { start: 7.974, end: 12.616, text: 'Third.' },
    { start: 12.616, end: 14.367, text: 'Fourth.' },
    { start: 14.421, end: 15.733, text: 'Fifth.' },
    { start: 16.881, end: 18.881, text: 'Last.' },
  ] });
  await h.openMenu();
  const savedByClick = new Promise(resolve => {
    const send = h.context.sendWorkerMessage;
    h.context.sendWorkerMessage = async message => {
      const result = await send(message);
      if (message.t === 'mendosave-save') resolve(message);
      return result;
    };
  });
  const single = [...h.document.querySelectorAll('.mendosave-menu-item')]
    .find(element => element.textContent === 'SRT · EN · с таймкодами');
  assert.ok(single, 'the delivered single-menu export action is available');
  h.click(single);
  const saved = await savedByClick;
  assert.equal(saved.filename, 'Fixture [en].srt');
  const content = decodeURIComponent(saved.url.slice(saved.url.indexOf(',') + 1));
  assert.deepEqual(content.split('\r\n').filter(line => /^\d\d:/.test(line)), [
    '00:00:01,200 --> 00:00:03,360',
    '00:00:05,318 --> 00:00:07,974',
    '00:00:07,974 --> 00:00:12,616',
    '00:00:12,616 --> 00:00:14,367',
    '00:00:14,421 --> 00:00:15,733',
    '00:00:16,881 --> 00:00:18,881',
  ]);
});

test('single and package SRT end a missing final cue at the captured video duration', async t => {
  for (const route of ['single', 'package']) await t.test(route, async () => {
    const h = harness();
    h.info.duration = 19.013042;
    let entered, finish;
    const requested = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { finish = resolve; });
    h.subtitles(async () => {
      entered(); await pending;
      return { cues: [{ start: 1, text: 'First.' }, { start: 7, text: 'Second.' }, { start: 16, text: 'Last.' }] };
    });
    await h.openMenu();
    const savedByClick = new Promise(resolve => {
      const send = h.context.sendWorkerMessage;
      h.context.sendWorkerMessage = async message => {
        const result = await send(message);
        if (message.t === 'mendosave-save') resolve(message.filename);
        return result;
      };
    });
    let downloading;
    if (route === 'package') downloading = h.snapshot().find(option => option.id === 'sub-srt').run();
    else {
      const single = [...h.document.querySelectorAll('.mendosave-menu-item')]
        .find(element => element.textContent === 'SRT · EN · с таймкодами');
      assert.ok(single, 'the real single-menu SRT choice is available');
      h.click(single); downloading = savedByClick;
    }
    await requested;
    h.info.duration = 200; h.info.title = 'Later metadata'; finish();
    assert.equal(await downloading, 'Fixture [en].srt');
    const saved = h.messages.find(message => message.t === 'mendosave-save');
    assert.equal(decodeURIComponent(saved.url.slice(saved.url.indexOf(',') + 1)),
      '\uFEFF1\r\n00:00:01,000 --> 00:00:07,000\r\nFirst.\r\n\r\n'
      + '2\r\n00:00:07,000 --> 00:00:16,000\r\nSecond.\r\n\r\n'
      + '3\r\n00:00:16,000 --> 00:00:19,013\r\nLast.\r\n');
  });
});

test('package SRT keeps exact milliseconds and carries rounded clock boundaries', async () => {
  const h = harness();
  h.info.duration = 90001;
  h.subtitles({ cues: [
    { start: 0, end: .001, text: 'Zero.' },
    { start: 1.2, end: 3.36, text: 'Native milliseconds.' },
    { start: .9996, end: 1.0006, text: 'Second boundary.' },
    { start: 59.9996, end: 60.0006, text: 'Minute boundary.' },
    { start: 3599.9996, end: 3600.0006, text: 'Hour boundary.' },
    { start: 86399.9996, end: 86400.0006, text: 'Day boundary.' },
    { start: 89999.9996, end: 90000.0006, text: 'Beyond a day.' },
  ] });
  await h.openMenu();
  const chosen = h.snapshot().find(option => option.id === 'sub-srt');
  assert.ok(chosen, 'the delivered package SRT action is available');
  assert.equal(await chosen.run(), 'Fixture [en].srt');
  const saved = h.messages.find(message => message.t === 'mendosave-save');
  const content = decodeURIComponent(saved.url.slice(saved.url.indexOf(',') + 1));
  assert.equal(content,
    '\uFEFF1\r\n00:00:00,000 --> 00:00:00,001\r\nZero.\r\n\r\n'
    + '2\r\n00:00:01,000 --> 00:00:01,001\r\nSecond boundary.\r\n\r\n'
    + '3\r\n00:00:01,200 --> 00:00:03,360\r\nNative milliseconds.\r\n\r\n'
    + '4\r\n00:01:00,000 --> 00:01:00,001\r\nMinute boundary.\r\n\r\n'
    + '5\r\n01:00:00,000 --> 01:00:00,001\r\nHour boundary.\r\n\r\n'
    + '6\r\n24:00:00,000 --> 24:00:00,001\r\nDay boundary.\r\n\r\n'
    + '7\r\n25:00:00,000 --> 25:00:00,001\r\nBeyond a day.\r\n');
});

test('SRT and VTT preserve starts and valid ends while bounding an explicit end by known duration', async t => {
  for (const format of ['srt', 'vtt']) await t.test(format, async () => {
    const h = harness(); h.info.duration = 19.013042;
    h.subtitles({ cues: [
      { start: 0, end: .25, text: 'At zero.' },
      { start: 1.25, end: 1.5, text: 'Short interval.' },
      { start: 3.36, end: 5.318, text: 'Native milliseconds.' },
      { start: 16, end: 22, text: 'Runs past video.' },
    ] });
    assert.equal(await h.context.downloadSubtitles(h.info, format), `Fixture [en].${format}`);
    const saved = h.messages.find(message => message.t === 'mendosave-save');
    const content = decodeURIComponent(saved.url.slice(saved.url.indexOf(',') + 1));
    const separator = format === 'vtt' ? '.' : ',';
    assert.ok(content.includes(`00:00:00${separator}000 --> 00:00:00${separator}250\r\nAt zero.`));
    assert.ok(content.includes(`00:00:01${separator}250 --> 00:00:01${separator}500\r\nShort interval.`));
    assert.ok(content.includes(`00:00:03${separator}360 --> 00:00:05${separator}318\r\nNative milliseconds.`));
    assert.ok(content.includes(`00:00:16${separator}000 --> 00:00:19${separator}013\r\nRuns past video.`));
  });
});

test('SRT rejects invalid cue times instead of moving starts or writing reversed intervals', async t => {
  for (const variant of [
    { name: 'negative start', cue: { start: -1, end: 2 } },
    { name: 'NaN start', cue: { start: NaN, end: 2 } },
    { name: 'infinite start', cue: { start: Infinity } },
    { name: 'start at duration', cue: { start: 10 } },
    { name: 'start past duration', cue: { start: 11, end: 12 } },
    { name: 'infinite end', cue: { start: 1, end: Infinity }, duration: 0 },
  ]) await t.test(variant.name, async () => {
    const h = harness(); h.info.duration = variant.duration ?? 10;
    h.subtitles({ cues: [{ ...variant.cue, text: 'Invalid interval.' }] });
    assert.equal(await h.context.downloadSubtitles(h.info, 'srt'), undefined);
    assert.equal(h.messages.length, 0, 'invalid timing cannot reach a download or processor');
    assert.match(h.notifications.at(-1), /таймкоды.*(?:некоррект|длитель)|некоррект.*таймкоды/i);
  });
});

test('unknown video duration preserves valid ends and the bounded missing-end fallback', async t => {
  for (const duration of [undefined, 0, -1, NaN, Infinity]) await t.test(String(duration), async () => {
    const h = harness(); h.info.duration = duration;
    h.subtitles({ cues: [{ start: 1, end: 1.25, text: 'Exact.' }, { start: 7, text: 'Next.' },
      { start: 16, end: 0, text: 'Unknown final end.' }] });
    assert.equal(await h.context.downloadSubtitles(h.info, 'srt'), 'Fixture [en].srt');
    const saved = h.messages.find(message => message.t === 'mendosave-save');
    assert.equal(decodeURIComponent(saved.url.slice(saved.url.indexOf(',') + 1)),
      '\uFEFF1\r\n00:00:01,000 --> 00:00:01,250\r\nExact.\r\n\r\n'
      + '2\r\n00:00:07,000 --> 00:00:16,000\r\nNext.\r\n\r\n'
      + '3\r\n00:00:16,000 --> 00:00:20,000\r\nUnknown final end.\r\n');
  });
});

test('SRT and VTT downloads preserve literal whitespace in accepted cues', async t => {
  for (const format of ['srt', 'vtt']) await t.test(format, async () => {
    const h = harness();
    const first = '  \n<first> \t ', last = '\n<last>\n  \n';
    h.subtitles({ lang: 'en', cues: [
      { start: 1, end: 2, text: first },
      { start: 2, end: 3, text: ' \r\n\t ' },
      { start: 3, end: 4, text: last },
    ] });
    assert.equal(await h.context.downloadSubtitles(h.info, format), `Fixture [en].${format}`);
    const saved = h.messages.find(message => message.t === 'mendosave-save');
    const separator = format === 'vtt' ? '.' : ',';
    const expected = (format === 'vtt' ? 'WEBVTT\r\n\r\n' : '1\r\n')
      + `00:00:01${separator}000 --> 00:00:02${separator}000\r\n${first}\r\n\r\n`
      + (format === 'vtt' ? '' : '2\r\n')
      + `00:00:03${separator}000 --> 00:00:04${separator}000\r\n${last}\r\n`;
    assert.equal(decodeURIComponent(saved.url.slice(saved.url.indexOf(',') + 1)), '\uFEFF' + expected);
  });
});

test('small and large TXT names reserve language and timed markers before Unicode title truncation', async t => {
  const names = new Map();
  for (const variant of [
    { name: 'emoji', title: '😀'.repeat(120) },
    { name: 'reserved ASCII', title: 'CON.' + 'A'.repeat(116) },
    { name: 'reserved BMP', title: 'CON.' + '界'.repeat(116) },
    { name: 'reserved emoji', title: 'CON.' + '😀'.repeat(116) },
  ]) for (const size of ['small', 'large']) for (const format of ['txt', 'timed-txt']) {
    await t.test(`${variant.name} ${size} ${format}`, async () => {
      const h = harness(), producers = producerPorts(), storage = packageIO();
      const sender = { id: 'mendo@test', tab: { id: 7 }, frameId: 0, documentId: 'doc7' };
      h.info.title = variant.title;
      const content = size === 'large' ? '界'.repeat(350000) : 'literal';
      h.subtitles({ lang: 'ru', text: content, timedText: content,
        cues: [{ start: 0, end: 1, text: 'literal' }] });
      const receive = async message => message.t === 'mendosave-save'
        ? (h.messages.push(message), { ok: true }) : storage.io.handle(message, sender) ?? { ok: true };
      h.context.sendWorkerMessage = receive;
      h.context.MendoPackageUI = createPackageUI({ runtime: { connect: producers.connect, sendMessage: receive } });
      const suffix = ` [ru]${format === 'timed-txt' ? ' [timed]' : ''}`;
      const filename = await h.context.downloadSubtitles(h.info, format);
      if (variant.name === 'emoji') assert.equal(filename,
        '😀'.repeat(Math.floor((180 - Buffer.byteLength(suffix + '.txt')) / 4)) + suffix + '.txt');
      assert.equal(require('../extension/archive.js').safeName(filename), filename,
        'shared Windows basename normalization cannot truncate the reserved markers');
      assert.ok(filename.endsWith(suffix + '.txt')); assert.ok([...filename.slice(0, -4)].length <= 120);
      assert.ok(Buffer.byteLength(filename) <= 180, 'shared archive sanitization retains the reserved suffix');
      assert.ok(filename.length <= 250); assert.ok(!filename.includes('\uFFFD'));
      assert.equal(h.notifications.at(-1), `Готово: ${filename}`);
      const expected = Buffer.from('\uFEFF' + content);
      if (size === 'large') {
        assert.equal(storage.saved.length, 1);
        assert.equal(storage.saved[0].filename, filename);
        assert.deepEqual(Buffer.from(await storage.saved[0].blob.arrayBuffer()), expected);
      } else {
        const saved = h.messages.find(message => message.t === 'mendosave-save');
        assert.equal(saved.filename, filename);
        assert.deepEqual(Buffer.from(decodeURIComponent(saved.url.slice(saved.url.indexOf(',') + 1))), expected);
      }
      names.set(format, filename);
      assert.equal(storage.files.size, 0); assert.equal(storage.io.jobsActive(), false);
      assert.ok(producers.ports.every(port => port.disconnected));
    });
  }
  assert.notEqual(names.get('txt'), names.get('timed-txt'));
});

test('standalone SRT and timed TXT pass real shared-helper admission through the background save route', async t => {
  for (const format of ['srt', 'timed-txt']) await t.test(format, async () => {
    const h = harness(), producers = producerPorts(), packets = [];
    h.context.MendoPackageUI = createPackageUI({ runtime: {
      connect: producers.connect,
      async sendMessage(message) {
        packets.push(message);
        assert.equal(message.t, 'mendosave-save', 'background owns forwarding text to its selected host');
        assert.equal(message.instanceId, undefined);
        assert.equal(message.packageId, undefined);
        return { ok: true };
      },
    } });
    h.subtitles({ lang: 'ru', timedText: '[00:01.125] Привет & <literal> 😀\n',
      cues: [{ start: 1.125, end: 1.75, text: 'Привет & <literal> 😀' }] });
    const transportNames = new Set(['sendRuntimeMessage', 'sendWorkerMessage', 'isWorkerAsleep']);
    const transport = declarations.filter(node => (node.type === 'FunctionDeclaration' && transportNames.has(node.id.name))
      || (node.type === 'VariableDeclaration' && node.declarations.some(item => item.id.name === 'WORKER_RETRY_DELAYS')))
      .map(node => source.slice(...node.range)).join('\n');
    vm.runInContext(transport, h.context);
    assert.equal(await h.context.downloadSubtitles(h.info, format), format === 'srt' ? 'Fixture [ru].srt' : 'Fixture [ru] [timed].txt');
    assert.equal(producers.ports.length, 0, 'standalone save uses background withHost admission rather than a direct processor command');
    assert.equal(packets.length, 1);
    const content = decodeURIComponent(packets[0].url.slice(packets[0].url.indexOf(',') + 1));
    assert.equal(content, format === 'srt' ? '\uFEFF1\r\n00:00:01,125 --> 00:00:01,750\r\nПривет & <literal> 😀\r\n'
      : '\uFEFF[00:01.125] Привет & <literal> 😀\n');
    assert.match(h.notifications.at(-1), /Готово:/);
  });
});

test('timed TXT is a separate package choice and saves actual timestamps and chapters as literal UTF-8', async () => {
  const h = harness();
  const literal = '[00:00] Начало\n\n[00:01.125] Привет & <literal> 😀\n';
  h.subtitles((command, payload) => {
    assert.equal(command, 'subtitles'); assert.equal(payload.format, 'timed-txt');
    return { lang: 'ru', timedText: literal, cues: [{ start: 1.125, end: 2, text: 'Привет & <literal> 😀' }] };
  }, 'ru');
  await h.openMenu();
  const selected = h.snapshot().find(option => option.id === 'sub-timed-txt');
  assert.ok(selected, 'the third format is additive');
  assert.match(selected.label, /TXT · RU · с таймкодами и главами/);
  assert.match(h.snapshot().find(option => option.id === 'sub-txt').label, /без таймкодов/);
  assert.match(h.snapshot().find(option => option.id === 'sub-srt').label, /с таймкодами/);
  assert.equal(await selected.run(), 'Fixture [ru] [timed].txt');
  const saved = h.messages.find(message => message.t === 'mendosave-save');
  assert.equal(decodeURIComponent(saved.url.slice(saved.url.indexOf(',') + 1)), '\uFEFF' + literal);
  assert.match(saved.filename, /\[timed\]\.txt$/);
});

test('selected long timed TXT saves all accepted Unicode and chapter bytes beyond the legacy text transport bounds', async t => {
  for (const variant of [
    { name: 'ASCII', text: 'Literal & <tag> '.repeat(400), title: 'Fixture' },
    { name: 'Unicode', text: 'Кириллица 😀 & <tag> '.repeat(240), title: 'Fixture' },
    { name: 'supplementary Unicode filename', text: 'Кириллица 😀 & <tag> '.repeat(240), title: '😀'.repeat(120) },
  ]) await t.test(variant.name, async () => {
    const h = harness(), producers = producerPorts(), storage = packageIO();
    const sender = { id: 'mendo@test', tab: { id: 7 }, frameId: 0, documentId: 'doc7' };
    const { text } = variant;
    h.info.title = variant.title;
    const cues = Array.from({ length: 400 }, (_, i) => ({ start: i * 3, end: i * 3 + 2, text: `${text} ${i}` }));
    const timedText = require('../extension/captions.js').formatTimedTranscript(cues, [{ start: 0, text: 'Chapter <literal>' }]);
    const expected = Buffer.from('\uFEFF' + timedText, 'utf8');
    let saved;
    const receive = async message => {
      if (message.t === 'mendosave-save') {
        if (message.url.length > 6 * 1024 ** 2) return { ok: false, error: 'Unsupported or oversized text download' };
        const value = decodeURIComponent(message.url.slice(message.url.indexOf(',') + 1));
        if (value.length > 2 * 1024 ** 2) return { ok: false, error: 'Invalid text output request' };
        saved = Buffer.from(value); return { ok: true };
      }
      return storage.io.handle(message, sender) ?? { ok: true };
    };
    h.subtitles({ lang: 'ru', timedText, cues });
    await h.openMenu(); const selected = h.snapshot().find(option => option.id === 'sub-timed-txt');
    h.context.MendoPackageUI = createPackageUI({ runtime: { connect: producers.connect, sendMessage: receive } });
    h.context.sendWorkerMessage = receive;
    assert.ok(expected.length > 2 * 1024 ** 2, 'fixture is accepted by the actual formatter and exceeds legacy limits');
    const filename = await selected.run();
    assert.equal(storage.saved.length, 1, h.notifications.at(-1));
    assert.deepEqual(Buffer.from(await storage.saved[0].blob.arrayBuffer()), expected);
    assert.equal(filename, storage.saved[0].filename, 'completion reports the actual saved name');
    if (variant.title === 'Fixture') assert.equal(filename, 'Fixture [ru] [timed].txt');
    assert.ok(filename.length <= 250); assert.match(filename, / \[ru\] \[timed\]\.txt$/u);
    assert.ok(!filename.includes('\uFFFD'), 'supplementary characters survive name shortening');
    assert.match(h.notifications.at(-1), /Готово:/);
    assert.ok(producers.ports.every(port => port.disconnected), 'terminal completion releases transfer and producer ports');
    assert.equal(storage.files.size, 0); assert.equal(storage.io.jobsActive(), false);
    assert.equal(saved, undefined, 'large text uses the actual bounded Blob handler');
  });
});

test('oversized page subtitle text is rejected before acquiring a processor or starting a transfer', async t => {
  for (const variant of [
    { name: 'ASCII length', text: 'A'.repeat(32 * 1024 ** 2 + 1) },
    { name: 'UTF-8 expansion', text: '界'.repeat(12 * 1024 ** 2) },
  ]) await t.test(variant.name, async () => {
    const h = harness(), producers = producerPorts(), packets = [];
    h.context.MendoPackageUI = createPackageUI({ runtime: {
      connect: producers.connect,
      async sendMessage(message) { packets.push(message); return { ok: true, filename: 'unexpected.txt' }; },
    } });
    h.context.sendWorkerMessage = async message => { packets.push(message); return { ok: true }; };
    h.subtitles({ lang: 'en', timedText: variant.text,
      cues: [{ start: 0, end: 1, text: 'untrusted page cue' }] });
    assert.equal(await h.context.downloadSubtitles(h.info, 'timed-txt'), undefined);
    assert.match(h.notifications.at(-1), /32 MiB/);
    assert.ok(!h.notifications.some(text => text.startsWith('Готово:')));
    assert.equal(producers.ports.length, 0); assert.equal(packets.length, 0);
  });
});

test('SRT rejects excessive page cue count and text before formatting or privileged transfer', async t => {
  for (const variant of [
    { name: 'cue count', cues: Array.from({ length: 50001 }, (_, i) => ({ start: i, text: 'x' })) },
    { name: 'single cue text', cues: [{ start: 0, text: 'A'.repeat(65537) }] },
    { name: 'total cue text', cues: Array.from({ length: 129 }, (_, i) => ({ start: i, text: '界'.repeat(65536) })) },
  ]) await t.test(variant.name, async () => {
    const h = harness(), producers = producerPorts(), packets = [];
    h.context.MendoPackageUI = createPackageUI({ runtime: {
      connect: producers.connect, async sendMessage(message) { packets.push(message); return { ok: true }; },
    } });
    h.context.sendWorkerMessage = async message => { packets.push(message); return { ok: true }; };
    h.subtitles({ lang: 'en', cues: variant.cues });
    assert.equal(await h.context.downloadSubtitles(h.info, 'srt'), undefined);
    assert.match(h.notifications.at(-1), /лимит/);
    assert.ok(!h.notifications.some(text => text.startsWith('Готово:')));
    assert.equal(producers.ports.length, 0); assert.equal(packets.length, 0);
  });
});

test('the full formatter text budget preserves all worst-case UTF-8 bytes through the real file handler', async t => {
  for (const format of ['timed-txt', 'srt']) await t.test(format, async () => {
    const h = harness(), producers = producerPorts(), storage = packageIO();
    h.info.duration = 128;
    const sender = { id: 'mendo@test', tab: { id: 7 }, frameId: 0, documentId: 'doc7' };
    const receive = async message => storage.io.handle(message, sender) ?? { ok: true };
    h.context.MendoPackageUI = createPackageUI({ runtime: { connect: producers.connect, sendMessage: receive } });
    h.context.sendWorkerMessage = receive;
    const cues = Array.from({ length: 128 }, (_, i) => ({ start: i, end: i + .5, text: '界'.repeat(65536) }));
    const timedText = require('../extension/captions.js').formatTimedTranscript(cues);
    const content = format === 'srt' ? h.context.buildTimedSubtitles(cues, 'srt') : timedText;
    const expected = Buffer.from('\uFEFF' + content, 'utf8');
    assert.ok(expected.length > 24 * 1024 ** 2);
    h.subtitles({ lang: 'zh', cues, timedText });
    assert.equal(await h.context.downloadSubtitles(h.info, format), format === 'srt'
      ? 'Fixture [zh].srt' : 'Fixture [zh] [timed].txt');
    assert.equal(storage.saved.length, 1);
    assert.deepEqual(Buffer.from(await storage.saved[0].blob.arrayBuffer()), expected);
    assert.match(h.notifications.at(-1), /Готово:/);
    assert.ok(producers.ports.every(port => port.disconnected));
    assert.equal(storage.files.size, 0); assert.equal(storage.io.jobsActive(), false);
  });
});

test('cancelled native save of a long timed TXT stays cancellation and releases the transfer', async () => {
  const h = harness(), producers = producerPorts(), packets = [];
  const storage = packageIO({ saveBlob: async () => { throw Object.assign(new Error('USER_CANCELED'), { cancelled: true }); } });
  const sender = { id: 'mendo@test', tab: { id: 7 }, frameId: 0, documentId: 'doc7' };
  const receive = async message => {
    packets.push(message);
    return storage.io.handle(message, sender) ?? { ok: true };
  };
  h.context.MendoPackageUI = createPackageUI({ runtime: { connect: producers.connect, sendMessage: receive } });
  h.context.sendWorkerMessage = receive;
  const cues = Array.from({ length: 400 }, (_, i) => ({ start: i, end: i + .5, text: 'Accepted caption '.repeat(400) }));
  h.subtitles({ lang: 'en', cues,
    timedText: require('../extension/captions.js').formatTimedTranscript(cues) });
  assert.equal(await h.context.downloadSubtitles(h.info, 'timed-txt'), false);
  assert.equal(h.notifications.at(-1), 'Сохранение отменено');
  assert.ok(!h.notifications.some(text => text.startsWith('Готово:')));
  assert.ok(producers.ports.every(port => port.disconnected));
  assert.ok(packets.some(message => message.t === 'mendosave-blob-open'));
  assert.ok(packets.some(message => message.t === 'mendosave-blob-abort'));
  assert.equal(storage.files.size, 0); assert.equal(storage.io.jobsActive(), false);
});

test('timed TXT reports unavailable chapters after saving actual timestamped text without inventing chapters', async () => {
  const h = harness();
  h.subtitles({ lang: 'ru', timedText: '[00:01] Реальная реплика\n',
    chaptersUnavailable: true, cues: [{ start: 1, end: 2, text: 'Реальная реплика' }] });
  assert.equal(await h.context.downloadSubtitles(h.info, 'timed-txt'), 'Fixture [ru] [timed].txt');
  assert.match(h.notifications.at(-1), /Главы на странице недоступны/);
  const saved = h.messages.find(message => message.t === 'mendosave-save');
  assert.equal(decodeURIComponent(saved.url.slice(saved.url.indexOf(',') + 1)), '\uFEFF[00:01] Реальная реплика\n');
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

test('SABR user cancellation never falls back to capture or a second save with the shared send shortcut absent', async (t) => {
  const variants = {
    AbortError() { const error = new Error('dialog canceled'); error.name = 'AbortError'; throw error; },
    cancelledFlag() { const error = new Error('dialog canceled'); error.cancelled = true; throw error; },
    cancelledDetails() { const error = new Error('dialog canceled'); error.details = { cancelled: true }; throw error; },
    response() { return { ok: false, error: 'dialog canceled', cancelled: true }; },
  };
  for (const [name, finalize] of Object.entries(variants)) await t.test(name, async () => {
    const h = harness(finalize);
    delete h.context.MendoPackageUI.send;
    assert.equal(await h.context.startDownload({ format: 'mp4', height: 720 }, h.info), false);
    assert.equal(h.captureSaves(), 0, 'cancellation is terminal rather than a route refusal');
    assert.equal(h.hooks.includes('download'), false);
    assert.equal(h.messages.filter(message => message.t === 'mendosave-finalize').length, 1);
    assert.ok(h.notifications.includes('Загрузка отменена'));
  });
});

test('ordinary SABR refusal retains the existing capture fallback', async () => {
  const h = harness(() => ({ ok: false, error: 'unsupported media' }));
  delete h.context.MendoPackageUI.send;
  assert.equal(await h.context.startDownload({ format: 'mp4', height: 720 }, h.info), true);
  assert.equal(h.captureSaves(), 1);
  assert.ok(h.hooks.includes('download'));
});

test('capture response preserves native save cancellation when the shared send shortcut is absent', async () => {
  const h = harness(() => ({ ok: false, error: 'unsupported media' }));
  delete h.context.MendoPackageUI.send;
  h.context.muxViaOffscreen = async () => ({ ok: false, cancelled: true, error: 'dialog canceled' });
  assert.equal(await h.context.startDownload({ format: 'mp4', height: 720 }, h.info), false);
  assert.ok(h.hooks.includes('download'));
  assert.ok(h.notifications.includes('Загрузка отменена'));
  assert.equal(h.notifications.some(text => text.startsWith('Готово:')), false);
});

test('subtitle response preserves native save cancellation when the shared send shortcut is absent', async () => {
  const h = harness();
  delete h.context.MendoPackageUI.send;
  h.context.sendWorkerMessage = async (message) => {
    h.messages.push(message);
    return { ok: false, cancelled: true, error: 'dialog canceled' };
  };
  assert.equal(await h.context.downloadSubtitles(h.info, 'txt'), false);
  assert.equal(h.messages.filter(message => message.t === 'mendosave-save').length, 1);
  assert.ok(h.notifications.includes('Сохранение отменено'));
});

test('every subtitle format rejects a response after the page changes instead of saving it under the old title', async t => {
  for (const format of ['srt', 'txt', 'timed-txt']) await t.test(format, async () => {
    const h = harness();
    const source = { videoId: h.info.videoId, lang: 'en', trackId: 'English manual', revision: 1 };
    let release, requested;
    const pending = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { requested = resolve; });
    h.context.callHook = async command => {
      if (command === 'subs-available') return { available: true, lang: 'en', source };
      assert.equal(command, 'subtitles'); requested(); await pending;
      return { videoId: source.videoId, source, lang: 'en', text: 'Old text', timedText: '[00:01] Old text\n',
        cues: [{ start: 1, end: 2, text: 'Old text' }] };
    };
    const downloading = h.context.downloadSubtitles(h.info, format, source);
    await entered;
    h.context.location = new URL('https://www.youtube.com/watch?v=otherVideo'); release();
    assert.equal(await downloading, undefined);
    assert.equal(h.messages.length, 0, 'no downloaded file or processor job can belong to a stale source');
    assert.match(h.notifications.at(-1), /Материал.*изменился/);
  });
});

test('single and package subtitle choices share distinguishable format, real language and honest chapter labels', async t => {
  for (const chaptersAvailable of [true, false]) await t.test(`chapters ${chaptersAvailable}`, async () => {
    const h = harness();
    h.subtitleState.lang = 'ru'; h.subtitleState.trackId = 'fixture:ru'; h.subtitleState.chaptersAvailable = chaptersAvailable;
    await h.openMenu();
    const labels = Array.from(h.snapshot()).filter(option => option.id.startsWith('sub-')).map(option => option.label);
    assert.deepEqual(labels, ['SRT · RU · с таймкодами', 'TXT · RU · без таймкодов',
      chaptersAvailable ? 'TXT · RU · с таймкодами и главами' : 'TXT · RU · с таймкодами']);
    const single = [...h.document.querySelectorAll('.mendosave-menu-item')].filter(item => /^(SRT|TXT) · /.test(item.textContent));
    assert.deepEqual(single.map(item => item.textContent), labels);
    assert.equal(new Set(labels).size, 3, 'plain and timed TXT remain separate choices');
  });
});

test('YouTube package Back opens the current SPA source and focuses its new package control', async () => {
  const h = harness();
  let focused;
  const createElement = h.document.createElement.bind(h.document);
  h.document.createElement = tag => { const element = createElement(tag); element.focus = () => { focused = element; }; return element; };
  h.context.MendoPackageUI = createPackageUI({ document: h.document, queue: require('../extension/package_queue.js'), runtime: {
    connect: producerPorts().connect, async sendMessage() { return { ok: true }; },
  } });
  await h.context.openMenu({ stopPropagation() {} });
  const oldOpener = h.document.querySelector('.mendo-package-open'); h.click(oldOpener);
  assert.equal(oldOpener.isConnected, false);
  h.context.location = new URL('https://www.youtube.com/watch?v=otherVideo');
  h.info.videoId = 'otherVideo'; h.info.title = 'Current source'; h.info.heights = [480]; h.info.sourceRevision = 2;
  h.subtitleState.videoId = 'otherVideo'; h.subtitleState.revision = 2;
  h.document.querySelector('[data-action="back"]').click(); await new Promise(setImmediate);
  const newOpener = h.document.querySelector('.mendo-package-open');
  assert.ok(newOpener?.isConnected, 'Back reconstructs a current source single menu');
  assert.ok(focused === newOpener);
  assert.match(h.document.querySelector('.mendosave-menu').textContent, /480p/);
  assert.doesNotMatch(h.document.querySelector('.mendosave-menu').textContent, /720p/);
  assert.equal(h.document.querySelectorAll('dialog').length, 0);
  assert.deepEqual(h.messages, []);
});

test('an invalidated asynchronous menu cannot block or overwrite the next SPA menu', async () => {
  const h = harness(), oldInfo = { ...h.info }, oldAvailability = h.availability();
  let resolveOldInfo;
  const pending = new Promise(resolve => { resolveOldInfo = resolve; });
  h.context.callHook = async command => command === 'info' ? pending : oldAvailability;
  const oldOpening = h.context.openMenu({ stopPropagation() {} });
  h.context.closeMenu();
  h.context.location = new URL('https://www.youtube.com/watch?v=otherVideo');
  h.info.videoId = 'otherVideo'; h.info.sourceRevision = 2; h.info.heights = [480];
  h.subtitleState.videoId = 'otherVideo'; h.subtitleState.revision = 2;
  h.subtitles({ lang: 'en', text: 'Current text' });
  await h.context.openMenu({ stopPropagation() {} });
  assert.ok(h.document.querySelector('.mendosave-menu'), 'a cancelled old opening does not retain the menu lock');
  assert.match(h.document.querySelector('.mendosave-menu').textContent, /480p/);
  resolveOldInfo(oldInfo); await oldOpening;
  assert.equal(h.document.querySelectorAll('.mendosave-menu').length, 1);
  assert.match(h.document.querySelector('.mendosave-menu').textContent, /480p/);
  assert.doesNotMatch(h.document.querySelector('.mendosave-menu').textContent, /720p/);
  assert.equal(h.notifications.length, 0, 'a superseded opening quietly stops');
});

test('a new SPA URL cannot offer media from a player that still owns the previous video', async () => {
  const h = harness(); h.info.playerVideoId = 'oldVideo';
  const trigger = h.document.createElement('button'); trigger.id = 'download-button'; h.document.body.append(trigger);
  const focusTarget = await h.context.openMenu({ stopPropagation() {} });
  assert.equal(h.document.querySelectorAll('.mendosave-menu').length, 0);
  assert.ok(focusTarget === trigger, 'a refused Back/menu opening retains a live source trigger for focus');
  assert.match(h.notifications.at(-1), /Плеер.*переключ/i);
  h.info.playerVideoId = h.info.videoId;
  await h.context.openMenu({ stopPropagation() {} });
  assert.equal(h.document.querySelectorAll('.mendosave-menu').length, 1, 'the ready current player can be opened on the next attempt');
});

test('subtitle saving verifies the current revision and selected track even after returning to the same URL', async t => {
  for (const format of ['srt', 'txt', 'timed-txt']) for (const change of ['revision', 'trackId', 'lang', 'missing reply source']) {
    await t.test(`${format} ${change}`, async () => {
      const h = harness(), source = h.availability().source;
      h.context.callHook = async command => {
        if (command === 'subs-available') {
          const current = { ...source };
          if (change === 'revision') current.revision = 3;
          if (change === 'trackId') current.trackId = 'other track';
          if (change === 'lang') current.lang = 'ru';
          return { available: true, source: current };
        }
        assert.equal(command, 'subtitles');
        return { videoId: source.videoId, source: change === 'missing reply source' ? undefined : { ...source },
          lang: source.lang, text: 'Literal', timedText: '[00:01] Literal\n', cues: [{ start: 1, end: 2, text: 'Literal' }] };
      };
      assert.equal(await h.context.downloadSubtitles(h.info, format, source), undefined);
      assert.equal(h.messages.length, 0);
      assert.match(h.notifications.at(-1), /Материал.*изменил/i);
    });
  }
});

test('the subtitle request and filename retain the clicked source and title during asynchronous work', async () => {
  const h = harness(), expected = h.availability().source, selected = { ...expected };
  let requested, finish, posted;
  const entered = new Promise(resolve => { requested = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  h.context.callHook = async (command, payload) => {
    if (command === 'subs-available') return { available: true, source: { ...expected } };
    posted = payload; requested(); await pending;
    return { videoId: expected.videoId, source: { ...expected }, lang: expected.lang, text: 'Original text' };
  };
  const downloading = h.context.downloadSubtitles(h.info, 'txt', selected);
  await entered; selected.lang = 'ru'; selected.trackId = 'Changed track'; h.info.title = 'Changed title'; finish();
  assert.equal(await downloading, 'Fixture [en].txt');
  assert.equal(posted.source.lang, 'en'); assert.equal(posted.source.trackId, 'fixture:en');
  assert.equal(Object.isFrozen(posted.source), true);
  assert.equal(h.messages.find(message => message.t === 'mendosave-save').filename, 'Fixture [en].txt');
});

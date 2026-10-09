const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML, DOMParser } = require('linkedom');

const payload = fs.readFileSync('tests/fixtures/vk-player.html', 'utf8');
const dash = fs.readFileSync('tests/fixtures/vk-audio.mpd', 'utf8');

function adapter(overrides = {}) {
  const { document, window } = parseHTML(overrides.shadowPlayer
    ? '<html><body><section class="vkit-lbf332 vkitInternalGroupCard VideoPlayerLayout__group--rDVMv"><div id="hidden-player" data-hidden="true"></div><div id="player-host"></div></section></body></html>'
    : '<html><body><div class="VideoPlayer__player"><video></video></div></body></html>');
  window.innerWidth = 900; window.innerHeight = 700;
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute('data-hidden')) return { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
    if (this.tagName === 'BUTTON') return { width: 36, height: 36, top: 424, bottom: 460, left: 610, right: 646 };
    return { width: 640, height: 360, top: 100, bottom: 460, left: 10, right: 650 };
  };
  let shadow;
  if (overrides.shadowPlayer) {
    const hidden = document.getElementById('hidden-player').attachShadow({ mode: 'open' });
    hidden.innerHTML = '<video></video><div><button aria-label="Настройки"></button></div>';
    shadow = document.getElementById('player-host').attachShadow({ mode: 'open' });
    shadow.innerHTML = `${overrides.noShadowVideo ? '' : '<video></video>'}<div class="controls"><button class="btn s-1r" aria-label="Приостановить"></button><button class="btn s-1r" aria-label="Настройки"></button></div>`;
  }
  const messages = [], requests = [];
  const responseBuffers = new WeakSet();
  // Mirror Gecko's Xray boundary for network-backed views: species access to
  // a foreign `constructor` is denied, while indexed bytes remain readable.
  function ContentUint8Array(input, offset, length) {
    const bytes = new Uint8Array(input, offset, length);
    if (responseBuffers.has(input)) Object.defineProperty(bytes, 'constructor', {
      get() { throw new Error('Permission denied to access property "constructor"'); },
    });
    return bytes;
  }
  ContentUint8Array.prototype = Uint8Array.prototype;
  const context = vm.createContext({ document, window, URL,
    Uint8Array: overrides.foreignViews ? ContentUint8Array : Uint8Array, btoa, crypto, DOMParser, TextDecoder,
    location: new URL(overrides.page || 'https://vkvideo.ru/video-1_2'), getComputedStyle: () => ({ position: 'relative' }),
    setInterval() {}, setTimeout(fn) { fn(); }, clearTimeout() {}, console: { error() {} },
    chrome: { runtime: { getManifest: () => ({ version: '0.1.0' }), onMessage: { addListener() {}, removeListener() {} },
      async sendMessage(message) {
        messages.push(message);
        if (message.t === 'mendosave-register-job') return { ok: true, tabId: 7 };
        if (message.t === 'mendosave-download-state') return { ok: true, state: 'complete' };
        return { ok: true, id: 42 };
      },
    } },
    async fetch(url, options = {}) {
      requests.push({ url: String(url), options });
      if (String(url).includes('video_ext.php')) return {
        ok: true, headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        async arrayBuffer() { return new TextEncoder().encode(overrides.payload || payload).buffer; },
      };
      if (String(url).endsWith('.mpd')) return { ok: true, async text() { return overrides.dash || dash; } };
      if (options.method === 'HEAD' || options.method === 'GET') return {
        ok: true,
        headers: new Headers({ 'content-length': options.method === 'GET'
          ? (overrides.getTotalBytes ?? overrides.totalBytes ?? 4) : (overrides.totalBytes ?? 4) }),
        body: { async cancel() {} },
      };
      return { status: overrides.status || 206, headers: new Headers(overrides.rangeHeaders || {}),
        async arrayBuffer() {
          const buffer = (overrides.bytes || Uint8Array.of(1, 2, 3, 4)).slice().buffer;
          if (overrides.foreignViews) responseBuffers.add(buffer);
          return buffer;
        } };
    },
  });
  vm.runInContext(fs.readFileSync('extension/vk.js', 'utf8'), context);
  const click = (element) => element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  const settle = async () => { for (let n = 0; n < 12; n++) await new Promise(setImmediate); };
  return { document, messages, requests, click, settle, window, shadow };
}

async function open(a) { a.click(a.document.querySelector('.mendosave-vk-btn')); await a.settle(); }
async function saveAudio(a) {
  await open(a);
  const control = [...a.document.querySelectorAll('[role="button"]')].find((node) => /M4A/.test(node.textContent));
  assert.ok(control, a.document.querySelector('.mendosave-vk-menu').textContent);
  a.click(control); await a.settle();
}

test('VK offers progressive video and streams its complete SegmentBase AAC as M4A', async () => {
  const a = adapter(); await saveAudio(a);
  const started = a.messages.find((m) => m.t === 'mendosave-begin');
  assert.equal(started.audioFormat, 'm4a');
  assert.equal(started.audioSize, 4);
  assert.equal(a.messages.find((m) => m.t === 'mendosave-chunk').b64, 'AQIDBA==');
  assert.equal(a.messages.filter((m) => m.t === 'mendosave-finalize').length, 1);
});

test('VK aborts an incomplete range instead of finalizing repeated or missing audio bytes', async () => {
  const a = adapter({ bytes: Uint8Array.of(1, 2, 3) }); await saveAudio(a);
  assert.equal(a.messages.some((m) => m.t === 'mendosave-finalize'), false);
  assert.equal(a.messages.some((m) => m.t === 'mendosave-abort'), true);
  assert.equal(a.messages.some((m) => m.t === 'mendosave-chunk'), false);
});

test('VK rejects a complete range whose exposed total disagrees with the probed audio size', async () => {
  const a = adapter({ rangeHeaders: { 'content-range': 'bytes 0-3/999' } });
  await saveAudio(a);
  assert.equal(a.requests.find((request) => request.options.headers?.Range)?.options.headers.Range, 'bytes=0-3');
  assert.equal(a.messages.some((message) => message.t === 'mendosave-finalize'), false);
  assert.equal(a.messages.some((message) => message.t === 'mendosave-chunk'), false);
  assert.equal(a.messages.some((message) => message.t === 'mendosave-abort'), true);
});

for (const totalBytes of ['9007199254740993', 'Infinity', '4.5', '4e0', '-4']) {
  test(`VK refuses an unsafe or nondecimal audio size: ${totalBytes}`, async () => {
    const a = adapter({ totalBytes });
    await saveAudio(a);
    assert.equal(a.messages.some((message) => message.t === 'mendosave-begin'), false);
    assert.equal(a.messages.some((message) => message.t === 'mendosave-finalize'), false);
    assert.equal(a.requests.some((request) => request.options.headers?.Range), false);
  });
}

for (const range of [null, 'bytes 0-3/4', 'bytes 0-3/*']) {
  test(`VK preserves exact audio transfer with a ${range === null ? 'CORS-hidden Content-Range' : range}`, async () => {
    const a = adapter({ rangeHeaders: range === null ? {} : { 'content-range': range } });
    await saveAudio(a);
    assert.equal(a.messages.some((message) => message.t === 'mendosave-abort'), false);
    assert.equal(a.messages.filter((message) => message.t === 'mendosave-finalize').length, 1);
    const chunks = a.messages.filter((message) => message.t === 'mendosave-chunk');
    assert.deepEqual(Buffer.concat(chunks.map((message) => Buffer.from(message.b64, 'base64'))), Buffer.from([1, 2, 3, 4]));
  });
}

for (const range of ['bytes 0-3/3', 'bytes 0-3/9007199254740993', 'bytes 0-9007199254740993/4']) {
  test(`VK refuses invalid or unsafe Content-Range numbers: ${range}`, async () => {
    const a = adapter({ rangeHeaders: { 'content-range': range } });
    await saveAudio(a);
    assert.equal(a.messages.some((message) => message.t === 'mendosave-chunk'), false);
    assert.equal(a.messages.some((message) => message.t === 'mendosave-finalize'), false);
    assert.equal(a.messages.some((message) => message.t === 'mendosave-abort'), true);
  });
}

test('VK can obtain a safe size through GET after an unusable HEAD size', async () => {
  const a = adapter({ totalBytes: '9007199254740993', getTotalBytes: 4 });
  await saveAudio(a);
  assert.ok(a.requests.some((request) => request.options.method === 'GET'));
  assert.equal(a.messages.find((message) => message.t === 'mendosave-begin').audioSize, 4);
  assert.equal(a.messages.filter((message) => message.t === 'mendosave-finalize').length, 1);
});

test('VK reads player files even when a quoted URL contains a closing brace', async () => {
  const a = adapter({ payload: payload.replace('video.mp4', 'video.mp4?label=}') });
  await open(a);
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /Видео со звуком/);
});

test('VK refuses DASH encryption rather than downloading protected audio as plain AAC', async () => {
  const a = adapter({ dash: dash.replace('<Representation', '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/><Representation') });
  await saveAudio(a);
  assert.equal(a.messages.some((m) => m.t === 'mendosave-begin'), false);
  assert.match(a.document.querySelector('.mendosave-vk-toast').textContent, /зашифрован/);
});

test('VK chooses AAC for an M4A save even when a higher bitrate Opus representation exists', async () => {
  const other = '<Representation id="opus" codecs="opus" bandwidth="256000"><BaseURL>opus.webm</BaseURL></Representation>';
  const a = adapter({ dash: dash.replace('</AdaptationSet>', `${other}</AdaptationSet>`) });
  await saveAudio(a);
  assert.ok(a.requests.some((request) => request.url === 'https://media.example/audio.m4a'));
  assert.equal(a.requests.some((request) => request.url.endsWith('opus.webm')), false);
});

test('VK video choices can be activated with Space', async () => {
  const a = adapter(); await open(a);
  const event = new a.window.Event('keydown', { bubbles: true, cancelable: true }); event.key = ' ';
  a.document.querySelector('[role="button"]').dispatchEvent(event); await a.settle();
  assert.equal(a.messages.some((m) => m.t === 'mendosave-save'), true);
});

test('VK transfers exact audio bytes when a network view has an inaccessible foreign constructor', async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 7);
  bytes[0] = 0x47; bytes[32767] = 0xaa; bytes[32768] = 0xbb;
  bytes[4 * 1024 * 1024 - 1] = 0xcc; bytes[4 * 1024 * 1024] = 0xdd;
  bytes[bytes.length - 1] = 0xee;
  const a = adapter({ foreignViews: true, bytes, totalBytes: bytes.length });
  await saveAudio(a);
  assert.equal(a.messages.some((m) => m.t === 'mendosave-abort'), false,
    a.document.querySelector('.mendosave-vk-toast').textContent);
  const chunks = a.messages.filter((m) => m.t === 'mendosave-chunk');
  assert.equal(chunks.length, 2);
  assert.deepEqual(Buffer.concat(chunks.map((m) => Buffer.from(m.b64, 'base64'))), Buffer.from(bytes));
  assert.equal(a.messages.filter((m) => m.t === 'mendosave-finalize').length, 1);
});

test('VK mounts into a visible video shadow root without legacy container class names', async () => {
  const a = adapter({ shadowPlayer: true });
  const button = a.shadow.querySelector('.mendosave-vk-btn');
  assert.ok(button, 'the active player must receive a download control');
  assert.ok(a.shadow.querySelector('style[data-mendosave]'), 'shadow controls require their own inline stylesheet');
  assert.equal(a.document.getElementById('hidden-player').shadowRoot.querySelector('.mendosave-vk-btn'), null);
  a.click(button); await a.settle();
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /Видео со звуком/);
  a.document.dispatchEvent(new a.window.Event('visibilitychange'));
  assert.equal(a.shadow.querySelectorAll('.mendosave-vk-btn').length, 1);
});

test('VK ignores visible generic shadow controls without media or a page video identity', () => {
  const withoutMedia = adapter({ shadowPlayer: true, noShadowVideo: true });
  assert.equal(withoutMedia.shadow.querySelector('.mendosave-vk-btn'), null);
  const withoutVideoId = adapter({ shadowPlayer: true, page: 'https://vkvideo.ru/' });
  assert.equal(withoutVideoId.shadow.querySelector('.mendosave-vk-btn'), null);
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { producerPorts } = require('./producer-port-harness.cjs');
const { create: createPackageUI } = require('../extension/package_ui.js');
const { parseHTML, DOMParser, UserEvent } = require('./user-dom.cjs');

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
  if (overrides.withPackage) {
    let focused;
    Object.defineProperty(document, 'activeElement', { get: () => focused });
    window.HTMLElement.prototype.focus = function () { focused = this; };
  }
  let shadow;
  if (overrides.shadowPlayer) {
    const hidden = document.getElementById('hidden-player').attachShadow({ mode: 'open' });
    hidden.innerHTML = '<video></video><div><button aria-label="Настройки"></button></div>';
    shadow = document.getElementById('player-host').attachShadow({ mode: 'open' });
    shadow.innerHTML = `${overrides.noShadowVideo ? '' : '<video></video>'}<div class="controls"><button class="btn s-1r" aria-label="Приостановить"></button><button class="btn s-1r" aria-label="Настройки"></button></div>`;
  }
  const messages = [], requests = [], sourceTimers = [];
  const bridgeMessages = [], bridgeRequests = [], frames = [];
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
  const context = vm.createContext({ document, window, URL, AbortController, AbortSignal,
    Uint8Array: overrides.foreignViews ? ContentUint8Array : Uint8Array, btoa, crypto, DOMParser, TextDecoder,
    location: new URL(overrides.page || 'https://vkvideo.ru/video-1_2'), TextEncoder, getComputedStyle: () => ({ position: 'relative' }),
    setInterval() {}, setTimeout(fn, delay) {
      if (delay >= 10_000) { sourceTimers.push({ fn, delay }); return sourceTimers.length; }
      fn();
    }, clearTimeout() {}, console: { error() {} },
    chrome: { runtime: { getManifest: () => ({ version: '0.1.0' }), onMessage: { addListener() {}, removeListener() {} },
      async sendMessage(message) {
        if (/^mendosave-(?:begin|chunk|abort|finalize)$/.test(message.t)) assert.equal(message.instanceId, 'processor-fixture');
        messages.push(message);
        if (overrides.sendResponder) return overrides.sendResponder(message);
        if (message.t === 'mendosave-register-job') return { ok: true, tabId: 7 };
        if (message.t === 'mendosave-download-state') return { ok: true, state: 'complete' };
        return { ok: true, id: 42 };
      },
    } },
    async fetch(url, options = {}) {
      requests.push({ url: String(url), options });
      if (overrides.fetchResponder && String(url).includes('video_ext.php')) return overrides.fetchResponder(url, options);
      if (String(url).includes('video_ext.php')) return {
        ok: true, headers: new Headers({ 'content-type': overrides.contentType || 'text/html; charset=utf-8' }),
        async arrayBuffer() { return overrides.payloadBytes
          ? overrides.payloadBytes.slice().buffer : new TextEncoder().encode(overrides.payload || payload).buffer; },
      };
      if (overrides.mediaResponder) return overrides.mediaResponder(url, options);
      if (String(url).endsWith('.mpd')) return { ok: true, async text() { return overrides.dash || dash; } };
      if (options.method === 'HEAD' || options.method === 'GET') return {
        ok: true,
        headers: new Headers({ 'content-length': options.method === 'GET'
          ? (overrides.getTotalBytes ?? overrides.totalBytes ?? 4) : (overrides.totalBytes ?? 4) }),
        body: { async cancel() {} },
      };
      return { status: overrides.status || 206, headers: new Headers(overrides.rangeHeaders || {}),
        body: new ReadableStream({ start(controller) {
          const buffer = (overrides.bytes || Uint8Array.of(1, 2, 3, 4)).slice().buffer;
          if (overrides.foreignViews) responseBuffers.add(buffer);
          controller.enqueue(new ContentUint8Array(buffer)); controller.close();
        } }) };
    },
  });
  const producers = producerPorts();
  context.chrome.runtime.connect = overrides.connectResponder || producers.connect;
  context.MendoPackageUI = createPackageUI({ runtime: context.chrome.runtime, fetch: (...args) => context.fetch(...args),
    document: overrides.withPackage ? document : undefined, queue: require('../extension/package_queue.js') });
  if (overrides.modernFrame) {
    const append = document.body.appendChild.bind(document.body);
    document.body.appendChild = function (element) {
      const result = append(element);
      if (element.tagName !== 'IFRAME') return result;
      frames.push(element);
      const { window: childWindow } = parseHTML('<html><body></body></html>');
      // linkedom forwards arbitrary Window properties to Node's shared global;
      // a browser's embed document instead starts with its own clean realm.
      childWindow.__mendosaveVKBridge = false;
      const childLocation = new URL(element.src);
      const dispatch = (target, source, origin, data) => {
        const event = new target.Event('message');
        event.source = source; event.origin = origin; event.data = structuredClone(data);
        queueMicrotask(() => target.dispatchEvent(event));
      };
      const parent = { location: context.location,
        postMessage(data) { bridgeMessages.push(structuredClone(data)); dispatch(window, childWindow, childLocation.origin, data); } };
      childWindow.parent = parent;
      childWindow.postMessage = data => { bridgeRequests.push(structuredClone(data)); dispatch(childWindow, parent, context.location.origin, data); };
      childWindow.fetch = async () => overrides.nativeDeferred || new Response(JSON.stringify(overrides.nativeEmbed || {
        response: { error_code: 0, video: { owner_id: -1, id: 2, title: 'Modern fixture', duration: 19,
          files: { mp4_720: 'https://vkvd526.okcdn.ru/?fixture=720', dash_sep: 'https://vkvd526.okcdn.ru/?fixture=dash' } } },
      }), { headers: { 'content-type': 'application/json' } });
      Object.defineProperty(element, 'contentWindow', { value: childWindow });
      const child = vm.createContext({ window: childWindow, location: childLocation, URL, TextDecoder,
        TextEncoder, Uint8Array, AbortController, crypto, console, setTimeout() { return 1; }, clearTimeout() {} });
      for (const file of ['vk_source.js', 'vk_bridge.js']) {
        vm.runInContext(fs.readFileSync(`extension/${file}`, 'utf8'), child);
      }
      Promise.resolve(childWindow.fetch('https://api.vk.ru/method/video.getEmbed'))
        .then(() => element.dispatchEvent(new window.Event('load')));
      return result;
    };
  }
  vm.runInContext(fs.readFileSync('extension/vk_source.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('extension/menu.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('extension/vk.js', 'utf8'), context);
  const click = (element) => element.dispatchEvent(new UserEvent('click', { bubbles: true, cancelable: true }));
  const settle = async () => { for (let n = 0; n < 12; n++) await new Promise(setImmediate); };
  return { document, messages, requests, sourceTimers, bridgeMessages, bridgeRequests, frames,
    click, settle, window, shadow, location: context.location, producers };
}

async function open(a) { a.click(a.document.querySelector('.mendosave-vk-btn')); await a.settle(); }
const choiceControls = a => [...a.document.querySelectorAll('.mendosave-vk-item[role]')]
  .filter(node => /^(?:Видео со звуком|Только звук)/.test(node.textContent));
async function saveAudio(a) {
  await open(a);
  const control = choiceControls(a).find((node) => /M4A/.test(node.textContent));
  assert.ok(control, a.document.querySelector('.mendosave-vk-menu').textContent);
  a.click(control); await a.settle();
}

function movingPlayer() {
  const app = adapter();
  app.window.scrollY = 0;
  app.window.Element.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('mendosave-vk-menu')) {
      const left = parseFloat(this.style.left) || 0, top = parseFloat(this.style.top) || 0;
      const width = Math.min(280, app.window.innerWidth - 16), height = Math.min(300, parseFloat(this.style.maxHeight) || 300);
      return { width, height, left, right: left + width, top, bottom: top + height };
    }
    const offset = app.window.scrollY || 0;
    if (this.tagName === 'BUTTON') {
      const left = Math.min(610, app.window.innerWidth - 50), top = Math.min(424 - offset, app.window.innerHeight - 60);
      return { width: 36, height: 36, top, bottom: top + 36, left, right: left + 36 };
    }
    return { width: 640, height: 360, top: 100 - offset, bottom: 460 - offset, left: 10, right: 650 };
  };
  return app;
}

test('same-source scrolling follows the live player without covering the VK trigger', async () => {
  const app = movingPlayer(); await open(app);
  const menu = app.document.querySelector('.mendosave-vk-menu');
  app.window.scrollY = 150; app.window.dispatchEvent(new app.window.Event('scroll')); await app.settle();
  const rect = menu.getBoundingClientRect(), anchor = app.document.querySelector('.mendosave-vk-btn').getBoundingClientRect();
  assert.equal(menu.isConnected, true);
  assert.equal(rect.left < anchor.right && rect.right > anchor.left && rect.top < anchor.bottom && rect.bottom > anchor.top, false);
  assert.equal(app.messages.some(message => message.t === 'mendosave-save'), false);
});

test('an open VK menu remains inside a resized narrow viewport', async () => {
  const app = movingPlayer(); await open(app);
  app.window.innerWidth = 360; app.window.innerHeight = 240; app.window.dispatchEvent(new app.window.Event('resize')); await app.settle();
  const rect = app.document.querySelector('.mendosave-vk-menu').getBoundingClientRect();
  assert.ok(rect.left >= 0 && rect.right <= 360 && rect.top >= 0 && rect.bottom <= 240);
});

test('VK menu remains open while the page scrolls up or down', async () => {
  const a = adapter(); await open(a);
  const menu = a.document.querySelector('.mendosave-vk-menu');
  assert.ok(menu);
  for (const scrollY of [450, 0, 900, 200]) {
    a.window.scrollY = scrollY;
    a.window.dispatchEvent(new a.window.Event('scroll'));
    await a.settle();
    assert.equal(a.document.querySelector('.mendosave-vk-menu') === menu, true);
  }
  assert.equal(a.messages.some(message => message.t === 'mendosave-save'), false);
});

test('VK menu keeps inside clicks and still closes on a repeat trigger or an outside click after scrolling', async () => {
  const a = adapter(); await open(a);
  const menu = a.document.querySelector('.mendosave-vk-menu');
  a.window.dispatchEvent(new a.window.Event('scroll'));
  a.click(menu); await a.settle();
  assert.equal(a.document.querySelector('.mendosave-vk-menu') === menu, true);
  a.click(a.document.querySelector('.mendosave-vk-btn')); await a.settle();
  assert.equal(Boolean(a.document.querySelector('.mendosave-vk-menu')), false);
  await open(a);
  a.window.dispatchEvent(new a.window.Event('scroll'));
  a.click(a.document.body); await a.settle();
  assert.equal(Boolean(a.document.querySelector('.mendosave-vk-menu')), false);
  assert.equal(a.messages.some(message => message.t === 'mendosave-save'), false);
});

test('a tall VK menu leaves its trigger exposed for a repeat click', async () => {
  const a = adapter();
  a.window.innerWidth = 1246; a.window.innerHeight = 883;
  const baseLayout = a.window.Element.prototype.getBoundingClientRect;
  a.window.Element.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('mendosave-vk-btn')) return { left: 799, right: 825, top: 463, bottom: 503, width: 26, height: 40 };
    if (this.classList.contains('mendosave-vk-menu')) {
      const width = Math.min(272, parseFloat(this.style.maxWidth) || Infinity);
      const height = Math.min(601.2, parseFloat(this.style.maxHeight) || Infinity);
      const left = parseFloat(this.style.left) || 0, top = parseFloat(this.style.top) || 0;
      return { left, top, right: left + width, bottom: top + height, width, height };
    }
    return baseLayout.call(this);
  };
  await open(a);
  const menu = a.document.querySelector('.mendosave-vk-menu').getBoundingClientRect();
  const trigger = a.document.querySelector('.mendosave-vk-btn').getBoundingClientRect();
  const overlaps = menu.left < trigger.right && menu.right > trigger.left && menu.top < trigger.bottom && menu.bottom > trigger.top;
  assert.equal(overlaps, false, 'a native click at the extension icon must not hit a quality row');
  assert.equal(menu.left >= 0 && menu.top >= 0 && menu.right <= 1246 && menu.bottom <= 883, true);
});

test('a tall VK menu scrolls within a narrow viewport while leaving its trigger exposed', async () => {
  const a = adapter();
  a.window.innerWidth = 326; a.window.innerHeight = 843;
  const baseLayout = a.window.Element.prototype.getBoundingClientRect;
  a.window.Element.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('mendosave-vk-btn')) return { left: 280, right: 306, top: 380, bottom: 420, width: 26, height: 40 };
    if (this.classList.contains('mendosave-vk-menu')) {
      const width = 272, height = Math.min(601.2, parseFloat(this.style.maxHeight) || Infinity);
      const left = parseFloat(this.style.left) || 0, top = parseFloat(this.style.top) || 0;
      return { left, top, right: left + width, bottom: top + height, width, height };
    }
    return baseLayout.call(this);
  };
  await open(a);
  const menu = a.document.querySelector('.mendosave-vk-menu').getBoundingClientRect();
  const trigger = a.document.querySelector('.mendosave-vk-btn').getBoundingClientRect();
  const overlaps = menu.left < trigger.right && menu.right > trigger.left && menu.top < trigger.bottom && menu.bottom > trigger.top;
  assert.equal(overlaps, false);
  assert.equal(menu.left >= 0 && menu.top >= 0 && menu.right <= 326 && menu.bottom <= 843, true);
  assert.equal(menu.height < 601.2, true, 'the list must scroll when no side has enough room');
});

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
  const event = new UserEvent('keydown', { bubbles: true, cancelable: true }); event.key = ' ';
  choiceControls(a)[0].dispatchEvent(event); await a.settle();
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

test('VK ignores a closed request failure after a different source menu succeeds', async () => {
  let finishOld;
  const old = new Promise(resolve => { finishOld = resolve; });
  let requestCount = 0;
  const response = body => ({ ok: true, headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    async arrayBuffer() { return new TextEncoder().encode(body).buffer; } });
  const a = adapter({ fetchResponder: () => ++requestCount === 1 ? old : response(payload) });
  await open(a);
  a.click(a.document.querySelector('.mendosave-vk-btn'));
  a.location.pathname = '/video-1_3';
  await open(a);
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /Видео со звуком/);
  finishOld(response('<html><title>No player</title></html>'));
  await a.settle();
  assert.doesNotMatch(a.document.querySelector('.mendosave-vk-menu').textContent, /Ошибка:/);
  assert.equal(a.messages.some(message => message.t === 'mendosave-save'), false);
});

test('VK offers matching modern player files through an owned embed frame without transferring authentication', async () => {
  const a = adapter({ modernFrame: true, payload: '<html><script>window.isBFF = true;</script></html>' });
  await open(a);
  const item = choiceControls(a).find(node => /Видео со звуком · 720p/.test(node.textContent));
  assert.ok(item, a.document.querySelector('.mendosave-vk-menu').textContent);
  a.click(item); await a.settle();
  assert.equal(a.messages.find(message => message.t === 'mendosave-save').url, 'https://vkvd526.okcdn.ru/?fixture=720');
  assert.equal(a.frames.length, 1);
  assert.equal(a.frames[0].isConnected, false, 'the temporary player document must be released');
  assert.doesNotMatch(JSON.stringify(a.bridgeMessages), /access_token|cookie|Authorization|credentials|getWebToken/);
});

test('VK opens the new SPA source on the first click while the previous source is still loading', async () => {
  let finishOld, calls = 0;
  const old = new Promise(resolve => { finishOld = resolve; });
  const response = { ok: true, headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    async arrayBuffer() { return new TextEncoder().encode(payload).buffer; } };
  const a = adapter({ fetchResponder: () => ++calls === 1 ? old : response });
  await open(a);
  a.location.pathname = '/video-1_3';
  await open(a);
  assert.match(a.document.querySelector('.mendosave-vk-menu')?.textContent || '', /Видео со звуком/);
  assert.equal(a.requests[0].options.signal.aborted, true);
  finishOld(response); await a.settle();
  assert.equal(a.document.querySelectorAll('.mendosave-vk-menu').length, 1);
});

test('VK stops a stalled source request and permits a fresh successful retry', async () => {
  let finishOld, calls = 0;
  const old = new Promise(resolve => { finishOld = resolve; });
  const response = { ok: true, headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    async arrayBuffer() { return new TextEncoder().encode(payload).buffer; } };
  const a = adapter({ fetchResponder: () => ++calls === 1 ? old : response });
  await open(a);
  a.sourceTimers.findLast(timer => timer.delay === 20_000)?.fn();
  await a.settle();
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /не ответил вовремя/);
  assert.equal(a.requests[0].options.signal.aborted, true);
  a.click(a.document.querySelector('.mendosave-vk-btn'));
  await open(a);
  finishOld(response); await a.settle();
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /Видео со звуком/);
  assert.doesNotMatch(a.document.querySelector('.mendosave-vk-menu').textContent, /Ошибка:/);
});

for (const [name, video, expected] of [
  ['another video id', { owner_id: -1, id: 99, files: { mp4_720: 'https://vkvd526.okcdn.ru/?fixture=720' } }, /другому видео/],
  ['missing files', { owner_id: -1, id: 2 }, /нет доступных файлов/],
  ['non-HTTPS file', { owner_id: -1, id: 2, files: { mp4_720: 'http://vkvd526.okcdn.ru/?fixture=720' } }, /неподдержанные данные/],
  ['foreign HTTPS host', { owner_id: -1, id: 2, files: { mp4_720: 'https://vkvd526.okcdn.ru.attacker.example/' } }, /неподдержанные данные/],
  ['unknown CDN route', { owner_id: -1, id: 2, files: { mp4_720: 'https://vkvd526.okcdn.ru/account' } }, /неподдержанные данные/],
  ['credential URL', { owner_id: -1, id: 2, files: { mp4_720: 'https://name:password@vkvd526.okcdn.ru/' } }, /неподдержанные данные/],
  ['oversized files list', { owner_id: -1, id: 2, files: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`other${index}`, ''])) }, /допустимый размер/],
]) {
  test(`VK rejects modern ${name} without permitting a download`, async () => {
    const a = adapter({ modernFrame: true, payload: '<script>window.isBFF=true;</script>',
      nativeEmbed: { response: { error_code: 0, video } } });
    await open(a);
    assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, expected);
    assert.equal(choiceControls(a).length, 0);
    assert.equal(a.messages.some(message => /mendosave-(?:save|begin|chunk|finalize)/.test(message.t)), false);
    assert.equal(a.frames[0].isConnected, false);
  });
}

test('VK reports a native service refusal rather than treating its files as success', async () => {
  const a = adapter({ modernFrame: true, payload: '<script>window.isBFF=true;</script>',
    nativeEmbed: { response: { error_code: 15, error_message: 'secret must not cross bridge',
      video: { owner_id: -1, id: 2, files: { mp4_720: 'https://vkvd526.okcdn.ru/?fixture=720' } } } } });
  await open(a);
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /VK не разрешил/);
  assert.doesNotMatch(JSON.stringify(a.bridgeMessages), /secret/);
  assert.equal(a.messages.some(message => message.t === 'mendosave-save'), false);
});

test('VK selects the exact legacy response video after unrelated files and other response items', async () => {
  const unrelated = { files: { mp4_1080: 'https://media.example/other.mp4' }, title: 'Wrong clip' };
  const current = { owner_id: -1, id: 2, title: 'Selected legacy clip', duration: 19,
    files: { mp4_240: 'https://media.example/current.mp4' } };
  const a = adapter({ payload: `<script>var external=${JSON.stringify(unrelated)};
    var data=${JSON.stringify({ response: { items: [{ ...unrelated, owner_id: -1, id: 99 }, current] } })};</script>` });
  await open(a);
  assert.match(a.document.querySelector('.mendosave-vk-menu')?.textContent || '', /240p/);
  assert.doesNotMatch(a.document.querySelector('.mendosave-vk-menu').textContent, /1080p/);
  a.click(choiceControls(a)[0]); await a.settle();
  const saved = a.messages.find(message => message.t === 'mendosave-save');
  assert.equal(saved.url, 'https://media.example/current.mp4');
  assert.equal(saved.filename, 'VK - Selected legacy clip [240p].mp4');
});

test('VK refuses a legacy response whose known video belongs to another owner', async () => {
  const a = adapter({ payload: `<script>${JSON.stringify({ response: { items: [
    { owner_id: -99, id: 2, title: 'Wrong owner', files: { mp4_240: 'https://media.example/wrong.mp4' } },
  ] } })}</script>` });
  await open(a);
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /другому видео/);
  assert.equal(choiceControls(a).length, 0);
});

test('VK keeps the identity-less windows-1251 legacy title intact', async () => {
  const bytes = Uint8Array.from(Buffer.concat([
    Buffer.from('<script>var player={"md_title":"', 'ascii'), Buffer.from([0xd2, 0xe5, 0xf1, 0xf2]),
    Buffer.from('","duration":19,"files":{"mp4_240":"https://media.example/video.mp4"}};</script>', 'ascii'),
  ]));
  const a = adapter({ payloadBytes: bytes, contentType: 'text/html; charset=windows-1251' });
  await open(a); a.click(choiceControls(a)[0]); await a.settle();
  assert.equal(a.messages.find(message => message.t === 'mendosave-save').filename, 'VK - Тест [240p].mp4');
});

test('VK refuses an oversized embed document even when it contains otherwise valid files', async () => {
  const a = adapter({ payload: payload + ' '.repeat(2 * 1024 * 1024) });
  await open(a);
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /допустимый размер/);
  assert.equal(choiceControls(a).length, 0);
});

test('VK Back restores the single menu and fresh package focus without refetching the unchanged source', async () => {
  const a = adapter({ withPackage: true });
  await open(a);
  a.click(a.document.querySelector('.mendo-package-open')); await a.settle();
  const selected = a.document.querySelector('.mendo-package-dialog input'); selected.checked = true;
  const back = a.document.querySelector('[data-action="back"]');
  assert.ok(back);
  a.click(back); await a.settle();
  assert.match(a.document.querySelector('.mendosave-vk-menu')?.textContent || '', /240p/);
  const opener = a.document.querySelector('.mendo-package-open');
  assert.equal(a.document.activeElement === opener, true);
  assert.equal(opener.isConnected, true);
  assert.equal(a.requests.length, 1);
  assert.equal(a.messages.some(message => /mendosave-(?:save|begin|package-begin)/.test(message.t)), false);
  a.click(opener); await a.settle();
  assert.equal(a.document.querySelector('.mendo-package-dialog input').checked, true);
});

test('VK Back loads the current SPA source and does not restore the previous source selection', async () => {
  const a = adapter({ withPackage: true, fetchResponder: url => ({ ok: true,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    async arrayBuffer() { return new TextEncoder().encode(String(url).includes('id=3&')
      ? payload.replace('mp4_240', 'mp4_720') : payload).buffer; },
  }) });
  await open(a); a.click(a.document.querySelector('.mendo-package-open')); await a.settle();
  a.document.querySelector('.mendo-package-dialog input').checked = true;
  a.location.pathname = '/video-1_3';
  a.click(a.document.querySelector('[data-action="back"]')); await a.settle();
  assert.match(a.document.querySelector('.mendosave-vk-menu')?.textContent || '', /720p/);
  assert.doesNotMatch(a.document.querySelector('.mendosave-vk-menu').textContent, /240p/);
  assert.equal(a.requests.length, 2);
  a.click(a.document.querySelector('.mendo-package-open')); await a.settle();
  assert.equal(a.document.querySelector('.mendo-package-dialog input').checked, false);
});

test('VK keeps a selected quality when a fresh same-source response adds a higher rung', async () => {
  let calls = 0;
  const a = adapter({ withPackage: true, fetchResponder: () => {
    const heights = ++calls === 1 ? [720, 240] : [1080, 720, 240];
    const html = `<script>${JSON.stringify({ response: { items: [{ owner_id: -1, id: 2,
      title: 'Quality fixture', duration: 19,
      files: Object.fromEntries(heights.map(height => [`mp4_${height}`, `https://media.example/quality-${height}.mp4`])),
    }] } })}</script>`;
    return { ok: true, headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      async arrayBuffer() { return new TextEncoder().encode(html).buffer; } };
  } });
  await open(a); a.click(a.document.querySelector('.mendo-package-open')); await a.settle();
  const old = [...a.document.querySelectorAll('.mendo-package-dialog label')].find(node => /720p/.test(node.textContent));
  old.querySelector('input').checked = true;
  a.click(a.document.querySelector('[data-action="back"]')); await a.settle();
  a.click(a.document.querySelector('.mendosave-vk-btn'));
  await open(a); a.click(a.document.querySelector('.mendo-package-open')); await a.settle();
  const selected = [...a.document.querySelectorAll('.mendo-package-dialog label')]
    .filter(node => node.querySelector('input').checked).map(node => node.textContent);
  assert.equal(selected.length, 1);
  assert.match(selected[0], /720p/);
});

test('VK accepts no foreign frame, origin, request or unsolicited metadata fields', async () => {
  const a = adapter({ modernFrame: true, payload: '<script>window.isBFF=true;</script>',
    nativeDeferred: new Promise(() => {}) });
  await open(a);
  const request = a.bridgeRequests[0]; assert.ok(request);
  const frame = a.frames[0];
  const body = { __mendosave_vk_from_player: true, kind: 'result', requestId: request.requestId,
    frameHref: request.frameHref, sourceHref: request.sourceHref, oid: '-1', id: '2',
    video: { oid: '-1', id: '2', title: 'Page data', duration: 19,
      files: { mp4_720: 'https://vkvd526.okcdn.ru/?fixture=720' } } };
  const emit = (data, source = frame.contentWindow, origin = a.location.origin) => {
    const event = new a.window.Event('message'); event.data = data; event.source = source; event.origin = origin;
    a.window.dispatchEvent(event);
  };
  emit(body, a.window);
  emit(body, frame.contentWindow, 'https://vk.com');
  emit({ ...body, requestId: 'closed_menu' });
  emit({ ...body, frameHref: request.frameHref + '&foreign=1' });
  emit({ ...body, id: '99' });
  await a.settle();
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /Читаю данные/);
  assert.equal(a.messages.some(message => message.t === 'mendosave-save'), false);
  emit({ ...body, unsolicited: 'page-only tracking metadata' });
  await a.settle();
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /неподдержанные данные/);
  assert.equal(choiceControls(a).length, 0);
  assert.equal(frame.isConnected, false);
});

test('VK closes an aborted modern frame and ignores its late result after a new menu succeeds', async () => {
  let complete, calls = 0;
  const nativeDeferred = new Promise(resolve => { complete = resolve; });
  const a = adapter({ modernFrame: true, nativeDeferred, fetchResponder: () => ({ ok: true,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    async arrayBuffer() { return new TextEncoder().encode(++calls === 1 ? '<script>window.isBFF=true;</script>' : payload).buffer; },
  }) });
  await open(a);
  const oldFrame = a.frames[0]; assert.equal(oldFrame.isConnected, true);
  a.click(a.document.querySelector('.mendosave-vk-btn'));
  assert.equal(oldFrame.isConnected, false);
  assert.equal(a.requests[0].options.signal.aborted, true);
  a.location.pathname = '/video-1_3'; await open(a);
  complete(new Response(JSON.stringify({ response: { error_code: 0,
    video: { owner_id: -1, id: 2, files: { mp4_720: 'https://vkvd526.okcdn.ru/?fixture=720' } } } })));
  await a.settle();
  assert.match(a.document.querySelector('.mendosave-vk-menu')?.textContent || '', /240p/);
  assert.doesNotMatch(a.document.querySelector('.mendosave-vk-menu').textContent, /720p|Ошибка:/);
  assert.equal(a.messages.some(message => message.t === 'mendosave-save'), false);
});

test('VK releases a timed out modern frame and retries through the visible control', async () => {
  let calls = 0;
  const a = adapter({ modernFrame: true, nativeDeferred: new Promise(() => {}), fetchResponder: () => ({ ok: true,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    async arrayBuffer() { return new TextEncoder().encode(++calls === 1 ? '<script>window.isBFF=true;</script>' : payload).buffer; },
  }) });
  await open(a);
  a.sourceTimers.find(timer => timer.delay === 12_000).fn(); await a.settle();
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /не ответил вовремя/);
  assert.equal(a.frames[0].isConnected, false);
  a.click([...a.document.querySelectorAll('.mendosave-vk-menu button')].find(node => node.textContent === 'Повторить'));
  await a.settle();
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /240p/);
  assert.equal(a.requests.length, 2);
});

test('VK retries a reported HTTP refusal without launching a player or duplicate save', async () => {
  let calls = 0;
  const a = adapter({ fetchResponder: () => ++calls === 1 ? { ok: false, status: 503 }
    : new Response(payload, { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
  await open(a);
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /HTTP 503/);
  assert.equal(a.frames.length, 0);
  a.click([...a.document.querySelectorAll('.mendosave-vk-menu button')].find(node => node.textContent === 'Повторить'));
  await a.settle();
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /240p/);
  assert.equal(a.requests.length, 2);
  assert.equal(a.messages.some(message => message.t === 'mendosave-save'), false);
});

test('VK fails bounded legacy scanning rather than falling back to a later mismatching known video', async () => {
  const prefix = Array.from({ length: 32 }, () => JSON.stringify({ response: { unrelated: true } })).join(',');
  const known = { response: { items: [{ owner_id: -99, id: 2, files: { mp4_240: 'https://media.example/wrong.mp4' } }] } };
  const a = adapter({ payload: `<script>var misc=[${prefix}];var player=${JSON.stringify(known)};</script>` });
  await open(a);
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /допустимый размер/);
  assert.equal(choiceControls(a).length, 0);
});

test('VK refuses a stale package opener immediately after SPA navigation', async () => {
  const a = adapter({ withPackage: true });
  await open(a);
  const stale = a.document.querySelector('.mendo-package-open');
  a.location.pathname = '/video-1_3';
  a.click(stale); await a.settle();
  assert.equal(Boolean(a.document.querySelector('.mendo-package-dialog')), false);
  assert.equal(a.messages.some(message => message.t === 'mendosave-package-begin'), false);
  assert.equal(a.requests.length, 2, 'the new source menu may fetch its own data');
});

test('VK does not borrow an unrelated title when the matching legacy item has none', async () => {
  const current = { owner_id: -1, id: 2, files: { mp4_240: 'https://media.example/current.mp4' } };
  const a = adapter({ payload: `<script>var misc={"md_title":"Another video"};
    var data=${JSON.stringify({ response: { items: [current] } })};</script>` });
  await open(a); a.click(choiceControls(a)[0]); await a.settle();
  assert.equal(a.messages.find(message => message.t === 'mendosave-save').filename, 'VK - video-1_2 [240p].mp4');
});

test('VK enforces projection bytes for multibyte media metadata', async () => {
  const keys = ['mp4_144', 'mp4_240', 'mp4_360', 'mp4_480', 'mp4_720', 'mp4_1080', 'mp4_1440', 'mp4_2160', 'dash_sep'];
  const a = adapter({ modernFrame: true, payload: '<script>window.isBFF=true;</script>', nativeEmbed: {
    response: { error_code: 0, video: { owner_id: -1, id: 2, title: 'Fixture', duration: 19,
      files: Object.fromEntries(keys.map(key => [key, `https://vkvd526.okcdn.ru/?fixture=${'Ж'.repeat(7500)}`])),
    } },
  } });
  await open(a);
  assert.match(a.document.querySelector('.mendosave-vk-menu').textContent, /допустимый размер/);
  assert.equal(choiceControls(a).length, 0);
});

test('VK single progressive 480p completes through browser download without a CORS body read', async () => {
  const a = adapter({ payload: `<script>var player=${JSON.stringify({ md_title: 'Single fixture',
    files: { mp4_480: 'https://vkvd526.okcdn.ru/?fixture=480' } })};</script>`,
  mediaResponder() { throw new TypeError('CDN body is not readable by extension fetch'); } });
  await open(a);
  a.click(choiceControls(a).find(node => /480p/.test(node.textContent))); await a.settle();
  assert.match(a.document.querySelector('.mendosave-vk-toast').textContent, /Готово: VK - Single fixture \[480p\]\.mp4/);
  assert.equal(a.requests.length, 1);
  assert.equal(a.messages.find(message => message.t === 'mendosave-save').filename, 'VK - Single fixture [480p].mp4');
  assert.equal(a.messages.some(message => message.t === 'mendosave-download-state'), true);
  assert.equal(a.messages.some(message => message.t === 'mendosave-begin' || message.t === 'mendosave-blob-open'), false);
});

test('VK package saves the selected progressive MP4 when its CDN is readable from VK but not the extension origin', async () => {
  const { fixture } = require('./package-io-harness.cjs');
  const bytes = Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0,
    105, 115, 111, 109, 97, 118, 99, 49);
  const pageSender = { id: 'mendo@test', tab: { id: 7 }, frameId: 0, documentId: 'vk-document' };
  const { io, saved, files } = fixture({ fetch: async () => {
    throw new TypeError('NetworkError when attempting to fetch resource.');
  } });
  const a = adapter({ withPackage: true, payload: `<script>var player=${JSON.stringify({
    md_title: 'CDN boundary fixture', duration: 19, files: {
      mp4_480: 'https://vkvd526.okcdn.ru/?fixture=480', mp4_720: 'https://vkvd526.okcdn.ru/?fixture=720',
    },
  })};</script>`,
  mediaResponder: (_url, options) => options.method === 'HEAD' || options.method === 'GET'
    ? { ok: true, status: 200, headers: new Headers({ 'content-length': String(bytes.length), 'content-type': 'video/mp4' }),
      body: { async cancel() {} } }
    : new Response(bytes, { status: 206,
      headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`, 'content-length': String(bytes.length) } }),
  async sendResponder(message) {
    if (message.t === 'mendosave-save') return io.handle({ ...message, t: 'mendosave-save-source',
      sourceOwner: { tabId: 7, frameId: 0, documentId: 'vk-document' } },
    { id: 'mendo@test', url: 'moz-extension://test/_generated_background_page.html' });
    if (/^mendosave-(?:package-|blob-)/.test(message.t)) return io.handle(message, pageSender);
    return { ok: true, id: 42, tabId: 7, state: 'complete' };
  } });
  await open(a);
  a.click(a.document.querySelector('.mendo-package-open')); await a.settle();
  const row = [...a.document.querySelectorAll('.mendo-package-dialog label')].find(node => /480p/.test(node.textContent));
  const input = row.querySelector('input'); input.checked = true;
  input.dispatchEvent(new a.window.Event('change', { bubbles: true }));
  a.click(a.document.querySelector('.mendo-package-dialog [data-mode=files]')); await a.settle();
  assert.match(a.document.querySelector('.mendo-package-dialog [role=status]').textContent, /Готово: 1/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].filename, 'VK - CDN boundary fixture [480p].mp4');
  assert.deepEqual(new Uint8Array(await saved[0].blob.arrayBuffer()), bytes);
  assert.equal(files.size, 0);
  assert.equal(io.host.active, null);
});

function progressivePackage({ total = 4, range, ...effects } = {}) {
  const { fixture } = require('./package-io-harness.cjs');
  const pageSender = { id: 'mendo@test', tab: { id: 7 }, frameId: 0, documentId: 'vk-ranges' };
  const state = fixture({ fetch: async () => { throw new TypeError('extension origin cannot read CDN'); }, ...effects });
  const transport = producerPorts();
  const a = adapter({ withPackage: true, payload: `<script>var player=${JSON.stringify({
    md_title: 'Ranges fixture', files: { mp4_480: 'https://vkvd526.okcdn.ru/?fixture=480',
      mp4_720: 'https://vkvd526.okcdn.ru/?fixture=720' },
  })};</script>`,
  connectResponder(options) {
    const port = transport.connect(options); port.sender = pageSender; state.io.connect(port); return port;
  },
  mediaResponder(url, options) {
    if (options.method === 'HEAD' || options.method === 'GET') return new Response(null, {
      headers: { 'content-length': String(total), 'content-type': 'video/mp4' },
    });
    return range ? range(String(url), options) : new Response(Uint8Array.of(1, 2, 3, 4), {
      status: 206, headers: { 'content-range': 'bytes 0-3/4', 'content-length': '4' },
    });
  },
  async sendResponder(message) {
    if (/^mendosave-(?:package-|blob-)/.test(message.t)) return state.io.handle(message, pageSender);
    if (message.t === 'mendosave-save') throw new Error('direct remote body fetch is not readable');
    return { ok: true, id: 42, tabId: 7, state: 'complete' };
  } });
  return { ...a, ...state, transport,
    async start(heights = [480], mode = 'files') {
      await open(a); a.click(a.document.querySelector('.mendo-package-open')); await a.settle();
      for (const row of a.document.querySelectorAll('.mendo-package-dialog label')) {
        const input = row.querySelector('input');
        input.checked = heights.some(height => row.textContent.includes(`${height}p`));
        input.dispatchEvent(new a.window.Event('change', { bubbles: true }));
      }
      a.click(a.document.querySelector(`.mendo-package-dialog [data-mode=${mode}]`)); await a.settle();
    },
    status: () => a.document.querySelector('.mendo-package-dialog [role=status]').textContent,
  };
}

test('VK package bounds multiple ranges and transfers exact video bytes across the 8 MiB boundary', async () => {
  const bytes = new Uint8Array(8 * 1024 ** 2 + 17);
  bytes[0] = 0x47; bytes[1024 ** 2 - 1] = 0xaa; bytes[1024 ** 2] = 0xbb;
  bytes[8 * 1024 ** 2 - 1] = 0xcc; bytes[8 * 1024 ** 2] = 0xdd; bytes[bytes.length - 1] = 0xee;
  const a = progressivePackage({ total: bytes.length, range: (_url, options) => {
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range).map(Number);
    return new Response(bytes.slice(from, to + 1), { status: 206,
      headers: { 'content-range': `bytes ${from}-${to}/${bytes.length}`, 'content-length': String(to - from + 1) } });
  } });
  await a.start();
  assert.match(a.status(), /Готово: 1/);
  assert.deepEqual(a.requests.filter(r => r.options.headers?.Range).map(r => r.options.headers.Range),
    ['bytes=0-1048575', 'bytes=1048576-2097151', 'bytes=2097152-3145727', 'bytes=3145728-4194303',
      'bytes=4194304-5242879', 'bytes=5242880-6291455', 'bytes=6291456-7340031',
      'bytes=7340032-8388607', 'bytes=8388608-8388624']);
  assert.deepEqual(new Uint8Array(await a.saved[0].blob.arrayBuffer()), bytes);
  assert.equal(a.messages.filter(m => m.t === 'mendosave-blob-chunk').every(m => Buffer.from(m.data, 'base64').length <= 1024 ** 2), true);
  assert.equal(a.files.size, 0);
});

test('VK package media reads preserve credential omission and refuse CDN redirects', async () => {
  const a = progressivePackage(); await a.start();
  assert.match(a.status(), /Готово: 1/);
  const media = a.requests.filter(r => !r.url.includes('video_ext.php'));
  assert.equal(media.length, 2);
  assert.equal(media.every(r => r.options.credentials === 'omit' && r.options.cache === 'no-store'
    && r.options.redirect === 'error'), true);
});

test('VK package rejects a declared video above the existing 1 GiB transfer limit before reading its body', async () => {
  const a = progressivePackage({ total: 1024 ** 3 + 1 }); await a.start();
  assert.match(a.status(), /превышает лимит/);
  assert.equal(a.requests.some(r => r.options.headers?.Range), false);
  assert.equal(a.saved.length, 0); assert.equal(a.files.size, 0);
});

test('VK package cancels an ignored Range with hidden length before accumulating an oversized body', async () => {
  let cancelled = false, reads = 0;
  const a = progressivePackage({ total: 8 * 1024 ** 2 + 1, range: () => ({ ok: true, status: 200,
    headers: new Headers(), body: new ReadableStream({ pull(controller) {
      if (!reads++) controller.enqueue(new Uint8Array(8 * 1024 ** 2 + 1));
    }, cancel() { cancelled = true; } }),
    arrayBuffer() { throw new Error('whole body must never be accumulated'); },
  }) });
  await a.start();
  assert.match(a.status(), /неполный или неверный диапазон/);
  assert.equal(cancelled, true);
  assert.equal(a.messages.some(m => m.t === 'mendosave-blob-finish'), false);
  assert.equal(a.saved.length, 0); assert.equal(a.files.size, 0); assert.equal(a.io.host.active, null);
});

test('VK package cancellation drains its pending range before releasing producers and permits an exact retry', async () => {
  let release, signal, rangeCount = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const a = progressivePackage({ range: (_url, options) => {
    if (++rangeCount > 1) return new Response(Uint8Array.of(1, 2, 3, 4), {
      status: 206, headers: { 'content-range': 'bytes 0-3/4', 'content-length': '4' },
    });
    signal = options.signal;
    return new Response(new ReadableStream({ async pull(controller) {
      await pending; controller.enqueue(Uint8Array.of(1, 2, 3, 4)); controller.close();
    } }), { status: 206, headers: { 'content-range': 'bytes 0-3/4', 'content-length': '4' } });
  } });
  await a.start();
  a.click(a.document.querySelector('.mendo-package-dialog [data-action=cancel]')); await a.settle();
  assert.equal(signal.aborted, true);
  assert.equal(a.transport.ports.filter(p => p.name === 'mendosave-producer').every(p => p.disconnected), false);
  assert.equal(a.document.querySelector('.mendo-package-dialog [data-mode=files]').disabled, true);
  assert.equal(a.saved.length, 0);
  release(); await a.settle();
  assert.match(a.status(), /Пакет отменён/);
  assert.equal(a.transport.ports.filter(p => p.name === 'mendosave-producer').every(p => p.disconnected), true);
  assert.equal(a.files.size, 0);
  a.click(a.document.querySelector('.mendo-package-dialog [data-mode=files]')); await a.settle();
  assert.match(a.status(), /Готово: 1/);
  assert.equal(a.saved.length, 1);
  assert.deepEqual(new Uint8Array(await a.saved[0].blob.arrayBuffer()), Uint8Array.of(1, 2, 3, 4));
});

test('VK ZIP contains both selected progressive files with the exact prepared raw bytes', async () => {
  const prepared = new Map();
  const a = progressivePackage({
    async prepare(blob, filename) {
      prepared.set(filename, Buffer.from(await blob.arrayBuffer()));
      return { blob, filename, id: `${filename}.bin`, size: blob.size };
    },
    range(url) { return new Response(url.includes('fixture=480') ? Uint8Array.of(1, 2, 3, 4) : Uint8Array.of(8, 7, 6, 5), {
      status: 206, headers: { 'content-range': 'bytes 0-3/4', 'content-length': '4' },
    }); },
  });
  await a.start([480, 720], 'zip');
  assert.match(a.status(), /Готово: Ranges fixture\.zip/);
  assert.equal(a.saved.length, 1); assert.match(a.saved[0].filename, /\.zip$/);
  const zip = Buffer.from(await a.saved[0].blob.arrayBuffer());
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), 2);
  let cursor = zip.readUInt32LE(zip.length - 6);
  const entries = [];
  for (let index = 0; index < 2; index++) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    assert.equal(zip.readUInt16LE(cursor + 10), 0);
    const length = zip.readUInt32LE(cursor + 24), nameLength = zip.readUInt16LE(cursor + 28);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const offset = zip.readUInt32LE(cursor + 42);
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    entries.push(name); assert.deepEqual(zip.subarray(start, start + length), prepared.get(name));
    cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  assert.deepEqual(entries.sort(), ['VK - Ranges fixture [480p].mp4', 'VK - Ranges fixture [720p].mp4']);
});

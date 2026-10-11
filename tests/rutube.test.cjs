const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { producerPorts } = require('./producer-port-harness.cjs');
const { create: createPackageUI } = require('../extension/package_ui.js');
const { parseHTML } = require('linkedom');

const page = 'https://rutube.ru/video/5295f2a858cdace0855c40f8a48f4676/';
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=293000,RESOLUTION=256x144,CODECS="avc1.42c014,mp4a.40.2"\nhttps://media.example/144.m3u8\n';
const fixture = fs.readFileSync('tests/fixtures/rutube-vod.m3u8', 'utf8');

function adapter(media = fixture, overrides = {}) {
  const { document, window } = parseHTML(overrides.html || '<html><body><div class="player"><video></video></div></body></html>');
  window.innerWidth = 1246; window.innerHeight = 983;
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.dataset.box) {
      const [left, top, width, height] = this.dataset.box.split(',').map(Number);
      return { left, top, width, height, right: left + width, bottom: top + height };
    }
    return { width: 640, height: 360, top: 100, bottom: 460, left: 10, right: 650 };
  };
  const messages = [], requests = [], errors = [];
  const responseBuffers = new WeakSet();
  // Model Gecko's Xray-wrapped views: numeric access works, but species-based
  // slice/subarray tries to read a foreign constructor and is denied. Only
  // network-backed buffers receive this boundary restriction.
  function ContentUint8Array(input, offset, length) {
    const bytes = new Uint8Array(input, offset, length);
    if (responseBuffers.has(input)) Object.defineProperty(bytes, 'constructor', {
      get() { throw new Error('Permission denied to access property "constructor"'); },
    });
    return bytes;
  }
  ContentUint8Array.prototype = Uint8Array.prototype;
  const context = vm.createContext({ document, window, URL, AbortController, AbortSignal,
    Uint8Array: overrides.foreignViews ? ContentUint8Array : Uint8Array, btoa, crypto,
    location: new URL(overrides.page || page), getComputedStyle: () => ({ position: 'relative' }),
    setInterval() {}, setTimeout(fn) { fn(); }, clearTimeout() {},
    console: { error(label, error) { errors.push(error || label); } },
    chrome: { runtime: { getManifest: () => ({ version: '0.1.0' }), async sendMessage(message) {
      if (/^mendosave-(?:begin|chunk|abort|finalize)$/.test(message.t)) assert.equal(message.instanceId, 'processor-fixture');
      messages.push(message);
      if (message.t === 'mendosave-register-job') return { ok: true, tabId: 7 };
      if (message.t === 'mendosave-finalize' && overrides.finalizeError) return { ok: false, error: 'mux failed' };
      return { ok: true };
    } } },
    async fetch(url) {
      requests.push(String(url));
      if (String(url).includes('/api/play/options/')) return { ok: true, async json() { return {
        title: 'Public fixture', duration: 54312, video_balancer: { m3u8: 'https://media.example/master.m3u8' }, ...overrides,
      }; } };
      if (String(url).endsWith('master.m3u8')) return { ok: true, async text() { return master; } };
      if (String(url).endsWith('144.m3u8')) return { ok: true, async text() { return media; } };
      return { ok: true, async arrayBuffer() {
        const buffer = (overrides.segmentBytes || Uint8Array.of(0x47, 1, 2)).slice().buffer;
        if (overrides.foreignViews) responseBuffers.add(buffer);
        return buffer;
      } };
    },
  });
  context.chrome.runtime.connect = producerPorts().connect;
  context.MendoPackageUI = createPackageUI({ runtime: context.chrome.runtime, fetch: (...args) => context.fetch(...args) });
  vm.runInContext(fs.readFileSync('extension/rutube.js', 'utf8'), context);
  const click = (element) => element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  const settle = async () => { for (let n = 0; n < 12; n++) await new Promise(setImmediate); };
  return { document, messages, requests, errors, click, settle, window };
}

test('Rutube public VOD streams ordered bytes and keeps the API duration in seconds', async () => {
  const a = adapter(); a.click(a.document.getElementById('mendosave-rutube-btn')); await a.settle();
  a.click(a.document.querySelector('[role="button"]')); await a.settle();
  assert.equal(a.messages.find((m) => m.t === 'mendosave-begin').duration, 54.312);
  assert.equal(a.messages.filter((m) => m.t === 'mendosave-chunk').map((m) => m.b64).join(','), 'RwEC,RwEC');
  assert.equal(a.messages.filter((m) => m.t === 'mendosave-finalize').length, 1);
});

test('Rutube refuses a rolling playlist instead of saving its current window as a complete VOD', async () => {
  const a = adapter(fixture.replace('#EXT-X-ENDLIST', ''));
  a.click(a.document.getElementById('mendosave-rutube-btn')); await a.settle();
  a.click(a.document.querySelector('[role="button"]')); await a.settle();
  assert.equal(a.messages.some((m) => m.t === 'mendosave-begin'), false);
  assert.match(a.document.querySelector('.mendosave-rt-toast').textContent, /завершён|трансляц/);
});

test('Rutube refuses encrypted HLS before a processor job or media request starts', async () => {
  const a = adapter(fixture.replace('#EXTINF:4.000,', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4.000,'));
  a.click(a.document.getElementById('mendosave-rutube-btn')); await a.settle();
  a.click(a.document.querySelector('[role="button"]')); await a.settle();
  assert.equal(a.messages.some((m) => m.t === 'mendosave-begin'), false);
  assert.equal(a.requests.some((url) => url.endsWith('.ts') || url.endsWith('key.bin')), false);
  assert.match(a.document.querySelector('.mendosave-rt-toast').textContent, /зашифрован/);
});

test('Rutube menu can be dismissed while playback options are still loading', async () => {
  const a = adapter();
  a.click(a.document.getElementById('mendosave-rutube-btn'));
  a.click(a.document.getElementById('mendosave-rutube-btn'));
  await a.settle();
  assert.equal(a.document.querySelector('.mendosave-rt-menu'), null);
});

test('Rutube quality choices can be activated with Enter', async () => {
  const a = adapter(); a.click(a.document.getElementById('mendosave-rutube-btn')); await a.settle();
  const event = new a.window.Event('keydown', { bubbles: true, cancelable: true }); event.key = 'Enter';
  a.document.querySelector('[role="button"]').dispatchEvent(event); await a.settle();
  assert.equal(a.messages.some((m) => m.t === 'mendosave-finalize'), true);
});

test('Rutube aborts its job when finalization fails so prepared chunks are released', async () => {
  const a = adapter(fixture, { finalizeError: true });
  a.click(a.document.getElementById('mendosave-rutube-btn')); await a.settle();
  a.click(a.document.querySelector('[role="button"]')); await a.settle();
  assert.equal(a.messages.some((m) => m.t === 'mendosave-abort'), true);
  assert.match(a.document.querySelector('.mendosave-rt-toast').textContent, /mux failed/);
});

test('Rutube transfers exact bytes from network views whose foreign constructor is inaccessible', async () => {
  const segment = new Uint8Array(4 * 1024 * 1024 + 7);
  segment[0] = 0x47; segment[32767] = 0xaa; segment[32768] = 0xbb;
  segment[4 * 1024 * 1024 - 1] = 0xcc; segment[4 * 1024 * 1024] = 0xdd;
  segment[segment.length - 1] = 0xee;
  const a = adapter(fixture, { foreignViews: true, segmentBytes: segment });
  a.click(a.document.getElementById('mendosave-rutube-btn')); await a.settle();
  a.click(a.document.querySelector('[role="button"]')); await a.settle();
  assert.equal(a.errors.length, 0, a.errors[0]?.message);
  const chunks = a.messages.filter((m) => m.t === 'mendosave-chunk');
  assert.equal(chunks.length, 4, 'each of two segments crosses the 4 MiB transfer boundary');
  const transferred = Buffer.concat(chunks.map((m) => Buffer.from(m.b64, 'base64')));
  assert.deepEqual(transferred, Buffer.concat([Buffer.from(segment), Buffer.from(segment)]));
  assert.equal(a.messages.filter((m) => m.t === 'mendosave-finalize').length, 1);
  assert.equal(a.messages.some((m) => m.t === 'mendosave-abort'), false);
});

test('Rutube Shorts mounts on the visible current action column and follows the next active card', async () => {
  const html = fs.readFileSync('tests/fixtures/rutube-shorts.html', 'utf8');
  const a = adapter(fixture, { html, page: 'https://rutube.ru/shorts/ad2ee104e6335c7f0debd626993ce774/' });
  const button = a.document.getElementById('mendosave-rutube-btn');
  assert.ok(button, 'the actual Shorts overlay must receive a control');
  assert.equal(button.parentElement.id, 'active');
  assert.equal(a.document.getElementById('side').querySelector('#mendosave-rutube-btn'), null);
  a.click(button); await a.settle();
  assert.match(a.document.querySelector('.mendosave-rt-menu').textContent, /144p MP4/);
  a.document.getElementById('active').dataset.box = '910,-800,48,591';
  a.document.getElementById('next').dataset.box = '910,220,48,591';
  a.window.dispatchEvent(new a.window.Event('scroll'));
  assert.equal(button.parentElement.id, 'next');
  assert.equal(a.document.querySelectorAll('#mendosave-rutube-btn').length, 1);
});

test('Rutube Shorts retains the older controls wrapper fallback and ignores entirely offscreen actions', () => {
  const page = 'https://rutube.ru/shorts/ad2ee104e6335c7f0debd626993ce774/';
  const legacy = adapter(fixture, { page, html: '<html><body><div class="controlsWrapper_hash" data-box="910,220,48,591"><div>↑</div><div id="legacy-actions">12<button>Like</button></div></div></body></html>' });
  assert.equal(legacy.document.getElementById('mendosave-rutube-btn').parentElement.id, 'legacy-actions');
  const offscreen = adapter(fixture, { page, html: '<html><body><div class="shortsControlsOverlay_hash" data-box="910,1203,48,591"><button>Like</button></div></body></html>' });
  assert.equal(offscreen.document.getElementById('mendosave-rutube-btn'), null);
});

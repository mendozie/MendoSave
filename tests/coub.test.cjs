const assert = require('node:assert/strict');
const { test } = require('node:test');
const { adapter, restrictNetworkViews } = require('./tiktok-adapter-harness.cjs');

function mp3(frames, truncated = false) {
  const size = 417;
  const bytes = new Uint8Array(frames * size + (truncated ? 100 : 0));
  for (let at = 0; at < bytes.length; at += size) bytes.set([0xff, 0xfb, 0x90, 0], at);
  return bytes;
}

function coub(audio, declaredVideoBytes = 8, actualVideoBytes = 8, send, streaming = false) {
  return adapter('coub.js', '<div data-permalink="or1i6abuay"><div class="viewer"></div></div>', 'https://coub.com/view/or1i6abuay', async (url) => {
    if (url.includes('/api/')) return { ok: true, json: async () => ({ permalink: 'or1i6abuay', title: 'Test loop', has_sound: true, duration: 0.01,
      file_versions: { html5: { video: { high: { url: 'https://media.invalid/video.mp4', size: declaredVideoBytes } }, audio: { high: { url: 'https://media.invalid/audio.mp3', size: audio.length } } } }, dimensions: { big: [640, 360] } }) };
    const bytes = url.endsWith('video.mp4') ? new Uint8Array(actualVideoBytes) : audio;
    if (streaming) {
      Object.defineProperty(bytes, 'constructor', {
        get() { throw Error('Permission denied to access property "constructor"'); },
      });
      let delivered = false;
      return { ok: true, status: 200, headers: { get: () => String(bytes.length) },
        body: { getReader: () => ({ read: async () => delivered ? { done: true }
          : (delivered = true, { done: false, value: bytes }) }) } };
    }
    return { ok: true, status: 200, headers: { get: () => String(bytes.length) }, arrayBuffer: async () => bytes.buffer };
  }, send);
}

async function combine(app) {
  app.click(app.document.querySelector('.mendosave-coub-btn'));
  await app.settle();
  app.click(app.document.querySelector('[role="button"].mendosave-coub-item'));
  await app.settle();
}

test('Coub refuses an MP3 with a truncated final frame instead of using a fabricated loop duration', async () => {
  const app = coub(mp3(2, true));
  await combine(app);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-begin'), false);
  assert.match(app.document.querySelector('.mendosave-coub-toast').textContent, /длительность/);
});

test('Coub refuses a track larger than the declared size instead of assembling extra bytes', async () => {
  const app = coub(mp3(2), 8, 9);
  await combine(app);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-begin'), false);
  assert.match(app.document.querySelector('.mendosave-coub-toast').textContent, /9 из 8/);
});

test('Coub uses the duration of complete MPEG-2 Layer III frames for looping', async () => {
  // MPEG-2, Layer III, 64 kb/s, 22050 Hz: 208 bytes and 576 samples/frame.
  const audio = new Uint8Array(5 * 208);
  for (let at = 0; at < audio.length; at += 208) audio.set([0xff, 0xf3, 0x80, 0], at);
  const app = coub(audio);
  await combine(app);
  const job = app.messages.find((x) => x.t === 'mendosave-begin');
  assert.ok(job);
  assert.ok(Math.abs(job.duration - 5 * 576 / 22050) < 0.000001);
  assert.equal(job.loopVideo, -1);
});

test('Coub direct video reports an interrupted browser download as an error', async () => {
  const app = coub(mp3(2), 8, 8, (message) => message.t === 'mendosave-download-state'
    ? { ok: true, state: 'interrupted', error: 'NETWORK_FAILED' } : { ok: true, id: 7 });
  app.click(app.document.querySelector('.mendosave-coub-btn'));
  await app.settle();
  app.click([...app.document.querySelectorAll('[role="button"]')].find((x) => x.textContent.includes('Видео без звука')));
  await app.settle();
  assert.match(app.document.querySelector('.mendosave-coub-toast').textContent, /NETWORK_FAILED/);
  assert.doesNotMatch(app.document.querySelector('.mendosave-coub-toast').textContent, /Готово:/);
});

test('Coub recognizes the current public API video/audio variants in the rendered menu', async () => {
  const payload = require('./fixtures/coub-item.json').payload;
  const app = adapter('coub.js', '<div data-permalink="or1i6abuay"><div class="viewer"></div></div>', 'https://coub.com/view/or1i6abuay', async () => ({ ok: true, json: async () => payload }));
  app.click(app.document.querySelector('.mendosave-coub-btn'));
  await app.settle();
  const text = app.document.querySelector('.mendosave-coub-menu').textContent;
  assert.match(text, /880×720/);
  assert.match(text, /Только звук · MP3/);
  assert.match(text, /один проход/);
});

test('Coub merged media already owns network bytes before MPEG parsing and chunk transfer', async () => {
  const audio = mp3(2);
  const app = coub(audio);
  restrictNetworkViews(app);
  await combine(app);
  const chunks = app.messages.filter((x) => x.t === 'mendosave-chunk');
  assert.deepEqual(Buffer.from(chunks.find((x) => x.track === 'video').b64, 'base64'), Buffer.alloc(8));
  assert.deepEqual(Buffer.from(chunks.find((x) => x.track === 'audio').b64, 'base64'), Buffer.from(audio));
  assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), true);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-abort'), false);
});

test('Coub owns streamed foreign Uint8Array chunks without invoking their denied constructor', async () => {
  const audio = mp3(2);
  const app = coub(audio, 8, 8, undefined, true);
  await combine(app);
  const chunks = app.messages.filter((x) => x.t === 'mendosave-chunk');
  assert.deepEqual(Buffer.from(chunks.find((x) => x.track === 'video').b64, 'base64'), Buffer.alloc(8));
  assert.deepEqual(Buffer.from(chunks.find((x) => x.track === 'audio').b64, 'base64'), Buffer.from(audio));
  assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), true);
});

test('Coub menu activates the selected audio action once with Enter or Space', async (t) => {
  for (const key of ['Enter', ' ']) await t.test(key === ' ' ? 'Space' : key, async () => {
    const app = coub(mp3(2));
    app.click(app.document.querySelector('.mendosave-coub-btn'));
    await app.settle();
    const item = [...app.document.querySelectorAll('[role="button"]')].find((x) => x.textContent.includes('Только звук'));
    assert.equal(app.press(item, key, true).defaultPrevented, true);
    assert.equal(app.press(item, 'a').defaultPrevented, false);
    assert.equal(app.messages.some((x) => x.t === 'mendosave-save'), false);
    const event = app.press(item, key);
    await app.settle();
    assert.equal(app.messages.filter((x) => x.t === 'mendosave-save').length, 1);
    assert.equal(event.defaultPrevented, true);
    assert.equal(app.document.querySelector('.mendosave-coub-menu'), null);
  });
});

test('Coub Escape closes the menu without starting a download or consuming later page keys', async () => {
  const app = coub(mp3(2));
  app.click(app.document.querySelector('.mendosave-coub-btn'));
  await app.settle();
  const event = app.press(app.document.body, 'Escape');
  assert.equal(Boolean(app.document.querySelector('.mendosave-coub-menu')), false);
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-save' || x.t === 'mendosave-begin'), false);
  assert.equal(app.press(app.document.body, 'Escape').defaultPrevented, false);
});

test('Coub names equal-resolution source variants by their API key and source byte size', async () => {
  const payload = require('./fixtures/coub-item.json').payload;
  const app = adapter('coub.js', '<div data-permalink="or1i6abuay"><div class="viewer"></div></div>', 'https://coub.com/view/or1i6abuay', async () => ({ ok: true, json: async () => payload }));
  app.click(app.document.querySelector('.mendosave-coub-btn'));
  await app.settle();
  const items = [...app.document.querySelectorAll('[role="button"]')].filter((x) => x.textContent.startsWith('Со звуком · 880×720'));
  assert.equal(items.length, 2);
  assert.match(items[0].querySelector('.mendosave-coub-text').textContent, /high/);
  assert.match(items[1].querySelector('.mendosave-coub-text').textContent, /med/);
  assert.match(items[0].querySelector('.mendosave-coub-hint').textContent, /видео 3\.3 МБ/);
  assert.match(items[1].querySelector('.mendosave-coub-hint').textContent, /видео 2\.4 МБ/);
});

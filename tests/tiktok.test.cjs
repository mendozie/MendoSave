const assert = require('node:assert/strict');
const { test } = require('node:test');
const { adapter, restrictNetworkViews } = require('./tiktok-adapter-harness.cjs');

function page(item) {
  return `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: item } } } })}</script>
    <article><div id="xgwrapper-0-6718335390845095173"></div><div class="SectionActionBarContainer"><a data-e2e="video-author-avatar" href="/@scout2015"></a></div></article>`;
}

test('TikTok menu shows the actual rendition dimensions rather than its nominal gear', async () => {
  const item = require('./fixtures/tiktok-item.json').item;
  const app = adapter('tiktok.js', page(item), 'https://www.tiktok.com/@scout2015/video/6718335390845095173', () => { throw Error('unexpected fetch'); });
  app.click(app.document.querySelector('.mendosave-tiktok-btn'));
  await app.settle();
  assert.match(app.document.querySelector('.mendosave-tiktok-menu').textContent, /576p/);
  assert.match(app.document.querySelector('.mendosave-tiktok-menu').textContent, /576×1024/);
});

test('TikTok rejects metadata for a different video after SPA navigation', async () => {
  const stale = { id: '9999999999999999999', video: { playAddr: 'https://media.invalid/stale.mp4', width: 720, height: 1280 } };
  const app = adapter('tiktok.js', page(stale), 'https://www.tiktok.com/@scout2015/video/6718335390845095173', async () => ({ ok: true, text: async () => page(stale) }));
  app.click(app.document.querySelector('.mendosave-tiktok-btn'));
  await app.settle();
  assert.match(app.document.querySelector('.mendosave-tiktok-menu').textContent, /данные другого видео/);
  assert.doesNotMatch(app.document.querySelector('.mendosave-tiktok-menu').textContent, /Видео ·/);
});

test('TikTok MP3 aborts when the server returns more bytes than the requested range', async () => {
  const item = { id: '6718335390845095173', music: { playUrl: 'https://media.invalid/sound.m4a' }, video: {} };
  const app = adapter('tiktok.js', page(item), 'https://www.tiktok.com/@scout2015/video/6718335390845095173', async (_url, options) => options.headers?.Range
    ? { status: 206, arrayBuffer: async () => new Uint8Array(6).buffer }
    : { ok: true, headers: { get: () => '5' }, body: { cancel: async () => {} } });
  app.click(app.document.querySelector('.mendosave-tiktok-btn'));
  await app.settle();
  app.click([...app.document.querySelectorAll('.mendosave-tiktok-item')].find((x) => x.textContent.includes('MP3')));
  await app.settle();
  assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), false);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-abort'), true);
  assert.match(app.document.querySelector('.mendosave-tiktok-toast').textContent, /размер диапазона/);
});

test('TikTok original sound keeps the MP3 container instead of naming its bytes M4A', async () => {
  const item = { id: '6718335390845095173', music: { playUrl: 'https://media.invalid/sound.mp3' }, video: {} };
  let sent = false;
  const app = adapter('tiktok.js', page(item), 'https://www.tiktok.com/@scout2015/video/6718335390845095173', async () => ({
    ok: true, headers: { get: (name) => name === 'content-length' ? '3' : 'audio/mpeg' },
    body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array([73, 68, 51]) }) }) },
  }));
  app.click(app.document.querySelector('.mendosave-tiktok-btn'));
  await app.settle();
  app.click([...app.document.querySelectorAll('.mendosave-tiktok-item')].find((x) => x.textContent.includes('без перекодирования')));
  await app.settle();
  assert.equal(app.downloads.length, 1);
  assert.match(app.downloads[0], /\.mp3$/);
  assert.doesNotMatch(app.document.querySelector('.mendosave-tiktok-menu')?.textContent || '', /M4A/);
});

test('TikTok MP3 job uses the music duration and MIME rather than the video duration', async () => {
  const item = { id: '6718335390845095173', music: { playUrl: 'https://media.invalid/sound.mp3', duration: 30 }, video: { duration: 10 } };
  const app = adapter('tiktok.js', page(item), 'https://www.tiktok.com/@scout2015/video/6718335390845095173', async (_url, options) => options.headers?.Range
    ? { status: 206, arrayBuffer: async () => new Uint8Array(5).buffer }
    : { ok: true, headers: { get: (name) => name === 'content-length' ? '5' : 'audio/mpeg' }, body: { cancel: async () => {} } });
  app.click(app.document.querySelector('.mendosave-tiktok-btn'));
  await app.settle();
  app.click([...app.document.querySelectorAll('.mendosave-tiktok-item')].find((x) => x.textContent.includes('MP3')));
  await app.settle();
  const job = app.messages.find((x) => x.t === 'mendosave-begin');
  assert.equal(job.duration, 30);
  assert.equal(job.audioMime, 'audio/mpeg');
});

async function mp3Range({ status = 206, contentRange = null, total = 5, returnedBytes = 5, responseForRange, foreignViews = false, activate } = {}) {
  const item = { id: '6718335390845095173', music: { playUrl: 'https://media.invalid/sound.mp3' }, video: {} };
  const app = adapter('tiktok.js', page(item), 'https://www.tiktok.com/@scout2015/video/6718335390845095173', async (_url, options) => options.headers?.Range
    ? (responseForRange ? responseForRange(options.headers.Range) : { status, headers: { get: (name) => name === 'content-range' ? contentRange : null }, arrayBuffer: async () => new Uint8Array(returnedBytes).buffer })
    : { ok: true, headers: { get: (name) => name === 'content-length' ? String(total) : 'audio/mpeg' }, body: { cancel: async () => {} } });
  if (foreignViews) restrictNetworkViews(app);
  app.click(app.document.querySelector('.mendosave-tiktok-btn'));
  await app.settle();
  const itemControl = [...app.document.querySelectorAll('.mendosave-tiktok-item')].find((x) => x.textContent.includes('MP3'));
  if (activate) activate(app, itemControl);
  else app.click(itemControl);
  await app.settle();
  return app;
}

test('TikTok rejects a same-sized range from the wrong file offset before sending its bytes', async () => {
  const app = await mp3Range({ contentRange: 'bytes 10-14/15' });
  assert.equal(app.messages.some((x) => x.t === 'mendosave-chunk'), false);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), false);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-abort'), true);
});

test('TikTok rejects inconsistent or malformed accessible Content-Range headers', async (t) => {
  for (const contentRange of ['bytes 0-3/5', 'bytes 0-4/6', 'bytes 0-4/*', 'bytes 0-4/9007199254740993', 'not-a-range', '']) {
    await t.test(contentRange || 'empty header', async () => {
      const app = await mp3Range({ contentRange });
      assert.equal(app.messages.some((x) => x.t === 'mendosave-chunk'), false);
      assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), false);
      assert.equal(app.messages.some((x) => x.t === 'mendosave-abort'), true);
    });
  }
});

test('TikTok accepts the exact requested range with matching known file size', async () => {
  const app = await mp3Range({ contentRange: 'bytes 0-4/5' });
  assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), true);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-abort'), false);
});

test('TikTok accepts an inaccessible CORS Content-Range only with the exact actual byte count', async (t) => {
  await t.test('correct actual size', async () => {
    const app = await mp3Range();
    assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), true);
  });
  await t.test('short actual size', async () => {
    const app = await mp3Range({ returnedBytes: 4 });
    assert.equal(app.messages.some((x) => x.t === 'mendosave-chunk'), false);
    assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), false);
    assert.equal(app.messages.some((x) => x.t === 'mendosave-abort'), true);
  });
});

test('TikTok accepts HTTP 200 only when the requested range covers the entire known file', async (t) => {
  await t.test('complete file in one range', async () => {
    const app = await mp3Range({ status: 200 });
    assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), true);
  });
  await t.test('partial file presented as HTTP 200', async () => {
    const app = await mp3Range({ status: 200, total: 4 * 1024 * 1024 + 5, returnedBytes: 4 * 1024 * 1024 });
    assert.equal(app.messages.some((x) => x.t === 'mendosave-chunk'), false);
    assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), false);
    assert.equal(app.messages.some((x) => x.t === 'mendosave-abort'), true);
  });
});

test('TikTok validates the second range offset and total before sending or finalizing that range', async () => {
  const total = 4 * 1024 * 1024 + 5;
  const app = await mp3Range({ total, responseForRange: (requested) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(requested);
    const start = Number(match[1]), end = Number(match[2]);
    return { status: 206, headers: { get: () => start ? `bytes 0-4/${total}` : `bytes ${start}-${end}/${total}` },
      arrayBuffer: async () => new Uint8Array(end - start + 1).buffer };
  } });
  assert.equal(app.requests.filter((x) => x.options.headers?.Range).length, 2);
  assert.equal(app.messages.filter((x) => x.t === 'mendosave-chunk').length, 1);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), false);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-abort'), true);
});

test('TikTok accepts consecutive exposed ranges only when each offset and total matches', async () => {
  const total = 4 * 1024 * 1024 + 5;
  const app = await mp3Range({ total, responseForRange: (requested) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(requested);
    const start = Number(match[1]), end = Number(match[2]);
    return { status: 206, headers: { get: () => `bytes ${start}-${end}/${total}` },
      arrayBuffer: async () => new Uint8Array(end - start + 1).buffer };
  } });
  assert.deepEqual(app.requests.filter((x) => x.options.headers?.Range).map((x) => x.options.headers.Range), ['bytes=0-4194303', 'bytes=4194304-4194308']);
  assert.equal(app.messages.filter((x) => x.t === 'mendosave-chunk').length, 2);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), true);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-abort'), false);
});

test('TikTok copies network-backed range bytes into its own realm before chunking', async () => {
  const app = await mp3Range({ foreignViews: true, responseForRange: () => ({ status: 206,
    headers: { get: () => 'bytes 0-4/5' }, arrayBuffer: async () => Uint8Array.of(1, 2, 3, 4, 5).buffer }) });
  assert.equal(app.messages.find((x) => x.t === 'mendosave-chunk')?.b64, 'AQIDBAU=', app.document.querySelector('.mendosave-tiktok-toast').textContent);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), true);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-abort'), false);
});

test('TikTok menu activates the selected MP3 action once with Enter or Space', async (t) => {
  for (const key of ['Enter', ' ']) await t.test(key === ' ' ? 'Space' : key, async () => {
    let event;
    const app = await mp3Range({ activate: (view, item) => {
      assert.equal(view.press(item, key, true).defaultPrevented, true);
      assert.equal(view.press(item, 'a').defaultPrevented, false);
      assert.equal(view.messages.some((x) => x.t === 'mendosave-begin'), false);
      event = view.press(item, key);
    } });
    assert.equal(app.messages.filter((x) => x.t === 'mendosave-begin').length, 1);
    assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(Boolean(app.document.querySelector('.mendosave-tiktok-menu')), false);
  });
});

test('TikTok Escape closes the menu without starting a job and releases its key listener', async () => {
  const app = await mp3Range({ activate: () => {} });
  const event = app.press(app.document.body, 'Escape');
  assert.equal(Boolean(app.document.querySelector('.mendosave-tiktok-menu')), false);
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-begin'), false);
  assert.equal(app.press(app.document.body, 'Escape').defaultPrevented, false);
});

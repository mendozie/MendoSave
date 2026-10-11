const assert = require('node:assert/strict');
const { test } = require('node:test');
const { adapter } = require('./tiktok-adapter-harness.cjs');

function coub(send) {
  const payload = require('./fixtures/coub-item.json').payload;
  const app = adapter('coub.js', '<div data-permalink="or1i6abuay"><div class="viewer"></div></div>',
    'https://coub.com/view/or1i6abuay', async () => ({ ok: true, json: async () => payload }), send);
  app.context.MendoPackageUI.add = (_menu, picker) => { app.picker = picker; };
  return app;
}

test('Coub processor workflow waits for producer ACK and retains it during native finalization', async () => {
  const { producerPorts } = require('./producer-port-harness.cjs');
  const transport = producerPorts({ autoAck: false });
  let finalized;
  const pending = new Promise(resolve => { finalized = resolve; });
  const audio = new Uint8Array(834);
  for (const at of [0, 417]) audio.set([0xff, 0xfb, 0x90, 0], at);
  const app = adapter('coub.js', '<div data-permalink="or1i6abuay"><div class="viewer"></div></div>',
    'https://coub.com/view/or1i6abuay', async url => {
      if (url.includes('/api/')) return { ok: true, json: async () => ({ permalink: 'or1i6abuay',
        title: 'Fixture', has_sound: true, duration: 0.01, file_versions: { html5: {
          video: { high: { url: 'https://media.invalid/video.mp4', size: 8 } },
          audio: { high: { url: 'https://media.invalid/audio.mp3', size: audio.length } },
        } } }) };
      const bytes = url.endsWith('video.mp4') ? new Uint8Array(8) : audio;
      return { ok: true, status: 200, headers: { get: () => String(bytes.length) },
        arrayBuffer: async () => bytes.buffer };
    }, message => message.t === 'mendosave-finalize' ? pending : { ok: true, tabId: 7 });
  app.context.MendoPackageUI.add = (_menu, picker) => { app.picker = picker; };
  app.context.chrome.runtime.connect = transport.connect;
  app.click(app.document.querySelector('.mendosave-coub-btn')); await app.settle();
  const choice = app.picker.options.find(entry => entry.label.includes('Со звуком'));
  assert.ok(choice);
  app.context.MendoPackageUI.running = true;
  const running = choice.run();
  await app.settle();
  assert.equal(app.messages.some(message => message.t === 'mendosave-ensure'), false);
  const producer = transport.ports.find(port => port.name === 'mendosave-producer');
  assert.ok(producer);
  producer.receive({ ok: true, instanceId: 'processor-fixture' });
  await app.settle();
  assert.equal(app.messages.some(message => message.t === 'mendosave-finalize'), true);
  assert.equal(app.messages.find(message => message.t === 'mendosave-finalize').instanceId, 'processor-fixture');
  assert.equal(producer.disconnected, false);
  finalized({ ok: true, filename: 'clip.mp4' });
  assert.equal(await running, 'clip.mp4');
  assert.equal(producer.disconnected, true);
});

test('Coub package direct item resolves after archive collection without polling a nonexistent download', async () => {
  const app = coub(() => ({ ok: true, collected: true, filename: 'stored.mp4' }));
  app.click(app.document.querySelector('.mendosave-coub-btn'));
  await app.settle();
  assert.ok(app.picker, 'available formats expose package picker');
  app.context.MendoPackageUI.running = true;
  const item = app.picker.options.find((entry) => entry.label.includes('Видео без звука'));
  assert.equal(await item.run(), 'stored.mp4');
  assert.equal(app.messages.some((message) => message.t === 'mendosave-download-state'), false);
});

test('Coub package item rejects a failed browser save rather than claiming queue success', async () => {
  const app = coub((message) => message.t === 'mendosave-save'
    ? { ok: false, error: 'disk unavailable' } : { ok: true });
  app.click(app.document.querySelector('.mendosave-coub-btn'));
  await app.settle();
  assert.ok(app.picker);
  app.context.MendoPackageUI.running = true;
  await assert.rejects(app.picker.options.find((entry) => entry.label.includes('Видео без звука')).run(), /disk unavailable/);
});

test('Coub rejects a second package item while the first save is still pending', async () => {
  let finish;
  const app = coub((message) => message.t === 'mendosave-save'
    ? new Promise((resolve) => { finish = resolve; }) : { ok: true, state: 'complete' });
  app.click(app.document.querySelector('.mendosave-coub-btn'));
  await app.settle();
  app.context.MendoPackageUI.running = true;
  const item = app.picker.options.find((entry) => entry.label.includes('Видео без звука'));
  const first = item.run();
  await assert.rejects(item.run(), /Другая загрузка/);
  finish({ ok: true, collected: true, filename: 'stored.mp4' });
  assert.equal(await first, 'stored.mp4');
});

test('Coub treats cancellation in the browser dialog as terminal user cancellation', async () => {
  const app = coub((message) => message.t === 'mendosave-download-state'
    ? { ok: true, state: 'interrupted', error: 'USER_CANCELED' } : { ok: true, id: 4 });
  app.click(app.document.querySelector('.mendosave-coub-btn'));
  await app.settle();
  app.context.MendoPackageUI.running = true;
  await assert.rejects(app.picker.options.find((entry) => entry.label.includes('Видео без звука')).run(),
    (error) => error.name === 'AbortError');
  assert.equal(app.messages.filter((message) => message.t === 'mendosave-save').length, 1);
});

test('Twitch clip package resolves a collected file without querying a download ID', async () => {
  const app = adapter('twitch_ui.js', '<video></video><div class="player-controls__right-control-group"></div>',
    'https://clips.twitch.tv/CloudySarcasticSashimiTwitchRPG', async () => ({ ok: true,
      json: async () => ({ data: { clip: { title: 'Test clip', videoQualities: [
        { quality: '360', sourceURL: 'https://media.invalid/clip-360.mp4' },
        { quality: '720', sourceURL: 'https://media.invalid/clip-720.mp4' },
      ] } } }),
    }), () => ({ ok: true, collected: true, filename: 'clip.mp4' }));
  app.context.MendoPackageUI.add = (_menu, picker) => { app.picker = picker; };
  app.click(app.document.querySelector('#mendosave-twitch-record'));
  await app.settle();
  assert.equal(app.picker.options.length, 2);
  app.context.MendoPackageUI.running = true;
  assert.equal(await app.picker.options[0].run(), 'clip.mp4');
  assert.equal(app.messages.some((message) => message.t === 'mendosave-download-state'), false);
});

test('VK format package includes video and audio and does not poll archive-collected video', async () => {
  const payload = require('node:fs').readFileSync('tests/fixtures/vk-player.html', 'utf8');
  const app = adapter('vk.js', '<div class="VideoPlayer__player"><video></video></div>',
    'https://vkvideo.ru/video-1_2', async () => ({ ok: true,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      arrayBuffer: async () => new TextEncoder().encode(payload).buffer,
    }), () => ({ ok: true, collected: true, filename: 'vk-collected.mp4' }));
  app.context.MendoPackageUI.add = (_menu, picker) => { app.picker = picker; };
  app.click(app.document.querySelector('.mendosave-vk-btn'));
  await app.settle();
  assert.ok(app.picker.options.some((entry) => entry.label.includes('M4A')));
  assert.ok(app.picker.options.some((entry) => entry.label.includes('MP3')));
  app.context.MendoPackageUI.running = true;
  assert.equal(await app.picker.options.find((entry) => entry.label.includes('Видео')).run(), 'vk-collected.mp4');
  assert.equal(app.messages.some((message) => message.t === 'mendosave-download-state'), false);
});

test('Rutube cancellation does not retry a segment or finalize a partial file', async () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=293000,RESOLUTION=256x144\nhttps://media.invalid/144.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=450000,RESOLUTION=640x360\nhttps://media.invalid/360.m3u8\n';
  const app = adapter('rutube.js', '<div class="player"><video></video></div>',
    'https://rutube.ru/video/5295f2a858cdace0855c40f8a48f4676/', async (url) => {
      if (url.includes('/api/play/options/')) return { ok: true, json: async () => ({ title: 'Fixture',
        duration: 54312, video_balancer: { m3u8: 'https://media.invalid/master.m3u8' } }) };
      if (url.endsWith('master.m3u8')) return { ok: true, text: async () => master };
      if (url.endsWith('.m3u8')) return { ok: true, text: async () => '#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n' };
      const error = new Error('canceled');
      error.name = 'AbortError';
      throw error;
    });
  app.context.MendoPackageUI.add = (_menu, picker) => { app.picker = picker; };
  app.click(app.document.querySelector('#mendosave-rutube-btn'));
  await app.settle();
  assert.equal(app.picker.options.length, 2);
  app.context.MendoPackageUI.running = true;
  await assert.rejects(app.picker.options[0].run(), (error) => error.name === 'AbortError');
  assert.equal(app.requests.filter((entry) => entry.url.endsWith('segment.ts')).length, 1);
  assert.equal(app.messages.some((message) => message.t === 'mendosave-finalize'), false);
  assert.equal(app.messages.some((message) => message.t === 'mendosave-abort'), true);
});

test('Rutube drains outstanding lookahead reads before abort cleanup releases the producer', async () => {
  let completeRead;
  const slowRead = new Promise(resolve => { completeRead = resolve; });
  let slowSignal;
  const app = adapter('rutube.js', '<div class="player"><video></video></div>',
    'https://rutube.ru/video/5295f2a858cdace0855c40f8a48f4676/', async (url, options) => {
      if (url.includes('/api/play/options/')) return { ok: true, json: async () => ({ title: 'Fixture', duration: 2000,
        video_balancer: { m3u8: 'https://media.invalid/master.m3u8' } }) };
      if (url.endsWith('master.m3u8')) return { ok: true, text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10000,RESOLUTION=256x144\n144.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=20000,RESOLUTION=640x360\n360.m3u8\n' };
      if (url.endsWith('.m3u8')) return { ok: true, text: async () => '#EXTM3U\n#EXTINF:1,\nfirst.ts\n#EXTINF:1,\nsecond.ts\n#EXT-X-ENDLIST\n' };
      if (url.endsWith('second.ts')) { slowSignal = options.signal; return { ok: true, arrayBuffer: () => slowRead }; }
      return { ok: true, arrayBuffer: async () => Uint8Array.of(0x47, 1, 2).buffer };
    }, message => {
      if (message.t === 'mendosave-chunk') throw new Error('processor write failed');
      return { ok: true, tabId: 7 };
    });
  app.context.MendoPackageUI.add = (_menu, picker) => { app.picker = picker; };
  app.click(app.document.querySelector('#mendosave-rutube-btn')); await app.settle();
  app.context.MendoPackageUI.running = true;
  const running = app.picker.options[0].run();
  const rejected = assert.rejects(running, /processor write failed/);
  await app.settle();
  const producer = app.producers.ports[0];
  assert.equal(producer.disconnected, false, 'outstanding native read still belongs to this workflow');
  assert.equal(slowSignal.aborted, true, 'failure cancels pending lookahead requests');
  assert.equal(app.messages.some(message => message.t === 'mendosave-abort'), false, 'read cleanup precedes job abort');
  completeRead(Uint8Array.of(0x47, 3, 4).buffer); await rejected;
  assert.equal(producer.disconnected, true);
  assert.equal(app.messages.some(message => message.t === 'mendosave-finalize'), false);
});

test('TikTok waits for privileged Blob save and preserves cookie-fetched original bytes', async () => {
  const item = { id: '6718335390845095173', music: { playUrl: 'https://media.invalid/sound.mp3' }, video: {} };
  const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({ __DEFAULT_SCOPE__: {
    'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: item } },
  } })}</script><article><div id="xgwrapper-0-6718335390845095173"></div><div class="SectionActionBarContainer"><a data-e2e="video-author-avatar" href="/@scout2015"></a></div></article>`;
  let sent = false;
  const app = adapter('tiktok.js', html, 'https://www.tiktok.com/@scout2015/video/6718335390845095173', async () => ({
    ok: true, headers: { get: (name) => name === 'content-length' ? '3' : 'audio/mpeg' },
    body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true,
      { done: false, value: Uint8Array.of(73, 68, 51) }) }) },
  }));
  let finish;
  app.context.MendoPackageUI.saveBlob = async (blob) => {
    app.blobs.push(blob);
    await new Promise((resolve) => { finish = resolve; });
  };
  app.click(app.document.querySelector('.mendosave-tiktok-btn'));
  await app.settle();
  app.click([...app.document.querySelectorAll('.mendosave-tiktok-item')].find((entry) => entry.textContent.includes('без перекодирования')));
  await app.settle();
  assert.equal(app.blobs.length, 1, 'original bytes transferred to privileged save');
  assert.deepEqual([...new Uint8Array(await app.blobs[0].arrayBuffer())], [73, 68, 51]);
  assert.equal(app.requests[0].options.credentials, 'include');
  assert.doesNotMatch(app.document.querySelector('.mendosave-tiktok-toast').textContent, /Готово:/);
  assert.equal(app.downloads.length, 0, 'no page anchor bypass');
  finish();
  await app.settle();
  assert.match(app.document.querySelector('.mendosave-tiktok-toast').textContent, /Готово:/);
});

test('TikTok package cancellation is terminal before trying another CDN mirror', async () => {
  const item = structuredClone(require('./fixtures/tiktok-item.json').item);
  item.video.bitrateInfo[0].PlayAddr.UrlList = ['https://media.invalid/first.mp4', 'https://media.invalid/second.mp4'];
  const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({ __DEFAULT_SCOPE__: {
    'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: item } },
  } })}</script><article><div id="xgwrapper-0-6718335390845095173"></div><div class="SectionActionBarContainer"><a data-e2e="video-author-avatar" href="/@scout2015"></a></div></article>`;
  const app = adapter('tiktok.js', html, 'https://www.tiktok.com/@scout2015/video/6718335390845095173', async () => {
    const error = new Error('canceled');
    error.name = 'AbortError';
    throw error;
  });
  app.context.MendoPackageUI.add = (_menu, picker) => { app.picker = picker; };
  app.click(app.document.querySelector('.mendosave-tiktok-btn'));
  await app.settle();
  app.context.MendoPackageUI.running = true;
  await assert.rejects(app.picker.options.find((entry) => entry.label.includes('576p')).run(),
    (error) => error.name === 'AbortError');
  assert.equal(app.requests.length, 1);
  assert.equal(app.blobs.length, 0);
});

test('TikTok host save failure does not redownload successful media from another mirror', async () => {
  const item = structuredClone(require('./fixtures/tiktok-item.json').item);
  item.video.bitrateInfo[0].PlayAddr.UrlList = ['https://media.invalid/first.mp4', 'https://media.invalid/second.mp4'];
  const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({ __DEFAULT_SCOPE__: {
    'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: item } },
  } })}</script><article><div id="xgwrapper-0-6718335390845095173"></div><div class="SectionActionBarContainer"><a data-e2e="video-author-avatar" href="/@scout2015"></a></div></article>`;
  const app = adapter('tiktok.js', html, 'https://www.tiktok.com/@scout2015/video/6718335390845095173', async () => {
    let sent = false;
    return { ok: true, headers: { get: (name) => name === 'content-length' ? '3' : 'video/mp4' },
      body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true,
        { done: false, value: Uint8Array.of(1, 2, 3) }) }) },
    };
  });
  app.context.MendoPackageUI.add = (_menu, picker) => { app.picker = picker; };
  app.context.MendoPackageUI.saveBlob = async () => { throw new Error('disk full'); };
  app.click(app.document.querySelector('.mendosave-tiktok-btn'));
  await app.settle();
  app.context.MendoPackageUI.running = true;
  await assert.rejects(app.picker.options.find((entry) => entry.label.includes('576p')).run(), /disk full/);
  assert.equal(app.requests.length, 1);
});

test('Zvuk browser dialog cancellation stops its separate multi-track queue', async () => {
  const app = adapter('zvuk.js', '<div class="ContentItem_wrapper"><a href="/track/123">First</a><div class="Controls_controls"><span>3:00</span></div></div>'
    + '<div class="ContentItem_wrapper"><a href="/track/124">Second</a><div class="Controls_controls"><span>3:00</span></div></div>',
  'https://zvuk.com/track/123', async (_url, options) => {
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ data: body.operationName === 'nvsTracks'
      ? { getTracks: [{ id: '123', title: 'First', duration: 180 }, { id: '124', title: 'Second', duration: 180 }] }
      : { mediaContents: [{ stream: { high: 'https://media.invalid/full.mp3' } }] } }) };
  }, (message) => message.t === 'mendosave-download-state'
    ? { ok: true, state: 'interrupted', error: 'USER_CANCELED' } : { ok: true, id: 4 });
  let pickers = 0;
  app.context.MendoPackageUI.add = () => { pickers++; };
  app.click(app.document.querySelector('.mendosave-zvuk-btn'));
  await app.settle();
  app.click([...app.document.querySelectorAll('.mendosave-zvuk-item')].find((entry) => entry.textContent.includes('Скачать все')));
  await app.settle();
  assert.equal(pickers, 0, 'different tracks are not a same-source format bundle');
  assert.equal(app.messages.filter((message) => message.t === 'mendosave-save').length, 1);
  assert.match(app.document.querySelector('.mendosave-zvuk-toast').textContent, /отменена/);
});

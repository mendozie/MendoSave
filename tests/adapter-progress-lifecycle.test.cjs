const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { adapter } = require('./tiktok-adapter-harness.cjs');

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function controlledTimers(app) {
  const timers = [];
  app.context.setTimeout = (callback, delay) => {
    if (delay <= 1500) { queueMicrotask(callback); return null; }
    const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer;
  };
  app.context.clearTimeout = (timer) => { if (timer) timer.cancelled = true; };
  return timers;
}

async function fixture(site, save, mode = 'video') {
  let app, button, toast, select;
  const send = (message) => message.t === 'mendosave-save' || message.t === 'mendosave-finalize'
    ? save(message) : { ok: true, id: 1, tabId: 7, state: 'complete' };
  if (site === 'coub') {
    const payload = require('./fixtures/coub-item.json').payload;
    app = adapter('coub.js', '<div data-permalink="or1i6abuay"><div class="viewer"></div></div>',
      'https://coub.com/view/or1i6abuay', async () => ({ ok: true, json: async () => payload }), send);
    button = '.mendosave-coub-btn'; toast = '.mendosave-coub-toast'; select = (item) => item.label.includes('Видео без звука');
  } else if (site === 'twitch') {
    app = adapter('twitch_ui.js', '<video></video><div class="player-controls__right-control-group"></div>',
      'https://clips.twitch.tv/CloudySarcasticSashimiTwitchRPG', async () => ({ ok: true,
        json: async () => ({ data: { clip: { title: 'Fixture', videoQualities: [
          { quality: '360', sourceURL: 'https://media.invalid/360.mp4' },
          { quality: '720', sourceURL: 'https://media.invalid/720.mp4' },
        ] } } }),
      }), send);
    button = '#mendosave-twitch-record'; toast = '#mendosave-twitch-toast'; select = () => true;
  } else if (site === 'vk') {
    const payload = fs.readFileSync('tests/fixtures/vk-player.html', 'utf8');
    app = adapter('vk.js', '<div class="VideoPlayer__player"><video></video></div>',
      'https://vkvideo.ru/video-1_2', async (url, options) => {
        if (url.includes('video_ext.php')) return { ok: true,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          arrayBuffer: async () => new TextEncoder().encode(payload).buffer };
        if (url.endsWith('.mpd')) return { ok: true, text: async () => fs.readFileSync('tests/fixtures/vk-audio.mpd', 'utf8') };
        if (options.method === 'HEAD') return new Response(null, { headers: { 'content-length': '4' } });
        return new Response(Uint8Array.of(1, 2, 3, 4), {
          status: 206, headers: { 'content-range': 'bytes 0-3/4', 'content-length': '4' },
        });
      }, message => mode === 'video' && message.t === 'mendosave-blob-finish' ? save(message) : send(message));
    button = '.mendosave-vk-btn'; toast = '.mendosave-vk-toast'; select = (item) => item.label.includes(mode === 'audio' ? 'MP3' : 'Видео');
  } else if (site === 'rutube') {
    app = adapter('rutube.js', '<div class="player"><video></video></div>',
      'https://rutube.ru/video/5295f2a858cdace0855c40f8a48f4676/', async (url) => {
        if (url.includes('/api/play/options/')) return { ok: true, json: async () => ({ title: 'Fixture',
          duration: 1000, video_balancer: { m3u8: 'https://media.invalid/master.m3u8' } }) };
        if (url.endsWith('master.m3u8')) return { ok: true, text: async () => '#EXTM3U\n'
          + '#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=256x144\n144.m3u8\n'
          + '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=640x360\n360.m3u8\n' };
        if (url.endsWith('.m3u8')) return { ok: true, text: async () => '#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n' };
        return { ok: true, arrayBuffer: async () => Uint8Array.of(0x47, 1).buffer };
      }, send);
    button = '#mendosave-rutube-btn'; toast = '.mendosave-rt-toast'; select = () => true;
  } else if (site === 'tiktok') {
    const item = structuredClone(require('./fixtures/tiktok-item.json').item);
    if (mode === 'audio') item.music = { playUrl: 'https://media.invalid/sound.m4a', duration: 1 };
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({ __DEFAULT_SCOPE__: {
      'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: item } },
    } })}</script><article><div id="xgwrapper-0-6718335390845095173"></div><div class="SectionActionBarContainer"><a data-e2e="video-author-avatar" href="/@scout2015"></a></div></article>`;
    app = adapter('tiktok.js', html, 'https://www.tiktok.com/@scout2015/video/6718335390845095173', async (_url, options) => {
      if (mode === 'audio') return options.headers?.Range
        ? { ok: true, status: 206, headers: new Headers({ 'content-range': 'bytes 0-2/3' }), arrayBuffer: async () => Uint8Array.of(1, 2, 3).buffer }
        : { ok: true, headers: new Headers({ 'content-length': '3', 'content-type': 'audio/mp4' }), body: { async cancel() {} } };
      let sent = false;
      return { ok: true, headers: { get: (name) => name === 'content-length' ? '3' : 'video/mp4' },
        body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true,
          { done: false, value: Uint8Array.of(1, 2, 3) }) }) },
      };
    }, send);
    app.context.MendoPackageUI.saveBlob = async () => {
      const result = await save({ t: 'mendosave-save' });
      if (!result.ok) { const error = new Error(result.error); if (result.cancelled) error.name = 'AbortError'; throw error; }
      return result.filename;
    };
    button = '.mendosave-tiktok-btn'; toast = '.mendosave-tiktok-toast'; select = (item) => item.label.includes(mode === 'audio' ? 'MP3' : '576p');
  } else throw new Error(`Unknown fixture ${site}`);
  const timers = controlledTimers(app);
  app.context.MendoPackageUI.add = (_menu, picker) => { app.picker = picker; };
  app.click(app.document.querySelector(button)); await app.settle();
  assert.ok(app.picker, `${site} exposes its existing package formats`);
  const options = typeof app.picker.options === 'function' ? app.picker.options() : app.picker.options;
  app.context.MendoPackageUI.running = true;
  return { app, item: options.find(select), box: () => app.document.querySelector(toast), timers };
}

test('Coub package cancellation sets terminal progress and schedules its dismissal before rethrow', async () => {
  const { item, box, timers } = await fixture('coub', () => { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; });
  await assert.rejects(item.run(), (error) => error.name === 'AbortError');
  assert.match(box().textContent, /отменена/);
  assert.ok(timers.some((timer) => timer.delay === 5000), 'terminal cancellation must dismiss its floating progress');
});

test('Coub package save failure replaces floating progress with its error before rethrow', async () => {
  const { item, box, timers } = await fixture('coub', () => { throw new Error('disk unavailable'); });
  await assert.rejects(item.run(), /disk unavailable/);
  assert.match(box().textContent, /Ошибка: disk unavailable/);
  const dismissal = timers.findLast((timer) => timer.delay === 11000);
  assert.ok(dismissal); dismissal.callback(); assert.equal(box().hidden, true);
});

for (const site of ['rutube', 'vk', 'tiktok', 'twitch']) {
  test(`${site} package cancellation and failure finalize floating progress before rethrow`, async (t) => {
    for (const cancelled of [true, false]) await t.test(cancelled ? 'cancelled' : 'failed', async () => {
      const { item, box, timers } = await fixture(site, () => {
        const error = new Error(cancelled ? 'cancelled' : 'disk unavailable');
        if (cancelled) error.name = 'AbortError';
        throw error;
      });
      await assert.rejects(item.run(), cancelled ? (error) => error.name === 'AbortError' : /disk unavailable/);
      assert.match(box().textContent, cancelled ? /отменена/ : /disk unavailable/);
      const dismissal = timers.findLast((timer) => timer.delay >= 4000);
      assert.ok(dismissal, 'terminal progress must schedule dismissal');
      dismissal.callback();
      assert.ok(box().hidden || !box().classList.contains('show'));
    });
  });
}

for (const site of ['coub', 'rutube', 'vk', 'tiktok', 'twitch']) {
  test(`${site} restart ignores an already queued previous dismissal`, async () => {
    let finish;
    let saves = 0;
    const { app, item, box, timers } = await fixture(site, () => {
      if (++saves === 1) { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; }
      finish = deferred(); return finish.promise;
    });
    await assert.rejects(item.run(), (error) => error.name === 'AbortError');
    const oldDismissal = timers.findLast((timer) => timer.delay >= 4000);
    assert.ok(oldDismissal);
    const next = item.run(); await app.settle();
    const text = box().textContent;
    assert.equal(oldDismissal.cancelled, true, 'a new run clears the old pending dismissal');
    oldDismissal.callback(); // Already queued callbacks may race with clearTimeout.
    assert.equal(box().textContent, text);
    assert.equal(box().hidden, false);
    if (site !== 'coub' && site !== 'rutube') assert.ok(box().classList.contains('show'));
    finish.resolve({ ok: true, collected: true, filename: 'new.mp4' });
    await next;
    assert.match(box().textContent, /[Гг]отово/);
  });
}

test('Coub removes progress listeners at termination and ignores a queued old job update', async () => {
  const secondSave = deferred();
  let saves = 0;
  const { app, item, box } = await fixture('coub', () => {
    if (++saves === 1) { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; }
    return secondSave.promise;
  });
  let job = 0;
  app.context.crypto = { randomUUID: () => `job-${++job}` };
  const active = new Set(), registered = [];
  app.context.chrome.runtime.onMessage.addListener = (callback) => { active.add(callback); registered.push(callback); };
  app.context.chrome.runtime.onMessage.removeListener = (callback) => active.delete(callback);
  await assert.rejects(item.run(), (error) => error.name === 'AbortError');
  assert.equal(active.size, 0);
  registered[0]({ t: 'mendosave-progress', jobId: 'job-1', value: 0.2, status: 'Old job progress' });
  assert.match(box().textContent, /отменена/, 'a finished job cannot overwrite its terminal state');
  const next = item.run(); await app.settle();
  const text = box().textContent;
  registered[0]({ t: 'mendosave-progress', jobId: 'job-1', value: 0.8, status: 'Old job progress' });
  assert.equal(box().textContent, text);
  secondSave.resolve({ ok: true, collected: true, filename: 'new.mp4' }); await next;
  assert.equal(active.size, 0);
});

test('Zvuk single-track cancellation remains terminal and old dismissal cannot hide a restarted track', async () => {
  let saves = 0;
  const nextSave = deferred();
  const app = adapter('zvuk.js', '<div class="ContentItem_wrapper"><a href="/track/123">Track</a><div class="Controls_controls"><span>3:00</span></div></div>',
    'https://zvuk.com/track/123', async (_url, options) => {
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ data: body.operationName === 'nvsTracks'
        ? { getTracks: [{ id: '123', title: 'Fixture', duration: 180 }] }
        : { mediaContents: [{ stream: { high: 'https://media.invalid/full.mp3' } }] } }) };
    }, (message) => {
      if (message.t !== 'mendosave-save') return { ok: true, id: 1, state: 'complete' };
      if (++saves === 1) { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; }
      return nextSave.promise;
    });
  const timers = controlledTimers(app);
  async function choose() {
    app.click(app.document.querySelector('.mendosave-zvuk-btn')); await app.settle();
    app.click(app.document.querySelector('[role="menuitem"].mendosave-zvuk-item')); await app.settle();
  }
  await choose();
  const box = app.document.querySelector('.mendosave-zvuk-toast');
  assert.match(box.textContent, /отменена/);
  const oldDismissal = timers.findLast((timer) => timer.delay >= 4000);
  assert.ok(oldDismissal);
  await choose();
  assert.match(box.textContent, /Скачиваю/);
  oldDismissal.callback();
  assert.ok(box.classList.contains('show'));
  nextSave.resolve({ ok: true, collected: true, filename: 'new.mp3' }); await app.settle();
  assert.match(box.textContent, /Готово:/);
});

for (const site of ['vk', 'tiktok']) {
  test(`${site} audio removes its runtime listener and rejects queued progress from a finished job`, async () => {
    const secondSave = deferred();
    let saves = 0;
    const { app, item, box } = await fixture(site, () => {
      if (++saves === 1) { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; }
      return secondSave.promise;
    }, 'audio');
    let job = 0;
    app.context.crypto = { randomUUID: () => `job-${++job}` };
    const active = new Set(), registered = [];
    app.context.chrome.runtime.onMessage.addListener = (callback) => { active.add(callback); registered.push(callback); };
    app.context.chrome.runtime.onMessage.removeListener = (callback) => active.delete(callback);
    await assert.rejects(item.run(), (error) => error.name === 'AbortError');
    assert.equal(active.size, 0);
    assert.equal(registered.length, 1, 'the real audio processing route was exercised');
    const terminal = box().textContent;
    registered[0]({ t: 'mendosave-progress', jobId: 'job-1', value: 0.5, status: 'Old job progress' });
    assert.equal(box().textContent, terminal);
    const next = item.run(); await app.settle();
    assert.equal(active.size, 1);
    const current = box().textContent;
    registered[0]({ t: 'mendosave-progress', jobId: 'job-1', value: 0.8, status: 'Old job progress' });
    assert.equal(box().textContent, current);
    secondSave.resolve({ ok: true, collected: true, filename: 'new.mp3' }); await next;
    assert.equal(active.size, 0);
  });
}

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { adapter, restrictNetworkViews } = require('./tiktok-adapter-harness.cjs');

function recordingPort(app, reply = { ok: true }) {
  const messages = new Set(), disconnects = new Set();
  const port = {
    onMessage: { addListener: (fn) => messages.add(fn), removeListener: (fn) => messages.delete(fn) },
    onDisconnect: { addListener: (fn) => disconnects.add(fn), removeListener: (fn) => disconnects.delete(fn) },
    disconnectCalls: 0,
    disconnect() { this.disconnectCalls++; for (const fn of [...disconnects]) fn(); },
    acknowledge(value = { ok: true }) { for (const fn of [...messages]) fn(value); },
  };
  app.context.chrome.runtime.connect = ({ name }) => {
    port.name = name;
    if (reply) queueMicrotask(() => port.acknowledge(reply));
    return port;
  };
  return port;
}

function liveRecording(send, reply) {
  const app = adapter('twitch_ui.js', '<video></video><div class="player-controls__right-control-group"></div>',
    'https://www.twitch.tv/monstercat', async () => { throw new Error('live must not fetch a VOD'); }, send);
  const media = app.document.querySelector('video');
  Object.assign(media, { readyState: 2, paused: false, error: null, ended: false });
  media.captureStream = () => ({ getVideoTracks: () => [{}] });
  const port = recordingPort(app, reply);
  let active;
  app.context.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { active = this; this.mimeType = 'video/webm'; this.startCalls = 0; }
    start() { this.startCalls++; this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop()); }
  };
  return { app, port, get recorder() { return active; } };
}

test('Twitch chooses a remuxable WebM codec and refuses an H264-only recorder before starting a job', async (t) => {
  for (const vp8Supported of [true, false]) {
    await t.test(vp8Supported ? 'VP8 fallback' : 'H264 only', async () => {
      const app = adapter('twitch_ui.js', '<video></video><div class="player-controls__right-control-group"></div>',
        'https://www.twitch.tv/twitchdev', async () => { throw new Error('live must not fetch a VOD'); });
      const media = app.document.querySelector('video');
      Object.assign(media, { readyState: 2, paused: false, error: null, ended: false });
      media.captureStream = () => ({ getVideoTracks: () => [{}] });
      recordingPort(app);
      const constructed = [];
      let starts = 0;
      app.context.MediaRecorder = class {
        static isTypeSupported(type) {
          return type.includes('h264') || (vp8Supported && type === 'video/webm;codecs=vp8,opus');
        }
        constructor(_stream, options) { constructed.push(options.mimeType); this.mimeType = options.mimeType; }
        start() { starts++; this.state = 'recording'; }
      };
      app.click(app.document.querySelector('#mendosave-twitch-record')); await app.settle();
      if (vp8Supported) {
        assert.deepEqual(constructed, ['video/webm;codecs=vp8,opus']);
        assert.equal(starts, 1);
        assert.equal(app.messages.find((message) => message.t === 'mendosave-live-begin').mime, constructed[0]);
      } else {
        assert.deepEqual(constructed, []);
        assert.equal(starts, 0);
        assert.equal(app.messages.some((message) => message.t === 'mendosave-live-begin'), false);
        assert.equal(app.document.querySelector('#mendosave-twitch-record').classList.contains('recording'), false);
        assert.match(app.document.querySelector('#mendosave-twitch-toast').textContent, /совместимый формат WebM недоступен/);
      }
    });
  }
});

function vod(playlist, variant = 'https://media.invalid/vod/playlist.m3u8', segmentFetch, master) {
  return adapter('twitch_ui.js', '<video></video><div class="player-controls__right-control-group"></div>', 'https://www.twitch.tv/videos/551972874', async (url) => {
    if (url.includes('gql.twitch.tv')) return { ok: true, json: async () => ({ data: { video: { title: 'Test VOD', lengthSeconds: 49, owner: { displayName: 'TwitchDev' } }, videoPlaybackAccessToken: { signature: 'fixture', value: 'fixture' } } }) };
    if (new URL(url).pathname.endsWith('/551972874.m3u8')) return { ok: true, text: async () => master || `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360\n${variant}\n` };
    if (url.endsWith('playlist.m3u8')) return { ok: true, text: async () => playlist };
    if (segmentFetch) return segmentFetch(url);
    return { ok: true, arrayBuffer: async () => new Uint8Array([0x47, 1]).buffer };
  });
}

async function choose(app) {
  app.click(app.document.querySelector('#mendosave-twitch-record'));
  await app.settle();
  app.click(app.document.querySelector('.mendosave-twitch-menu-item'));
  await app.settle();
}

test('Twitch rejects encrypted VOD before fetching or processing segments', async () => {
  const app = vod('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:49,\n0.ts\n#EXT-X-ENDLIST');
  await choose(app);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-begin'), false);
  assert.equal(app.requests.some((x) => x.url.endsWith('0.ts')), false);
  assert.match(app.document.querySelector('#mendosave-twitch-toast').textContent, /зашифрован/);
});

test('Twitch refuses an unfinished VOD playlist instead of saving its rolling snapshot as complete', async () => {
  const app = vod('#EXTM3U\n#EXTINF:6,\n0.ts\n');
  await choose(app);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), false);
  assert.match(app.document.querySelector('#mendosave-twitch-toast').textContent, /ещё не завершён/);
});

test('Twitch resolves a relative rendition URL against its master playlist', async () => {
  const app = vod('#EXTM3U\n#EXTINF:49,\n0.ts\n#EXT-X-ENDLIST', 'source/playlist.m3u8');
  await choose(app);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), true);
  assert.equal(app.requests.some((x) => x.url === 'https://usher.ttvnw.net/vod/source/playlist.m3u8'), true);
});

test('Twitch VOD keeps at most six segment requests in flight ahead of the processor', async () => {
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  let fetched = 0;
  const lines = Array.from({ length: 9 }, (_, i) => `#EXTINF:1,\n${i}.ts`).join('\n');
  const app = vod(`#EXTM3U\n${lines}\n#EXT-X-ENDLIST`, undefined, async (url) => {
    fetched++;
    if (url.endsWith('/0.ts')) await stalled;
    return { ok: true, arrayBuffer: async () => new Uint8Array([0x47, Number(/(\d+)\.ts/.exec(url)[1])]).buffer };
  });
  await choose(app);
  const beforeRelease = fetched;
  release();
  await app.settle();
  assert.equal(beforeRelease, 6);
  assert.equal(fetched, 9);
  assert.deepEqual(app.messages.filter((x) => x.t === 'mendosave-chunk').map((x) => Buffer.from(x.b64, 'base64')[1]), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('Twitch clip reports browser interruption instead of announcing completion at download ID', async () => {
  const app = adapter('twitch_ui.js', '<video></video><div class="player-controls__right-control-group"></div>', 'https://clips.twitch.tv/CloudySarcasticSashimiTwitchRPG', async () => ({ ok: true, json: async () => ({ data: { clip: { title: 'Test clip', videoQualities: [{ quality: '360', sourceURL: 'https://media.invalid/clip.mp4' }] } } }) }),
    (message) => message.t === 'mendosave-download-state' ? { ok: true, state: 'interrupted', error: 'NETWORK_FAILED' } : { ok: true, id: 7 });
  await choose(app);
  assert.match(app.document.querySelector('#mendosave-twitch-toast').textContent, /NETWORK_FAILED/);
  assert.doesNotMatch(app.document.querySelector('#mendosave-twitch-toast').textContent, /готово/);
});

test('Twitch refuses fMP4 playlists that need an initialization segment', async () => {
  const app = vod('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:49,\n0.m4s\n#EXT-X-ENDLIST');
  await choose(app);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-begin'), false);
  assert.match(app.document.querySelector('#mendosave-twitch-toast').textContent, /fMP4/);
});

test('Twitch refuses byte-range playlists instead of concatenating the full file repeatedly', async () => {
  const app = vod('#EXTM3U\n#EXTINF:49,\n#EXT-X-BYTERANGE:100@0\nall.ts\n#EXT-X-ENDLIST');
  await choose(app);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-begin'), false);
  assert.match(app.document.querySelector('#mendosave-twitch-toast').textContent, /диапазонами bytes/);
});

test('Twitch processes the sanitized complete AWS 24-second VOD playlist in order', async () => {
  const app = vod(require('node:fs').readFileSync('tests/fixtures/twitch-vod.m3u8', 'utf8'));
  await choose(app);
  const begin = app.messages.find((x) => x.t === 'mendosave-begin');
  assert.ok(Math.abs(begin.duration - 24.022) < 0.001);
  assert.equal(app.messages.filter((x) => x.t === 'mendosave-chunk').length, 6);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), true);
});

test('Twitch owns network segment bytes before subarray and preserves their exact content', async () => {
  const app = vod('#EXTM3U\n#EXTINF:49,\n0.ts\n#EXT-X-ENDLIST', undefined, async () => ({
    ok: true, arrayBuffer: async () => Uint8Array.of(0x47, 1, 2, 3, 4).buffer,
  }));
  restrictNetworkViews(app);
  await choose(app);
  assert.equal(app.messages.find((x) => x.t === 'mendosave-chunk')?.b64, 'RwECAwQ=', app.document.querySelector('#mendosave-twitch-toast').textContent);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-finalize'), true);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-abort'), false);
});

test('Twitch retains native button semantics for each VOD rendition action', async () => {
  const app = vod('#EXTM3U\n#EXTINF:49,\n0.ts\n#EXT-X-ENDLIST');
  app.click(app.document.querySelector('#mendosave-twitch-record'));
  await app.settle();
  const controls = [...app.document.querySelectorAll('.mendosave-twitch-menu-item')];
  assert.equal(controls.length, 1);
  assert.equal(controls[0].tagName, 'BUTTON');
  assert.equal(controls[0].getAttribute('type'), 'button');
  app.click(controls[0]);
  await app.settle();
  assert.equal(app.messages.filter((x) => x.t === 'mendosave-finalize').length, 1);
});

test('Twitch distinguishes equal-resolution VOD variants by the frame rate declared in HLS', async () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720,FRAME-RATE=60.000,BANDWIDTH=3500000\nhttps://media.invalid/60/playlist.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=1280x720,FRAME-RATE=30.000,BANDWIDTH=2000000\nhttps://media.invalid/30/playlist.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=1280x720,FRAME-RATE=59.940,BANDWIDTH=3400000\nhttps://media.invalid/59.94/playlist.m3u8\n';
  const app = vod('#EXTM3U\n#EXTINF:49,\n0.ts\n#EXT-X-ENDLIST', undefined, undefined, master);
  app.click(app.document.querySelector('#mendosave-twitch-record'));
  await app.settle();
  const labels = [...app.document.querySelectorAll('.mendosave-twitch-menu-item')].map((x) => x.textContent);
  assert.deepEqual(labels, ['720p · 60 fps', '720p · 59.94 fps', '720p · 30 fps']);
});

test('Twitch distinguishes its current 720p source tiers even when both declare the same frame rate', async () => {
  // Primary AWS VOD master: both variants declare 29.973, while VIDEO IDs differ.
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720,FRAME-RATE=29.973,VIDEO="720p60",BANDWIDTH=1493288\nhttps://media.invalid/first/playlist.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=1280x720,FRAME-RATE=29.973,VIDEO="720p30",BANDWIDTH=1088144\nhttps://media.invalid/second/playlist.m3u8\n';
  const app = vod('#EXTM3U\n#EXTINF:49,\n0.ts\n#EXT-X-ENDLIST', undefined, undefined, master);
  app.click(app.document.querySelector('#mendosave-twitch-record'));
  await app.settle();
  const labels = [...app.document.querySelectorAll('.mendosave-twitch-menu-item')].map((x) => x.textContent);
  assert.deepEqual(labels, ['720p · 29.973 fps · вариант 720p60 · 1.49 Мбит/с', '720p · 29.973 fps · вариант 720p30 · 1.09 Мбит/с']);
});

test('Twitch Escape closes its native-button menu without starting processing and releases the key listener', async () => {
  const app = vod('#EXTM3U\n#EXTINF:49,\n0.ts\n#EXT-X-ENDLIST');
  app.click(app.document.querySelector('#mendosave-twitch-record'));
  await app.settle();
  const event = app.press(app.document.body, 'Escape');
  assert.equal(Boolean(app.document.querySelector('#mendosave-twitch-menu')), false);
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-begin'), false);
  assert.equal(app.press(app.document.body, 'Escape').defaultPrevented, false);
});

test('Twitch live rejects unavailable frames before play or capture, including an offline pending play promise', async (t) => {
  for (const [name, state] of [
    ['offline playing', { readyState: 0, paused: false }],
    ['offline paused', { readyState: 0, paused: true }],
    ['metadata only', { readyState: 1, paused: true }],
    ['media error', { readyState: 4, paused: true, error: { code: 3 } }],
    ['ended', { readyState: 4, paused: false, ended: true }],
  ]) {
    await t.test(name, async () => {
      const app = adapter('twitch_ui.js', '<video></video><div class="player-controls__right-control-group"></div>',
        'https://www.twitch.tv/twitchdev', async () => { throw new Error('live must not fetch a VOD'); });
      const media = app.document.querySelector('video');
      Object.assign(media, { ended: false, error: null, ...state });
      let playCalls = 0, captureCalls = 0;
      media.play = () => { playCalls++; return new Promise(() => {}); };
      media.captureStream = () => { captureCalls++; return { getVideoTracks: () => [] }; };
      app.click(app.document.querySelector('#mendosave-twitch-record'));
      await app.settle();
      assert.equal(playCalls, 0);
      assert.equal(captureCalls, 0);
      assert.match(app.document.querySelector('#mendosave-twitch-toast')?.textContent || '', /видеокадр пока недоступен/);
      assert.equal(app.document.querySelector('#mendosave-twitch-record').classList.contains('recording'), false);
      assert.equal(app.downloads.length, 0);
    });
  }
});

test('Twitch live resumes a paused ready player before capture and starts recording normally', async () => {
  const app = adapter('twitch_ui.js', '<video></video><div class="player-controls__right-control-group"></div>',
    'https://www.twitch.tv/monstercat', async () => { throw new Error('live must not fetch a VOD'); });
  const media = app.document.querySelector('video');
  recordingPort(app);
  Object.assign(media, { readyState: 2, paused: true, error: null, ended: false });
  const calls = [];
  const stream = { getVideoTracks: () => [{}] };
  media.play = async () => { calls.push('play'); media.paused = false; };
  media.captureStream = () => { calls.push('capture'); return stream; };
  app.context.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor(input) { assert.equal(input, stream); calls.push('construct'); }
    start(interval) { assert.equal(interval, 1000); this.state = 'recording'; calls.push('start'); }
  };
  app.click(app.document.querySelector('#mendosave-twitch-record'));
  await app.settle();
  assert.deepEqual(calls, ['play', 'capture', 'construct', 'start']);
  assert.equal(app.document.querySelector('#mendosave-twitch-record').classList.contains('recording'), true);
  assert.match(app.document.querySelector('#mendosave-twitch-toast').textContent, /запись начата \(monstercat\)/);
});

test('Twitch preserves received recording bytes outside the page before teardown can discard final recorder events', async () => {
  const received = [];
  const app = adapter('twitch_ui.js', '<video></video><div class="player-controls__right-control-group"></div>',
    'https://www.twitch.tv/monstercat', async () => { throw new Error('live must not fetch a VOD'); },
    (message) => {
      if (message.t === 'mendosave-live-chunk') received.push(Buffer.from(message.b64, 'base64'));
      return { ok: true, tabId: 7, state: 'complete' };
    });
  const media = app.document.querySelector('video');
  recordingPort(app);
  Object.assign(media, { readyState: 2, paused: false, error: null, ended: false });
  media.captureStream = () => ({ getVideoTracks: () => [{}] });
  let active, stopCalls = 0;
  app.context.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { active = this; this.mimeType = 'video/webm'; }
    start() { this.state = 'recording'; }
    // Model teardown: the document never gets final dataavailable or stop.
    stop() { stopCalls++; this.state = 'inactive'; }
  };
  app.click(app.document.querySelector('#mendosave-twitch-record'));
  await app.settle();
  const bytes = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4);
  active.ondataavailable({ data: new Blob([bytes], { type: 'video/webm' }) });
  await app.settle();
  app.context.window.dispatchEvent(new app.context.window.Event('beforeunload'));
  await app.settle();
  assert.equal(stopCalls, 1);
  assert.equal(app.downloads.length, 0);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-live-finalize'), false);
  assert.deepEqual(Buffer.concat(received), Buffer.from(bytes), 'already received bytes must outlive the discarded page callbacks');
});

test('Twitch marks page teardown as interrupted even when final recorder events reach the host', async () => {
  const live = liveRecording();
  live.app.click(live.app.document.querySelector('#mendosave-twitch-record'));
  await live.app.settle();
  live.recorder.ondataavailable({ data: new Blob([Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3)]) });
  await live.app.settle();
  live.app.context.window.dispatchEvent(new live.app.context.window.Event('beforeunload'));
  await live.app.settle();
  const finalized = live.app.messages.filter((x) => x.t === 'mendosave-live-finalize');
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].interrupted, true);
  assert.equal(live.port.disconnectCalls, 1);
});

test('Twitch handles host Port closure during finalize through the actual success or failure response', async (t) => {
  for (const succeeds of [true, false]) await t.test(succeeds ? 'saved' : 'save rejected', async () => {
    const live = liveRecording((message) => {
      if (message.t === 'mendosave-live-finalize') {
        live.port.disconnect();
        return succeeds ? { ok: true, filename: 'saved.webm' } : { ok: false, error: 'Save failed after Port closure' };
      }
      return { ok: true, tabId: 7 };
    });
    const button = live.app.document.querySelector('#mendosave-twitch-record');
    live.app.click(button);
    await live.app.settle();
    live.recorder.ondataavailable({ data: new Blob([Uint8Array.of(1, 2, 3)]) });
    await live.app.settle();
    live.app.click(button);
    await live.app.settle();
    const toast = live.app.document.querySelector('#mendosave-twitch-toast').textContent;
    assert.match(toast, succeeds ? /сохранено saved\.webm/ : /Save failed after Port closure/);
    if (!succeeds) assert.doesNotMatch(toast, /сохранено/);
    assert.equal(live.app.messages.filter((x) => x.t === 'mendosave-live-finalize').length, 1);
  });
});

test('Twitch does not hide a rejected pending chunk when Port closes while stop is draining', async () => {
  let rejectWrite;
  const pendingWrite = new Promise((_, reject) => { rejectWrite = reject; });
  const live = liveRecording((message) => message.t === 'mendosave-live-chunk'
    ? pendingWrite : { ok: true, tabId: 7 });
  const button = live.app.document.querySelector('#mendosave-twitch-record');
  live.app.click(button);
  await live.app.settle();
  live.recorder.ondataavailable({ data: new Blob([Uint8Array.of(1, 2, 3)]) });
  live.app.click(button);
  await live.app.settle();
  live.port.disconnect();
  rejectWrite(new Error('Chunk failed after Port closure'));
  await live.app.settle();
  const toast = live.app.document.querySelector('#mendosave-twitch-toast').textContent;
  assert.match(toast, /Chunk failed after Port closure/);
  assert.doesNotMatch(toast, /сохранено/);
  assert.equal(live.app.messages.some((x) => x.t === 'mendosave-live-finalize'), false);
});

test('Twitch recording waits for its owned Port acknowledgement before recorder.start and ignores a second start click', async () => {
  const live = liveRecording(undefined, null);
  const button = live.app.document.querySelector('#mendosave-twitch-record');
  live.app.click(button);
  await live.app.settle();
  assert.equal(live.recorder.startCalls, 0);
  assert.equal(button.classList.contains('recording'), false);
  live.app.click(button);
  await live.app.settle();
  const begins = live.app.messages.filter((message) => message.t === 'mendosave-live-begin');
  assert.equal(begins.length, 1);
  assert.equal(begins[0].rawRecording, true);
  assert.equal(begins[0].mime, 'video/webm');
  assert.match(begins[0].filename, /^Twitch - monstercat - .*\.webm$/);
  assert.equal(live.port.name, `mendosave-twitch-recording:${begins[0].jobId}`);
  live.port.acknowledge();
  await live.app.settle();
  assert.equal(live.recorder.startCalls, 1);
  assert.equal(button.classList.contains('recording'), true);
});

test('Twitch recording aborts a rejected Port binding before recording starts', async () => {
  const live = liveRecording(undefined, { ok: false, error: 'Foreign recording owner' });
  live.app.click(live.app.document.querySelector('#mendosave-twitch-record'));
  await live.app.settle();
  assert.equal(live.recorder.startCalls, 0);
  assert.equal(live.app.messages.filter((x) => x.t === 'mendosave-live-abort').length, 1);
  assert.equal(live.app.messages.some((x) => x.t === 'mendosave-live-finalize'), false);
  assert.match(live.app.document.querySelector('#mendosave-twitch-toast').textContent, /Foreign recording owner/);
});

test('Twitch recording releases an unbound host job on early Port disconnect or binding timeout', async (t) => {
  for (const mode of ['disconnect', 'timeout']) await t.test(mode, async () => {
    const live = liveRecording(undefined, null);
    let expire;
    const schedule = live.app.context.setTimeout;
    live.app.context.setTimeout = (fn, delay) => {
      if (delay === 30_000) { expire = fn; return 2; }
      return schedule(fn, delay);
    };
    live.app.click(live.app.document.querySelector('#mendosave-twitch-record'));
    await live.app.settle();
    if (mode === 'timeout') expire();
    else live.port.disconnect();
    await live.app.settle();
    assert.equal(live.recorder.startCalls, 0);
    assert.equal(live.app.messages.filter((x) => x.t === 'mendosave-live-abort').length, 1);
    assert.equal(live.app.messages.some((x) => x.t === 'mendosave-live-finalize'), false);
    assert.match(live.app.document.querySelector('#mendosave-twitch-toast').textContent,
      mode === 'timeout' ? /не подтвердил запись за 30 секунд/ : /связь с обработчиком записи прервалась/);
  });
});

test('Twitch stop drains ordered 4 MiB chunks and the final recorder tail before one host finalize', async () => {
  let release;
  const firstWrite = new Promise((resolve) => { release = resolve; });
  const accepted = [];
  const live = liveRecording((message) => {
    if (message.t === 'mendosave-live-chunk') {
      accepted.push(Buffer.from(message.b64, 'base64'));
      if (accepted.length === 1) return firstWrite;
    }
    return { ok: true, tabId: 7, filename: 'saved.webm' };
  });
  const button = live.app.document.querySelector('#mendosave-twitch-record');
  live.app.click(button);
  await live.app.settle();
  const prefix = Buffer.alloc(4 * 1024 * 1024 + 7, 0x27);
  prefix.set([0x1a, 0x45, 0xdf, 0xa3]);
  const tail = Buffer.from([1, 2, 3, 4]);
  live.recorder.ondataavailable({ data: new Blob([prefix], { type: 'video/webm' }) });
  live.recorder.stop = () => {
    live.recorder.state = 'inactive';
    queueMicrotask(() => {
      live.recorder.ondataavailable({ data: new Blob([tail], { type: 'video/webm' }) });
      live.recorder.onstop();
    });
  };
  live.app.click(button);
  await live.app.settle();
  assert.equal(accepted.length, 1);
  assert.equal(live.app.messages.some((x) => x.t === 'mendosave-live-finalize'), false);
  assert.equal(live.port.disconnectCalls, 0);
  release({ ok: true });
  await live.app.settle();
  live.recorder.onstop();
  await live.app.settle();
  assert.deepEqual(accepted.map((part) => part.length), [4 * 1024 * 1024, 7, 4]);
  assert.deepEqual(Buffer.concat(accepted), Buffer.concat([prefix, tail]));
  assert.equal(live.app.messages.filter((x) => x.t === 'mendosave-live-finalize').length, 1);
  assert.equal(live.app.messages.find((x) => x.t === 'mendosave-live-finalize').interrupted, false);
  assert.equal(live.port.disconnectCalls, 1);
  assert.equal(live.app.downloads.length, 0);
  assert.match(live.app.document.querySelector('#mendosave-twitch-toast').textContent, /сохранено saved\.webm/);
});

test('Twitch transfer failure disconnects for host partial preservation without aborting acknowledged bytes or claiming completion', async () => {
  const accepted = [];
  const live = liveRecording((message) => {
    if (message.t === 'mendosave-live-chunk') {
      if (accepted.length) return { ok: false, error: 'QuotaExceededError' };
      accepted.push(Buffer.from(message.b64, 'base64'));
    }
    return { ok: true, tabId: 7 };
  });
  live.app.click(live.app.document.querySelector('#mendosave-twitch-record'));
  await live.app.settle();
  live.recorder.ondataavailable({ data: new Blob([Uint8Array.of(1, 2, 3)]) });
  await live.app.settle();
  live.recorder.ondataavailable({ data: new Blob([Uint8Array.of(4, 5, 6)]) });
  await live.app.settle();
  assert.deepEqual(Buffer.concat(accepted), Buffer.from([1, 2, 3]));
  assert.equal(live.port.disconnectCalls, 1);
  assert.equal(live.app.messages.some((x) => ['mendosave-live-abort', 'mendosave-live-finalize'].includes(x.t)), false);
  const toast = live.app.document.querySelector('#mendosave-twitch-toast').textContent;
  assert.match(toast, /QuotaExceededError/);
  assert.doesNotMatch(toast, /сохранено/);
});

test('Twitch recording copies foreign Blob bytes before subarray chunk transfer', async () => {
  const live = liveRecording();
  const bytes = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 9);
  function XrayUint8Array(input, offset, length) {
    const view = new Uint8Array(input, offset, length);
    if (input === bytes.buffer) Object.defineProperty(view, 'constructor', {
      get() { throw new Error('Permission denied to access property "constructor"'); },
    });
    return view;
  }
  XrayUint8Array.prototype = Uint8Array.prototype;
  live.app.context.Uint8Array = XrayUint8Array;
  live.app.click(live.app.document.querySelector('#mendosave-twitch-record'));
  await live.app.settle();
  live.recorder.ondataavailable({ data: { size: bytes.length, arrayBuffer: async () => bytes.buffer } });
  await live.app.settle();
  const chunks = live.app.messages.filter((x) => x.t === 'mendosave-live-chunk');
  assert.equal(chunks.length, 1, live.app.document.querySelector('#mendosave-twitch-toast').textContent);
  assert.deepEqual(Buffer.from(chunks[0].b64, 'base64'), Buffer.from(bytes));
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { adapter, restrictNetworkViews } = require('./tiktok-adapter-harness.cjs');

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

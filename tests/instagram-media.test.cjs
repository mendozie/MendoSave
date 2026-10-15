const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test, before } = require('node:test');
const { DOMParser } = require('linkedom');
const schema = require('../extension/instagram_source.js');
const media = require('../extension/instagram_media.js');
const { create: createPackageUI } = require('../extension/package_ui.js');
const { fixture: packageIO } = require('./package-io-harness.cjs');
const { producerPorts } = require('./producer-port-harness.cjs');
globalThis.DOMParser = DOMParser;
const parserLibrary = import('../extension/vendor/mediabunny/mediabunny.min.mjs');
const mp4Fixtures = new Map();
before(async () => {
  const lib = await parserLibrary;
  for (const [audio, videoTrack, width, height, fragmented] of [[true, true, 720, 1280, false],
    [false, true, 720, 1280, false], [true, false, 0, 0, false], [false, true, 1080, 1920, false],
    [true, true, 720, 1280, true], [false, true, 1080, 1920, true], [true, false, 0, 0, true]]) {
    const target = new lib.BufferTarget();
    const output = new lib.Output({ target, format: new lib.Mp4OutputFormat({ fastStart: fragmented ? 'fragmented' : 'in-memory' }) });
    const videoSource = videoTrack && new lib.EncodedVideoPacketSource('avc');
    const audioSource = audio && new lib.EncodedAudioPacketSource('aac');
    if (videoSource) output.addVideoTrack(videoSource);
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    // Complete synthetic sample tables/payloads test container and transport
    // contracts; these dummy encoded samples are not native codec evidence.
    if (videoSource) for (let i = 0; i < 2; i++) await videoSource.add(new lib.EncodedPacket(
      Uint8Array.of(0, 0, 0, 2, 0x65, 0x80 + i), 'key', i * 0.04, 0.04), {
      decoderConfig: { codec: 'avc1.42001e', codedWidth: width, codedHeight: height,
        description: Uint8Array.of(1, 0x42, 0, 0x1e, 0xff, 0xe0, 0) },
    });
    if (audioSource) for (let i = 0; i < 4; i++) await audioSource.add(new lib.EncodedPacket(
      Uint8Array.of(1, 2, 3 + i), 'key', i * 0.02, 0.02), {
      decoderConfig: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1, description: Uint8Array.of(0x11, 0x88) },
    });
    await output.finalize();
    mp4Fixtures.set(`${audio}:${videoTrack}:${width}:${height}:${fragmented}`, Buffer.from(target.buffer));
  }
});

const cdn = name => `https://scontent.cdninstagram.com/${name}`;
const photo = () => ({ id: '101', index: 0, type: 'photo', hasAudio: null, dashManifest: '',
  imageVersions: [{ url: cdn('small.jpg'), width: 1, height: 1 },
    { url: cdn('large.jpg'), width: 2, height: 3 }], videoVersions: [] });
const post = (items = [photo()]) => ({ shortcode: 'B', id: '1', username: 'author', caption: 'Описание автора', items });
const video = (overrides = {}) => ({ id: '103', index: 0, type: 'video', hasAudio: true, dashManifest: '',
  imageVersions: [], videoVersions: [{ url: cdn('video.mp4'), width: 720, height: 1280 }], ...overrides });
const mpd = `<MPD type="static" xmlns="urn:mpeg:dash:schema:mpd:2011"><Period>
  <AdaptationSet mimeType="video/mp4" codecs="avc1.640028">
    <Representation id="low" width="360" height="640" bandwidth="100000"><BaseURL>${cdn('360.mp4')}</BaseURL></Representation>
    <Representation id="high" width="1080" height="1920" bandwidth="600000"><BaseURL>${cdn('1080.mp4')}</BaseURL><SegmentBase indexRange="16-20"><Initialization range="0-15"/></SegmentBase></Representation>
  </AdaptationSet><AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2">
    <Representation id="aac" bandwidth="128000"><BaseURL>${cdn('audio.m4a')}</BaseURL></Representation>
  </AdaptationSet></Period></MPD>`;

test('Instagram offers photo versions highest first and caption once in a full carousel', () => {
  const second = { ...photo(), id: '102', index: 1 };
  const options = media.choices(post([photo(), second]));
  assert.deepEqual(options.map(item => item.kind), ['photo', 'photo', 'photo', 'photo', 'caption']);
  assert.match(options[0].label, /2 × 3/);
  assert.match(options[1].label, /1 × 1/);
  assert.match(options[0].label, /формат источника/);
  assert.match(options[2].group, /2/);
  assert.match(options[4].label, /Описание автора · TXT/);
  assert.equal(new Set(options.map(item => item.id)).size, 5);
});

test('Instagram preserves sound in DASH choices, ranks resolutions and offers audio from the real track', () => {
  const options = media.choices(post([video({ dashManifest: mpd })]));
  const videos = options.filter(item => item.kind === 'video');
  assert.deepEqual(videos.map(item => item.version.height), [1920, 1280, 640]);
  assert.equal(videos[0].transport, 'dash');
  assert.equal(videos[0].audio.url, cdn('audio.m4a'));
  assert.match(videos[0].label, /H\.264 \+ AAC/);
  assert.equal(videos[1].transport, 'progressive');
  assert.deepEqual(options.filter(item => item.kind === 'audio').map(item => item.format), ['m4a', 'mp3']);
});

function environment(fetcher, hooks = {}) {
  const saved = [], messages = [], listeners = new Set();
  let released = 0;
  const controller = new AbortController();
  const packageUI = { signal: controller.signal, check() {
    if (controller.signal.aborted) throw Object.assign(new Error('Отменено'), { name: 'AbortError' });
  }, fetch: fetcher, async saveBlob(blob, filename) { saved.push({ blob, filename }); return filename; },
  async acquireProcessor(options) { hooks.acquired?.(options); return { release() { released++; }, async send(message) {
    messages.push(message);
    const response = await hooks.send?.(message, options);
    if (response) return response;
    if (message.t === 'mendosave-register-job') return { ok: true, tabId: 7 };
    return { ok: true, filename: message.filename };
  } }; } };
  const runtime = { onMessage: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } } };
  return { executor: media.create({ schema, packageUI, runtime, loadParser: () => parserLibrary }), packageUI, runtime, saved, messages, controller, listeners,
    get released() { return released; } };
}
// Valid 2x3 solid-color images generated offline with Python Pillow 12.1.1.
const jpeg = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDCooor7Q8I/9k=', 'base64'));
const webp = new Uint8Array(Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+7nZ//q0PlofLQ/c+/+LORiOy8AAA', 'base64'));
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGM0STvDwMDAxAAGUAoAGk4BbEHQzlIAAAAASUVORK5CYII=', 'base64'));

test('Instagram photo preserves bytes with actual WEBP extension despite a jpg URL', async () => {
  const env = environment(async (url, options) => {
    assert.equal(url, cdn('large.jpg'));
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return new Response(webp, { headers: { 'content-type': 'image/webp', 'content-length': String(webp.length) } });
  });
  const value = post();
  const choice = media.choices(value)[0];
  const filename = await env.executor.run(value, choice);
  assert.match(filename, /\.webp$/);
  assert.equal(env.saved.length, 1);
  assert.equal(env.saved[0].blob.type, 'image/webp');
  assert.deepEqual(new Uint8Array(await env.saved[0].blob.arrayBuffer()), webp);
});

test('Instagram progressive video saves exact muxed bytes and MP3 requests local best-quality conversion', async () => {
  const bytes = mp4();
  const env = environment(async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
  const value = post([video()]);
  await env.executor.run(value, media.choices(value).find(item => item.kind === 'video'));
  assert.equal(env.saved.length, 1);
  assert.deepEqual(Buffer.from(await env.saved[0].blob.arrayBuffer()), bytes);
  await env.executor.run(value, media.choices(value).find(item => item.format === 'mp3'));
  const begin = env.messages.find(message => message.t === 'mendosave-begin');
  assert.equal(begin.audioFormat, 'mp3');
  assert.equal(begin.audioQuality, 'best');
  assert.equal(begin.audioCopyOnly, undefined);
});

test('Instagram original DASH audio preserves its container bytes and caption preserves author text', async () => {
  const bytes = mp4(true, false);
  const env = environment(async () => new Response(bytes, { headers: { 'content-type': 'audio/mp4' } }));
  const value = post([video({ dashManifest: mpd })]); value.caption = 'Первая строка\n🎥 Вторая строка';
  await env.executor.run(value, media.choices(value).find(item => item.format === 'm4a'));
  assert.equal(env.saved[0].blob.type, 'audio/mp4');
  assert.match(env.saved[0].filename, /\.m4a$/);
  assert.deepEqual(Buffer.from(await env.saved[0].blob.arrayBuffer()), bytes);
  await env.executor.run(value, media.choices(value).find(item => item.kind === 'caption'));
  assert.equal(await env.saved[1].blob.text(), value.caption);
  assert.equal(env.messages.length, 0);
});

test('Instagram never saves a progressive video missing its promised audio', async () => {
  const env = environment(async () => new Response(mp4(false), { headers: { 'content-type': 'video/mp4' } }));
  const value = post([video()]);
  await assert.rejects(env.executor.run(value, media.choices(value)[0]), /без обещанной аудиодорожки/);
  assert.equal(env.saved.length, 0);
  await assert.rejects(env.executor.run(value, media.choices(value).find(item => item.format === 'm4a')), /нет аудиодорожки/);
  assert.equal(env.messages.length, 0);
});

test('Instagram rejects unsafe or unsupported DASH instead of silently omitting a carousel video', () => {
  for (const manifest of [mpd.replace(cdn('1080.mp4'), 'https://attacker.example/stream.mp4'),
    mpd.replace('avc1.640028', 'unsupported'), mpd.replace('<Period>', '<Period><ContentProtection/>'),
    mpd.replace('<Period>', '<Period><SegmentTemplate/>'), '<!DOCTYPE MPD [<!ENTITY x SYSTEM="https://example.com/">]>' + mpd]) {
    assert.throws(() => media.choices(post([video({ dashManifest: manifest })])), /Instagram:/);
  }
});

test('Instagram unknown audio never hides a mixed carousel and labels each available transport truthfully', () => {
  const silent = mpd.replace(/<AdaptationSet mimeType="audio\/mp4"[\s\S]*?<\/AdaptationSet>/, '');
  const value = post([photo(), video({ index: 1, hasAudio: null, dashManifest: silent }), { ...photo(), id: '104', index: 2 }]);
  const options = media.choices(value);
  assert.equal(options.filter(option => option.kind === 'photo').length, 4);
  const videos = options.filter(option => option.kind === 'video');
  assert.equal(videos.length, 3);
  assert.ok(videos.filter(option => option.transport === 'dash').every(option => /без звука/.test(option.label)));
  assert.match(videos.find(option => option.transport === 'progressive').label, /звук не подтверждён/);
  const audio = options.filter(option => option.kind === 'audio');
  assert.deepEqual(audio.map(option => option.format), ['m4a', 'mp3']);
  assert.ok(audio.every(option => /звук не подтверждён/.test(option.label)));
});

test('Instagram promised sound filters silent DASH but retains progressive video and confirmed audio choices', () => {
  const silent = mpd.replace(/<AdaptationSet mimeType="audio\/mp4"[\s\S]*?<\/AdaptationSet>/, '');
  const value = post([video({ dashManifest: silent })]);
  const options = media.choices(value);
  const videos = options.filter(option => option.kind === 'video');
  assert.equal(videos.length, 1);
  assert.equal(videos[0].transport, 'progressive');
  assert.match(videos[0].label, /со звуком/);
  assert.equal(options.filter(option => option.kind === 'audio').length, 2);
  assert.throws(() => media.choices(post([video({ videoVersions: [], dashManifest: silent })])), /нет поддержанного видео/);
});

test('Instagram an unknown sound flag still confirms a real DASH audio track and omits audio for silent DASH alone', () => {
  const confirmed = media.choices(post([video({ hasAudio: null, dashManifest: mpd })])).filter(option => option.kind === 'audio');
  assert.equal(confirmed.length, 2);
  assert.ok(confirmed.every(option => !/звук не подтверждён/.test(option.label)));
  const silent = mpd.replace(/<AdaptationSet mimeType="audio\/mp4"[\s\S]*?<\/AdaptationSet>/, '');
  const options = media.choices(post([video({ hasAudio: null, videoVersions: [], dashManifest: silent })]));
  assert.equal(options.filter(option => option.kind === 'audio').length, 0);
  assert.equal(options.filter(option => option.kind === 'video').length, 2);
});

test('Instagram rejects HTML, unknown or mismatched bytes, incomplete media and excessive advertised size before saving', async () => {
  const responses = [
    () => new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('<html>Login</html>', { headers: { 'content-type': 'image/jpeg' } }),
    () => new Response(webp, { headers: { 'content-type': 'image/jpeg' } }),
    () => new Response(jpeg.slice(0, 4), { headers: { 'content-type': 'image/jpeg', 'content-length': '12' } }),
    () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg', 'content-length': String(1024 ** 3) } }),
    () => new Response(jpeg, { status: 429 }),
  ];
  for (const response of responses) {
    const env = environment(async () => response());
    const value = post();
    await assert.rejects(env.executor.run(value, media.choices(value)[0]), /Instagram:/);
    assert.equal(env.saved.length, 0);
  }
});

test('Instagram reruns source validation and ignores URLs injected into a previously displayed choice', async () => {
  const urls = [];
  const env = environment(async url => { urls.push(url); return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }); });
  const value = post(), choice = media.choices(value)[0];
  choice.version.url = 'https://attacker.example/payload';
  await env.executor.run(value, choice);
  assert.deepEqual(urls, [cdn('large.jpg')]);
  value.items[0].imageVersions[0].url = 'https://attacker.example/payload';
  await assert.rejects(env.executor.run(value, choice), /Instagram/);
  assert.equal(urls.length, 1);
});

test('Instagram aborts a failed processor job, releases its producer and removes progress listeners', async () => {
  const env = environment(async () => new Response(mp4(), { headers: { 'content-type': 'video/mp4' } }), {
    send(message) { if (message.t === 'mendosave-chunk') return { ok: false, error: 'processor refused bytes' }; },
  });
  const value = post([video()]);
  await assert.rejects(env.executor.run(value, media.choices(value).find(item => item.format === 'mp3')), /processor refused bytes/);
  assert.equal(env.messages.some(message => message.t === 'mendosave-finalize'), false);
  assert.equal(env.messages.filter(message => message.t === 'mendosave-abort').length, 1);
  assert.equal(env.released, 1);
  assert.equal(env.listeners.size, 0);
});

test('Instagram cancellation during finalization immediately aborts the owned processor and drains before release', async () => {
  let finish, entered;
  const finalized = new Promise(resolve => { entered = resolve; });
  const controller = new AbortController();
  const env = environment(async () => new Response(mp4(), { headers: { 'content-type': 'video/mp4' } }), {
    send(message) {
      if (message.t === 'mendosave-finalize') { entered(); return new Promise(resolve => { finish = resolve; }); }
      if (message.t === 'mendosave-abort') { finish?.({ ok: false, cancelled: true }); return { ok: true }; }
    },
  });
  const value = post([video()]);
  const work = env.executor.run(value, media.choices(value).find(item => item.format === 'mp3'), { signal: controller.signal });
  const outcome = work.then(() => 'saved', error => error.name);
  await finalized;
  controller.abort();
  const result = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('still finalizing'), 50))]);
  if (result === 'still finalizing') { finish({ ok: false, cancelled: true }); await outcome; }
  assert.equal(result, 'AbortError');
  assert.equal(env.messages.filter(message => message.t === 'mendosave-abort').length, 1);
  assert.equal(env.released, 1);
  assert.equal(env.listeners.size, 0);
});

test('Instagram cancellation interrupts a pending response body and permits a fresh run', async () => {
  let cancelled = false;
  const env = environment(async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(jpeg.slice(0, 4)); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'image/jpeg', 'content-length': '12' } }));
  const controller = new AbortController();
  const value = post(), choice = media.choices(value)[0];
  const work = env.executor.run(value, choice, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(Promise.race([work, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('did not stop pending transfer')), 100);
    timer.unref();
  })]), { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.equal(env.saved.length, 0);
  await env.executor.run(value, media.choices(value).find(option => option.kind === 'caption'));
  assert.equal(env.saved.length, 1);
});

test('Instagram cancelled fetch prioritizes its own AbortError over a foreign then failure', async () => {
  const controller = new AbortController();
  const env = environment(() => {
    controller.abort();
    return Object.defineProperty({}, 'then', { get() { throw new Error('Permission denied to access property "then"'); } });
  });
  const value = post();
  await assert.rejects(env.executor.run(value, media.choices(value)[0], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(env.saved.length, 0);
});

test('Instagram retains a non-cancellation fetch failure instead of reporting a cancellation', async () => {
  const env = environment(() => Object.defineProperty({}, 'then', {
    get() { throw new Error('Permission denied to access property "then"'); },
  }));
  const value = post();
  await assert.rejects(env.executor.run(value, media.choices(value)[0]), { name: 'Error', message: 'Permission denied to access property "then"' });
  assert.equal(env.saved.length, 0);
});

test('Instagram foreign reader cleanup cannot replace the original transfer error', async () => {
  let cleaned = false;
  const env = environment(async () => ({ status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }),
    body: { getReader() { return {
      read() { throw new Error('original body read failure'); },
      cancel() {
        cleaned = true;
        return Object.defineProperties({}, {
          then: { get() { throw new Error('Permission denied to access property "then"'); } },
          catch: { get() { throw new Error('Permission denied to access property "then"'); } },
        });
      },
    }; } },
  }));
  const value = post();
  await assert.rejects(env.executor.run(value, media.choices(value)[0]), /original body read failure/);
  assert.equal(cleaned, true);
  assert.equal(env.saved.length, 0);
});

test('Instagram abort event safely drains a reader with an inaccessible foreign cancel Promise', async () => {
  let finishRead, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  let cancelled = 0;
  const env = environment(async () => ({ status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }),
    body: { getReader() { return {
      read() { entered(); return new Promise(resolve => { finishRead = resolve; }); },
      cancel() {
        cancelled++;
        finishRead?.({ done: true });
        return Object.defineProperties({}, {
          then: { get() { throw new Error('Permission denied to access property "then"'); } },
          catch: { get() { throw new Error('Permission denied to access property "then"'); } },
        });
      },
    }; } },
  }));
  const controller = new AbortController(), value = post();
  const work = env.executor.run(value, media.choices(value)[0], { signal: controller.signal });
  const outcome = assert.rejects(work, { name: 'AbortError' });
  await reading;
  controller.abort();
  await outcome;
  assert.ok(cancelled > 0);
  assert.equal(env.saved.length, 0);
  await env.executor.run(value, media.choices(value).find(option => option.kind === 'caption'));
  assert.equal(env.saved.length, 1);
});

function box(type, ...parts) {
  const payload = Buffer.concat(parts.map(part => Buffer.from(part)));
  const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type, 4);
  return Buffer.concat([header, payload]);
}
function track(handler, codec) {
  const hdlr = Buffer.alloc(12); hdlr.write(handler, 8);
  const stsd = Buffer.alloc(8); stsd.writeUInt32BE(1, 4);
  return box('trak', box('mdia', box('hdlr', hdlr), box('minf', box('stbl', box('stsd', stsd, box(codec, Buffer.alloc(28)))))));
}
const mp4 = (audio = true, videoTrack = true, width = 720, height = 1280, fragmented = false) =>
  Buffer.from(mp4Fixtures.get(`${audio}:${videoTrack}:${videoTrack ? width : 0}:${videoTrack ? height : 0}:${fragmented}`));
const mp4Containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf']);
function rewriteMp4(bytes, transform) {
  const parts = [];
  for (let at = 0; at < bytes.length;) {
    const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    assert.ok(size >= 8 && at + size <= bytes.length);
    let payload = bytes.subarray(at + 8, at + size);
    if (mp4Containers.has(type)) payload = rewriteMp4(payload, transform);
    const transformed = transform(type, payload) ?? payload;
    parts.push(Buffer.isBuffer(transformed) ? box(type, transformed) : box(transformed.type, transformed.payload));
    at += size;
  }
  return Buffer.concat(parts);
}

test('Instagram rejects a complete progressive MP4 whose actual dimensions differ from the selected quality', async () => {
  const value = post([video({ videoVersions: [{ url: cdn('wrong-quality.mp4'), width: 1080, height: 1920 }] })]);
  const env = environment(async () => new Response(mp4(), { headers: { 'content-type': 'video/mp4' } }));
  await assert.rejects(env.executor.run(value, media.choices(value)[0]), /размер видео не совпадает/);
  assert.equal(env.saved.length, 0);
  assert.equal(env.messages.length, 0);
});

test('Instagram rejects empty or undersized progressive and fragmented sample payloads without Content-Length', async () => {
  for (const fragmented of [false, true]) for (const payloadBytes of [0, 1]) {
    const bytes = rewriteMp4(mp4(true, true, 720, 1280, fragmented), (type, payload) => type === 'mdat' ? payload.subarray(0, payloadBytes) : payload);
    const env = environment(async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
    const value = post([video()]);
    await assert.rejects(env.executor.run(value, media.choices(value)[0]), /MP4|полностью|samples/);
    assert.equal(env.saved.length, 0);
    assert.equal(env.messages.length, 0);
  }
});

test('Instagram rejects boxed dummy media with metadata but no actual indexed samples', async () => {
  const bytes = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isommp42')), box('mdat'), box('moov', track('vide', 'avc1'), track('soun', 'mp4a'))]);
  const env = environment(async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
  const value = post([video()]);
  await assert.rejects(env.executor.run(value, media.choices(value)[0]), /MP4|полностью|samples/);
  assert.equal(env.saved.length, 0);
});

test('Instagram rejects samples indexed into headers instead of an mdat payload', async () => {
  const bytes = rewriteMp4(mp4(false), (type, payload) => {
    if (type !== 'stco') return payload;
    const changed = Buffer.from(payload);
    assert.equal(changed.readUInt32BE(4), 1);
    changed.writeUInt32BE(0, 8);
    return changed;
  });
  const env = environment(async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
  const value = post([video({ hasAudio: false })]);
  await assert.rejects(env.executor.run(value, media.choices(value)[0]), /sample.*mdat|диапазон.*MP4/);
  assert.equal(env.saved.length, 0);
  assert.equal(env.messages.length, 0);
});

test('Instagram rejects co64 and fragmented trun sample offsets into metadata', async () => {
  for (const scenario of ['co64-header', 'co64-unsafe', 'trun-header']) {
    const fragmented = scenario === 'trun-header';
    let changedOffset = false;
    const bytes = rewriteMp4(mp4(false, true, fragmented ? 1080 : 720, fragmented ? 1920 : 1280, fragmented), (type, payload) => {
      if (!fragmented && type === 'stco') {
        const count = payload.readUInt32BE(4), wide = Buffer.alloc(8 + count * 8);
        payload.copy(wide, 0, 0, 8); changedOffset = true;
        if (scenario === 'co64-unsafe') for (let index = 0; index < count; index++) wide.writeBigUInt64BE(2n ** 53n, 8 + index * 8);
        return { type: 'co64', payload: wide };
      }
      if (fragmented && type === 'trun') {
        assert.ok(payload.readUInt32BE(0) & 1, 'controlled fragmented fixture has an explicit data offset');
        const changed = Buffer.from(payload); changed.writeInt32BE(0, 8); changedOffset = true; return changed;
      }
      return payload;
    });
    assert.equal(changedOffset, true);
    const value = post([video({ hasAudio: false, videoVersions: [{ url: cdn('invalid-extent.mp4'),
      width: fragmented ? 1080 : 720, height: fragmented ? 1920 : 1280 }] })]);
    const env = environment(async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
    await assert.rejects(env.executor.run(value, media.choices(value)[0]), /sample.*mdat|диапазон.*MP4/);
    assert.equal(env.saved.length, 0);
    assert.equal(env.messages.length, 0);
  }
});

test('Instagram requires a parser extent projection before reading or saving a sample', async () => {
  const lib = await parserLibrary;
  let actualReads = 0;
  class MissingExtentSink extends lib.EncodedPacketSink {
    async getFirstPacket(options) {
      if (!options?.metadataOnly) actualReads++;
      const packet = await super.getFirstPacket(options);
      // clone does not copy the vendor's deliberately nonenumerable projection.
      return packet?.clone();
    }
  }
  const env = environment(async () => new Response(mp4(), { headers: { 'content-type': 'video/mp4' } }));
  const executor = media.create({ schema, packageUI: env.packageUI, runtime: env.runtime,
    loadParser: async () => ({ ...lib, EncodedPacketSink: MissingExtentSink }) });
  const value = post([video()]);
  await assert.rejects(executor.run(value, media.choices(value)[0]), /диапазон sample MP4 не подтверждён/);
  assert.equal(actualReads, 0);
  assert.equal(env.saved.length, 0);
  assert.equal(env.messages.length, 0);
});

test('Instagram rejects a sample crossing mdat into another complete box even when every byte exists', async () => {
  const original = mp4(false);
  let end = 0;
  for (let at = 0; at < original.length; at += original.readUInt32BE(at)) {
    if (original.toString('ascii', at + 4, at + 8) === 'mdat') end = at + original.readUInt32BE(at);
  }
  assert.ok(end > 0);
  const bytes = Buffer.concat([rewriteMp4(original, (type, payload) => {
    if (type !== 'stco') return payload;
    const changed = Buffer.from(payload); changed.writeUInt32BE(end - 3, 8); return changed;
  }), box('free', Buffer.alloc(32))]);
  const env = environment(async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
  const value = post([video({ hasAudio: false })]);
  await assert.rejects(env.executor.run(value, media.choices(value)[0]), /sample.*mdat|диапазон.*MP4/);
  assert.equal(env.saved.length, 0);
});

test('Instagram accepts complete samples indexed by co64 without losing exact bytes', async () => {
  const bytes = rewriteMp4(mp4(false), (type, payload) => {
    if (type !== 'stco') return payload;
    const count = payload.readUInt32BE(4), wide = Buffer.alloc(8 + count * 8);
    payload.copy(wide, 0, 0, 8);
    for (let index = 0; index < count; index++) wide.writeBigUInt64BE(BigInt(payload.readUInt32BE(8 + index * 4) + count * 4), 8 + index * 8);
    return { type: 'co64', payload: wide };
  });
  const value = post([video({ hasAudio: false })]);
  const env = environment(async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
  await env.executor.run(value, media.choices(value)[0]);
  assert.deepEqual(Buffer.from(await env.saved[0].blob.arrayBuffer()), bytes);
});

test('Instagram accepts complete fragmented progressive MP4 with known or honestly unknown dimensions', async () => {
  const bytes = mp4(true, true, 720, 1280, true);
  for (const unknown of [false, true]) {
    const value = post([video({ videoVersions: [{ url: cdn('fragmented.mp4'), width: unknown ? 0 : 720, height: unknown ? 0 : 1280 }] })]);
    const env = environment(async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
    await env.executor.run(value, media.choices(value)[0]);
    assert.deepEqual(Buffer.from(await env.saved[0].blob.arrayBuffer()), bytes);
  }
});

test('Instagram validates complete fragmented DASH inputs before handing both exact tracks to the processor', async () => {
  const videoBytes = mp4(false, true, 1080, 1920, true), audioBytes = mp4(true, false, 0, 0, true);
  const value = post([video({ dashManifest: mpd })]);
  const env = environment(async url => new Response(url === cdn('audio.m4a') ? audioBytes : videoBytes,
    { headers: { 'content-type': url === cdn('audio.m4a') ? 'audio/mp4' : 'video/mp4' } }));
  const choice = media.choices(value).find(option => option.kind === 'video' && option.transport === 'dash');
  await env.executor.run(value, choice);
  for (const [trackName, bytes] of [['video', videoBytes], ['audio', audioBytes]]) {
    const chunks = env.messages.filter(message => message.t === 'mendosave-chunk' && message.track === trackName)
      .map(message => Buffer.from(message.b64, 'base64'));
    assert.deepEqual(Buffer.concat(chunks), bytes);
  }
  const wrong = environment(async () => new Response(mp4(false), { headers: { 'content-type': 'video/mp4' } }));
  await assert.rejects(wrong.executor.run(value, choice), /размер видео не совпадает/);
  assert.equal(wrong.saved.length, 0);
  assert.equal(wrong.messages.length, 0);
});

test('Instagram uses displayed video dimensions after rotation rather than blindly comparing coded dimensions', async () => {
  const rotated = rewriteMp4(mp4(), (type, payload) => {
    if (type !== 'tkhd' || !payload.readUInt32BE(76)) return payload;
    const changed = Buffer.from(payload);
    changed.writeInt32BE(0, 40); changed.writeInt32BE(65536, 44);
    changed.writeInt32BE(-65536, 52); changed.writeInt32BE(0, 56);
    return changed;
  });
  const value = post([video({ videoVersions: [{ url: cdn('rotated.mp4'), width: 1280, height: 720 }] })]);
  const env = environment(async () => new Response(rotated, { headers: { 'content-type': 'video/mp4' } }));
  await env.executor.run(value, media.choices(value)[0]);
  assert.equal(env.saved.length, 1);
  value.items[0].videoVersions[0].width = 720; value.items[0].videoVersions[0].height = 1280;
  await assert.rejects(env.executor.run(value, media.choices(value)[0]), /размер видео не совпадает/);
  assert.equal(env.saved.length, 1);
});

test('Instagram rejects samples ending before the declared complete track duration', async () => {
  const bytes = rewriteMp4(mp4(), (type, payload) => {
    if (type !== 'mdhd') return payload;
    const changed = Buffer.from(payload); changed.writeUInt32BE(changed.readUInt32BE(12) * 5, 16); return changed;
  });
  const env = environment(async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
  const value = post([video()]);
  await assert.rejects(env.executor.run(value, media.choices(value)[0]), /длительность MP4 короче/);
  assert.equal(env.saved.length, 0);
});

test('Instagram disposes the actual parser when metadata or packet reading is cancelled', async () => {
  const lib = await parserLibrary;
  for (const stage of ['metadata', 'packets']) {
    let disposed = 0;
    const controller = new AbortController();
    class GuardedInput extends lib.Input {
      async getTracks(...args) { const tracks = await super.getTracks(...args); if (stage === 'metadata') controller.abort(); return tracks; }
      dispose() { disposed++; return super.dispose(); }
    }
    class GuardedSink extends lib.EncodedPacketSink {
      async getNextPacket(packet, options) {
        const next = await super.getNextPacket(packet, options);
        if (stage === 'packets' && !options?.metadataOnly) controller.abort();
        return next;
      }
    }
    const env = environment(async () => new Response(mp4(), { headers: { 'content-type': 'video/mp4' } }));
    const executor = media.create({ schema, packageUI: env.packageUI, runtime: env.runtime,
      loadParser: async () => ({ ...lib, Input: GuardedInput, EncodedPacketSink: GuardedSink }) });
    const value = post([video()]);
    await assert.rejects(executor.run(value, media.choices(value)[0], { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(disposed, 1);
    assert.equal(env.saved.length, 0);
    assert.equal(env.messages.length, 0);
  }
});

test('Instagram cancellation disposes and interrupts a parser waiting on an unfinished source read', async () => {
  const lib = await parserLibrary;
  let entered, releaseRead, disposed = 0;
  const reading = new Promise(resolve => { entered = resolve; });
  class BlockedSource extends lib.CustomSource {
    constructor(options) {
      super({ ...options, read(start, end) {
        entered();
        return new Promise((resolve, reject) => {
          releaseRead = () => Promise.resolve().then(() => options.read(start, end)).then(resolve, reject);
        });
      } });
    }
  }
  class GuardedInput extends lib.Input { dispose() { disposed++; return super.dispose(); } }
  const env = environment(async () => new Response(mp4(), { headers: { 'content-type': 'video/mp4' } }));
  const executor = media.create({ schema, packageUI: env.packageUI, runtime: env.runtime,
    loadParser: async () => ({ ...lib, CustomSource: BlockedSource, Input: GuardedInput }) });
  const controller = new AbortController(), value = post([video()]);
  const outcome = executor.run(value, media.choices(value)[0], { signal: controller.signal }).then(() => 'saved', error => error.name);
  await reading;
  controller.abort();
  const result = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('still reading'), 50))]);
  await releaseRead();
  await outcome;
  assert.equal(result, 'AbortError');
  assert.equal(disposed, 1);
  assert.equal(env.saved.length, 0);
  assert.equal(env.messages.length, 0);
});

test('Instagram invalidated choices do not load a parser or fetch any media', async () => {
  let loaded = 0, fetched = 0;
  const env = environment(async () => { fetched++; throw new Error('unexpected fetch'); });
  const executor = media.create({ schema, packageUI: env.packageUI, runtime: env.runtime,
    loadParser: async () => { loaded++; return parserLibrary; } });
  const value = post([video()]);
  await assert.rejects(executor.run(value, { id: 'old choice', compatibilityKey: 'old choice' }), /больше недоступен/);
  assert.equal(loaded, 0); assert.equal(fetched, 0);
});

test('Instagram rejects a fragmented DASH track ending before its advertised presentation duration', async () => {
  const silent = mpd.replace(/<AdaptationSet mimeType="audio\/mp4"[\s\S]*?<\/AdaptationSet>/, '')
    .replace('<MPD type="static"', '<MPD mediaPresentationDuration="PT1S" type="static"');
  const value = post([video({ hasAudio: false, videoVersions: [], dashManifest: silent })]);
  const bytes = mp4(false, true, 1080, 1920, true);
  const env = environment(async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
  await assert.rejects(env.executor.run(value, media.choices(value)[0]), /длительность MP4 короче заявленной в DASH/);
  assert.equal(env.saved.length, 0);
});

test('Instagram rejects missing complete trailing fragments even on a long advertised DASH presentation', async () => {
  const lib = await parserLibrary;
  const target = new lib.BufferTarget();
  const output = new lib.Output({ target, format: new lib.Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }) });
  const source = new lib.EncodedVideoPacketSource('avc'); output.addVideoTrack(source); await output.start();
  for (let i = 0; i < 600; i++) await source.add(new lib.EncodedPacket(Uint8Array.of(0, 0, 0, 2, 0x65, 0x80), 'key', i, 1), {
    decoderConfig: { codec: 'avc1.42001e', codedWidth: 720, codedHeight: 1280,
      description: Uint8Array.of(1, 0x42, 0, 0x1e, 0xff, 0xe0, 0) },
  });
  await output.finalize();
  const complete = Buffer.from(target.buffer), fragments = [];
  for (let at = 0; at < complete.length; at += complete.readUInt32BE(at)) {
    if (complete.toString('ascii', at + 4, at + 8) === 'moof') fragments.push(at);
  }
  assert.equal(fragments.length, 600);
  const truncated = complete.subarray(0, fragments.at(-5));
  const silent = mpd.replace(/<AdaptationSet mimeType="audio\/mp4"[\s\S]*?<\/AdaptationSet>/, '')
    .replace('<MPD type="static"', '<MPD mediaPresentationDuration="PT600S" type="static"')
    .replace('width="1080" height="1920"', 'width="720" height="1280"');
  const value = post([video({ hasAudio: false, videoVersions: [], dashManifest: silent })]);
  const env = environment(async () => new Response(truncated, { headers: { 'content-type': 'video/mp4' } }));
  await assert.rejects(env.executor.run(value, media.choices(value)[0]), /длительность MP4 короче заявленной в DASH/);
  assert.equal(env.saved.length, 0);
});

test('Instagram original audio demuxes a progressive MP4 with strict copy and actual AAC metadata', async () => {
  const bytes = mp4();
  const env = environment(async () => new Response(bytes, { headers: {
    'content-type': 'video/mp4', 'content-length': String(bytes.length),
  } }));
  const value = post([video()]);
  const filename = await env.executor.run(value, media.choices(value).find(item => item.format === 'm4a'));
  assert.match(filename, /\.m4a$/);
  assert.equal(env.saved.length, 0);
  const begun = env.messages.find(message => message.t === 'mendosave-begin');
  assert.equal(begun.format, 'mp3');
  assert.equal(begun.audioFormat, 'original');
  assert.equal(begun.audioCopyOnly, true);
  assert.match(begun.audioMime, /mp4a/);
  assert.equal(begun.tabId, 7);
  const received = Buffer.concat(env.messages.filter(message => message.t === 'mendosave-chunk')
    .map(message => Buffer.from(message.b64, 'base64')));
  assert.deepEqual(received, bytes);
  assert.ok(env.messages.some(message => message.t === 'mendosave-finalize'));
  assert.equal(env.released, 1);
  assert.equal(env.listeners.size, 0);
});

test('Instagram DASH video delivers complete separate video and AAC tracks to an owned job', async () => {
  const videoBytes = mp4(false, true, 1080, 1920), audioBytes = mp4(true, false);
  const env = environment(async url => new Response(url === cdn('audio.m4a') ? audioBytes : videoBytes,
    { headers: { 'content-type': url === cdn('audio.m4a') ? 'audio/mp4' : 'video/mp4' } }));
  const value = post([video({ dashManifest: mpd })]);
  const filename = await env.executor.run(value, media.choices(value).find(item => item.transport === 'dash' && item.kind === 'video'));
  assert.match(filename, /1080x1920.*\.mp4$/);
  const begin = env.messages.find(message => message.t === 'mendosave-begin');
  assert.equal(begin.format, 'mp4');
  assert.equal(begin.transcode, false);
  assert.match(begin.videoMime, /avc1/);
  assert.match(begin.audioMime, /mp4a/);
  for (const [trackName, bytes] of [['video', videoBytes], ['audio', audioBytes]]) {
    const actual = Buffer.concat(env.messages.filter(message => message.t === 'mendosave-chunk' && message.track === trackName)
      .map(message => Buffer.from(message.b64, 'base64')));
    assert.deepEqual(actual, bytes);
  }
  assert.equal(env.released, 1);
});

test('Instagram supports explicitly muted DASH video without inventing an audio track', async () => {
  const muted = mpd.replace(/<AdaptationSet mimeType="audio\/mp4"[\s\S]*?<\/AdaptationSet>/, '');
  const value = post([video({ hasAudio: false, videoVersions: [], dashManifest: muted })]);
  const options = media.choices(value);
  assert.equal(options.filter(item => item.kind === 'video').length, 2);
  assert.equal(options.some(item => item.kind === 'audio'), false);
  assert.match(options[0].label, /без звука/);
  const env = environment(async () => new Response(mp4(false, true, 1080, 1920), { headers: { 'content-type': 'video/mp4' } }));
  await env.executor.run(value, options[0]);
  assert.equal(env.saved.length, 1);
  assert.equal(env.messages.length, 0);
});

test('Instagram same-size versions keep distinct selection keys, labels and saved filenames', async () => {
  const item = photo(); item.imageVersions.push({ url: cdn('another-large.jpg'), width: 2, height: 3 });
  const value = post([item]);
  const options = media.choices(value).filter(item => item.kind === 'photo');
  assert.equal(new Set(options.map(item => item.compatibilityKey)).size, 3);
  assert.match(options[1].label, /вариант 2/);
  const env = environment(async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }));
  await env.executor.run(value, options[0]); await env.executor.run(value, options[1]);
  assert.notEqual(env.saved[0].filename, env.saved[1].filename);
});

test('Instagram rejects a DASH manifest referencing separate initialization URLs', () => {
  const linked = mpd.replace('<Initialization range="0-15"/>', '<Initialization sourceURL="https://attacker.example/init" range="0-15"/>');
  assert.throws(() => media.choices(post([video({ dashManifest: linked })])), /Instagram:/);
});

test('Instagram cancellation after processor acquisition does not submit stale work', async () => {
  const controller = new AbortController();
  const env = environment(async () => new Response(mp4(), { headers: { 'content-type': 'video/mp4' } }), {
    acquired() { controller.abort(); },
  });
  const value = post([video()]);
  await assert.rejects(env.executor.run(value, media.choices(value).find(item => item.format === 'mp3'),
    { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(env.messages.length, 0);
  assert.equal(env.released, 1);
});

test('Instagram processor disconnect preserves its error and never finalizes or saves a stale job', async () => {
  const env = environment(async () => new Response(mp4(), { headers: { 'content-type': 'video/mp4' } }), {
    send(message, options) {
      if (message.t === 'mendosave-chunk') options.onDisconnect(new Error('processor disconnected'));
    },
  });
  const value = post([video()]);
  await assert.rejects(env.executor.run(value, media.choices(value).find(item => item.format === 'mp3')), /processor disconnected/);
  assert.equal(env.messages.some(message => message.t === 'mendosave-finalize'), false);
  assert.equal(env.messages.filter(message => message.t === 'mendosave-abort').length, 1);
  assert.equal(env.released, 1);
  assert.equal(env.listeners.size, 0);
});

test('Instagram large processor input uses bounded chunks with identical reconstructed bytes', async () => {
  const bytes = Buffer.concat([mp4(), box('free', Buffer.alloc(2 * 1024 ** 2, 42))]);
  const env = environment(async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
  const value = post([video()]);
  await env.executor.run(value, media.choices(value).find(item => item.format === 'mp3'));
  const chunks = env.messages.filter(message => message.t === 'mendosave-chunk').map(message => Buffer.from(message.b64, 'base64'));
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every(chunk => chunk.length <= 1024 ** 2));
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test('Instagram caption reaches native save through real PackageUI and PackageIO as exact UTF8 text/plain', async () => {
  const fixture = packageIO();
  const { connect } = producerPorts();
  const sender = { id: 'mendo@test', tab: { id: 7 }, frameId: 0, documentId: 'doc7' };
  const runtime = { connect, async sendMessage(message) {
    if (message.t === 'mendosave-ensure') return { ok: true };
    return fixture.io.handle(message, sender);
  } };
  const ui = createPackageUI({ runtime });
  const executor = media.create({ schema, packageUI: ui, runtime, loadParser: () => parserLibrary });
  const value = post(); value.caption = 'Описание 🎥\nВторая строка';
  const filename = await executor.run(value, media.choices(value).find(option => option.kind === 'caption'));
  assert.match(filename, /\.txt$/);
  assert.equal(fixture.saved.length, 1);
  assert.equal(fixture.saved[0].blob.type, 'text/plain');
  assert.deepEqual(Buffer.from(await fixture.saved[0].blob.arrayBuffer()), Buffer.from(value.caption, 'utf8'));
  assert.equal(fixture.files.size, 0);
});

test('Instagram unknown image and progressive dimensions are explicit, rank after known DASH and never become 0x0 filenames', async () => {
  const image = photo(); image.imageVersions = [{ url: cdn('unknown.jpg'), width: 0, height: 0 }];
  const value = post([image, video({ index: 1, videoVersions: [{ url: cdn('unknown.mp4'), width: 0, height: 0 }], dashManifest: mpd })]);
  const options = media.choices(value);
  assert.match(options[0].label, /размер не указан/);
  const videos = options.filter(option => option.kind === 'video');
  assert.deepEqual(videos.map(option => option.transport), ['dash', 'dash', 'progressive']);
  assert.match(videos[2].label, /размер не указан/);
  assert.equal(options.some(option => option.label.includes('0 × 0')), false);
  const env = environment(async url => new Response(url.endsWith('.jpg') ? jpeg : mp4(), {
    headers: { 'content-type': url.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4' },
  }));
  for (const choice of [options[0], videos[2]]) assert.doesNotMatch(await env.executor.run(value, choice), /0x0/);
});

test('Instagram rejects truncated JPEG, PNG and RIFF bodies without Content-Length or a native decoder', async () => {
  for (const [bytes, mime] of [[Uint8Array.from([255, 216, 255]), 'image/jpeg'], [jpeg.slice(0, -2), 'image/jpeg'],
    [png.slice(0, -12), 'image/png'], [webp.slice(0, -2), 'image/webp']]) {
    const env = environment(async () => new Response(bytes, { headers: { 'content-type': mime } }));
    const value = post();
    await assert.rejects(env.executor.run(value, media.choices(value)[0]), /Instagram:/);
    assert.equal(env.saved.length, 0);
  }
});

test('Instagram valid JPEG, PNG and WEBP pass structural validation with exact bytes and dimensions', async () => {
  for (const [bytes, mime, extension] of [[jpeg, 'image/jpeg', 'jpg'], [png, 'image/png', 'png'], [webp, 'image/webp', 'webp']]) {
    const env = environment(async () => new Response(bytes, { headers: { 'content-type': mime } }));
    const value = post();
    assert.match(await env.executor.run(value, media.choices(value)[0]), new RegExp(`\\.${extension}$`));
    assert.deepEqual(Buffer.from(await env.saved[0].blob.arrayBuffer()), Buffer.from(bytes));
    value.items[0].imageVersions[1].height = 4;
    await assert.rejects(env.executor.run(value, media.choices(value)[0]), /размер фото не совпадает/);
    assert.equal(env.saved.length, 1);
  }
});

test('Instagram uses native image decoding and closes the bitmap for known and unknown dimensions', async () => {
  const previous = globalThis.createImageBitmap;
  const decoded = [], closed = [];
  globalThis.createImageBitmap = async (blob, options) => {
    decoded.push({ blob, options });
    return { width: 2, height: 3, close() { closed.push(true); } };
  };
  try {
    for (const unknown of [false, true]) {
      const value = post();
      if (unknown) value.items[0].imageVersions.forEach(version => { version.width = 0; version.height = 0; });
      const env = environment(async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }));
      await env.executor.run(value, media.choices(value)[0]);
      assert.equal(env.saved.length, 1);
    }
    assert.equal(decoded.length, 2);
    assert.equal(closed.length, 2);
    assert.ok(decoded.every(call => call.blob.type === 'image/jpeg' && call.options.imageOrientation === 'none'));
  } finally {
    if (previous === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previous;
  }
});

test('Instagram decoder failures and decoded dimension mismatches never save an image', async () => {
  const previous = globalThis.createImageBitmap;
  let closed = 0;
  try {
    for (const decode of [async () => { throw new Error('unsupported format'); },
      async () => ({ width: 2, height: 4, close() { closed++; } })]) {
      globalThis.createImageBitmap = decode;
      const value = post();
      const env = environment(async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }));
      await assert.rejects(env.executor.run(value, media.choices(value)[0]), /браузер не смог декодировать фото/);
      assert.equal(env.saved.length, 0);
    }
    assert.equal(closed, 1);
  } finally {
    if (previous === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previous;
  }
});

test('Instagram owns Gecko foreign Blob and stream bytes before inspecting or transferring media', async t => {
  for (const scenario of ['png', 'webp', 'dash', 'audio']) await t.test(scenario, async () => {
    const foreignBuffers = new WeakSet();
    let foreignViews = 0;
    class ForeignBlob extends Blob {
      async arrayBuffer() { const buffer = await super.arrayBuffer(); foreignBuffers.add(buffer); return buffer; }
      slice(...args) { const part = super.slice(...args); return new ForeignBlob([part], { type: part.type }); }
    }
    function ContentUint8Array(input, offset, length) {
      const view = new Uint8Array(input, offset, length);
      if (foreignBuffers.has(input)) {
        foreignViews++;
        Object.defineProperty(view, 'constructor', {
          get() { throw new Error('Permission denied to access property "constructor"'); },
        });
      }
      return view;
    }
    ContentUint8Array.prototype = Uint8Array.prototype;
    const context = vm.createContext({ module: { exports: {} }, Uint8Array: ContentUint8Array, Blob: ForeignBlob,
      DataView, Promise, AbortController, DOMParser, crypto, btoa, setTimeout, clearTimeout, MendoInstagramSource: schema });
    vm.runInContext(fs.readFileSync('extension/instagram_media.js', 'utf8'), context);
    const foreignMedia = context.module.exports;
    const imageBytes = scenario === 'png' ? png : webp;
    const env = environment(async url => {
      const bytes = scenario === 'png' || scenario === 'webp' ? imageBytes : url === cdn('audio.m4a') ? mp4(true, false)
        : scenario === 'dash' ? mp4(false, true, 1080, 1920) : mp4();
      const mime = scenario === 'png' || scenario === 'webp' ? `image/${scenario}` : url === cdn('audio.m4a') ? 'audio/mp4' : 'video/mp4';
      const response = new Response(bytes, { headers: { 'content-type': mime } });
      const reader = response.body.getReader();
      return { status: 200, headers: response.headers, body: { getReader() { return {
        async read() {
          const part = await reader.read();
          if (part.value) Object.defineProperty(part.value, 'constructor', {
            get() { throw new Error('Permission denied to access property "constructor"'); },
          });
          return part;
        }, cancel() { return reader.cancel(); },
      }; } } };
    });
    const executor = foreignMedia.create({ schema, packageUI: env.packageUI, runtime: env.runtime, loadParser: () => parserLibrary });
    const value = post(scenario === 'png' || scenario === 'webp' ? [photo()] : [video({ dashManifest: scenario === 'dash' ? mpd : '' })]);
    const selected = foreignMedia.choices(value).find(option => scenario === 'audio' ? option.format === 'mp3'
      : scenario === 'dash' ? option.kind === 'video' && option.transport === 'dash' : option.kind === 'photo');
    await executor.run(value, selected);
    assert.ok(foreignViews > 0, 'the fixture exercises views backed by foreign Blob buffers');
    if (scenario === 'png' || scenario === 'webp') {
      assert.deepEqual(Buffer.from(await env.saved[0].blob.arrayBuffer()), Buffer.from(imageBytes));
    } else for (const trackName of scenario === 'dash' ? ['video', 'audio'] : ['audio']) {
      const chunks = env.messages.filter(message => message.t === 'mendosave-chunk' && message.track === trackName)
        .map(message => Buffer.from(message.b64, 'base64'));
      const expected = scenario === 'audio' ? mp4() : trackName === 'audio' ? mp4(true, false) : mp4(false, true, 1080, 1920);
      assert.deepEqual(Buffer.concat(chunks), expected);
    }
  });
});

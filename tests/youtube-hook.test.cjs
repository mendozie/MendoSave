const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function pageHook() {
  const { document, window } = parseHTML('<html><body><div id="movie_player"><video></video></div></body></html>');
  const player = document.getElementById('movie_player');
  player.getPlaybackQuality = () => 'small';
  player.getAvailableQualityLevels = () => [];
  const media = player.querySelector('video');
  media.currentTime = 0; media.duration = 19;
  class SourceBuffer {
    constructor() { this.received = []; this.buffered = { length: 0 }; }
    appendBuffer(bytes) { this.received.push(Uint8Array.from(bytes)); }
  }
  class MediaSource {
    constructor() { this.sourceBuffers = []; this.readyState = 'open'; }
    addSourceBuffer() { const buffer = new SourceBuffer(); this.sourceBuffers.push(buffer); return buffer; }
    static isTypeSupported() { return true; }
  }
  class HTMLMediaElement { canPlayType() { return 'probably'; } }
  const posts = [];
  window.MediaSource = MediaSource;
  window.SourceBuffer = SourceBuffer;
  window.Worker = undefined;
  window.postMessage = (message) => posts.push(message);
  const location = new URL('https://www.youtube.com/watch?v=fixture01');
  const context = vm.createContext({ document, window, location, MediaSource, SourceBuffer, HTMLMediaElement,
    URL, URLSearchParams, Uint8Array, ArrayBuffer, DataView, TextDecoder, TextEncoder, Blob,
    performance, screen: { width: 1920, height: 1080 }, navigator: { userAgent: 'test' },
    console: { log() {}, error() {}, warn() {} },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
  });
  // Execute the complete page script so constructor wrapping, passive-capture
  // startup, and both public bridge handlers participate in the regression.
  vm.runInContext(fs.readFileSync('extension/content_hook.js', 'utf8'), context);
  function drain(reqId) {
    const event = new window.Event('message');
    event.source = window; event.origin = location.origin;
    event.data = { __mendosave_to_hook: true, cmd: 'drain-captured', reqId };
    window.dispatchEvent(event);
    const reply = posts.find((message) => message.__mendosave_from_hook === true && message.reqId === reqId);
    assert.ok(reply, 'the page bridge must reply to drain-captured');
    assert.equal(reply.ok, true);
    return reply.tracks;
  }
  return { MediaSource, drain };
}

function box(type, payload) {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(Buffer.from(type, 'ascii'), 4);
  bytes.set(payload, 8);
  return bytes;
}

test('YouTube MSE bridge drains captured audio and video with their decoder init before media bytes', () => {
  const hook = pageHook();
  const source = new hook.MediaSource();
  const audio = source.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
  const video = source.addSourceBuffer('video/mp4; codecs="avc1.4d4015"');
  const audioInit = box('ftyp', Uint8Array.of(0x69, 0x73, 0x6f, 0x6d));
  const videoInit = box('ftyp', Uint8Array.of(0x69, 0x73, 0x6f, 0x32));
  const audioMedia = box('moof', Uint8Array.of(1, 2, 3, 4));
  const videoMedia = box('moof', Uint8Array.of(5, 6, 7, 8));
  audio.appendBuffer(audioInit); video.appendBuffer(videoInit);
  audio.appendBuffer(audioMedia); video.appendBuffer(videoMedia);

  // The hook remains transparent to the player's normal append calls.
  assert.deepEqual(audio.received.map((bytes) => [...bytes]), [[...audioInit], [...audioMedia]]);
  assert.deepEqual(video.received.map((bytes) => [...bytes]), [[...videoInit], [...videoMedia]]);
  const tracks = hook.drain(1);
  assert.ok(tracks.audio instanceof ArrayBuffer, 'captured audio must include its initialization segment');
  assert.ok(tracks.video instanceof ArrayBuffer, 'captured video must include its initialization segment');
  assert.deepEqual([...new Uint8Array(tracks.audio)], [...audioInit, ...audioMedia]);
  assert.deepEqual([...new Uint8Array(tracks.video)], [...videoInit, ...videoMedia]);
  assert.deepEqual(Object.keys(hook.drain(2)), [], 'a second drain must not duplicate bytes already shipped');
});

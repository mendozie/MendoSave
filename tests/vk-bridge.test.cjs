const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const espree = require('espree');

const fixture = () => ({ response: { error_code: 0, video: {
  owner_id: -1, id: 2, title: 'Projected fixture', duration: 19,
  files: { mp4_720: 'https://vkvd526.okcdn.ru/?fixture=720',
    dash_sep: 'https://vkvd526.okcdn.ru/?fixture=dash',
    hls: 'https://vkvd526.okcdn.ru/video.m3u8?fixture=hls', failover_host: 'ignored.example' },
  access_token: 'not metadata', tracking_info: 'not metadata',
} } });

function bridge(options = {}) {
  const received = [], listeners = new Map();
  const location = new URL('https://vkvideo.ru/video_ext.php?oid=-1&id=2&autoplay=0');
  const parent = { location: new URL('https://vkvideo.ru/video-1_2'),
    postMessage(message) { received.push(structuredClone(message)); } };
  const response = options.response || new Response(JSON.stringify(options.body || fixture()),
    { headers: { 'content-type': 'application/json' } });
  const nativeResult = options.nativeResult || Promise.resolve(response);
  const window = { parent,
    addEventListener(type, callback) { const callbacks = listeners.get(type) || []; callbacks.push(callback); listeners.set(type, callbacks); },
    fetch() { return nativeResult; },
  };
  if (options.XMLHttpRequest) window.XMLHttpRequest = options.XMLHttpRequest;
  const context = vm.createContext({ window, location, URL, TextDecoder, TextEncoder, console });
  for (const name of ['vk_source.js', 'vk_bridge.js']) vm.runInContext(fs.readFileSync(`extension/${name}`, 'utf8'), context);
  const request = (changes = {}, sender = parent, origin = location.origin) => {
    const data = { __mendosave_vk_to_player: true, kind: 'request', requestId: 'menu_7',
      sourceHref: 'https://vkvideo.ru/video-1_2', frameHref: location.href, oid: '-1', id: '2', ...changes };
    for (const callback of listeners.get('message') || []) callback({ data, source: sender, origin });
  };
  const settle = async () => { for (let index = 0; index < 8; index++) await new Promise(setImmediate); };
  return { window, location, parent, request, received, nativeResult, settle,
    blockParentLocation() {
      Object.defineProperty(parent, 'location', { configurable: true, get() {
        throw Object.assign(new Error('Permission denied to get property "href" on cross-origin object'), { name: 'SecurityError' });
      } });
    },
  };
}
const results = b => b.received.filter(message => message.kind === 'result');

function publicAdapterFixture() {
  // Reuse the existing full delivered-adapter DOM fixture without registering
  // its unrelated tests. The assertion observes real menu and bridge messages.
  const source = fs.readFileSync('tests/vk.test.cjs', 'utf8');
  const tree = espree.parse(source, { ecmaVersion: 'latest', range: true });
  const setup = tree.body.filter(node => node.type === 'FunctionDeclaration' || node.type === 'VariableDeclaration')
    .map(node => source.slice(...node.range)).join('\n');
  return new Function('require', `${setup}\nreturn { adapter, open };`)(createRequire(path.resolve('tests/vk.test.cjs')));
}

test('VK observer caches only the minimal matching native payload without changing the native response', async () => {
  const b = bridge();
  assert.equal(b.window.fetch('https://api.vk.ru/method/video.getEmbed', { body: 'private native authentication' }), b.nativeResult);
  await b.settle();
  b.request();
  const [result] = results(b);
  assert.equal(result.video.oid, '-1'); assert.equal(result.video.id, '2');
  assert.deepEqual(Object.keys(result.video.files).sort(), ['dash_sep', 'mp4_720']);
  assert.deepEqual(Object.keys(result.video).sort(), ['duration', 'files', 'id', 'oid', 'title']);
  assert.doesNotMatch(JSON.stringify(b.received), /access_token|tracking_info|not metadata|private native|failover_host|ignored.example/);
});

test('VK observer returns correlated metadata when parent location access raises SecurityError', async t => {
  for (const phase of ['cached request', 'pending response']) await t.test(phase, async () => {
    const b = bridge();
    if (phase === 'pending response') b.request();
    b.blockParentLocation();
    assert.equal(b.window.fetch('https://api.vk.ru/method/video.getEmbed'), b.nativeResult);
    await b.settle();
    if (phase === 'cached request') b.request();
    const result = results(b)[0];
    assert.ok(result, 'the controlled player can exchange messages without parent DOM/location access');
    assert.equal(result.sourceHref, 'https://vkvideo.ru/video-1_2');
    assert.equal(result.frameHref, b.location.href);
    assert.equal(result.requestId, 'menu_7');
    assert.equal(result.video.oid, '-1'); assert.equal(result.video.id, '2');
    assert.deepEqual(Object.keys(result.video).sort(), ['duration', 'files', 'id', 'oid', 'title']);
  });
});

test('VK observer refuses foreign window, origin, parent source, frame and video identities', async () => {
  const b = bridge();
  b.blockParentLocation();
  await b.window.fetch('https://api.vk.ru/method/video.getEmbed'); await b.settle();
  b.request({}, {});
  b.request({}, b.parent, 'https://vk.com');
  b.request({ sourceHref: 'https://vkvideo.ru/video-1_99' });
  b.request({ frameHref: 'https://vkvideo.ru/video_ext.php?oid=-1&id=99' });
  b.request({ oid: '-7' });
  b.request({ id: '99' });
  assert.equal(results(b).length, 0);
  b.request({ requestId: 'current_menu' });
  assert.equal(results(b).length, 1);
  assert.equal(results(b)[0].requestId, 'current_menu');
});

test('VK observer requires a bounded canonical source URL at the exact frame origin', async () => {
  const b = bridge(); b.blockParentLocation();
  await b.window.fetch('https://api.vk.ru/method/video.getEmbed'); await b.settle();
  for (const sourceHref of [
    'https://vk.com/video-1_2', 'https://m.vkvideo.ru/video-1_2',
    'https://vkvideo.ru/video-1_2?view=current', 'https://vkvideo.ru/video-1_2#current',
    ' https://vkvideo.ru/video-1_2 ', 'http://vkvideo.ru/video-1_2',
    'https://user:password@vkvideo.ru/video-1_2', 'https://vkvideo.ru:444/video-1_2',
    'https://attacker.example/video-1_2', `https://vkvideo.ru/video-1_2/${'x'.repeat(8192)}`, null,
  ]) b.request({ sourceHref });
  assert.equal(results(b).length, 0);
  b.request();
  assert.equal(results(b).length, 1, 'a canonical same-origin current-source claim remains available');
});

test('VK observer drops a pending result when its own frame has moved to another video', async () => {
  let complete;
  const nativeResult = new Promise(resolve => { complete = resolve; });
  const b = bridge({ nativeResult });
  b.request();
  b.window.fetch('https://api.vk.ru/method/video.getEmbed');
  b.location.searchParams.set('id', '99');
  complete(new Response(JSON.stringify(fixture()))); await b.settle();
  assert.equal(results(b).length, 0);
});

test('VK isolated parent refuses a delayed opaque-frame result after an unclosed parent SPA source change', async () => {
  const { adapter, open } = publicAdapterFixture();
  let complete;
  const nativeDeferred = new Promise(resolve => { complete = resolve; });
  const a = adapter({ modernFrame: true, nativeDeferred, payload: '<script>window.isBFF=true;</script>' });
  await open(a);
  const frame = a.frames[0];
  assert.ok(frame.isConnected); assert.equal(a.bridgeRequests.length, 1);
  Object.defineProperty(frame.contentWindow.parent, 'location', { get() {
    throw Object.assign(new Error('Permission denied to get property "href" on cross-origin object'), { name: 'SecurityError' });
  } });
  a.location.pathname = '/video-1_99';
  complete(new Response(JSON.stringify(fixture()))); await a.settle();
  assert.equal(a.bridgeMessages.filter(message => message.kind === 'result').length, 1,
    'the opaque frame may answer its previously validated source claim');
  assert.equal(a.document.querySelectorAll('.mendosave-vk-item[role="button"]').length, 0,
    'the actual isolated parent must refuse the old result before exposing download choices');
  assert.equal(a.messages.some(message => message.t === 'mendosave-save' || message.t === 'mendosave-begin'), false);
  assert.equal(frame.isConnected, false, 'actual-source refusal disposes the owned frame');
});

test('VK observer does not expose cancelled requests or unrelated API response bodies', async () => {
  const b = bridge();
  b.request(); b.request({ kind: 'cancel' });
  await b.window.fetch('https://api.vk.ru/method/video.getEmbed'); await b.settle();
  assert.equal(results(b).length, 0);
  const other = bridge(); other.request();
  await other.window.fetch('https://api.vkvideo.ru/method/video.getWebToken'); await other.settle();
  assert.equal(results(other).length, 0);
});

test('VK observer refuses an API redirect to another host', async () => {
  const response = new Response(JSON.stringify(fixture()));
  Object.defineProperty(response, 'url', { value: 'https://attacker.example/payload' });
  const b = bridge({ response }); b.request();
  await b.window.fetch('https://api.vk.ru/method/video.getEmbed'); await b.settle();
  assert.equal(results(b)[0].video, undefined);
  assert.equal(results(b)[0].code, 'PLAYER_UNAVAILABLE');
});

test('VK observer rejects an oversized clone without waiting for the native player to consume its original', async () => {
  const payload = ' '.repeat(2 * 1024 * 1024 + 1);
  const response = new Response(payload), clones = [];
  const clone = response.clone.bind(response);
  // Node 22's Undici can finalize an unreachable clone by cancelling the original
  // tee branch. Keep the fixture's real clones alive through the ownership check.
  response.clone = () => { const copy = clone(); clones.push(copy); return copy; };
  const b = bridge({ response });
  b.request(); await b.window.fetch('https://api.vk.ru/method/video.getEmbed'); await b.settle();
  assert.ok(results(b)[0], 'the observer must classify the oversized response while the original is still unread');
  assert.equal(results(b)[0].code, 'RESPONSE_TOO_LARGE');
  const original = await b.nativeResult;
  assert.equal(original.bodyUsed, false);
  // Run with --expose-gc to cover delayed consumption under CI collection pressure.
  if (typeof global.gc === 'function') {
    for (let index = 0; index < 8; index++) { global.gc(); await new Promise(setImmediate); }
  }
  assert.equal(original.bodyUsed, false, 'the original remains unread until its native consumer starts');
  assert.equal(original.body.locked, false);
  const bytes = await original.arrayBuffer();
  assert.equal(bytes.byteLength, 2 * 1024 * 1024 + 1);
  assert.ok(Buffer.from(bytes).equals(Buffer.from(payload)));
  assert.ok(clones.length > 0);
  assert.equal(clones[0].bodyUsed, true, 'the observer consumed its clone before the original was read');
});

for (const [name, response, code] of [
  ['malformed JSON', new Response('{not json}'), 'INVALID_RESPONSE'],
  ['missing response', new Response('{}'), 'INVALID_RESPONSE'],
  ['nonzero service error', new Response(JSON.stringify({ response: { error_code: 15 } })), 'API_ERROR'],
  ['declared oversized body', new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }), 'RESPONSE_TOO_LARGE'],
]) {
  test(`VK observer classifies ${name} without handing the page an executable route`, async () => {
    const b = bridge({ response }); b.request();
    await b.window.fetch('https://api.vk.ru/method/video.getEmbed'); await b.settle();
    assert.equal(results(b)[0]?.code, code);
    assert.equal(results(b)[0]?.video, undefined);
    await (await b.nativeResult).arrayBuffer();
  });
}

test('VK observer supports a native JSON XMLHttpRequest with the same filtered projection', async () => {
  class NativeXHR {
    constructor() { this.listeners = []; this.status = 200; this.responseType = 'json'; this.response = fixture(); }
    open(method, url) { this.method = method; this.responseURL = url; }
    addEventListener(type, callback) { if (type === 'load') this.listeners.push(callback); }
    send() { for (const listener of this.listeners) listener(); return 'native-result'; }
  }
  const b = bridge({ XMLHttpRequest: NativeXHR }); b.request();
  const xhr = new b.window.XMLHttpRequest(); xhr.open('POST', 'https://api.vk.ru/method/video.getEmbed');
  assert.equal(xhr.send('private request body'), 'native-result');
  assert.equal(results(b)[0].video.id, '2');
  assert.deepEqual(Object.keys(results(b)[0].video.files).sort(), ['dash_sep', 'mp4_720']);
  assert.doesNotMatch(JSON.stringify(b.received), /private request|access_token|tracking_info/);
});

test('VK observer enforces raw bytes for multibyte XHR text', async () => {
  class NativeXHR {
    constructor() { this.listeners = []; this.status = 200; this.responseType = 'text';
      this.responseText = JSON.stringify({ ...fixture(), irrelevant: 'Ж'.repeat(1100 * 1024) }); }
    open(method, url) { this.responseURL = url; }
    addEventListener(type, callback) { if (type === 'load') this.listeners.push(callback); }
    send() { for (const callback of this.listeners) callback(); }
  }
  const b = bridge({ XMLHttpRequest: NativeXHR }); b.request();
  const xhr = new b.window.XMLHttpRequest(); xhr.open('POST', 'https://api.vk.ru/method/video.getEmbed'); xhr.send();
  assert.equal(results(b)[0]?.code, 'RESPONSE_TOO_LARGE');
  assert.equal(results(b)[0]?.video === undefined, true);
});

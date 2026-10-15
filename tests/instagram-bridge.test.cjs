const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DOMParser } = require('linkedom');
const schema = require('../extension/instagram_source.js');
const readerAPI = require('../extension/instagram_bridge.js');
const url = 'https://www.instagram.com/p/ABC/';
const photo = () => ({ code: 'ABC', pk: '66', media_type: 1, user: { username: 'fixture' },
  caption: { text: 'Описание\n🙂' }, image_versions2: { candidates: [
    { url: 'https://scontent.cdninstagram.com/image.jpg', width: 1080, height: 1350 },
  ] }, tracking_token: 'never-project-this' });
const html = payload => '<!doctype html><html><body>' + (payload ? '<script type="application/json">'
  + JSON.stringify({ require: [payload] }).replaceAll('<', '\\u003c') + '</script>' : '') + '</body></html>';
function response(target, body, options = {}) {
  const value = new Response(body, options);
  Object.defineProperty(value, 'url', { value: target });
  return value;
}
function reader({ payload = photo(), fetcher, ...options } = {}) {
  const location = new URL(url), calls = [];
  const api = readerAPI.create({ schema, DOMParser, current: () => location.href,
    fetch: async (target, init) => { calls.push({ url: target, init });
      return fetcher ? fetcher(target, init) : response(target, html(payload)); }, ...options });
  return { api, location, calls, read: options => api.read(schema.source(location.href), options) };
}

test('isolated reader projects only fresh canonical HTTP metadata and keeps the session on Instagram', async () => {
  const r = reader();
  const post = await r.read();
  assert.equal(post.caption, 'Описание\n🙂');
  assert.equal(post.items.length, 1);
  assert.doesNotMatch(JSON.stringify(post), /tracking_token|never-project/);
  assert.deepEqual(r.calls.map(call => call.url), [url]);
  assert.equal(r.calls[0].init.credentials, 'include');
  assert.equal(r.calls[0].init.cache, 'no-store');
  assert.equal(r.calls[0].init.redirect, 'error');
  assert.deepEqual(r.calls[0].init.headers, { Accept: 'text/html' });
});

test('only a missing full HTTP node permits one bound API GET fallback', async () => {
  const r = reader({ fetcher: async target => response(target,
    target === url ? html(null) : JSON.stringify({ items: [photo()] })) });
  assert.equal((await r.read()).id, '66');
  assert.deepEqual(r.calls.map(call => call.url), [url, 'https://www.instagram.com/api/v1/media/66/info/']);
  assert.deepEqual(r.calls[1].init.headers, { 'x-ig-app-id': '936619743392459' });
  assert.doesNotMatch(JSON.stringify(r.calls), /csrf|cookie|authorization/i);
});

test('HTTP auth, rate limit and unavailable responses retain explicit errors without fallback', async t => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [429, 'RATE_LIMITED'], [404, 'UNAVAILABLE']]) {
    await t.test(String(status), async () => {
      const r = reader({ fetcher: async target => response(target, '', { status }) });
      await assert.rejects(r.read(), { code }); assert.equal(r.calls.length, 1);
    });
  }
});

test('foreign or changed selected sources and redirected responses cannot supply metadata', async () => {
  const r = reader();
  await assert.rejects(r.api.read({ shortcode: 'ABC', href: 'https://attacker.invalid/p/ABC/' }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(r.api.read(schema.source('https://www.instagram.com/p/ABD/')), { code: 'SOURCE_MISMATCH' });
  assert.equal(r.calls.length, 0);
  for (const finalURL of ['https://attacker.invalid/p/ABC/', 'https://www.instagram.com/p/ABD/']) {
    const changed = reader({ fetcher: async () => response(finalURL, html(photo())) });
    await assert.rejects(changed.read(), { code: 'SOURCE_MISMATCH' });
  }
});

test('late HTTP responses after SPA navigation fail the selected-source binding', async () => {
  let complete;
  const r = reader({ fetcher: () => new Promise(resolve => { complete = resolve; }) });
  const loading = r.read(); r.location.pathname = '/p/ABD/';
  complete(response(url, html(photo())));
  await assert.rejects(loading, { code: 'SOURCE_MISMATCH' });
});

test('cancelled reads allow a new source immediately and suppress the old completion', async () => {
  let complete;
  const r = reader({ fetcher: target => target === url ? new Promise(resolve => { complete = resolve; })
    : response(target, html({ ...photo(), code: 'ABD', pk: '67' })) });
  const controller = new AbortController();
  const first = r.read({ signal: controller.signal });
  controller.abort(); r.location.pathname = '/p/ABD/';
  assert.equal((await r.read()).shortcode, 'ABD');
  complete(response(url, html(photo())));
  await assert.rejects(first, { name: 'AbortError' });
});

test('abort cancels a stalled response stream and a subsequent read remains usable', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('<html>')); },
    cancel() { cancelled = true; } });
  const r = reader({ fetcher: async target => response(target, stream) });
  const controller = new AbortController(), loading = r.read({ signal: controller.signal });
  await new Promise(setImmediate); controller.abort();
  await assert.rejects(loading, { name: 'AbortError' }); assert.equal(cancelled, true);
});

test('declared and streamed HTML body limits are enforced and rejected streams are cancelled', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const stream = new ReadableStream({ start(controller) {
      if (!declared) controller.enqueue(new Uint8Array(readerAPI.MAX_HTML_BYTES + 1));
    }, cancel() { cancelled = true; } });
    const r = reader({ fetcher: async target => response(target, stream, declared
      ? { headers: { 'content-length': String(readerAPI.MAX_HTML_BYTES + 1) } } : {}) });
    await assert.rejects(r.read(), { code: 'RESPONSE_TOO_LARGE' });
    assert.equal(cancelled, true);
  }
});

test('compressed-size headers do not replace the decoded byte limit or require false length parity', async () => {
  const r = reader({ fetcher: async target => response(target, html(photo()),
    { headers: { 'content-length': '1', 'content-encoding': 'gzip' } }) });
  assert.equal((await r.read()).id, '66');
});

test('a broken transfer never produces success or an API retry', async () => {
  const r = reader({ fetcher: async target => response(target, new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(html(photo()))); controller.error(new Error('network truncated'));
  } })) });
  await assert.rejects(r.read(), { code: 'UNAVAILABLE' }); assert.equal(r.calls.length, 1);
});

test('API JSON body uses its smaller limit and fallback calls are rate bounded', async () => {
  const r = reader({ fetcher: async target => target === url ? response(target, html(null))
    : response(target, '{}', { headers: { 'content-length': String(schema.MAX_RESPONSE_BYTES + 1) } }) });
  await assert.rejects(r.read(), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(r.read(), { code: 'RATE_LIMITED' });
  assert.equal(r.calls.length, 3);
});

test('reader timeout aborts I/O, reports TIMEOUT and clears its timer', async () => {
  let timeout, cleared = false;
  const r = reader({ setTimeout(fn) { timeout = fn; return 1; }, clearTimeout() { cleared = true; },
    fetcher: (target, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }) });
  const loading = r.read(); timeout();
  await assert.rejects(loading, { code: 'TIMEOUT' }); assert.equal(cleared, true);
});

test('fresh legacy GraphQL and anonymous shadow/full representations retain all supported media', async () => {
  const graph = reader({ payload: { id: '66', shortcode: 'ABC', __typename: 'GraphImage',
    display_url: 'https://scontent.cdninstagram.com/photo.jpg', dimensions: { width: 1080, height: 1350 } } });
  assert.equal((await graph.read()).items[0].type, 'photo');
  const full = { ...photo(), __typename: 'XIGPolarisVideoMedia', id: 'POLARIS_66', media_type: 2,
    original_width: 720, original_height: 1280, has_audio: true,
    video_versions: [{ type: 101, url: 'https://video.xx.fbcdn.net/anonymous.mp4' }] };
  const r = reader({ payload: { full, shadow: { code: 'ABC', pk: '66', media_type: 2 } } });
  assert.deepEqual((await r.read()).items[0].videoVersions, [
    { url: 'https://video.xx.fbcdn.net/anonymous.mp4', width: 0, height: 0 }]);
  assert.equal(r.calls.length, 1);
});

test('rejected full HTTP nodes remain fail-closed unless another complete selected representation validates', async () => {
  const invalid = { ...photo(), image_versions2: { candidates: [
    { url: 'https://attacker.invalid/image.jpg', width: 1080, height: 1350 }] } };
  const failed = reader({ payload: invalid });
  await assert.rejects(failed.read(), { code: 'INVALID_RESPONSE' }); assert.equal(failed.calls.length, 1);
  const good = reader({ payload: { complete: photo(), invalid } });
  assert.equal((await good.read()).id, '66'); assert.equal(good.calls.length, 1);
});

test('incomplete HTTP carousel children never become an apparent cover-only success', async () => {
  const r = reader({ payload: { ...photo(), media_type: 8, carousel_media_count: 2,
    carousel_media: [{ ...photo(), code: undefined, pk: '67' }, { pk: '68', media_type: 2 }] } });
  await assert.rejects(r.read(), { code: 'INVALID_RESPONSE' }); assert.equal(r.calls.length, 1);
});

test('Gecko stream cleanup wrappers cannot override a successful read or AbortError', async () => {
  for (const aborted of [false, true]) {
    let finishRead, sent = false;
    const wrapped = { get catch() { throw new Error('Permission denied to access property catch'); } };
    const body = { getReader() { return {
      read() {
        if (aborted) return new Promise(resolve => { finishRead = resolve; });
        if (sent) return Promise.resolve({ done: true });
        sent = true; return Promise.resolve({ done: false, value: new TextEncoder().encode(html(photo())) });
      },
      cancel() { finishRead?.({ done: true }); return wrapped; }, releaseLock() {},
    }; } };
    const r = reader({ fetcher: async target => ({ url: target, status: 200, redirected: false,
      headers: new Headers(), body }) });
    const controller = new AbortController(), loading = r.read({ signal: controller.signal });
    if (aborted) {
      await new Promise(setImmediate); controller.abort(); await assert.rejects(loading, { name: 'AbortError' });
    } else assert.equal((await loading).id, '66');
  }
});

test('anonymous HTTP metadata explicitly negotiates HTML and preserves the complete mixed carousel', async () => {
  const image = id => ({ pk: id, media_type: 1,
    image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/anonymous.jpg' }] } });
  const video = id => ({ pk: id, media_type: 2, has_audio: true,
    video_versions: [{ type: 101, url: 'https://video.xx.fbcdn.net/anonymous.mp4' }] });
  const full = { ...photo(), media_type: 8, carousel_media_count: 4,
    carousel_media: [image('67'), video('68'), video('69'), image('70')] };
  const r = reader({ fetcher: async (target, init) => {
    if (target !== url) throw new TypeError('NetworkError when attempting to fetch resource');
    return response(target, html(init.headers?.Accept === 'text/html' ? full : null));
  } });
  const post = await r.read();
  assert.deepEqual(post.items.map(item => [item.id, item.type]),
    [['67', 'photo'], ['68', 'video'], ['69', 'video'], ['70', 'photo']]);
  assert.equal(r.calls.length, 1, 'complete negotiated HTML does not need an anonymous API request');
});

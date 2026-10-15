const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const schema = require('../extension/instagram_source.js');

const url = 'https://www.instagram.com/p/ABC/';
const photo = () => ({ code: 'ABC', pk: '66', media_type: 1, user: { username: 'fixture' },
  caption: { text: 'Описание\n🙂' }, image_versions2: { candidates: [
    { url: 'https://scontent.cdninstagram.com/image.jpg', width: 1080, height: 1350 },
  ] }, tracking_token: 'never-project-this' });
function bridge({ payload = photo(), fetcher } = {}) {
  const listeners = [], received = [], requests = [];
  const location = new URL(url);
  const window = { addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    postMessage(message) { received.push(structuredClone(message)); } };
  const context = vm.createContext({ window, location, URL, TextEncoder, TextDecoder, AbortController,
    setTimeout, clearTimeout, Date, console, MendoInstagramSource: schema,
    document: { scripts: payload ? [{ type: 'application/json', textContent: JSON.stringify({ require: [payload] }) }] : [], cookie: '' },
    fetch: async (target, options) => { requests.push(String(target)); return fetcher ? fetcher(target, options)
      : new Response('{}', { status: 401 }); } });
  if (fs.existsSync('extension/instagram_bridge.js')) vm.runInContext(fs.readFileSync('extension/instagram_bridge.js', 'utf8'), context);
  const request = (changes = {}, source = window, origin = location.origin) => listeners.forEach(fn => fn({
    source, origin, data: { __mendosave_ig_request: true, kind: 'request', requestId: 'menu_1', sourceHref: url, ...changes },
  }));
  return { window, location, received, requests, request, document: context.document,
    async settle() { for (let i = 0; i < 12; i++) await new Promise(setImmediate); } };
}
test('Instagram bridge projects the selected embedded publication without another request or private fields', async () => {
  const b = bridge(); b.request(); await b.settle();
  assert.equal(b.received.length, 1);
  assert.equal(b.received[0].post.shortcode, 'ABC');
  assert.equal(b.received[0].post.items.length, 1);
  assert.equal(b.received[0].post.caption, 'Описание\n🙂');
  assert.equal(b.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(b.received), /tracking_token|never-project/);
});
test('Instagram bridge refuses foreign senders and a different publication before reading the session', async () => {
  const b = bridge({ payload: null });
  b.request({}, {}); b.request({}, b.window, 'https://attacker.invalid');
  b.request({ sourceHref: 'https://www.instagram.com/p/ABD/' });
  b.request({ sourceHref: url + '?tracking=1' });
  await b.settle(); assert.equal(b.requests.length, 0); assert.equal(b.received.length, 0);
});
test('Instagram bridge fallback reads only the bound publication and classifies expired login', async () => {
  const b = bridge({ payload: null }); b.request(); await b.settle();
  assert.deepEqual(b.requests, ['https://www.instagram.com/api/v1/media/66/info/']);
  assert.equal(b.received[0].code, 'AUTH_REQUIRED');
});
test('Instagram bridge drops a late response after navigation to another publication', async () => {
  let complete;
  const b = bridge({ payload: null, fetcher: () => new Promise(resolve => { complete = resolve; }) });
  b.request(); await b.settle(); b.location.pathname = '/p/ABD/';
  complete(new Response(JSON.stringify({ items: [photo()] })));
  await b.settle(); assert.equal(b.received.length, 0);
});
test('Instagram bridge rejects excessive response bytes and 429 with explicit bounded errors', async t => {
  for (const [name, response, code] of [
    ['rate', new Response('{}', { status: 429 }), 'RATE_LIMITED'],
    ['oversize', new Response('{}', { headers: { 'content-length': String(schema.MAX_RESPONSE_BYTES + 1) } }), 'RESPONSE_TOO_LARGE'],
  ]) await t.test(name, async () => {
    const b = bridge({ payload: null, fetcher: async () => response }); b.request(); await b.settle();
    assert.equal(b.received[0].code, code);
  });
});

test('navigation cancellation frees the bridge immediately and late old results cannot overwrite the new post', async () => {
  let completeOld, oldSignal;
  const b = bridge({ payload: null, fetcher: (target, options) => {
    oldSignal = options.signal;
    return new Promise(resolve => { completeOld = resolve; });
  } });
  b.request(); await b.settle();
  b.location.pathname = '/p/ABD/';
  const cancel = { kind: 'cancel' };
  b.request(cancel, {}, b.location.origin);
  b.request(cancel, b.window, 'https://attacker.invalid');
  b.request({ ...cancel, sourceHref: 'https://www.instagram.com/p/ABD/' });
  assert.equal(oldSignal.aborted, false, 'cancel requires matching sender, origin and original source');
  b.request(cancel);
  assert.equal(oldSignal.aborted, true, 'old-source cancel remains valid after navigation');
  b.document.scripts = [{ type: 'application/json', textContent: JSON.stringify({
    ...photo(), code: 'ABD', pk: '67', caption: { text: 'New post' },
  }) }];
  b.request({ requestId: 'menu_2', sourceHref: b.location.href });
  await b.settle();
  assert.equal(b.received.length, 1);
  assert.equal(b.received[0].post.shortcode, 'ABD');
  completeOld(new Response(JSON.stringify({ items: [photo()] })));
  await b.settle();
  assert.equal(b.received.length, 1, 'late cancelled response is suppressed');
});

test('embedded legacy GraphQL media uses its matching normalization envelope without a network fallback', async () => {
  const b = bridge({ payload: { id: '66', shortcode: 'ABC', __typename: 'GraphImage',
    display_url: 'https://scontent.cdninstagram.com/photo.jpg', dimensions: { width: 1080, height: 1350 } } });
  b.request(); await b.settle();
  assert.equal(b.requests.length, 0);
  assert.equal(b.received[0].post?.items[0].type, 'photo');
  assert.equal(b.received[0].post?.shortcode, 'ABC');
});

test('anonymous embedded scanning skips a source-less shadow and reads the complete same-post video', async () => {
  const full = { ...photo(), __typename: 'XIGPolarisVideoMedia', id: 'POLARIS_66', media_type: 2,
    original_width: 720, original_height: 1280, has_audio: true,
    video_versions: [{ type: 101, url: 'https://video.xx.fbcdn.net/anonymous.mp4' }] };
  const shadow = { code: 'ABC', pk: '66', media_type: 2, __typename: 'XIGPolarisVideoMedia' };
  // The reader's bounded depth-first traversal encounters shadow first.
  const b = bridge({ payload: { full, shadow } }); b.request(); await b.settle();
  assert.equal(b.requests.length, 0);
  assert.equal(b.received[0].post?.items[0].type, 'video');
  assert.deepEqual(b.received[0].post.items[0].videoVersions, [
    { url: 'https://video.xx.fbcdn.net/anonymous.mp4', width: 0, height: 0 }]);
});

test('invalid full embedded media stays fail-closed unless a complete same-source alternative validates', async () => {
  const invalid = { ...photo(), image_versions2: { candidates: [
    { url: 'https://attacker.invalid/image.jpg', width: 1080, height: 1350 }] } };
  const fail = bridge({ payload: invalid }); fail.request(); await fail.settle();
  assert.equal(fail.received[0].code, 'INVALID_RESPONSE');
  assert.equal(fail.requests.length, 0);
  const recover = bridge({ payload: { complete: photo(), invalid } }); recover.request(); await recover.settle();
  assert.equal(recover.received[0].post?.items.length, 1);
  assert.equal(recover.received[0].post?.id, '66');
  assert.equal(recover.requests.length, 0);
  const mismatch = bridge({ payload: { other: { ...photo(), code: 'ABD', pk: '67' }, invalid } });
  mismatch.request(); await mismatch.settle();
  assert.equal(mismatch.received[0].code, 'INVALID_RESPONSE');
  assert.equal(mismatch.requests.length, 0);
});

test('incomplete carousel children never become an apparent cover-only success during embedded scanning', async () => {
  const b = bridge({ payload: { ...photo(), media_type: 8, carousel_media_count: 2,
    carousel_media: [{ ...photo(), code: undefined, pk: '67' }, { pk: '68', media_type: 2 }] } });
  b.request(); await b.settle();
  assert.equal(b.received[0].code, 'INVALID_RESPONSE');
  assert.equal(b.received[0].post, undefined);
  assert.equal(b.requests.length, 0);
});

test('a matching source-less shadow alone still allows the bound API fallback', async () => {
  const b = bridge({ payload: { code: 'ABC', pk: '66', media_type: 2 } });
  b.request(); await b.settle();
  assert.deepEqual(b.requests, ['https://www.instagram.com/api/v1/media/66/info/']);
  assert.equal(b.received[0].code, 'AUTH_REQUIRED');
});

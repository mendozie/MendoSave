const test = require('node:test');
const assert = require('node:assert/strict');
const instagram = require('../extension/instagram_source.js');
const expected = { shortcode: 'BA', href: 'https://www.instagram.com/p/BA/' };
const image = (id = '64') => ({ pk: id, media_type: 1, image_versions2: { candidates:
  [{ url: 'https://scontent.cdninstagram.com/photo.jpg', width: 1080, height: 1350 }] } });
const photoPost = () => ({ ...image(), code: 'BA', user: { username: 'synthetic_author' },
  caption: { text: 'Author description\nSecond line' } });
const video = (id = '66') => ({ pk: id, media_type: 2, has_audio: true,
  image_versions2: { candidates: [] }, video_versions: [
    { url: 'https://video.xx.fbcdn.net/video.mp4', width: 720, height: 1280 }],
  video_dash_manifest: '<MPD>synthetic bounded manifest</MPD>' });

test('Instagram post source canonicalizes the selected permalink and rejects unrelated routes', () => {
  assert.deepEqual(instagram.source('https://www.instagram.com/reel/BA/?igsh=ignored#fragment'),
    { shortcode: 'BA', href: 'https://www.instagram.com/p/BA/' });
  for (const url of ['http://www.instagram.com/p/BA/', 'https://instagram.com/p/BA/',
    'https://www.instagram.com.evil.test/p/BA/', 'https://user@www.instagram.com/p/BA/',
    'https://www.instagram.com:444/p/BA/', 'https://www.instagram.com/stories/BA/',
    'https://www.instagram.com/p/BA/extra', 'https://www.instagram.com/p/%42A/']) {
    assert.equal(instagram.source(url), null, url);
  }
});

test('whole mixed carousel preserves child IDs, order, video choices and DASH metadata', () => {
  const root = { ...photoPost(), media_type: 8, carousel_media: [image('65'), video('66')] };
  const result = instagram.normalize({ items: [root] }, expected);
  assert.deepEqual(result.items.map(item => [item.id, item.index, item.type]),
    [['65', 0, 'photo'], ['66', 1, 'video']]);
  assert.deepEqual(result.items[1], { id: '66', index: 1, type: 'video', imageVersions: [],
    videoVersions: [{ url: 'https://video.xx.fbcdn.net/video.mp4', width: 720, height: 1280 }],
    dashManifest: '<MPD>synthetic bounded manifest</MPD>', hasAudio: true });
  assert.deepEqual(instagram.projection(result, expected), result);
  assert.equal(instagram.normalize({ items: [{ ...video('64'), code: 'BA' }] }, expected).items[0].type, 'video');
  for (const children of [[], [image('65'), { pk: '66', media_type: 99 }], [image('65'), image('65')]]) {
    assert.throws(() => instagram.normalize({ items: [{ ...root, carousel_media: children }] }, expected),
      { code: 'INVALID_RESPONSE' });
  }
});

test('API photos project only bounded media, author and caption tied to the selected source', () => {
  const payload = { items: [photoPost()] };
  const result = instagram.normalize(payload, expected);
  assert.deepEqual(result, { shortcode: 'BA', id: '64', username: 'synthetic_author',
    caption: 'Author description\nSecond line', items: [{ id: '64', index: 0, type: 'photo',
      imageVersions: [{ url: 'https://scontent.cdninstagram.com/photo.jpg', width: 1080, height: 1350 }],
      videoVersions: [], dashManifest: '', hasAudio: null }] });
  assert.deepEqual(instagram.projection(result, expected), result);
  assert.deepEqual(instagram.normalize({ data: { xdt_api__v1__media__shortcode__web_info: payload } }, expected), result);
  assert.equal(instagram.same(expected, instagram.source('https://www.instagram.com/reels/BA/')), true);
});

test('media URLs stay on HTTPS Instagram CDN subdomains with no URL authority ambiguity', () => {
  for (const url of ['https://scontent.cdninstagram.com/image.jpg?fixture=synthetic',
    'https://video.xx.fbcdn.net/video.mp4']) assert.equal(instagram.mediaUrl(url), true, url);
  for (const url of ['http://scontent.cdninstagram.com/a', 'https://cdninstagram.com/a',
    'https://fbcdn.net/a', 'https://cdninstagram.com.evil.test/a', 'https://localhost/a',
    'https://user@scontent.cdninstagram.com/a', 'https://scontent.cdninstagram.com:8443/a',
    'https://scontent.cdninstagram.com/a#fragment', 'https://scontent.cdninstagram.com./a',
    'https://127.0.0.1/a', `https://scontent.cdninstagram.com/${'x'.repeat(8192)}`]) {
    assert.equal(instagram.mediaUrl(url), false, url.slice(0, 100));
  }
});

test('GraphQL single media and ordered sidecars normalize to the same public contract', () => {
  const node = { id: '65', __typename: 'GraphImage', display_resources: [
    { src: 'https://scontent.cdninstagram.com/photo.jpg', config_width: 1080, config_height: 1350 }] };
  const clip = { id: '66', __typename: 'GraphVideo', is_video: true, video_url:
    'https://video.xx.fbcdn.net/video.mp4', dimensions: { width: 720, height: 1280 } };
  const root = { id: '64', shortcode: 'BA', __typename: 'GraphSidecar',
    owner: { username: 'author' }, edge_media_to_caption: { edges: [{ node: { text: 'Post caption' } }] },
    edge_sidecar_to_children: { edges: [{ node }, { node: clip }] } };
  const result = instagram.normalize({ data: { shortcode_media: root } }, expected);
  assert.equal(result.username, 'author');
  assert.equal(result.caption, 'Post caption');
  assert.deepEqual(result.items.map(item => [item.id, item.type]), [['65', 'photo'], ['66', 'video']]);
  assert.deepEqual(result.items[1].videoVersions, [
    { url: 'https://video.xx.fbcdn.net/video.mp4', width: 720, height: 1280 }]);
  assert.deepEqual(instagram.normalize({ data: { xdt_shortcode_media: root } }, expected), result);
  const single = instagram.normalize({ graphql: { shortcode_media: { ...node, id: '64', shortcode: 'BA' } } }, expected);
  assert.equal(single.items.length, 1);
  assert.equal(single.items[0].type, 'photo');
});

test('API errors retain explicit machine codes without exposing server text', () => {
  for (const [payload, code] of [[{ status: 'fail', message: 'login_required' }, 'AUTH_REQUIRED'],
    [{ status: 'fail', message: 'challenge_required' }, 'AUTH_REQUIRED'],
    [{ status: 'fail', message: 'Please wait a few minutes before you try again.' }, 'RATE_LIMITED'],
    [{ status: 'fail', error_type: 'rate_limit_error' }, 'RATE_LIMITED'],
    [{ status: 'fail', message: 'Media not found or unavailable' }, 'UNAVAILABLE'],
    [{ data: { shortcode_media: null } }, 'UNAVAILABLE'],
    [{ items: [] }, 'UNAVAILABLE'], [{ data: {} }, 'INVALID_RESPONSE']]) {
    assert.throws(() => instagram.normalize(payload, expected), error => error.code === code
      && !error.message.includes('login_required'));
  }
  assert.equal(instagram.error('RATE_LIMITED').code, 'RATE_LIMITED');
  assert.equal(instagram.error('unknown').code, 'INVALID_RESPONSE');
});

test('response and projection resource budgets reject oversized untrusted metadata', () => {
  const oversized = { items: [photoPost()], ignored: 'x'.repeat(instagram.MAX_RESPONSE_BYTES) };
  assert.throws(() => instagram.normalize(oversized, expected), { code: 'RESPONSE_TOO_LARGE' });
  assert.throws(() => instagram.normalize({ items: [{ ...photoPost(),
    caption: { text: 'x'.repeat(65537) } }] }, expected), { code: 'RESPONSE_TOO_LARGE' });
  assert.throws(() => instagram.normalize({ items: [{ ...photoPost(), media_type: 8,
    carousel_media: Array.from({ length: 21 }, (_, index) => image(String(100 + index))) }] }, expected),
  { code: 'RESPONSE_TOO_LARGE' });
  const result = instagram.normalize({ items: [photoPost()] }, expected);
  result.ignored = 'x'.repeat(instagram.MAX_PROJECTION_BYTES);
  assert.throws(() => instagram.projection(result, expected), { code: 'RESPONSE_TOO_LARGE' });
});

test('response identity accepts code-only posts and numeric pk but rejects contradictory or missing identity', () => {
  const onlyCode = photoPost();
  delete onlyCode.pk;
  assert.equal(instagram.normalize({ items: [onlyCode] }, expected).id, '64');
  const onlyPk = photoPost();
  delete onlyPk.code;
  assert.equal(instagram.normalize({ items: [onlyPk] }, expected).id, '64');
  assert.equal(instagram.normalize({ items: [{ ...photoPost(), id: '64_12345' }] }, expected).id, '64');
  for (const root of [{ ...photoPost(), code: 'BB' }, { ...photoPost(), pk: '65' }]) {
    assert.throws(() => instagram.normalize({ items: [root] }, expected), { code: 'SOURCE_MISMATCH' });
  }
  for (const root of [image(undefined), { ...photoPost(), pk: Number.MAX_SAFE_INTEGER + 1 }]) {
    if (root.code === undefined) delete root.pk;
    assert.throws(() => instagram.normalize({ items: [root] }, expected), { code: 'INVALID_RESPONSE' });
  }
});

test('strict URL parsing rejects explicit default ports and parser-normalized whitespace or backslashes', () => {
  for (const url of ['https://www.instagram.com:443/p/BA/', ' https://www.instagram.com/p/BA/',
    'https://www.instagram.com/p/BA/\n', 'https://www.instagram.com\\p\\BA\\']) {
    assert.equal(instagram.source(url), null, url);
  }
  for (const url of ['https://video.xx.fbcdn.net:443/video.mp4', ' https://video.xx.fbcdn.net/video.mp4',
    'https://video.xx.fbcdn.net\\video.mp4', 'https://video.xx.fbcdn.net/video.mp4\n']) {
    assert.equal(instagram.mediaUrl(url), false, url);
  }
});

test('declared carousel completeness cannot silently become a cover-only or partial download', () => {
  for (const root of [{ ...photoPost(), carousel_media: [image('65')] },
    { ...photoPost(), media_type: 8, carousel_media_count: 3, carousel_media: [image('65'), image('66')] }]) {
    assert.throws(() => instagram.normalize({ items: [root] }, expected), { code: 'INVALID_RESPONSE' });
  }
  const result = instagram.normalize({ items: [{ ...photoPost(), media_type: 8,
    carousel_media_count: 2, carousel_media: [image('65'), image('66')] }] }, expected);
  assert.equal(result.items.length, 2);
});

test('projection revalidation rejects forged schemas, missing files and unsafe variants', () => {
  const original = instagram.normalize({ items: [photoPost()] }, expected);
  const bad = change => {
    const value = structuredClone(original);
    change(value);
    assert.throws(() => instagram.projection(value, expected), { code: 'INVALID_RESPONSE' });
  };
  bad(value => { value.items[0].imageVersions = []; });
  bad(value => { value.items[0].imageVersions[0].url = 'https://localhost/private'; });
  bad(value => { value.items[0].imageVersions[0].width = 0; });
  bad(value => { value.items[0].imageVersions[0].height = '1350'; });
  bad(value => { value.items[0].type = 'other'; });
  bad(value => { value.items[0].index = 1; });
  bad(value => { value.items[0].id = 'NaN'; });
  bad(value => { value.items[0].hasAudio = 'true'; });
  bad(value => { value.caption = { text: 'untrusted object' }; });
  bad(value => { value.username = null; });
  const mismatch = structuredClone(original);
  mismatch.shortcode = 'BB';
  assert.throws(() => instagram.projection(mismatch, expected), { code: 'SOURCE_MISMATCH' });
});

test('known shortcode identity and suffixed API id normalize without precision loss', () => {
  const source = instagram.source('https://www.instagram.com/reel/DecDOjeM5K8/');
  const value = instagram.normalize({ items: [{ ...video('4007091962752766652'),
    code: 'DecDOjeM5K8', id: '4007091962752766652_7976930970', carousel_media: null,
    carousel_media_count: null }] }, source);
  assert.equal(value.id, '4007091962752766652');
});

test('unknown GraphQL children cannot masquerade as photos through is_video false', () => {
  const root = { id: '64', shortcode: 'BA', __typename: 'GraphSidecar',
    edge_sidecar_to_children: { edges: [{ node: { id: '65', __typename: 'UnsupportedMedia',
      is_video: false, display_url: 'https://scontent.cdninstagram.com/photo.jpg',
      dimensions: { width: 1080, height: 1350 } } }] } };
  assert.throws(() => instagram.normalize({ data: { shortcode_media: root } }, expected),
    { code: 'INVALID_RESPONSE' });
});

test('structured-cloned sparse arrays cannot skip a carousel child or a media variant', () => {
  const value = instagram.normalize({ items: [photoPost()] }, expected);
  const missingChild = structuredClone(value);
  missingChild.items = new Array(1);
  assert.throws(() => instagram.projection(missingChild, expected), { code: 'INVALID_RESPONSE' });
  value.items[0].imageVersions = new Array(1);
  assert.throws(() => instagram.projection(value, expected), { code: 'INVALID_RESPONSE' });
});

test('profile-grid post and Reel permalinks bind to the same canonical selected publication', () => {
  assert.deepEqual(instagram.source('https://www.instagram.com/healthberry_brest/p/DTVqKjZDCf5/'),
    { shortcode: 'DTVqKjZDCf5', href: 'https://www.instagram.com/p/DTVqKjZDCf5/' });
  assert.deepEqual(instagram.source('https://www.instagram.com/healthberry_brest/reel/DecDOjeM5K8/'),
    { shortcode: 'DecDOjeM5K8', href: 'https://www.instagram.com/p/DecDOjeM5K8/' });
  assert.equal(instagram.same(instagram.source('https://www.instagram.com/profile.name/reels/BA/'), expected), true);
  for (const route of ['one/two/p/BA/', 'bad%5Fname/p/BA/', '.invalid/p/BA/', 'invalid./p/BA/',
    'bad..name/p/BA/', 'bad-name/p/BA/', `${'x'.repeat(31)}/p/BA/`, 'profile.name/p/BA/extra']) {
    assert.equal(instagram.source('https://www.instagram.com/' + route), null, route);
  }
});

test('anonymous progressive variants preserve unknown dimensions without borrowing the original size', () => {
  for (const dimensions of [{}, { width: null, height: null }]) {
    const root = { ...video('64'), code: 'BA', __typename: 'XIGPolarisVideoMedia', id: 'POLARIS_64',
      original_width: 720, original_height: 1280,
      video_versions: [{ type: 101, url: 'https://video.xx.fbcdn.net/anonymous.mp4', ...dimensions }] };
    const result = instagram.normalize({ items: [root] }, expected);
    assert.deepEqual(result.items[0].videoVersions, [
      { url: 'https://video.xx.fbcdn.net/anonymous.mp4', width: 0, height: 0 }]);
    assert.deepEqual(instagram.projection(result, expected), result);
  }
});

test('unknown sizing does not weaken malformed dimension validation', () => {
  for (const dimensions of [{ width: 720 }, { height: 1280 }, { width: null, height: 1280 },
    { width: -1, height: -1 }, { width: 0, height: 0 }, { width: '720', height: '1280' }]) {
    assert.throws(() => instagram.normalize({ items: [{ ...video('64'), code: 'BA', video_versions: [
      { url: 'https://video.xx.fbcdn.net/anonymous.mp4', ...dimensions }] }] }, expected), { code: 'INVALID_RESPONSE' });
  }
  for (const dimensions of [{ width: 1080 }, { width: null, height: 1350 }, { width: 0, height: 0 }]) {
    assert.throws(() => instagram.normalize({ items: [{ ...photoPost(), image_versions2: { candidates: [
      { url: 'https://scontent.cdninstagram.com/photo.jpg', ...dimensions }] } }] }, expected), { code: 'INVALID_RESPONSE' });
  }
  const projected = instagram.normalize({ items: [{ ...video('64'), code: 'BA', video_versions: [
    { url: 'https://video.xx.fbcdn.net/anonymous.mp4' }] }] }, expected);
  projected.items[0].videoVersions[0].height = 1280;
  assert.throws(() => instagram.projection(projected, expected), { code: 'INVALID_RESPONSE' });
});

test('anonymous photo variants preserve unknown dimensions without borrowing child original dimensions', () => {
  for (const dimensions of [{}, { width: null, height: null }]) {
    const result = instagram.normalize({ items: [{ ...photoPost(), original_width: 864, original_height: 1100,
      image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/anonymous.jpg', ...dimensions }] } }] }, expected);
    assert.deepEqual(result.items[0].imageVersions, [
      { url: 'https://scontent.cdninstagram.com/anonymous.jpg', width: 0, height: 0 }]);
    assert.deepEqual(instagram.projection(result, expected), result);
  }
});

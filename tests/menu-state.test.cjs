const assert = require('node:assert/strict');
const { test } = require('node:test');
const { adapter } = require('./tiktok-adapter-harness.cjs');

function capturePicker(app) {
  app.context.MendoPackageUI.add = (menu, spec) => {
    app.picker = spec;
    const opener = app.document.createElement('button'); opener.className = 'mendo-package-open'; menu.append(opener);
    return opener;
  };
}

function fixture(site) {
  let app;
  if (site === 'coub') app = adapter('coub.js', '<div data-permalink="or1i6abuay"><div class="viewer"></div></div>',
    'https://coub.com/view/or1i6abuay', async () => ({ ok: true, json: async () => require('./fixtures/coub-item.json').payload }));
  if (site === 'rutube') app = adapter('rutube.js', '<div class="player"><video></video></div>',
    'https://rutube.ru/video/5295f2a858cdace0855c40f8a48f4676/', async url => url.includes('/api/play/options/')
      ? { ok: true, json: async () => ({ title: 'Fixture', duration: 1000, video_balancer: { m3u8: 'https://media.invalid/master.m3u8' } }) }
      : { ok: true, text: async () => '#EXTM3U\n' + [144, 360, 720, 1080].map(height => `#EXT-X-STREAM-INF:BANDWIDTH=${height * 1000},RESOLUTION=1920x${height}\n${height}.m3u8\n`).join('') });
  if (site === 'twitch') app = adapter('twitch_ui.js', '<video></video><div class="player-controls__right-control-group"></div>',
    'https://clips.twitch.tv/OriginalClip', async () => ({ ok: true, json: async () => ({ data: { clip: {
      title: 'Fixture', videoQualities: [360, 480, 720, 1080].map(quality => ({ quality: String(quality), sourceURL: `https://media.invalid/${quality}.mp4` })),
    } } }) }));
  if (site === 'vk') app = adapter('vk.js', '<div class="VideoPlayer__player"><video></video></div>',
    'https://vkvideo.ru/video-1_2', async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      arrayBuffer: async () => new TextEncoder().encode(`<script>${JSON.stringify({ response: { items: [{ owner_id: -1, id: 2, title: 'Fixture', duration: 19,
        files: Object.fromEntries([360, 480, 720, 1080].map(height => [`mp4_${height}`, `https://media.invalid/${height}.mp4`])),
      }] } })}</script>`).buffer }));
  if (site === 'tiktok') {
    const item = require('./fixtures/tiktok-item.json').item;
    app = adapter('tiktok.js', `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: item } } } })}</script><article><div id="xgwrapper-0-${item.id}"></div><div class="SectionActionBarContainer"><a data-e2e="video-author-avatar" href="/@scout2015"></a></div></article>`,
      `https://www.tiktok.com/@scout2015/video/${item.id}`, () => { throw Error('Unexpected fetch'); });
  }
  capturePicker(app);
  const selectors = { coub: '.mendosave-coub-btn', rutube: '#mendosave-rutube-btn', twitch: '#mendosave-twitch-record', vk: '.mendosave-vk-btn', tiktok: '.mendosave-tiktok-btn' };
  return { app, trigger: () => app.document.querySelector(selectors[site]), menu: () => app.document.querySelector('.mendo-menu') };
}

for (const site of ['coub', 'rutube', 'twitch', 'vk', 'tiktok']) {
  test(`${site} retains expanded qualities and scroll through package Back and ordinary close/reopen`, async () => {
    const { app, trigger, menu } = fixture(site);
    app.click(trigger()); await app.settle();
    app.click(menu().querySelector('.mendo-menu-more'));
    menu().scrollTop = 173;
    const reads = app.requests.length, picker = app.picker;
    picker.close(); await picker.back();
    assert.equal(menu().querySelector('.mendo-menu-more').getAttribute('aria-expanded'), 'true', 'Back retains expanded qualities');
    assert.equal(menu().scrollTop, 173, 'Back retains the scrolled position');
    app.click(menu().querySelector('.mendo-menu-close'));
    app.click(trigger()); await app.settle();
    assert.equal(app.requests.length, reads, 'ordinary reopen does not read metadata again');
    assert.equal(menu().querySelector('.mendo-menu-more').getAttribute('aria-expanded'), 'true');
    assert.equal(menu().scrollTop, 173);
    assert.equal(app.messages.some(message => /mendosave-(?:save|begin|live-begin)$/.test(message.t)), false);
  });
}

test('Zvuk ordinary close/reopen reuses track metadata and retains menu position', async () => {
  const app = adapter('zvuk.js', '<div class="ContentItem_wrapper"><a href="/track/123">Track</a><div class="Controls_controls"><span>3:00</span></div></div>',
    'https://zvuk.com/track/123', async (_url, options) => ({ ok: true, json: async () => ({ data: { getTracks: JSON.parse(options.body).variables.ids.map(id => ({ id, title: 'Fixture', duration: 180 })) } }) }));
  const trigger = app.document.querySelector('.mendosave-zvuk-btn');
  app.click(trigger); await app.settle();
  const original = app.document.querySelector('.mendo-menu');
  assert.match(original.textContent, /Fixture/);
  original.scrollTop = 173; app.click(original.querySelector('.mendo-menu-close'));
  app.click(trigger); await app.settle();
  assert.equal(app.requests.length, 1, 'metadata for the same track list is reused');
  assert.equal(app.document.querySelector('.mendo-menu').scrollTop, 173);
  assert.equal(app.messages.some(message => /mendosave-save$/.test(message.t)), false);
});

test('an actual Coub menu refits after viewport resize and repeated opens do not add window listeners', async () => {
  const { app, trigger, menu } = fixture('coub');
  const view = app.document.defaultView;
  let resizeListeners = 0;
  const add = view.addEventListener.bind(view);
  view.addEventListener = (type, ...args) => { if (type === 'resize') resizeListeners++; return add(type, ...args); };
  app.click(trigger()); await app.settle();
  menu().style.left = '440px'; menu().style.top = '407px';
  menu().getBoundingClientRect = () => ({ left: Number.parseFloat(menu().style.left), top: Number.parseFloat(menu().style.top),
    width: Math.min(320, view.innerWidth - 16), height: Math.min(559, view.innerHeight - 16) });
  view.innerWidth = 306; view.innerHeight = 775;
  view.dispatchEvent(new view.Event('resize'));
  assert.equal(menu().style.left, '8px');
  assert.equal(menu().style.top, '208px');
  app.click(menu().querySelector('.mendo-menu-close')); app.click(trigger()); await app.settle();
  assert.equal(resizeListeners, 1, 'shared refit installs one listener per document rather than per menu');
});

test('Coub invalidates metadata and presentation after an observed source transition and failed save', async () => {
  const { app, trigger, menu } = fixture('coub');
  app.click(trigger()); await app.settle();
  app.click(menu().querySelector('.mendo-menu-more')); menu().scrollTop = 173;
  app.click(menu().querySelector('.mendo-menu-close'));
  const original = app.context.location.href;
  app.context.location.href = 'https://coub.com/view/another';
  app.document.dispatchEvent(new app.context.window.Event('visibilitychange'));
  app.context.location.href = original;
  app.document.dispatchEvent(new app.context.window.Event('visibilitychange'));
  app.click(trigger()); await app.settle();
  assert.equal(app.requests.length, 2, 'visiting another source drops the previous metadata even after returning');
  assert.equal(menu().querySelector('.mendo-menu-more').getAttribute('aria-expanded'), 'false');
  const picker = app.picker;
  picker.close(); app.context.MendoPackageUI.running = true;
  const send = app.context.chrome.runtime.sendMessage;
  app.context.chrome.runtime.sendMessage = message => message.t === 'mendosave-save' ? { ok: false, error: 'expired source' } : send(message);
  await assert.rejects(picker.options.find(option => option.id.includes('-video-')).run(), /expired source/);
  app.context.MendoPackageUI.running = false;
  app.click(trigger()); await app.settle();
  assert.equal(app.requests.length, 3, 'a failed media save cannot leave expired metadata in the cache');
});

test('Coub reused player ownership invalidates the cached source even without a URL change', async () => {
  const { app, trigger, menu } = fixture('coub');
  app.click(trigger()); await app.settle(); app.click(menu().querySelector('.mendo-menu-close'));
  const owner = app.document.querySelector('[data-permalink]');
  owner.dataset.permalink = 'replacement'; app.document.dispatchEvent(new app.context.window.Event('visibilitychange'));
  owner.dataset.permalink = 'or1i6abuay'; app.document.dispatchEvent(new app.context.window.Event('visibilitychange'));
  app.click(trigger()); await app.settle();
  assert.equal(app.requests.length, 2);
});

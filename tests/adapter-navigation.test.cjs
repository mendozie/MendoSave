const assert = require('node:assert/strict');
const { test } = require('node:test');
const { adapter } = require('./tiktok-adapter-harness.cjs');

function capturePicker(app) {
  app.context.MendoPackageUI.add = (menu, spec) => {
    app.picker = spec;
    const opener = app.document.createElement('button');
    opener.className = 'mendo-package-open';
    menu.append(opener);
    return opener;
  };
}

test('Coub standalone controls share arrows, Home/End and restore the live trigger on Escape', async () => {
  const payload = require('./fixtures/coub-item.json').payload;
  const app = adapter('coub.js', '<div data-permalink="or1i6abuay"><div class="viewer"></div></div>',
    'https://coub.com/view/or1i6abuay', async () => ({ ok: true, json: async () => payload }));
  app.context.MendoMenu = require('../extension/menu.js');
  capturePicker(app);
  const trigger = app.document.querySelector('.mendosave-coub-btn');
  let focused;
  trigger.focus = () => { focused = trigger; };
  app.click(trigger); await app.settle();
  const menu = app.document.querySelector('.mendosave-coub-menu');
  const controls = [...menu.querySelectorAll('[role=menuitem]')];
  for (const control of controls) control.focus = () => { focused = control; };
  app.press(controls[0], 'End'); assert.equal(focused === controls.at(-1), true, 'End focuses package opener');
  app.press(focused, 'Home'); assert.equal(focused === controls[0], true, 'Home focuses first variant');
  app.press(focused, 'ArrowDown'); assert.equal(focused === controls[1], true, 'ArrowDown focuses next variant');
  app.press(focused, 'Escape');
  assert.equal(app.document.querySelector('.mendosave-coub-menu'), null);
  assert.equal(focused === trigger, true, 'Escape restores the source trigger');
});

test('Coub Back reloads the current source, returns a live opener and starts no download', async () => {
  const original = require('./fixtures/coub-item.json').payload;
  const app = adapter('coub.js', '<div data-permalink="or1i6abuay"><div class="viewer"></div></div>',
    'https://coub.com/view/or1i6abuay', async url => ({ ok: true, json: async () => ({ ...original,
      permalink: url.split('/').at(-1), title: 'Same title' }) }));
  capturePicker(app);
  app.click(app.document.querySelector('.mendosave-coub-btn'));
  await app.settle();
  const oldPicker = app.picker;
  oldPicker.close();
  app.context.location.href = 'https://coub.com/view/newsource';
  app.document.querySelector('[data-permalink]').setAttribute('data-permalink', 'newsource');
  const focused = await oldPicker.back();
  assert.equal(app.picker.source, 'coub:newsource');
  assert.equal(focused.isConnected, true);
  assert.equal(focused.className, 'mendo-package-open');
  assert.equal(app.messages.some(m => m.t === 'mendosave-save' || m.t === 'mendosave-ensure'), false);
  assert.notEqual(app.picker, oldPicker);
});

test('Rutube Back fetches the current SPA video instead of the old package source', async () => {
  const app = adapter('rutube.js', '<div class="player"><video></video></div>',
    'https://rutube.ru/video/5295f2a858cdace0855c40f8a48f4676/', async url => {
      if (url.includes('/api/play/options/')) return { ok: true, json: async () => ({
        title: 'Same title', duration: 1000, video_balancer: { m3u8: 'https://media.invalid/master.m3u8' } }) };
      return { ok: true, text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=256x144\n144.m3u8\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=640x360\n360.m3u8\n' };
    });
  capturePicker(app);
  app.click(app.document.querySelector('#mendosave-rutube-btn'));
  await app.settle();
  const oldPicker = app.picker;
  oldPicker.close();
  app.context.location.href = 'https://rutube.ru/video/11111111111111111111111111111111/';
  const focused = await oldPicker.back();
  assert.equal(app.picker.source, 'rutube:11111111111111111111111111111111');
  assert.equal(focused.isConnected, true);
  assert.equal(app.requests.some(r => r.url.includes('/api/play/options/11111111111111111111111111111111')), true);
  assert.equal(app.messages.some(m => m.t === 'mendosave-ensure'), false);
});

test('Twitch Back re-detects and loads a current clip before restoring the menu', async () => {
  const app = adapter('twitch_ui.js', '<video></video><div class="player-controls__right-control-group"></div>',
    'https://clips.twitch.tv/OriginalClip', async () => ({ ok: true, json: async () => ({ data: { clip: {
      title: 'Same title', videoQualities: [
        { quality: '360', sourceURL: 'https://media.invalid/a.mp4' },
        { quality: '720', sourceURL: 'https://media.invalid/b.mp4' },
      ] } } }) }));
  capturePicker(app);
  app.click(app.document.querySelector('#mendosave-twitch-record'));
  await app.settle();
  const oldPicker = app.picker;
  oldPicker.close();
  app.context.location.href = 'https://clips.twitch.tv/NewClip';
  const focused = await oldPicker.back();
  assert.equal(app.picker.source, 'twitch:clip:NewClip');
  assert.equal(focused.isConnected, true);
  assert.equal(app.messages.some(m => m.t === 'mendosave-save'), false);
});

test('TikTok Back rebuilds the reused rail entry from the current video rather than its old closure', async () => {
  const original = require('./fixtures/tiktok-item.json').item;
  const page = item => JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': {
    statusCode: 0, itemInfo: { itemStruct: item },
  } } });
  const app = adapter('tiktok.js', `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${page(original)}</script>
    <article><div id="xgwrapper-0-${original.id}"></div><div class="SectionActionBarContainer">
    <a data-e2e="video-author-avatar" href="/@scout2015"></a></div></article>`,
  `https://www.tiktok.com/@scout2015/video/${original.id}`, () => { throw Error('Unexpected fetch'); });
  capturePicker(app);
  app.click(app.document.querySelector('.mendosave-tiktok-btn'));
  await app.settle();
  const oldPicker = app.picker;
  oldPicker.close();
  const next = { ...original, id: '9999999999999999999' };
  app.context.location.href = `https://www.tiktok.com/@scout2015/video/${next.id}`;
  app.document.querySelector('[id^="xgwrapper-"]').id = `xgwrapper-0-${next.id}`;
  app.document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__').textContent = page(next);
  const focused = await oldPicker.back();
  assert.equal(app.picker.source, `tiktok:${next.id}`);
  assert.equal(focused.isConnected, true);
  assert.equal(app.messages.some(m => m.t === 'mendosave-save'), false);
});

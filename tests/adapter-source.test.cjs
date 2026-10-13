const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { adapter } = require(path.resolve('tests/tiktok-adapter-harness.cjs'));
function capturePicker(app) {
  app.context.MendoPackageUI.add = (menu, spec) => {
    app.picker = spec;
    const opener = app.document.createElement('button'); opener.className = 'mendo-package-open'; menu.append(opener); return opener;
  };
}
test('review Coub: late Back source B must not append its choices to a newer source C menu', async () => {
  const original = require(path.resolve('tests/fixtures/coub-item.json')).payload;
  let releaseB;
  const pendingB = new Promise(resolve => { releaseB = resolve; });
  const response = id => ({ ok: true, json: async () => ({ ...original, permalink: id, title: 'Same title' }) });
  const app = adapter('coub.js', '<div data-permalink="sourceA"><div class="viewer"></div></div>', 'https://coub.com/view/sourceA',
    url => url.endsWith('/sourceB') ? pendingB : response(url.split('/').at(-1)));
  capturePicker(app);
  const trigger = app.document.querySelector('.mendosave-coub-btn'); app.click(trigger); await app.settle();
  const old = app.picker; old.close();
  app.context.location.href = 'https://coub.com/view/sourceB'; app.document.querySelector('[data-permalink]').setAttribute('data-permalink', 'sourceB');
  const back = old.back(); await app.settle();
  app.press(app.document.querySelector('.mendosave-coub-menu'), 'Escape');
  app.context.location.href = 'https://coub.com/view/sourceC'; app.document.querySelector('[data-permalink]').setAttribute('data-permalink', 'sourceC');
  app.click(trigger); await app.settle(); assert.equal(app.picker.source, 'coub:sourceC');
  releaseB(response('sourceB')); await back; await app.settle();
  assert.equal(app.picker.source, 'coub:sourceC', 'a superseded Back cannot publish source B into C');
  assert.equal(app.document.querySelectorAll('.mendo-package-open').length, 1);
});
test('review Twitch: Back from clip to current live page must not start or stop recording', async () => {
  const reply = { ok: true, json: async () => ({ data: { clip: { title: 'Clip', videoQualities: [
    { quality: '360', sourceURL: 'https://media.invalid/a.mp4' }, { quality: '720', sourceURL: 'https://media.invalid/b.mp4' },
  ] } } }) };
  const app = adapter('twitch_ui.js', '<video></video><div class="player-controls__right-control-group"></div>',
    'https://www.twitch.tv/scout/clip/OriginalClip', async () => reply);
  capturePicker(app);
  const trigger = app.document.querySelector('#mendosave-twitch-record'); app.click(trigger); await app.settle();
  const old = app.picker; old.close();
  const media = app.document.querySelector('video'); media.readyState = 2;
  let captures = 0; media.captureStream = () => { captures++; throw new Error('Review stops before actual recording'); };
  app.context.location.href = 'https://www.twitch.tv/scout';
  await old.back(); await app.settle();
  assert.equal(captures, 0, 'Back is navigation, not an activation of the live Record control');
});
test('review Twitch: Back source metadata that resolves after SPA C must not reopen source B', async () => {
  const response = () => ({ ok: true, json: async () => ({ data: { clip: { title: 'Same title', videoQualities: [
    { quality: '360', sourceURL: 'https://media.invalid/a.mp4' }, { quality: '720', sourceURL: 'https://media.invalid/b.mp4' },
  ] } } }) });
  let releaseB, calls = 0;
  const pendingB = new Promise(resolve => { releaseB = resolve; });
  const app = adapter('twitch_ui.js', '<video></video><div class="player-controls__right-control-group"></div>',
    'https://www.twitch.tv/scout/clip/OriginalClip', () => ++calls === 2 ? pendingB : response());
  capturePicker(app);
  app.click(app.document.querySelector('#mendosave-twitch-record')); await app.settle();
  const old = app.picker; old.close(); app.context.location.href = 'https://www.twitch.tv/scout/clip/SourceB';
  const back = old.back(); await app.settle(); app.context.location.href = 'https://www.twitch.tv/scout/clip/SourceC';
  releaseB(response()); await back; await app.settle();
  assert.notEqual(app.picker.source, 'twitch:clip:SourceB', 'late B metadata cannot reopen an obsolete source');
});
test('review Rutube: Back source B must not offer files after the URL advances to source C', async () => {
  let releaseB;
  const pendingB = new Promise(resolve => { releaseB = resolve; });
  const response = () => ({ ok: true, json: async () => ({ title: 'Same title', duration: 1000,
    video_balancer: { m3u8: 'https://media.invalid/master.m3u8' } }) });
  const sourceA = '5295f2a858cdace0855c40f8a48f4676', sourceB = '11111111111111111111111111111111', sourceC = '22222222222222222222222222222222';
  const app = adapter('rutube.js', '<div class="player"><video></video></div>', `https://rutube.ru/video/${sourceA}/`, url => {
    if (url.includes(`/api/play/options/${sourceB}`)) return pendingB;
    if (url.includes('/api/play/options/')) return response();
    return { ok: true, text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=256x144\n144.m3u8\n'
      + '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=640x360\n360.m3u8\n' };
  });
  capturePicker(app); app.click(app.document.querySelector('#mendosave-rutube-btn')); await app.settle();
  const old = app.picker; old.close(); app.context.location.href = `https://rutube.ru/video/${sourceB}/`;
  const back = old.back(); await app.settle(); app.context.location.href = `https://rutube.ru/video/${sourceC}/`;
  releaseB(response()); await back; await app.settle();
  assert.notEqual(app.picker.source, `rutube:${sourceB}`, 'the current connected menu still must validate source identity');
});
test('review TikTok: late Back source B must not append its choices to a newer source C menu', async () => {
  const original = require(path.resolve('tests/fixtures/tiktok-item.json')).item;
  const sourceB = '8888888888888888888', sourceC = '9999999999999999999';
  const page = item => JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: item } } } });
  let releaseB;
  const pendingB = new Promise(resolve => { releaseB = resolve; });
  const app = adapter('tiktok.js', `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${page(original)}</script>
    <article><div id="xgwrapper-0-${original.id}"></div><div class="SectionActionBarContainer"><a data-e2e="video-author-avatar" href="/@scout2015"></a></div></article>`,
    `https://www.tiktok.com/@scout2015/video/${original.id}`, () => pendingB);
  capturePicker(app); const trigger = app.document.querySelector('.mendosave-tiktok-btn'); app.click(trigger); await app.settle();
  const old = app.picker; old.close();
  app.context.location.href = `https://www.tiktok.com/@scout2015/video/${sourceB}`; app.document.querySelector('[id^="xgwrapper-"]').id = `xgwrapper-0-${sourceB}`;
  const back = old.back(); await app.settle(); app.press(app.document.querySelector('.mendosave-tiktok-menu'), 'Escape');
  app.context.location.href = `https://www.tiktok.com/@scout2015/video/${sourceC}`; app.document.querySelector('[id^="xgwrapper-"]').id = `xgwrapper-0-${sourceC}`;
  app.document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__').textContent = page({ ...original, id: sourceC });
  await old.back(); await app.settle(); assert.equal(app.picker.source, `tiktok:${sourceC}`);
  releaseB({ ok: true, text: async () => `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${page({ ...original, id: sourceB })}</script>` });
  await back; await app.settle();
  assert.equal(app.picker.source, `tiktok:${sourceC}`, 'a superseded Back cannot publish B into C');
  assert.equal(app.document.querySelectorAll('.mendo-package-open').length, 1);
});
test('review Rutube: unchanged selected quality survives insertion of a new higher quality on reentry', async () => {
  let masters = 0;
  const oldMaster = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=256x144\n144.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=640x360\n360.m3u8\n';
  const app = adapter('rutube.js', '<div class="player"><video></video></div>',
    'https://rutube.ru/video/5295f2a858cdace0855c40f8a48f4676/', url => {
      if (url.includes('/api/play/options/')) return { ok: true, json: async () => ({
        title: 'Same title', duration: 1000, video_balancer: { m3u8: 'https://media.invalid/master.m3u8' } }) };
      return { ok: true, text: async () => ++masters === 1 ? oldMaster
        : oldMaster + '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=1280x720\n720.m3u8\n' };
    });
  app.context.MendoPackageUI = require(path.resolve('extension/package_ui.js')).create({ document: app.document,
    runtime: app.context.chrome.runtime, fetch: app.context.fetch, queue: require(path.resolve('extension/package_queue.js')) });
  app.click(app.document.querySelector('#mendosave-rutube-btn')); await app.settle();
  app.click(app.document.querySelector('.mendo-package-open'));
  const selected = [...app.document.querySelectorAll('.mendo-package-list label')].find(label => /360p/.test(label.textContent)).querySelector('input');
  selected.checked = true; selected.dispatchEvent(new app.document.defaultView.Event('change'));
  app.click(app.document.querySelector('[data-action="back"]')); await app.settle();
  app.click(app.document.querySelector('.mendo-package-open'));
  const sameQuality = [...app.document.querySelectorAll('.mendo-package-list label')].find(label => /360p/.test(label.textContent)).querySelector('input');
  assert.equal(sameQuality.checked, true, 'an unchanged compatible format cannot be keyed by its previous list index');
});

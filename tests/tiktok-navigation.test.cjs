const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { adapter } = require(path.resolve('tests/tiktok-adapter-harness.cjs'));
test('TikTok: a reused current rail trigger must open its current source after closing the restored menu', async () => {
  const original = require(path.resolve('tests/fixtures/tiktok-item.json')).item;
  const page = item => JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: item } } } });
  const app = adapter('tiktok.js', `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${page(original)}</script>
    <article><div id="xgwrapper-0-${original.id}"></div><div class="SectionActionBarContainer"><a data-e2e="video-author-avatar" href="/@scout2015"></a></div></article>`,
    `https://www.tiktok.com/@scout2015/video/${original.id}`, () => { throw new Error('Unexpected fetch'); });
  let picker;
  app.context.MendoPackageUI.add = (_menu, spec) => { picker = spec; };
  const trigger = app.document.querySelector('.mendosave-tiktok-btn'); app.click(trigger); await app.settle(); picker.close();
  const next = { ...original, id: '9999999999999999999' };
  app.context.location.href = `https://www.tiktok.com/@scout2015/video/${next.id}`;
  app.document.querySelector('[id^="xgwrapper-"]').id = `xgwrapper-0-${next.id}`;
  app.document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__').textContent = page(next);
  app.click(trigger); await app.settle();
  assert.ok(app.document.querySelector('.mendosave-tiktok-menu'), 'the live reused trigger cannot retain an old entry closure');
  assert.equal(picker.source, `tiktok:${next.id}`);
});
test('TikTok: two same-size gears with nearby bitrates must not inherit each other selection', async () => {
  const original = require(path.resolve('tests/fixtures/tiktok-item.json')).item;
  const first = structuredClone(original.video.bitrateInfo[0]); first.Bitrate = 1000000;
  const second = structuredClone(first); second.Bitrate = 1040000; second.GearName = `${first.GearName}_lower`;
  second.PlayAddr.UrlList = ['https://v16.tiktokcdn.com/review-second'];
  const item = { ...original, video: { ...original.video, bitrateInfo: [first, second] } };
  const page = JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: item } } } });
  const app = adapter('tiktok.js', `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${page}</script>
    <article><div id="xgwrapper-0-${original.id}"></div><div class="SectionActionBarContainer"><a data-e2e="video-author-avatar" href="/@scout2015"></a></div></article>`,
    `https://www.tiktok.com/@scout2015/video/${original.id}`, () => { throw new Error('Unexpected fetch'); });
  app.context.MendoPackageUI = require(path.resolve('extension/package_ui.js')).create({ document: app.document,
    runtime: app.context.chrome.runtime, fetch: app.context.fetch, queue: require(path.resolve('extension/package_queue.js')) });
  app.click(app.document.querySelector('.mendosave-tiktok-btn')); await app.settle(); app.click(app.document.querySelector('.mendo-package-open'));
  const selected = app.document.querySelector('.mendo-package-list input');
  selected.checked = true; selected.dispatchEvent(new app.document.defaultView.Event('change'));
  app.click(app.document.querySelector('[data-action="back"]')); await app.settle(); app.click(app.document.querySelector('.mendo-package-open'));
  const inputs = [...app.document.querySelectorAll('.mendo-package-list input')];
  assert.equal(inputs.filter(input => input.checked).length, 1, 'rounded display labels cannot identify distinct file variants');
});

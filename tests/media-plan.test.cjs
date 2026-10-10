const assert = require('node:assert/strict');
const { test } = require('node:test');

test('a chosen H.264 output is encoded even when SABR delivers the original codec', () => {
  const { processingOptions } = require('../extension/media_plan.js');
  assert.deepEqual(processingOptions({ format: 'mp4', transcode: true, requestedHeight: 240, sourceHeight: 240 }),
    { transcode: true, scaleHeight: 0 });
  assert.deepEqual(processingOptions({ format: 'mp4', transcode: false, requestedHeight: 240, sourceHeight: 240 }),
    { transcode: false, scaleHeight: 0 });
});

test('a higher source is downscaled while a lower source is never silently upscaled', () => {
  const { processingOptions } = require('../extension/media_plan.js');
  assert.deepEqual(processingOptions({ format: 'mp4', requestedHeight: 720, sourceHeight: 1080 }),
    { transcode: true, scaleHeight: 720 });
  assert.deepEqual(processingOptions({ format: 'mp4', requestedHeight: 720, sourceHeight: 240 }),
    { transcode: false, scaleHeight: 0 });
  assert.deepEqual(processingOptions({ format: 'mp3', requestedHeight: 720, sourceHeight: 1080 }),
    { transcode: true, scaleHeight: 0 });
});

test('H.264/AAC keeps source AAC and rejects an Opus-only hardware encoder', async () => {
  const { aacCodec } = require('../extension/media_plan.js');
  assert.equal(await aacCodec('aac', () => { throw new Error('AAC passthrough must not encode'); }), 'aac');
  await assert.rejects(aacCodec('opus', async () => null), /AAC/);
  assert.equal(await aacCodec('opus', async codecs => { assert.deepEqual(codecs, ['aac']); return 'aac'; }), 'aac');
});

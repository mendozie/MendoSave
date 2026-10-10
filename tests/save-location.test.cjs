const assert = require('node:assert/strict');
const { test } = require('node:test');
const { browserContext } = require('./background-harness.cjs');

test('native downloads use the saved picker preference and ignore a page override', async () => {
  const requests = [];
  const browser = browserContext({ downloads: {
    async download(options) { requests.push(options); return requests.length; },
  } });
  const request = { t: 'mendosave-save', url: 'https://example.test/media.mp4', filename: 'video.mp4' };
  assert.equal((await browser.message({ ...request, saveAs: true })).ok, true);
  assert.equal(requests[0].saveAs, false);
  browser.data.nova_settings = { saveAs: true };
  assert.equal((await browser.message({ ...request, saveAs: false })).ok, true);
  assert.equal(requests[1].saveAs, true);
  assert.equal(requests[1].conflictAction, 'uniquify');
  browser.data.nova_settings = { saveAs: 'true' };
  assert.equal((await browser.message(request)).ok, true);
  assert.equal(requests[2].saveAs, false);
});

test('cancelling the native picker returns a cancellation without another download or network fallback', async () => {
  let attempts = 0;
  const browser = browserContext({ downloads: {
    async download() { attempts++; throw new Error('Download canceled by the user'); },
  } });
  browser.data.nova_settings = { saveAs: true };
  const response = await browser.message({ t: 'mendosave-save',
    url: 'https://example.test/media.mp4', filename: 'video.mp4' });
  assert.equal(response.ok, false);
  assert.equal(response.cancelled, true);
  assert.equal(attempts, 1);
  assert.deepEqual(browser.network, []);
  assert.equal(Object.keys(browser.data).some((key) => key.startsWith('mendo_download_owner:')), false);
});

test('a native download failure remains an error and a foreign sender cannot trigger a picker', async () => {
  let attempts = 0;
  const browser = browserContext({ downloads: {
    async download() { attempts++; throw new Error('FILE_ACCESS_DENIED'); },
  } });
  browser.data.nova_settings = { saveAs: true };
  const request = { t: 'mendosave-save', url: 'https://example.test/media.mp4', filename: 'video.mp4' };
  const response = await browser.message(request);
  assert.equal(response.ok, false);
  assert.equal(response.error, 'FILE_ACCESS_DENIED');
  assert.equal(response.cancelled, undefined);
  assert.equal((await browser.message(request, { id: 'other-extension' })).ok, false);
  assert.equal(attempts, 1);
});

test('Chromium user cancellation errors are also terminal user actions', async () => {
  let attempts = 0;
  const browser = browserContext({ downloads: {
    async download() { attempts++; throw new Error('USER_CANCELED'); },
  } });
  const response = await browser.message({ t: 'mendosave-save',
    url: 'blob:moz-extension://test/output', filename: 'audio.mp3' },
  browser.processorSender());
  assert.equal(response.ok, false);
  assert.equal(response.cancelled, true);
  assert.equal(attempts, 1);
  assert.deepEqual(browser.network, []);
  assert.equal(Object.keys(browser.data).some((key) => key.startsWith('mendo_download_owner:')), false);
});

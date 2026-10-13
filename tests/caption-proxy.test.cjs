const assert = require('node:assert/strict');
const { test } = require('node:test');
const { browserContext } = require('./background-harness.cjs');

const originalUrl = 'https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=en';
const foreignUrl = 'https://www.youtube.com/api/timedtext?v=SBN-oBhn5rE&lang=en';

test('caption proxy preserves the final response URL so the caller can verify a redirect owner', async () => {
  const text = '{"events":[{"tStartMs":1000,"segs":[{"utf8":"Caption"}]}]}';
  const browser = browserContext({ fetch: async () => ({ ok: true, status: 200, url: foreignUrl, text: async () => text }) });
  const result = await browser.message({ t: 'mendosave-fetch-caption', url: originalUrl });
  assert.equal(result.ok, true);
  assert.equal(result.url, foreignUrl);
  assert.equal(result.text, text);
});

test('caption proxy keeps successful text, status and original source URL without changing caption bytes', async () => {
  const text = ' A <literal> &amp;\nРусская реплика 🙂 ';
  const browser = browserContext({ fetch: async (url, options) => {
    assert.equal(url, originalUrl);
    assert.equal(options.credentials, 'include');
    return { ok: true, status: 200, url: originalUrl, text: async () => text };
  } });
  const result = await browser.message({ t: 'mendosave-fetch-caption', url: originalUrl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.url, originalUrl);
  assert.equal(result.text, text);
  assert.equal(result.len, text.length);
});

test('caption proxy still rejects an unavailable sender or URL before performing network I/O', async () => {
  const browser = browserContext({ fetch: async () => { throw new Error('must not fetch rejected input'); } });
  assert.equal((await browser.message({ t: 'mendosave-fetch-caption', url: originalUrl },
    { id: 'foreign-extension', tab: { id: 7, url: 'https://www.youtube.com/watch?v=fixture' } })).ok, false);
  for (const url of ['https://example.test/api/timedtext?v=fixture', 'http://www.youtube.com/api/timedtext?v=fixture',
    'https://www.youtube.com/watch?v=fixture']) assert.equal((await browser.message({ t: 'mendosave-fetch-caption', url })).ok, false);
  assert.deepEqual(browser.network, []);
});

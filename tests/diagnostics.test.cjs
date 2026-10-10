const assert = require('node:assert/strict');
const { test } = require('node:test');
const { browserContext } = require('./background-harness.cjs');

test('page-relayed diagnostics reject oversized fields and leave settings and recovery writable', async () => {
  const browser = browserContext();
  for (const fields of [{ tag: 'x'.repeat(129), text: 'short' },
    { tag: 'network', text: 'x'.repeat(65_537) }, { tag: {}, text: 'x' }, { tag: 'network', text: {} }]) {
    const result = await browser.message({ t: 'mendosave-log', ...fields });
    assert.equal(result.ok, false);
  }
  assert.equal(browser.data.nova_logs, undefined);
  const result = await browser.message({ t: 'mendosave-log', tag: 'network', text: 'normal log' });
  assert.equal(result.ok, true);
  await browser.chrome.storage.local.set({ nova_settings: { ask: true }, nova_recovered: [] });
  assert.equal(browser.data.nova_settings.ask, true);
  assert.equal(browser.data.nova_logs[0].tag, 'network');
});

test('a new diagnostic write bounds oversized entries left by an older version', async () => {
  const browser = browserContext();
  browser.data.nova_logs = [{ ts: 1, tag: 'a'.repeat(200), text: 'b'.repeat(5000) }];
  assert.equal((await browser.message({ t: 'mendosave-log', tag: 'new', text: 'small' })).ok, true);
  assert.ok(browser.data.nova_logs.every((entry) => entry.tag.length <= 128 && entry.text.length <= 4000));
});

test('blocked diagnostic storage cannot accumulate an unlimited pending write queue', async () => {
  const browser = browserContext();
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  browser.chrome.storage.local.set = async (values) => { await gate; Object.assign(browser.data, values); };
  const pending = Array.from({ length: 32 }, (_, index) => browser.message({ t: 'mendosave-log', tag: 'network', text: `entry ${index}` }));
  // On the vulnerable implementation this request is retained behind the
  // blocked write. A bounded queue responds immediately with a refusal.
  const result = await Promise.race([
    browser.message({ t: 'mendosave-log', tag: 'network', text: 'overflow' }),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 50)),
  ]);
  unblock();
  await Promise.all(pending);
  assert.equal(result.ok, false);
  assert.equal(result.timeout, undefined);
  assert.equal((await browser.message({ t: 'mendosave-log', tag: 'network', text: 'resumed' })).ok, true);
});

test('a diagnostic export removes credentials and signed links from every report section', async () => {
  const browser = browserContext();
  let report = '';
  browser.chrome.storage.local.get = async (keys) => Object.fromEntries(
    (Array.isArray(keys) ? keys : [keys]).map((key) => [key, browser.data[key]]));
  browser.data.nova_logs = [{ ts: 1, tag: 'fetch', text: 'https://cdn.example/video?sig=journal-secret' }];
  browser.data.nvs_playlist_queue = { url: 'https://example.org/watch?token=queue-secret', cookie: 'queue-cookie' };
  browser.chrome.tabs.create = async () => ({ id: 19 });
  browser.chrome.runtime.sendMessage = async (message) => {
    if (message.t === 'mendosave-host-probe') return { ok: true, instanceId: message.instanceId };
    assert.equal(message.t, 'mendosave-save-text');
    report = message.text;
    return { ok: true, id: 42 };
  };
  const result = await browser.message({ t: 'mendosave-error', context: 'fetch',
    error: 'Authorization: Bearer bearer-secret\nCookie: SID=cookie-secret\nhttps://user:password-secret@cdn.example/file?sig=error-secret#fragment-secret',
    details: { access_token: 'detail-secret', path: 'C:\\Users\\alice\\Downloads\\private.mp4' },
  }, { id: browser.chrome.runtime.id, tab: { id: 7, url: 'https://www.youtube.com/watch?v=id&token=page-secret#page-fragment' } });
  assert.equal(result.ok, true);
  for (const secret of ['journal-secret', 'queue-secret', 'queue-cookie', 'bearer-secret', 'cookie-secret', 'password-secret', 'error-secret', 'fragment-secret', 'detail-secret', 'alice', 'page-secret', 'page-fragment']) {
    assert.equal(report.includes(secret), false, `leaked ${secret}`);
  }
  assert.ok(report.includes('cdn.example'));
  assert.ok(report.includes('Version:'));
});

test('diagnostic storage removes secrets before writing a log entry', async () => {
  const browser = browserContext();
  const result = await browser.message({ t: 'mendosave-log', tag: 'network',
    text: 'https://cdn.example/secret/path?sig=private-token Authorization: Bearer private-bearer' });
  assert.equal(result.ok, true);
  assert.equal(browser.data.nova_logs.length, 1);
  assert.equal(browser.data.nova_logs[0].text.includes('private-'), false);
  assert.equal(browser.data.nova_logs[0].text.includes('/secret/path'), false);
});

test('diagnostics hide complete quoted and unquoted private paths with spaces', async () => {
  const { sanitize } = require('../extension/diagnostics.js');
  const paths = [
    ['C:', 'Users', 'Jane Doe', 'Downloads', 'private.mp4'].join('\\'),
    ['', '', 'server', 'Jane Doe', 'private.mp4'].join('\\'),
    ['', 'home', 'Jane Doe', 'private.mp4'].join('/'),
    ['C:', 'Users', "O'Neil Doe", 'Downloads', 'private.mp4'].join('\\'),
    ['', '', 'server', "O'Neil Doe", 'private.mp4'].join('\\'),
    ['', 'home', "O'Neil Doe", 'private.mp4'].join('/'),
  ];
  for (const path of paths) {
    assert.equal(sanitize({ path }).includes('Doe'), false);
    const browser = browserContext();
    await browser.message({ t: 'mendosave-log', tag: 'error', text: `failed at "${path}"` });
    assert.equal(browser.data.nova_logs[0].text.includes('Doe'), false);
  }
});

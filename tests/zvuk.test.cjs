const assert = require('node:assert/strict');
const { test } = require('node:test');
const { adapter } = require('./tiktok-adapter-harness.cjs');

function track(stream, send) {
  return adapter('zvuk.js', '<div class="ContentItem_wrapper"><a href="/track/123">Track</a><div class="Controls_controls"><span>3:00</span></div></div>', 'https://zvuk.com/track/123', async (_url, options) => {
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ data: body.operationName === 'nvsTracks'
      ? { getTracks: [{ id: '123', title: 'Test track', duration: 180, artistNames: ['Test artist'] }] }
      : { mediaContents: [{ stream }] } }) };
  }, send);
}

async function download(app) {
  app.click(app.document.querySelector('.mendosave-zvuk-btn'));
  await app.settle();
  app.click(app.document.querySelector('[role="button"].mendosave-zvuk-item'));
  await app.settle();
}

test('Zvuk saves an available preview when full-quality fields are absent and identifies it in the filename', async () => {
  const app = track({ high: null, mid: null, preview: 'https://media.invalid/preview.mp3' });
  await download(app);
  const save = app.messages.find((x) => x.t === 'mendosave-save');
  assert.ok(save, 'available preview should be downloadable');
  assert.equal(save.url, 'https://media.invalid/preview.mp3');
  assert.match(save.filename, /фрагмент/);
  assert.match(app.document.querySelector('.mendosave-zvuk-toast').textContent, /фрагмент/);
});

test('Zvuk does not call a preview returned in high a complete track', async () => {
  const url = 'https://media.invalid/preview.mp3';
  const app = track({ high: url, mid: url, preview: url });
  await download(app);
  assert.match(app.messages.find((x) => x.t === 'mendosave-save').filename, /фрагмент/);
});

test('Zvuk leaves an entitled full MP3 unlabelled and waits for browser completion', async () => {
  let polls = 0;
  const app = track({ high: 'https://media.invalid/full.mp3', mid: null, preview: 'https://media.invalid/preview.mp3' }, (message) => {
    if (message.t === 'mendosave-download-state') return { ok: true, state: ++polls === 1 ? 'in_progress' : 'complete', totalBytes: 10, bytesReceived: 5 };
    return { ok: true, id: 7 };
  });
  await download(app);
  assert.equal(app.messages.find((x) => x.t === 'mendosave-save').filename, 'Test artist - Test track.mp3');
  assert.equal(polls, 2);
  assert.match(app.document.querySelector('.mendosave-zvuk-toast').textContent, /Готово:/);
});

test('Zvuk menu activates its selected track once with Enter or Space', async (t) => {
  for (const key of ['Enter', ' ']) await t.test(key === ' ' ? 'Space' : key, async () => {
    const app = track({ high: 'https://media.invalid/full.mp3' });
    app.click(app.document.querySelector('.mendosave-zvuk-btn'));
    await app.settle();
    const item = app.document.querySelector('[role="button"].mendosave-zvuk-item');
    assert.equal(app.press(item, key, true).defaultPrevented, true);
    assert.equal(app.press(item, 'a').defaultPrevented, false);
    assert.equal(app.messages.some((x) => x.t === 'mendosave-save'), false);
    const event = app.press(item, key);
    await app.settle();
    assert.equal(app.messages.filter((x) => x.t === 'mendosave-save').length, 1);
    assert.equal(event.defaultPrevented, true);
    assert.equal(Boolean(app.document.querySelector('.mendosave-zvuk-menu')), false);
  });
});

test('Zvuk Escape closes the menu without saving and releases its key listener', async () => {
  const app = track({ high: 'https://media.invalid/full.mp3' });
  app.click(app.document.querySelector('.mendosave-zvuk-btn'));
  await app.settle();
  const event = app.press(app.document.body, 'Escape');
  assert.equal(Boolean(app.document.querySelector('.mendosave-zvuk-menu')), false);
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.messages.some((x) => x.t === 'mendosave-save'), false);
  assert.equal(app.press(app.document.body, 'Escape').defaultPrevented, false);
});

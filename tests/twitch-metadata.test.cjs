const assert = require('node:assert/strict');
const { test } = require('node:test');
const { adapter } = require('./tiktok-adapter-harness.cjs');

const html = '<video></video><div class="player-controls__right-control-group"></div>';
const href = 'https://www.twitch.tv/twitch/clip/CloudySarcasticSashimiTwitchRPG';
const response = () => ({ ok: true, json: async () => ({ data: { clip: {
  title: 'Clip', videoQualities: [{ quality: '720', sourceURL: 'https://media.invalid/clip.mp4' }],
} } }) });

// Drive the content script through clicks and a deterministic public timer seam.
function clock(app) {
  let now = 0, id = 0;
  const timers = new Map();
  app.context.setTimeout = (fn, delay) => {
    timers.set(++id, { fn, at: now + delay });
    return id;
  };
  app.context.clearTimeout = key => timers.delete(key);
  return async milliseconds => {
    now += milliseconds;
    for (const [key, timer] of [...timers]) {
      if (timer.at <= now && timers.delete(key)) timer.fn();
    }
    await app.settle();
  };
}

test('Twitch metadata that never responds stops loading within 30 seconds and permits retry', async () => {
  let call = 0, pendingSignal;
  const app = adapter('twitch_ui.js', html, href, (_url, options) => {
    if (++call === 1) {
      pendingSignal = options.signal;
      return new Promise(() => {});
    }
    return response();
  });
  const advance = clock(app);
  const trigger = app.document.getElementById('mendosave-twitch-record');
  app.click(trigger);
  await app.settle();
  assert.match(app.document.getElementById('mendosave-twitch-toast').textContent, /читаю данные/);
  await advance(30_000);
  assert.match(app.document.getElementById('mendosave-twitch-toast').textContent, /не ответил|вовремя|время ожидания/);
  assert.equal(pendingSignal?.aborted, true, 'timeout cancels the underlying request');
  app.click(trigger);
  await app.settle();
  assert.equal(app.document.querySelector('.mendosave-twitch-menu-item')?.textContent, '720p');
  assert.equal(app.messages.some(message => /mendosave-(?:save|begin|live-begin)$/.test(message.t)), false);
});

test('Twitch cancels a stalled response body and ignores its late completion after retry', async () => {
  let call = 0, release, pendingSignal;
  const body = new Promise(resolve => { release = resolve; });
  const app = adapter('twitch_ui.js', html, href, (_url, options) => {
    if (++call === 1) {
      pendingSignal = options.signal;
      return { ok: true, json: () => body };
    }
    return response();
  });
  const advance = clock(app);
  const trigger = app.document.getElementById('mendosave-twitch-record');
  app.click(trigger); await app.settle();
  await advance(30_000);
  assert.match(app.document.getElementById('mendosave-twitch-toast').textContent, /не ответил/);
  assert.equal(pendingSignal.aborted, true);
  app.click(trigger); await app.settle();
  release({ data: { clip: { videoQualities: [{ quality: '1080', sourceURL: 'https://media.invalid/old.mp4' }] } } });
  await app.settle();
  assert.deepEqual([...app.document.querySelectorAll('.mendosave-twitch-menu-item')].map(e => e.textContent), ['720p']);
  assert.equal(app.document.getElementById('mendosave-twitch-toast').textContent, '');
});

test('Twitch metadata deadline covers both the VOD playlist request and its response body', async t => {
  for (const stall of ['request', 'body']) await t.test(stall, async () => {
    let masterSignal;
    const app = adapter('twitch_ui.js', html, 'https://www.twitch.tv/videos/551972874', (url, options) => {
      if (url.includes('gql.twitch.tv')) return { ok: true, json: async () => ({ data: {
        videoPlaybackAccessToken: { signature: 'fixture', value: 'fixture' },
      } }) };
      masterSignal = options.signal;
      return stall === 'request' ? new Promise(() => {}) : { ok: true, text: () => new Promise(() => {}) };
    });
    const advance = clock(app);
    app.click(app.document.getElementById('mendosave-twitch-record')); await app.settle();
    await advance(30_000);
    assert.match(app.document.getElementById('mendosave-twitch-toast').textContent, /не ответил/);
    assert.equal(masterSignal.aborted, true);
    assert.equal(app.document.getElementById('mendosave-twitch-menu'), null);
    assert.equal(app.messages.some(message => /mendosave-(?:begin|live-begin)$/.test(message.t)), false);
  });
});

test('Twitch stale metadata timeout clears its loading indicator without publishing an error on the new source', async () => {
  let call = 0;
  const app = adapter('twitch_ui.js', html, href, () => ++call === 1 ? new Promise(() => {}) : response());
  const advance = clock(app);
  const trigger = app.document.getElementById('mendosave-twitch-record');
  app.click(trigger); await app.settle();
  app.context.location.href = 'https://www.twitch.tv/twitch/clip/CurrentClip';
  await advance(30_000);
  assert.equal(app.document.getElementById('mendosave-twitch-toast').classList.contains('show'), false);
  assert.doesNotMatch(app.document.getElementById('mendosave-twitch-toast').textContent, /не ответил/);
  app.click(trigger); await app.settle();
  assert.equal(app.document.querySelector('.mendosave-twitch-menu-item').textContent, '720p');
  assert.match(JSON.parse(app.requests.at(-1).options.body).query, /CurrentClip/);
});

test('Twitch successful metadata completion clears its deadline without cancelling valid formats', async () => {
  const app = adapter('twitch_ui.js', html, href, response);
  const advance = clock(app);
  app.click(app.document.getElementById('mendosave-twitch-record')); await app.settle();
  await advance(30_000);
  assert.equal(app.requests[0].options.signal.aborted, false);
  assert.equal(app.document.querySelector('.mendosave-twitch-menu-item').textContent, '720p');
  assert.equal(app.document.getElementById('mendosave-twitch-toast').textContent, '');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { parseHTML, UserEvent } = require('./user-dom.cjs');
const schema = require('../extension/instagram_source.js');
function app({ onRun, choices = [{ id: 'photo-1', label: 'Фото · 1080×1350', group: 'Фото', compatibilityKey: 'image' }] } = {}) {
  const { document, window: domWindow } = parseHTML('<html><body><article>Publication</article></body></html>');
  const window = { Event: domWindow.Event, addEventListener() {}, removeEventListener() {} };
  const location = new URL('https://www.instagram.com/p/ABC/');
  const messages = [], saved = [], runs = [], listeners = new Set();
  let refresh;
  window.innerWidth = 1280; window.innerHeight = 800;
  const context = vm.createContext({ window, document, location, URL, AbortController, DOMException,
    crypto: require('node:crypto').webcrypto, console,
    setInterval(fn) { refresh = fn; return 1; }, clearInterval() {}, setTimeout, clearTimeout,
    MutationObserver: class { observe() {} },
    chrome: { runtime: {} }, MendoInstagramSource: schema,
    MendoInstagramMedia: { choices: () => choices,
      create: () => ({ async run(post, choice, options) {
        saved.push({ shortcode: post.shortcode, id: choice.id }); runs.push(options);
        return onRun ? onRun(post, choice, options) : 'fixture.jpg';
      } }) },
    MendoPackageUI: { running: false, add(menu) {
      const opener = document.createElement('button'); opener.className = 'mendo-package-open';
      menu.append(opener); return opener;
    } },
  });
  window.addEventListener = (type, fn) => { if (type === 'message') listeners.add(fn); };
  window.removeEventListener = (type, fn) => { if (type === 'message') listeners.delete(fn); };
  window.postMessage = message => messages.push(message);
  for (const file of ['menu.js', 'instagram.js']) if (fs.existsSync('extension/' + file)) vm.runInContext(fs.readFileSync('extension/' + file, 'utf8'), context);
  return { document, window, location, messages, saved, runs, refresh: () => refresh(),
    click(selector, trusted = true) { const e = document.querySelector(selector); assert.ok(e, selector);
      e.dispatchEvent(trusted ? new UserEvent('click', { bubbles: true }) : new window.Event('click', { bubbles: true })); },
    key(selector, key, trusted = true) {
      const target = document.querySelector(selector); assert.ok(target, selector);
      const event = trusted ? new UserEvent('keydown', { bubbles: true, cancelable: true })
        : new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value: key }); target.dispatchEvent(event);
    },
    reply(changes = {}, sender = window, origin = location.origin) {
      const request = messages.filter(m => m.kind === 'request').at(-1);
      const selected = schema.source(request.sourceHref);
      const post = schema.normalize({ items: [{ code: selected.shortcode, pk: selected.shortcode === 'ABD' ? '67' : '66',
        media_type: 1, image_versions2: { candidates: [
        { url: 'https://scontent.cdninstagram.com/image.jpg', width: 1080, height: 1350 },
      ] } }] }, selected);
      for (const fn of [...listeners]) fn({ source: sender, origin, data: {
        __mendosave_ig_result: true, requestId: request.requestId, sourceHref: request.sourceHref, post, ...changes,
      } }); },
    async settle() { for (let i = 0; i < 10; i++) await new Promise(setImmediate); },
  };
}
test('Instagram adds one accessible download control only for the opened publication', async () => {
  const a = app();
  assert.equal(a.document.querySelectorAll('.mendosave-instagram-btn').length, 1);
  assert.equal(a.document.querySelector('.mendosave-instagram-btn').tagName, 'BUTTON');
  a.click('.mendosave-instagram-btn'); await a.settle();
  assert.equal(a.messages.length, 1);
  a.reply(); await a.settle();
  assert.match(a.document.body.textContent, /Фото.*1080/);
  a.click('.mendosave-instagram-item'); await a.settle();
  assert.deepEqual(a.saved, [{ shortcode: 'ABC', id: 'photo-1' }]);
});

test('keyboard cancellation aborts the current download and restores controls for an independent retry', async () => {
  const a = app({ onRun: (post, choice, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }) });
  a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  a.key('.mendosave-instagram-item', 'Enter'); await a.settle();
  assert.equal(a.document.querySelector('.mendosave-instagram-item').disabled, true);
  a.key('.mendosave-instagram-cancel', 'Enter'); await a.settle();
  assert.equal(a.runs[0].signal.aborted, true);
  assert.equal(a.document.querySelector('.mendosave-instagram-item').disabled, false);
  assert.match(a.document.querySelector('.mendosave-instagram-status').textContent, /отменена/);
  a.key('.mendosave-instagram-item', ' '); await a.settle();
  assert.equal(a.runs.length, 2);
  assert.notEqual(a.runs[0].signal, a.runs[1].signal);
  assert.equal(a.runs[1].signal.aborted, false);
  a.key('.mendosave-instagram-cancel', ' '); await a.settle();
});

test('Escape dismisses loading and error menus and late metadata cannot reopen them', async () => {
  const a = app();
  a.click('.mendosave-instagram-btn');
  a.key('.mendosave-instagram-menu', 'Escape'); await a.settle();
  assert.equal(Boolean(a.document.querySelector('.mendosave-instagram-menu')), false);
  assert.equal(a.messages.at(-1).kind, 'cancel');
  a.reply(); await a.settle();
  assert.equal(Boolean(a.document.querySelector('.mendosave-instagram-menu')), false);
  a.click('.mendosave-instagram-btn'); a.reply({ code: 'AUTH_REQUIRED' }); await a.settle();
  assert.match(a.document.querySelector('.mendosave-instagram-status').textContent, /входа/);
  a.key('.mendosave-instagram-menu', 'Escape'); await a.settle();
  assert.equal(Boolean(a.document.querySelector('.mendosave-instagram-menu')), false);
});

test('an empty author description is stated explicitly rather than offered as a transcript', async () => {
  const a = app(); a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  assert.match(a.document.querySelector('.mendosave-instagram-status').textContent, /Описания нет/);
  assert.doesNotMatch(a.document.body.textContent, /расшифровка/i);
});

test('synthetic activation and foreign, stale or unsafe metadata do not authorize a download', async () => {
  const a = app();
  a.click('.mendosave-instagram-btn', false); await a.settle();
  assert.equal(a.messages.length, 0);
  a.click('.mendosave-instagram-btn');
  a.reply({}, {});
  a.reply({}, a.window, 'https://attacker.invalid');
  a.reply({ requestId: 'stale' });
  a.reply({ sourceHref: 'https://www.instagram.com/p/ABD/' });
  await a.settle();
  assert.equal(Boolean(a.document.querySelector('.mendosave-instagram-item')), false);
  a.reply({ post: { shortcode: 'ABC', id: '66', username: '', caption: '', items: [{ id: '66', index: 0,
    type: 'photo', imageVersions: [{ url: 'https://localhost/private', width: 1080, height: 1350 }],
    videoVersions: [], dashManifest: '', hasAudio: null }] } });
  await a.settle();
  assert.match(a.document.querySelector('.mendosave-instagram-status').textContent, /Ошибка/);
  assert.equal(a.saved.length, 0);
  a.key('.mendosave-instagram-menu', 'Escape');
  a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  a.click('.mendosave-instagram-item', false);
  a.key('.mendosave-instagram-item', 'Enter', false); await a.settle();
  assert.equal(a.saved.length, 0);
  a.click('.mendosave-instagram-item'); await a.settle();
  assert.equal(a.saved.length, 1);
});

test('SPA navigation cancels the old metadata request and binds the next menu to the new publication', async () => {
  const a = app(); a.click('.mendosave-instagram-btn');
  const previous = a.messages[0];
  a.location.pathname = '/profile.name/p/ABD/'; a.refresh(); await a.settle();
  assert.deepEqual(structuredClone(a.messages.at(-1)), { __mendosave_ig_request: true, kind: 'cancel',
    requestId: previous.requestId, sourceHref: previous.sourceHref });
  assert.equal(Boolean(a.document.querySelector('.mendosave-instagram-menu')), false);
  a.reply(); await a.settle();
  assert.equal(Boolean(a.document.querySelector('.mendosave-instagram-menu')), false);
  a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  a.click('.mendosave-instagram-item'); await a.settle();
  assert.equal(a.saved[0].shortcode, 'ABD');
  a.location.pathname = '/stories/profile/123/'; a.refresh();
  assert.equal(Boolean(a.document.querySelector('.mendosave-instagram-btn')), false);
});

test('leaving the selected publication aborts its active media operation', async () => {
  const a = app({ onRun: (post, choice, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }) });
  a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  a.click('.mendosave-instagram-item'); await a.settle();
  a.location.pathname = '/p/ABD/'; a.refresh(); await a.settle();
  assert.equal(a.runs[0].signal.aborted, true);
  assert.equal(Boolean(a.document.querySelector('.mendosave-instagram-menu')), false);
});

test('opening the next publication during old cancellation does not leave a stale cancelled menu', async () => {
  const a = app({ onRun: (post, choice, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }) });
  a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  a.click('.mendosave-instagram-item'); await a.settle();
  a.location.pathname = '/p/ABD/'; a.refresh();
  a.click('.mendosave-instagram-btn');
  await a.settle();
  assert.equal(a.messages.filter(message => message.kind === 'request').at(-1).sourceHref,
    'https://www.instagram.com/p/ABD/');
  assert.doesNotMatch(a.document.querySelector('.mendosave-instagram-status').textContent, /Загрузка отменена/);
  a.reply(); await a.settle();
  assert.equal(Boolean(a.document.querySelector('.mendosave-instagram-item')), true);
});

test('reopening a running same-post menu and cancelling restores choices and package controls for retry', async () => {
  const a = app({ choices: [
    { id: 'photo-1', label: 'Фото', group: 'Фото', compatibilityKey: 'image' },
    { id: 'caption', label: 'Описание автора', group: 'Текст', compatibilityKey: 'caption' },
  ], onRun: (post, choice, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }) });
  a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  a.click('.mendosave-instagram-item'); await a.settle();
  assert.equal(a.document.querySelector('.mendo-package-open').disabled, true);
  a.click('.mendosave-instagram-btn'); a.click('.mendosave-instagram-btn');
  a.key('.mendosave-instagram-cancel', 'Enter'); await a.settle();
  assert.equal(a.runs[0].signal.aborted, true);
  assert.equal(a.messages.filter(message => message.kind === 'request').length, 2);
  a.reply(); await a.settle();
  assert.equal(a.document.querySelectorAll('.mendosave-instagram-item').length, 2);
  assert.equal(a.document.querySelector('.mendo-package-open').disabled, false);
  a.key('.mendosave-instagram-item', 'Enter'); await a.settle();
  assert.equal(a.runs.length, 2);
  assert.equal(a.runs[1].signal.aborted, false);
  a.key('.mendosave-instagram-cancel', 'Enter'); await a.settle();
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { parseHTML, UserEvent } = require('./user-dom.cjs');
const schema = require('../extension/instagram_source.js');
function app({ onRun, markup = '<article>Publication</article>', rects = {}, choices = [{ id: 'photo-1', label: 'Фото · 1080×1350', group: 'Фото', compatibilityKey: 'image' }] } = {}) {
  const { document, window: domWindow } = parseHTML(`<html><body>${markup}</body></html>`);
  for (const [selector, box] of Object.entries(rects)) {
    document.querySelector(selector).getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height });
  }
  const window = { Event: domWindow.Event, addEventListener() {}, removeEventListener() {} };
  const location = new URL('https://www.instagram.com/p/ABC/');
  const messages = [], outbound = [], saved = [], runs = [], packageConfigs = [], listeners = new Set();
  let refresh;
  window.innerWidth = 1280; window.innerHeight = 800;
  const context = vm.createContext({ window, document, location, URL, AbortController, DOMException,
    crypto: require('node:crypto').webcrypto, console,
    setInterval(fn) { refresh = fn; return 1; }, clearInterval() {}, setTimeout, clearTimeout,
    MutationObserver: class { observe() {} },
    chrome: { runtime: {} }, MendoInstagramSource: schema,
    MendoInstagramReader: { create: () => ({ read(selected, { signal }) {
      return new Promise((resolve, reject) => {
        let finished = false;
        const request = { kind: 'request', requestId: require('node:crypto').randomUUID(), sourceHref: selected.href, signal };
        const finish = (value, error) => {
          if (finished) return; finished = true;
          signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(value);
        };
        const abort = () => {
          messages.push({ __mendosave_ig_request: true, kind: 'cancel', requestId: request.requestId, sourceHref: request.sourceHref });
          finish(null, new DOMException('Cancelled', 'AbortError'));
        };
        request.resolve = value => finish(value); request.reject = error => finish(null, error);
        signal.addEventListener('abort', abort, { once: true }); messages.push(request);
      });
    } }) },
    MendoInstagramMedia: { choices: () => choices,
      create: () => ({ async run(post, choice, options) {
        saved.push({ shortcode: post.shortcode, id: choice.id }); runs.push(options);
        return onRun ? onRun(post, choice, options) : 'fixture.jpg';
      } }) },
    MendoPackageUI: { running: false, add(menu, config) {
      packageConfigs.push(config);
      const opener = document.createElement('button'); opener.className = 'mendo-package-open';
      menu.append(opener); return opener;
    } },
  });
  window.addEventListener = (type, fn) => { if (type === 'message') listeners.add(fn); };
  window.removeEventListener = (type, fn) => { if (type === 'message') listeners.delete(fn); };
  window.postMessage = message => outbound.push(message);
  for (const file of ['menu.js', 'instagram.js']) if (fs.existsSync('extension/' + file)) vm.runInContext(fs.readFileSync('extension/' + file, 'utf8'), context);
  const forge = (changes = {}, sender = window, origin = location.origin) => {
    const request = messages.filter(m => m.kind === 'request').at(-1);
    for (const fn of [...listeners]) fn({ source: sender, origin, data: { __mendosave_ig_result: true,
      requestId: request.requestId, sourceHref: request.sourceHref, ...changes } });
  };
  return { document, window, location, messages, outbound, saved, runs, packageConfigs, forge, refresh: () => refresh(),
    click(selector, trusted = true) { const e = document.querySelector(selector); assert.ok(e, selector);
      e.dispatchEvent(trusted ? new UserEvent('click', { bubbles: true }) : new window.Event('click', { bubbles: true })); },
    key(selector, key, trusted = true) {
      const target = document.querySelector(selector); assert.ok(target, selector);
      const event = trusted ? new UserEvent('keydown', { bubbles: true, cancelable: true })
        : new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value: key }); target.dispatchEvent(event);
    },
    change(selector, value, trusted = true) {
      const target = document.querySelector(selector); assert.ok(target, selector);
      for (const option of target.querySelectorAll('option')) option.selected = false;
      [...target.querySelectorAll('option')].find(option => option.value === value).selected = true;
      const event = new window.Event('change', { bubbles: true });
      Object.defineProperty(event, 'isTrusted', { value: trusted }); target.dispatchEvent(event);
    },
    reply(changes = {}, sender = window, origin = location.origin) {
      const request = messages.filter(m => m.kind === 'request').at(-1);
      if (sender !== window || origin !== location.origin || changes.requestId || changes.sourceHref) {
        forge(changes, sender, origin); return;
      }
      const selected = schema.source(request.sourceHref);
      const post = schema.normalize({ items: [{ code: selected.shortcode, pk: selected.shortcode === 'ABD' ? '67' : '66',
        media_type: 1, image_versions2: { candidates: [
        { url: 'https://scontent.cdninstagram.com/image.jpg', width: 1080, height: 1350 },
      ] } }] }, selected);
      if (changes.code) request.reject(schema.error(changes.code));
      else request.resolve(changes.post || post);
    },
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

test('Back and reopening reuse the validated publication without another read, but SPA gets a fresh source', async () => {
  const a = app({ choices: [
    { id: 'photo-1', label: 'Фото · 1080×1350', kind: 'photo', itemIndex: 0, group: 'Фото', compatibilityKey: 'image' },
    { id: 'caption', label: 'Описание автора', kind: 'caption', group: 'Текст', compatibilityKey: 'caption' },
  ] });
  a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  assert.equal(a.packageConfigs.length, 1);
  a.packageConfigs[0].close(); const returning = a.packageConfigs[0].back(); await a.settle();
  assert.equal(a.messages.filter(message => message.kind === 'request').length, 1);
  await returning;
  assert.equal(a.document.querySelectorAll('.mendosave-instagram-item').length, 2);
  a.click('.mendosave-instagram-btn'); a.click('.mendosave-instagram-btn'); await a.settle();
  assert.equal(a.messages.filter(message => message.kind === 'request').length, 1);
  a.location.pathname = '/p/ABD/'; a.refresh();
  a.click('.mendosave-instagram-btn'); await a.settle();
  assert.equal(a.messages.filter(message => message.kind === 'request').length, 2);
  a.reply(); await a.settle(); a.click('.mendosave-instagram-item'); await a.settle();
  assert.equal(a.saved.at(-1).shortcode, 'ABD');
});

test('one photo card offers its qualities inside a selector and downloads only the user-selected real variant', async () => {
  const a = app({ choices: [
    { id: 'photo-best', label: 'Фото · 1440 × 1800 · формат источника', kind: 'photo', itemIndex: 0, group: 'Элемент 1 · Фото', compatibilityKey: 'best' },
    { id: 'photo-small', label: 'Фото · 720 × 900 · формат источника', kind: 'photo', itemIndex: 0, group: 'Элемент 1 · Фото', compatibilityKey: 'small' },
    { id: 'photo-square', label: 'Фото · 640 × 640 · формат источника', kind: 'photo', itemIndex: 0, group: 'Элемент 1 · Фото', compatibilityKey: 'square' },
    { id: 'caption', label: 'Описание автора · TXT', kind: 'caption', group: 'Текст', compatibilityKey: 'caption' },
  ] });
  a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  assert.equal(a.document.querySelectorAll('.mendosave-instagram-card').length, 1);
  assert.equal(a.document.querySelectorAll('.mendosave-instagram-quality option').length, 3);
  assert.equal(a.packageConfigs.at(-1).options.length, 4, 'package keeps all real choices');
  a.change('.mendosave-instagram-quality', 'photo-small');
  a.click('.mendosave-instagram-item'); await a.settle();
  assert.equal(a.saved.at(-1).id, 'photo-small');
  a.change('.mendosave-instagram-quality', 'photo-square', false);
  a.click('.mendosave-instagram-item'); await a.settle();
  assert.equal(a.saved.at(-1).id, 'photo-small', 'forged selection does not change user intent');
});

test('the icon-only Reel control follows the visible action rail, ignoring offscreen Reels', () => {
  const a = app({ markup: `<main><div><video id="off"></video><svg id="old-like" aria-label="Like"></svg></div><div>${'<div>'.repeat(14)}<video id="active"></video>${'</div>'.repeat(14)}<aside><button><svg id="like" aria-label="Like"></svg></button></aside></div></main>`,
    rects: { '#off': { left: 250, top: -900, width: 400, height: 700 },
      '#old-like': { left: 680, top: -300, width: 24, height: 24 },
      '#active': { left: 250, top: 16, width: 400, height: 700 },
      '#like': { left: 680, top: 460, width: 24, height: 24 } } });
  const button = a.document.querySelector('.mendosave-instagram-btn');
  assert.equal(button.style.left, '670px', 'the /p/ alias can display the same Reel layout');
  a.location.pathname = '/reel/ABC/'; a.refresh();
  assert.equal(button.textContent, '');
  assert.ok(button.querySelector('svg'));
  assert.equal(button.title, 'MendoSave');
  assert.equal(button.style.left, '670px');
  assert.equal(button.style.top, '402px');
  a.window.innerWidth = 720; a.refresh();
  assert.ok(parseFloat(button.style.left) + 44 <= 712, 'control is inside narrow viewport');
});

test('return restores quality, extras and scroll and failed reads are retried rather than cached', async () => {
  const a = app({ choices: [
    { id: 'best', kind: 'photo', itemIndex: 0, label: 'Фото · 1080×1350', group: 'Фото' },
    { id: 'small', kind: 'photo', itemIndex: 0, label: 'Фото · 540×675', group: 'Фото' },
    { id: 'caption', kind: 'caption', label: 'Описание автора · TXT', group: 'Текст' },
  ] });
  a.click('.mendosave-instagram-btn'); a.reply({ code: 'AUTH_REQUIRED' }); await a.settle();
  a.key('.mendosave-instagram-menu', 'Escape'); a.click('.mendosave-instagram-btn');
  a.reply(); await a.settle();
  assert.equal(a.messages.filter(message => message.kind === 'request').length, 2);
  a.change('.mendosave-instagram-quality', 'small');
  a.click('.mendosave-instagram-extras-toggle');
  a.document.querySelector('.mendosave-instagram-menu').scrollTop = 73;
  const config = a.packageConfigs.at(-1); config.close(); await config.back(); await a.settle();
  assert.equal(a.document.querySelector('.mendosave-instagram-quality').value, 'small');
  assert.equal(a.document.querySelector('.mendosave-instagram-extras').hidden, false);
  assert.equal(a.document.querySelector('.mendosave-instagram-menu').scrollTop, 73);
  assert.equal(a.messages.filter(message => message.kind === 'request').length, 2);
});

test('photo versions with another aspect ratio are identified in the compact quality selector', async () => {
  const a = app({ choices: [
    { id: 'portrait', kind: 'photo', itemIndex: 0, label: 'Фото · 1440 × 1800', group: 'Фото', version: { width: 1440, height: 1800 } },
    { id: 'square', kind: 'photo', itemIndex: 0, label: 'Фото · 1080 × 1080', group: 'Фото', version: { width: 1080, height: 1080 } },
    { id: 'portrait-small', kind: 'photo', itemIndex: 0, label: 'Фото · 720 × 900', group: 'Фото', version: { width: 720, height: 900 } },
  ] });
  a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  const options = a.document.querySelectorAll('.mendosave-instagram-quality option');
  assert.match(options[1].textContent, /другие пропорции/i);
  assert.doesNotMatch(options[2].textContent, /другие пропорции/i);
});

test('the post trigger uses free space beyond the whole article rather than covering the author column', () => {
  const a = app({ markup: '<main><article><img id="photo"><aside>Author and comments</aside></article></main>',
    rects: { '#photo': { left: 250, top: 100, width: 400, height: 500 },
      article: { left: 250, top: 80, width: 700, height: 600 } } });
  const button = a.document.querySelector('.mendosave-instagram-btn');
  assert.equal(button.style.left, '962px');
  assert.equal(button.style.top, '92px');
});

test('expired media refreshes validated metadata on reopen and direct retry, while keeping the selected choice identity', async () => {
  const seen = [];
  const a = app({ onRun(post) {
    seen.push(post.items[0].imageVersions[0].url);
    if (seen.length < 3) throw new Error('HTTP 403: expired media URL');
    return 'fresh.jpg';
  } });
  const post = url => ({ shortcode: 'ABC', id: '66', username: '', caption: '', items: [{ id: '66', index: 0,
    type: 'photo', imageVersions: [{ url, width: 1080, height: 1350 }], videoVersions: [], dashManifest: '', hasAudio: null }] });
  a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  a.click('.mendosave-instagram-item'); await a.settle();
  a.click('.mendosave-instagram-btn'); a.click('.mendosave-instagram-btn'); await a.settle();
  assert.equal(a.messages.filter(message => message.kind === 'request').length, 2);
  a.reply({ post: post('https://scontent.cdninstagram.com/fresh-1.jpg') }); await a.settle();
  a.click('.mendosave-instagram-item'); await a.settle();
  a.click('.mendosave-instagram-item'); await a.settle();
  assert.equal(a.messages.filter(message => message.kind === 'request').length, 3);
  a.reply({ post: post('https://scontent.cdninstagram.com/fresh-2.jpg') }); await a.settle();
  assert.deepEqual(seen, ['https://scontent.cdninstagram.com/image.jpg', 'https://scontent.cdninstagram.com/fresh-1.jpg',
    'https://scontent.cdninstagram.com/fresh-2.jpg']);
  assert.match(a.document.querySelector('.mendosave-instagram-status').textContent, /Готово/);
});

test('a metadata refresh during media retry is cancellable and its late reply cannot start another save', async () => {
  const a = app({ onRun() { throw new Error('HTTP 403: expired media URL'); } });
  a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  a.click('.mendosave-instagram-item'); await a.settle();
  a.click('.mendosave-instagram-item'); await a.settle();
  assert.equal(a.messages.filter(message => message.kind === 'request').length, 2);
  a.key('.mendosave-instagram-cancel', 'Enter'); await a.settle();
  assert.equal(a.messages.filter(message => message.kind === 'cancel').length, 1);
  a.reply(); await a.settle();
  assert.equal(a.saved.length, 1);
  assert.equal(a.document.querySelector('.mendosave-instagram-item').disabled, false);
});

test('a refreshed publication cannot silently substitute a missing quality during retry', async () => {
  const choices = [{ id: 'selected', label: 'Фото · 1080×1350', kind: 'photo', itemIndex: 0, group: 'Фото' }];
  const a = app({ choices, onRun() { throw new Error('HTTP 403: expired media URL'); } });
  a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  a.click('.mendosave-instagram-item'); await a.settle();
  choices.splice(0, 1, { id: 'replacement', label: 'Фото · 540×675', kind: 'photo', itemIndex: 0, group: 'Фото' });
  a.click('.mendosave-instagram-item'); await a.settle(); a.reply(); await a.settle();
  assert.equal(a.saved.length, 1);
  assert.match(a.document.querySelector('.mendosave-instagram-status').textContent, /вариант изменился/);
});

test('closing the menu during a retry metadata refresh leaves the active operation running', async () => {
  let attempts = 0;
  const a = app({ onRun() { if (++attempts === 1) throw new Error('HTTP 403: expired media URL'); return 'fresh.jpg'; } });
  a.click('.mendosave-instagram-btn'); a.reply(); await a.settle();
  a.click('.mendosave-instagram-item'); await a.settle();
  a.click('.mendosave-instagram-item'); await a.settle();
  const refreshing = a.messages.filter(message => message.kind === 'request').at(-1);
  a.click('.mendo-menu-close'); await a.settle();
  assert.equal(refreshing.signal.aborted, false, 'X dismisses the menu without cancelling the operation');
  a.reply(); await a.settle();
  assert.equal(a.saved.length, 2);
  a.click('.mendosave-instagram-btn'); await a.settle();
  assert.equal(a.messages.filter(message => message.kind === 'request').length, 2);
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
  assert.equal(a.messages.filter(message => message.kind === 'request').length, 1);
  assert.equal(a.document.querySelectorAll('.mendosave-instagram-item').length, 2);
  assert.equal(a.document.querySelector('.mendo-package-open').disabled, false);
  a.key('.mendosave-instagram-item', 'Enter'); await a.settle();
  assert.equal(a.runs.length, 2);
  assert.equal(a.runs[1].signal.aborted, false);
  a.key('.mendosave-instagram-cancel', 'Enter'); await a.settle();
});

test('same-origin page metadata forgery cannot race the trusted metadata read', async () => {
  const a = app(); a.click('.mendosave-instagram-btn');
  a.forge({ post: { shortcode: 'ABC', id: '66', username: 'forged', caption: 'Forged description', items: [{
    id: '66', index: 0, type: 'photo', imageVersions: [
      { url: 'https://scontent.cdninstagram.com/forged.jpg', width: 1080, height: 1350 }],
    videoVersions: [], dashManifest: '', hasAudio: null }] } });
  await a.settle();
  assert.equal(Boolean(a.document.querySelector('.mendosave-instagram-item')), false);
  assert.equal(a.saved.length, 0);
  assert.equal(a.outbound.length, 0, 'no page-readable metadata protocol exists');
  a.reply(); await a.settle();
  assert.equal(Boolean(a.document.querySelector('.mendosave-instagram-item')), true);
});

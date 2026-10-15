const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseHTML, UserEvent } = require('./user-dom.cjs');

test('menu controls support keyboard selection, navigation and Escape', () => {
  const { bind } = require('../extension/menu.js');
  const { document } = parseHTML('<div id="menu"><div class="mendosave-menu-item">Video</div><div class="mendosave-menu-item disabled">Unavailable</div><div class="mendosave-menu-radio sel">Original</div></div>');
  const menu = document.getElementById('menu');
  let focused, selected = 0, closed = 0;
  for (const control of menu.children) control.focus = () => { focused = control; };
  require('../extension/menu.js').onActivate(menu.firstElementChild, () => selected++);
  bind(menu, () => closed++);
  assert.equal(focused, menu.firstElementChild);
  assert.equal(menu.children[1].getAttribute('aria-disabled'), 'true');
  assert.equal(menu.children[1].tabIndex, -1);
  function press(target, key) {
    const event = new UserEvent('keydown', { bubbles: true, cancelable: true });
    event.key = key; target.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  }
  press(focused, 'Enter');
  assert.equal(selected, 1);
  press(focused, 'ArrowDown');
  assert.equal(focused, menu.lastElementChild);
  press(focused, 'Escape');
  assert.equal(closed, 1);
});

test('menu placement keeps a narrow viewport within its visible bounds', () => {
  const { place } = require('../extension/menu.js');
  const menu = { style: {}, getBoundingClientRect: () => ({ width: 300, height: 510 }) };
  place(menu, { right: 0, top: 0, bottom: 0 }, 326, 843);
  const left = Number.parseFloat(menu.style.left), top = Number.parseFloat(menu.style.top);
  assert.ok(left >= 8 && left + 300 <= 326 - 8);
  assert.ok(top >= 8 && top + 510 <= 843 - 8);
});

test('the package opener participates in keyboard navigation and activation without selecting disabled rows', () => {
  const { bind } = require('../extension/menu.js');
  const { document } = parseHTML('<div id="menu"><div class="mendosave-menu-item">Video</div><div class="mendosave-menu-item disabled">Unavailable</div><div class="mendosave-menu-radio">Original</div><button class="mendo-package-open">Select multiple</button></div>');
  const menu = document.getElementById('menu'), opener = menu.lastElementChild;
  let focused, packages = 0, unavailable = 0, closed = 0;
  for (const control of menu.children) control.focus = () => { focused = control; };
  require('../extension/menu.js').onActivate(opener, () => packages++);
  menu.children[1].addEventListener('click', () => unavailable++);
  bind(menu, () => closed++);
  const press = (target, key) => {
    const event = new UserEvent('keydown', { bubbles: true, cancelable: true });
    event.key = key; target.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  };
  press(focused, 'End'); assert.ok(focused === opener, 'End reaches the package opener');
  assert.equal(opener.getAttribute('role'), 'menuitem');
  press(opener, 'Enter'); press(opener, ' '); assert.equal(packages, 2);
  press(opener, 'ArrowDown'); assert.ok(focused === menu.firstElementChild);
  press(focused, 'ArrowUp'); assert.ok(focused === opener);
  press(opener, 'Home'); assert.ok(focused === menu.firstElementChild);
  press(menu.children[1], 'Enter'); assert.equal(unavailable, 0);
  opener.disabled = true;
  press(opener, ' '); assert.equal(packages, 2);
  press(menu.firstElementChild, 'End'); assert.ok(focused === menu.children[2]);
  press(focused, 'Escape'); assert.equal(closed, 1);
});

test('shared menu navigation respects activation already handled by an adapter control', () => {
  const { bind } = require('../extension/menu.js');
  const { document } = parseHTML('<div><button class="adapter-option mendosave-menu-item">Video</button><button class="mendo-package-open">Select multiple</button></div>');
  const menu = document.firstElementChild, video = menu.firstElementChild;
  let clicks = 0;
  require('../extension/menu.js').onActivate(video, () => clicks++);
  video.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); require('../extension/menu.js').activate(video, event); } });
  bind(menu, () => {}, 'button');
  const event = new UserEvent('keydown', { bubbles: true, cancelable: true }); event.key = 'Enter'; video.dispatchEvent(event);
  assert.equal(clicks, 1, 'the adapter and shared menu cannot activate a control twice');
});

test('compact groups keep advanced choices available through trusted keyboard activation', () => {
  const { bind, compact, onActivate } = require('../extension/menu.js');
  const { document, Event } = parseHTML('<div id="menu"><button class="choice">1080p</button><button class="choice">720p</button><button class="choice">480p</button><button class="choice">360p</button><button class="mendo-package-open">Пакет</button></div>');
  const menu = document.getElementById('menu'), items = [...menu.querySelectorAll('.choice')];
  let selected = 0, focused;
  onActivate(items[2], () => selected++);
  compact(menu, { groups: [{ title: 'Видео', items }] });
  for (const control of menu.querySelectorAll('button')) control.focus = () => { focused = control; };
  bind(menu, () => {}, '.choice,.mendo-package-open');
  const more = menu.querySelector('.mendo-menu-more');
  const press = (control, key) => { const event = new UserEvent('keydown', { bubbles: true, cancelable: true }); event.key = key; control.dispatchEvent(event); };
  assert.equal(items[2].hidden, true);
  assert.equal(items[2].tabIndex, -1);
  press(items[1], 'ArrowDown'); assert.equal(focused, more);
  more.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  assert.equal(items[2].hidden, true, 'page-script clicks cannot reveal or activate choices');
  press(more, 'Enter');
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(items[2].hidden, false);
  press(items[1], 'ArrowDown'); assert.equal(focused, items[2]);
  press(focused, 'Enter'); assert.equal(selected, 1);
  press(more, ' ');
  assert.equal(items[2].hidden, true);
  assert.equal(items[2].tabIndex, -1);
  assert.equal(menu.querySelectorAll('.choice').length, 4, 'all original quality choices survive');
});

test('a shared header closes once through trusted keyboard activation and exposes a decorative brand icon', () => {
  const { bind, decorate, icon } = require('../extension/menu.js');
  const { document } = parseHTML('<div id="menu"><button class="choice">Видео</button></div>');
  const menu = document.getElementById('menu'); let closed = 0;
  decorate(menu, { title: 'YouTube', subtitle: 'Материал', close: () => closed++ });
  decorate(menu, { title: 'YouTube', subtitle: 'Актуальный материал', close: () => closed++ });
  bind(menu, () => closed++, '.choice');
  assert.equal(menu.querySelectorAll('.mendo-menu-header').length, 1);
  assert.equal(menu.querySelector('.mendo-menu-subtitle').textContent, 'Актуальный материал');
  const close = menu.querySelector('.mendo-menu-close');
  const event = new UserEvent('keydown', { bubbles: true, cancelable: true }); event.key = 'Enter'; close.dispatchEvent(event);
  assert.equal(closed, 1);
  assert.equal(close.getAttribute('aria-label'), 'Закрыть меню');
  assert.equal(icon(document).getAttribute('aria-hidden'), 'true');
  assert.equal(icon(document, 'download').querySelector('circle').getAttribute('r'), '16.9');
});

test('native form controls retain their keys while Escape closes the surrounding menu', () => {
  const { bind } = require('../extension/menu.js');
  const { document } = parseHTML('<div id="menu"><button class="choice">Видео</button><select><option>1080p</option><option>720p</option></select><input><textarea></textarea><div contenteditable="true"><span>Название</span></div></div>');
  const menu = document.getElementById('menu'); let closed = 0;
  bind(menu, () => closed++, '.choice');
  for (const control of menu.querySelectorAll('select,input,textarea,[contenteditable] span')) {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ']) {
      const event = new UserEvent('keydown', { bubbles: true, cancelable: true }); event.key = key;
      control.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false, `${control.tagName} owns ${key}`);
    }
  }
  const escape = new UserEvent('keydown', { bubbles: true, cancelable: true }); escape.key = 'Escape';
  menu.querySelector('select').dispatchEvent(escape);
  assert.equal(closed, 1);
  assert.equal(escape.defaultPrevented, true);
});

test('expanding qualities keeps a menu above bottom controls inside the viewport', () => {
  const { compact } = require('../extension/menu.js');
  const { document, window } = parseHTML('<div id="menu" style="top:500px;left:1050px"><button>1080p</button><button>720p</button><button>480p</button><button>360p</button></div>');
  window.innerWidth = 1280; window.innerHeight = 800;
  const menu = document.getElementById('menu');
  menu.getBoundingClientRect = () => ({ top: 500, left: 1050, width: 320, height: 600 });
  compact(menu, { groups: [{ title: 'Видео', items: [...menu.querySelectorAll('button')] }] });
  menu.querySelector('.mendo-menu-more').click();
  assert.equal(menu.style.top, '192px');
  assert.equal(menu.style.left, '952px');
});

test('source state restores presentation only for the same option signature and keeps one metadata source', () => {
  const { compact, createState } = require('../extension/menu.js');
  const { document } = parseHTML('<html><body></body></html>');
  const state = createState(); state.route('route'); state.get('source-a'); state.set('source-a', { title: 'A' });
  const make = () => { const menu = document.createElement('div'); for (const label of ['1080p', '720p', '480p']) { const button = document.createElement('button'); button.textContent = label; menu.append(button); } compact(menu, { groups: [{ title: 'Видео', items: [...menu.children] }] }); return menu; };
  let menu = make(); state.attach(menu, 'source-a', '1080,720,480');
  menu.querySelector('.mendo-menu-more').click(); menu.scrollTop = 173; state.remember(menu);
  menu = make(); state.attach(menu, 'source-a', '1080,720,480');
  assert.equal(menu.querySelector('.mendo-menu-more').getAttribute('aria-expanded'), 'true');
  assert.equal(menu.scrollTop, 173);
  menu = make(); state.attach(menu, 'source-a', '2160,1080,720');
  assert.equal(menu.querySelector('.mendo-menu-more').getAttribute('aria-expanded'), 'false');
  assert.equal(Number(menu.scrollTop) || 0, 0);
  assert.equal(state.get('source-b'), undefined); state.set('source-b', { title: 'B' });
  assert.equal(state.get('source-a'), undefined, 'previous source metadata is not retained in a map');
});

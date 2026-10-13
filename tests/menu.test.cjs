const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseHTML } = require('linkedom');

test('menu controls support keyboard selection, navigation and Escape', () => {
  const { bind } = require('../extension/menu.js');
  const { document, window } = parseHTML('<div id="menu"><div class="mendosave-menu-item">Video</div><div class="mendosave-menu-item disabled">Unavailable</div><div class="mendosave-menu-radio sel">Original</div></div>');
  const menu = document.getElementById('menu');
  let focused, selected = 0, closed = 0;
  for (const control of menu.children) control.focus = () => { focused = control; };
  menu.firstElementChild.addEventListener('click', () => selected++);
  bind(menu, () => closed++);
  assert.equal(focused, menu.firstElementChild);
  assert.equal(menu.children[1].getAttribute('aria-disabled'), 'true');
  assert.equal(menu.children[1].tabIndex, -1);
  function press(target, key) {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
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
  const { document, window } = parseHTML('<div id="menu"><div class="mendosave-menu-item">Video</div><div class="mendosave-menu-item disabled">Unavailable</div><div class="mendosave-menu-radio">Original</div><button class="mendo-package-open">Select multiple</button></div>');
  const menu = document.getElementById('menu'), opener = menu.lastElementChild;
  let focused, packages = 0, unavailable = 0, closed = 0;
  for (const control of menu.children) control.focus = () => { focused = control; };
  opener.addEventListener('click', () => packages++);
  menu.children[1].addEventListener('click', () => unavailable++);
  bind(menu, () => closed++);
  const press = (target, key) => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
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
  const { document, window } = parseHTML('<div><button class="adapter-option mendosave-menu-item">Video</button><button class="mendo-package-open">Select multiple</button></div>');
  const menu = document.firstElementChild, video = menu.firstElementChild;
  let clicks = 0;
  video.addEventListener('click', () => clicks++);
  video.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); video.click(); } });
  bind(menu, () => {}, 'button');
  const event = new window.Event('keydown', { bubbles: true, cancelable: true }); event.key = 'Enter'; video.dispatchEvent(event);
  assert.equal(clicks, 1, 'the adapter and shared menu cannot activate a control twice');
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseHTML } = require('linkedom');

test('menu controls support keyboard selection, navigation and Escape', () => {
  const { bind } = require('../extension/menu.js');
  const { document, window } = parseHTML('<div id="menu"><div class="nova-menu-item">Video</div><div class="nova-menu-item disabled">Unavailable</div><div class="nova-menu-radio sel">Original</div></div>');
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

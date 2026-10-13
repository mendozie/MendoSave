const assert = require('node:assert/strict');
const { test } = require('node:test');
const { adapter } = require('./tiktok-adapter-harness.cjs');
const { parseHTML } = require('linkedom');
const { producerPorts } = require('./producer-port-harness.cjs');

function event(window, type, trusted, key) {
  const value = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(value, 'isTrusted', { value: trusted });
  if (key) value.key = key;
  return value;
}

function coub() {
  const payload = require('./fixtures/coub-item.json').payload;
  return adapter('coub.js', '<div data-permalink="fixture"><div class="viewer"></div></div>',
    'https://coub.com/view/fixture', async () => ({ ok: true, json: async () => payload }));
}

test('page-dispatched opener activation cannot initiate Coub metadata or downloads', async () => {
  const app = coub();
  app.document.querySelector('.mendosave-coub-btn').dispatchEvent(event(app.context.window, 'click', false));
  await app.settle();
  assert.equal(app.requests.length, 0);
  assert.equal(app.document.querySelector('.mendosave-coub-menu'), null);
});

test('a genuinely opened menu still rejects synthetic media clicks and keys', async () => {
  for (const type of ['click', 'keydown']) {
    const app = coub();
    app.document.querySelector('.mendosave-coub-btn').dispatchEvent(event(app.context.window, 'click', true));
    await app.settle();
    const option = app.document.querySelector('.mendosave-coub-item[role="menuitem"],.mendosave-coub-item[role="button"]');
    assert.ok(option);
    option.dispatchEvent(event(app.context.window, type, false, 'Enter'));
    await app.settle();
    assert.equal(option.isConnected, true, 'a synthetic action must leave the user menu intact');
    assert.equal(app.messages.some(message => /mendosave-(save|begin|register-job)$/.test(message.t)), false);
  }
});

test('package files and ZIP starts reject page-dispatched clicks after genuine opening', async () => {
  for (const mode of ['files', 'zip']) {
    const { document, window } = parseHTML('<html><body><div id="menu"></div></body></html>');
    const messages = [], transport = producerPorts();
    const ui = require('../extension/package_ui.js').create({ document,
      queue: require('../extension/package_queue.js'), runtime: { connect: transport.connect,
        async sendMessage(message) { messages.push(message); return { ok: true }; } } });
    const opener = ui.add(document.getElementById('menu'), { title: 'Fixture', options: ['a', 'b'].map(id => ({
      id, label: id, async run() { return `${id}.mp4`; },
    })) });
    opener.dispatchEvent(event(window, 'click', true));
    const input = document.querySelector('input'); input.checked = true;
    input.dispatchEvent(new window.Event('change'));
    document.querySelector(`[data-mode="${mode}"]`).dispatchEvent(event(window, 'click', false));
    await new Promise(setImmediate);
    assert.equal(ui.running, false);
    assert.equal(transport.ports.length, 0);
    assert.equal(messages.length, 0);
  }
});

test('trusted menu keyboard activation calls its action once and rejects synthetic/repeated keys', () => {
  const menuAPI = require('../extension/menu.js');
  const { document, window } = parseHTML('<div id="menu"><button class="mendosave-menu-item">Save</button></div>');
  const menu = document.getElementById('menu'), button = menu.firstElementChild;
  button.focus = () => {};
  let starts = 0;
  menuAPI.onActivate(button, () => starts++);
  menuAPI.bind(menu, () => {});
  button.dispatchEvent(event(window, 'keydown', false, 'Enter'));
  assert.equal(starts, 0);
  button.dispatchEvent(event(window, 'keydown', true, 'Enter'));
  button.dispatchEvent(event(window, 'keydown', true, ' '));
  const repeat = event(window, 'keydown', true, 'Enter'); repeat.repeat = true; button.dispatchEvent(repeat);
  assert.equal(starts, 2);
});

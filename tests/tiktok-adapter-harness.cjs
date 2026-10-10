const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML, DOMParser } = require('linkedom');

// Runs the delivered content script and exercises its DOM/runtime boundary.
function adapter(script, html, href, network, send) {
  const { document, window } = parseHTML(`<html><body>${html}</body></html>`);
  window.innerWidth = 1280;
  window.innerHeight = 800;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 320, height: 200, top: 300, bottom: 500, left: 20, right: 340 });
  const messages = [], requests = [], downloads = [], blobs = [], listeners = new Set();
  document.addEventListener('click', (event) => {
    if (event.target.tagName === 'A' && event.target.download) downloads.push(event.target.download);
  }, true);
  const context = vm.createContext({
    window, document, location: new URL(href), URL, Blob, Uint8Array, DOMParser, TextDecoder,
    crypto: require('node:crypto').webcrypto,
    console: { log() {}, error() {} },
    fetch: async (url, options = {}) => { requests.push({ url: String(url), options }); return network(String(url), options); },
    chrome: { runtime: {
      getManifest: () => ({ version: '0.1.0' }),
      async sendMessage(message) { messages.push(message); return send ? send(message) : { ok: true, id: 1, tabId: 7, state: 'complete' }; },
      onMessage: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
    } },
    localStorage: { getItem() { return null; }, setItem() {} },
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    getComputedStyle: () => ({ position: 'relative' }),
    setInterval() { return 1; }, clearInterval() {},
    setTimeout(fn, delay) { if (delay <= 1500) queueMicrotask(fn); return 1; }, clearTimeout() {},
    requestAnimationFrame(fn) { fn(); return 1; },
    MutationObserver: class { observe() {} },
  });
  context.MendoPackageUI = {
    running: false,
    check() {},
    send: (message) => context.chrome.runtime.sendMessage(message),
    fetch: (url, options) => context.fetch(url, options),
    add() {},
    interruption(code) {
      const error = new Error(`Сохранение прервано: ${code}`);
      if (code === 'USER_CANCELED' || code === 'USER_CANCELLED') error.name = 'AbortError';
      throw error;
    },
    async saveBlob(blob, filename) { blobs.push(blob); downloads.push(filename); return filename; },
  };
  vm.runInContext(fs.readFileSync(`extension/${script}`, 'utf8'), context, { filename: script });
  return {
    document, messages, requests, downloads, blobs, context,
    click(element) { element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); },
    press(element, key, repeat = false) {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      event.key = key;
      event.repeat = repeat;
      element.dispatchEvent(event);
      return event;
    },
    async settle() { for (let i = 0; i < 12; i++) await new Promise(setImmediate); },
  };
}

// Model Gecko Xray network views without restricting extension-owned arrays.
// Index reads work; species-based subarray reads a foreign constructor and fails.
function restrictNetworkViews(app) {
  const responseBuffers = new WeakSet();
  function ContentUint8Array(input, offset, length) {
    const bytes = new Uint8Array(input, offset, length);
    if (responseBuffers.has(input)) Object.defineProperty(bytes, 'constructor', {
      get() { throw new Error('Permission denied to access property "constructor"'); },
    });
    return bytes;
  }
  ContentUint8Array.prototype = Uint8Array.prototype;
  app.context.Uint8Array = ContentUint8Array;
  const fetch = app.context.fetch;
  app.context.fetch = async (...args) => {
    const response = await fetch(...args);
    if (response.arrayBuffer) {
      const read = response.arrayBuffer.bind(response);
      response.arrayBuffer = async () => {
        const buffer = await read();
        responseBuffers.add(buffer);
        return buffer;
      };
    }
    return response;
  };
}

module.exports = { adapter, restrictNetworkViews };

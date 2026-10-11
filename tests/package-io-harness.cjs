const fs = require('node:fs');
const vm = require('node:vm');
const { PackageHost } = require('../extension/package_host.js');
const archive = require('../extension/archive.js');

function fixture(overrides = {}) {
  const files = new Map();
  function directory(prefix = '') {
    return {
      async getDirectoryHandle(name) { return directory(`${prefix}${name}/`); },
      async *entries() {
        for (const key of files.keys()) {
          const name = key.startsWith(prefix) ? key.slice(prefix.length) : '';
          if (name && !name.includes('/')) yield [name, { kind: 'file' }];
        }
      },
      async getFileHandle(name, options) {
        const key = prefix + name;
        if (!files.has(key)) {
          if (!options?.create) throw new Error('missing file');
          files.set(key, new Uint8Array());
        }
        return {
          async createWritable() {
            let parts = [];
            return new WritableStream({
              async write(bytes) { await overrides.beforeWrite?.(); parts.push(bytes); },
              async close() { files.set(key, new Uint8Array(await new Blob(parts).arrayBuffer())); },
              abort() { parts = []; },
            });
          },
          async getFile() { return new File([files.get(key)], name); },
        };
      },
      async removeEntry(name) { files.delete(prefix + name); },
    };
  }
  const saved = [];
  const timers = new Map();
  let timerId = 0;
  const effects = { runtimeId: 'mendo@test', getURL: path => `moz-extension://test/${path}`,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    storage: { getDirectory: async () => directory(), estimate: async () => ({ usage: 0, quota: 8 * 1024 ** 3 }) },
    saveBlob: async (blob, filename) => { saved.push({ blob, filename }); return 42; },
    prepare: async (blob, filename) => ({ blob, filename, id: `${filename}.bin`, size: blob.size }),
    discard: async () => {}, archive, ...overrides };
  const context = vm.createContext({ MendoPackageHost: { PackageHost },
    Blob, File, WritableStream, AbortController, AbortSignal, DOMException, URL, TextEncoder, Uint8Array,
    crypto: require('node:crypto').webcrypto, atob, fetch });
  vm.runInContext(fs.readFileSync('extension/package_io.js', 'utf8'), context);
  return { io: context.MendoPackageIO.create(effects), files, saved, timers, storage: effects.storage };
}

module.exports = { fixture };

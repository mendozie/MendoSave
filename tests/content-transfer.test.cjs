const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const espree = require('espree');
const { parseHTML } = require('linkedom');
const { producerPorts } = require('./producer-port-harness.cjs');
const { create: createPackageUI } = require('../extension/package_ui.js');

const CHUNK_SIZE = 4 * 1024 * 1024;
const source = fs.readFileSync('extension/content_ui.js', 'utf8');
const tree = espree.parse(source, { ecmaVersion: 'latest', range: true });
const declarations = tree.body[0].expression.callee.body.body;
// Isolate the real transfer flows, not the whole UI bootstrap. This harness
// observes extension message bytes and live DOM events; it does not establish
// hook/DOM integration or Gecko compatibility, which require browser QA.
const names = new Set(['ownedTransferChunk', 'stageBuffer', 'encodeBase64', 'muxViaOffscreen', 'startLiveRecording']);
const constantNames = new Set(['TRANSFER_CHUNK_SIZE', 'HAS_NATIVE_BASE64']);
const transferSource = declarations.filter(node => (node.type === 'FunctionDeclaration' && names.has(node.id.name))
  || (node.type === 'VariableDeclaration' && node.declarations.some(item => constantNames.has(item.id.name))))
  .map(node => source.slice(...node.range)).join('\n');

function harness() {
  const { window } = parseHTML('<html><body></body></html>');
  const pageBuffers = new WeakSet();
  let largestCopy = 0;
  function ContentUint8Array(input, offset, length) {
    const bytes = new Uint8Array(input, offset, length);
    if (pageBuffers.has(input)) Object.defineProperty(bytes, 'constructor', {
      get() { throw new Error('Permission denied to access property "constructor"'); },
    });
    if (ArrayBuffer.isView(input)) largestCopy = Math.max(largestCopy, bytes.byteLength);
    return bytes;
  }
  ContentUint8Array.prototype = Uint8Array.prototype;
  const messages = [], errors = [];
  const producers = producerPorts();
  const runtimeSend = async (message) => {
    messages.push(message);
    return message.t === 'mendosave-register-job' ? { ok: true, tabId: 7 } : { ok: true };
  };
  const packageUI = createPackageUI({ runtime: { connect: producers.connect, sendMessage: runtimeSend } });
  let finishLive, liveStarted;
  const ready = new Promise(resolve => { liveStarted = resolve; });
  const context = vm.createContext({ window, location: new URL('https://www.youtube.com/shorts/fixture'),
    MendoPackageUI: packageUI,
    Uint8Array: ContentUint8Array, btoa, crypto,
    async sendWorkerMessage() { return { ok: true }; },
    sendRuntimeMessage: (message, _timeout, producer) => producer ? producer.send(message) : runtimeSend(message),
    callHook(cmd) {
      if (cmd === 'live-start') {
        liveStarted();
        return new Promise(resolve => { finishLive = resolve; });
      }
      return Promise.resolve({});
    },
    getToast() { return { set() {}, hide() {} }; }, renderLivePanel() {}, removeLivePanel() {},
    safeFilename: value => value,
    async reportError(tag, error) { errors.push(error); },
    chrome: { runtime: { onMessage: { addListener() {}, removeListener() {} } } },
  });
  vm.runInContext(`let liveJob = null, downloadInProgress = false;
    ${transferSource}`, context);
  function fixture(size = CHUNK_SIZE + 7) {
    const bytes = new Uint8Array(size);
    bytes[0] = 0x11; bytes[32767] = 0xaa; bytes[32768] = 0xbb;
    bytes[CHUNK_SIZE - 1] = 0xcc; bytes[CHUNK_SIZE] = 0xdd; bytes[size - 1] = 0xee;
    pageBuffers.add(bytes.buffer);
    return bytes;
  }
  return { context, window, fixture, messages, errors, ready, producers,
    acquire: () => packageUI.acquireProcessor(),
    largestCopy: () => largestCopy,
    finishLive: () => finishLive({ durationSeconds: 10, videoMime: 'video/mp4', audioMime: 'audio/mp4' }),
    foreignView: buffer => new ContentUint8Array(buffer),
  };
}

function expectBytes(h, type, track, expected) {
  const chunks = h.messages.filter(message => message.t === type && message.track === track);
  assert.deepEqual(chunks.map(message => Buffer.from(message.b64, 'base64').length), [CHUNK_SIZE, 7]);
  assert.deepEqual(Buffer.concat(chunks.map(message => Buffer.from(message.b64, 'base64'))), Buffer.from(expected));
  assert.equal(chunks.every(message => message.instanceId === 'processor-fixture'), true, 'bytes are routed to the acquired processor');
  assert.equal(h.largestCopy(), CHUNK_SIZE, 'owned copy is bounded to a transfer chunk');
}

test('captured staging transfers exact foreign-buffer bytes across the 4 MiB boundary', async () => {
  const h = harness(), bytes = h.fixture();
  const producer = await h.acquire();
  assert.throws(() => h.foreignView(bytes.buffer).subarray(0, 1), /Permission denied to access property "constructor"/);
  assert.equal(await h.context.stageBuffer('stage-job', 'audio', bytes.buffer, producer), true);
  expectBytes(h, 'mendosave-stage', 'audio', bytes);
  producer.release();
});

test('captured mux transfers audio, video and prefix without foreign species access', async () => {
  const h = harness(), bytes = h.fixture();
  const producer = await h.acquire();
  const job = { jobId: 'mux-job', format: 'mp4', filename: 'fixture.mp4',
    video: bytes.buffer, audio: bytes.buffer, videoPrefix: bytes.buffer };
  assert.equal((await h.context.muxViaOffscreen(job, undefined, producer)).ok, true);
  for (const track of ['audio', 'video', 'video-prefix']) expectBytes(h, 'mendosave-chunk', track, bytes);
  assert.equal(h.messages.filter(message => message.t === 'mendosave-finalize').length, 1);
  assert.equal(h.messages.some(message => message.t === 'mendosave-abort'), false);
  assert.equal(job.video, null); assert.equal(job.audio, null); assert.equal(job.videoPrefix, null);
  producer.release();
});

test('live message chunks transfer exact foreign-buffer bytes and finalize both tracks', { timeout: 5000 }, async () => {
  const h = harness(), bytes = h.fixture();
  const recording = h.context.startLiveRecording({ title: 'fixture', videoId: 'fixture' }, 'now');
  await h.ready;
  assert.equal(h.producers.ports[0].disconnected, false, 'live transfer owns a ready processor');
  for (const kind of ['audio', 'video']) {
    const event = new h.window.Event('message');
    event.source = h.window; event.origin = 'https://www.youtube.com';
    event.data = { __mendosave_live_chunk: true, kind, mime: `${kind}/mp4`, buffer: bytes.buffer };
    h.window.dispatchEvent(event);
  }
  h.finishLive();
  assert.equal(await recording, true, h.errors[0]?.message);
  assert.equal(h.producers.ports[0].disconnected, true, 'finished transfer releases its processor');
  for (const track of ['audio', 'video']) expectBytes(h, 'mendosave-live-chunk', track, bytes);
  assert.equal(h.messages.filter(message => message.t === 'mendosave-live-finalize').length, 1);
  assert.equal(h.messages.some(message => message.t === 'mendosave-live-abort'), false);
  assert.equal(h.errors.length, 0);
});

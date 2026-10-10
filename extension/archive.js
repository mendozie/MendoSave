/* global module, require */
'use strict';

const NAME_BYTES = 180;
const DEFAULT_MAX_BYTES = 1024 ** 3;
const MAX_ENTRIES = 1000;
const encoder = new TextEncoder();

function truncateName(value, bytes) {
  let result = '';
  let size = 0;
  for (const character of value) {
    const length = encoder.encode(character).length;
    if (size + length > bytes) break;
    result += character;
    size += length;
  }
  return result;
}

function nameParts(name) {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  return dot > 0 && encoder.encode(extension).length <= 32
    ? [name.slice(0, dot), extension] : [name, ''];
}

function safeName(value) {
  if (typeof value !== 'string') throw new TypeError('Archive filename must be a string');
  let name = value.toWellFormed().normalize('NFC').trim()
    // Windows prohibits control characters; bidi overrides must not conceal a filename.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!name) name = 'file';
  if (/^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\s*\.|$)/i.test(name)) name = `_${name}`;
  const [stem, extension] = nameParts(name);
  return `${truncateName(stem, NAME_BYTES - encoder.encode(extension).length).replace(/[. ]+$/g, '')}${extension}`;
}
function uniqueNames(names) {
  if (!Array.isArray(names)) throw new TypeError('Archive filenames must be an array');
  const used = new Set();
  return names.map((value) => {
    const name = safeName(value);
    const [stem, extension] = nameParts(name);
    let candidate = name;
    for (let number = 2; used.has(candidate.toUpperCase()); number++) {
      const suffix = ` (${number})${extension}`;
      candidate = `${truncateName(stem, NAME_BYTES - encoder.encode(suffix).length)}${suffix}`;
    }
    used.add(candidate.toUpperCase());
    return candidate;
  });
}

async function write(entries, writable, { signal, onProgress, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_ENTRIES) throw new TypeError('Archive requires 1 to 1000 files');
  if (!(writable instanceof WritableStream) || writable.locked) throw new TypeError('Archive requires an unlocked WritableStream');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('Archive limit must be a positive finite safe integer');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('Archive progress must be a function');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Archive signal must be an AbortSignal');
  const files = entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string' || !entry.name.trim()
      || !(entry.blob instanceof Blob) || entry.blob.size <= 0 || !Number.isSafeInteger(entry.blob.size)) {
      throw new TypeError('Archive entry requires a filename and nonempty Blob');
    }
    return { name: entry.name, blob: entry.blob };
  });
  let totalBytes = 0;
  for (const file of files) {
    if (file.blob.size > maxBytes - totalBytes) throw new DOMException('Archive exceeds the output limit', 'QuotaExceededError');
    totalBytes += file.blob.size;
  }
  signal?.throwIfAborted();
  const zip = typeof module !== 'undefined' ? require('./vendor/zipjs/zip-native.min.js') : globalThis.zip;
  if (!zip) throw new Error('Local ZIP library is unavailable');
  zip.configure({ useWebWorkers: false });
  const names = uniqueNames(files.map((entry) => entry.name));
  const target = writable.getWriter();
  let bytes = 0;
  let progressError;
  let progressFailed = false;
  const output = new WritableStream({
    async write(chunk) {
      if (progressFailed) throw progressError;
      signal?.throwIfAborted();
      if (chunk.byteLength > maxBytes - bytes) throw new DOMException('Archive exceeds the output limit', 'QuotaExceededError');
      await target.write(chunk);
      bytes += chunk.byteLength;
      signal?.throwIfAborted();
    },
  });
  const results = [];
  let completedBytes = 0;
  const report = async (currentBytes = 0) => {
    try {
      await onProgress?.({
        bytesWritten: bytes, completedBytes: completedBytes + currentBytes, totalBytes,
        entriesCompleted: results.length, totalEntries: files.length,
      });
    } catch (error) {
      // zip.js ignores callback rejections. Preserve them at the output boundary.
      progressFailed = true;
      progressError = error;
      throw error;
    }
  };
  try {
    const archive = new zip.ZipWriter(output, { level: 0, useWebWorkers: false, bufferedWrite: false, preventClose: true });
    for (let index = 0; index < files.length; index++) {
      signal?.throwIfAborted();
      const entry = files[index];
      const metadata = await archive.add(names[index], new zip.BlobReader(entry.blob), {
        level: 0, useWebWorkers: false, signal,
        onprogress: (loaded) => report(Math.min(loaded, entry.blob.size)),
      });
      if (progressFailed) throw progressError;
      if (metadata.uncompressedSize !== entry.blob.size || metadata.compressedSize !== entry.blob.size) {
        throw new Error('Archive source size changed during packing');
      }
      results.push({ name: names[index], size: entry.blob.size });
      completedBytes += entry.blob.size;
      await report();
    }
    signal?.throwIfAborted();
    await archive.close();
    await report();
    signal?.throwIfAborted();
    await target.close();
    signal?.throwIfAborted();
    return { bytes, entries: results };
  } catch (error) {
    try { await target.abort(error); } catch {}
    throw error;
  } finally {
    target.releaseLock();
  }
}

globalThis.MendoArchive = { safeName, uniqueNames, write };
if (typeof module !== 'undefined') module.exports = globalThis.MendoArchive;

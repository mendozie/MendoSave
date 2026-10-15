(() => {
  const PACKAGE_ROUTES = new Map(['begin', 'next', 'complete', 'finish', 'cancel']
    .map(action => [`mendosave-package-${action}`, action]));
  const BLOB_ROUTES = new Set(['open', 'chunk', 'finish', 'abort'].map(action => `mendosave-blob-${action}`));
  const MAX_BYTES = 1024 ** 3;
  const CHUNK_BYTES = 1024 ** 2;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function create(effects) {
    const transfers = new Map();
    const sources = new Set();
    const archives = new Map();
    const producers = new Map();
    const reservations = new Map();
    const timerStart = effects.setTimeout || setTimeout;
    const timerStop = effects.clearTimeout || clearTimeout;
    const transferTimeout = effects.transferTimeoutMs ?? 60000;
    let initialization, sweeping = false, beginning = false;
    if (!Number.isSafeInteger(transferTimeout) || transferTimeout < 1 || transferTimeout > 300000) {
      throw new Error('Некорректный таймаут передачи');
    }
    const host = new globalThis.MendoPackageHost.PackageHost({ names: effects.archive.uniqueNames,
      prepare: effects.prepare, save: effects.saveBlob, discard: effects.discard, cancelWork: effects.cancelWork,
      archive: writeArchive });
    function owner(sender) {
      if (sender?.id !== effects.runtimeId || !Number.isInteger(sender?.tab?.id) || sender.frameId !== 0) {
        throw new Error('Пакет доступен только верхнему документу вкладки');
      }
      return { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId };
    }
    function failure(error) {
      return { ok: false, error: String(error?.message || error),
        ...(error?.cancelled === true || error?.name === 'AbortError' ? { cancelled: true } : {}) };
    }
    async function quota(needed) {
      const estimate = await effects.storage.estimate();
      if (!Number.isFinite(estimate.quota) || !Number.isFinite(estimate.usage)
        || estimate.quota - estimate.usage < needed + 65536) {
        throw new DOMException('Недостаточно места во временном хранилище', 'QuotaExceededError');
      }
    }
    async function spool(name, needed) {
      await quota(needed);
      const root = await effects.storage.getDirectory();
      const directory = await root.getDirectoryHandle(name, { create: true });
      const id = `${crypto.randomUUID()}.bin`;
      const file = await directory.getFileHandle(id, { create: true });
      try {
        const writable = await file.createWritable();
        const writer = writable.getWriter();
        return { directory, id, file, writer, writable };
      } catch (error) { await directory.removeEntry(id).catch(() => {}); throw error; }
    }
    async function cleanup(entry) {
      if (!entry.closed) {
        const writer = entry.writable.locked ? entry.writer : entry.writable.getWriter();
        await writer.abort().catch(() => {});
        try { writer.releaseLock(); } catch {}
      }
      entry.closed = true;
      entry.detach?.();
      entry.release?.();
      clearTransferTimer(entry);
      try { entry.writer.releaseLock(); } catch {}
      await entry.directory.removeEntry(entry.id);
    }
    function sameOwner(left, right) {
      return left.tabId === right.tabId && left.frameId === right.frameId && left.documentId === right.documentId;
    }
    function position(entry) {
      if (beginning) throw new Error('Пакет ещё подготавливается');
      const p = host.owned(entry.owner, entry.packageId);
      if (!Number.isInteger(entry.packageIndex) || entry.packageIndex < 0 || p.index !== entry.packageIndex
        || p.entries[entry.packageIndex] || p.busy) throw new Error('Результат не принадлежит текущей позиции пакета');
      return p;
    }
    function claim(entry) {
      const p = position(entry);
      const key = `${entry.packageId}:${entry.packageIndex}`;
      if (producers.has(key) || effects.positionBusy?.(p)) throw new Error('Для позиции уже открыт producer');
      producers.set(key, entry);
      entry.release = () => { if (producers.get(key) === entry) producers.delete(key); };
    }
    function positionAvailable(currentOwner, id, index) {
      if (sweeping) throw new Error('Временное хранилище ещё очищается');
      const entry = { owner: currentOwner, packageId: id, packageIndex: index };
      position(entry);
      if (producers.has(`${id}:${index}`)) throw new Error('Для позиции уже открыт producer');
      return true;
    }
    async function output(currentOwner, id, index, blob, filename, job) {
      positionAvailable(currentOwner, id, index);
      return host.output(currentOwner, id, blob, filename, job);
    }
    function workActive() {
      return Boolean(beginning || host.active || transfers.size || sources.size || archives.size || producers.size || reservations.size);
    }
    async function sweep() {
      if (workActive() || sweeping) throw new Error('Очистка запрещена: работа уже выполняется');
      sweeping = true;
      try {
        const root = await effects.storage.getDirectory();
        let removed = 0;
        for (const name of ['mendo-transfer', 'mendo-archives']) {
          let directory;
          try { directory = await root.getDirectoryHandle(name); }
          catch (error) { if (error?.name === 'NotFoundError') continue; throw error; }
          const owned = [];
          for await (const [filename, handle] of directory.entries()) {
            if (handle.kind === 'file' && filename.endsWith('.bin') && UUID.test(filename.slice(0, -4))) owned.push(filename);
          }
          for (const filename of owned) { await directory.removeEntry(filename); removed++; }
        }
        return { removed };
      } finally { sweeping = false; }
    }
    function initialize() {
      if (!initialization) initialization = sweep().catch(error => { initialization = undefined; throw error; });
      return initialization;
    }
    function clearTransferTimer(entry) {
      if (entry.timer !== undefined) timerStop(entry.timer);
      entry.timer = undefined;
    }
    function refreshTransferTimer(entry, id) {
      clearTransferTimer(entry);
      if (entry.phase === 'receiving') {
        entry.timer = timerStart(() => expireTransfer(entry, id).catch(error => effects.onError?.(error)), transferTimeout);
      }
    }
    async function expireTransfer(entry, id) {
      if (transfers.get(id) !== entry || entry.phase !== 'receiving') return;
      clearTransferTimer(entry);
      entry.controller.abort();
      await entry.chain.catch(() => {});
      try { if (transfers.get(id) === entry && entry.writer) { await cleanup(entry); transfers.delete(id); } } finally { effects.onActivity?.(); }
    }
    function metadata(message) {
      if (typeof message.filename !== 'string' || !message.filename.trim() || message.filename.length > 250
        || typeof message.mime !== 'string' || message.mime.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(message.mime)
        || !Number.isSafeInteger(message.size) || message.size < 1 || message.size > MAX_BYTES) {
        throw new Error('Некорректные параметры файла');
      }
    }
    async function blobMessage(message, sender) {
      const currentOwner = owner(sender);
      if (!UUID.test(message.transferId || '')) throw new Error('Некорректный transferId');
      if (message.t === 'mendosave-blob-open') {
        metadata(message);
        if (transfers.has(message.transferId) || transfers.size >= 4) throw new Error('Передача уже открыта или лимит достигнут');
        const entry = { owner: currentOwner, packageId: message.packageId, packageIndex: message.packageIndex,
          filename: effects.archive.safeName(message.filename),
          mime: message.mime, size: message.size, bytes: 0, sequence: 0, phase: 'receiving', chain: Promise.resolve(),
          controller: new AbortController() };
        const p = message.packageId !== undefined ? position(entry) : null;
        if (p) {
          claim(entry);
          const abort = () => entry.controller.abort(p.controller.signal.reason);
          p.controller.signal.addEventListener('abort', abort, { once: true });
          entry.detach = () => p.controller.signal.removeEventListener('abort', abort);
        }
        transfers.set(message.transferId, entry);
        entry.chain = spool('mendo-transfer', entry.size).then(result => Object.assign(entry, result));
        refreshTransferTimer(entry, message.transferId);
        try {
          await entry.chain;
          entry.controller.signal.throwIfAborted();
          if (p) position(entry);
        } catch (error) {
          if (entry.writer) await cleanup(entry);
          clearTransferTimer(entry); entry.detach?.(); entry.release?.(); transfers.delete(message.transferId); throw error;
        }
        return { ok: true };
      }
      const entry = transfers.get(message.transferId);
      if (!entry || !sameOwner(entry.owner, currentOwner)) throw new Error('Передача не принадлежит этому документу');
      if (message.t === 'mendosave-blob-abort') entry.controller.abort();
      const task = entry.chain.then(async () => {
        if (entry.closed) throw new Error('Передача уже закрыта');
        if (message.t === 'mendosave-blob-abort') {
          await cleanup(entry); transfers.delete(message.transferId); return { ok: true, cancelled: true };
        }
        entry.controller.signal.throwIfAborted();
        if (entry.packageId !== undefined) {
          if ((message.packageIndex !== undefined && message.packageIndex !== entry.packageIndex)
            || (message.packageId !== undefined && message.packageId !== entry.packageId)) {
            throw new Error('Блок не принадлежит позиции передачи');
          }
          position(entry);
        }
        if (message.t === 'mendosave-blob-chunk') {
          if (message.sequence !== entry.sequence || typeof message.data !== 'string'
            || message.data.length > Math.ceil(CHUNK_BYTES / 3) * 4
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) {
            throw new Error('Некорректный блок передачи');
          }
          const decoded = atob(message.data);
          if (!decoded.length || decoded.length > CHUNK_BYTES || decoded.length > entry.size - entry.bytes) {
            throw new Error('Размер блока превышает объявленный файл');
          }
          await entry.writer.write(Uint8Array.from(decoded, character => character.charCodeAt(0)));
          entry.bytes += decoded.length; entry.sequence++;
          entry.controller.signal.throwIfAborted();
          refreshTransferTimer(entry, message.transferId);
          return { ok: true };
        }
        if (entry.bytes !== entry.size) throw new Error('Файл передан не полностью');
        entry.phase = 'saving';
        clearTransferTimer(entry);
        await entry.writer.close(); entry.closed = true;
        const source = await entry.file.getFile();
        if (source.size !== entry.size) throw new Error('Размер сохранённого файла не совпадает');
        const file = new File([source], entry.filename, { type: entry.mime });
        if (entry.packageId !== undefined) position(entry);
        const job = { get cancelled() { return entry.controller.signal.aborted; } };
        const response = entry.packageId
          ? await host.output(currentOwner, entry.packageId, file, entry.filename, job)
          : { ok: true, id: await effects.saveBlob(file, entry.filename, job), filename: entry.filename };
        entry.controller.signal.throwIfAborted();
        await cleanup(entry); transfers.delete(message.transferId);
        return response;
      });
      entry.chain = task.catch(async error => {
        await cleanup(entry).catch(() => {}); transfers.delete(message.transferId); throw error;
      });
      return entry.chain;
    }
    async function releasePackage(p) {
      const release = reservations.get(p);
      reservations.delete(p);
      await release?.();
    }
    async function beginPackage(currentOwner, message) {
      if (beginning || reservations.size) throw new Error('Другой пакет ещё выполняется');
      beginning = true;
      let p;
      try {
        // Claim the owner synchronously, but keep positions closed until the
        // asynchronous storage admission has supplied its cleanup lease.
        const result = await host.begin(currentOwner, message);
        p = host.active;
        const release = await effects.reservePackage?.(p);
        if (release) reservations.set(p, release);
        p.controller.signal.throwIfAborted();
        return result;
      } catch (error) {
        if (p && host.active === p) await host.cancel(currentOwner, message).catch(() => {});
        if (p) await releasePackage(p);
        throw error;
      } finally { beginning = false; }
    }
    async function cancelPackage(currentOwner, message) {
      const p = host.owned(currentOwner, message.packageId, true);
      try {
        const result = await host.cancel(currentOwner, message);
        await Promise.allSettled([...transfers.entries()].filter(([, entry]) => entry.packageId === message.packageId)
          .map(async ([id, entry]) => {
            await entry.chain.catch(() => {});
            try { if (transfers.get(id) === entry && entry.writer) { await cleanup(entry); transfers.delete(id); } } finally { effects.onActivity?.(); }
          }));
        return result;
      } finally { await releasePackage(p); }
    }
    function sourceUrl(value) {
      if (typeof value !== 'string' || value.length > 16384) throw new Error('Некорректный адрес медиа');
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname);
      if (url.protocol !== 'https:' || url.username || url.password || url.port
        || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
        || hostname.startsWith('[')
        || (ipv4 && (+ipv4[1] === 0 || +ipv4[1] === 10 || +ipv4[1] === 127 || +ipv4[1] >= 224
          || (+ipv4[1] === 169 && +ipv4[2] === 254) || (+ipv4[1] === 192 && +ipv4[2] === 168)
          || (+ipv4[1] === 172 && +ipv4[2] >= 16 && +ipv4[2] <= 31)))
        || (effects.allowedUrl && !effects.allowedUrl(url.href))) throw new Error('Адрес медиа не разрешён');
      return url.href;
    }
    async function sourceMessage(message, sender) {
      if (sender?.url) {
        try { const parsed = new URL(sender.url); parsed.hash = ''; sender = { ...sender, url: parsed.href }; }
        catch { throw new Error('Invalid background URL'); }
      }
      if (sender?.id !== effects.runtimeId || sender.tab
        || (sender.url && sender.url !== effects.getURL('_generated_background_page.html')
          && sender.url !== effects.getURL('background.js'))) throw new Error('Источник доступен только background');
      const currentOwner = message.sourceOwner;
      if (!currentOwner || !Number.isInteger(currentOwner.tabId) || currentOwner.frameId !== 0) {
        throw new Error('Владелец источника отсутствует');
      }
      const p = host.owned(currentOwner, message.packageId);
      const producer = { owner: currentOwner, packageId: p.id, packageIndex: message.packageIndex };
      claim(producer);
      sources.add(p.id);
      let entry, reader, body;
      try {
        let type, length;
        if (typeof message.url === 'string' && message.url.startsWith('data:')) {
          const match = /^data:(text\/plain|text\/vtt|application\/x-subrip);charset=utf-8,(.*)$/s.exec(message.url);
          if (!match || message.url.length > 6 * CHUNK_BYTES) throw new Error('Некорректный текстовый источник');
          const blob = new Blob([decodeURIComponent(match[2])]);
          type = match[1]; length = blob.size; body = blob.stream();
        } else {
          const url = sourceUrl(message.url);
          const response = await (effects.fetch || fetch)(url, { signal: p.controller.signal,
            redirect: 'error', credentials: 'omit' });
          body = response.body;
          if (!response.ok || !body) throw new Error(`HTTP ${response.status}`);
          const header = response.headers.get('content-length');
          if (header !== null && (!/^\d+$/.test(header) || !Number.isSafeInteger(Number(header)))) {
            throw new Error('Некорректный Content-Length');
          }
          length = header === null ? null : Number(header);
          if (length !== null && (length < 1 || length > MAX_BYTES)) throw new Error('Размер источника превышает лимит');
          type = message.mime || response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
        }
        metadata({ filename: message.filename, mime: type, size: length ?? 1 });
        p.controller.signal.throwIfAborted();
        entry = await spool('mendo-transfer', length ?? 0);
        reader = body.getReader();
        let bytes = 0;
        while (true) {
          p.controller.signal.throwIfAborted();
          position(producer);
          const { done, value } = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array) || value.byteLength > MAX_BYTES - bytes
            || (length !== null && value.byteLength > length - bytes)) throw new Error('Размер источника не совпадает');
          if (length === null) await quota(value.byteLength);
          await entry.writer.write(value); bytes += value.byteLength;
        }
        if (!bytes || (length !== null && bytes !== length)) throw new Error('Источник передан не полностью');
        p.controller.signal.throwIfAborted();
        await entry.writer.close(); entry.closed = true;
        const source = await entry.file.getFile();
        if (source.size !== bytes) throw new Error('Размер сохранённого источника не совпадает');
        const file = new File([source], message.filename, { type });
        position(producer);
        return await host.output(currentOwner, p.id, file, message.filename,
          { get cancelled() { return p.controller.signal.aborted; } });
      } finally {
        await reader?.cancel().catch(() => {});
        if (!reader) await body?.cancel().catch(() => {});
        reader?.releaseLock();
        try { if (entry) await cleanup(entry); }
        finally { producer.release(); sources.delete(p.id); }
      }
    }
    function connect(port) {
      if (sweeping) { port.disconnect?.(); return false; }
      if (port?.name?.startsWith('mendosave-transfer:')) {
        const id = port.name.slice('mendosave-transfer:'.length);
        const entry = transfers.get(id);
        try {
          if (!entry || entry.portConnected || !sameOwner(owner(port.sender), entry.owner)) {
            throw new Error('Передача не принадлежит порту');
          }
        } catch { port.disconnect?.(); return false; }
        entry.portConnected = true;
        refreshTransferTimer(entry, id);
        port.onDisconnect.addListener(() => expireTransfer(entry, id).catch(error => effects.onError?.(error)));
        return true;
      }
      if (!port?.name?.startsWith('mendosave-package:')) return false;
      let currentOwner, p;
      try {
        currentOwner = owner(port.sender);
        p = host.owned(currentOwner, port.name.slice('mendosave-package:'.length));
      } catch { port.disconnect?.(); return false; }
      port.onDisconnect.addListener(() => {
        if (host.active !== p) return Promise.resolve();
        return cancelPackage(currentOwner, { packageId: p.id }).catch(() => {}).finally(() => effects.onActivity?.());
      });
      return true;
    }
    async function writeArchive(entries, signal, p) {
      const total = entries.reduce((sum, entry) => sum + entry.size, 0);
      if (!Number.isSafeInteger(total) || total > MAX_BYTES - 65536
        || entries.some(entry => !(entry.blob instanceof Blob) || entry.blob.size !== entry.size)) {
        throw new Error('Некорректные файлы архива или превышен лимит');
      }
      signal.throwIfAborted();
      const entry = await spool('mendo-archives', total + 65536);
      archives.set(p.id, entry);
      entry.writer.releaseLock();
      await effects.archive.write(entries.map(file => ({ name: file.filename, blob: file.blob })), entry.writable,
        { signal, maxBytes: MAX_BYTES, onProgress: value => effects.notify?.(p, value, 'archiving') });
      entry.closed = true;
      const source = await entry.file.getFile();
      return new File([source], `${p.title}.zip`, { type: 'application/zip' });
    }
    async function finishPackage(currentOwner, message) {
      const p = host.owned(currentOwner, message.packageId);
      if (p.busy) throw new Error('Пакет уже сохраняется');
      try { return await host.finish(currentOwner, message); }
      finally {
        try {
          const entry = archives.get(message.packageId);
          if (entry) { await cleanup(entry); archives.delete(message.packageId); }
        } finally { if (host.active !== p) await releasePackage(p); }
      }
    }
    function handle(message, sender) {
      const action = PACKAGE_ROUTES.get(message?.t);
      const run = callback => Promise.resolve().then(() => {
        if (sweeping) throw new Error('Временное хранилище ещё очищается');
        return callback();
      }).catch(failure);
      if (message?.t === 'mendosave-save-source') return run(() => sourceMessage(message, sender));
      if (BLOB_ROUTES.has(message?.t)) return run(() => blobMessage(message, sender));
      if (!action) return undefined;
      if (action === 'begin') return run(() => beginPackage(owner(sender), message));
      if (action === 'cancel') return run(() => cancelPackage(owner(sender), message));
      if (action === 'finish') return run(() => finishPackage(owner(sender), message));
      return run(() => {
        if (beginning) throw new Error('Пакет ещё подготавливается');
        return host[action](owner(sender), message);
      });
    }
    return { host, handle, connect, output, positionAvailable, initialize, sweep,
      jobsActive: () => sweeping || workActive() };
  }
  globalThis.MendoPackageIO = { create };
})();

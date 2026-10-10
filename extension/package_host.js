(() => {
  class PackageHost {
    constructor(effects) { this.effects = effects; this.active = null; }
    async begin(owner, request) {
      if (this.active) throw new Error('Другой пакет уже выполняется');
      if (!Number.isInteger(owner.tabId) || owner.frameId !== 0
        || !/^[A-Za-z0-9_-]{1,100}$/.test(request.packageId || '')
        || !['files', 'zip'].includes(request.mode) || typeof request.title !== 'string' || request.title.length > 250
        || !Array.isArray(request.items) || !request.items.length || request.items.length > 20
        || (request.mode === 'zip' && request.items.length < 2)
        || request.items.some(item => !item || typeof item.id !== 'string' || !item.id.length || item.id.length > 100
          || typeof item.label !== 'string' || !item.label.length || item.label.length > 250)
        || new Set(request.items.map(item => item.id)).size !== request.items.length) {
        throw new Error('Некорректный план пакета');
      }
      this.active = { owner: { ...owner }, id: request.packageId, mode: request.mode, title: request.title,
        items: request.items.map(item => ({ id: item.id, label: item.label })), entries: [], index: -1,
        phase: 'processing', controller: new AbortController(), busy: false };
      return { ok: true };
    }
    owned(owner, id, allowCancelled = false) {
      const p = this.active;
      if (!p || p.id !== id || p.owner.tabId !== owner.tabId || owner.frameId !== 0
        || p.owner.documentId !== owner.documentId) throw new Error('Пакет не принадлежит этому документу');
      if (!allowCancelled && p.controller.signal.aborted) {
        const error = new Error('Пакет отменён'); error.name = 'AbortError'; error.cancelled = true; throw error;
      }
      return p;
    }
    next(owner, request) {
      const p = this.owned(owner, request.packageId);
      if (!Number.isInteger(request.index) || request.index !== p.entries.length || request.index >= p.items.length
        || p.busy || (p.index >= 0 && !p.entries[p.index]?.complete)) throw new Error('Недопустимый порядок очереди');
      p.index = request.index;
      return { ok: true };
    }
    async output(owner, id, blob, filename, job) {
      const p = this.owned(owner, id);
      if (p.index < 0 || p.entries[p.index] || p.busy || !blob?.size || !Number.isSafeInteger(blob.size)) {
        throw new Error('Результат не соответствует текущей позиции');
      }
      const name = this.effects.names([...p.entries.map(entry => entry.filename), filename]).at(-1);
      if (p.mode === 'zip' && p.entries.reduce((sum, entry) => sum + entry.size, 0) + blob.size
        > (this.effects.maxBytes || 1024 ** 3) - 65536) throw new Error('Пакет превышает лимит временного хранилища');
      p.busy = true;
      try {
        let entry, downloadId;
        if (p.mode === 'zip') {
          entry = await this.effects.prepare(blob, name, p.controller.signal, p.id);
        } else {
          downloadId = await this.effects.save(blob, name, job || { get cancelled() { return p.controller.signal.aborted; } });
          entry = { filename: name, size: blob.size, saved: true };
        }
        p.entries.push({ ...entry, filename: name, size: blob.size, complete: false });
        this.owned(owner, id);
        return { ok: true, collected: p.mode === 'zip', filename: name, ...(p.mode === 'files' ? { id: downloadId } : {}) };
      } finally {
        p.busy = false;
        if (p.controller.signal.aborted && this.active === p) this.active = null;
      }
    }
    complete(owner, request) {
      const p = this.owned(owner, request.packageId);
      if (request.index !== p.index || !p.entries[p.index] || p.busy) throw new Error('Файл не завершён');
      p.entries[p.index].complete = true;
      return { ok: true };
    }
    async finish(owner, request) {
      const p = this.owned(owner, request.packageId);
      if (p.busy || p.entries.length !== p.items.length || p.entries.some(entry => !entry.complete)) {
        throw new Error('Пакет не завершён: ZIP не создаётся');
      }
      p.busy = true;
      p.phase = 'saving';
      try {
        let filename;
        if (p.mode === 'zip') {
          filename = this.effects.names([`${p.title}.zip`])[0];
          const blob = await this.effects.archive(p.entries, p.controller.signal, p);
          this.owned(owner, p.id);
          await this.effects.save(blob, filename, { get cancelled() { return p.controller.signal.aborted; } });
          this.owned(owner, p.id);
          await this.effects.discard(p.entries);
        }
        p.phase = 'complete';
        return { ok: true, ...(filename ? { filename } : {}), count: p.entries.length };
      } finally {
        p.busy = false;
        this.active = null;
      }
    }
    async cancel(owner, request) {
      const p = this.owned(owner, request.packageId, true);
      p.phase = request.reason === 'error' ? 'error' : 'cancelled';
      p.controller.abort();
      try { await this.effects.cancelWork?.(p); }
      finally { if (!p.busy && this.active === p) this.active = null; }
      return { ok: true, retained: p.entries.length };
    }
  }
  globalThis.MendoPackageHost = { PackageHost };
  if (typeof module !== 'undefined') module.exports = { PackageHost };
})();

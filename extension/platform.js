// Host admission and disposal share one controller. Producers reserve before
// creation, so ensure-to-begin and gaps between package entries are protected.
globalThis.MendoProcessorHost = {
  creation: null, closing: null, instance: null, reservations: new Set(), producers: new Map(), revision: 0,
  reserve() {
    const token = {}; this.reservations.add(token); this.revision++;
    return () => { if (this.reservations.delete(token)) { this.revision++; this.maybeClose(); } };
  },
  async ensure() { return this.withHost(() => undefined); },
  async withHost(action) {
    const release = this.reserve();
    try { await this.ready(); return await action(this.instance); }
    finally { release(); }
  },
  async ready() {
    if (this.closing) await this.closing;
    if (this.instance?.ready && this.instance.port) return;
    if (!this.creation) this.creation = Promise.resolve().then(async () => {
      if (this.instance?.ready && await this.health(this.instance)) return;
      if (this.instance?.handle) await this.probe(this.instance);
      else await this.open();
    })
      .finally(() => { this.creation = null; this.maybeClose(); });
    return this.creation;
  },
  async health(instance) {
    // Idle ACK deliberately disconnects the work port. Its cached readiness
    // cannot prove that the iframe/context survived until the next admission.
    const ready = await chrome.runtime.sendMessage({ t: 'mendosave-host-probe', instanceId: instance.id }).catch(() => null);
    if (ready?.ok && (ready.instanceId === instance.id || instance.legacy)) {
      if (!instance.port) { instance.active = Boolean(ready.active); instance.workRevision = ready.revision || 0; }
      return true;
    }
    if (instance.port || instance.active) throw new Error('Media processor is unavailable while work is active');
    const canDispose = () => this.instance === instance && !instance.port && !instance.active;
    if (!instance.handle?.owned) {
      // A context adopted after a Chromium restart is not ours to destroy.
      const backend = globalThis.MendoHostBackend;
      if (!backend?.canRestore || await backend.canRestore(instance.url)) throw new Error('Existing media processor is unavailable');
    } else if (await instance.handle.close(canDispose) === false) {
      if (this.instance === instance && instance.port) return true;
      throw new Error('Media processor became active during revalidation');
    }
    if (!canDispose()) {
      if (this.instance === instance && instance.port) return true;
      throw new Error('Media processor became active during revalidation');
    }
    if (this.instance === instance) this.instance = null;
    instance.ready = false;
    for (const [producer, owner] of this.producers) if (owner === instance) producer.disconnect();
    return false;
  },
  async open() {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const url = `${chrome.runtime.getURL('offscreen.html')}#mendosave-host=${id}`;
    const instance = { id, url, ready: false, active: true, workRevision: 0, port: null, handle: null };
    this.instance = instance;
    try {
      const backend = globalThis.MendoHostBackend;
      if (!backend) throw new Error('Media processor backend is unavailable');
      instance.handle = await backend.open(url);
      instance.url = instance.handle.url || url;
      const nonce = /^#mendosave-host=([A-Za-z0-9_-]+)$/.exec(new URL(instance.url).hash);
      instance.id = nonce?.[1] || 'legacy';
      instance.legacy = !nonce;
      try { await this.probe(instance); }
      catch (error) {
        // A silent iframe has admitted no work. A live startup/recovery port
        // must settle before disposal; never turn its timeout into data loss.
        if (instance.handle.kind !== 'iframe' || !backend.fallback || (instance.seenPort && instance.active)) throw error;
        if (await instance.handle.close(() => this.instance === instance && (!instance.seenPort || !instance.active)) === false) throw error;
        instance.id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        instance.url = `${chrome.runtime.getURL('offscreen.html')}#mendosave-host=${instance.id}`;
        instance.port = null; instance.seenPort = false; instance.workRevision = 0; instance.active = true;
        instance.handle = await backend.fallback(instance.url);
        await this.probe(instance);
      }
    } catch (error) {
      instance.failed = true;
      if (instance.handle?.owned && (!instance.seenPort || !instance.active)) {
        const disposed = await instance.handle.close(() => this.instance === instance && (!instance.seenPort || !instance.active)).catch(() => false);
        if (disposed !== false && this.instance === instance) this.instance = null;
      } else if (!instance.handle && this.instance === instance) this.instance = null;
      throw error;
    }
  },
  async probe(instance) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await chrome.runtime.sendMessage({ t: 'mendosave-host-probe', instanceId: instance.id }).catch(() => null);
      if (ready?.ok && (ready.instanceId === instance.id || instance.legacy)) {
        instance.ready = true; instance.failed = false;
        if (!instance.port) { instance.active = Boolean(ready.active); instance.workRevision = ready.revision || 0; }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Обработчик медиа не запустился. Повторите загрузку.');
  },
  isProcessor(sender) {
    return sender?.id === chrome.runtime.id && Boolean(this.instance) && sender.url === this.instance.url;
  },
  async restore(sender) {
    if (this.isProcessor(sender)) return true;
    if (this.creation) { await this.creation.catch(() => {}); return this.isProcessor(sender); }
    if (this.instance || sender?.id !== chrome.runtime.id || !globalThis.MendoHostBackend?.canRestore) return false;
    if (!await MendoHostBackend.canRestore(sender.url)) return false;
    return this.withHost(() => this.isProcessor(sender));
  },
  connect(port) {
    if (port.name === 'mendosave-producer') {
      if (port.sender?.id !== chrome.runtime.id || !Number.isInteger(port.sender?.tab?.id)) { port.disconnect(); return true; }
      const release = this.reserve(); let connected = true;
      port.onDisconnect.addListener(() => { connected = false; this.producers.delete(port); release(); });
      this.ready().then(() => {
        if (!connected) return;
        this.producers.set(port, this.instance);
        port.postMessage({ ok: true, instanceId: this.instance.id });
      }, error => {
        if (!connected) return;
        try { port.postMessage({ ok: false, error: String(error?.message || error) }); } finally { port.disconnect(); }
      }).catch(() => port.disconnect());
      return true;
    }
    if (port.name !== 'mendosave-processor') return false;
    if (!this.isProcessor(port.sender)) { port.disconnect(); return true; }
    const instance = this.instance; instance.port = port; instance.seenPort = true;
    port.onMessage.addListener(message => {
      if (this.instance !== instance || instance.port !== port || message?.instanceId !== instance.id
        || !Number.isSafeInteger(message.revision) || message.revision < instance.workRevision || typeof message.active !== 'boolean') return;
      instance.workRevision = message.revision; instance.active = message.active; this.revision++;
      if (!message.active) {
        try { port.postMessage({ t: 'mendosave-idle-ack', instanceId: instance.id, revision: message.revision }); } catch (error) {}
      }
      if (!message.active) this.maybeClose();
    });
    port.onDisconnect.addListener(() => {
      if (instance.port !== port) return;
      instance.port = null;
      if (instance.active) {
        // An active port disappearing is a lost host, not a successful idle.
        instance.ready = false;
        for (const [producer, owner] of this.producers) if (owner === instance) producer.disconnect();
        if (!this.closing) this.closing = Promise.resolve().then(async () => {
          const disposed = instance.handle?.owned
            ? await instance.handle.close(() => this.instance === instance && !instance.port) : false;
          if (disposed !== false && this.instance === instance) this.instance = null;
        }).catch(() => {}).finally(() => { this.closing = null; });
      } else this.maybeClose();
    });
    return true;
  },
  maybeClose() {
    const instance = this.instance;
    if ((!instance?.ready && !instance?.failed) || !instance.handle?.owned || instance.active || this.reservations.size || this.creation || this.closing) return;
    const revision = this.revision;
    this.closing = Promise.resolve().then(async () => {
      if (this.instance !== instance || revision !== this.revision || this.reservations.size || instance.active) return;
      const sealed = await chrome.runtime.sendMessage({ t: 'mendosave-host-close', instanceId: instance.id, revision: instance.workRevision }).catch(() => null);
      if (!sealed?.ok) { await this.health(instance); return; }
      if (this.instance !== instance || revision !== this.revision || this.reservations.size || instance.active) {
        await chrome.runtime.sendMessage({ t: 'mendosave-host-resume', instanceId: instance.id }).catch(() => null);
        return;
      }
      const canDispose = () => this.instance === instance && revision === this.revision && !this.reservations.size && !instance.active;
      if (await instance.handle.close(canDispose) === false) {
        await chrome.runtime.sendMessage({ t: 'mendosave-host-resume', instanceId: instance.id }).catch(() => null);
        return;
      }
      if (this.instance === instance) this.instance = null;
    }).catch(async () => {
      const resumed = await chrome.runtime.sendMessage({ t: 'mendosave-host-resume', instanceId: instance.id }).catch(() => null);
      if (!resumed?.ok && this.instance === instance && !instance.port && !instance.active) this.instance = null;
    }).finally(() => { this.closing = null; if (this.revision !== revision) this.maybeClose(); });
  },
};

globalThis.MendoHostBackend = {
  async canRestore(url) {
    if (typeof url !== 'string' || typeof chrome.runtime.getContexts !== 'function') return false;
    const parsed = new URL(url); parsed.hash = '';
    if (parsed.href !== chrome.runtime.getURL('offscreen.html')) return false;
    return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).some(context => context.documentUrl === url);
  },
  async open(url) {
    const contexts = typeof chrome.runtime.getContexts === 'function'
      ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) : [];
    const existing = contexts[0];
    const exists = Boolean(existing) || (typeof chrome.offscreen.hasDocument === 'function' && await chrome.offscreen.hasDocument());
    if (!exists) await chrome.offscreen.createDocument({
      url, reasons: ['WORKERS', 'BLOBS'],
      justification: 'Process media locally using bundled workers.',
    });
    const actualUrl = existing?.documentUrl || (exists ? chrome.runtime.getURL('offscreen.html') : url);
    const parsed = new URL(actualUrl), hash = parsed.hash; parsed.hash = '';
    if (parsed.href !== chrome.runtime.getURL('offscreen.html')) throw new Error('An unrelated offscreen context is already open');
    const ownershipKey = 'mendo_processor_host';
    const saved = await chrome.storage?.session?.get(ownershipKey).catch(() => ({}));
    const owned = !exists || (saved?.[ownershipKey]?.url === actualUrl && /^#mendosave-host=[A-Za-z0-9_-]+$/.test(hash));
    if (!exists) await chrome.storage?.session?.set({ [ownershipKey]: { url: actualUrl } }).catch(() => {});
    return { url: actualUrl, owned, async close(canClose = () => true) {
      const current = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!canClose()) return false;
      if (owned && current.some(context => context.documentUrl === actualUrl)) {
        await chrome.offscreen.closeDocument();
        const owner = await chrome.storage?.session?.get(ownershipKey);
        if (owner?.[ownershipKey]?.url === actualUrl) await chrome.storage.session.remove(ownershipKey).catch(() => {});
      }
      return owned;
    } };
  },
};

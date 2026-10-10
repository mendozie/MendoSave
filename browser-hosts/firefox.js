// Firefox event pages have DOM. An active processor port owns their lifetime.
globalThis.MendoHostBackend = {
  async open(url) {
    let frame;
    try {
      frame = document.createElement('iframe');
      frame.hidden = true;
      frame.src = url;
      (document.body || document.documentElement).append(frame);
      return { url, kind: 'iframe', owned: true, async close(canClose = () => true) {
        if (!canClose()) return false;
        frame.remove(); return true;
      } };
    } catch (error) {
      frame?.remove();
      // Never adopt a same-URL user tab: only this returned ID may be closed.
      return this.fallback(url);
    }
  },
  async fallback(url) {
    const tab = await chrome.tabs.create({ url, active: false, pinned: true });
    return { url, kind: 'tab', owned: true, tabId: tab.id, async close(canClose = () => true) {
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (!canClose()) return false;
      if (current?.url === url) await chrome.tabs.remove(tab.id);
      return true;
    } };
  },
};

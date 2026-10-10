// Only the host differs. The media processor and its workers stay bundled.
globalThis.MendoProcessorHost = {
  creation: null,
  async ensure() {
    if (!this.creation) {
      this.creation = this.open().finally(() => { this.creation = null; });
    }
    return this.creation;
  },
  async open() {
    const url = chrome.runtime.getURL('offscreen.html');
    if (globalThis.MendoHostBackend) await MendoHostBackend.open(url);
    else {
      const tabs = await chrome.tabs.query({});
      if (!tabs.some((tab) => tab.url === url)) await chrome.tabs.create({ url, active: false, pinned: true });
    }
    // Creation resolves before scripts have registered. Do not lose the first job.
    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await chrome.runtime.sendMessage({ t: 'mendosave-host-probe' }).catch(() => null);
      if (ready?.ok) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Обработчик медиа не запустился. Повторите загрузку.');
  },
};

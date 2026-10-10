globalThis.MendoHostBackend = {
  async open(url) {
    const exists = typeof chrome.offscreen.hasDocument === 'function'
      ? await chrome.offscreen.hasDocument()
      : (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })).length > 0;
    if (!exists) await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['WORKERS', 'BLOBS'],
      justification: 'Process media locally using bundled workers.',
    });
  },
};

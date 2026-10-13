// Bundled MAIN-world observer in the controlled native VK embed document.
// It never makes an API request or reads/transfers its request body or headers.
(() => {
  const schema = globalThis.MendoVKSource;
  const own = schema?.source(location.href);
  if (!own || location.pathname !== '/video_ext.php' || window.__mendosaveVKBridge) return;
  window.__mendosaveVKBridge = true;
  const TO_PLAYER = '__mendosave_vk_to_player';
  const FROM_PLAYER = '__mendosave_vk_from_player';
  const MAX_SOURCE_URL_LENGTH = 8192;
  const parent = window.parent;
  const frameHref = location.href;
  const pending = new Map();
  let captured;

  function matchingParentSource(request) {
    if (typeof request.sourceHref !== 'string' || request.sourceHref.length > MAX_SOURCE_URL_LENGTH) return false;
    const source = schema.source(request.sourceHref);
    return schema.same(source, own) && source.href === request.sourceHref
      && new URL(source.href).origin === location.origin;
  }
  function send(request) {
    // The parent can be opaque despite matching URL origins. Correlate its
    // canonical request; the isolated consumer rechecks its actual source.
    if (location.href !== frameHref || !matchingParentSource(request)) return;
    parent.postMessage({ [FROM_PLAYER]: true, kind: 'result', frameHref,
      requestId: request.requestId, sourceHref: request.sourceHref, oid: own.oid, id: own.id,
      ...captured }, location.origin);
  }
  function record(result) {
    if (location.href !== frameHref) return;
    captured = result;
    for (const request of pending.values()) send(request);
    pending.clear();
  }
  function capture(text) {
    try {
      if (typeof text !== 'string' || text.length > schema.MAX_RESPONSE_BYTES
        || new TextEncoder().encode(text).byteLength > schema.MAX_RESPONSE_BYTES) throw schema.error('RESPONSE_TOO_LARGE');
      record({ video: schema.embed(JSON.parse(text), own) });
    } catch (failure) { record({ code: failure.code || 'INVALID_RESPONSE' }); }
  }
  window.addEventListener('message', event => {
    const request = event.data;
    if (location.href !== frameHref || event.source !== parent || event.origin !== location.origin || !request || request[TO_PLAYER] !== true
      || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(request.requestId)
      || request.frameHref !== frameHref) return;
    if (request.kind === 'cancel') { pending.delete(request.requestId); return; }
    if (request.kind !== 'request' || !schema.same(schema.ids(request.oid, request.id), own)) return;
    if (!matchingParentSource(request)) return;
    if (captured) send(request);
    else if (pending.size < 4) pending.set(request.requestId, { requestId: request.requestId, sourceHref: request.sourceHref });
  });

  function endpoint(value) {
    try {
      const url = new URL(value, location.origin);
      return url.protocol === 'https:' && url.hostname === 'api.vk.ru' && !url.port && !url.username && !url.password
        && url.pathname === '/method/video.getEmbed';
    } catch (failure) { return false; }
  }
  async function readResponse(response) {
    if (!response.ok || (response.url && !endpoint(response.url))) { record({ code: 'PLAYER_UNAVAILABLE' }); return; }
    const clone = response.clone();
    if (Number(clone.headers.get('content-length')) > schema.MAX_RESPONSE_BYTES) {
      // A cloned body is a tee: awaiting cancellation can wait for the page's
      // original reader. Classification must not depend on its consumption.
      clone.body?.cancel().catch(() => {});
      record({ code: 'RESPONSE_TOO_LARGE' }); return;
    }
    const reader = clone.body?.getReader();
    if (!reader) { capture(await clone.text()); return; }
    const decoder = new TextDecoder();
    let text = '', bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > schema.MAX_RESPONSE_BYTES) {
          reader.cancel().catch(() => {}); record({ code: 'RESPONSE_TOO_LARGE' }); return;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      capture(text + decoder.decode());
    } finally { reader.releaseLock(); }
  }
  if (typeof window.fetch === 'function') {
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      const result = nativeFetch.apply(this, arguments);
      const url = typeof input === 'string' || input instanceof URL ? input : input?.url;
      if (endpoint(url)) Promise.resolve(result).then(readResponse)
        .catch(() => record({ code: 'PLAYER_UNAVAILABLE' }));
      return result;
    };
  }
  if (typeof window.XMLHttpRequest === 'function') {
    const prototype = window.XMLHttpRequest.prototype;
    const open = prototype.open, sendNative = prototype.send;
    const selected = new WeakSet();
    prototype.open = function (method, url) {
      selected.delete(this);
      if (endpoint(url)) selected.add(this);
      return open.apply(this, arguments);
    };
    prototype.send = function () {
      if (selected.has(this)) this.addEventListener('load', () => {
        if (this.status < 200 || this.status >= 300 || (this.responseURL && !endpoint(this.responseURL))) {
          record({ code: 'PLAYER_UNAVAILABLE' }); return;
        }
        try {
          if (this.responseType === 'json') {
            capture(JSON.stringify(this.response));
          } else if (!this.responseType || this.responseType === 'text') capture(this.responseText);
        } catch (failure) { record({ code: 'INVALID_RESPONSE' }); }
      }, { once: true });
      return sendNative.apply(this, arguments);
    };
  }
  parent.postMessage({ [FROM_PLAYER]: true, kind: 'ready', frameHref }, location.origin);
})();

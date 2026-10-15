// Bundled page-world metadata reader. Authentication stays in the site's context.
(() => {
  const schema = globalThis.MendoInstagramSource;
  if (!schema || location.origin !== 'https://www.instagram.com' || window.__mendosaveInstagramBridge) return;
  window.__mendosaveInstagramBridge = true;
  let active = null;
  let lastNetwork = 0;
  function current(request) {
    const own = schema.source(location.href);
    return own && schema.same(own, schema.source(request.sourceHref)) && request.sourceHref === own.href;
  }
  function embedded(selected) {
    let bytes = 0, visited = 0;
    let rejected = null;
    const hasSources = value => ['image_versions2', 'video_versions', 'video_dash_manifest',
      'carousel_media', 'display_resources', 'display_url', 'video_url', 'dash_info', 'edge_sidecar_to_children']
      .some(key => value[key] != null && (typeof value[key] === 'string' || Array.isArray(value[key])
        ? value[key].length > 0 : true));
    for (const script of document.scripts) {
      if (script.type !== 'application/json') continue;
      const text = script.textContent || '';
      bytes += text.length;
      if (bytes > 8 * 1024 * 1024) break;
      if (text.length > schema.MAX_RESPONSE_BYTES || !text.includes(selected.shortcode)) continue;
      let root;
      try { root = JSON.parse(text); } catch { continue; }
      const stack = [root];
      while (stack.length && ++visited <= 50000) {
        const value = stack.pop();
        if (!value || typeof value !== 'object') continue;
        if ((value.code === selected.shortcode || value.shortcode === selected.shortcode)
          && (value.media_type || ['GraphImage', 'GraphVideo', 'GraphSidecar'].includes(value.__typename))) {
          try {
            return schema.normalize(value.media_type ? { items: [value] }
              : { data: { shortcode_media: value } }, selected);
          } catch (failure) {
            // Anonymous pages also embed matching summary/shadow nodes. A
            // different complete representation may describe the same post;
            // a rejected full source must never become a partial download or
            // disappear into a network fallback.
            if (hasSources(value) || ['SOURCE_MISMATCH', 'RESPONSE_TOO_LARGE'].includes(failure.code)) {
              rejected ||= failure;
            }
          }
        }
        for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
      }
      if (visited > 50000) break;
    }
    if (rejected) throw rejected;
    return null;
  }
  async function responseJson(response) {
    if (response.status === 429) throw schema.error('RATE_LIMITED');
    if (response.status === 401 || response.status === 403 || /\/accounts\/login/.test(response.url || '')) throw schema.error('AUTH_REQUIRED');
    if (!response.ok) throw schema.error('UNAVAILABLE');
    if (response.url) {
      const target = new URL(response.url);
      if (target.origin !== location.origin || !/^\/api\/v1\/media\/\d+\/info\/$/.test(target.pathname)) throw schema.error('INVALID_RESPONSE');
    }
    if (Number(response.headers.get('content-length')) > schema.MAX_RESPONSE_BYTES) {
      response.body?.cancel().catch(() => {}); throw schema.error('RESPONSE_TOO_LARGE');
    }
    const reader = response.body?.getReader();
    if (!reader) throw schema.error('INVALID_RESPONSE');
    const decoder = new TextDecoder();
    let text = '', bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > schema.MAX_RESPONSE_BYTES) { reader.cancel().catch(() => {}); throw schema.error('RESPONSE_TOO_LARGE'); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      try { return JSON.parse(text + decoder.decode()); } catch { throw schema.error('INVALID_RESPONSE'); }
    } finally { reader.releaseLock(); }
  }
  async function load(selected, signal) {
    const post = embedded(selected);
    if (post) return post;
    if (Date.now() - lastNetwork < 2000) throw schema.error('RATE_LIMITED');
    lastNetwork = Date.now();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = 0n;
    for (const char of selected.shortcode) id = id * 64n + BigInt(alphabet.indexOf(char));
    const headers = { 'x-ig-app-id': '936619743392459' };
    const csrf = /(?:^|;\s*)csrftoken=([A-Za-z0-9_-]{1,256})(?:;|$)/.exec(document.cookie || '');
    if (csrf) headers['x-csrftoken'] = csrf[1];
    const response = await fetch(`${location.origin}/api/v1/media/${id}/info/`, {
      credentials: 'same-origin', cache: 'no-store', headers, signal, redirect: 'error',
    });
    return schema.normalize(await responseJson(response), selected);
  }
  window.addEventListener('message', event => {
    const request = event.data;
    if (event.source !== window || event.origin !== location.origin || !request || request.__mendosave_ig_request !== true
      || typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(request.requestId)) return;
    if (request.kind === 'cancel') {
      if (active?.id === request.requestId && active.sourceHref === request.sourceHref) {
        const cancelled = active;
        active = null;
        clearTimeout(cancelled.timer);
        cancelled.controller.abort();
      }
      return;
    }
    if (request.kind !== 'request' || !current(request) || active) return;
    const state = { id: request.requestId, sourceHref: request.sourceHref, controller: new AbortController() };
    active = state;
    const timer = setTimeout(() => state.controller.abort(), 12000);
    state.timer = timer;
    Promise.resolve().then(() => load(schema.source(request.sourceHref), state.controller.signal)).then(post => {
      if (!state.controller.signal.aborted && current(request)) window.postMessage({ __mendosave_ig_result: true,
        requestId: request.requestId, sourceHref: request.sourceHref, post }, location.origin);
    }).catch(failure => {
      if (!state.controller.signal.aborted && current(request)) window.postMessage({ __mendosave_ig_result: true,
        requestId: request.requestId, sourceHref: request.sourceHref, code: failure.code || 'UNAVAILABLE' }, location.origin);
    }).finally(() => { clearTimeout(timer); if (active === state) active = null; });
  });
})();

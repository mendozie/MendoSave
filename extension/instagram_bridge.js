/* global module */
// Loaded only in ISOLATED. Neither page DOM nor page-world messages can supply
// metadata: it must come from a fresh, bounded HTTPS response for this post.
(() => {
  const MAX_HTML_BYTES = 8 * 1024 * 1024;
  function create({ schema = globalThis.MendoInstagramSource, fetch: fetcher = globalThis.fetch.bind(globalThis),
    DOMParser: Parser = globalThis.DOMParser, current = () => globalThis.location.href,
    now = () => Date.now(), setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout } = {}) {
    let active = null, lastAPI = -Infinity;
    function embedded(html, selected) {
      const doc = new Parser().parseFromString(html, 'text/html');
      let visited = 0, rejected = null;
      const hasSources = value => ['image_versions2', 'video_versions', 'video_dash_manifest',
        'carousel_media', 'display_resources', 'display_url', 'video_url', 'dash_info', 'edge_sidecar_to_children']
        .some(key => value[key] != null && (typeof value[key] === 'string' || Array.isArray(value[key])
          ? value[key].length > 0 : true));
      for (const script of doc.querySelectorAll('script[type="application/json"]')) {
        const text = script.textContent || '';
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
              if (hasSources(value) || ['SOURCE_MISMATCH', 'RESPONSE_TOO_LARGE'].includes(failure.code)) rejected ||= failure;
            }
          }
          for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
        }
        if (visited > 50000) throw schema.error('RESPONSE_TOO_LARGE');
      }
      if (rejected) throw rejected;
      return null;
    }
    async function read(value, { signal } = {}) {
      const selected = schema.source(value?.href);
      if (!selected || value.shortcode !== selected.shortcode || value.href !== selected.href) throw schema.error('INVALID_RESPONSE');
      if (active && !active.controller.signal.aborted) throw schema.error('UNAVAILABLE');
      const state = { controller: new AbortController(), timedOut: false };
      const abort = () => state.controller.abort();
      const check = () => {
        if (state.timedOut) throw schema.error('TIMEOUT');
        if (state.controller.signal.aborted) throw new DOMException('Запрос отменён', 'AbortError');
        if (!schema.same(selected, schema.source(current()))) throw schema.error('SOURCE_MISMATCH');
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimer(() => { state.timedOut = true; state.controller.abort(); }, 12000);
      active = state;
      async function text(url, max, api = false) {
        check();
        const response = await fetcher(url, { credentials: 'include', cache: 'no-store', redirect: 'error',
          signal: state.controller.signal, headers: api ? { 'x-ig-app-id': '936619743392459' } : { Accept: 'text/html' } });
        let reader;
        const cancelReader = async () => {
          // Gecko can expose a stream Promise through a compartment wrapper;
          // accessing its .catch may itself throw. Preserve the real result.
          try { if (reader) await reader.cancel(); else await response.body?.cancel(); } catch {}
        };
        const cancel = () => { void cancelReader(); };
        try {
          check();
          if (response.status === 429) throw schema.error('RATE_LIMITED');
          if (response.status === 401 || response.status === 403 || /\/accounts\/login/.test(response.url || '')) throw schema.error('AUTH_REQUIRED');
          if (response.status !== 200) throw schema.error('UNAVAILABLE');
          if (response.redirected || !response.url) throw schema.error('INVALID_RESPONSE');
          const target = new URL(response.url);
          if (target.origin !== 'https://www.instagram.com' || target.href !== url) throw schema.error('SOURCE_MISMATCH');
          const declared = response.headers.get('content-length');
          if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw schema.error('INVALID_RESPONSE');
          if (Number(declared) > max) throw schema.error('RESPONSE_TOO_LARGE');
          if (!response.body?.getReader) throw schema.error('INVALID_RESPONSE');
          reader = response.body.getReader();
          state.controller.signal.addEventListener('abort', cancel, { once: true });
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let result = '', bytes = 0;
          for (;;) {
            const chunk = await reader.read(); check();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > max) throw schema.error('RESPONSE_TOO_LARGE');
            result += decoder.decode(chunk.value, { stream: true });
          }
          return result + decoder.decode();
        } finally {
          state.controller.signal.removeEventListener('abort', cancel);
          await cancelReader();
          try { reader?.releaseLock(); } catch {}
        }
      }
      try {
        check();
        const html = await text(selected.href, MAX_HTML_BYTES);
        const post = embedded(html, selected); check();
        if (post) return post;
        if (now() - lastAPI < 2000) throw schema.error('RATE_LIMITED');
        lastAPI = now();
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        let id = 0n;
        for (const char of selected.shortcode) id = id * 64n + BigInt(alphabet.indexOf(char));
        const raw = await text(`https://www.instagram.com/api/v1/media/${id}/info/`, schema.MAX_RESPONSE_BYTES, true);
        let payload;
        try { payload = JSON.parse(raw); } catch { throw schema.error('INVALID_RESPONSE'); }
        check(); return schema.normalize(payload, selected);
      } catch (failure) {
        check();
        if (failure?.code && schema.error(failure.code).code === failure.code) throw failure;
        throw schema.error('UNAVAILABLE');
      } finally {
        clearTimer(timer); signal?.removeEventListener('abort', abort);
        if (active === state) active = null;
      }
    }
    return Object.freeze({ read });
  }
  const api = Object.freeze({ MAX_HTML_BYTES, create });
  globalThis.MendoInstagramReader = api;
  if (typeof module !== 'undefined') module.exports = api;
})();

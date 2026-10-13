// VK Video adapter (vkvideo.ru, vk.com/video…).
//
// The page is a lazy SPA: no <video> exists until playback starts and the HTML
// carries no media URLs at all. Legacy `/video_ext.php` embeds the player data;
// its modern bootstrap runs native `video.getEmbed` in a controlled frame.
// The bundled observer projects only matching metadata, keeping site
// authentication in that document. Both modes return progressive MP4 files
// and `dash_sep`, with video and audio in separate AdaptationSets.
//
// Two consequences shape everything below:
//   * a single progressive file goes straight to chrome.downloads. A package
//     reads bounded ranges from the VK origin: its CDN refuses extension-
//     origin fetch, so bytes use the existing owned Blob transfer to OPFS;
//   * the DASH audio track uses SegmentBase addressing, which means each
//     representation is ONE whole MP4 addressed by byte ranges. Audio-only is
//     therefore a plain ranged download and needs no segment stitching — and it
//     is streamed to the offscreen document slice by slice, so a two-hour
//     audiobook never exists in the page in one piece.
(() => {
  let processorTask = null;
  const mendoSend = (message, task) => {
    if (task?.error && !/abort|cancel|mendosave-log|mendosave-error/.test(message.t)) {
      return Promise.reject(task.error);
    }
    if (task?.lease) return task.lease.send(message);
    return globalThis.MendoPackageUI
      ? globalThis.MendoPackageUI.send(message) : chrome.runtime.sendMessage(message);
  };
  const mendoFetch = async (url, options = {}) => {
    const task = processorTask;
    if (task?.error) throw task.error;
    if (task) options = { ...options, signal: options.signal
      ? AbortSignal.any([options.signal, task.controller.signal]) : task.controller.signal };
    try {
      const response = await (globalThis.MendoPackageUI
        ? globalThis.MendoPackageUI.fetch(url, options) : fetch(url, options));
      if (task?.error) throw task.error;
      return response;
    } catch (error) { throw task?.error || error; }
  };
  const mendoCheck = () => {
    if (processorTask?.error) throw processorTask.error;
    globalThis.MendoPackageUI?.check();
  };
  async function reserveProcessor() {
    const task = { controller: new AbortController(), error: null, lease: null };
    processorTask = task;
    try {
      task.lease = await globalThis.MendoPackageUI.acquireProcessor({
        signal: globalThis.MendoPackageUI.signal || task.controller.signal,
        onDisconnect(error) {
          if (processorTask !== task) return;
          task.error = error;
          task.controller.abort();
        },
      });
      mendoCheck();
      return task;
    } catch (error) {
      releaseProcessor(task);
      throw error;
    }
  }
  function releaseProcessor(task) {
    task?.lease?.release();
    if (processorTask === task) processorTask = null;
  }
  const packageRunning = () => Boolean(globalThis.MendoPackageUI?.running);
  function downloadInterrupted(code) {
    if (globalThis.MendoPackageUI) globalThis.MendoPackageUI.interruption(code);
    const error = new Error(`Сохранение прервано: ${code || 'причина не указана'}`);
    if (code === 'USER_CANCELED' || code === 'USER_CANCELLED') error.name = 'AbortError';
    throw error;
  }

  const BUTTON_CLASS = 'mendosave-vk-btn';
  const SLICE_BYTES = 8 * 1024 * 1024;
  const PACKAGE_SLICE_BYTES = 1024 * 1024;
  const TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;
  const VIDEO_ID_RE = /\/(?:video|clip)(-?\d+)_(\d+)/;

  let menu;
  let menuRequest;
  let busy = false;
  let toastBox;

  function log(tag, text) {
    mendoSend({ t: 'mendosave-log', tag: `vk/${tag}`, text }).catch(() => {});
  }

  function reportError(context, error, details) {
    console.error('[MendoSave]', error);
    return mendoSend({
      t: 'mendosave-error', context, error: String(error?.stack || error?.message || error), details,
    }).catch(() => null);
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function safeName(value) {
    return String(value || '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 110);
  }

  function formatBytes(size) {
    const value = Number(size) || 0;
    if (!value) return '';
    return value >= 1e6 ? `${(value / 1e6).toFixed(1)} МБ` : `${Math.round(value / 1e3)} КБ`;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
      : `${minutes}:${String(rest).padStart(2, '0')}`;
  }

  // ---- player payload --------------------------------------------------------

  function videoIdFrom(href) {
    const match = VIDEO_ID_RE.exec(String(href || ''));
    return match ? { oid: match[1], id: match[2] } : null;
  }

  // The payload is HTML with an embedded JSON blob; `files` is pulled out by
  // brace matching rather than by a regex, because the URLs inside carry
  // escaped slashes and their own punctuation.
  function extractObject(html, key, from = 0) {
    const at = html.indexOf(`"${key}"`, from);
    if (at < 0) return null;
    let open = at + key.length + 2;
    while (/\s/.test(html[open] || 'x')) open += 1;
    if (html[open++] !== ':') return null;
    while (/\s/.test(html[open] || 'x')) open += 1;
    if (html[open] !== '{') return null;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = open; index < html.length; index++) {
      const char = html[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (!depth) {
          try { return JSON.parse(html.slice(open, index + 1).replace(/\\\//g, '/')); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  function decodeBody(buffer, contentType) {
    const label = (String(contentType || '').match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
    try { return new TextDecoder(label).decode(buffer); } catch (error) {
      return new TextDecoder('utf-8').decode(buffer);
    }
  }

  function extractString(html, key) {
    const match = html.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!match) return '';
    try { return JSON.parse(`"${match[1]}"`); } catch (e) { return ''; }
  }

  function legacyVideo(html, ids) {
    let selected, structured = false, at = -1;
    for (let count = 0; count < 32; count++) {
      at = html.indexOf('"response"', at + 1);
      if (at < 0) break;
      const response = extractObject(html, 'response', at);
      if (!Array.isArray(response?.items)) continue;
      structured = true;
      if (response.items.length > 32) throw new Error('ответ плеера превышает допустимый размер');
      selected = response.items.find(value => value && String(value.owner_id) === ids.oid && String(value.id) === ids.id);
      if (selected) break;
    }
    if (!selected && at >= 0 && html.indexOf('"response"', at + 1) >= 0) {
      throw new Error('ответ плеера превышает допустимый размер');
    }
    if (structured && !selected) throw new Error('ответ плеера относится к другому видео');
    const files = selected ? selected.files : extractObject(html, 'files');
    if (!files || typeof files !== 'object' || Array.isArray(files)) return null;
    const durationMatch = html.match(/"duration"\s*:\s*(\d+)/);
    const fallbackTitle = `video${ids.oid}_${ids.id}`;
    return { ...ids, files,
      duration: selected ? Number(selected.duration) || 0 : (durationMatch ? Number(durationMatch[1]) : 0),
      title: selected ? (selected.title || selected.md_title || fallbackTitle)
        : (extractString(html, 'md_title') || extractString(html, 'title') || fallbackTitle) };
  }

  async function readPlayerBody(response, signal) {
    const limit = globalThis.MendoVKSource?.MAX_RESPONSE_BYTES || 2 * 1024 * 1024;
    const tooLarge = () => new Error('ответ плеера превышает допустимый размер');
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel().catch(() => {});
      throw tooLarge();
    }
    const reader = response.body?.getReader();
    if (!reader) {
      const buffer = await response.arrayBuffer();
      signal?.throwIfAborted();
      if (buffer.byteLength > limit) throw tooLarge();
      return decodeBody(buffer, response.headers.get('content-type'));
    }
    const chunks = [];
    let total = 0;
    const abort = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        signal?.throwIfAborted();
        const next = await reader.read();
        signal?.throwIfAborted();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > limit) { await reader.cancel(); throw tooLarge(); }
        chunks.push(new Uint8Array(next.value));
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return decodeBody(bytes.buffer, response.headers.get('content-type'));
    } finally {
      signal?.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }

  function loadNativeVideo(ids, url, signal) {
    const schema = globalThis.MendoVKSource;
    if (!schema) throw new Error('не удалось запустить загрузчик штатного плеера');
    const source = schema.source(location.href);
    if (!schema.same(source, ids)) throw schema.error('SOURCE_MISMATCH');
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.style.display = 'none';
      frame.setAttribute('aria-hidden', 'true');
      frame.title = 'MendoSave: данные VK';
      frame.src = url;
      const request = { __mendosave_vk_to_player: true, kind: 'request',
        requestId: crypto.randomUUID().replaceAll('-', '_'), sourceHref: source.href,
        oid: ids.oid, id: ids.id, frameHref: url };
      let settled = false, timeout;
      const finish = (failure, video) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        window.removeEventListener('message', receive);
        signal?.removeEventListener('abort', abort);
        frame.remove();
        if (failure) reject(failure); else resolve(video);
      };
      const abort = () => {
        const failure = new Error('получение данных отменено'); failure.name = 'AbortError';
        finish(failure);
      };
      const ask = () => {
        if (settled) return;
        try { frame.contentWindow?.postMessage(request, location.origin); }
        catch (failure) { finish(schema.error('PLAYER_UNAVAILABLE')); }
      };
      const receive = event => {
        if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.__mendosave_vk_from_player !== true || data.frameHref !== url) return;
        if (data.kind === 'ready') { ask(); return; }
        if (data.kind !== 'result' || data.requestId !== request.requestId
          || data.sourceHref !== request.sourceHref || data.oid !== ids.oid || data.id !== ids.id) return;
        if (!schema.same(schema.source(location.href), source) || signal?.aborted) { abort(); return; }
        try {
          const fields = new Set(['__mendosave_vk_from_player', 'kind', 'frameHref', 'requestId', 'sourceHref',
            'oid', 'id', 'video', 'code']);
          if (Object.keys(data).length !== 8 || Object.keys(data).some(key => !fields.has(key))) {
            throw schema.error('INVALID_RESPONSE');
          }
          if (data.code !== undefined) {
            if (typeof data.code !== 'string') throw schema.error('INVALID_RESPONSE');
            throw schema.error(data.code);
          }
          const video = schema.video(data.video, ids);
          const videoFields = new Set(['oid', 'id', 'title', 'duration', 'files']);
          if (Object.keys(data.video).length !== 5 || Object.keys(data.video).some(key => !videoFields.has(key))) {
            throw schema.error('INVALID_RESPONSE');
          }
          // Serialize only the bounded projection, never unsolicited page data.
          if (new TextEncoder().encode(JSON.stringify(video)).byteLength > schema.MAX_PROJECTION_BYTES) {
            throw schema.error('RESPONSE_TOO_LARGE');
          }
          finish(null, video);
        } catch (failure) { finish(failure); }
      };
      window.addEventListener('message', receive);
      signal?.addEventListener('abort', abort, { once: true });
      frame.addEventListener('load', ask);
      timeout = setTimeout(() => finish(schema.error('TIMEOUT')), 12_000);
      if (signal?.aborted) { abort(); return; }
      document.body.appendChild(frame);
    });
  }

  async function loadVideo(target, signal) {
    const ids = videoIdFrom(target) || videoIdFrom(location.pathname);
    if (!ids) throw new Error('не удалось определить видео');
    const url = `${location.origin}/video_ext.php?oid=${encodeURIComponent(ids.oid)}`
      + `&id=${encodeURIComponent(ids.id)}&hd=4&autoplay=0`;
    // With cookies: age-restricted and closed-group videos answer with an error
    // payload otherwise, and the site itself loads the player the same way.
    const response = await mendoFetch(url, { credentials: 'include', cache: 'no-store', signal });
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(`страница плеера не открылась (HTTP ${response.status})`);
    // VK still serves this endpoint as windows-1251. Read as UTF-8 the title
    // decodes to replacement characters and the saved file is called
    // "VK - ???????.m4a", so the charset is taken from the response itself.
    const html = await readPlayerBody(response, signal);
    signal?.throwIfAborted();
    const legacy = legacyVideo(html, ids);
    if (!legacy) {
      if (/window\.isBFF\s*=\s*true\b/.test(html)) return loadNativeVideo(ids, url, signal);
      const reason = extractString(html, 'error_msg') || extractString(html, 'msg');
      throw new Error(reason || 'в ответе плеера нет ссылок на файлы');
    }
    return legacy;
  }

  function progressiveRungs(files) {
    return Object.keys(files)
      .map((key) => /^mp4_(\d+)$/.exec(key))
      .filter(Boolean)
      .map((match) => ({ key: match[0], height: Number(match[1]), url: files[match[0]] }))
      .filter((rung) => rung.url)
      .sort((left, right) => right.height - left.height);
  }

  // The best AAC representation of `dash_sep`. Video is ignored here on purpose:
  // whole-file video comes from the progressive URLs, which cost nothing.
  async function loadAudioTrack(files) {
    if (!files.dash_sep) throw new Error('у этого видео нет отдельной аудиодорожки');
    const response = await mendoFetch(files.dash_sep, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`манифест DASH не открылся (HTTP ${response.status})`);
    const manifest = new DOMParser().parseFromString(await response.text(), 'application/xml');
    const sets = [...manifest.querySelectorAll('AdaptationSet')];
    const audioSet = sets.find((set) => /^audio/.test(set.getAttribute('mimeType') || ''))
      || sets.find((set) => [...set.querySelectorAll('Representation')]
        .some((rep) => /^mp4a/.test(rep.getAttribute('codecs') || '')));
    if (!audioSet) throw new Error('в манифесте DASH нет аудиодорожки');
    if (audioSet.querySelector('ContentProtection')) throw new Error('зашифрованный DASH не поддерживается');
    if (manifest.documentElement?.getAttribute('type') === 'dynamic') {
      throw new Error('запись трансляции DASH пока не поддержана');
    }
    if (audioSet.querySelector('SegmentTemplate, SegmentList')) {
      throw new Error('сегментированная аудиодорожка DASH пока не поддержана');
    }
    const best = [...audioSet.querySelectorAll('Representation')]
      .map((rep) => ({
        bandwidth: Number(rep.getAttribute('bandwidth')) || 0,
        codecs: rep.getAttribute('codecs') || audioSet.getAttribute('codecs') || '',
        base: rep.querySelector('BaseURL')?.textContent?.trim() || '',
      }))
      .filter((rep) => rep.base && /^mp4a(?:\.|$)/.test(rep.codecs))
      .sort((left, right) => right.bandwidth - left.bandwidth)[0];
    if (!best) throw new Error('в манифесте DASH нет доступного файла AAC');
    return { ...best, url: new URL(best.base, files.dash_sep).toString() };
  }

  // ---- transfer --------------------------------------------------------------

  const HAS_NATIVE_BASE64 = typeof Uint8Array.prototype.toBase64 === 'function';

  function encodeBase64(bytes) {
    if (!bytes.length) return '';
    if (HAS_NATIVE_BASE64) return bytes.toBase64();
    let binary = '';
    const step = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + step, bytes.length)));
    }
    return btoa(binary);
  }

  // `no-store` is not optional: a file the page's own player already fetched
  // sits in the cache as a no-cors entry that a CORS request cannot read, and
  // Chrome reports that as a bare `TypeError: Failed to fetch`.
  async function fetchRange(url, from, to, total) {
    const response = await mendoFetch(url, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: { Range: `bytes=${from}-${to}` },
    });
    const expected = to - from + 1;
    let reader;
    try {
      if (response.status !== 206 && response.status !== 200) {
        throw new Error(`сервер отказал на диапазоне (HTTP ${response.status})`);
      }
      // A server may ignore Range or return a short body. Appending that body
      // and advancing by its length can repeat the beginning or silently truncate
      // the audio. Only accept the exact requested bytes before handing them on.
      if (response.status === 200 && from !== 0) throw new Error('сервер проигнорировал диапазон аудиодорожки');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected)) {
        throw new Error('сервер вернул неполный или неверный диапазон медиа');
      }
      const range = response.headers.get('content-range');
      if (range) {
        // An exposed complete length must agree with the size used to end the
        // download; exact start/end alone can still accept a truncated track.
        const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(range);
        const start = match ? Number(match[1]) : NaN;
        const end = match ? Number(match[2]) : NaN;
        const completeLength = match?.[3] === '*' ? null : Number(match?.[3]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
            || start !== from || end !== to
            || (completeLength !== null && (!Number.isSafeInteger(completeLength)
                || completeLength !== total || completeLength <= end))) {
          throw new Error('сервер вернул другой диапазон аудиодорожки');
        }
      }
      // Bound the body independently of headers: an ignored Range must never
      // materialize a two-hour progressive file in page memory.
      reader = response.body?.getReader();
      if (!reader) throw new Error('сервер не предоставил поток диапазона медиа');
      const bytes = new Uint8Array(expected);
      let at = 0;
      for (;;) {
        mendoCheck();
        const { done, value } = await reader.read();
        mendoCheck();
        if (done) break;
        if (!Number.isSafeInteger(value?.byteLength) || value.byteLength > expected - at) {
          throw new Error('сервер вернул неполный или неверный диапазон медиа');
        }
        // Own the network view before species-based subarray/base64 operations.
        const incoming = new Uint8Array(value);
        if (incoming.length !== value.byteLength) throw new Error('сервер вернул неверные данные диапазона');
        bytes.set(incoming, at); at += incoming.length;
      }
      if (at !== expected) throw new Error('сервер вернул неполный или неверный диапазон медиа');
      return bytes;
    } finally {
      await (reader || response.body)?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }

  // `Content-Range` is not a CORS-safelisted response header, so its value is
  // invisible to the page even when the ranged request itself succeeds — the
  // first attempt at sizing the track read `null` from it and refused to start.
  // `Content-Length` of an unranged response is safelisted; the body is dropped
  // as soon as the headers are in, so nothing is transferred for it.
  async function probeSize(url) {
    for (const method of ['HEAD', 'GET']) {
      try {
        const response = await mendoFetch(url, { method, credentials: 'omit', cache: 'no-store', redirect: 'error' });
        const length = response.headers.get('content-length');
        const total = /^\d+$/.test(length || '') ? Number(length) : 0;
        if (method === 'GET') await response.body?.cancel().catch(() => {});
        if (response.ok && Number.isSafeInteger(total) && total > 0) return total;
      } catch (error) {
        mendoCheck();
        if (error?.name === 'AbortError') throw error;
        /* try the next method */
      }
    }
    return 0;
  }

  async function sendChunk(jobId, track, bytes, producer) {
    for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_SIZE) {
      const slice = bytes.subarray(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, bytes.length));
      const response = await mendoSend({
        t: 'mendosave-chunk', jobId, track, b64: encodeBase64(slice),
      }, producer);
      if (!response?.ok) throw new Error(response?.error || 'передача данных прервалась');
    }
  }

  // ---- downloads -------------------------------------------------------------

  async function saveDirect(url, filename) {
    const saved = await mendoSend({ t: 'mendosave-save', url, filename });
    if (!saved?.ok) throw new Error(saved?.error || 'браузер не принял файл на сохранение');
    return saved.collected ? saved : saved.id;
  }

  // The browser pulls a direct file itself, so its progress has to be asked
  // for; `downloads.onChanged` fires on state changes, not on bytes, which is
  // why this polls. Without it the page could only say "handed over" while the
  // real bar lived in Chrome's own download bubble.
  async function followBrowserDownload(id, notification) {
    if (id?.collected) return;
    let misses = 0;
    for (;;) {
      mendoCheck();
      await new Promise((resolve) => setTimeout(resolve, 700));
      const state = await mendoSend({ t: 'mendosave-download-state', id }).catch((error) => {
        mendoCheck();
        if (error?.name === 'AbortError') throw error;
        return null;
      });
      if (!state?.ok) {
        // A download the browser has not registered yet is normal for a moment.
        if (++misses > 8) throw new Error(state?.error || 'браузер потерял загрузку');
        continue;
      }
      misses = 0;
      if (state.state === 'interrupted') {
        downloadInterrupted(state.error);
      }
      if (state.state === 'complete') {
        notification.stage('file', 1, 'done', 'Загрузка файла');
        return;
      }
      const total = Number(state.totalBytes) || 0;
      const received = Number(state.bytesReceived) || 0;
      notification.stage('file', total ? received / total : null, 'active',
        state.paused
          ? 'Пауза в браузере'
          : (total ? `Загрузка · ${formatBytes(received)} из ${formatBytes(total)}` : 'Загрузка файла'));
    }
  }

  async function downloadPackageVideo(url, filename, notification, producer) {
    notification.stage('file', null, 'active', 'Читаю размер видео');
    const total = await probeSize(url);
    if (!total) throw new Error('сервер не сообщил размер видео');
    if (total > 1024 ** 3) throw new Error('Размер видео превышает лимит временного хранилища');
    const transferId = crypto.randomUUID();
    let opened = false, finished = false, port;
    const requireOk = response => {
      if (!response?.ok) throw new Error(response?.error || 'передача видео прервалась');
      return response;
    };
    try {
      requireOk(await mendoSend({ t: 'mendosave-ensure' }, producer));
      mendoCheck(); opened = true;
      requireOk(await mendoSend({ t: 'mendosave-blob-open', transferId, filename,
        mime: 'video/mp4', size: total }, producer));
      port = chrome.runtime.connect({ name: `mendosave-transfer:${transferId}` });
      let sequence = 0;
      for (let at = 0; at < total;) {
        // Feed the existing 60s transfer deadline after each 1 MiB range,
        // rather than waiting for a complete 8 MiB audio-sized read.
        const end = Math.min(total - 1, at + PACKAGE_SLICE_BYTES - 1);
        const bytes = await fetchRange(url, at, end, total);
        for (let offset = 0; offset < bytes.length; offset += 1024 ** 2) {
          mendoCheck();
          requireOk(await mendoSend({ t: 'mendosave-blob-chunk', transferId, sequence: sequence++,
            data: encodeBase64(bytes.subarray(offset, Math.min(offset + 1024 ** 2, bytes.length))) }, producer));
        }
        at += bytes.length;
        notification.stage('file', at / total, 'active', 'Получение видео');
      }
      mendoCheck();
      notification.stage('file', 1, 'active', 'Сохранение видео');
      const result = requireOk(await mendoSend({ t: 'mendosave-blob-finish', transferId }, producer));
      mendoCheck(); finished = true;
      notification.stage('file', 1, 'done', 'Загрузка файла');
      return result.filename || filename;
    } finally {
      if (opened && !finished) await mendoSend({ t: 'mendosave-blob-abort', transferId }, producer).catch(() => {});
      try { port?.disconnect(); } catch {}
    }
  }

  async function downloadAudio(info, audioFormat, notification, producer) {
    notification.stage('fetch', null, 'active', 'Читаю размер дорожки');
    const track = await loadAudioTrack(info.files);
    const total = await probeSize(track.url);
    if (!total) throw new Error('сервер не сообщил размер аудиодорожки');
    notification.stage('fetch', 0, 'active', 'Скачивание звука');

    const jobId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const extension = audioFormat === 'mp3' ? '.mp3' : '.m4a';
    const filename = `VK - ${safeName(info.title)}${extension}`;
    // The mux stage has no number of its own until offscreen reports one, and a
    // long MP3 encode is exactly when the user needs to see something moving.
    const onProgress = (message) => {
      if (message?.t !== 'mendosave-progress' || message.jobId !== jobId) return;
      const value = Number(message.value);
      notification.stage('process', Number.isFinite(value) ? value : null, 'active',
        message.status || 'Сборка файла');
    };
    chrome.runtime.onMessage.addListener(onProgress);
    try {
      const ensured = await mendoSend({ t: 'mendosave-ensure' }, producer);
      if (!ensured?.ok) throw new Error(ensured?.error || 'не удалось запустить обработчик медиа');
      const registration = await mendoSend({ t: 'mendosave-register-job', jobId }, producer);
      if (!registration?.ok || !Number.isInteger(registration.tabId)) {
        throw new Error(registration?.error || 'не удалось определить вкладку загрузки');
      }
      const started = await mendoSend({
        t: 'mendosave-begin',
        jobId,
        tabId: registration.tabId,
        filename,
        // Audio-only job: the same shape the YouTube MP3 path uses.
        format: 'mp3',
        audioFormat,
        audioQuality: 'best',
        audioMime: 'audio/mp4',
        audioSize: total,
        videoSize: 0,
        duration: info.duration,
      }, producer);
      if (!started?.ok) throw new Error(started?.error || 'не удалось начать обработку');

      // Slice by slice, so the page holds 8 MB at a time instead of the file.
      let at = 0;
      while (at < total) {
        const end = Math.min(total - 1, at + SLICE_BYTES - 1);
        const bytes = await fetchRange(track.url, at, end, total);
        if (!bytes.length) throw new Error('сервер вернул пустой диапазон');
        await sendChunk(jobId, 'audio', bytes, producer);
        at += bytes.length;
        notification.stage('fetch', at / total, 'active', 'Скачивание звука');
      }
      notification.stage('fetch', 1, 'done', 'Скачивание звука');
      notification.stage('process', null, 'active', 'Сборка файла');
      const finalized = await mendoSend({ t: 'mendosave-finalize', jobId }, producer);
      if (!finalized?.ok) throw new Error(finalized?.error || 'не удалось собрать файл');
      notification.stage('process', 1, 'done', 'Сборка файла');
      log('audio', `saved; bitrate=${track.bandwidth} bytes=${total} format=${audioFormat}`);
      return finalized.filename || filename;
    } catch (error) {
      await mendoSend({ t: 'mendosave-abort', jobId }, producer).catch(() => {});
      throw error;
    } finally {
      chrome.runtime.onMessage.removeListener(onProgress);
    }
  }

  // ---- toast -----------------------------------------------------------------

  // Same shape as the YouTube panel: a title, one row per stage with its own
  // bar, and the box itself slides in. A stage with no number of its own runs
  // an indeterminate stripe rather than a frozen empty bar — during a remux
  // there is nothing to count until offscreen reports back.
  let toastTimer;
  let toastRevision = 0;

  function getToast() {
    const revision = ++toastRevision;
    if (!toastBox) {
      toastBox = createElement('div', 'mendosave-vk-toast');
      const text = createElement('div', 'mendosave-vk-toast-text');
      const bar = createElement('div', 'mendosave-vk-toast-bar');
      bar.append(createElement('i'));
      const stages = createElement('div', 'mendosave-vk-stages');
      toastBox.append(text, bar, stages);
      document.body.appendChild(toastBox);
      toastBox._text = text;
      toastBox._bar = bar;
      toastBox._stages = stages;
    }
    const show = () => {
      clearTimeout(toastTimer);
      toastBox.classList.add('show');
    };
    return {
      set(message, fraction) {
        if (revision !== toastRevision) return;
        show();
        toastBox._text.textContent = message;
        toastBox._stages.replaceChildren();
        toastBox._stages.classList.remove('show');
        toastBox._bar.hidden = false;
        toastBox._bar.querySelector('i').style.width = `${Math.max(0, Math.min(1, Number(fraction) || 0)) * 100}%`;
      },
      begin(message, definitions) {
        if (revision !== toastRevision) return;
        show();
        toastBox._text.textContent = message;
        toastBox._bar.hidden = true;
        toastBox._stages.replaceChildren();
        for (const definition of definitions) {
          const row = createElement('div', 'mendosave-vk-stage queued');
          row.dataset.stage = definition.id;
          const head = createElement('div', 'mendosave-vk-stage-head');
          head.append(createElement('span', 'mendosave-vk-stage-label', definition.label),
            createElement('span', 'mendosave-vk-stage-value', 'ожидание'));
          const bar = createElement('div', 'mendosave-vk-stage-bar');
          bar.append(createElement('i'));
          row.append(head, bar);
          toastBox._stages.append(row);
        }
        toastBox._stages.classList.add('show');
      },
      stage(id, fraction, state = 'active', label) {
        if (revision !== toastRevision) return;
        const row = toastBox?._stages.querySelector(`[data-stage="${id}"]`);
        if (!row) return;
        row.className = `mendosave-vk-stage ${state}`;
        if (label) row.querySelector('.mendosave-vk-stage-label').textContent = label;
        const value = row.querySelector('.mendosave-vk-stage-value');
        const fill = row.querySelector('.mendosave-vk-stage-bar i');
        if (Number.isFinite(fraction)) {
          const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
          value.textContent = state === 'done' ? 'готово' : `${percent}%`;
          fill.style.width = `${percent}%`;
          row.classList.remove('busy');
        } else {
          value.textContent = state === 'active' ? 'идёт…' : (state === 'error' ? 'ошибка' : 'ожидание');
          fill.style.width = state === 'done' ? '100%' : '0%';
          row.classList.toggle('busy', state === 'active');
        }
      },
      hide(delay) {
        if (revision !== toastRevision) return;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          if (revision === toastRevision) toastBox?.classList.remove('show');
        }, delay || 0);
      },
    };
  }

  // ---- menu ------------------------------------------------------------------

  function closeMenu() {
    menuRequest?.controller.abort();
    menuRequest = undefined;
    menu?.remove();
    menu = undefined;
    document.removeEventListener('click', onOutsideClick, true);
  }

  // `event.target` is retargeted to the shadow host for anything inside the
  // player, so the button's own click would read as an outside click and close
  // the menu a moment before it opens. The composed path still shows the truth.
  function onOutsideClick(event) {
    if (!menu) return;
    const path = event.composedPath ? event.composedPath() : [event.target];
    const insideMenu = path.some((node) => node === menu);
    const onButton = path.some((node) => node?.classList?.contains?.(BUTTON_CLASS));
    if (!insideMenu && !onButton) closeMenu();
  }

  function buildChoices(info) {
    const choices = [];
    for (const rung of progressiveRungs(info.files)) {
      choices.push({
        kind: 'video', rung,
        text: `Видео со звуком · ${rung.height}p`,
        hint: info.duration ? formatClock(info.duration) : '',
      });
    }
    if (info.files.dash_sep) {
      choices.push({ kind: 'audio', audioFormat: 'm4a', text: 'Только звук · M4A', hint: 'без перекодирования' });
      choices.push({ kind: 'audio', audioFormat: 'mp3', text: 'Только звук · MP3', hint: 'перекодирование' });
    }
    return choices;
  }

  async function runChoice(info, choice) {
    const bundled = packageRunning();
    mendoCheck();
    if (busy) {
      if (bundled) throw new Error('Другая загрузка уже выполняется');
      return;
    }
    busy = true;
    const notification = getToast();
    let producer;
    try {
      if (choice.kind !== 'video' || bundled) producer = await reserveProcessor();
      let filename;
      if (choice.kind === 'video') {
        filename = `VK - ${safeName(info.title)} [${choice.rung.height}p].mp4`;
        notification.begin(`Скачиваю ${choice.rung.height}p…`, [{ id: 'file', label: 'Загрузка файла' }]);
        if (bundled) {
          filename = await downloadPackageVideo(choice.rung.url, filename, notification, producer);
        } else {
          notification.stage('file', null, 'active', 'Передача браузеру');
          const downloadId = await saveDirect(choice.rung.url, filename);
          log('video', `handed to downloads; height=${choice.rung.height} id=${downloadId}`);
          // The browser only ACCEPTED it here; the bytes keep arriving for a
          // while, so the panel follows the real transfer instead of claiming
          // "готово" against a downloads list that says otherwise.
          await followBrowserDownload(downloadId, notification);
          filename = downloadId?.filename || filename;
        }
        notification.set(`Готово: ${filename}`, 1);
      } else {
        notification.begin(`Скачиваю звук · ${choice.audioFormat === 'mp3' ? 'MP3' : 'M4A'}…`, [
          { id: 'fetch', label: 'Скачивание звука' },
          { id: 'process', label: 'Сборка файла' },
        ]);
        filename = await downloadAudio(info, choice.audioFormat, notification, producer);
        notification.set(`Готово: ${filename}`, 1);
      }
      notification.hide(4000);
      return filename;
    } catch (error) {
      if (error?.name === 'AbortError') {
        notification.set('Загрузка отменена', 1);
        notification.hide(4000);
        if (bundled) throw error;
        return;
      }
      notification.set(`Ошибка: ${String(error?.message || error).slice(0, 140)}`, 1);
      notification.hide(8000);
      if (bundled) throw error;
      void reportError('vk-download', error, { kind: choice.kind });
    } finally {
      releaseProcessor(producer);
      busy = false;
    }
  }

  function openMenu(button, event) {
    event.preventDefault();
    event.stopPropagation();
    if (packageRunning()) return;
    if (menu && menuRequest?.source !== location.href) closeMenu();
    if (menu) { closeMenu(); return; }
    return showMenu(button);
  }

  async function loadMenuVideo(request) {
    const signal = request.controller.signal;
    let timeout, onAbort;
    try {
      return await new Promise((resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        timeout = setTimeout(() => request.controller.abort(globalThis.MendoVKSource?.error('TIMEOUT')
          || new Error('плеер не ответил вовремя; повторите попытку')), 20_000);
        loadVideo(request.source, signal).then(resolve, reject);
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function showMenu(button, cachedInfo) {
    if (packageRunning()) return button;
    closeMenu();
    menu = createElement('div', 'mendosave-vk-menu');
    const heading = createElement('div', 'mendosave-vk-head', `MendoSave v${chrome.runtime.getManifest().version}`);
    const loading = createElement('div', 'mendosave-vk-item mendosave-vk-muted', 'Читаю данные видео…');
    menu.append(heading, loading);
    document.body.appendChild(menu);
    positionMenu(button);
    document.addEventListener('click', onOutsideClick, true);

    const request = { menu, source: location.href, controller: new AbortController() };
    menuRequest = request;
    const ownsMenu = () => menuRequest === request && menu === request.menu
      && location.href === request.source;

    try {
      const info = cachedInfo || await loadMenuVideo(request);
      if (!ownsMenu()) return;
      loading.remove();
      const choices = buildChoices(info);
      if (!choices.length) throw new Error('у этого видео нет доступных файлов');
      for (const choice of choices) {
        const item = createElement('div', 'mendosave-vk-item');
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          item.click();
        });
        item.append(createElement('span', 'mendosave-vk-text', choice.text));
        if (choice.hint) item.append(createElement('span', 'mendosave-vk-hint', choice.hint));
        item.addEventListener('click', () => {
          if (!ownsMenu()) { closeMenu(); return; }
          closeMenu(); void runChoice(info, choice);
        });
        menu.append(item);
      }
      const opener = choices.length > 1 ? globalThis.MendoPackageUI?.add(menu, {
        title: info.title, source: `vk:${info.oid}_${info.id}`, close: closeMenu,
        back: async () => {
          schedule();
          const anchor = playerShadowRoot()?.querySelector(`.${BUTTON_CLASS}`)
            || document.querySelector(`.${BUTTON_CLASS}`) || (button?.isConnected ? button : null);
          const current = videoIdFrom(location.href);
          const reusable = current?.oid === info.oid && current?.id === info.id;
          return showMenu(anchor, reusable ? info : undefined);
        },
        options: () => {
          if (!ownsMenu()) { closeMenu(); void showMenu(button); return []; }
          return choices.map(choice => ({
            id: choice.kind === 'video' ? `vk-video-${choice.rung.height}` : `vk-audio-${choice.audioFormat}`,
            label: choice.text, group: choice.kind === 'video' ? 'Видео' : 'Аудио',
            run: () => runChoice(info, choice),
          }));
        },
      }) : null;
      bindMenu(button);
      positionMenu(button);
      return opener || button;
    } catch (error) {
      if (!ownsMenu() || error?.name === 'AbortError') return;
      loading.remove();
      menu.append(createElement('div', 'mendosave-vk-item mendosave-vk-muted',
        `Ошибка: ${String(error?.message || error).slice(0, 120)}`));
      const retry = createElement('button', 'mendosave-vk-item', 'Повторить');
      retry.type = 'button';
      retry.setAttribute('role', 'button');
      retry.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        if (ownsMenu()) void showMenu(button);
      });
      menu.append(retry);
      bindMenu(button);
      positionMenu(button);
      log('menu', `list failed: ${String(error?.message || error)}`);
      return retry;
    }
  }

  function bindMenu(button) {
    globalThis.MendoMenu?.bind(menu, () => {
      closeMenu();
      if (button?.isConnected) button.focus();
    }, '.mendosave-vk-item[role="button"],.mendo-package-open');
  }

  function positionMenu(button) {
    if (!menu || !button) return;
    const margin = 8;
    const clamp = (value, limit) => Math.max(margin, Math.min(value, limit));
    menu.style.maxHeight = `${Math.max(1, window.innerHeight - 2 * margin)}px`;
    const box = button.getBoundingClientRect();
    const width = menu.getBoundingClientRect().width || 280;
    let height = menu.getBoundingClientRect().height || 200;
    const above = box.top - 2 * margin;
    const below = window.innerHeight - box.bottom - 2 * margin;
    let left = clamp(box.right - width, window.innerWidth - width - margin);
    let top;
    if (above >= height) top = box.top - height - margin;
    else if (below >= height) top = box.bottom + margin;
    else if (box.left >= width + 2 * margin) {
      left = box.left - width - margin;
      top = clamp(box.top, window.innerHeight - height - margin);
    } else if (window.innerWidth - box.right >= width + 2 * margin) {
      left = box.right + margin;
      top = clamp(box.top, window.innerHeight - height - margin);
    } else {
      // A narrow viewport cannot fit the list beside the icon. Scroll the
      // list above or below it so a repeat click still targets the icon.
      menu.style.maxHeight = `${Math.max(1, Math.max(above, below))}px`;
      height = menu.getBoundingClientRect().height || 200;
      top = above >= below ? box.top - height - margin : box.bottom + margin;
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${clamp(top, window.innerHeight - height - margin)}px`;
  }

  // ---- mounting ----------------------------------------------------------------
  // VK's class names are hashed, but the readable prefix survives the build, so
  // the anchor is matched by prefix and then checked by size: the same markup
  // exists collapsed (0×0) elsewhere on the page.

  // The same ring-and-arrows mark the YouTube button uses, so one extension does
  // not look like two.
  function createIcon() {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('aria-hidden', 'true');
    const ring = document.createElementNS(namespace, 'circle');
    ring.setAttribute('cx', '18');
    ring.setAttribute('cy', '18');
    ring.setAttribute('r', '16.9');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', '#35d477');
    ring.setAttribute('stroke-width', '2.2');
    const arrows = document.createElementNS(namespace, 'path');
    arrows.setAttribute('fill', '#35d477');
    arrows.setAttribute('d', 'M16 6h4v14l5-5 3 3-10 10L8 18l3-3 5 5V6z M7 28h22v3H7z');
    svg.append(ring, arrows);
    return svg;
  }

  // VK's player is a web component and its controls live inside an open shadow
  // root, which an extension stylesheet cannot reach — hence the inline sheet
  // below. Outside that root the button is stretched to the whole player by
  // VK's own rules, so the light-DOM fallback pins its geometry with
  // !important.
  const SHADOW_STYLE = `
    .${BUTTON_CLASS} {
      width: 40px; height: 40px; padding: 0; border: 0; margin: 0;
      background: transparent; cursor: pointer; opacity: 0.9;
      display: inline-flex; align-items: center; justify-content: center;
      flex: 0 0 auto;
    }
    .${BUTTON_CLASS}:hover { opacity: 1; }
    .${BUTTON_CLASS} svg { width: 26px; height: 26px; display: block; }
  `;

  function playerShadowRoot() {
    for (const host of document.querySelectorAll('div.shadow-root-container')) {
      if (!host.shadowRoot) continue;
      const box = host.getBoundingClientRect();
      if (box.width > 200 && box.height > 150) return host.shadowRoot;
    }
    // VK's newer player attaches its open root to an ordinary DIV without the
    // legacy class. Match the media-bearing, visible host instead of CSS hashes.
    for (const host of document.querySelectorAll('*')) {
      const root = host.shadowRoot;
      if (!root?.querySelector('video')) continue;
      const box = host.getBoundingClientRect();
      if (box.width > 200 && box.height > 150 && box.bottom > 0 && box.right > 0
        && box.top < window.innerHeight && box.left < window.innerWidth) return root;
    }
    return null;
  }

  function visiblePlayerBox() {
    for (const element of document.querySelectorAll('[class*="VideoPlayer__aspectRatio"], [class*="VideoPlayer__player"]')) {
      const box = element.getBoundingClientRect();
      if (box.width > 200 && box.height > 150) return element;
    }
    return null;
  }

  function makeButton() {
    const button = document.createElement('button');
    button.className = BUTTON_CLASS;
    button.type = 'button';
    button.title = 'Скачать видео (MendoSave)';
    button.setAttribute('aria-label', button.title);
    button.append(createIcon());
    button.addEventListener('click', (event) => { void openMenu(button, event); });
    return button;
  }

  // Into the control row, immediately left of the right-most control. The row is
  // found by geometry rather than by label: VK's buttons carry localized
  // aria-labels and hashed classes, but their place on screen is stable.
  function mountInShadow(root) {
    if (root.querySelector(`.${BUTTON_CLASS}`)) return true;
    const host = root.host.getBoundingClientRect();
    const controls = [...root.querySelectorAll('button')]
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter((candidate) => candidate.box.width > 8
        && candidate.box.bottom > host.bottom - host.height * 0.2);
    if (!controls.length) return false;
    const rightMost = controls.sort((left, right) => right.box.right - left.box.right)[0].element;
    const wrapper = rightMost.closest('.tooltip-wrapper') || rightMost;
    const row = wrapper.parentElement;
    if (!row) return false;
    if (!root.querySelector('style[data-mendosave]')) {
      const style = document.createElement('style');
      style.setAttribute('data-mendosave', '1');
      style.textContent = SHADOW_STYLE;
      root.append(style);
    }
    row.insertBefore(makeButton(), wrapper);
    return true;
  }

  function ensureButton() {
    if (!videoIdFrom(location.pathname)) {
      document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((node) => node.remove());
      return;
    }
    const root = playerShadowRoot();
    if (root && mountInShadow(root)) return;
    // Fallback for a player without the shadow root: an overlay in the corner.
    const anchor = visiblePlayerBox();
    if (!anchor || anchor.querySelector(`.${BUTTON_CLASS}`)) return;
    const button = makeButton();
    button.classList.add('mendosave-vk-overlay');
    if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
    anchor.appendChild(button);
  }

  // An interval, not requestAnimationFrame: rAF does not run in a hidden tab,
  // and the SPA re-renders the player on every in-page navigation anyway.
  function schedule() {
    try {
      if (menuRequest && menuRequest.source !== location.href) closeMenu();
      ensureButton();
    } catch (error) {}
  }
  setInterval(schedule, 1000);
  document.addEventListener('visibilitychange', schedule);
  schedule();
})();

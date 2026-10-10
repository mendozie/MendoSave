// Rutube adapter. Deliberately independent of content_hook.js: Rutube publishes
// a plain HLS playlist, so nothing here intercepts MSE or drives the player.
// Segments are ordinary GETs, and the assembled MPEG-TS goes to the shared
// offscreen muxer as a single already-muxed input.
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

  const BUTTON_ID = 'mendosave-rutube-btn';
  const TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;
  const SEGMENT_CONCURRENCY = 6;
  const ID_PATTERN = /[0-9a-f]{32}/i;

  let downloadInProgress = false;
  let menu;
  let toast;

  function log(tag, text) {
    mendoSend({ t: 'mendosave-log', tag: `rutube/${tag}`, text }).catch(() => {});
  }

  function reportError(context, error, details) {
    console.error('[MendoSave]', error);
    return mendoSend({
      t: 'mendosave-error', context, error: String(error?.stack || error?.message || error), details,
    }).catch(() => null);
  }

  // ---- page facts ---------------------------------------------------------

  // Slug URLs (rutube.sport) carry no id, but every page advertises its player
  // embed, and that URL always ends with the canonical 32-hex id.
  function videoIdFromPage() {
    const fromPath = ID_PATTERN.exec(location.pathname);
    if (fromPath) return fromPath[0].toLowerCase();
    const embed = document.querySelector('meta[property="og:video"], meta[property="og:video:url"]');
    const fromEmbed = embed?.content ? ID_PATTERN.exec(embed.content) : null;
    return fromEmbed ? fromEmbed[0].toLowerCase() : '';
  }

  const isShorts = () => location.pathname.startsWith('/shorts/');

  function safeFilename(name) {
    return String(name || 'video')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'video';
  }

  // ---- playback options and playlists -------------------------------------

  async function fetchPlayOptions(videoId) {
    const url = `${location.origin}/api/play/options/${videoId}/`
      + `?no_404=true&referer=${encodeURIComponent(location.href)}`;
    const response = await mendoFetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`Rutube API ответил ${response.status}`);
    const payload = await response.json();
    const master = payload?.video_balancer?.m3u8 || payload?.video_balancer?.default;
    if (!master) throw new Error('Rutube не отдал плейлист видео');
    return {
      master,
      title: payload.title || document.title,
      durationSeconds: (Number(payload.duration) || 0) / 1000,
      isLive: Boolean(payload.is_livestream || payload.live_streams?.is_active),
    };
  }

  function parseAttributes(line) {
    const attributes = {};
    // Values may be quoted and contain commas (CODECS="avc1.42c01f, mp4a.40.2").
    const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let match = pattern.exec(line);
    while (match) {
      attributes[match[1]] = match[2].replace(/^"|"$/g, '');
      match = pattern.exec(line);
    }
    return attributes;
  }

  // One rendition can appear several times, once per CDN mirror. Keep every
  // mirror: a segment that fails on one host is retried on the next.
  function parseMasterPlaylist(text, baseUrl) {
    const lines = text.split('\n').map((line) => line.trim());
    const byHeight = new Map();
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue;
      const target = lines[index + 1];
      if (!target || target.startsWith('#')) continue;
      const attributes = parseAttributes(lines[index]);
      const resolution = /(\d+)x(\d+)/.exec(attributes.RESOLUTION || '');
      if (!resolution) continue;
      // Vertical shorts must be named by their short edge, exactly as the
      // YouTube side learned to do: 608x1080 is a 608p rendition, not 1080p.
      const height = Math.min(Number(resolution[1]), Number(resolution[2]));
      const entry = byHeight.get(height) || {
        height,
        bandwidth: Number(attributes.BANDWIDTH) || 0,
        codecs: attributes.CODECS || '',
        mirrors: [],
      };
      entry.mirrors.push(new URL(target, baseUrl).href);
      byHeight.set(height, entry);
    }
    return [...byHeight.values()].sort((left, right) => right.height - left.height);
  }

  function parseMediaPlaylist(text, baseUrl) {
    if (!/^#EXTM3U(?:\r?\n|$)/.test(text.trim())) throw new Error('ответ не является HLS-плейлистом');
    if (!/^#EXT-X-ENDLIST\s*$/m.test(text)) {
      throw new Error('плейлист не завершён: запись трансляции пока не поддержана');
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('#EXT-X-KEY:') && parseAttributes(line).METHOD !== 'NONE') {
        throw new Error('зашифрованный HLS не поддерживается');
      }
      if (/^#EXT-X-(?:MAP|BYTERANGE):/.test(line)) {
        throw new Error('этот тип HLS пока не поддерживается (init segment или byte range)');
      }
    }
    const segments = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      segments.push(new URL(line, baseUrl).href);
    }
    return segments;
  }

  async function fetchText(url) {
    const response = await mendoFetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`плейлист ответил ${response.status}`);
    return response.text();
  }

  // ---- segment download ---------------------------------------------------

  async function fetchSegment(url, attempt = 0) {
    try {
      const response = await mendoFetch(url, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // In Gecko a view over a DOM-returned ArrayBuffer can stay in its foreign
      // realm. Its subarray() then fails when species reads `constructor`.
      // Copy once into an owned buffer before any slicing/base64 transfer.
      const fetchedBytes = new Uint8Array(await response.arrayBuffer());
      const bytes = new Uint8Array(fetchedBytes);
      if (!bytes.length) throw new Error('пустой сегмент');
      return bytes;
    } catch (error) {
      mendoCheck();
      if (error?.name === 'AbortError') throw error;
      if (attempt >= 2) throw error;
      await new Promise((resolve) => { setTimeout(resolve, 300 * (attempt + 1)); });
      return fetchSegment(url, attempt + 1);
    }
  }

  // Segments are fetched ahead but handed over strictly in playlist order, and
  // are released as soon as they leave. Collecting the whole film first is what
  // this replaced, and it could not work: a two-hour Rutube video is 1814
  // segments, and after holding all of them the code asked for ONE contiguous
  // buffer of the same size again — reported from the field as
  // `RangeError: Array buffer allocation failed` at 480p, where the file is
  // under a gigabyte and only the doubling made it fail.
  async function streamSegments(urls, send, onProgress) {
    // Fetches run ahead, the handover stays in playlist order, and a segment is
    // released the moment it leaves. `LOOKAHEAD` bounds both the concurrency and
    // the memory: never more than this many segments in flight.
    //
    // The single loop is deliberate. An earlier version polled a "have I got the
    // next one yet" condition with `while (...) await drain()`, and when the
    // awaited promise was already resolved that became a pure microtask spin:
    // microtasks starve the event loop, so the very network responses it was
    // waiting for could never be delivered and the whole tab froze. Awaiting the
    // promise of the segment actually needed is what makes progress possible.
    const LOOKAHEAD = SEGMENT_CONCURRENCY * 2;
    const inFlight = new Map();
    let nextToFetch = 0;

    try {
      for (let index = 0; index < urls.length; index++) {
        while (nextToFetch < urls.length && inFlight.size < LOOKAHEAD) {
          const at = nextToFetch++;
          const request = fetchSegment(urls[at]);
          // Marks it handled; the await below still sees a rejection.
          request.catch(() => {});
          inFlight.set(at, request);
        }
        const request = inFlight.get(index);
        inFlight.delete(index);
        await send(await request);
        onProgress((index + 1) / urls.length);
      }
    } finally {
      // A failed head/write must drain cancelled lookahead reads before the
      // caller aborts its job, releases the host and accepts another run.
      if (inFlight.size) processorTask?.controller.abort();
      await Promise.allSettled([...inFlight.values()]);
    }
  }

  // ---- handing the stream to the shared muxer ------------------------------

  // See content_ui.js: the argument spread costs ~155 ms per 4 MiB chunk in
  // Chrome 151 against 1.2 ms for the native encoder, and it is the transfer's
  // whole bottleneck. Byte-identical output.
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

  async function beginJob(job, expectedBytes, producer) {
    const ensured = await mendoSend({ t: 'mendosave-ensure' }, producer);
    if (!ensured?.ok) throw new Error(ensured?.error || 'не удалось запустить обработчик медиа');
    const registration = await mendoSend({ t: 'mendosave-register-job', jobId: job.jobId }, producer);
    if (!registration?.ok || !Number.isInteger(registration.tabId)) {
      throw new Error(registration?.error || 'не удалось определить вкладку загрузки');
    }
    const started = await mendoSend({
      t: 'mendosave-begin',
      jobId: job.jobId,
      tabId: registration.tabId,
      filename: job.filename,
      format: 'mp4',
      muxed: true,
      videoMime: 'video/mp2t',
      audioMime: '',
      duration: job.duration,
      // Lets the muxer decide up front whether to spool to disk instead of
      // holding the stream in memory. An estimate is enough: it also switches
      // over on its own once the bytes actually pile up.
      expectedBytes: Math.max(0, Math.round(expectedBytes) || 0),
    }, producer);
    if (!started?.ok) throw new Error(started?.error || 'не удалось начать обработку');
  }

  // Sends one segment onwards, split into transfer-sized chunks. The segment
  // itself is dropped by the caller right after.
  async function sendBytes(jobId, bytes, producer) {
    for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_SIZE) {
      const chunk = bytes.subarray(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, bytes.length));
      const response = await mendoSend({
        t: 'mendosave-chunk', jobId, track: 'video', b64: encodeBase64(chunk),
      }, producer);
      if (!response?.ok) throw new Error(response?.error || 'передача данных прервалась');
    }
  }

  // ---- UI ------------------------------------------------------------------

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

  let toastRevision = 0;
  let toastTimer;
  function getToast() {
    const revision = ++toastRevision;
    clearTimeout(toastTimer);
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'mendosave-rt-toast';
      document.body.appendChild(toast);
    }
    toast.hidden = false;
    return {
      set(text, progress) {
        if (revision !== toastRevision) return;
        toast.textContent = text;
        toast.style.setProperty('--mendosave-rt-progress', `${Math.round((progress || 0) * 100)}%`);
      },
      hide(delay) {
        if (revision !== toastRevision) return;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          if (revision === toastRevision && toast) toast.hidden = true;
        }, delay || 0);
      },
    };
  }

  function closeMenu() {
    menu?.remove();
    menu = undefined;
    document.removeEventListener('click', onOutsideClick, true);
  }

  function onOutsideClick(event) {
    if (menu && !menu.contains(event.target) && !event.target.closest?.(`#${BUTTON_ID}`)) closeMenu();
  }

  async function openMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    if (packageRunning()) return;
    if (menu) { closeMenu(); return; }
    menu = document.createElement('div');
    const openedMenu = menu;
    menu.className = 'mendosave-rt-menu';
    const heading = document.createElement('div');
    heading.className = 'mendosave-rt-head';
    heading.textContent = `MendoSave v${chrome.runtime.getManifest().version}`;
    menu.append(heading);
    const loading = document.createElement('div');
    loading.className = 'mendosave-rt-item mendosave-rt-muted';
    loading.textContent = 'Читаю список качеств…';
    menu.append(loading);
    document.body.appendChild(menu);
    positionMenu();
    document.addEventListener('click', onOutsideClick, true);

    try {
      const videoId = videoIdFromPage();
      if (!videoId) throw new Error('не удалось определить идентификатор видео');
      const options = await fetchPlayOptions(videoId);
      if (menu !== openedMenu) return;
      const master = await fetchText(options.master);
      if (menu !== openedMenu) return;
      const variants = parseMasterPlaylist(master, options.master);
      loading.remove();
      if (options.isLive) {
        const live = document.createElement('div');
        live.className = 'mendosave-rt-item mendosave-rt-muted';
        live.textContent = 'Идёт трансляция — запись эфира пока не поддержана';
        menu.append(live);
        return;
      }
      if (!variants.length) throw new Error('Rutube не предложил ни одного качества');
      for (const variant of variants) {
        const item = document.createElement('div');
        item.className = 'mendosave-rt-item';
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          item.click();
        });
        const size = variant.bandwidth && options.durationSeconds
          ? ` · ~${Math.round((variant.bandwidth / 8) * options.durationSeconds / 1e6)} МБ` : '';
        item.textContent = `${variant.height}p MP4${size}`;
        item.addEventListener('click', () => {
          closeMenu();
          void startDownload(variant, options);
        });
        menu.append(item);
      }
      if (variants.length > 1) globalThis.MendoPackageUI?.add(menu, {
        title: options.title, source: `rutube:${videoId}`, close: closeMenu,
        options: variants.map((variant, index) => ({
          id: `rutube-${index}`, label: `${variant.height}p MP4`,
          run: () => startDownload(variant, options),
        })),
      });
    } catch (error) {
      if (menu !== openedMenu) return;
      loading.remove();
      const failed = document.createElement('div');
      failed.className = 'mendosave-rt-item mendosave-rt-muted';
      failed.textContent = `Ошибка: ${String(error?.message || error).slice(0, 90)}`;
      menu.append(failed);
      log('menu', `quality list failed: ${String(error?.message || error)}`);
    }
  }

  function positionMenu() {
    const button = document.getElementById(BUTTON_ID);
    if (!button || !menu) return;
    const box = button.getBoundingClientRect();
    const width = 260;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, box.left + box.width / 2 - width / 2));
    menu.style.left = `${left}px`;
    // Open downwards when there is not enough room above the button.
    const menuHeight = menu.getBoundingClientRect().height || 280;
    menu.style.top = box.top > menuHeight + 16
      ? `${box.top - menuHeight - 8}px`
      : `${Math.min(window.innerHeight - menuHeight - 8, box.bottom + 8)}px`;
  }

  async function startDownload(variant, options) {
    const bundled = packageRunning();
    mendoCheck();
    if (downloadInProgress) {
      if (bundled) throw new Error('Другая загрузка уже выполняется');
      return;
    }
    downloadInProgress = true;
    const notification = getToast();
    let job;
    let producer;
    try {
      producer = await reserveProcessor();
      notification.set(`Готовлю ${variant.height}p…`, 0.02);
      let segments = null;
      let lastError = null;
      for (const mirror of variant.mirrors) {
        try {
          segments = parseMediaPlaylist(await fetchText(mirror), mirror);
          if (segments.length) break;
        } catch (error) {
          mendoCheck();
          if (error?.name === 'AbortError') throw error;
          lastError = error;
        }
      }
      if (!segments?.length) throw lastError || new Error('плейлист сегментов пуст');
      const estimate = (variant.bandwidth || 0) / 8 * (options.durationSeconds || 0);
      log('download', `start; height=${variant.height} segments=${segments.length}`
        + ` mirrors=${variant.mirrors.length} estimateBytes=${Math.round(estimate)}`);

      const filename = `${safeFilename(options.title)} [${variant.height}p].mp4`;
      job = {
        jobId: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
        filename,
        duration: options.durationSeconds,
      };
      await beginJob(job, estimate, producer);

      let sentBytes = 0;
      await streamSegments(segments, async (bytes) => {
        await sendBytes(job.jobId, bytes, producer);
        sentBytes += bytes.length;
      }, (fraction) => {
        notification.set(`Скачивание ${Math.round(fraction * 100)}%`, fraction * 0.92);
      });
      log('download', `segments streamed; bytes=${sentBytes}`);

      notification.set('Сборка файла…', 0.94);
      const result = await mendoSend({ t: 'mendosave-finalize', jobId: job.jobId }, producer);
      if (!result?.ok) throw new Error(result?.error || 'не удалось собрать файл');
      notification.set(`Готово: ${result.filename || filename}`, 1);
      notification.hide(5000);
      return result.filename || filename;
    } catch (error) {
      if (job) await mendoSend({ t: 'mendosave-abort', jobId: job.jobId }, producer).catch(() => {});
      if (error?.name === 'AbortError') {
        notification.set('Загрузка отменена', 1);
        notification.hide(5000);
        if (bundled) throw error;
        return;
      }
      notification.set(`Ошибка: ${String(error?.message || error).slice(0, 140)}`, 1);
      notification.hide(9000);
      if (bundled) throw error;
      await reportError('rutube/download', error, { height: variant?.height, page: location.href });
    } finally {
      releaseProcessor(producer);
      downloadInProgress = false;
    }
  }

  // ---- mounting -------------------------------------------------------------
  // Rutube ships hashed CSS-module class names, so anchors match on the stable
  // part before the hash and every lookup tolerates the element being absent.

  function shortsActionColumn() {
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0
        && box.left < window.innerWidth && box.top < window.innerHeight;
    };
    // The current SPA puts native actions directly in this overlay, without
    // the older wrapper/counter structure. Ignore neighbouring offscreen cards.
    const overlays = [...document.querySelectorAll('[class*="shortsControlsOverlay"]')]
      .filter((element) => visible(element) && element.querySelector('button'));
    const wrappers = overlays.length ? overlays
      : [...document.querySelectorAll('[class*="controlsWrapper"]')].filter(visible);
    // The carousel keeps a wrapper per card; the visible one nearest the centre
    // of the viewport belongs to the reel actually being watched.
    const centre = window.innerHeight / 2;
    const active = wrappers.sort((left, right) => {
      const distance = (element) => {
        const box = element.getBoundingClientRect();
        return Math.abs(box.top + box.height / 2 - centre);
      };
      return distance(left) - distance(right);
    })[0];
    if (!active) return null;
    if (overlays.length) return active;
    // Middle child holds the like/comment counters; first child is the arrow.
    return [...active.children].find((child) => /\d/.test(child.textContent || '')) || null;
  }

  function playerRoot() {
    const media = document.querySelector('video');
    let node = media?.parentElement || null;
    while (node && node !== document.body) {
      const box = node.getBoundingClientRect();
      if (box.width > 320 && box.height > 180) return node;
      node = node.parentElement;
    }
    return document.querySelector('[class*="player"]') || null;
  }

  function ensureButton() {
    if (document.getElementById(BUTTON_ID)) {
      if (isShorts()) {
        // The carousel swaps cards; keep the button on the active one.
        const column = shortsActionColumn();
        const button = document.getElementById(BUTTON_ID);
        if (column && button.parentElement !== column) column.prepend(button);
      }
      return;
    }
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.title = 'MendoSave - скачать';
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', openMenu);

    if (isShorts()) {
      const column = shortsActionColumn();
      if (!column) return;
      button.className = 'mendosave-rt-btn mendosave-rt-shorts';
      const circle = document.createElement('span');
      circle.className = 'mendosave-rt-circle';
      circle.append(createIcon());
      const label = document.createElement('span');
      label.className = 'mendosave-rt-label';
      label.textContent = 'MendoSave';
      button.append(circle, label);
      column.prepend(button);
      return;
    }

    const root = playerRoot();
    if (!root) return;
    button.className = 'mendosave-rt-btn mendosave-rt-overlay';
    button.append(createIcon());
    if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
    root.appendChild(button);
  }

  // requestAnimationFrame does not run in a hidden tab, which would leave the
  // button missing until the tab is first shown. A plain interval does.
  function schedule() {
    try { ensureButton(); } catch (error) {}
  }
  setInterval(schedule, 1000);
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
  schedule();
})();

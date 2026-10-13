// TikTok (tiktok.com) — video without the watermark, plus the sound on its own.
//
// Everything a download needs is already in the page TikTok serves for a
// permalink: `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">` holds
// `webapp.video-detail.itemInfo.itemStruct`, and that carries
//   video.playAddr      — the clean MP4 (no watermark; `downloadAddr` is the
//                         branded render, the same distinction as Coub's G26),
//   video.bitrateInfo[] — the rungs, each with its own byte size,
//   music.playUrl       — the sound as a separate file (MP3 or MP4/AAC).
// A feed page has no itemStruct of its own, so the permalink is fetched
// same-origin and parsed the same way. No API key, no signing, no GraphQL.
//
// The one trap: TikTok's media CDN lives on a DIFFERENT origin
// (v16-webapp-prime.*.tiktok.com), so fetch's default `same-origin`
// credentials mode drops the cookies and the CDN answers 403 with a 505-byte
// body. Measured: the same request with credentials included returns 200 and
// honours Range. Original files use a cookie-bearing page fetch and a Blob;
// MP3 conversion streams the file into the extension media processor.
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

  const BUTTON_CLASS = 'mendosave-tiktok-btn';
  const VIDEO_HREF = /\/video\/(\d+)/;
  const SLICE_BYTES = 4 * 1024 * 1024;
  const TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;
  // The right-hand action column (avatar, like, comments, bookmark, share).
  // TikTok's class names are hashed, but the readable suffix of the styled
  // component survives the build, which is the same substring match the VK
  // adapter uses on the player (I20 forbids keying on the hash, not on this).
  const RAIL_SELECTOR = '[class*="SectionActionBarContainer"]';
  const AVATAR_SELECTOR = '[data-e2e="video-author-avatar"]';
  // The feed carries no /video/<id> link at all; the id lives in the player
  // wrapper's own element id, `xgwrapper-<n>-<itemId>`.
  const PLAYER_ID = /xgwrapper-(?:\d+-)?(\d{6,})/;

  let menu;
  let menuAnchor;
  let busy = false;
  let toastBox;

  function log(tag, text) {
    mendoSend({ t: 'mendosave-log', tag: `tiktok/${tag}`, text }).catch(() => {});
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

  // TikTok captions are mostly emoji, and truncation is by CODE POINT rather
  // than by UTF-16 unit for exactly that reason: String.slice cuts a surrogate
  // pair in half and the lone surrogate makes the whole filename unusable, at
  // which point Chrome names the file after the blob UUID instead of failing.
  function safeName(value) {
    const cleaned = String(value || '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const points = [...cleaned];
    return points.length > 80 ? points.slice(0, 80).join('').trim() : cleaned;
  }

  function formatBytes(size) {
    const value = Number(size) || 0;
    if (!value) return '';
    return value >= 1e6 ? `${(value / 1e6).toFixed(1)} МБ` : `${Math.round(value / 1e3)} КБ`;
  }

  // ---- item data -------------------------------------------------------------

  function videoIdFrom(href) {
    const match = VIDEO_HREF.exec(String(href || ''));
    return match ? match[1] : null;
  }

  function parseUniversalData(html) {
    const match = /id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!match) return null;
    try { return JSON.parse(match[1]); } catch (error) { return null; }
  }

  function itemFromUniversal(universal) {
    const detail = universal?.__DEFAULT_SCOPE__?.['webapp.video-detail'];
    if (!detail) return null;
    if (detail.statusCode && Number(detail.statusCode) !== 0) {
      throw new Error(detail.statusMsg || `TikTok отказал (код ${detail.statusCode})`);
    }
    return detail.itemInfo?.itemStruct || null;
  }

  // Gear names are nominal tiers. Prefer the actual encoded dimensions: the
  // public sample's normal_540_0 is 576×1024. Use the gear only if dimensions
  // are absent, and label a vertical video by its short side.
  function heightFromGear(gear) {
    const match = /_(\d{3,4})_/.exec(String(gear || ''));
    return match ? Number(match[1]) : 0;
  }

  function shortSide(width, height) {
    const values = [Number(width) || 0, Number(height) || 0].filter(Boolean);
    return values.length === 2 ? Math.min(...values) : (values[0] || 0);
  }

  function rungsOf(item) {
    const video = item.video || {};
    const rungs = [];
    for (const entry of video.bitrateInfo || []) {
      const urls = entry?.PlayAddr?.UrlList || [];
      if (!urls.length) continue;
      rungs.push({
        gear: entry.GearName || '',
        width: Number(entry.PlayAddr?.Width) || Number(video.width) || 0,
        pixelHeight: Number(entry.PlayAddr?.Height) || Number(video.height) || 0,
        height: shortSide(entry.PlayAddr?.Width, entry.PlayAddr?.Height)
          || heightFromGear(entry.GearName)
          || shortSide(video.width, video.height),
        bitrate: Number(entry.Bitrate) || 0,
        size: Number(entry.PlayAddr?.DataSize) || 0,
        urls: [...urls],
      });
    }
    // The plain playAddr is what the page itself is playing; keep it as the
    // safety net for an item whose bitrateInfo came back empty.
    if (!rungs.length && video.playAddr) {
      rungs.push({
        gear: 'play', width: Number(video.width) || 0, pixelHeight: Number(video.height) || 0,
        height: shortSide(video.width, video.height), bitrate: Number(video.bitrate) || 0,
        size: Number(video.size) || 0, urls: [video.playAddr],
      });
    }
    // Sorted by BITRATE, not by the number in the gear name. TikTok's
    // `adapt_lower_720_1` really is 720 lines, but it is a lower-bitrate
    // adaptation: measured on one clip it is 2.7 MB against 3.1 MB for
    // `normal_540_0`. Ordering by resolution therefore put a visibly worse and
    // smaller file at the top of the menu and read as a bug — «выбрал 720p, а
    // файл меньше». Bitrate is what actually ranks them.
    rungs.sort((left, right) => (right.bitrate - left.bitrate) || (right.size - left.size));
    // Several gears can share a rung (normal / lower / lowest), so the number
    // alone would label two menu rows identically.
    const perHeight = new Map();
    for (const rung of rungs) perHeight.set(rung.height, (perHeight.get(rung.height) || 0) + 1);
    rungs.forEach((rung, index) => {
      rung.label = rung.height ? `${rung.height}p` : (rung.gear || 'исходное');
      if (rung.height && perHeight.get(rung.height) > 1 && rung.bitrate) {
        rung.label += ` · ${(rung.bitrate / 1e6).toFixed(1)} Мбит/с`;
      }
      rung.best = index === 0;
    });
    return rungs;
  }

  function describe(item) {
    const author = item.author?.uniqueId || item.author?.nickname || 'tiktok';
    const text = safeName(item.desc || '') || item.id;
    return {
      id: String(item.id || ''),
      author,
      title: text,
      duration: Number(item.video?.duration) || 0,
      rungs: rungsOf(item),
      music: {
        url: item.music?.playUrl || '',
        duration: Number(item.music?.duration) || 0,
        title: item.music?.title || '',
        author: item.music?.authorName || '',
      },
      base: `TikTok - ${safeName(author)} - ${text}`,
    };
  }

  const itemCache = new Map();

  async function loadItem(id, href) {
    const cached = itemCache.get(id);
    if (cached) return cached;
    // The page currently open already carries its own item; anything else is
    // fetched as HTML from the same origin, which needs no headers at all.
    if (videoIdFrom(location.pathname) === id) {
      const inline = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (inline) {
        try {
          const item = itemFromUniversal(JSON.parse(inline.textContent));
          if (item && String(item.id) === id) {
            const described = describe(item);
            itemCache.set(id, described);
            return described;
          }
        } catch (error) { /* fall through to the fetch */ }
      }
    }
    if (!href) throw new Error('не удалось определить адрес этого видео');
    const response = await mendoFetch(new URL(href, location.origin).href, { cache: 'no-store' });
    if (!response.ok) throw new Error(`страница видео не открылась (HTTP ${response.status})`);
    const item = itemFromUniversal(parseUniversalData(await response.text()));
    if (!item) throw new Error('в странице нет данных видео (TikTok мог потребовать вход)');
    if (String(item.id) !== id) throw new Error('TikTok вернул данные другого видео; обновите страницу');
    const described = describe(item);
    itemCache.set(id, described);
    return described;
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

  async function sendChunk(jobId, track, bytes, producer) {
    for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_SIZE) {
      const slice = bytes.subarray(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, bytes.length));
      const response = await mendoSend({
        t: 'mendosave-chunk', jobId, track, b64: encodeBase64(slice),
      }, producer);
      if (!response?.ok) throw new Error(response?.error || 'передача данных прервалась');
    }
  }

  // `credentials: 'include'` is the whole point of this function: the CDN is a
  // different origin, and without the cookies it answers 403. `no-store` on top
  // of that, because the page's own player has already pulled the same URL in
  // no-cors mode and that cache entry is unreadable to a CORS request (G5/I3).
  async function fetchRange(url, from, to, total) {
    const response = await mendoFetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Range: `bytes=${from}-${to}` },
    });
    if (response.status !== 206 && response.status !== 200) {
      throw new Error(`сервер отказал на диапазоне (HTTP ${response.status})`);
    }
    const fetchedBytes = new Uint8Array(await response.arrayBuffer());
    // Own the backing buffer: Gecko Xray network views deny the constructor
    // lookup performed by subarray during chunk transfer.
    const bytes = new Uint8Array(fetchedBytes);
    if (bytes.length !== to - from + 1
      || (response.status === 200 && (from !== 0 || to !== total - 1))) {
      throw new Error('сервер вернул неверный размер диапазона');
    }
    // Content-Range is not CORS-safelisted. When the CDN exposes it, verify
    // identity of the slice and consistency with the separately probed file.
    // When it is inaccessible, the exact byte-count check above still applies.
    const contentRange = response.headers?.get?.('content-range');
    if (contentRange !== null && contentRange !== undefined) {
      const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(contentRange.trim());
      const values = match ? match.slice(1).map(Number) : [];
      if (response.status !== 206 || values.length !== 3 || !values.every(Number.isSafeInteger)
        || values[0] !== from || values[1] !== to || values[2] !== total
        || values[0] > values[1] || values[1] >= values[2]) {
        throw new Error('сервер вернул неверный Content-Range');
      }
    }
    return bytes;
  }

  // `Content-Range` is not CORS-safelisted, so it reads as null even on a good
  // 206; the length of an unranged response is (N26).
  async function probeSize(url) {
    const response = await mendoFetch(url, { credentials: 'include', cache: 'no-store' });
    const total = Number(response.headers.get('content-length')) || 0;
    const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`файл недоступен (HTTP ${response.status})`);
    return { total, mime };
  }

  async function beginJob(jobId, filename, options, producer) {
    const ensured = await mendoSend({ t: 'mendosave-ensure' }, producer);
    if (!ensured?.ok) throw new Error(ensured?.error || 'не удалось запустить обработчик медиа');
    const registration = await mendoSend({ t: 'mendosave-register-job', jobId }, producer);
    if (!registration?.ok || !Number.isInteger(registration.tabId)) {
      throw new Error(registration?.error || 'не удалось определить вкладку загрузки');
    }
    const started = await mendoSend({
      t: 'mendosave-begin', jobId, tabId: registration.tabId, filename, ...options,
    }, producer);
    if (!started?.ok) throw new Error(started?.error || 'не удалось начать обработку');
  }

  // Pulls `url` in slices and ships each one onward, so the page never holds
  // more than SLICE_BYTES of a file at a time.
  async function streamThroughOffscreen(url, jobId, track, total, onProgress, producer) {
    let at = 0;
    while (at < total) {
      const end = Math.min(total - 1, at + SLICE_BYTES - 1);
      const bytes = await fetchRange(url, at, end, total);
      if (!bytes.length) throw new Error('сервер вернул пустой диапазон');
      await sendChunk(jobId, track, bytes, producer);
      at += bytes.length;
      onProgress?.(at / total);
    }
  }

  // ---- downloads -------------------------------------------------------------

  // The whole file in one request, read through the body stream so the panel
  // has a real number to show. `credentials: 'include'` is what makes the CDN
  // answer at all (G27).
  async function fetchWholeFile(url, notification, stage, label) {
    const response = await mendoFetch(url, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error(`сервер отказал (HTTP ${response.status})`);
    const declared = Number(response.headers.get('content-length')) || 0;
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type.includes('text/html')) {
      await response.body?.cancel().catch(() => {});
      throw new Error('вместо файла пришла страница — TikTok мог потребовать вход');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      mendoCheck();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      notification.stage(stage, declared ? received / declared : null, 'active', label);
    }
    // I9: a short transfer never becomes a finished file.
    if (declared && received !== declared) {
      throw new Error(`сервер отдал ${received} байт из ${declared}`);
    }
    if (!received) throw new Error('сервер вернул пустой файл');
    return { chunks, bytes: received, type };
  }

  // Keep the cookie-bearing fetch here, then hand its exact bytes to the
  // extension host for normal Save As or archive collection.
  async function saveBlob(chunks, type, filename) {
    mendoCheck();
    if (!globalThis.MendoPackageUI) throw new Error('Обработчик сохранения недоступен');
    await globalThis.MendoPackageUI.saveBlob(new Blob(chunks, { type }), filename);
  }

  // One route, not two. Handing the URL to chrome.downloads was tried first in
  // 1.8 and the CDN refused every single one of them with SERVER_FORBIDDEN —
  // an extension-initiated download does not carry the cookies TikTok wants —
  // so it only ever produced a failed entry in the browser's download list
  // before the page did the work anyway. `urls` are mirrors of the same file.
  async function downloadVideo(info, rung, notification) {
    const filename = `${info.base} [${rung.height || '?'}p].mp4`;
    let lastError = null;
    for (const url of rung.urls) {
      let file;
      try {
        file = await fetchWholeFile(url, notification, 'file', 'Скачивание видео');
      } catch (error) {
        mendoCheck();
        if (error?.name === 'AbortError') throw error;
        lastError = error;
        log('video', `mirror failed: ${String(error?.message || error)}`);
        continue;
      }
      await saveBlob(file.chunks, file.type || 'video/mp4', filename);
      notification.stage('file', 1, 'done', 'Скачивание видео');
      log('video', `saved ${info.id}; rung=${rung.label} bytes=${file.bytes}`);
      return filename;
    }
    throw lastError || new Error('ни одно зеркало CDN не ответило');
  }

  // The sound is a separate file on a CDN that answers an ordinary cross-origin
  // request (measured: 206 without cookies), so it takes the same shape as the
  // VK audio-only job — straight into the muxer, out as .m4a or .mp3.
  function soundName(info) {
    return safeName([info.music.author, info.music.title].filter(Boolean).join(' - '))
      || safeName(info.base);
  }

  // The original sound may be MP3 or MP4/AAC. Preserve its bytes and container
  // instead of assuming every music.playUrl is M4A.
  async function downloadSoundOriginal(info, notification) {
    const file = await fetchWholeFile(info.music.url, notification, 'file', 'Скачивание звука');
    const head = file.chunks[0] || [];
    let format;
    if (file.type.includes('audio/mpeg') || (head[0] === 73 && head[1] === 68 && head[2] === 51)) format = 'mp3';
    else if (file.type.includes('audio/mp4') || file.type.includes('video/mp4')) format = 'm4a';
    else if (file.type.includes('audio/aac')) format = 'aac';
    else throw new Error('TikTok отдал неизвестный формат звука; сохранение отменено');
    const filename = `${soundName(info)}.${format}`;
    await saveBlob(file.chunks, file.type, filename);
    notification.stage('file', 1, 'done', 'Скачивание звука');
    log('sound', `saved ${info.id}; bytes=${file.bytes} format=${format}`);
    return filename;
  }

  async function downloadSound(info, audioFormat, notification, producer) {
    if (!info.music.url) throw new Error('у этого видео нет отдельной звуковой дорожки');
    if (audioFormat !== 'mp3') return downloadSoundOriginal(info, notification);
    notification.stage('file', null, 'active', 'Читаю размер дорожки');
    const { total, mime } = await probeSize(info.music.url);
    if (!total) throw new Error('сервер не сообщил размер дорожки');
    const jobId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const filename = `${soundName(info)}.mp3`;
    const onProgress = (message) => {
      if (message?.t !== 'mendosave-progress' || message.jobId !== jobId) return;
      const value = Number(message.value);
      notification.stage('process', Number.isFinite(value) ? value : null, 'active',
        message.status || 'Сборка файла');
    };
    chrome.runtime.onMessage.addListener(onProgress);
    try {
      await beginJob(jobId, filename, {
        format: 'mp3',
        audioFormat,
        audioQuality: 'best',
        audioMime: mime || 'audio/mpeg',
        audioSize: total,
        videoSize: 0,
        duration: info.music.duration,
      }, producer);
      await streamThroughOffscreen(info.music.url, jobId, 'audio', total, (fraction) => {
        notification.stage('file', fraction, 'active', 'Скачивание звука');
      }, producer);
      notification.stage('file', 1, 'done', 'Скачивание звука');
      notification.stage('process', null, 'active', 'Сборка файла');
      const finalized = await mendoSend({ t: 'mendosave-finalize', jobId }, producer);
      if (!finalized?.ok) throw new Error(finalized?.error || 'не удалось собрать файл');
      notification.stage('process', 1, 'done', 'Сборка файла');
      return finalized.filename || filename;
    } catch (error) {
      await mendoSend({ t: 'mendosave-abort', jobId }, producer).catch(() => {});
      throw error;
    } finally {
      chrome.runtime.onMessage.removeListener(onProgress);
    }
  }

  async function runChoice(entry, choice) {
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
      if (choice.kind === 'sound' && choice.audioFormat === 'mp3') producer = await reserveProcessor();
      // Only the MP3 branch has anything to assemble; video and original sound are saved
      // exactly as the CDN sent them, so an empty «Сборка файла» row would sit
      // there at «ожидание» forever.
      const stages = [{
        id: 'file',
        label: choice.kind === 'sound' ? 'Скачивание звука' : 'Скачивание видео',
      }];
      if (choice.kind === 'sound' && choice.audioFormat === 'mp3') {
        stages.push({ id: 'process', label: 'Сборка файла' });
      }
      notification.begin(choice.kind === 'sound' ? 'Скачиваю звук…' : 'Скачиваю видео…', stages);
      notification.stage('file', null, 'active', 'Читаю данные видео');
      const info = entry.info || await loadItem(entry.id, entry.href);
      entry.info = info;
      const filename = choice.kind === 'sound'
        ? await downloadSound(info, choice.audioFormat, notification, producer)
        : await downloadVideo(info, choice.rung || info.rungs[0], notification);
      notification.set(`Готово: ${filename}`, 1);
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
      void reportError('tiktok-download', error, { kind: choice.kind, id: entry.id });
    } finally {
      releaseProcessor(producer);
      busy = false;
    }
  }

  // ---- toast -----------------------------------------------------------------

  let toastTimer;
  let toastRevision = 0;

  function getToast() {
    const revision = ++toastRevision;
    if (!toastBox) {
      toastBox = createElement('div', 'mendosave-tiktok-toast');
      const text = createElement('div', 'mendosave-tiktok-toast-text');
      const bar = createElement('div', 'mendosave-tiktok-toast-bar');
      bar.append(createElement('i'));
      const stages = createElement('div', 'mendosave-tiktok-stages');
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
          const row = createElement('div', 'mendosave-tiktok-stage queued');
          row.dataset.stage = definition.id;
          const head = createElement('div', 'mendosave-tiktok-stage-head');
          head.append(createElement('span', 'mendosave-tiktok-stage-label', definition.label),
            createElement('span', 'mendosave-tiktok-stage-value', 'ожидание'));
          const bar = createElement('div', 'mendosave-tiktok-stage-bar');
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
        row.className = `mendosave-tiktok-stage ${state}`;
        if (label) row.querySelector('.mendosave-tiktok-stage-label').textContent = label;
        const value = row.querySelector('.mendosave-tiktok-stage-value');
        const fill = row.querySelector('.mendosave-tiktok-stage-bar i');
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

  function closeMenu(restoreFocus = false) {
    menu?.remove();
    menu = undefined;
    if (restoreFocus && menuAnchor?.isConnected) menuAnchor.focus();
    menuAnchor = undefined;
    document.removeEventListener('click', onOutsideClick, true);
    document.removeEventListener('keydown', onMenuKeydown, true);
  }

  function onMenuKeydown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeMenu(true);
  }

  function onOutsideClick(event) {
    if (!menu) return;
    const path = event.composedPath ? event.composedPath() : [event.target];
    if (path.some((node) => node === menu || node?.classList?.contains?.(BUTTON_CLASS))) return;
    closeMenu();
  }

  function addItem(text, hint, onClick) {
    const item = createElement('div', 'mendosave-tiktok-item');
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (!event.repeat) item.click();
    });
    item.append(createElement('span', 'mendosave-tiktok-text', text));
    if (hint) item.append(createElement('span', 'mendosave-tiktok-hint', hint));
    item.addEventListener('click', () => { closeMenu(); onClick(); });
    menu.append(item);
    return item;
  }

  // The item this action column belongs to. Scoped to the column's own feed
  // item first, so a page holding several players (a permalink shows the video
  // plus the next one below it) never binds a button to its neighbour.
  function itemContainerFor(rail) {
    const article = rail.closest('article, [data-e2e="recommend-list-item-container"]');
    if (article) return article;
    let node = rail.parentElement;
    for (let depth = 0; depth < 8 && node; depth++) {
      if (node.querySelectorAll('div[id^="xgwrapper-"]').length === 1) return node;
      node = node.parentElement;
    }
    return null;
  }

  function entryForRail(rail) {
    const container = itemContainerFor(rail);
    const wrapper = container?.querySelector('div[id^="xgwrapper-"]');
    const id = PLAYER_ID.exec(wrapper?.id || '')?.[1] || videoIdFrom(location.pathname);
    if (!id) return null;
    // The permalink is rebuilt from the author link in this very column; the
    // feed publishes no /video/<id> anchor of its own.
    const author = rail.querySelector(AVATAR_SELECTOR)?.getAttribute('href') || '';
    const href = author.startsWith('/@')
      ? `${author}/video/${id}`
      : (videoIdFrom(location.pathname) === id ? location.href : '');
    return { id, href };
  }

  async function openMenu(button, entry, event) {
    event.preventDefault();
    event.stopPropagation();
    if (packageRunning()) return;
    if (menu) { closeMenu(); return; }
    menuAnchor = button;
    menu = createElement('div', 'mendosave-tiktok-menu');
    const openedMenu = menu, sourceHref = location.href;
    const rail = button.closest(RAIL_SELECTOR);
    const current = () => {
      if (menu !== openedMenu) return false;
      if (location.href !== sourceHref || (rail && entryForRail(rail)?.id !== entry.id)) { closeMenu(); return false; }
      return true;
    };
    menu.append(createElement('div', 'mendosave-tiktok-head',
      `MendoSave v${chrome.runtime.getManifest().version}`));
    const loading = createElement('div', 'mendosave-tiktok-item mendosave-tiktok-muted', 'Читаю данные видео…');
    menu.append(loading);
    document.body.appendChild(menu);
    positionMenu(button);
    document.addEventListener('click', onOutsideClick, true);
    document.addEventListener('keydown', onMenuKeydown, true);

    try {
      const info = await loadItem(entry.id, entry.href);
      if (!current()) return;
      entry.info = info;
      loading.remove();
      menu.append(createElement('div', 'mendosave-tiktok-menu-note',
        `${info.author}${info.title && info.title !== info.id ? ` — ${info.title}` : ''}`));

      for (const rung of info.rungs) {
        addItem(
          `Видео · ${rung.label}`,
          // The size leads the hint: the rungs are ordered by bitrate, so the
          // resolution alone does not tell the viewer which file is bigger.
          [rung.width && rung.pixelHeight ? `${rung.width}×${rung.pixelHeight}` : '',
            formatBytes(rung.size), rung.best ? 'макс. битрейт' : '', 'исходный поток']
            .filter(Boolean).join(' · '),
          () => void runChoice(entry, { kind: 'video', rung }),
        );
      }
      if (info.music.url) {
        addItem('Только звук · исходный файл', 'без перекодирования',
          () => void runChoice(entry, { kind: 'sound', audioFormat: 'original' }));
        addItem('Только звук · MP3', 'перекодирование',
          () => void runChoice(entry, { kind: 'sound', audioFormat: 'mp3' }));
      }
      const options = info.rungs.map((rung, index) => ({
        id: `tiktok-video-${encodeURIComponent(rung.gear)}-${rung.bitrate}-${rung.width}-${rung.pixelHeight}-${rung.size}`,
        label: `Видео · ${rung.label}`,
        compatibilityKey: JSON.stringify([rung.gear, rung.bitrate, rung.width, rung.pixelHeight, rung.size]), group: 'Видео',
        run: () => runChoice(entry, { kind: 'video', rung }),
      }));
      if (info.music.url) options.push(
        { id: 'tiktok-sound-original', label: 'Только звук · исходный файл', group: 'Аудио',
          run: () => runChoice(entry, { kind: 'sound', audioFormat: 'original' }) },
        { id: 'tiktok-sound-mp3', label: 'Только звук · MP3', group: 'Аудио',
          run: () => runChoice(entry, { kind: 'sound', audioFormat: 'mp3' }) },
      );
      if (options.length > 1) globalThis.MendoPackageUI?.add(menu, {
        title: info.title || info.id, source: `tiktok:${info.id || entry.id}`, options, close: closeMenu,
        back: async () => {
          const currentId = videoIdFrom(location.pathname);
          const rails = [...document.querySelectorAll(RAIL_SELECTOR)];
          const rail = rails.find((candidate) => entryForRail(candidate)?.id === currentId)
            || (!currentId && button.isConnected ? button.closest(RAIL_SELECTOR) : null);
          const current = rail?.querySelector(`.${BUTTON_CLASS}`);
          const currentEntry = rail && entryForRail(rail);
          if (!current?.isConnected || !currentEntry) return null;
          await openMenu(current, currentEntry, { preventDefault() {}, stopPropagation() {} });
          return menu?.querySelector('.mendo-package-open') || current;
        },
      });
      globalThis.MendoMenu?.bind(menu, () => closeMenu(true), '.mendosave-tiktok-item[role="button"],.mendo-package-open');
      positionMenu(button);
    } catch (error) {
      if (!current()) return;
      loading.remove();
      menu.append(createElement('div', 'mendosave-tiktok-item mendosave-tiktok-muted',
        `Ошибка: ${String(error?.message || error).slice(0, 120)}`));
      log('menu', `list failed: ${String(error?.message || error)}`);
    }
  }

  function positionMenu(button) {
    if (!menu || !button) return;
    const box = button.getBoundingClientRect();
    const width = menu.getBoundingClientRect().width || 320;
    const height = menu.getBoundingClientRect().height || 200;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, box.right - width))}px`;
    menu.style.top = box.top > height + 16
      ? `${box.top - height - 8}px`
      : `${Math.min(window.innerHeight - height - 8, box.bottom + 8)}px`;
  }

  // ---- mounting ----------------------------------------------------------------

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

  // Into the action column, above the avatar — the place the viewer already
  // looks for per-video actions, and the same position the Shorts button takes
  // on YouTube. The column is a flex column whose first child is the avatar, so
  // "above it" is simply the first position.
  function mountInRail(rail) {
    const entry = entryForRail(rail);
    if (!entry) return;
    const existing = rail.querySelector(`.${BUTTON_CLASS}`);
    // The feed reuses a column for the next reel as it scrolls, so a button
    // still carrying the previous id would download the wrong video.
    if (existing) {
      if (existing.dataset.mendosaveVideo === entry.id) return;
      existing.remove();
    }
    const button = document.createElement('button');
    button.className = `${BUTTON_CLASS} mendosave-tiktok-rail-btn`;
    button.type = 'button';
    button.dataset.mendosaveVideo = entry.id;
    button.title = 'Скачать видео (MendoSave)';
    button.setAttribute('aria-label', button.title);
    button.append(createIcon());
    button.addEventListener('click', (event) => {
      const currentEntry = entryForRail(button.closest(RAIL_SELECTOR));
      if (currentEntry) void openMenu(button, currentEntry, event);
    });
    rail.insertBefore(button, rail.firstElementChild);
  }

  function ensureButtons() {
    for (const rail of document.querySelectorAll(RAIL_SELECTOR)) {
      if (rail.getBoundingClientRect().width > 0) mountInRail(rail);
    }
  }

  // An interval, not requestAnimationFrame: rAF never runs in a hidden tab
  // (N29), and TikTok rewrites its route on every swipe without a page load.
  setInterval(() => { try { ensureButtons(); } catch (error) {} }, 1500);
  document.addEventListener('visibilitychange', () => { try { ensureButtons(); } catch (error) {} });
  window.addEventListener('scroll', () => { if (menu) closeMenu(); }, { passive: true });
  try { ensureButtons(); } catch (error) {}
})();

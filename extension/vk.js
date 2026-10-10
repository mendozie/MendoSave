// VK Video adapter (vkvideo.ru, vk.com/video…).
//
// The page is a lazy SPA: no <video> exists until playback starts and the HTML
// carries no media URLs at all. The player's own embed endpoint does —
// `/video_ext.php?oid=…&id=…` answers with the player payload, and its `files`
// object holds progressive `mp4_144…mp4_720` plus `dash_sep`, a DASH manifest
// with video and audio in separate AdaptationSets.
//
// Two consequences shape everything below:
//   * a progressive file needs no assembly, so it goes straight to
//     chrome.downloads — no fetch, no CORS, no copy in the page;
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
  const TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;
  const VIDEO_ID_RE = /\/(?:video|clip)(-?\d+)_(\d+)/;

  let menu;
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
  function extractObject(html, key) {
    const at = html.indexOf(`"${key}"`);
    if (at < 0) return null;
    const open = html.indexOf('{', at);
    if (open < 0) return null;
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
    const match = html.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
    if (!match) return '';
    try { return JSON.parse(`"${match[1]}"`); } catch (e) { return ''; }
  }

  async function loadVideo(target) {
    const ids = videoIdFrom(target) || videoIdFrom(location.pathname);
    if (!ids) throw new Error('не удалось определить видео');
    const url = `${location.origin}/video_ext.php?oid=${encodeURIComponent(ids.oid)}`
      + `&id=${encodeURIComponent(ids.id)}&hd=4&autoplay=0`;
    // With cookies: age-restricted and closed-group videos answer with an error
    // payload otherwise, and the site itself loads the player the same way.
    const response = await mendoFetch(url, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error(`страница плеера не открылась (HTTP ${response.status})`);
    // VK still serves this endpoint as windows-1251. Read as UTF-8 the title
    // decodes to replacement characters and the saved file is called
    // "VK - ???????.m4a", so the charset is taken from the response itself.
    const html = decodeBody(await response.arrayBuffer(), response.headers.get('content-type'));
    const files = extractObject(html, 'files');
    if (!files) {
      const reason = extractString(html, 'error_msg') || extractString(html, 'msg');
      throw new Error(reason || 'в ответе плеера нет ссылок на файлы');
    }
    const durationMatch = html.match(/"duration":(\d+)/);
    return {
      ...ids,
      files,
      duration: durationMatch ? Number(durationMatch[1]) : 0,
      title: extractString(html, 'md_title') || extractString(html, 'title') || `video${ids.oid}_${ids.id}`,
    };
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
      headers: { Range: `bytes=${from}-${to}` },
    });
    if (response.status !== 206 && response.status !== 200) {
      throw new Error(`сервер отказал на диапазоне (HTTP ${response.status})`);
    }
    // A server may ignore Range or return a short body. Appending that body
    // and advancing by its length can repeat the beginning or silently truncate
    // the audio. Only accept the exact requested bytes before handing them on.
    if (response.status === 200 && from !== 0) throw new Error('сервер проигнорировал диапазон аудиодорожки');
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
    // Own the backing buffer before species-based subarray/base64 operations:
    // Gecko's view over a DOM-returned ArrayBuffer can retain its foreign realm.
    const fetchedBytes = new Uint8Array(await response.arrayBuffer());
    const bytes = new Uint8Array(fetchedBytes);
    if (bytes.length !== to - from + 1) throw new Error('сервер вернул неполный или неверный диапазон аудиодорожки');
    return bytes;
  }

  // `Content-Range` is not a CORS-safelisted response header, so its value is
  // invisible to the page even when the ranged request itself succeeds — the
  // first attempt at sizing the track read `null` from it and refused to start.
  // `Content-Length` of an unranged response is safelisted; the body is dropped
  // as soon as the headers are in, so nothing is transferred for it.
  async function probeSize(url) {
    for (const method of ['HEAD', 'GET']) {
      try {
        const response = await mendoFetch(url, { method, credentials: 'omit', cache: 'no-store' });
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
      if (choice.kind !== 'video') producer = await reserveProcessor();
      let filename;
      if (choice.kind === 'video') {
        filename = `VK - ${safeName(info.title)} [${choice.rung.height}p].mp4`;
        notification.begin(`Скачиваю ${choice.rung.height}p…`, [{ id: 'file', label: 'Загрузка файла' }]);
        notification.stage('file', null, 'active', 'Передача браузеру');
        const downloadId = await saveDirect(choice.rung.url, filename);
        log('video', `handed to downloads; height=${choice.rung.height} id=${downloadId}`);
        // The browser only ACCEPTED it here; the bytes keep arriving for a
        // while, so the panel follows the real transfer instead of claiming
        // "готово" against a downloads list that says otherwise.
        await followBrowserDownload(downloadId, notification);
        filename = downloadId?.filename || filename;
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

  async function openMenu(button, event) {
    event.preventDefault();
    event.stopPropagation();
    if (packageRunning()) return;
    if (menu) { closeMenu(); return; }
    menu = createElement('div', 'mendosave-vk-menu');
    const heading = createElement('div', 'mendosave-vk-head', `MendoSave v${chrome.runtime.getManifest().version}`);
    const loading = createElement('div', 'mendosave-vk-item mendosave-vk-muted', 'Читаю данные видео…');
    menu.append(heading, loading);
    document.body.appendChild(menu);
    positionMenu(button);
    document.addEventListener('click', onOutsideClick, true);

    try {
      const info = await loadVideo(location.href);
      if (!menu) return;
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
        item.addEventListener('click', () => { closeMenu(); void runChoice(info, choice); });
        menu.append(item);
      }
      if (choices.length > 1) globalThis.MendoPackageUI?.add(menu, {
        title: info.title, source: `vk:${info.oid}_${info.id}`, close: closeMenu,
        options: choices.map((choice, index) => ({
          id: `vk-${index}`, label: choice.text,
          run: () => runChoice(info, choice),
        })),
      });
      positionMenu(button);
    } catch (error) {
      if (!menu) return;
      loading.remove();
      menu.append(createElement('div', 'mendosave-vk-item mendosave-vk-muted',
        `Ошибка: ${String(error?.message || error).slice(0, 120)}`));
      log('menu', `list failed: ${String(error?.message || error)}`);
    }
  }

  function positionMenu(button) {
    if (!menu || !button) return;
    const box = button.getBoundingClientRect();
    const width = menu.getBoundingClientRect().width || 280;
    const height = menu.getBoundingClientRect().height || 200;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, box.right - width))}px`;
    menu.style.top = box.top > height + 16
      ? `${box.top - height - 8}px`
      : `${Math.min(window.innerHeight - height - 8, box.bottom + 8)}px`;
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
    try { ensureButton(); } catch (error) {}
  }
  setInterval(schedule, 1000);
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('scroll', () => { if (menu) closeMenu(); }, { passive: true });
  schedule();
})();

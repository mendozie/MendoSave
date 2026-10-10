// Twitch: live recording, clips and VODs.
//
// Live is recorded from the player (a broadcast is realtime by nature, so 1x
// recording is the lossless-speed option). Clips and VODs are NOT: their media
// is cross-origin, so `captureStream()` throws outright — the error users saw
// was "Cannot capture from element with cross-origin data". Both are published
// through Twitch's public GraphQL endpoint instead: a clip is a plain MP4, a
// VOD is HLS with MPEG-TS segments, which the shared offscreen muxer already
// accepts as one pre-muxed input (`muxed: true`, the Rutube path).
(() => {
  const mendoSend = (message) => globalThis.MendoPackageUI
    ? globalThis.MendoPackageUI.send(message) : chrome.runtime.sendMessage(message);
  const mendoFetch = (url, options) => globalThis.MendoPackageUI
    ? globalThis.MendoPackageUI.fetch(url, options) : fetch(url, options);
  const mendoCheck = () => globalThis.MendoPackageUI?.check();
  const packageRunning = () => Boolean(globalThis.MendoPackageUI?.running);
  function downloadInterrupted(code) {
    if (globalThis.MendoPackageUI) globalThis.MendoPackageUI.interruption(code);
    const error = new Error(`Сохранение прервано: ${code || 'причина не указана'}`);
    if (code === 'USER_CANCELED' || code === 'USER_CANCELLED') error.name = 'AbortError';
    throw error;
  }

  const BUTTON_ID = 'mendosave-twitch-record';
  const MENU_ID = 'mendosave-twitch-menu';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GQL_URL = 'https://gql.twitch.tv/gql';
  // Twitch's own web client id: the site itself sends it from the browser, and
  // the queries below are the ones the player makes to play the same video.
  const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const SEGMENT_CONCURRENCY = 6;
  const TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;
  // A VOD past this is spooled to disk by the muxer instead of being held in
  // memory, so the old honest refusal at 1.5 GB is gone: the ceiling is now free
  // disk space. Kept only as the hint that decides it up front.
  const VOD_SPOOL_HINT = 256 * 1024 * 1024;

  let recorder = null;
  let recorderMime = 'video/webm';
  let recordingSession = null;
  let recordingStarting = false;
  let recordedVideo = null;
  let recordingChannel = '';
  let startPath = '';
  let startedAt = 0;
  let watchdog = null;
  let stopReason = '';
  let injectFrame;
  let menu;
  let busy = false;

  // ---- page kind -----------------------------------------------------------

  function pageKind() {
    if (location.hostname === 'clips.twitch.tv') {
      const slug = location.pathname.split('/').filter(Boolean)[0];
      return slug ? { kind: 'clip', slug } : { kind: 'other' };
    }
    const segments = location.pathname.split('/').filter(Boolean);
    if (segments[1] === 'clip' && segments[2]) return { kind: 'clip', slug: segments[2] };
    if (segments[0] === 'videos' && segments[1]) return { kind: 'vod', id: segments[1] };
    if (segments.length === 1) return { kind: 'live', channel: segments[0] };
    return { kind: 'other' };
  }

  function channelFromLocation() {
    const segments = location.pathname.split('/').filter(Boolean);
    return segments[0] === 'videos'
      ? (segments[1] ? `vod-${segments[1]}` : 'vod')
      : (segments[0] || 'stream');
  }

  // Code points, not UTF-16 units: slicing through a surrogate pair leaves a
  // lone surrogate, and Chrome then names the file after the blob UUID (G28).
  function safeName(value) {
    const cleaned = String(value || '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    const points = [...cleaned];
    return points.length > 120 ? points.slice(0, 120).join('').trim() : cleaned;
  }

  // ---- Twitch API ----------------------------------------------------------

  // Plain queries, not persisted ones: a persisted query depends on a hash that
  // Twitch rotates, and a rotated hash would break downloads silently.
  async function gql(query) {
    let response;
    try {
      response = await mendoFetch(GQL_URL, {
        method: 'POST',
        headers: { 'Client-ID': GQL_CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        credentials: 'omit',
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      // Distinguish the one failure that needs a different fix: a blocked
      // cross-origin request has to be moved into the service worker, while
      // everything else is a Twitch-side answer we can read.
      throw new Error(`запрос к Twitch не прошёл (${String(error?.message || error)})`);
    }
    if (!response.ok) throw new Error(`Twitch API ответил ${response.status}`);
    const payload = await response.json();
    if (payload?.errors?.length) {
      throw new Error(payload.errors.map((entry) => entry.message).join('; '));
    }
    return payload?.data || {};
  }

  const ACCESS_PARAMS = 'params: { platform: "web", playerBackend: "mediaplayer", playerType: "site" }';

  async function loadClip(slug) {
    const data = await gql(`{
      clip(slug: "${slug}") {
        title
        durationSeconds
        broadcaster { displayName }
        videoQualities { frameRate quality sourceURL }
        playbackAccessToken(${ACCESS_PARAMS}) { signature value }
      }
    }`);
    const clip = data.clip;
    if (!clip) throw new Error('клип не найден');
    const token = clip.playbackAccessToken;
    const qualities = (clip.videoQualities || [])
      .filter((entry) => entry?.sourceURL)
      .map((entry) => ({
        label: `${entry.quality}p${Number(entry.frameRate) >= 50 ? Math.round(entry.frameRate) : ''}`,
        height: Number.parseInt(entry.quality, 10) || 0,
        url: token
          ? `${entry.sourceURL}?sig=${encodeURIComponent(token.signature)}&token=${encodeURIComponent(token.value)}`
          : entry.sourceURL,
      }))
      .sort((left, right) => right.height - left.height);
    if (!qualities.length) throw new Error('Twitch не отдал ссылки на файл клипа');
    return {
      kind: 'clip',
      title: clip.title || slug,
      channel: clip.broadcaster?.displayName || channelFromLocation(),
      duration: Number(clip.durationSeconds) || 0,
      qualities,
    };
  }

  async function loadVod(id) {
    const data = await gql(`{
      video(id: "${id}") { title lengthSeconds owner { displayName } }
      videoPlaybackAccessToken(id: "${id}", ${ACCESS_PARAMS}) { signature value }
    }`);
    const token = data.videoPlaybackAccessToken;
    if (!token?.value) throw new Error('Twitch не выдал токен воспроизведения');
    const master = new URL(`https://usher.ttvnw.net/vod/${id}.m3u8`);
    master.searchParams.set('allow_source', 'true');
    master.searchParams.set('allow_audio_only', 'true');
    master.searchParams.set('player', 'twitchweb');
    master.searchParams.set('sig', token.signature);
    master.searchParams.set('token', token.value);
    const response = await mendoFetch(master.href, { credentials: 'omit' });
    if (!response.ok) throw new Error(`плейлист недоступен (HTTP ${response.status})`);
    const qualities = parseMasterPlaylist(await response.text(), response.url || master.href);
    if (!qualities.length) throw new Error('в плейлисте нет ни одной ступени качества');
    return {
      kind: 'vod',
      title: data.video?.title || `video-${id}`,
      channel: data.video?.owner?.displayName || channelFromLocation(),
      duration: Number(data.video?.lengthSeconds) || 0,
      qualities,
    };
  }

  // Master playlist: every #EXT-X-STREAM-INF line is followed by its URL. The
  // step is named by the short side, the same rule the Rutube adapter uses, so
  // a vertical clip is not labelled by its long side.
  function parseMasterPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const variants = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
      const url = (lines[index + 1] || '').trim();
      if (!url || url.startsWith('#')) continue;
      const resolution = /RESOLUTION=(\d+)x(\d+)/.exec(line);
      const name = /VIDEO="([^"]+)"/.exec(line) || /NAME="([^"]+)"/.exec(line);
      const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(line)?.[1]) || 0;
      const height = resolution ? Math.min(Number(resolution[1]), Number(resolution[2])) : 0;
      const frameRate = Number(/\bFRAME-RATE=(\d+(?:\.\d+)?)(?:,|$)/.exec(line)?.[1]) || 0;
      variants.push({
        label: height ? `${height}p${frameRate ? ` · ${frameRate} fps` : ''}` : (name?.[1] || 'auto'),
        height,
        frameRate,
        sourceName: name?.[1] || '',
        bandwidth,
        url: new URL(url, baseUrl).href,
      });
    }
    const labels = new Map();
    for (const variant of variants) labels.set(variant.label, (labels.get(variant.label) || 0) + 1);
    for (const variant of variants) {
      if (labels.get(variant.label) < 2) continue;
      // VIDEO names are source tier identifiers, not measured FPS. Twitch can
      // name tiers 720p60/720p30 while declaring the same FRAME-RATE for both.
      const details = [variant.sourceName ? `вариант ${variant.sourceName}` : '',
        variant.bandwidth ? `${(variant.bandwidth / 1e6).toFixed(2)} Мбит/с` : ''].filter(Boolean);
      if (details.length) variant.label += ` · ${details.join(' · ')}`;
    }
    return variants.sort((left, right) => (right.height - left.height) || (right.bandwidth - left.bandwidth));
  }

  async function loadVodSegments(playlistUrl) {
    const response = await mendoFetch(playlistUrl, { credentials: 'omit' });
    if (!response.ok) throw new Error(`медиаплейлист недоступен (HTTP ${response.status})`);
    const text = await response.text();
    if (!/^#EXT-X-ENDLIST\s*$/m.test(text)) {
      throw new Error('VOD ещё не завершён; дождитесь готовой записи');
    }
    const base = new URL(playlistUrl);
    const segments = [];
    let duration = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('#EXT-X-MAP:')) throw new Error('VOD в fMP4 пока не поддерживается');
      if (line.startsWith('#EXT-X-BYTERANGE:')) throw new Error('VOD с диапазонами bytes пока не поддерживается');
      if (line.startsWith('#EXT-X-KEY:') && !/\bMETHOD=NONE(?:,|$)/.test(line)) {
        throw new Error('этот VOD зашифрован; такой плейлист не поддерживается');
      }
      if (line.startsWith('#EXTINF')) {
        duration += Number.parseFloat(line.slice(8)) || 0;
        continue;
      }
      if (!line || line.startsWith('#')) continue;
      segments.push(new URL(line, base).href);
    }
    if (!segments.length) throw new Error('в плейлисте нет сегментов');
    return { segments, duration };
  }

  // ---- downloading ---------------------------------------------------------

  async function fetchSegment(url, attempt = 0) {
    try {
      const response = await mendoFetch(url, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const fetchedBytes = new Uint8Array(await response.arrayBuffer());
      // A Gecko Xray view cannot safely perform the species lookup in subarray.
      // Copy once at the network boundary into an extension-owned buffer.
      const bytes = new Uint8Array(fetchedBytes);
      if (!bytes.length) throw new Error('пустой сегмент');
      return bytes;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (attempt >= 2) throw error;
      await new Promise((resolve) => { setTimeout(resolve, 300 * (attempt + 1)); });
      return fetchSegment(url, attempt + 1);
    }
  }

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

  async function sendChunks(jobId, bytes) {
    for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_SIZE) {
      const chunk = bytes.subarray(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, bytes.length));
      const response = await mendoSend({
        t: 'mendosave-chunk', jobId, track: 'video', b64: encodeBase64(chunk),
      });
      if (!response?.ok) throw new Error(response?.error || 'передача данных прервалась');
    }
  }

  // Segments go to the muxer as they arrive, in playlist order: a VOD is far
  // too big to first collect whole and then hand over.
  async function downloadVod(info, quality) {
    const { segments, duration } = await loadVodSegments(quality.url);
    const estimate = (quality.bandwidth || 0) / 8 * (duration || info.duration || 0);
    const jobId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const filename = `Twitch - ${safeName(info.channel)} - ${safeName(info.title)} [${quality.label}].mp4`;

    const ensured = await mendoSend({ t: 'mendosave-ensure' });
    if (!ensured?.ok) throw new Error(ensured?.error || 'не удалось запустить обработчик медиа');
    const registration = await mendoSend({ t: 'mendosave-register-job', jobId });
    if (!registration?.ok || !Number.isInteger(registration.tabId)) {
      throw new Error(registration?.error || 'не удалось определить вкладку загрузки');
    }
    const started = await mendoSend({
      t: 'mendosave-begin',
      jobId,
      tabId: registration.tabId,
      filename,
      format: 'mp4',
      muxed: true,
      videoMime: 'video/mp2t',
      audioMime: '',
      duration: duration || info.duration || 0,
      // Lets the muxer spool to disk from the first chunk instead of finding out
      // the hard way; it also switches over on its own if the estimate is low.
      expectedBytes: estimate > VOD_SPOOL_HINT ? Math.round(estimate) : 0,
    });
    if (!started?.ok) throw new Error(started?.error || 'не удалось начать обработку');

    try {
      // Bound retained bytes as well as concurrent requests. A stalled head or
      // a slow processor must not let the other workers collect an entire VOD.
      for (let start = 0; start < segments.length; start += SEGMENT_CONCURRENCY) {
        const batch = await Promise.allSettled(segments.slice(start, start + SEGMENT_CONCURRENCY)
          .map((url) => fetchSegment(url)));
        const failed = batch.find((entry) => entry.status === 'rejected');
        if (failed) throw failed.reason;
        for (let offset = 0; offset < batch.length; offset++) {
          await sendChunks(jobId, batch[offset].value);
          batch[offset].value = null;
          toast(`MendoSave: скачано ${start + offset + 1} из ${segments.length} сегментов`, true);
        }
      }
      const result = await mendoSend({ t: 'mendosave-finalize', jobId });
      if (!result?.ok) throw new Error(result?.error || 'не удалось собрать файл');
      return result.filename || filename;
    } catch (error) {
      await mendoSend({ t: 'mendosave-abort', jobId }).catch(() => {});
      throw error;
    }
  }

  // A clip is already one signed MP4. Handing the URL to the downloads API
  // keeps the bytes out of the page entirely — no fetch, no CORS, no copy.
  async function downloadClip(info, quality) {
    const filename = `Twitch - ${safeName(info.channel)} - ${safeName(info.title)} [${quality.label}].mp4`;
    const saved = await mendoSend({
      t: 'mendosave-save', url: quality.url, filename,
    });
    if (!saved?.ok) throw new Error(saved?.error || 'браузер не принял файл на сохранение');
    if (saved.collected) return saved.filename || filename;
    let misses = 0;
    for (;;) {
      mendoCheck();
      await new Promise((resolve) => setTimeout(resolve, 700));
      const state = await mendoSend({ t: 'mendosave-download-state', id: saved.id }).catch((error) => {
        if (error?.name === 'AbortError') throw error;
        return null;
      });
      if (!state?.ok) {
        if (++misses > 8) throw new Error(state?.error || 'браузер потерял загрузку');
        continue;
      }
      misses = 0;
      if (state.state === 'complete') break;
      if (state.state === 'interrupted') downloadInterrupted(state.error);
    }
    return filename;
  }

  // ---- UI ------------------------------------------------------------------

  function toast(message, sticky = false) {
    let box = document.getElementById('mendosave-twitch-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mendosave-twitch-toast';
      document.body.append(box);
    }
    box.textContent = message;
    box.classList.add('show');
    clearTimeout(toast.timer);
    if (!sticky) toast.timer = setTimeout(() => box.classList.remove('show'), 5000);
  }

  function closeMenu() {
    document.removeEventListener('keydown', onMenuKeydown, true);
    menu?.remove();
    menu = null;
  }

  function onMenuKeydown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeMenu();
  }

  function openMenu(button, info) {
    closeMenu();
    menu = document.createElement('div');
    menu.id = MENU_ID;
    const header = document.createElement('div');
    header.className = 'mendosave-twitch-menu-title';
    header.textContent = info.kind === 'clip' ? 'Скачать клип' : 'Скачать запись';
    menu.append(header);
    for (const quality of info.qualities) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'mendosave-twitch-menu-item';
      item.textContent = quality.label;
      item.addEventListener('click', () => {
        closeMenu();
        void runDownload(info, quality);
      });
      menu.append(item);
    }
    if (info.qualities.length > 1) globalThis.MendoPackageUI?.add(menu, {
      title: info.title, close: closeMenu,
      options: info.qualities.map((quality, index) => ({
        id: `twitch-${index}`, label: quality.label,
        run: () => runDownload(info, quality),
      })),
    });
    document.body.append(menu);
    document.addEventListener('keydown', onMenuKeydown, true);
    const box = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, box.top - menu.offsetHeight - 8)}px`;
    setTimeout(() => {
      document.addEventListener('click', onDocumentClick, { once: true });
    }, 0);
  }

  function onDocumentClick(event) {
    if (menu && !menu.contains(event.target)) closeMenu();
  }

  async function runDownload(info, quality) {
    const bundled = packageRunning();
    mendoCheck();
    if (busy) {
      if (bundled) throw new Error('Другая загрузка уже выполняется');
      return;
    }
    busy = true;
    try {
      toast(`MendoSave: скачиваю ${quality.label}…`, true);
      const filename = info.kind === 'clip'
        ? await downloadClip(info, quality)
        : await downloadVod(info, quality);
      toast(`MendoSave: готово — ${filename}`);
      return filename;
    } catch (error) {
      if (bundled) throw error;
      if (error?.name === 'AbortError') {
        toast('MendoSave: загрузка отменена');
        return;
      }
      toast(`MendoSave: ${String(error?.message || error)}`);
    } finally {
      busy = false;
    }
  }

  async function onButtonClick(button) {
    if (packageRunning()) return;
    const page = pageKind();
    if (page.kind === 'live') {
      if (recorder) stopRecording('остановлено пользователем');
      else void startRecording();
      return;
    }
    if (page.kind !== 'clip' && page.kind !== 'vod') {
      toast('MendoSave: на этой странице нечего скачивать');
      return;
    }
    if (busy) return;
    busy = true;
    try {
      toast('MendoSave: читаю данные…', true);
      const info = page.kind === 'clip' ? await loadClip(page.slug) : await loadVod(page.id);
      toast('');
      document.getElementById('mendosave-twitch-toast')?.classList.remove('show');
      openMenu(button, info);
    } catch (error) {
      toast(`MendoSave: ${String(error?.message || error)}`);
    } finally {
      busy = false;
    }
  }

  // ---- live recording -----------------------------------------------------

  function findControlsGroup() {
    return document.querySelector('.player-controls__right-control-group')
      || document.querySelector('[data-a-target="player-controls"] > div:last-child');
  }

  function findPlayerVideo() {
    const videos = [...document.querySelectorAll('video')];
    return videos.find((media) => media.readyState >= 2 && !media.ended) || videos[0] || null;
  }

  function formatElapsed(ms) {
    const total = Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const seconds = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
  }

  function pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  }

  function cleanupWatchdog() {
    clearInterval(watchdog);
    watchdog = null;
    if (recordedVideo) {
      recordedVideo.removeEventListener('ended', onPlayerEnded);
      recordedVideo = null;
    }
  }

  function onPlayerEnded() {
    stopRecording('трансляция завершилась');
  }

  function bindRecordingPort(jobId) {
    const port = chrome.runtime.connect({ name: `mendosave-twitch-recording:${jobId}` });
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
      };
      const fail = (error) => {
        cleanup();
        port.disconnect();
        reject(error);
      };
      const onMessage = (message) => {
        if (message?.ok !== true) {
          fail(new Error(message?.error || 'обработчик не подтвердил запись'));
          return;
        }
        cleanup();
        resolve(port);
      };
      const onDisconnect = () => fail(new Error('связь с обработчиком записи прервалась'));
      const timer = setTimeout(() => fail(new Error('обработчик не подтвердил запись за 30 секунд')), 30_000);
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
    });
  }

  function preserveRecordingChunk(session, blob) {
    if (!blob?.size || session.finished || session.failed) return;
    session.queuedBytes += blob.size;
    if (session.queuedBytes - session.sentBytes > 192 * 1024 * 1024) {
      session.failed = 'передача записи не успевает за эфиром';
      stopRecording('ошибка передачи записи');
      return;
    }
    session.chain = session.chain.then(async () => {
      if (session.failed) return;
      const blobBytes = new Uint8Array(await blob.arrayBuffer());
      const bytes = new Uint8Array(blobBytes);
      for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_SIZE) {
        const response = await mendoSend({
          t: 'mendosave-live-chunk', jobId: session.jobId, track: 'video',
          mime: session.mime, b64: encodeBase64(bytes.subarray(offset, offset + TRANSFER_CHUNK_SIZE)),
        });
        if (!response?.ok) throw new Error(response?.error || 'обработчик не сохранил фрагмент записи');
      }
      session.sentBytes += bytes.length;
    }).catch((error) => {
      session.failed = String(error?.message || error);
      if (recordingSession === session) stopRecording('ошибка передачи записи');
    });
  }

  async function startRecording() {
    if (recorder || recordingStarting || recordingSession) return;
    const media = findPlayerVideo();
    if (!media) {
      toast('MendoSave: плеер не найден');
      return;
    }
    // An offline player can leave play() pending indefinitely. Check that a
    // current frame exists before trying to resume or capture its stream.
    if (!(media.readyState >= 2) || media.error || media.ended) {
      toast('MendoSave: видеокадр пока недоступен, дождитесь начала трансляции');
      return;
    }
    recordingStarting = true;
    toast('MendoSave: подготавливаю запись…', true);
    let session;
    try {
      if (media.paused) {
        try { await media.play(); } catch (error) {}
      }
      let stream;
      try { stream = media.captureStream(); } catch (error) {
        throw new Error(`не удалось захватить поток (${error?.message || error})`, { cause: error });
      }
      if (!stream.getVideoTracks().length) throw new Error('видеопоток пока недоступен, попробуйте через пару секунд');
      recorderMime = pickMimeType();
      if (!recorderMime) throw new Error('совместимый формат WebM недоступен в этом браузере');
      const active = new MediaRecorder(stream, {
        mimeType: recorderMime,
        videoBitsPerSecond: 12_000_000,
        audioBitsPerSecond: 192_000,
      });
      startedAt = Date.now();
      recordingChannel = channelFromLocation();
      const stamp = new Date(startedAt).toLocaleString('sv').replace(/:/g, '-').replace(' ', '_');
      session = {
        jobId: crypto.randomUUID(),
        filename: `Twitch - ${safeName(recordingChannel)} - ${stamp}.webm`,
        mime: active.mimeType || recorderMime,
        chain: Promise.resolve(), queuedBytes: 0, sentBytes: 0, failed: '', finished: false,
      };
      const ensured = await mendoSend({ t: 'mendosave-ensure' });
      if (!ensured?.ok) throw new Error(ensured?.error || 'не удалось запустить обработчик записи');
      const registration = await mendoSend({ t: 'mendosave-register-job', jobId: session.jobId });
      if (!registration?.ok || !Number.isInteger(registration.tabId)) throw new Error(registration?.error || 'вкладка записи не определена');
      const begun = await mendoSend({
        t: 'mendosave-live-begin', jobId: session.jobId, tabId: registration.tabId,
        rawRecording: true, filename: session.filename, mime: session.mime,
      });
      if (!begun?.ok) throw new Error(begun?.error || 'не удалось начать сохранение записи');
      session.begun = true;
      session.port = await bindRecordingPort(session.jobId);
      recordingSession = session;
      recorder = active;
      stopReason = '';
      startPath = location.pathname;
      active.ondataavailable = (event) => preserveRecordingChunk(session, event.data);
      active.onstop = () => { void finalizeRecording(session); };
      active.onerror = () => {
        stopReason = 'ошибка записи потока';
        cleanupWatchdog();
      };
      session.port.onDisconnect.addListener(() => {
        // The host can close its Port after saving but before replying to
        // finalize. Pending chunk/finalize requests still report any failure.
        if (session.finished || session.finalizing) return;
        session.failed = 'связь с обработчиком записи прервалась';
        if (recordingSession === session) stopRecording('ошибка передачи записи');
      });
      active.start(1000);
      recordedVideo = media;
      media.addEventListener('ended', onPlayerEnded);
      // A raid or navigation replaces the stream: preserve only this channel.
      watchdog = setInterval(() => {
        if (location.pathname !== startPath) { stopRecording('канал сменился'); return; }
        if (recordedVideo && !document.contains(recordedVideo)) { stopRecording('плеер закрыт'); return; }
        updateBadge();
      }, 1000);
      setButtonState(true);
      toast(`MendoSave: запись начата (${recordingChannel})`);
    } catch (error) {
      recorder = null;
      recordingSession = null;
      if (session) session.finished = true;
      if (session?.begun) await mendoSend({ t: 'mendosave-live-abort', jobId: session.jobId }).catch(() => {});
      session?.port?.disconnect();
      toast(`MendoSave: ${error?.message || error}`);
    } finally { recordingStarting = false; }
  }

  function stopRecording(reason) {
    if (!recorder) return;
    stopReason = reason || '';
    cleanupWatchdog();
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); return; } catch (error) {}
    }
    if (recordingSession) void finalizeRecording(recordingSession);
  }

  async function finalizeRecording(session) {
    if (session.finalizing || session.finished) return;
    session.finalizing = true;
    recorder = null;
    cleanupWatchdog();
    setButtonState(false);
    toast('MendoSave: сохраняю запись…', true);
    try {
      await session.chain;
      if (session.failed) throw new Error(session.failed);
      const result = await mendoSend({
        t: 'mendosave-live-finalize', jobId: session.jobId, interrupted: Boolean(session.interrupted),
      });
      if (!result?.ok) throw new Error(result?.error || 'не удалось сохранить запись');
      toast(`MendoSave: сохранено ${result.filename || session.filename}${stopReason ? ` (${stopReason})` : ''}`);
    } catch (error) {
      // Disconnect lets the host preserve its acknowledged prefix as partial.
      toast(`MendoSave: ошибка записи (${error?.message || error}); принятые фрагменты остаются у обработчика`);
    } finally {
      session.finished = true;
      session.port?.disconnect();
      if (recordingSession === session) recordingSession = null;
    }
  }

  // ---- button --------------------------------------------------------------

  // Brand icon: green ring with the double down-arrows, same as the YouTube
  // button. While recording, the arrows give way to a pulsing red dot.
  function createIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('aria-hidden', 'true');
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('class', 'mendosave-ring');
    ring.setAttribute('cx', '18');
    ring.setAttribute('cy', '18');
    ring.setAttribute('r', '16');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', 'currentColor');
    ring.setAttribute('stroke-width', '2.4');
    const arrows = document.createElementNS(SVG_NS, 'path');
    arrows.setAttribute('class', 'mendosave-arrows');
    arrows.setAttribute('fill', 'currentColor');
    arrows.setAttribute('d', 'M16 6h4v14l5-5 3 3-10 10L8 18l3-3 5 5V6z M7 28h22v3H7z');
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', 'mendosave-rec-dot');
    dot.setAttribute('cx', '18');
    dot.setAttribute('cy', '18');
    dot.setAttribute('r', '7');
    dot.setAttribute('fill', 'currentColor');
    svg.append(ring, arrows, dot);
    return svg;
  }

  function setButtonState(recording) {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    button.classList.toggle('recording', recording);
    const live = pageKind().kind === 'live';
    button.title = recording
      ? 'Остановить запись и сохранить файл (MendoSave)'
      : (live ? 'Записать трансляцию (MendoSave)' : 'Скачать видео (MendoSave)');
    button.setAttribute('aria-label', button.title);
    const badge = button.querySelector('.mendosave-rec-time');
    if (badge && !recording) badge.textContent = '';
  }

  function updateBadge() {
    const badge = document.querySelector(`#${BUTTON_ID} .mendosave-rec-time`);
    if (badge && recorder) badge.textContent = formatElapsed(Date.now() - startedAt);
  }

  function createButton() {
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.className = 'mendosave-twitch-btn';
    button.type = 'button';
    button.append(createIcon());
    const badge = document.createElement('span');
    badge.className = 'mendosave-rec-time';
    button.append(badge);
    button.addEventListener('click', () => { void onButtonClick(button); });
    return button;
  }

  function ensureButton() {
    if (pageKind().kind === 'other') {
      document.getElementById(BUTTON_ID)?.remove();
      closeMenu();
      return;
    }
    if (document.getElementById(BUTTON_ID)) return;
    const group = findControlsGroup();
    if (!group || !findPlayerVideo()) return;
    group.prepend(createButton());
    setButtonState(Boolean(recorder));
  }

  function scheduleInject() {
    if (injectFrame) return;
    injectFrame = requestAnimationFrame(() => {
      injectFrame = undefined;
      ensureButton();
    });
  }

  new MutationObserver(scheduleInject).observe(document.documentElement, { childList: true, subtree: true });
  scheduleInject();
  // rAF never runs in a hidden tab, so a channel opened in a background tab
  // would get no button at all until it was looked at (N29). The timer is the
  // cheap insurance; ensureButton() returns immediately once the button exists.
  setInterval(() => { try { ensureButton(); } catch (error) {} }, 2_000);
  window.addEventListener('beforeunload', () => {
    // Ask for the final tail if events still run. Acknowledged chunks already
    // live in the extension host, which finalizes on Port disconnection.
    if (recordingSession) recordingSession.interrupted = true;
    if (recorder) stopRecording('страница закрывается');
  });

  // ---- player quality preference -------------------------------------------
  //
  // Twitch has no scriptable player API reachable from an isolated world, but
  // it does have two stable seams: `localStorage['video-quality']`, which the
  // player reads when it mounts, and its own settings menu, whose radios are
  // the only place the real rung names ("1080p60", "480p30") are published —
  // the fps suffix differs per stream, so those names cannot be guessed.
  //
  // Measured on a live channel: clicking a rung's label writes
  // {"default":"720p60"} and flips 'video-quality-highest-available' to false.
  const QUALITY_STORE_KEY = 'video-quality';
  const HIGHEST_STORE_KEY = 'video-quality-highest-available';
  const SETTINGS_BUTTON = '[data-a-target="player-settings-button"]';
  const QUALITY_ITEM = '[data-a-target="player-settings-menu-item-quality"]';
  const QUALITY_RADIO = 'input[name="player-settings-submenu-quality-option"]';
  const MENU_ROOT = '[data-a-target="player-settings-menu"]';

  let quality = {
    settings: null, target: null, lastWritten: null, busy: false, timer: null,
    attempts: 0, lockMisses: 0,
  };

  function qualityLog(text) {
    mendoSend({ t: 'mendosave-log', tag: 'twitch/quality', text }).catch(() => {});
  }

  function readStoredQuality() {
    try { return JSON.parse(localStorage.getItem(QUALITY_STORE_KEY) || 'null')?.default || null; }
    catch (error) { return null; }
  }

  // "1080p60(Источник)" → 1080, "Автоматически" → null.
  function heightFromLabel(label) {
    const match = /(\d{3,4})\s*p/i.exec(String(label || ''));
    return match ? Number(match[1]) : null;
  }

  function labelFor(radio) {
    return (document.querySelector(`label[for="${radio.id}"]`)?.textContent || '').trim();
  }

  // The menu is opened only to read or click; hiding it keeps that from
  // flashing over the stream. `opacity` and not `visibility`/`display`, because
  // the element still has to be laid out for React to treat the click as real.
  function hideMenuChrome(hidden) {
    let style = document.getElementById('mendosave-twitch-quiet-menu');
    if (!hidden) { style?.remove(); return; }
    if (style) return;
    style = document.createElement('style');
    style.id = 'mendosave-twitch-quiet-menu';
    style.textContent = `${MENU_ROOT} { opacity: 0 !important; }`;
    (document.head || document.documentElement).append(style);
  }

  async function withQualityMenu(action) {
    const button = document.querySelector(SETTINGS_BUTTON);
    if (!button) return null;
    hideMenuChrome(true);
    try {
      button.click();
      let item = null;
      for (let attempt = 0; attempt < 20 && !item; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        item = document.querySelector(QUALITY_ITEM);
      }
      if (!item) return null;
      item.click();
      let radios = [];
      for (let attempt = 0; attempt < 20 && !radios.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        radios = [...document.querySelectorAll(QUALITY_RADIO)];
      }
      if (!radios.length) return null;
      return await action(radios);
    } finally {
      // The same button toggles the menu, so closing it means clicking again —
      // but ONLY while it is actually open. A blind second click on a menu
      // Twitch had already closed would re-open it, and the style that hides it
      // is removed a moment later, leaving the popover stuck open over the
      // stream. Hence: close if open, look again, and only then reveal.
      const closeIfOpen = () => {
        if (!document.querySelector(MENU_ROOT)) return;
        try { document.querySelector(SETTINGS_BUTTON)?.click(); } catch (error) {}
      };
      closeIfOpen();
      setTimeout(() => {
        closeIfOpen();
        setTimeout(() => hideMenuChrome(false), 120);
      }, 250);
    }
  }

  // The rung the preference resolves to, given what this stream actually
  // offers. 'auto' follows the monitor the window is on, so an undocked laptop
  // asks for less without anyone changing a setting.
  function desiredHeight(available) {
    const settings = quality.settings;
    const wanted = settings?.twitchQuality ?? 'auto';
    return globalThis.MendoSaveSettings.resolveHeight(wanted, available);
  }

  // Returns 'skipped' when the page was not ready to be asked at all, so a slow
  // player does not burn the caller's retry budget.
  async function applyQualityPreference(reason) {
    if (quality.busy || recorder) return 'skipped';
    const settings = quality.settings;
    if (!settings) return 'skipped';
    if (pageKind().kind === 'other') return 'skipped';
    const media = findPlayerVideo();
    if (!media || !media.videoHeight) return 'skipped';

    // A rung the viewer picked by hand after we last wrote one is their
    // decision; adopt it as the new target instead of overruling it.
    const stored = readStoredQuality();
    if (stored && quality.lastWritten && stored !== quality.lastWritten) {
      quality.target = heightFromLabel(stored);
      quality.lastWritten = stored;
      qualityLog(`manual selection adopted: ${stored}`);
      return 'ok';
    }

    quality.busy = true;
    try {
      const chosen = await withQualityMenu(async (radios) => {
        const rungs = radios
          .map((radio) => ({ radio, label: labelFor(radio), height: heightFromLabel(labelFor(radio)) }))
          .filter((rung) => rung.height);
        if (!rungs.length) return null;
        const target = desiredHeight(rungs.map((rung) => rung.height));
        const pick = rungs.find((rung) => rung.height === target);
        if (!pick) return null;
        quality.target = pick.height;
        // Already on it, and not sitting on "Автоматически": nothing to click.
        if (pick.radio.checked) return { label: pick.label, clicked: false };
        document.querySelector(`label[for="${pick.radio.id}"]`)?.click();
        return { label: pick.label, clicked: true };
      });
      if (!chosen) return 'failed';
      quality.lastWritten = chosen.label.replace(/\s*\(.*\)\s*$/, '');
      // 'highest available' overrules the stored rung, so it is the flag that
      // decides whether "Максимальное" or a fixed rung wins.
      try {
        localStorage.setItem(HIGHEST_STORE_KEY, settings.twitchQuality === 'max' ? 'true' : 'false');
      } catch (error) {}
      qualityLog(`${reason}: ${chosen.clicked ? 'switched to' : 'already on'} ${chosen.label}`
        + ` (pref=${settings.twitchQuality}, lock=${settings.twitchLock})`);
      return 'ok';
    } catch (error) {
      qualityLog(`could not apply preference: ${String(error?.message || error)}`);
      return 'failed';
    } finally {
      quality.busy = false;
    }
  }

  // The lock: ABR drops the rendition long after any one-time choice, so the
  // only thing that holds it is checking what is actually being decoded.
  // `videoHeight` is the honest answer and needs no page-world access.
  function enforceQualityLock() {
    if (!quality.settings?.twitchLock || quality.busy || recorder) return;
    const media = findPlayerVideo();
    if (!media?.videoHeight || !quality.target) return;
    if (media.videoHeight >= quality.target) {
      quality.lockMisses = 0;
      return;
    }
    // There are states where the rendition simply cannot reach the target and
    // never will: an ad playing in the same element at a lower resolution, a
    // "1080p60" rung whose source is really 936p, a rung the line cannot carry.
    // Without a cap this would open and close the settings menu every five
    // seconds for as long as the tab is open.
    if ((quality.lockMisses = (quality.lockMisses || 0) + 1) > 3) {
      if (quality.lockMisses === 4) {
        qualityLog(`lock: ${media.videoHeight}p stayed below ${quality.target}p after 3 tries,`
          + ' standing down until the page or the setting changes');
      }
      return;
    }
    qualityLog(`lock: ${media.videoHeight}p is below ${quality.target}p, re-selecting`);
    void applyQualityPreference('lock');
  }

  let qualityPath = '';
  function watchQuality() {
    if (!quality.settings) return;
    // Twitch is an SPA: switching channels re-mounts the player without a page
    // load, and the new stream has its own ladder.
    if (location.pathname !== qualityPath) {
      qualityPath = location.pathname;
      quality.target = null;
      quality.lastWritten = null;
      quality.attempts = 0;
      quality.lockMisses = 0;
      setTimeout(() => { void applyQualityPreference('page'); }, 3_000);
      return;
    }
    // A page whose menu never yields a usable rung (a directory page, a player
    // that refused to mount) must not re-open that menu every five seconds
    // forever — three tries and this page is left alone.
    if (quality.target === null) {
      if (quality.attempts >= 3) return;
      void applyQualityPreference('retry').then((result) => {
        if (result === 'failed') quality.attempts += 1;
      });
      return;
    }
    enforceQualityLock();
  }

  (async () => {
    const api = globalThis.MendoSaveSettings;
    if (!api) return;
    quality.settings = await api.load();
    // 'Максимальное' is the one preference that needs no menu and no player:
    // set the flag before Twitch's own player reads it.
    if (quality.settings.twitchQuality === 'max') {
      try { localStorage.setItem(HIGHEST_STORE_KEY, 'true'); } catch (error) {}
    }
    api.subscribe((next) => {
      quality.settings = next;
      quality.target = null;
      quality.lastWritten = null;
      quality.attempts = 0;
      quality.lockMisses = 0;
      void applyQualityPreference('settings changed');
    });
    quality.timer = setInterval(() => { try { watchQuality(); } catch (error) {} }, 5_000);
    watchQuality();
  })();
})();

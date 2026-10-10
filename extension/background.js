// Service worker: owns the offscreen document, persistent diagnostics and
// browser downloads. ffmpeg.wasm itself runs in offscreen.html.
if (typeof importScripts === 'function') importScripts('browser-host.js', 'platform.js', 'diagnostics.js');

const LOG_KEY = 'nova_logs';
const LOG_LIMIT = 400;
const LOG_ENTRY_LIMIT = 4_000;
const ERROR_DETAIL_LIMIT = 50_000;
const ERROR_LOG_FILENAME = 'MendoSave-debug.txt';
const RELOAD_DOWNLOAD_PREFIX = 'nova_reload_download:';
const RELOAD_GUARD_PREFIX = 'nova_reload_guard:';
const RELOAD_GUARD_TTL_MS = 5 * 60_000;
const HANDLED_MESSAGES = new Set([
  'mendosave-fetch-cover',
  'mendosave-reload-tab',
  'mendosave-navigate-tab',
  'mendosave-log',
  'mendosave-error',
  'mendosave-ensure',
  'mendosave-save',
  'mendosave-download-state',
  'mendosave-download-cancel',
  'mendosave-fetch-caption',
  'mendosave-register-job',
  'mendosave-progress',
  'mendosave-package-progress',
  'mendosave-set-reload-download',
  'mendosave-get-reload-download',
  'mendosave-clear-reload-download',
  'mendosave-clear-reload-guard',
  'mendosave-ping',
  'mendosave-flush-recovered',
  'mendosave-recovery-read',
  'mendosave-recovery-write',
]);
const RECOVERY_KEY = 'nova_recovered';

let logWrite = Promise.resolve();
let reloadGuardWrite = Promise.resolve();

function truncate(value, limit) {
  const text = MendoDiagnostics.sanitize(value) || '';
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(date.getUTCDate())}-${pad(date.getUTCMonth() + 1)}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

// A report is read top to bottom by a human looking for one failing download.
// Repeats are folded into a counter and long idle stretches are marked, so the
// boundaries between separate attempts are visible instead of having to be
// reconstructed from timestamps.
const LOG_GAP_MARKER_MS = 2 * 60_000;

function formatLogLines(logs) {
  const lines = [];
  let previousTs = 0;
  for (const entry of logs) {
    const ts = Number(entry?.ts) || 0;
    if (previousTs && ts - previousTs >= LOG_GAP_MARKER_MS) {
      const minutes = Math.round((ts - previousTs) / 60_000);
      lines.push('', `--- пауза ${minutes} мин ---`, '');
    }
    const repeat = Number(entry?.repeat) || 1;
    const lastTs = Number(entry?.lastTs) || ts;
    const suffix = repeat > 1 ? ` (×${repeat}, последний ${formatTimestamp(lastTs)})` : '';
    lines.push(`[${formatTimestamp(ts)}] [${entry?.tag || 'log'}] ${entry?.text || ''}${suffix}`);
    previousTs = lastTs;
  }
  return lines;
}

function appendLog(entry) {
  entry = { ...entry, tag: MendoDiagnostics.text(entry.tag), text: MendoDiagnostics.text(entry.text) };
  // Serialize read-modify-write operations so concurrent content-script logs
  // cannot overwrite one another in chrome.storage.local.
  logWrite = logWrite
    .catch(() => {})
    .then(async () => {
      const stored = await chrome.storage.local.get(LOG_KEY);
      const logs = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
      // A retried operation writes the same line over and over (primers,
      // refill attempts, bridge timeouts). Counting them keeps the fact and
      // its cadence while spending one slot of the ring instead of dozens.
      const last = logs[logs.length - 1];
      if (last && last.tag === entry.tag && last.text === entry.text) {
        last.repeat = (Number(last.repeat) || 1) + 1;
        last.lastTs = entry.ts;
      } else {
        logs.push(entry);
      }
      await chrome.storage.local.set({ [LOG_KEY]: logs.slice(-LOG_LIMIT) });
    });
  return logWrite;
}

async function ensureOffscreen() {
  await MendoProcessorHost.ensure();
}

// Finished files the offscreen document could not hand over (see the recovery
// store there). Flushing needs that document, so it is created on demand.
async function flushRecoveredFiles(manual = false) {
  const stored = await chrome.storage.local.get(RECOVERY_KEY).catch(() => ({}));
  const entries = Array.isArray(stored[RECOVERY_KEY]) ? stored[RECOVERY_KEY] : [];
  if (!entries.some((entry) => entry && !entry.savedAt)) return { ok: true, saved: 0, pending: 0 };
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({ t: 'mendosave-flush', manual })
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  return result || { ok: false, error: 'обработчик медиа не ответил' };
}

// Windows refuses these as a base name whatever the extension is.
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Chrome does not fail a download whose filename it cannot use — it quietly
// generates one from the URL instead, and for a blob: URL that is the blob's
// UUID plus an extension guessed from the MIME type. That is where finished
// files were landing as `50b453d3-4e0a-4112-a2d2-ec6fe31a2ee5.m4a`.
//
// The two ways a name got there:
//   * a title cut with String.slice landed inside a surrogate pair, leaving a
//     lone surrogate — the string is then not valid UTF-8 and Chrome discards
//     the whole name;
//   * a title made entirely of characters the callers strip («?», «|») left an
//     empty base, so the name was just ".m4a".
// Both are repaired here rather than in each adapter, so no site can reach
// chrome.downloads with a name the browser will silently replace.
function repairFilename(value) {
  const raw = String(value || '');
  const match = /^(.*?)(\.[A-Za-z0-9]{1,5})?$/s.exec(raw) || [];
  let base = match[1] || '';
  const extension = match[2] || '';
  base = base
    // Lone surrogates first: everything after this can assume valid text.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    // Chromium's IsFilenameLegal (base/i18n/file_util_icu.cc) refuses every
    // format (Cf) and control (Cc) character and every non-character anywhere
    // in the name, and chrome.downloads then refuses the download itself
    // ("Invalid filename"). Cf is invisible and common in titles: the ZWJ that
    // glues emoji sequences (U+1F636 U+200D U+1F32B U+FE0F, a field report),
    // bidi marks around RTL words, soft hyphens, flag tag characters. Dropped
    // rather than replaced, so a sequence falls apart into its visible emoji
    // instead of taking the file with it.
    .replace(/[\p{Cf}\p{Noncharacter_Code_Point}]+/gu, '')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Chromium also refuses whitespace, "." and "~" as the first or last
    // character; a leading dot would also make the name read as an extension,
    // and Windows rejects a trailing dot or space outright.
    .replace(/^[.~\s]+/, '')
    .replace(/[.~\s]+$/, '');
  // By code points, so the truncation itself cannot recreate the lone surrogate
  // this function exists to remove.
  const points = [...base];
  // Trailing dots and spaces are stripped again after the cut, not only before
  // it: truncating «…AAA. more text» at 120 leaves «…AAA.», which Windows
  // rejects just as it rejects the original.
  if (points.length > 120) base = points.slice(0, 120).join('').replace(/[.~\s]+$/, '').trim();
  // On Windows a name of up to 12 characters with a tilde can pass for an 8.3
  // short name (`ABCDEF~1.MP3`), which Chromium refuses as well.
  if (base.includes('~') && [...`${base}${extension}`].length <= 12) base = base.replace(/~/g, '-');
  if (RESERVED_DEVICE_NAMES.test(base)) base = `_${base}`;
  if (!base) base = 'mendosave-download';
  return `${base}${extension}`;
}

async function saveDownload(url, filename) {
  if (typeof url !== 'string' || !url) throw new Error('download URL is missing');
  if (typeof filename !== 'string' || !filename) throw new Error('download filename is missing');
  const repaired = repairFilename(filename);
  if (repaired !== filename) {
    // Logged, not silent: the repair hides the symptom, and without this line
    // the next bad title would be just as invisible as the first one was.
    void appendLog({
      ts: Date.now(),
      tag: 'download',
      text: `filename repaired: ${JSON.stringify(filename)} -> ${JSON.stringify(repaired)}`,
    }).catch(() => {});
  }
  if (url.startsWith('data:')) {
    const match = /^data:(text\/plain|text\/vtt|application\/x-subrip);charset=utf-8,(.*)$/s.exec(url);
    if (!match || url.length > 6 * 1024 * 1024) throw new Error('Unsupported or oversized text download');
    const text = decodeURIComponent(match[2]);
    await ensureOffscreen();
    const response = await chrome.runtime.sendMessage({ t: 'mendosave-save-text', text, type: match[1], filename: repaired });
    if (!response?.ok) {
      const error = new Error(response?.error || 'Не удалось сохранить текстовый файл');
      error.cancelled = Boolean(response?.cancelled); throw error;
    }
    return response.id;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !url.startsWith(`blob:${chrome.runtime.getURL('')}`)) {
    throw new Error('Download URL is not allowed');
  }
  const stored = await chrome.storage.local.get('nova_settings');
  try {
    return await chrome.downloads.download({ url, filename: repaired,
      saveAs: stored?.nova_settings?.saveAs === true, conflictAction: 'uniquify' });
  } catch (error) {
    // The native picker rejects before there is a download ID in Gecko.
    // Only known browser cancellation errors are user actions; a generic
    // network or filesystem failure must remain an error.
    const detail = String(error?.message || error);
    if (detail === 'Download canceled by the user' || detail === 'USER_CANCELED') {
      const cancelled = new Error(detail, { cause: error });
      cancelled.cancelled = true;
      throw cancelled;
    }
    throw error;
  }
}

function validateCaptionUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/api/timedtext') {
    throw new Error('caption URL is not allowed');
  }
  return url.href;
}

async function downloadErrorLog(message, sender) {
  await logWrite.catch(() => {});
  const stored = await chrome.storage.local
    .get([LOG_KEY, 'nvs_playlist_queue', RECOVERY_KEY])
    .catch(() => ({}));
  const logs = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  // Extension state snapshot: without it "silent" misbehaviour (stalled
  // queues, stale pending downloads) is invisible in reports.
  const sessionState = await chrome.storage.session.get(null).catch(() => ({}));
  const state = {
    playlistQueue: stored.nvs_playlist_queue || null,
    recovered: stored[RECOVERY_KEY] || null,
    session: sessionState,
  };
  const report = [
    'MendoSave error report',
    `Time: ${formatTimestamp(Date.now())}`,
    `Version: ${chrome.runtime.getManifest().version}`,
    `Context: ${message.context || 'unknown'}`,
    `Page: ${sender?.tab?.url || 'extension'}`,
    `Browser: ${navigator.userAgent}`,
    '',
    truncate(message.error || 'Unknown error', ERROR_DETAIL_LIMIT),
    message.details ? `\nDetails:\n${truncate(message.details, ERROR_DETAIL_LIMIT)}` : '',
    `\nState:\n${truncate(state, ERROR_DETAIL_LIMIT)}`,
    logs.length ? `\nRecent logs:\n${formatLogLines(logs).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const url = `data:text/plain;charset=utf-8,${encodeURIComponent(`\uFEFF${MendoDiagnostics.text(report)}\n`)}`;
  const id = await saveDownload(url, ERROR_LOG_FILENAME);
  return { ok: true, id, filename: ERROR_LOG_FILENAME };
}

// A report is read to understand ONE failing download, and entries from earlier
// sessions only bury it: exported logs had grown to hundreds of lines covering
// days, where the run in question was the last twenty. Reloading the extension
// or restarting the browser starts a fresh journal.
//
// Deliberately NOT tied to the service worker starting up: MV3 terminates it
// whenever it is idle, so that would wipe the log between the capture and the
// error report about it — exactly the lines needed.
async function startNewLogSession(reason) {
  await logWrite.catch(() => {});
  logWrite = logWrite.catch(() => {}).then(() => chrome.storage.local
    .set({ [LOG_KEY]: [{ ts: Date.now(), tag: 'session', text: `journal cleared on ${reason}` }] })
    .catch(() => {}));
  return logWrite;
}

chrome.runtime.onInstalled.addListener(() => {
  startNewLogSession('extension reload/update');
  flushRecoveredFiles().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  startNewLogSession('browser start');
  flushRecoveredFiles().catch(() => {});
});

async function handleMessage(message, sender) {
  if (sender?.id !== chrome.runtime.id) throw new Error('Unknown extension sender');
  const downloadOwner = () => {
    if (sender.url === chrome.runtime.getURL('offscreen.html')) return 'processor';
    if (Number.isInteger(sender.tab?.id)) return `tab:${sender.tab.id}`;
    throw new Error('Download sender has no tab');
  };
  const reloadDownloadKey = () => {
    if (!Number.isInteger(sender?.tab?.id)) throw new Error('download tab is unavailable');
    return `${RELOAD_DOWNLOAD_PREFIX}${sender.tab.id}`;
  };
  const reloadGuardKey = () => {
    if (!Number.isInteger(sender?.tab?.id)) throw new Error('download tab is unavailable');
    return `${RELOAD_GUARD_PREFIX}${sender.tab.id}`;
  };
  switch (message.t) {
    // Cover art for audio downloads. Fetched here because content pages are
    // bound by page CORS and the offscreen document by its COEP; the service
    // worker with the i.ytimg.com host permission has neither restriction.
    case 'mendosave-fetch-cover': {
      const videoId = String(message.videoId || '');
      if (!/^[A-Za-z0-9_-]{6,}$/.test(videoId)) throw new Error('некорректный идентификатор видео');
      for (const name of ['maxresdefault', 'hqdefault']) {
        try {
          const response = await fetch(`https://i.ytimg.com/vi/${videoId}/${name}.jpg`, { cache: 'no-store' });
          if (!response.ok) continue;
          const buffer = new Uint8Array(await response.arrayBuffer());
          // A real JPEG only: ffmpeg embeds it as the ID3/covr picture as-is.
          if (buffer.length < 2_000 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) continue;
          let binary = '';
          const step = 0x8000;
          for (let offset = 0; offset < buffer.length; offset += step) {
            binary += String.fromCharCode(...buffer.subarray(offset, Math.min(offset + step, buffer.length)));
          }
          return { ok: true, b64: btoa(binary), source: name };
        } catch (error) { /* try the next thumbnail size */ }
      }
      return { ok: false, error: 'обложка недоступна' };
    }

    // YouTube's SPA router can intercept page-initiated location.reload()/
    // assign() and keep a wedged media session alive. Browser-level tab
    // reloads/navigations (what a manual F5 does) cannot be intercepted.
    case 'mendosave-reload-tab': {
      if (!Number.isInteger(sender?.tab?.id)) throw new Error('вкладка не определена');
      await chrome.tabs.reload(sender.tab.id);
      return { ok: true };
    }

    case 'mendosave-navigate-tab': {
      if (!Number.isInteger(sender?.tab?.id)) throw new Error('вкладка не определена');
      const url = new URL(String(message.url || ''));
      const allowedOrigins = ['https://www.youtube.com', 'https://music.youtube.com'];
      if (!allowedOrigins.includes(url.origin) || url.pathname !== '/watch') {
        throw new Error('навигация разрешена только на страницы просмотра YouTube');
      }
      await chrome.tabs.update(sender.tab.id, { url: url.href });
      return { ok: true };
    }

    case 'mendosave-log':
      await appendLog({
        ts: Date.now(),
        tag: message.tag,
        text: truncate(message.text, LOG_ENTRY_LIMIT),
        tab: sender?.tab?.id,
        frame: sender?.frameId,
      });
      return { ok: true };

    case 'mendosave-error':
      return downloadErrorLog(message, sender);

    case 'mendosave-ensure':
      await ensureOffscreen();
      return { ok: true };

    // Heartbeat from the offscreen document. Receiving it resets this
    // worker's idle timer, so a long mux can no longer outlive the worker
    // that has to accept its result.
    case 'mendosave-ping':
      return { ok: true };

    case 'mendosave-flush-recovered':
      return flushRecoveredFiles(true);

    case 'mendosave-recovery-read':
    case 'mendosave-recovery-write': {
      if (sender?.id !== chrome.runtime.id || sender?.url !== chrome.runtime.getURL('offscreen.html')) {
        throw new Error('Recovery storage is only available to the media processor');
      }
      if (message.t === 'mendosave-recovery-read') {
        const stored = await chrome.storage.local.get(RECOVERY_KEY);
        return { ok: true, entries: Array.isArray(stored[RECOVERY_KEY]) ? stored[RECOVERY_KEY] : [] };
      }
      if (!Array.isArray(message.entries) || message.entries.length > 100
        || message.entries.some((entry) => !entry || !/^[A-Za-z0-9_-]+\.bin$/.test(entry.id)
          || typeof entry.filename !== 'string' || entry.filename.length > 250
          || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) {
        throw new Error('Invalid recovery index');
      }
      await chrome.storage.local.set({ [RECOVERY_KEY]: message.entries });
      return { ok: true };
    }

    case 'mendosave-save': {
      const owner = downloadOwner();
      if (message.packageId) {
        if (!Number.isInteger(sender.tab?.id) || sender.frameId !== 0) throw new Error('Пакет доступен только верхнему документу вкладки');
        if (typeof message.url !== 'string' || typeof message.filename !== 'string' || !message.filename.length
          || message.filename.length > 250) throw new Error('Некорректный результат пакета');
        await ensureOffscreen();
        const response = await chrome.runtime.sendMessage({ t: 'mendosave-save-source', packageId: message.packageId,
          packageIndex: message.packageIndex, url: message.url, filename: repairFilename(message.filename),
          sourceOwner: { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId } });
        if (response?.ok && Number.isInteger(response.id)) await chrome.storage.session.set({ [`mendo_download_owner:${response.id}`]: owner });
        return response;
      }
      const id = await saveDownload(message.url, message.filename);
      await chrome.storage.session.set({ [`mendo_download_owner:${id}`]: owner });
      return { ok: true, id };
    }

    // A direct save is pulled by the browser itself, so the page has no byte
    // count of its own: without this the on-page panel could only say "handed
    // over" while Chrome's own bubble showed the real progress.
    case 'mendosave-download-state':
    case 'mendosave-download-cancel': {
      const id = message.id;
      if (!Number.isInteger(id) || id < 0) return { ok: false, error: 'download id is missing' };
      const key = `mendo_download_owner:${id}`;
      const saved = await chrome.storage.session.get(key);
      if (saved[key] !== downloadOwner()) throw new Error('Download belongs to a different sender');
      if (message.t === 'mendosave-download-cancel') {
        await chrome.downloads.cancel(id);
        return { ok: true };
      }
      const [item] = await chrome.downloads.search({ id });
      if (!item) return { ok: false, error: 'download not found' };
      return {
        ok: true,
        state: item.state,
        paused: Boolean(item.paused),
        bytesReceived: item.bytesReceived || 0,
        totalBytes: item.totalBytes || item.fileSize || 0,
        error: item.error || '',
      };
    }

    case 'mendosave-fetch-caption': {
      const response = await fetch(validateCaptionUrl(message.url), {
        credentials: 'include',
        referrer: 'https://www.youtube.com/',
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, len: text.length, text };
    }

    case 'mendosave-register-job':
      if (!Number.isInteger(sender?.tab?.id)) throw new Error('download tab is unavailable');
      return { ok: true, tabId: sender.tab.id };

    case 'mendosave-set-reload-download': {
      const pending = message.pending;
      if (!pending || (pending.format !== 'mp4' && pending.format !== 'mp3')
        || !/^[A-Za-z0-9_-]{6,}$/.test(String(pending.videoId || ''))
        || (pending.format === 'mp4' && !Number.isFinite(Number(pending.height)))
        || !Number.isFinite(Number(pending.createdAt))
        || typeof pending.token !== 'string'
        || typeof pending.playerState?.paused !== 'boolean'
        || !Number.isFinite(Number(pending.playerState?.time))
        || typeof pending.playerState?.muted !== 'boolean') {
        throw new Error('invalid reload download request');
      }
      const pendingKey = reloadDownloadKey();
      const guardKey = reloadGuardKey();
      reloadGuardWrite = reloadGuardWrite
        .catch(() => {})
        .then(async () => {
          const now = Date.now();
          const stored = await chrome.storage.session.get(guardKey);
          const guard = stored[guardKey];
          const sameActiveJob = guard
            && guard.videoId === String(pending.videoId)
            && guard.format === pending.format
            && now - Number(guard.updatedAt) <= RELOAD_GUARD_TTL_MS;
          const reloadCount = sameActiveJob ? Number(guard.reloadCount) + 1 : 1;
          if (reloadCount > 2) {
            return {
              ok: false,
              reloadBlocked: true,
              error: 'повторная загрузка краёв уже выполнялась дважды; циклическое обновление остановлено',
            };
          }
          const audioFormat = ['original', 'mp3', 'm4a', 'aac', 'flac', 'wav']
            .includes(pending.audioFormat) ? pending.audioFormat : null;
          await chrome.storage.session.set({
            [guardKey]: {
              videoId: String(pending.videoId),
              format: pending.format,
              reloadCount,
              updatedAt: now,
            },
            [pendingKey]: {
              videoId: String(pending.videoId),
              title: String(pending.title || '').slice(0, 300),
              duration: Math.max(0, Number(pending.duration) || 0),
              format: pending.format,
              audioFormat,
              height: pending.format === 'mp3' ? null : Number(pending.height),
              createdAt: Number(pending.createdAt),
              token: pending.token.slice(0, 100),
              reloadAttempted: true,
              reloadCount,
              playerState: {
                paused: pending.playerState.paused,
                time: Math.max(0, Number(pending.playerState.time)),
                muted: pending.playerState.muted,
              },
            },
          });
          return { ok: true, reloadCount };
        });
      return reloadGuardWrite;
    }

    case 'mendosave-get-reload-download': {
      const key = reloadDownloadKey();
      const stored = await chrome.storage.session.get(key);
      return { ok: true, pending: stored[key] || null };
    }

    case 'mendosave-clear-reload-download':
      await chrome.storage.session.remove(reloadDownloadKey());
      return { ok: true };

    case 'mendosave-clear-reload-guard':
      await chrome.storage.session.remove([reloadDownloadKey(), reloadGuardKey()]);
      return { ok: true };

    case 'mendosave-progress':
    case 'mendosave-package-progress': {
      if (sender?.url !== chrome.runtime.getURL('offscreen.html')) {
        throw new Error('progress messages are only accepted from the media processor');
      }
      if (!Number.isInteger(message.tabId)) throw new Error('progress tab is unavailable');
      await chrome.tabs.sendMessage(message.tabId, {
        t: message.t,
        ...(message.packageId ? { packageId: message.packageId } : {}),
        jobId: message.jobId,
        value: message.value,
        percent: message.percent,
        ...(message.status ? { status: message.status } : {}),
      });
      return { ok: true };
    }

    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !HANDLED_MESSAGES.has(message.t)) return false;

  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error),
      ...(error?.cancelled === true ? { cancelled: true } : {}) }));
  return true;
});

// Local development popup. No upstream updater.
document.getElementById('current-version').textContent = `v${chrome.runtime.getManifest().version}`;

// Player quality preferences. Applied by content_ui.js/content_hook.js on
// YouTube and by twitch_ui.js on Twitch; this popup only edits the record.
const settingsHint = document.getElementById('settings-hint');

function fillQualitySelect(select, heights) {
  // `screen` here is the display the popup — and therefore the browser window
  // — is on, so the number quoted next to "Как у монитора" is what that same
  // window will resolve 'auto' to.
  const monitor = globalThis.NovaSettings.monitorHeight();
  const options = [
    ['auto', `Как у монитора (${monitor}p)`],
    ['max', 'Максимальное'],
    ...heights.map((height) => [String(height), `${height}p`]),
  ];
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
}

async function setupSettings() {
  const { YOUTUBE_HEIGHTS, TWITCH_HEIGHTS, save, load } = globalThis.NovaSettings;
  const youtubeQuality = document.getElementById('yt-quality');
  const youtubeLock = document.getElementById('yt-lock');
  const twitchQuality = document.getElementById('tw-quality');
  const twitchLock = document.getElementById('tw-lock');

  fillQualitySelect(youtubeQuality, YOUTUBE_HEIGHTS);
  fillQualitySelect(twitchQuality, TWITCH_HEIGHTS);

  const current = await load();
  youtubeQuality.value = String(current.youtubeQuality);
  youtubeLock.checked = current.youtubeLock;
  twitchQuality.value = String(current.twitchQuality);
  twitchLock.checked = current.twitchLock;

  const note = (text) => { settingsHint.textContent = text; };
  const persist = async (patch, message) => {
    try {
      await save(patch);
      note(message);
    } catch (error) {
      note(`Не удалось сохранить настройку: ${String(error?.message || error)}`);
    }
  };

  youtubeQuality.addEventListener('change', () => persist(
    { youtubeQuality: youtubeQuality.value },
    'Сохранено. На открытых вкладках YouTube — обновите страницу (F5).',
  ));
  twitchQuality.addEventListener('change', () => persist(
    { twitchQuality: twitchQuality.value },
    'Сохранено. Twitch применяет качество при следующей загрузке плеера.',
  ));
  youtubeLock.addEventListener('change', () => persist(
    { youtubeLock: youtubeLock.checked },
    youtubeLock.checked
      ? 'Качество YouTube закреплено: плеер не будет понижать его сам.'
      : 'YouTube снова может понижать качество при слабой сети.',
  ));
  twitchLock.addEventListener('change', () => persist(
    { twitchLock: twitchLock.checked },
    twitchLock.checked
      ? 'Качество Twitch закреплено: авто-режим плеера выключен.'
      : 'Twitch снова может выбирать качество сам.',
  ));
}

setupSettings().catch((error) => {
  settingsHint.textContent = `Настройки недоступны: ${String(error?.message || error)}`;
});

// Files that finished processing but that the browser did not accept for
// saving (a service-worker restart at the wrong moment). They wait in the
// extension's private storage until saved from here.
const recoveredBox = document.getElementById('recovered');
const saveRecoveredButton = document.getElementById('save-recovered');

function formatSize(bytes) {
  const megabytes = Number(bytes) / (1024 * 1024);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return '';
  return megabytes >= 1024 ? ` (${(megabytes / 1024).toFixed(1)} ГБ)` : ` (${Math.round(megabytes)} МБ)`;
}

async function refreshRecovered() {
  const stored = await chrome.storage.local.get('nova_recovered').catch(() => ({}));
  const pending = (Array.isArray(stored.nova_recovered) ? stored.nova_recovered : [])
    .filter((entry) => entry && !entry.savedAt);
  recoveredBox.hidden = pending.length === 0;
  saveRecoveredButton.hidden = pending.length === 0;
  if (!pending.length) return pending.length;
  // These controls only ever appear after a download finished processing but
  // the browser refused to accept the file, so say exactly that — an unexplained
  // button here reads like a mystery feature.
  recoveredBox.textContent = pending.length === 1
    ? `Загрузка завершилась, но браузер не принял файл «${pending[0].filename}»`
      + `${formatSize(pending[0].bytes)}. Он сохранён во временном хранилище — нажмите кнопку ниже.`
    : `Готовых файлов, которые браузер не принял: ${pending.length}.`
      + ' Они сохранены во временном хранилище — нажмите кнопку ниже.';
  return pending.length;
}

saveRecoveredButton.addEventListener('click', async () => {
  saveRecoveredButton.disabled = true;
  saveRecoveredButton.textContent = 'Сохраняю…';
  const result = await chrome.runtime.sendMessage({ t: 'nova-flush-recovered' })
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  saveRecoveredButton.disabled = false;
  saveRecoveredButton.textContent = 'Сохранить готовый файл';
  const stillPending = await refreshRecovered();
  if (!stillPending) {
    recoveredBox.hidden = false;
    recoveredBox.textContent = 'Готово: файл отправлен в загрузки браузера.';
  } else {
    recoveredBox.textContent = `Не удалось сохранить: ${result?.error || 'ошибка'}.`
      + ' Попробуйте ещё раз или перезапустите браузер.';
  }
});

refreshRecovered();

// Manual journal export: the debug file is otherwise only produced by errors,
// which hides silent misbehaviour (wasted retries, reload loops) from reports.
const exportButton = document.getElementById('export-log');
exportButton.addEventListener('click', async () => {
  exportButton.disabled = true;
  exportButton.textContent = 'Сохраняю журнал…';
  const result = await chrome.runtime.sendMessage({
    t: 'nova-error',
    context: 'manual-export',
    error: 'Журнал сохранён по запросу пользователя (это не ошибка).',
  }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
  exportButton.disabled = false;
  exportButton.textContent = result?.ok
    ? 'Журнал сохранён в загрузки (NVS-debug.txt)'
    : `Не удалось сохранить журнал: ${result?.error || 'ошибка'}`;
});

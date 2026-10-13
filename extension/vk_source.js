/* global module */
// The page may provide metadata, never authority to run privileged operations.
// Both worlds validate the same small projection before a user chooses a file.
(() => {
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PROJECTION_BYTES = 128 * 1024;
  const MAX_FILES = 32;
  const MAX_URL_LENGTH = 8192;
  const FILE_KEYS = new Set(['mp4_144', 'mp4_240', 'mp4_360', 'mp4_480', 'mp4_720',
    'mp4_1080', 'mp4_1440', 'mp4_2160', 'dash_sep']);
  const ERROR_TEXT = Object.freeze({
    SOURCE_MISMATCH: 'ответ плеера относится к другому видео',
    INVALID_RESPONSE: 'ответ плеера содержит неподдержанные данные',
    RESPONSE_TOO_LARGE: 'ответ плеера превышает допустимый размер',
    NO_FILES: 'у этого видео нет доступных файлов',
    API_ERROR: 'VK не разрешил получить это видео',
    PLAYER_UNAVAILABLE: 'не удалось получить данные штатного плеера; повторите попытку',
    TIMEOUT: 'плеер не ответил вовремя; повторите попытку',
  });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function error(code, serviceCode) {
    const selected = Object.hasOwn(ERROR_TEXT, code) ? code : 'INVALID_RESPONSE';
    const result = new Error(ERROR_TEXT[selected] + (selected === 'API_ERROR'
      && Number.isSafeInteger(serviceCode) ? ` (код ${serviceCode})` : ''));
    result.code = selected;
    return result;
  }
  function ids(oid, id) {
    const owner = String(oid), video = String(id);
    if (!/^-?[1-9]\d{0,14}$/.test(owner) || !/^[1-9]\d{0,14}$/.test(video)
      || !Number.isSafeInteger(Number(owner)) || !Number.isSafeInteger(Number(video))) return null;
    return { oid: owner, id: video };
  }
  function source(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.port || url.username || url.password
        || !(url.hostname === 'vk.com' || url.hostname === 'vkvideo.ru'
          || url.hostname.endsWith('.vkvideo.ru'))) return null;
      const match = /^\/(?:video|clip)(-?\d+)_(\d+)(?:\/|$)/.exec(url.pathname);
      const selected = match ? ids(match[1], match[2]) : (url.pathname === '/video_ext.php'
        ? ids(url.searchParams.get('oid'), url.searchParams.get('id')) : null);
      return selected ? { ...selected, href: `${url.origin}${url.pathname}` } : null;
    } catch (failure) { return null; }
  }
  const same = (left, right) => left && right && left.oid === right.oid && left.id === right.id;
  function mediaUrl(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH) return false;
    try {
      const url = new URL(value);
      // These are the progressive/DASH routes observed in both native legacy
      // responses and the authenticated video.getEmbed response. Expanding
      // routes requires source evidence, rather than a wildcard CDN guess.
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
        && /^vkvd\d+\.okcdn\.ru$/.test(url.hostname) && url.pathname === '/';
    } catch (failure) { return false; }
  }
  function video(value, expected) {
    if (!object(value) || !expected) throw error('INVALID_RESPONSE');
    const identity = ids(value.owner_id ?? value.oid, value.id);
    if (!same(identity, expected)) throw error('SOURCE_MISMATCH');
    if (!object(value.files)) throw error('NO_FILES');
    const entries = Object.entries(value.files);
    if (entries.length > MAX_FILES) throw error('RESPONSE_TOO_LARGE');
    const files = {};
    for (const [key, url] of entries) {
      if (!FILE_KEYS.has(key)) continue;
      if (!mediaUrl(url)) throw error('INVALID_RESPONSE');
      files[key] = url;
    }
    if (!Object.keys(files).length) throw error('NO_FILES');
    const title = value.title ?? value.md_title ?? `video${identity.oid}_${identity.id}`;
    if (typeof title !== 'string' || title.length > 1024) throw error('INVALID_RESPONSE');
    const duration = value.duration ?? 0;
    if (!Number.isFinite(duration) || duration < 0 || duration > 31 * 24 * 60 * 60) throw error('INVALID_RESPONSE');
    return { ...identity, title, duration, files };
  }
  function embed(value, expected) {
    if (!object(value) || !object(value.response)) throw error('INVALID_RESPONSE');
    const response = value.response;
    if (!Number.isSafeInteger(response.error_code)) throw error('INVALID_RESPONSE');
    if (response.error_code !== 0) throw error('API_ERROR', response.error_code);
    return video(response.video, expected);
  }
  globalThis.MendoVKSource = Object.freeze({ MAX_RESPONSE_BYTES, MAX_PROJECTION_BYTES,
    error, ids, source, same, mediaUrl, video, embed });
  if (typeof module !== 'undefined') module.exports = globalThis.MendoVKSource;
})();

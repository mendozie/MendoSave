/* global module */
(() => {
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PROJECTION_BYTES = 512 * 1024;
  const MAX_URL_LENGTH = 8192;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const ERROR_TEXT = Object.freeze({
    AUTH_REQUIRED: 'Instagram требует входа в аккаунт',
    RATE_LIMITED: 'Instagram ограничил частоту запросов; повторите попытку позже',
    UNAVAILABLE: 'публикация недоступна в текущей сессии',
    INVALID_RESPONSE: 'Instagram вернул неподдержанные данные публикации',
    SOURCE_MISMATCH: 'ответ Instagram относится к другой публикации',
    RESPONSE_TOO_LARGE: 'данные Instagram превышают допустимый размер',
  });
  function error(code) {
    const selected = Object.hasOwn(ERROR_TEXT, code) ? code : 'INVALID_RESPONSE';
    const result = new Error(ERROR_TEXT[selected]);
    result.code = selected;
    return result;
  }
  function text(value, max) {
    if (typeof value !== 'string') throw error('INVALID_RESPONSE');
    if (value.length > max) throw error('RESPONSE_TOO_LARGE');
    return value;
  }
  function bounded(value, max) {
    const stack = [{ value, depth: 0 }], seen = new Set(), encoder = new TextEncoder();
    let size = 0, nodes = 0;
    while (stack.length) {
      const current = stack.pop(), entry = current.value;
      if (++nodes > 20000 || current.depth > 32) throw error('RESPONSE_TOO_LARGE');
      if (entry === null || ['string', 'number', 'boolean'].includes(typeof entry)) {
        if (typeof entry === 'string' && entry.length > max) throw error('RESPONSE_TOO_LARGE');
        if (typeof entry === 'number' && !Number.isFinite(entry)) throw error('INVALID_RESPONSE');
        size += encoder.encode(JSON.stringify(entry)).length;
      } else if (typeof entry === 'object') {
        if (seen.has(entry)) throw error('INVALID_RESPONSE');
        seen.add(entry);
        if (Array.isArray(entry)) {
          if (entry.length > 20000) throw error('RESPONSE_TOO_LARGE');
          for (let index = 0; index < entry.length; index++) {
            if (!Object.hasOwn(entry, index)) throw error('INVALID_RESPONSE');
          }
        }
        const entries = Object.entries(entry);
        if (entries.length > 20000) throw error('RESPONSE_TOO_LARGE');
        size += 2 + entries.length;
        for (const [key, child] of entries) {
          if (!Array.isArray(entry)) size += encoder.encode(JSON.stringify(key)).length + 1;
          stack.push({ value: child, depth: current.depth + 1 });
        }
      } else throw error('INVALID_RESPONSE');
      if (size > max) throw error('RESPONSE_TOO_LARGE');
    }
  }
  function numericId(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw error('INVALID_RESPONSE');
    const id = String(value);
    if (!/^[1-9]\d{0,29}$/.test(id)) throw error('INVALID_RESPONSE');
    return id;
  }
  function shortcodeId(shortcode) {
    if (typeof shortcode !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(shortcode)) throw error('INVALID_RESPONSE');
    let result = 0n;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (const char of shortcode) result = result * 64n + BigInt(alphabet.indexOf(char));
    return result.toString();
  }
  function identity(value, expected) {
    if (!object(value) || !object(expected)) throw error('INVALID_RESPONSE');
    const expectedId = shortcodeId(expected.shortcode);
    const id = numericId(value.pk ?? value.id ?? expectedId);
    if ((value.code !== undefined && value.code !== expected.shortcode)
      || (value.shortcode !== undefined && value.shortcode !== expected.shortcode)
      || id !== expectedId) throw error('SOURCE_MISMATCH');
    if (value.pk === undefined && value.id === undefined && value.code === undefined
      && value.shortcode === undefined) throw error('INVALID_RESPONSE');
    return id;
  }
  function versions(value, raw = false) {
    if (!Array.isArray(value)) throw error('INVALID_RESPONSE');
    if (value.length > 32) throw error('RESPONSE_TOO_LARGE');
    return value.map(item => {
      if (!object(item) || !mediaUrl(item.url)) throw error('INVALID_RESPONSE');
      if (raw ? item.width == null && item.height == null : item.width === 0 && item.height === 0) {
        return { url: item.url, width: 0, height: 0 };
      }
      if (!Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height)
        || item.width < 1 || item.height < 1 || item.width > 32768 || item.height > 32768) {
        throw error('INVALID_RESPONSE');
      }
      return { url: item.url, width: item.width, height: item.height };
    });
  }
  function mediaUrl(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH
      || !/^https:\/\/[^/:?#\s\\]+(?:[/?]|$)/.test(value) || /[\s\\]/.test(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
        && /^(?:[a-z0-9-]+\.)+(?:cdninstagram\.com|fbcdn\.net)$/.test(url.hostname);
    } catch (failure) { return false; }
  }
  function source(value) {
    if (typeof value !== 'string' || value.length > MAX_URL_LENGTH
      || !/^https:\/\/www\.instagram\.com\//.test(value) || /[\s\\]/.test(value)) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'www.instagram.com'
        || url.port || url.username || url.password) return null;
      const match = /^(?:\/([A-Za-z0-9._]{1,30}))?\/(?:p|reel|reels)\/([A-Za-z0-9_-]{1,20})\/?$/.exec(url.pathname);
      if (!match || (match[1] && !/^(?!.*\.\.)[A-Za-z0-9_](?:[A-Za-z0-9._]{0,28}[A-Za-z0-9_])?$/.test(match[1]))) return null;
      return { shortcode: match[2], href: `https://www.instagram.com/p/${match[2]}/` };
    } catch (failure) { return null; }
  }
  const same = (left, right) => Boolean(left && right && left.shortcode === right.shortcode);
  function graphqlItem(item, index) {
    if (!object(item)) throw error('INVALID_RESPONSE');
    if (item.__typename !== undefined && !['GraphImage', 'GraphVideo'].includes(item.__typename)) {
      throw error('INVALID_RESPONSE');
    }
    const isVideo = item.__typename === 'GraphVideo' || item.is_video === true;
    if (!isVideo && item.__typename !== 'GraphImage' && item.is_video !== false) throw error('INVALID_RESPONSE');
    const resources = item.display_resources ?? (item.display_url ? [{ src: item.display_url,
      config_width: item.dimensions?.width, config_height: item.dimensions?.height }] : []);
    if (!Array.isArray(resources)) throw error('INVALID_RESPONSE');
    return { id: numericId(item.id ?? item.pk), index, type: isVideo ? 'video' : 'photo',
      imageVersions: versions(resources.map(resource => ({ url: resource?.src,
        width: resource?.config_width, height: resource?.config_height })), true),
      videoVersions: versions(item.video_versions ?? (item.video_url ? [{ url: item.video_url,
        width: item.dimensions?.width, height: item.dimensions?.height }] : []), true),
      dashManifest: item.video_dash_manifest ?? item.dash_info?.video_dash_manifest ?? '',
      hasAudio: item.has_audio ?? null };
  }
  function normalize(payload, expected) {
    if (!object(payload)) throw error('INVALID_RESPONSE');
    bounded(payload, MAX_RESPONSE_BYTES);
    if (payload.status === 'fail' || payload.message || payload.error_type) {
      const message = [payload.message, payload.error_type].filter(value => typeof value === 'string').join(' ').toLowerCase();
      if (/login_required|challenge_required|checkpoint_required|not logged in/.test(message)) throw error('AUTH_REQUIRED');
      if (/rate.limit|please wait|too many requests/.test(message)) throw error('RATE_LIMITED');
      throw error('UNAVAILABLE');
    }
    const envelope = payload.data?.xdt_api__v1__media__shortcode__web_info ?? payload;
    if (envelope.items?.length === 0 || (object(payload.data)
      && (payload.data.shortcode_media === null || payload.data.xdt_shortcode_media === null
        || payload.data.xdt_api__v1__media__shortcode__web_info === null))) throw error('UNAVAILABLE');
    const graph = payload.data?.shortcode_media ?? payload.data?.xdt_shortcode_media
      ?? payload.graphql?.shortcode_media;
    if (graph) {
      const id = identity(graph, expected);
      const edges = graph.edge_sidecar_to_children?.edges;
      if (graph.__typename === 'GraphSidecar' && !Array.isArray(edges)) throw error('INVALID_RESPONSE');
      if (edges !== undefined && !Array.isArray(edges)) throw error('INVALID_RESPONSE');
      return projection({ shortcode: expected.shortcode, id,
        username: graph.owner?.username ?? '', caption: graph.edge_media_to_caption?.edges?.[0]?.node?.text ?? '',
        items: edges ? edges.map((edge, index) => graphqlItem(edge?.node, index)) : [graphqlItem(graph, 0)] }, expected);
    }
    if (!Array.isArray(envelope.items) || envelope.items.length !== 1) throw error('INVALID_RESPONSE');
    const root = envelope.items[0];
    const id = identity(root, expected);
    if (root.media_type !== 8 && root.carousel_media != null) throw error('INVALID_RESPONSE');
    const children = root.media_type === 8 ? root.carousel_media : [root];
    if (!Array.isArray(children)) throw error('INVALID_RESPONSE');
    if (children.length > 20) throw error('RESPONSE_TOO_LARGE');
    if (root.carousel_media_count != null && (root.media_type !== 8
      || root.carousel_media_count !== children.length)) throw error('INVALID_RESPONSE');
    return projection({ shortcode: expected.shortcode, id,
      username: root.user?.username ?? '', caption: root.caption?.text ?? '',
      items: children.map((item, index) => {
        if (!object(item) || ![1, 2].includes(item.media_type)) throw error('INVALID_RESPONSE');
        return { id: numericId(item.pk ?? item.id ?? (item === root ? id : undefined)), index,
          type: item.media_type === 1 ? 'photo' : 'video',
          imageVersions: versions(item.image_versions2?.candidates ?? [], true),
          videoVersions: versions(item.video_versions ?? [], true),
          dashManifest: item.video_dash_manifest ?? '', hasAudio: item.has_audio ?? null };
      }) }, expected);
  }
  function projection(value, expected) {
    bounded(value, MAX_PROJECTION_BYTES);
    const id = identity(value, expected);
    if (!Array.isArray(value.items) || !value.items.length) throw error('INVALID_RESPONSE');
    if (value.items.length > 20) throw error('RESPONSE_TOO_LARGE');
    const seen = new Set();
    return { shortcode: expected.shortcode, id, username: text(value.username, 128),
      caption: text(value.caption, 65536), items: value.items.map((item, index) => {
        if (!object(item) || item.index !== index || !['photo', 'video'].includes(item.type)) throw error('INVALID_RESPONSE');
        const itemId = numericId(item.id);
        if (seen.has(itemId)) throw error('INVALID_RESPONSE');
        seen.add(itemId);
        const imageVersions = versions(item.imageVersions);
        const videoVersions = versions(item.videoVersions);
        // This is metadata only. Consumers must parse XML and validate every
        // extracted media URL before it can authorize a download.
        const dashManifest = text(item.dashManifest, 128 * 1024);
        if (![true, false, null].includes(item.hasAudio)) throw error('INVALID_RESPONSE');
        if ((item.type === 'photo' && (!imageVersions.length || videoVersions.length || dashManifest))
          || (item.type === 'video' && !videoVersions.length && !dashManifest)) throw error('INVALID_RESPONSE');
        return { id: itemId, index, type: item.type, imageVersions,
          videoVersions, dashManifest, hasAudio: item.hasAudio };
      }) };
  }
  globalThis.MendoInstagramSource = Object.freeze({ MAX_RESPONSE_BYTES, MAX_PROJECTION_BYTES,
    error, source, same, mediaUrl, normalize, projection });
  if (typeof module !== 'undefined') module.exports = globalThis.MendoInstagramSource;
})();

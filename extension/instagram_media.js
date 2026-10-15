/* global module */
(() => {
  const source = () => globalThis.MendoInstagramSource;
  const bySize = (a, b) => b.width * b.height - a.width * a.height;
  const knownSize = value => value.width > 0 && value.height > 0;
  const dimensions = value => knownSize(value) ? `${value.width} × ${value.height}` : 'размер не указан';
  const fail = text => { throw new Error(`Instagram: ${text}`); };
  const localName = node => node.localName || node.nodeName.split(':').pop();
  const children = (node, name) => [...node.children].filter(child => localName(child) === name);
  const descendants = (node, name) => [...node.querySelectorAll('*')].filter(child => localName(child) === name);
  const codecLabel = codec => /^avc[13]\./i.test(codec) ? 'H.264'
    : /^(?:hvc1|hev1)\./i.test(codec) ? 'H.265' : /^av01\./i.test(codec) ? 'AV1'
      : /^vp09\./i.test(codec) ? 'VP9' : /^mp4a\.40\./i.test(codec) ? 'AAC' : '';
  function dashDuration(value) {
    if (!value) return 0;
    const match = /^P(?:(\d+(?:\.\d+)?)D)?T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
    if (!match || !match.slice(1).some(Boolean)) fail('неподдержанная длительность DASH');
    const duration = Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) fail('неподдержанная длительность DASH');
    return duration;
  }
  function dashTracks(xml, schema) {
    if (!xml) return { video: [], audio: [] };
    if (xml.length > 128 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) fail('неподдержанный DASH manifest');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const root = doc.documentElement;
    if (!root || localName(root) !== 'MPD' || descendants(doc, 'parsererror').length
      || root.getAttribute('type') === 'dynamic' || descendants(root, 'ContentProtection').length
      || descendants(root, 'SegmentTemplate').length || descendants(root, 'SegmentList').length
      || children(root, 'Period').length !== 1) fail('неподдержанный DASH manifest');
    const representations = descendants(root, 'Representation');
    if (!representations.length || representations.length > 64
      || descendants(root, 'BaseURL').length !== representations.length) fail('неподдержанный DASH manifest');
    for (const node of [root, ...root.querySelectorAll('*')]) for (const attribute of node.attributes) {
      if (/^(?:sourceURL|href)$/i.test(attribute.localName || attribute.name.split(':').pop())) {
        if (!schema.mediaUrl(attribute.value)) fail('недопустимый URL дорожки DASH');
        fail('DASH с отдельными initialization URL не поддерживается');
      }
    }
    const tracks = { video: [], audio: [] };
    const duration = dashDuration(root.getAttribute('mediaPresentationDuration') || children(root, 'Period')[0].getAttribute('duration'));
    for (const representation of representations) {
      const adaptation = representation.parentElement;
      if (localName(adaptation) !== 'AdaptationSet'
        || adaptation.parentElement !== children(root, 'Period')[0]) fail('неподдержанная структура DASH');
      const mime = representation.getAttribute('mimeType') || adaptation.getAttribute('mimeType') || '';
      const codec = representation.getAttribute('codecs') || adaptation.getAttribute('codecs') || '';
      const label = codecLabel(codec);
      const kind = mime === 'video/mp4' ? 'video' : mime === 'audio/mp4' ? 'audio' : '';
      if (!kind || !label || codec.length > 100 || !/^[a-z0-9]+(?:\.[a-z0-9]+)+$/i.test(codec)
        || (kind === 'audio') !== (label === 'AAC')) fail('неподдержанный codec DASH');
      const bases = children(representation, 'BaseURL');
      if (bases.length !== 1 || !schema.mediaUrl(bases[0].textContent.trim())) fail('недопустимый URL дорожки DASH');
      const number = name => Number(representation.getAttribute(name) || adaptation.getAttribute(name) || 0);
      const width = number('width'), height = number('height'), bandwidth = number('bandwidth');
      if ((kind === 'video' && (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width > 32768 || height > 32768))
        || !Number.isSafeInteger(bandwidth) || bandwidth < 0 || bandwidth > 1_000_000_000) fail('неверные параметры DASH');
      tracks[kind].push({ url: bases[0].textContent.trim(), width, height, bandwidth, codec, duration,
        mime: `${mime}; codecs="${codec}"`, codecLabel: label });
    }
    tracks.video.sort((a, b) => bySize(a, b) || b.bandwidth - a.bandwidth);
    tracks.audio.sort((a, b) => b.bandwidth - a.bandwidth);
    return tracks;
  }
  function choices(value, schema = source()) {
    const post = schema.projection(value, { shortcode: value.shortcode });
    const result = [];
    for (const item of post.items) {
      const group = `Элемент ${item.index + 1} · ${item.type === 'photo' ? 'Фото' : 'Видео'}`;
      if (item.type === 'photo') {
        const seen = new Set(), variants = new Map();
        for (const version of [...item.imageVersions].sort(bySize)) {
          if (seen.has(version.url)) continue;
          seen.add(version.url);
          const size = dimensions(version), variant = (variants.get(size) || 0) + 1;
          variants.set(size, variant);
          const id = `${item.id}:photo:${version.width}x${version.height}:${variant}`;
          result.push({ id, compatibilityKey: id, group,
            label: `Фото · ${size} · формат источника${variant > 1 ? ` · вариант ${variant}` : ''}`, kind: 'photo',
            itemIndex: item.index, format: 'source', version, variant });
        }
      } else {
        const tracks = dashTracks(item.dashManifest, schema);
        const audio = tracks.audio[0];
        const versions = [
          ...item.videoVersions.map(version => ({ ...version, transport: 'progressive' })),
          ...tracks.video.filter(() => audio || item.hasAudio !== true).map(version => ({ ...version, transport: 'dash' })),
        ].sort((a, b) => bySize(a, b) || (b.bandwidth || 0) - (a.bandwidth || 0));
        const seen = new Set(), variants = new Map();
        for (const version of versions) {
          if (seen.has(version.url)) continue;
          seen.add(version.url);
          const transport = version.transport;
          const size = `${dimensions(version)}:${transport}`, variant = (variants.get(size) || 0) + 1;
          variants.set(size, variant);
          const id = `${item.id}:video:${version.width}x${version.height}:${transport}:${variant}`;
          const sound = transport === 'dash' ? audio ? `${version.codecLabel} + ${audio.codecLabel}` : `${version.codecLabel} · без звука`
            : item.hasAudio === true ? 'со звуком' : item.hasAudio === false ? 'без звука' : 'звук не подтверждён';
          result.push({ id, compatibilityKey: id, group,
            label: `Видео · ${dimensions(version)} · MP4 · ${sound}${variant > 1 ? ` · вариант ${variant}` : ''}`,
            kind: 'video', itemIndex: item.index, format: 'mp4', transport, version, variant, ...(transport === 'dash' && audio ? { audio } : {}) });
        }
        if (!versions.length) fail(`для элемента ${item.index + 1} нет поддержанного видео`);
        if (audio || item.hasAudio !== false) {
          const version = audio || versions.find(version => version.transport === 'progressive');
          if (version) for (const format of ['m4a', 'mp3']) {
            const id = `${item.id}:audio:${format}`;
            const uncertainty = !audio && item.hasAudio === null ? ' · звук не подтверждён' : '';
            result.push({ id, compatibilityKey: id, group, kind: 'audio', itemIndex: item.index, format,
              transport: audio ? 'dash' : 'progressive', version,
              label: (format === 'mp3' ? 'Только звук · MP3 · преобразование' : 'Исходное аудио · M4A · без перекодирования') + uncertainty });
          }
        }
      }
    }
    if (post.caption.trim()) result.push({ id: `${post.id}:caption`, compatibilityKey: `${post.id}:caption`,
      group: 'Текст', label: 'Описание автора · TXT', kind: 'caption', format: 'txt' });
    return result;
  }
  const MAX_FILE_BYTES = 1024 ** 3 - 65536;
  const MAX_TRACK_BYTES = 750_000_000;
  const CHUNK_BYTES = 1024 ** 2;
  const bytesText = bytes => String.fromCharCode(...bytes);
  // Gecko can expose Blob/network buffers from the page compartment. The
  // second construction owns the backing bytes before slice/subarray species
  // resolution touches the inaccessible constructor of the foreign view.
  const ownedBytes = value => new Uint8Array(new Uint8Array(value));
  function sniff(bytes) {
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: 'image/jpeg', extension: 'jpg' };
    if (bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) return { mime: 'image/png', extension: 'png' };
    if (/^GIF8[79]a/.test(bytesText(bytes.slice(0, 6)))) return { mime: 'image/gif', extension: 'gif' };
    if (bytesText(bytes.slice(0, 4)) === 'RIFF' && bytesText(bytes.slice(8, 12)) === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
    if (bytesText(bytes.slice(4, 8)) === 'ftyp') {
      const brands = bytesText(bytes.slice(8, 64));
      if (/avif|avis/.test(brands)) return { mime: 'image/avif', extension: 'avif' };
      if (/heic|heix|hevc|hevx/.test(brands)) return { mime: 'image/heic', extension: 'heic' };
      return { mime: 'video/mp4', extension: 'mp4' };
    }
    fail('сервер вернул неизвестный формат медиа');
  }
  async function validateImage(file, expected, check) {
    const { blob, mime } = file;
    const invalid = () => fail('фото повреждено или передано не полностью');
    const read = async (at, length) => {
      check();
      if (at < 0 || length < 0 || at + length > blob.size) invalid();
      const bytes = ownedBytes(await blob.slice(at, at + length).arrayBuffer());
      check();
      if (bytes.length !== length) invalid();
      return bytes;
    };
    const uint16 = (bytes, at, little = false) => new DataView(bytes.buffer).getUint16(at, little);
    const uint32 = (bytes, at, little = false) => new DataView(bytes.buffer).getUint32(at, little);
    let width, height, structural = false;
    if (mime === 'image/jpeg') {
      const tail = await read(blob.size - 2, 2);
      if (tail[0] !== 255 || tail[1] !== 217) invalid();
      let at = 2, scanned = false;
      for (let count = 0; count < 4096 && at < blob.size - 2; count++) {
        let marker = await read(at, 2);
        if (marker[0] !== 255) invalid();
        while (marker[1] === 255) { at++; marker = await read(at, 2); }
        if (marker[1] === 0 || marker[1] === 216 || marker[1] === 217) invalid();
        const length = uint16(await read(at + 2, 2), 0);
        if (length < 2 || at + 2 + length > blob.size - 2) invalid();
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker[1])) {
          if (length < 8) invalid();
          const frame = await read(at + 4, 6);
          height = uint16(frame, 1); width = uint16(frame, 3);
          if (length !== 8 + 3 * frame[5]) invalid();
        }
        if (marker[1] === 218) {
          const components = (await read(at + 4, 1))[0];
          if (!width || !height || length !== 6 + 2 * components || at + 2 + length >= blob.size - 2) invalid();
          scanned = true;
          break;
        }
        at += 2 + length;
      }
      if (!scanned) invalid();
      structural = true;
    } else if (mime === 'image/png') {
      let at = 8, data = false, ended = false;
      for (let count = 0; count < 65536 && at < blob.size; count++) {
        const header = await read(at, 8), size = uint32(header, 0), type = bytesText(header.slice(4, 8));
        if (!/^[A-Za-z]{4}$/.test(type) || at + 12 + size > blob.size) invalid();
        if (at === 8 && (type !== 'IHDR' || size !== 13)) invalid();
        if (type === 'IHDR') {
          if (at !== 8 || size !== 13) invalid();
          const info = await read(at + 8, 13);
          width = uint32(info, 0); height = uint32(info, 4);
          if (![0, 2, 3, 4, 6].includes(info[9]) || info[10] || info[11] || info[12] > 1) invalid();
        }
        if (type === 'IDAT' && size) data = true;
        at += 12 + size;
        if (type === 'IEND') { if (size || !data || at !== blob.size) invalid(); ended = true; break; }
      }
      if (!ended) invalid();
      structural = true;
    } else if (mime === 'image/webp') {
      const header = await read(0, 12);
      if (uint32(header, 4, true) + 8 !== blob.size) invalid();
      let at = 12, payloads = 0;
      for (let count = 0; count < 65536 && at < blob.size; count++) {
        const chunk = await read(at, 8), size = uint32(chunk, 4, true), type = bytesText(chunk.slice(0, 4));
        const end = at + 8 + size + size % 2;
        if (end > blob.size || size < 1) invalid();
        if (type === 'VP8 ') {
          if (size < 10) invalid();
          const frame = await read(at + 8, 10);
          if (bytesText(frame.slice(3, 6)) !== '\x9d\x01\x2a') invalid();
          width = uint16(frame, 6, true) & 16383; height = uint16(frame, 8, true) & 16383; payloads++;
        } else if (type === 'VP8L') {
          if (size < 5) invalid();
          const frame = await read(at + 8, 5);
          if (frame[0] !== 47) invalid();
          width = 1 + ((frame[1] | frame[2] << 8) & 16383);
          height = 1 + ((frame[2] >> 6 | frame[3] << 2 | frame[4] << 10) & 16383); payloads++;
        } else if (type === 'VP8X') {
          if (size !== 10) invalid();
          const frame = await read(at + 8, 10);
          width = 1 + frame[4] + (frame[5] << 8) + (frame[6] << 16);
          height = 1 + frame[7] + (frame[8] << 8) + (frame[9] << 16);
        } else if (type === 'ANMF') {
          if (size < 16) invalid();
          payloads++;
        }
        at = end;
      }
      if (at !== blob.size || !width || !height || payloads < 1) invalid();
      structural = true;
    } else if (mime === 'image/gif') {
      const info = await read(0, 13);
      if ((await read(blob.size - 1, 1))[0] !== 59) invalid();
      width = uint16(info, 6, true); height = uint16(info, 8, true);
    } else {
      // AVIF/HEIC must have complete ISO boxes and a successful native decoder.
      let at = 0, meta = false, data = false;
      for (let count = 0; count < 65536 && at < blob.size; count++) {
        const header = await read(at, 8), size = uint32(header, 0), type = bytesText(header.slice(4, 8));
        if (size < 8 || at + size > blob.size) invalid();
        if (type === 'meta') meta = true;
        if (type === 'mdat' && size > 8) data = true;
        at += size;
      }
      if (at !== blob.size || !meta || !data) invalid();
    }
    const validateDimensions = (actualWidth, actualHeight) => {
      if (!Number.isInteger(actualWidth) || !Number.isInteger(actualHeight) || actualWidth < 1 || actualHeight < 1
        || actualWidth > 32768 || actualHeight > 32768 || actualWidth * actualHeight > 100_000_000) invalid();
      if (knownSize(expected) && (actualWidth !== expected.width || actualHeight !== expected.height)) {
        fail('размер фото не совпадает с выбранным вариантом');
      }
    };
    if (width !== undefined) validateDimensions(width, height);
    check();
    if (typeof globalThis.createImageBitmap === 'function') {
      let bitmap;
      try {
        bitmap = await globalThis.createImageBitmap(blob, { imageOrientation: 'none' });
        check();
        validateDimensions(bitmap.width, bitmap.height);
        if (width !== undefined && (width !== bitmap.width || height !== bitmap.height)) invalid();
      } catch (error) {
        check();
        fail('браузер не смог декодировать фото; файл повреждён или формат не поддерживается');
      } finally { bitmap?.close(); }
    } else if (!structural) fail('декодер этого формата фото недоступен');
  }
  function safeName(post, choice) {
    const owner = [...post.username.replace(/[\\/:*?"<>|]/g, '_')].filter(char => char.codePointAt(0) >= 32)
      .slice(0, 40).join('').replace(/[. ]+$/g, '') || 'post';
    const item = choice.itemIndex === undefined ? '' : ` - ${String(choice.itemIndex + 1).padStart(2, '0')}`;
    const size = ['photo', 'video'].includes(choice.kind) && knownSize(choice.version)
      ? ` [${choice.version.width}x${choice.version.height}]` : '';
    const suffix = choice.kind === 'caption' ? ' - caption' : choice.kind === 'audio' ? ' - audio' : '';
    const variant = choice.variant > 1 ? ` - variant ${choice.variant}` : '';
    const transport = choice.kind === 'video' && choice.transport === 'dash' ? ' - DASH' : '';
    return `Instagram - ${owner} - ${post.shortcode}${item}${size}${suffix}${transport}${variant}`;
  }
  // Check physical boxes, then consume every indexed packet with the bundled
  // guarded demuxer. Metadata-only reads alone can silently accept EOF samples.
  async function mp4Tracks(blob, check, lib, expected = {}, signal) {
    let visited = 0;
    async function boxes(start, end) {
      const result = [];
      while (start < end) {
        check();
        if (++visited > 4096 || end - start < 8) fail('неподдержанная структура MP4');
        const header = ownedBytes(await blob.slice(start, Math.min(start + 16, end)).arrayBuffer());
        const view = new DataView(header.buffer);
        const firstSize = view.getUint32(0);
        const headerSize = firstSize === 1 ? 16 : 8;
        const size = firstSize === 1 && header.length === 16
          ? view.getUint32(8) * 2 ** 32 + view.getUint32(12) : firstSize === 0 ? end - start : firstSize;
        if (!Number.isSafeInteger(size) || size < headerSize || start + size > end) fail('медиа MP4 передано не полностью');
        result.push({ type: bytesText(header.slice(4, 8)), start: start + headerSize, end: start + size });
        start += size;
      }
      return result;
    }
    const top = await boxes(0, blob.size);
    const moovs = top.filter(box => box.type === 'moov');
    if (moovs.length !== 1) fail('MP4 не содержит подтверждённые дорожки');
    const mediaRanges = top.filter(box => box.type === 'mdat');
    const payloadBytes = mediaRanges.reduce((sum, box) => sum + box.end - box.start, 0);
    const sampleExtent = packet => {
      const extent = packet.mendoMp4Extent;
      if (!extent || !Number.isSafeInteger(extent.offset) || extent.offset < 0
        || !Number.isSafeInteger(extent.byteLength) || extent.byteLength !== packet.byteLength || extent.byteLength < 1
        || !Number.isSafeInteger(extent.offset + extent.byteLength)) fail('диапазон sample MP4 не подтверждён parser');
      let low = 0, high = mediaRanges.length - 1, selected = -1;
      while (low <= high) {
        const middle = low + Math.floor((high - low) / 2);
        if (mediaRanges[middle].start <= extent.offset) { selected = middle; low = middle + 1; }
        else high = middle - 1;
      }
      if (selected < 0 || extent.offset + extent.byteLength > mediaRanges[selected].end) fail('sample MP4 выходит за payload mdat');
      return extent;
    };
    const input = new lib.Input({ formats: [lib.MP4], source: new lib.CustomSource({
      getSize: () => blob.size, maxCacheSize: 8 * 1024 ** 2,
      read(start, end) {
        check();
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > blob.size || end < start
          || end - start > 16 * 1024 ** 2) fail('sample или метаданные MP4 превышают лимит проверки');
        return Promise.resolve(blob.slice(start, end).arrayBuffer()).then(buffer => {
          const bytes = ownedBytes(buffer);
          check();
          if (bytes.byteLength !== end - start) fail('MP4 передано не полностью');
          return bytes;
        });
      },
    }) });
    let disposed = false, rejectAbort;
    const dispose = () => { if (!disposed) { disposed = true; input.dispose(); } };
    const aborted = signal && new Promise((resolve, reject) => { rejectAbort = reject; });
    aborted?.catch(() => {});
    const abort = () => {
      dispose();
      try { check(); } catch (error) { rejectAbort(error); }
    };
    const waiting = promise => aborted ? Promise.race([promise, aborted]) : promise;
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      check();
      const sourceTracks = await waiting(input.getTracks());
      check();
      if (!sourceTracks.length || sourceTracks.length > 8) fail('неподдержанное число дорожек MP4');
      const tracks = [];
      let allBytes = 0, allPackets = 0;
      for (const track of sourceTracks) {
        check();
        if (!['audio', 'video'].includes(track.type)) fail('неподдержанная дорожка MP4');
        const codec = await waiting(track.getInternalCodecId());
        const info = { type: track.type, codec };
        if (track.type === 'video') {
          info.width = await waiting(track.getDisplayWidth()); info.height = await waiting(track.getDisplayHeight());
          info.codedWidth = await waiting(track.getCodedWidth()); info.codedHeight = await waiting(track.getCodedHeight());
          info.rotation = await waiting(track.getRotation());
          if (![info.width, info.height, info.codedWidth, info.codedHeight].every(value => Number.isInteger(value) && value > 0 && value <= 32768)) fail('неверные размеры видео MP4');
          if (knownSize(expected) && (expected.width !== info.width || expected.height !== info.height)) fail('размер видео не совпадает с выбранным вариантом');
        }
        const sink = new lib.EncodedPacketSink(track);
        let metadata = await waiting(sink.getFirstPacket({ metadataOnly: true }));
        if (metadata) sampleExtent(metadata);
        let actual = await waiting(sink.getFirstPacket());
        let count = 0, first = Infinity, last = -Infinity;
        while (metadata || actual) {
          check();
          if (!metadata || !actual || metadata.sequenceNumber !== actual.sequenceNumber
            || metadata.byteLength !== actual.byteLength || metadata.timestamp !== actual.timestamp || metadata.duration !== actual.duration
            || !Number.isSafeInteger(actual.byteLength) || actual.byteLength < 1 || actual.data.byteLength !== actual.byteLength
            || !Number.isFinite(actual.timestamp) || !Number.isFinite(actual.duration) || actual.duration < 0) fail('samples MP4 переданы не полностью');
          const metadataExtent = sampleExtent(metadata), actualExtent = sampleExtent(actual);
          if (metadataExtent.offset !== actualExtent.offset || metadataExtent.byteLength !== actualExtent.byteLength) fail('диапазон sample MP4 изменился при чтении');
          allBytes += actual.byteLength;
          if (++allPackets > 1_000_000 || allBytes > payloadBytes) fail('samples MP4 выходят за доступные media bytes');
          count++;
          first = Math.min(first, actual.timestamp); last = Math.max(last, actual.timestamp + actual.duration);
          if (allPackets % 64 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); check(); }
          metadata = await waiting(sink.getNextPacket(metadata, { metadataOnly: true }));
          if (metadata) sampleExtent(metadata);
          actual = await waiting(sink.getNextPacket(actual));
        }
        if (!count || !(last > first)) fail('MP4 не содержит полную непустую дорожку');
        const declaredDuration = await waiting(track.getDurationFromMetadata());
        const resolution = await waiting(track.getTimeResolution());
        const tolerance = Math.max(0.05, 2 / resolution);
        if (Number.isFinite(declaredDuration) && declaredDuration > 0 && last + tolerance < declaredDuration) fail('длительность MP4 короче заявленной в metadata');
        const dashTolerance = 0.25;
        if (Number.isFinite(expected.duration) && expected.duration > 0 && last - first + dashTolerance < expected.duration) fail('длительность MP4 короче заявленной в DASH');
        tracks.push({ ...info, packetCount: count, duration: last - first });
      }
      return tracks;
    } catch (error) {
      check();
      if (String(error?.message || '').startsWith('Instagram:')) throw error;
      fail(`проверка MP4 отклонена: ${String(error?.message || error).slice(0, 250)}`);
    } finally { signal?.removeEventListener('abort', abort); dispose(); }
  }
  function base64(bytes) {
    let text = '';
    for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(text);
  }
  function create({ schema = source(), packageUI = globalThis.MendoPackageUI,
    runtime = globalThis.chrome?.runtime, fetcher,
    loadParser = () => import(runtime.getURL('vendor/mediabunny/mediabunny.min.mjs')) } = {}) {
    let running = false;
    let parserLoad;
    const parser = () => parserLoad ||= Promise.resolve().then(loadParser).catch(error => { parserLoad = null; throw error; });
    async function run(value, requested, { signal: callerSignal, onProgress } = {}) {
      if (running) fail('сохранение уже выполняется');
      const post = schema.projection(value, { shortcode: value.shortcode });
      const choice = choices(post, schema).find(candidate => candidate.id === requested?.id
        && candidate.compatibilityKey === requested.compatibilityKey);
      if (!choice) fail('выбранный вариант больше недоступен');
      const controller = new AbortController(), signals = [callerSignal, packageUI.signal].filter(Boolean);
      const abort = () => controller.abort();
      for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
      if (signals.some(signal => signal.aborted)) controller.abort();
      let timedOut = false, disconnectedError;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20 * 60 * 1000);
      const check = () => {
        if (disconnectedError) throw disconnectedError;
        if (timedOut) fail('истекло время передачи медиа');
        if (controller.signal.aborted) throw Object.assign(new Error('Сохранение отменено'), { name: 'AbortError', cancelled: true });
        packageUI.check();
      };
      const progress = (stage, number, text) => { check(); onProgress?.({ stage, value: number, text }); };
      const inspectMp4 = async (blob, version) => {
        progress('process', null, 'Проверка дорожек MP4');
        return mp4Tracks(blob, check, await parser(), version, controller.signal);
      };
      const fetchMedia = fetcher || packageUI.fetch.bind(packageUI);
      async function readFile(url, kind, limit = MAX_FILE_BYTES) {
        check();
        if (!schema.mediaUrl(url)) fail('недопустимый URL медиа');
        const response = await fetchMedia(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
        let reader, cancelReader;
        try {
          check();
          if (response.status !== 200) fail(`медиа недоступно (HTTP ${response.status})`);
          if (response.redirected || (response.url && !schema.mediaUrl(response.url))) fail('неподтверждённое перенаправление медиа');
          const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          if (mime && mime !== 'application/octet-stream' && !(kind === 'photo' ? /^image\// : /^(?:video|audio)\/mp4$/).test(mime)) fail('вместо медиа пришёл неподдержанный ответ');
          const length = response.headers.get('content-length');
          const declared = length === null ? 0 : Number(length);
          if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(declared) || declared <= 0)) fail('сервер сообщил неверный размер файла');
          if (declared > limit) fail('медиа превышает допустимый размер');
          if (!response.body?.getReader) fail('сервер не передал поток медиа');
          reader = response.body.getReader();
          cancelReader = async () => {
            // A Gecko reader can return a foreign Promise whose then/catch
            // properties are inaccessible. Cleanup must not replace the
            // transfer outcome or escape from the abort event handler.
            try { await reader.cancel(); } catch {}
          };
          controller.signal.addEventListener('abort', cancelReader, { once: true });
          const parts = [];
          let total = 0;
          for (;;) {
            check();
            const { done, value: next } = await reader.read();
            check();
            if (done) break;
            total += next.byteLength;
            if (total > limit || (declared && total > declared)) fail('медиа превышает заявленный размер');
            const bytes = ownedBytes(next);
            parts.push(bytes);
            progress('fetch', declared ? total / declared : null, 'Скачивание файла');
          }
          if (!total || (declared && total !== declared)) fail('медиа передано не полностью');
          const blob = new Blob(parts);
          const detected = sniff(ownedBytes(await blob.slice(0, 64).arrayBuffer()));
          if ((kind === 'photo') !== detected.mime.startsWith('image/')) fail('формат медиа не совпадает с выбранным вариантом');
          if (mime && mime !== 'application/octet-stream' && mime !== detected.mime
            && !(mime === 'audio/mp4' && detected.mime === 'video/mp4')) fail('MIME медиа не совпадает с содержимым');
          return { blob: blob.slice(0, blob.size, detected.mime), ...detected };
        } finally {
          controller.signal.removeEventListener('abort', cancelReader);
          if (reader) await cancelReader();
          else { try { await response.body?.cancel(); } catch {} }
        }
      }
      async function processFiles(files, filename, options) {
        let producer, jobId, registered = false, finished = false, abortPromise;
        const abortJob = () => {
          if (registered && !finished && !abortPromise) {
            abortPromise = producer.send({ t: 'mendosave-abort', jobId }).catch(() => {});
          }
        };
        const onMessage = message => {
          if (message?.t !== 'mendosave-progress' || message.jobId !== jobId || controller.signal.aborted) return;
          onProgress?.({ stage: 'process', value: Number.isFinite(message.value) ? message.value : null,
            text: message.status || 'Обработка медиа' });
        };
        const requireOk = response => {
          check();
          if (response?.cancelled) throw Object.assign(new Error('Сохранение отменено'), { name: 'AbortError', cancelled: true });
          if (!response?.ok) fail(response?.error || 'обработчик не подтвердил операцию');
          return response;
        };
        try {
          check();
          producer = await packageUI.acquireProcessor({ signal: controller.signal,
            onDisconnect(error) { disconnectedError = error; controller.abort(); } });
          check();
          requireOk(await producer.send({ t: 'mendosave-ensure' }));
          jobId = globalThis.crypto.randomUUID();
          const registration = requireOk(await producer.send({ t: 'mendosave-register-job', jobId }));
          registered = true;
          if (!Number.isInteger(registration.tabId) || registration.tabId < 0) fail('вкладка загрузки не определена');
          controller.signal.addEventListener('abort', abortJob, { once: true });
          runtime?.onMessage?.addListener(onMessage);
          requireOk(await producer.send({ t: 'mendosave-begin', jobId, tabId: registration.tabId, filename,
            videoSize: files.filter(file => file.track === 'video').reduce((size, file) => size + file.blob.size, 0),
            audioSize: files.filter(file => file.track === 'audio').reduce((size, file) => size + file.blob.size, 0),
            ...options }));
          for (const file of files) {
            for (let offset = 0; offset < file.blob.size; offset += CHUNK_BYTES) {
              check();
              const bytes = ownedBytes(await file.blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
              requireOk(await producer.send({ t: 'mendosave-chunk', jobId, track: file.track, b64: base64(bytes) }));
              progress('process', (offset + bytes.length) / file.blob.size, 'Передача в обработчик');
            }
          }
          progress('process', null, 'Обработка медиа');
          const result = requireOk(await producer.send({ t: 'mendosave-finalize', jobId }));
          finished = true;
          return result.filename || filename;
        } finally {
          runtime?.onMessage?.removeListener(onMessage);
          controller.signal.removeEventListener('abort', abortJob);
          abortJob();
          await abortPromise;
          producer?.release();
        }
      }
      running = true;
      try {
        check();
        let file;
        if (choice.kind === 'caption') file = { blob: new Blob([post.caption], { type: 'text/plain' }), extension: 'txt' };
        else if (choice.kind === 'photo') {
          file = await readFile(choice.version.url, 'photo');
          await validateImage(file, choice.version, check);
        }
        else if (choice.kind === 'video') {
          file = await readFile(choice.version.url, 'video', choice.transport === 'dash' ? MAX_TRACK_BYTES : MAX_FILE_BYTES);
          const tracks = await inspectMp4(file.blob, choice.version);
          const videoTrack = tracks.find(track => track.type === 'video');
          if (!videoTrack) fail('файл не содержит видеодорожку');
          if (choice.transport === 'dash' && videoTrack.codec.toLowerCase() !== choice.version.codec.split('.')[0].toLowerCase()) fail('video codec не совпадает с DASH');
          if (choice.transport === 'dash' && choice.audio) {
            const audio = await readFile(choice.audio.url, 'audio', Math.min(MAX_TRACK_BYTES, MAX_FILE_BYTES - file.blob.size));
            const audioTracks = await inspectMp4(audio.blob, choice.audio);
            if (!audioTracks.some(track => track.type === 'audio' && track.codec === 'mp4a')
              || audioTracks.some(track => track.type === 'video')) fail('audio codec не совпадает с DASH');
            return await processFiles([{ track: 'video', blob: file.blob }, { track: 'audio', blob: audio.blob }],
              `${safeName(post, choice)}.mp4`, { format: 'mp4', transcode: false,
                videoMime: choice.version.mime, audioMime: choice.audio.mime });
          }
          if (post.items[choice.itemIndex].hasAudio === true && !tracks.some(track => track.type === 'audio')) fail('сервер вернул видео без обещанной аудиодорожки');
        }
        else if (choice.kind === 'audio') {
          file = await readFile(choice.version.url, 'audio', MAX_TRACK_BYTES);
          const tracks = await inspectMp4(file.blob, choice.version);
          const audio = tracks.find(track => track.type === 'audio');
          if (!audio) fail('в видео нет аудиодорожки');
          if (choice.format === 'm4a' && audio.codec !== 'mp4a') fail('исходный audio codec не поддерживает M4A без перекодирования');
          const filename = `${safeName(post, choice)}.${choice.format}`;
          if (choice.transport === 'dash' && choice.format === 'm4a') {
            if (tracks.some(track => track.type === 'video')) fail('исходная аудиодорожка содержит видео');
            file = { blob: file.blob.slice(0, file.blob.size, 'audio/mp4'), extension: 'm4a' };
          } else return await processFiles([{ track: 'audio', blob: file.blob }], filename, {
            format: 'mp3', audioFormat: choice.format === 'mp3' ? 'mp3' : 'original',
            audioQuality: 'best', audioMime: `audio/mp4; codecs="${audio.codec}"`,
            ...(choice.format === 'm4a' ? { audioCopyOnly: true } : {}),
          });
        } else fail('выбранный медиаформат пока недоступен');
        const filename = `${safeName(post, choice)}.${file.extension}`;
        progress('save', null, 'Сохранение файла');
        const output = await packageUI.saveBlob(file.blob, filename, { signal: controller.signal });
        check();
        progress('save', 1, 'Файл сохранён');
        return output || filename;
      } catch (error) {
        check();
        throw error;
      } finally {
        clearTimeout(timer);
        for (const signal of signals) signal.removeEventListener('abort', abort);
        running = false;
      }
    }
    return { run };
  }
  const api = Object.freeze({ choices, create });
  globalThis.MendoInstagramMedia = api;
  if (typeof module !== 'undefined') module.exports = api;
})();

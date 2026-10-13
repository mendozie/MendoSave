const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { browserContext } = require('./background-harness.cjs');

const ORIGINAL_VIDEO = 'jNQXAC9IVRw';
const NEXT_VIDEO = 'SBN-oBhn5rE';
const source = fs.readFileSync('extension/content_hook.js', 'utf8');

function captionTrack(videoId = ORIGINAL_VIDEO, lang = 'en', kind = '', name = '') {
  return { languageCode: lang, kind, vssId: `${kind === 'asr' ? 'a' : ''}.${lang}${name ? '.' + name : ''}`,
    baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}${kind ? '&kind=' + kind : ''}${name ? '&name=' + name : ''}&sig=fixture` };
}

function response(body, url = '', ok = true) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok, status: ok ? 200 : 403, url, text: async () => text, json: async () => JSON.parse(text),
    clone: () => ({ text: async () => text }) };
}

function attributedLegacyPanel(videoId = ORIGINAL_VIDEO, lang = 'en', kind = '', name = '') {
  const field = (index, value) => { const bytes = Buffer.from(value); return Buffer.concat([Buffer.from([index * 8 + 2, bytes.length]), bytes]); };
  const selector = Buffer.concat([field(1, kind), field(2, lang), field(3, name)]).toString('base64');
  const continuation = Buffer.concat([field(1, videoId), field(2, encodeURIComponent(selector))]).toString('base64');
  return { content: { transcriptRenderer: { content: { transcriptSearchPanelRenderer: {
    body: { transcriptSegmentListRenderer: { initialSegments: [1200, 5318, 7974, 12616, 14421, 16881].map((start, index) => ({
      transcriptSegmentRenderer: { startMs: String(start), endMs: String(start + 1000), snippet: { simpleText: `Attributed speech ${index + 1}` } },
    })) } },
    footer: { transcriptFooterRenderer: { languageMenu: { sortFilterSubMenuRenderer: { subMenuItems: [{ selected: true,
      continuation: { reloadContinuationData: { continuation } } }] } } } },
  } } } } };
}

function pageHook(tracks = [captionTrack()]) {
  const { window, document } = parseHTML('<html><body><div id="movie_player"><video></video></div></body></html>');
  for (const key of ['__mendosave_captured_timedtext', '__mendosave_captured_timedtext_sources', '__mendosave_next_params']) window[key] = [];
  window.__mendosaveHookInstalled = false;
  window.ytInitialData = undefined;
  window.ytInitialPlayerResponse = undefined;
  class SourceBuffer { appendBuffer() {} }
  class MediaSource { addSourceBuffer() { return new SourceBuffer(); } }
  window.MediaSource = MediaSource;
  window.ManagedMediaSource = undefined;
  window.SourceBuffer = SourceBuffer;
  window.Worker = undefined;
  const location = new URL(`https://www.youtube.com/watch?v=${ORIGINAL_VIDEO}`);
  const player = document.getElementById('movie_player'), media = player.querySelector('video');
  const state = { videoId: ORIGINAL_VIDEO, tracks, duration: 19.013 };
  player.getPlayerResponse = () => ({ videoDetails: { videoId: state.videoId, lengthSeconds: String(state.duration) },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: state.tracks } } });
  player.getVideoData = () => ({ video_id: state.videoId, title: 'Original title' });
  player.getPlaybackQuality = () => 'small';
  player.getAvailableQualityLevels = () => [];
  player.getOption = (_module, option) => option === 'tracklist' ? state.tracks : state.tracks[0];
  media.currentTime = 0; media.duration = state.duration;
  class HTMLMediaElement { canPlayType() { return 'probably'; } }
  const requests = [], pending = new Map();
  let sequence = 1;
  const h = { window, document, location, state, player, media, requests,
    fetch: async (url) => response({ events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Original speech' }] }] }, url),
    proxy: async () => ({ ok: false, error: 'fixture unavailable' }),
    navigate(videoId, { event = true } = {}) {
      if (event) document.dispatchEvent(new window.Event('yt-navigate-start'));
      location.searchParams.set('v', videoId);
      state.videoId = videoId;
      state.tracks = [captionTrack(videoId)];
      state.duration = videoId === ORIGINAL_VIDEO ? 19.013 : 1465.161;
      media.duration = state.duration;
    },
    request(cmd, payload = {}) {
      const reqId = sequence++;
      const result = new Promise((resolve) => pending.set(reqId, resolve));
      emit({ __mendosave_to_hook: true, cmd, reqId, ...payload });
      return result;
    },
  };
  const emit = (data) => {
    const event = new window.Event('message');
    event.source = window; event.origin = location.origin; event.data = data;
    window.dispatchEvent(event);
  };
  window.postMessage = (message) => {
    if (message.__mendosave_from_hook) {
      pending.get(message.reqId)?.(message);
      pending.delete(message.reqId);
    } else if (message.__mendosave_to_ui && message.msg?.t === 'mendosave-fetch-caption') {
      Promise.resolve(h.proxy(message.msg)).then((resp) => emit({ __mendosave_from_ui: true, reqId: message.reqId, ok: true, resp }));
    }
  };
  window.fetch = async (url, options) => { requests.push({ url, options }); return h.fetch(url, options); };
  const context = vm.createContext({ window, document, location, HTMLMediaElement, MediaSource, SourceBuffer, URL, URLSearchParams, TextDecoder, TextEncoder,
    Uint8Array, ArrayBuffer, DataView, Blob, Node: window.Node, atob, btoa, performance, navigator: { language: 'en', userAgent: 'fixture' },
    screen: { width: 1920, height: 1080 }, MendoCaptions: require('../extension/captions.js'),
    fetch: (...args) => window.fetch(...args),
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay) { return delay === 100 || delay === 250 ? setTimeout(callback, 0) : 0; },
    clearTimeout, setInterval() { return 0; }, clearInterval() {},
  });
  vm.runInContext(source, context);
  return h;
}

test('pending SRT rejects native Next instead of exporting new video cues under the original filename', async () => {
  const h = pageHook();
  const available = await h.request('subs-available');
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  let started;
  const fetching = new Promise((resolve) => { started = resolve; });
  h.fetch = async (url) => {
    if (url.includes('/get_transcript')) return response({ transcriptSegmentRenderer: {
      startMs: '1453000', endMs: '1465161', snippet: { simpleText: 'Speech from the next video' } } }, url);
    started();
    await first;
    return response('', url, false);
  };
  const result = h.request('subtitles', { format: 'srt', source: available.source });
  await fetching;
  h.navigate(NEXT_VIDEO);
  releaseFirst();
  const saved = await result;
  assert.equal(saved.ok, false, `changed source must be rejected, got ${JSON.stringify({ text: saved.text, cues: saved.cues })}`);
  assert.match(saved.error, /Материал.*изменился/);
  assert.equal(saved.text, undefined);
});

test('all subtitle formats return the immutable material and selected-track snapshot from availability', async (t) => {
  for (const format of ['srt', 'txt', 'timed-txt']) await t.test(format, async () => {
    const h = pageHook();
    const available = await h.request('subs-available');
    assert.equal(available.source?.videoId, ORIGINAL_VIDEO);
    assert.equal(available.source?.lang, 'en');
    assert.equal(typeof available.source?.trackId, 'string');
    assert.ok(Number.isSafeInteger(available.source?.revision));
    const captured = { ...available.source };
    const result = await h.request('subtitles', { format, source: captured });
    assert.equal(result.ok, true);
    assert.equal(result.videoId, ORIGINAL_VIDEO);
    assert.deepEqual(JSON.parse(JSON.stringify(result.source)), captured);
    assert.equal(result.text, 'Original speech');
    assert.equal(result.cues[0].start, 1);
    assert.equal(result.cues[0].end, 2);
    assert.equal(result.lang, 'en');
    assert.ok(Number.isSafeInteger(result.reqId));
  });
});

test('all formats reuse an attributed native legacy panel after its initial request endpoint disappeared', async (t) => {
  for (const format of ['srt', 'txt', 'timed-txt']) await t.test(format, async () => {
    const h = pageHook([captionTrack(), captionTrack(ORIGINAL_VIDEO, 'de')]);
    const panel = h.document.createElement('ytd-engagement-panel-section-list-renderer');
    panel.data = attributedLegacyPanel(); h.document.body.append(panel);
    h.fetch = async (url) => response('', url, false);
    const available = await h.request('subs-available');
    const result = await h.request('subtitles', { format, source: available.source });
    assert.equal(result.ok, true, 'the selected footer already binds the ready cues; trigger params are unnecessary for reading them');
    assert.equal(result.videoId, ORIGINAL_VIDEO); assert.equal(result.lang, 'en');
    assert.equal(result.cues.length, 6); assert.equal(result.cues[0].start, 1.2); assert.equal(result.cues[5].start, 16.881);
    assert.deepEqual(JSON.parse(JSON.stringify(result.source)), JSON.parse(JSON.stringify(available.source)));
    assert.equal(h.requests.some(request => request.url.includes('/youtubei/')), false);
  });
});

test('a ready legacy panel still requires an exact selected footer and unique track tuple', async (t) => {
  for (const mismatch of ['video', 'language', 'kind', 'name', 'missing footer', 'two footers', 'ambiguous track']) await t.test(mismatch, async () => {
    const tracks = [captionTrack(), captionTrack(ORIGINAL_VIDEO, 'de')];
    if (mismatch === 'ambiguous track') tracks.push({ ...tracks[0], vssId: '.en.other' });
    const h = pageHook(tracks), panel = h.document.createElement('ytd-engagement-panel-section-list-renderer');
    panel.data = attributedLegacyPanel(mismatch === 'video' ? NEXT_VIDEO : ORIGINAL_VIDEO,
      mismatch === 'language' ? 'de' : 'en', mismatch === 'kind' ? 'asr' : '', mismatch === 'name' ? 'other' : '');
    const transcript = panel.data.content.transcriptRenderer.content.transcriptSearchPanelRenderer;
    if (mismatch === 'missing footer') delete transcript.footer;
    if (mismatch === 'two footers') panel.data.extra = structuredClone(transcript.footer);
    h.document.body.append(panel); h.fetch = async (url) => response('', url, false);
    const available = await h.request('subs-available'), result = await h.request('subtitles', { format: 'srt', source: available.source });
    assert.equal(result.ok, false); assert.equal(result.text, undefined);
  });
});

test('source changes during a ready legacy panel read still reject the result before handoff', async () => {
  const h = pageHook([captionTrack(), captionTrack(ORIGINAL_VIDEO, 'de')]);
  const panel = h.document.createElement('ytd-engagement-panel-section-list-renderer'), data = attributedLegacyPanel();
  Object.defineProperty(panel, 'data', { get() { h.navigate(NEXT_VIDEO); return data; } });
  h.document.body.append(panel); h.fetch = async (url) => response('', url, false);
  const available = await h.request('subs-available'), result = await h.request('subtitles', { format: 'srt', source: available.source });
  assert.equal(result.ok, false); assert.equal(result.text, undefined); assert.match(result.error, /Материал.*изменился/);
});

test('subtitle requests reject missing or mismatching material, language, track and revision snapshots', async (t) => {
  for (const format of ['srt', 'txt', 'timed-txt']) {
    for (const field of ['videoId', 'lang', 'trackId', 'revision', 'missing']) await t.test(`${format}/${field}`, async () => {
      const h = pageHook(), available = await h.request('subs-available');
      const captured = { ...available.source };
      if (field !== 'missing') captured[field] = field === 'revision' ? captured.revision + 1 : 'another source';
      const result = await h.request('subtitles', { format, ...(field === 'missing' ? {} : { source: captured }) });
      assert.equal(result.ok, false, `${format} must reject ${field} before returning a file`);
      assert.equal(result.text, undefined);
      assert.equal(h.requests.length, 0);
    });
  }
});

test('a different selected language cannot take over any pending subtitle format', async (t) => {
  for (const format of ['srt', 'txt', 'timed-txt']) await t.test(format, async () => {
    const h = pageHook(), available = await h.request('subs-available');
    h.fetch = async (url) => {
      h.state.tracks.push(captionTrack(ORIGINAL_VIDEO, 'ru'));
      return response({ events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Original speech' }] }] }, url);
    };
    const result = await h.request('subtitles', { format, source: available.source });
    assert.equal(result.ok, false, 'changed selected language must not return a successful file');
    assert.equal(result.text, undefined);
    assert.match(result.error, /дорожка.*изменилась|Материал.*изменился/);
  });
});

test('a native response started before A to B to A cannot become captions for the new visit', async (t) => {
  for (const format of ['srt', 'txt', 'timed-txt']) await t.test(format, async () => {
    const h = pageHook();
    const oldUrl = h.state.tracks[0].baseUrl;
    let release;
    const oldResponse = new Promise((resolve) => { release = resolve; });
    h.fetch = () => oldResponse;
    const nativeRequest = h.window.fetch(oldUrl);
    h.navigate(NEXT_VIDEO);
    h.navigate(ORIGINAL_VIDEO);
    release(response({ events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Stale speech from the old visit' }] }] }, oldUrl));
    await nativeRequest;
    // The passive response observer reads its own cloned stream asynchronously.
    // Let the completed native response settle before starting the new export.
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.fetch = async (url) => response('', url, false);
    const available = await h.request('subs-available');
    const result = await h.request('subtitles', { format, source: available.source });
    assert.equal(result.ok, false, 'late native response must keep the revision captured at request start');
    assert.equal(result.text, undefined);
  });
});

test('subtitle availability reports only chapter metadata owned by the current video', async () => {
  const h = pageHook();
  assert.equal((await h.request('subs-available')).chaptersAvailable, false);
  h.window.ytInitialData = { currentVideoEndpoint: { watchEndpoint: { videoId: ORIGINAL_VIDEO } },
    chapterRenderer: { timeRangeStartMillis: 0, title: { simpleText: 'Actual intro' } } };
  assert.equal((await h.request('subs-available')).chaptersAvailable, true);
  h.window.ytInitialData.currentVideoEndpoint.watchEndpoint.videoId = NEXT_VIDEO;
  assert.equal((await h.request('subs-available')).chaptersAvailable, false);
});

test('pending subtitle work rejects A to B to A and exact track changes for every format', async (t) => {
  for (const format of ['srt', 'txt', 'timed-txt']) {
    for (const change of ['return to same video', 'named track', 'automatic track', 'different language']) await t.test(`${format}/${change}`, async () => {
      const h = pageHook(), available = await h.request('subs-available');
      h.fetch = async (url) => {
        if (change === 'return to same video') { h.navigate(NEXT_VIDEO); h.navigate(ORIGINAL_VIDEO); }
        if (change === 'named track') h.state.tracks[0].baseUrl += '&name=another';
        if (change === 'automatic track') h.state.tracks[0].kind = 'asr';
        if (change === 'different language') h.state.tracks[0].languageCode = 'de';
        return response({ events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Original speech' }] }] }, url);
      };
      const result = await h.request('subtitles', { format, source: available.source });
      assert.equal(result.ok, false);
      assert.equal(result.text, undefined);
      assert.match(result.error, /Материал.*изменился|дорожка.*изменилась/);
    });
  }
});

test('a menu snapshot from an earlier visit is stale after A to B to A', async () => {
  const h = pageHook(), old = await h.request('subs-available');
  h.navigate(NEXT_VIDEO);
  h.navigate(ORIGINAL_VIDEO);
  const current = await h.request('subs-available');
  assert.notEqual(current.source.revision, old.source.revision);
  const result = await h.request('subtitles', { format: 'srt', source: old.source });
  assert.equal(result.ok, false);
  assert.equal(result.text, undefined);
  assert.equal(h.requests.length, 0);
});

test('a successful native caption response from the same visit keeps its exact video and track attribution', async () => {
  const h = pageHook(), nativeUrl = h.state.tracks[0].baseUrl;
  await h.window.fetch(nativeUrl);
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.fetch = async (url) => response('', url, false);
  const available = await h.request('subs-available');
  const result = await h.request('subtitles', { format: 'srt', source: available.source });
  assert.equal(result.ok, true);
  assert.equal(result.videoId, ORIGINAL_VIDEO);
  assert.equal(result.lang, 'en');
  assert.equal(result.text, 'Original speech');
  assert.equal(result.cues[0].end, 2);
});

test('all formats reject a caption URL attributed to another video, language, kind or translation', async (t) => {
  for (const format of ['srt', 'txt', 'timed-txt']) {
    for (const [field, value] of [['v', NEXT_VIDEO], ['lang', 'de'], ['kind', 'asr'], ['tlang', 'de']]) await t.test(`${format}/${field}`, async () => {
      const selected = captionTrack(), wrongUrl = new URL(selected.baseUrl);
      wrongUrl.searchParams.set(field, value);
      selected.baseUrl = wrongUrl.href;
      const h = pageHook([selected]), available = await h.request('subs-available');
      const result = await h.request('subtitles', { format, source: available.source });
      assert.equal(result.ok, false);
      assert.equal(result.text, undefined);
      assert.equal(h.requests.length, 0);
    });
  }
});

test('a successful caption response redirected to another video cannot be saved as the selected material', async (t) => {
  for (const format of ['srt', 'txt', 'timed-txt']) await t.test(format, async () => {
    const h = pageHook(), available = await h.request('subs-available');
    h.fetch = async () => response({ events: [{ tStartMs: 1453000, dDurationMs: 12161, segs: [{ utf8: 'Foreign speech' }] }] }, captionTrack(NEXT_VIDEO).baseUrl);
    const result = await h.request('subtitles', { format, source: available.source });
    assert.equal(result.ok, false);
    assert.equal(result.text, undefined);
  });
});

test('info exposes a stale player video independently of the current location during SPA navigation', async () => {
  const h = pageHook();
  h.location.searchParams.set('v', NEXT_VIDEO);
  const info = await h.request('info');
  assert.equal(info.videoId, NEXT_VIDEO);
  assert.equal(info.playerVideoId, ORIGINAL_VIDEO);
  assert.equal((await h.request('subs-available')).source, null);
});

test('info keeps actual title and player ownership together when the caption response has already switched videos', async () => {
  const h = pageHook();
  h.location.searchParams.set('v', NEXT_VIDEO);
  h.player.getPlayerResponse = () => ({ videoDetails: { videoId: NEXT_VIDEO, title: 'Next title' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [captionTrack(NEXT_VIDEO)] } } });
  const info = await h.request('info'), available = await h.request('subs-available');
  assert.equal(info.videoId, NEXT_VIDEO);
  assert.equal(info.title, 'Original title');
  assert.equal(info.duration, 19.013);
  assert.equal(available.source.videoId, NEXT_VIDEO, 'caption ownership remains a separate proof');
  assert.equal(info.playerVideoId, ORIGINAL_VIDEO, 'actual player ownership must match the captured title and media');
});

test('a known current audio/video player remains available without captions or streamingData in its partial response', async () => {
  const h = pageHook([]);
  h.media.readyState = 2;
  h.player.getAvailableQualityLevels = () => ['hd720'];
  h.player.getPlayerResponse = () => ({ videoDetails: { videoId: ORIGINAL_VIDEO } });
  const info = await h.request('info'), available = await h.request('subs-available');
  assert.equal(info.videoId, ORIGINAL_VIDEO);
  assert.equal(info.title, 'Original title');
  assert.equal(info.duration, 19.013);
  assert.deepEqual(JSON.parse(JSON.stringify(info.heights)), [720]);
  assert.equal(available.source, null);
  assert.equal(available.available, false, 'missing caption proof cannot become a subtitle source');
  assert.equal(info.playerVideoId, ORIGINAL_VIDEO, 'subtitle availability cannot remove the known audio/video owner');
});

test('info captures actual player owner, title and live flag as one metadata snapshot', async () => {
  const h = pageHook();
  let reads = 0;
  h.player.getVideoData = () => ++reads === 1
    ? { video_id: ORIGINAL_VIDEO, title: 'Original title', isLive: false }
    : { video_id: NEXT_VIDEO, title: 'Next title', isLive: true };
  const info = await h.request('info');
  assert.equal(info.playerVideoId, ORIGINAL_VIDEO);
  assert.equal(info.title, 'Original title');
  assert.equal(info.isLive, false);
});

test('info cannot substitute a caption response for an unknown actual player owner', async () => {
  const h = pageHook();
  h.player.getVideoData = () => ({ title: 'Original title' });
  const info = await h.request('info'), available = await h.request('subs-available');
  assert.equal(available.source.videoId, ORIGINAL_VIDEO);
  assert.equal(info.playerVideoId, null, 'caption source ownership does not establish ownership of actual media metadata');
});

test('a known player without a title uses its video ID instead of the previous page title', async () => {
  const h = pageHook();
  h.navigate(NEXT_VIDEO);
  h.document.title = 'Original title - YouTube';
  h.player.getVideoData = () => ({ video_id: NEXT_VIDEO, title: '' });
  const info = await h.request('info');
  assert.equal(info.playerVideoId, NEXT_VIDEO);
  assert.equal(info.title, NEXT_VIDEO, 'unowned tab metadata must not name the current material');
});

test('info does not attach foreign audio and music metadata to the actual player snapshot', async () => {
  const h = pageHook();
  h.player.getPlayerResponse = () => ({ videoDetails: { videoId: NEXT_VIDEO, musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
    streamingData: { adaptiveFormats: [{ mimeType: 'audio/webm; codecs="opus"', bitrate: 128000 }] } });
  const info = await h.request('info');
  assert.equal(info.playerVideoId, ORIGINAL_VIDEO);
  assert.equal(info.audioSource, null);
  assert.equal(info.musicVideoType, '');
});

test('info preserves codec and music metadata from a response owned by the actual player', async () => {
  const h = pageHook();
  h.player.getPlayerResponse = () => ({ videoDetails: { videoId: ORIGINAL_VIDEO, musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
    streamingData: { adaptiveFormats: [{ mimeType: 'audio/webm; codecs="opus"', bitrate: 128000 }] } });
  const info = await h.request('info');
  assert.equal(info.playerVideoId, ORIGINAL_VIDEO);
  assert.deepEqual(JSON.parse(JSON.stringify(info.audioSource)), { codec: 'opus', bitrateKbps: 128 });
  assert.equal(info.musicVideoType, 'MUSIC_VIDEO_TYPE_ATV');
});

test('info copies owned audio metadata before later caption-source reads can mutate the player response', async () => {
  const h = pageHook();
  const shared = { videoDetails: { videoId: ORIGINAL_VIDEO, musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
    streamingData: { adaptiveFormats: [{ mimeType: 'audio/webm; codecs="opus"', bitrate: 128000 }] } };
  let reads = 0;
  h.player.getPlayerResponse = () => {
    if (++reads > 1) {
      shared.videoDetails.videoId = NEXT_VIDEO;
      shared.streamingData.adaptiveFormats = [{ mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 64000 }];
    }
    return shared;
  };
  const info = await h.request('info');
  assert.equal(info.playerVideoId, ORIGINAL_VIDEO);
  assert.deepEqual(JSON.parse(JSON.stringify(info.audioSource)), { codec: 'opus', bitrateKbps: 128 });
});

test('late replies remain bound to their own request and immutable source even if caller data changes', async () => {
  const h = pageHook(), available = await h.request('subs-available');
  const captured = { ...available.source }, expected = { ...captured };
  let release;
  const pendingFirst = new Promise((resolve) => { release = resolve; });
  let first = true;
  h.fetch = async (url) => {
    if (first) {
      first = false;
      await pendingFirst;
      return response({ events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'First request speech' }] }] }, url);
    }
    return response({ events: [{ tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: 'Second request speech' }] }] }, url);
  };
  const firstRequest = h.request('subtitles', { format: 'srt', source: captured });
  captured.lang = 'de';
  const secondResult = await h.request('subtitles', { format: 'txt', source: expected });
  release();
  const firstResult = await firstRequest;
  assert.equal(firstResult.text, 'First request speech');
  assert.equal(secondResult.text, 'Second request speech');
  assert.notEqual(firstResult.reqId, secondResult.reqId);
  assert.deepEqual(JSON.parse(JSON.stringify(firstResult.source)), expected);
});

test('a unique named caption track keeps its name in the direct fallback request', async () => {
  const h = pageHook([captionTrack(ORIGINAL_VIDEO, 'en', '', 'original')]), available = await h.request('subs-available');
  h.fetch = async (url) => response({ events: [{ tStartMs: 0, dDurationMs: 500, segs: [{ utf8: 'Named speech' }] }] }, url,
    !url.includes('sig=fixture') && new URL(url).searchParams.get('name') === 'original');
  const result = await h.request('subtitles', { format: 'srt', source: available.source });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Named speech');
  assert.equal(result.cues[0].end, 0.5);
});

test('background proxy redirects cannot export another video as the selected material', async (t) => {
  for (const format of ['srt', 'txt', 'timed-txt']) await t.test(format, async () => {
    const h = pageHook(), available = await h.request('subs-available');
    const background = browserContext({ fetch: async () => response({ events: [{ tStartMs: 1000, dDurationMs: 1000,
      segs: [{ utf8: 'Foreign video speech' }] }] }, captionTrack(NEXT_VIDEO).baseUrl) });
    h.fetch = async (url) => response('', url, false);
    h.proxy = (message) => background.message(message);
    const result = await h.request('subtitles', { format, source: available.source });
    assert.equal(result.ok, false, 'the actual background proxy must preserve the response owner receipt');
    assert.equal(result.text, undefined);
  });
});

test('the final background caption receipt cannot contradict language, kind, track name or translation', async (t) => {
  for (const [field, value] of [['lang', 'de'], ['kind', 'asr'], ['name', 'another'], ['tlang', 'de']]) await t.test(field, async () => {
    const h = pageHook(), available = await h.request('subs-available'), finalUrl = new URL(h.state.tracks[0].baseUrl);
    finalUrl.searchParams.set(field, value);
    const background = browserContext({ fetch: async () => response({ events: [{ tStartMs: 1000, dDurationMs: 1000,
      segs: [{ utf8: 'Unverified speech' }] }] }, finalUrl.href) });
    h.fetch = async (url) => response('', url, false);
    h.proxy = (message) => background.message(message);
    const result = await h.request('subtitles', { format: 'srt', source: available.source });
    assert.equal(result.ok, false);
    assert.equal(result.text, undefined);
  });
});

test('a caption descriptor without a language or track code cannot invent an English source', async () => {
  const h = pageHook([{}]), available = await h.request('subs-available');
  assert.equal(available.source, null);
  assert.equal(available.available, false);
  const result = await h.request('subtitles', { format: 'srt', source: available.source });
  assert.equal(result.ok, false);
  assert.equal(result.text, undefined);
  assert.equal(h.requests.length, 0);
});

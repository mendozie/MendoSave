const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const espree = require('espree');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync('extension/content_hook.js', 'utf8');
const declarations = espree.parse(source, { ecmaVersion: 'latest', range: true }).body[0].expression.callee.body.body;
const names = new Set(['captionTracks', 'playerResponse', 'pickTrack', 'getTrackLang', 'getTrackKind',
  'getSubtitles', 'fetchCaptionFromTrack', 'fetchViaBackground', 'tryParse', 'parseJson3', 'parseJson3Cues',
  'parseVttOrSrt', 'parseXmlCues', 'buildCuesFromLines', 'extractTranscriptCuesFromDOM',
  'getTimedSubtitles', 'timedSubtitleTrackUrl', 'timedSubtitleTrackIdentity', 'decodeTimedCaptionEntities', 'buildTimedTranscriptResult',
  'fetchTimedInnertube', 'decodeTimedTranscriptParams', 'timedTranscriptTuple', 'findTimedTranscriptParams', 'parseTimedInnertube', 'walkTimedMetadata', 'getTimedPanelSubtitles',
  'rememberTimedText', 'snapshotTimedCaptionSource', 'readRememberedTimedCaptions', 'triggerTimedPlayerCaptions', 'timedPlayerTrackMatches', 'inspectFetchResponse', 'isTimedCaptionRequest',
  'decodeModernTranscriptVideo', 'findModernTranscriptRequest', 'modernTranscriptTrackCurrent', 'parseModernTimedTranscript', 'fetchModernTimedTranscript', 'readOwnedTimedChapters']);
const flow = declarations.filter((node) => node.type === 'FunctionDeclaration' && names.has(node.id.name))
  .map((node) => source.slice(...node.range)).join('\n');
const bridge = declarations.find((node) => node.type === 'ExpressionStatement'
  && source.slice(...node.range).includes("else if (cmd === 'subtitles')"));

const track = (languageCode, kind = '', name = '') => ({ languageCode, kind,
  vssId: `${kind === 'asr' ? 'a' : ''}.${languageCode}${name ? '.' + name : ''}`,
  baseUrl: `https://www.youtube.com/api/timedtext?v=fixture01&lang=${languageCode}${kind ? '&kind=' + kind : ''}${name ? '&name=' + name : ''}&sig=fixture`,
});
const payload = (text = 'Русская реплика.') => JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 1250, segs: [{ utf8: text }] }] });

function harness(tracks = [track('ru'), track('en')]) {
  const { window, document } = parseHTML('<html><body><transcript-segment-view-model><span class="ytwTranscriptSegmentViewModelTimestamp">0:02</span><span role="text">English caption</span></transcript-segment-view-model></body></html>');
  // linkedom delegates undeclared window properties to the Node global.
  // Each fixture represents a fresh page and must own an empty response ring.
  window.__mendosave_captured_timedtext = [];
  window.__mendosave_captured_timedtext_sources = [];
  let videoId = 'fixture01';
  let reply;
  const requests = [], proxyRequests = [], fallbacks = [];
  const player = { getPlayerResponse: () => ({ videoDetails: { videoId, lengthSeconds: '10' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } }) };
  const location = new URL('https://www.youtube.com/watch?v=fixture01');
  window.postMessage = (message) => reply?.(message);
  const context = vm.createContext({ document, window, location, URL, URLSearchParams, TextDecoder, atob, Node: window.Node,
    getInnertubeCfg: () => null, navigator: { language: 'en' }, sleep: async () => {}, rememberTranscriptParams() {},
    MendoCaptions: require('../extension/captions.js'),
    player: () => player, video: () => ({ duration: 10 }), vidId: () => videoId,
    log() {}, closeTranscriptPanelIfOpen() {},
    fetch: async (url, options) => { requests.push({ url, credentials: options.credentials }); return { ok: true, text: async () => payload() }; },
    sendToBackground: async (message) => { proxyRequests.push(message); return { ok: true, text: payload() }; },
    fetchViaInnertube: async () => { fallbacks.push('innertube'); return { parsed: { lang: 'ru', lines: ['Unknown transcript'], cues: [{ start: 2, text: 'Unknown transcript' }] } }; },
    triggerPlayerCaptions: async () => { fallbacks.push('player'); return { lines: ['Unknown player'], cues: [{ start: 2, text: 'Unknown player' }] }; },
    getSubtitlesViaPanel: async () => { fallbacks.push('panel'); return { lines: ['Unknown panel'], cues: [{ start: 2, text: 'Unknown panel' }] }; },
  });
  vm.runInContext(flow, context);
  vm.runInContext(`const TO_HOOK = '__mendosave_to_hook', FROM_HOOK = '__mendosave_from_hook'; ${source.slice(...bridge.range)}`, context);
  return { context, document, window, tracks, player, requests, proxyRequests, fallbacks,
    navigate(id) { videoId = id; },
    requestTimed() {
      return new Promise((resolve) => {
        reply = resolve;
        const event = new window.Event('message');
        event.source = window; event.origin = location.origin;
        event.data = { __mendosave_to_hook: true, reqId: 1, cmd: 'subtitles', format: 'timed-txt' };
        window.dispatchEvent(event);
      });
    },
  };
}

test('timed TXT fetches the selected Russian track instead of relabelling an open English transcript', async () => {
  const h = harness();
  const result = await h.context.getSubtitles(true);
  assert.equal(result.text, 'Русская реплика.');
  assert.equal(result.lang, 'ru');
  assert.equal(h.requests[0].url, h.tracks[0].baseUrl);
  assert.equal(result.cues[0].start, 1);
});

function transcriptParams(videoId, lang, kind = '', name = '') {
  const string = (field, value) => { const bytes = Buffer.from(value); return Buffer.concat([Buffer.from([field * 8 + 2, bytes.length]), bytes]); };
  const selector = Buffer.concat([string(1, kind), string(2, lang), string(3, name)]).toString('base64');
  return Buffer.concat([string(1, videoId), string(2, encodeURIComponent(selector))]).toString('base64');
}
function transcriptResponse(params, text = 'Actual selected speech') {
  return { actions: [{ updateEngagementPanelAction: { content: { transcriptRenderer: { content: {
    transcriptSearchPanelRenderer: {
      body: { transcriptSegmentListRenderer: { initialSegments: [{ transcriptSegmentRenderer: { startMs: '1250', endMs: '2500', snippet: { runs: [{ text }] } } }] } },
      footer: { transcriptFooterRenderer: { languageMenu: { sortFilterSubMenuRenderer: { subMenuItems: [{ selected: true, title: 'English', continuation: { getTranscriptEndpoint: { params } } }] } } } },
    },
  } } } } }] };
}

test('timed TXT falls back to a fresh exact attributed Innertube endpoint when timedtext is unavailable', async () => {
  const h = harness([track('en')]);
  const params = transcriptParams('fixture01', 'en');
  h.window.ytInitialData = { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params } } } };
  h.context.fetch = async (url, options) => {
    h.requests.push({ url, options });
    return url.includes('/youtubei/') ? { ok: true, text: async () => JSON.stringify(transcriptResponse(params, 'Hello <literal> &amp;\n🙂')) } : { ok: false, status: 403 };
  };
  h.context.sendToBackground = async () => ({ ok: false });
  const result = await h.context.getSubtitles(true);
  assert.equal(result.text, 'Hello <literal> &amp;\n🙂');
  assert.equal(result.cues[0].start, 1.25);
  assert.equal(result.lang, 'en');
  assert.equal(JSON.parse(h.requests.find(({ url }) => url.includes('/youtubei/')).options.body).params, params);
});

test('Innertube fallback rejects contradictory selected language or automatic caption metadata', async (t) => {
  for (const [lang, kind] of [['ru', ''], ['en', 'asr']]) await t.test(`${lang}/${kind}`, async () => {
    const h = harness([track('en'), track('ru'), track('en', 'asr')]);
    const params = transcriptParams('fixture01', 'en');
    h.window.ytInitialData = { getTranscriptEndpoint: { params } };
    h.context.fetch = async (url) => url.includes('/youtubei/')
      ? { ok: true, text: async () => JSON.stringify(transcriptResponse(transcriptParams('fixture01', lang, kind))) }
      : { ok: false, status: 403 };
    h.context.sendToBackground = async () => ({ ok: false });
    // The default picker prioritizes Russian; force the exact selected English choice.
    h.context.pickTrack = () => h.tracks[0];
    await assert.rejects(h.context.getSubtitles(true), /выбранную дорожку/);
  });
});

test('Innertube endpoint binding rejects old video, unknown selector, mismatching track name and ambiguous tuple', async (t) => {
  const cases = [
    { label: 'old video', tracks: [track('en')], params: transcriptParams('oldVideo', 'en') },
    { label: 'unknown schema', tracks: [track('en')], params: Buffer.from('fixture01 en').toString('base64') },
    { label: 'other named track', tracks: [track('en', '', 'first'), track('en', '', 'second')], params: transcriptParams('fixture01', 'en', '', 'second') },
    { label: 'indistinguishable tracks', tracks: [track('en'), { ...track('en'), vssId: '.en.second' }], params: transcriptParams('fixture01', 'en') },
  ];
  for (const value of cases) await t.test(value.label, async () => {
    const h = harness(value.tracks);
    h.window.ytInitialData = { getTranscriptEndpoint: { params: value.params } };
    h.context.fetch = async (url) => { h.requests.push({ url }); return { ok: false, status: 403 }; };
    h.context.sendToBackground = async () => ({ ok: false });
    await assert.rejects(h.context.getSubtitles(true), /выбранную дорожку/);
    assert.ok(h.requests.every(({ url }) => !url.includes('/youtubei/')));
  });
});

test('fresh Innertube fallback preserves exact named manual and automatic track choices', async (t) => {
  for (const kind of ['', 'asr']) await t.test(kind || 'manual', async () => {
    const h = harness([track('en', kind, 'first'), track('en', kind, 'second')]);
    const params = transcriptParams('fixture01', 'en', kind, 'first');
    h.window.ytInitialData = { getTranscriptEndpoint: { params } };
    h.context.fetch = async (url) => url.includes('/youtubei/')
      ? { ok: true, text: async () => JSON.stringify(transcriptResponse(params)) }
      : { ok: false, status: 403 };
    h.context.sendToBackground = async () => ({ ok: false });
    assert.equal((await h.context.getSubtitles(true)).text, 'Actual selected speech');
  });
});

test('navigation during fresh Innertube response rejects its old cues', async () => {
  const h = harness([track('en')]);
  const params = transcriptParams('fixture01', 'en');
  h.window.ytInitialData = { getTranscriptEndpoint: { params } };
  h.context.fetch = async (url) => {
    if (!url.includes('/youtubei/')) return { ok: false, status: 403 };
    h.document.dispatchEvent(new h.window.Event('yt-navigate-start'));
    return { ok: true, text: async () => JSON.stringify(transcriptResponse(params)) };
  };
  h.context.sendToBackground = async () => ({ ok: false });
  await assert.rejects(h.context.getSubtitles(true), /Материал.*изменился/);
});

test('Innertube parser rejects invalid and missing actual times and bounds metadata/text', () => {
  const h = harness([track('en')]);
  const params = transcriptParams('fixture01', 'en');
  const tuple = ['fixture01', 'en', '', ''];
  for (const startMs of [undefined, 'x', '-1', '123abc', Infinity]) {
    const response = transcriptResponse(params);
    const segment = response.actions[0].updateEngagementPanelAction.content.transcriptRenderer.content.transcriptSearchPanelRenderer.body.transcriptSegmentListRenderer.initialSegments[0].transcriptSegmentRenderer;
    segment.startMs = startMs;
    assert.equal(h.context.parseTimedInnertube(response, tuple), null);
  }
  assert.equal(h.context.parseTimedInnertube(transcriptResponse(params, 'x'.repeat(65537)), tuple), null);
  let deep = transcriptResponse(params);
  for (let index = 0; index < 66; index++) deep = { deep };
  assert.equal(h.context.parseTimedInnertube(deep, tuple), null);
  assert.equal(h.context.decodeTimedTranscriptParams('x'.repeat(8193)), null);
});

test('selected footer reload continuation proves the same exact video and caption selector', () => {
  const h = harness([track('en')]), params = transcriptParams('fixture01', 'en');
  const response = transcriptResponse(params);
  const selected = response.actions[0].updateEngagementPanelAction.content.transcriptRenderer.content.transcriptSearchPanelRenderer.footer.transcriptFooterRenderer.languageMenu.sortFilterSubMenuRenderer.subMenuItems[0];
  selected.continuation = { reloadContinuationData: { continuation: params } };
  assert.equal(h.context.parseTimedInnertube(response, ['fixture01', 'en', '', ''], true)?.lines[0], 'Actual selected speech');
  selected.continuation.reloadContinuationData.continuation = transcriptParams('fixture01', 'en', 'asr');
  assert.equal(h.context.parseTimedInnertube(response, ['fixture01', 'en', '', ''], true), null);
  selected.continuation.getTranscriptEndpoint = { params };
  assert.equal(h.context.parseTimedInnertube(response, ['fixture01', 'en', '', ''], true), null);
});

test('native transcript fallback consumes attributed structured panel cues after exact resolveCommand', async () => {
  const h = harness([track('en')]), params = transcriptParams('fixture01', 'en');
  h.window.ytInitialData = { getTranscriptEndpoint: { params } };
  const app = h.document.createElement('ytd-app'), panel = h.document.createElement('ytd-engagement-panel-section-list-renderer');
  h.document.body.append(app, panel);
  let command;
  app.resolveCommand = (value) => { command = value; panel.data = transcriptResponse(params, 'Native selected speech'); };
  h.context.fetch = async () => ({ ok: false, status: 400 });
  h.context.sendToBackground = async () => ({ ok: false });
  const result = await h.context.getSubtitles(true);
  assert.equal(result.text, 'Native selected speech');
  assert.equal(command.getTranscriptEndpoint.params, params);
});

test('native panel requires exact selected footer even when unknown DOM and structured cues exist', async () => {
  const h = harness([track('en')]), params = transcriptParams('fixture01', 'en');
  h.window.ytInitialData = { getTranscriptEndpoint: { params } };
  const panel = h.document.createElement('ytd-engagement-panel-section-list-renderer');
  panel.data = { transcriptSegmentRenderer: { startMs: '1000', endMs: '2000', snippet: { simpleText: 'Unattributed panel' } } };
  h.document.body.append(panel);
  h.context.fetch = async () => ({ ok: false, status: 400 });
  h.context.sendToBackground = async () => ({ ok: false });
  await assert.rejects(h.context.getSubtitles(true), /выбранную дорожку/);
});

test('native fallback reveals the exact continuation panel so on-item-shown transport can load it', async () => {
  const h = harness([track('en')]), params = transcriptParams('fixture01', 'en');
  const app = h.document.createElement('ytd-app'), panel = h.document.createElement('ytd-engagement-panel-section-list-renderer');
  panel.data = { targetId: 'engagement-panel-searchable-transcript', visibility: 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN',
    content: { continuationItemRenderer: { trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN', continuationEndpoint: { getTranscriptEndpoint: { params } } } } };
  h.document.body.append(app, panel);
  const commands = [];
  app.resolveCommand = (value) => {
    commands.push(value);
    if (value.changeEngagementPanelVisibilityAction?.targetId === panel.data.targetId) panel.data = transcriptResponse(params, 'Loaded by native shown continuation');
  };
  h.context.fetch = async () => ({ ok: false, status: 400 });
  h.context.sendToBackground = async () => ({ ok: false });
  assert.equal((await h.context.getSubtitles(true)).text, 'Loaded by native shown continuation');
  assert.equal(commands[0].changeEngagementPanelVisibilityAction.targetId, 'engagement-panel-searchable-transcript');
  assert.equal(commands[0].changeEngagementPanelVisibilityAction.visibility, 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
});

test('native player fallback uses the selected full track and accepts only its observed successful response', async () => {
  const h = harness([track('en'), track('de')]);
  h.context.fetch = async () => ({ ok: false, status: 400 });
  h.context.sendToBackground = async () => ({ ok: false });
  let chosen;
  h.player.setOption = (_module, _option, value) => {
    chosen = value;
    h.context.rememberTimedText(payload('Native exact English'), h.tracks[0].baseUrl + '&fmt=json3', { videoId: 'fixture01', playerVideoId: 'fixture01' }, true);
  };
  h.player.getOption = () => chosen;
  assert.equal((await h.context.getSubtitles(true)).text, 'Native exact English');
  assert.equal(chosen.vssId, h.tracks[0].vssId);
  assert.equal(chosen.baseUrl, h.tracks[0].baseUrl);
});

test('remembered response provenance rejects mismatching manual/auto, named tracks, translation and stale source', async (t) => {
  const cases = [
    { label: 'other language', url: track('de').baseUrl },
    { label: 'automatic instead of manual', url: track('en', 'asr').baseUrl },
    { label: 'other named track', url: track('en', '', 'second').baseUrl },
    { label: 'translation', url: track('en', '', 'first').baseUrl + '&tlang=de' },
    { label: 'old material snapshot', url: track('en', '', 'first').baseUrl, source: { videoId: 'oldVideo', playerVideoId: 'oldVideo' } },
    { label: 'failed response', url: track('en', '', 'first').baseUrl, ok: false },
  ];
  for (const value of cases) await t.test(value.label, async () => {
    const h = harness([track('en', '', 'first'), track('en', '', 'second')]);
    h.context.fetch = async () => ({ ok: false, status: 400 });
    h.context.sendToBackground = async () => ({ ok: false });
    h.context.rememberTimedText(payload('Unverified caption'), value.url, value.source || { videoId: 'fixture01', playerVideoId: 'fixture01' }, value.ok !== false);
    await assert.rejects(h.context.getSubtitles(true), /выбранную дорожку/);
  });
});

test('fetch response observer retains original URL/source proof and keeps legacy strings', async () => {
  const h = harness([track('en')]);
  const raw = payload('Captured original response');
  const snapshot = h.context.snapshotTimedCaptionSource();
  await h.context.inspectFetchResponse({ ok: true, url: h.tracks[0].baseUrl + '&fmt=json3', clone: () => ({ text: async () => raw }) }, h.tracks[0].baseUrl, snapshot);
  assert.equal(h.window.__mendosave_captured_timedtext[0], raw);
  assert.equal((await h.context.getSubtitles(true)).text, 'Captured original response');
  assert.equal(h.requests.length, 0);
  const entry = h.window.__mendosave_captured_timedtext_sources[0];
  assert.equal(entry.url, h.tracks[0].baseUrl + '&fmt=json3');
  assert.equal(entry.videoId, 'fixture01');
  assert.equal(entry.playerVideoId, 'fixture01');
});

test('observer classifies actual relative timedtext requests and rejects lookalike URLs', async () => {
  const h = harness([track('en')]), url = '/api/timedtext?v=fixture01&lang=en';
  await h.context.inspectFetchResponse({ ok: true, url: 'https://www.youtube.com' + url, clone: () => ({ text: async () => payload('Relative native response') }) }, url, h.context.snapshotTimedCaptionSource());
  assert.equal((await h.context.getSubtitles(true)).text, 'Relative native response');
  h.window.__mendosave_captured_timedtext_sources = [];
  await h.context.inspectFetchResponse({ ok: true, url: 'https://attacker.test/youtube.com/api/timedtext?v=fixture01&lang=en', clone: () => ({ text: async () => payload('Lookalike response') }) }, 'https://attacker.test/youtube.com/api/timedtext?v=fixture01&lang=en', h.context.snapshotTimedCaptionSource());
  assert.equal(h.context.readRememberedTimedCaptions(h.tracks[0], h.tracks, 'fixture01'), null);
});

test('observer source snapshot rejects response after navigation and unsuccessful HTTP status', async () => {
  const h = harness([track('en')]), snapshot = h.context.snapshotTimedCaptionSource();
  h.navigate('otherVideo');
  const response = { ok: true, url: h.tracks[0].baseUrl, clone: () => ({ text: async () => payload('Old source response') }) };
  await h.context.inspectFetchResponse(response, h.tracks[0].baseUrl, snapshot);
  assert.equal(h.window.__mendosave_captured_timedtext_sources.length, 0);
  h.navigate('fixture01');
  await h.context.inspectFetchResponse({ ...response, ok: false }, h.tracks[0].baseUrl, snapshot);
  assert.equal(h.window.__mendosave_captured_timedtext_sources.length, 0);
  assert.equal(h.window.__mendosave_captured_timedtext.length, 2);
});

test('caption provenance ring is bounded by entries and UTF16 storage bytes', () => {
  const h = harness([track('en')]), snapshot = h.context.snapshotTimedCaptionSource();
  for (let index = 0; index < 25; index++) h.context.rememberTimedText(payload(`Caption ${index}`), h.tracks[0].baseUrl, snapshot, true);
  assert.equal(h.window.__mendosave_captured_timedtext_sources.length, 20);
  h.window.__mendosave_captured_timedtext_sources = [];
  const large = 'x'.repeat(1536 * 1024);
  for (let index = 0; index < 3; index++) h.context.rememberTimedText(large, h.tracks[0].baseUrl, snapshot, true);
  assert.equal(h.window.__mendosave_captured_timedtext_sources.length, 2);
  assert.ok(h.window.__mendosave_captured_timedtext_sources.reduce((sum, entry) => sum + (entry.url.length + entry.text.length) * 2, 0) <= 8 * 1024 * 1024);
});

test('native player must confirm the selected track rather than an unknown or automatic track', async (t) => {
  for (const actual of [{}, track('en', 'asr'), track('en', '', 'other')]) await t.test(JSON.stringify(actual), async () => {
    const h = harness([track('en')]);
    h.context.fetch = async () => ({ ok: false, status: 400 });
    h.context.sendToBackground = async () => ({ ok: false });
    h.player.setOption = () => h.context.rememberTimedText(payload('Unexpected caption'), h.tracks[0].baseUrl, h.context.snapshotTimedCaptionSource(), true);
    h.player.getOption = () => actual;
    await assert.rejects(h.context.getSubtitles(true), /выбранную дорожку/);
  });
});

test('native player confirmation distinguishes caption name and refuses ambiguous name-free metadata', () => {
  const h = harness([track('en', '', 'first'), track('en', '', 'second')]);
  assert.equal(h.context.timedPlayerTrackMatches({ languageCode: 'en', kind: '', name: 'second' }, h.tracks[0], h.tracks, 'fixture01'), false);
  assert.equal(h.context.timedPlayerTrackMatches({ languageCode: 'en', kind: '' }, h.tracks[0], h.tracks, 'fixture01'), false);
  assert.equal(h.context.timedPlayerTrackMatches({ languageCode: 'en', kind: '', name: 'first' }, h.tracks[0], h.tracks, 'fixture01'), true);
  assert.equal(h.context.timedPlayerTrackMatches({ languageCode: 'en', kind: '', name: 'first', vss_id: h.tracks[0].vssId }, h.tracks[0], h.tracks, 'fixture01'), true);
});

test('same-language distinct tracks cannot fall back to an ambiguous language-only timedtext request', async () => {
  const h = harness([track('ru', '', 'first'), track('ru', '', 'second')]);
  h.context.fetch = async (url) => { h.requests.push({ url }); return { ok: !url.includes('sig=fixture'), text: async () => payload('Generic Russian track') }; };
  h.context.sendToBackground = async (message) => { h.proxyRequests.push(message); return { ok: false }; };
  await assert.rejects(h.context.getSubtitles(true), /выбранную дорожку/);
  assert.ok(h.requests.every(({ url }) => url === h.tracks[0].baseUrl));
  assert.ok(h.proxyRequests.every(({ url }) => url === h.tracks[0].baseUrl));
});

test('navigation during a timed track request rejects the old material instead of returning its captions', async () => {
  const h = harness();
  h.context.fetch = async () => { h.navigate('otherVideo'); return { ok: true, text: async () => payload() }; };
  await assert.rejects(h.context.getSubtitles(true), /Материал.*изменился/);
});

test('missing event times are unavailable timed cues rather than invented zero timestamps', async () => {
  const h = harness([track('ru')]);
  const untimed = JSON.stringify({ events: [{ segs: [{ utf8: 'Untimed caption' }] }] });
  h.context.fetch = async () => ({ ok: true, text: async () => untimed });
  h.context.sendToBackground = async () => ({ ok: true, text: untimed });
  await assert.rejects(h.context.getSubtitles(true), /реальными таймкодами/);
});

test('optional chapter traversal failure delivers actual timed speech with explicit unavailable chapters status', async () => {
  const h = harness();
  h.context.MendoCaptions = { ...require('../extension/captions.js'), readChapters() { throw new RangeError('Chapter metadata traversal limit exceeded'); } };
  const result = await h.requestTimed();
  assert.equal(result.ok, true);
  assert.equal(result.timedText, '[00:01] Русская реплика.\n');
  assert.equal(result.chaptersUnavailable, true);
});

test('timed track choice distinguishes manual captions from automatic captions among multiple languages', async (t) => {
  const cases = [
    { tracks: [track('ru', 'asr'), track('ru'), track('en')], selected: 1, speech: 'Ручная расшифровка.' },
    { tracks: [track('en'), track('ru', 'asr')], selected: 1, speech: 'Автоматическая расшифровка.' },
  ];
  for (const value of cases) await t.test(value.speech, async () => {
    const h = harness(value.tracks);
    h.context.fetch = async (url) => { h.requests.push({ url }); return { ok: true, text: async () => payload(value.speech) }; };
    const result = await h.context.getSubtitles(true);
    assert.equal(result.text, value.speech);
    assert.equal(h.requests[0].url, value.tracks[value.selected].baseUrl);
    assert.equal(new URL(h.requests[0].url).searchParams.get('kind') || '', value.tracks[value.selected].kind);
  });
});

test('a unique requested video/language/kind tuple retains direct timedtext fallback', async () => {
  const h = harness([track('ru', 'asr'), track('en')]);
  h.context.fetch = async (url) => { h.requests.push({ url }); return { ok: !url.includes('sig=fixture'), text: async () => payload('Automatic direct track') }; };
  const result = await h.context.getSubtitles(true);
  assert.equal(result.text, 'Automatic direct track');
  assert.equal(h.requests[1].url, 'https://www.youtube.com/api/timedtext?v=fixture01&lang=ru&kind=asr&fmt=json3');
});

test('exact signed selected track remains usable through background proxy retries', async () => {
  const h = harness([track('ru', '', 'first'), track('ru', '', 'second')]);
  h.context.fetch = async (url, options) => { h.requests.push({ url, credentials: options.credentials }); return { ok: false, status: 403 }; };
  const result = await h.context.getSubtitles(true);
  assert.equal(result.text, 'Русская реплика.');
  assert.deepEqual(h.requests.map(({ credentials }) => credentials), ['omit', 'include']);
  assert.equal(h.proxyRequests[0].url, h.tracks[0].baseUrl);
});

test('failed selected-track requests cannot relabel unknown DOM, player or panel text, even with one listed language', async () => {
  const h = harness([track('ru')]);
  h.context.fetch = async (url) => { h.requests.push({ url }); return { ok: false, status: 403 }; };
  h.context.sendToBackground = async (message) => { h.proxyRequests.push(message); return { ok: false }; };
  await assert.rejects(h.context.getSubtitles(true), /Язык и версия открытой расшифровки не подтверждены/);
  assert.deepEqual(h.fallbacks, []);
  assert.ok(h.requests.length > 0 && h.proxyRequests.length > 0);
});

test('stale, mismatching and translated caption URLs cannot bind a selected original track', async (t) => {
  const variants = [
    ['old video', 'v=fixture01', 'v=oldVideo'],
    ['other language', 'lang=ru', 'lang=en'],
    ['other kind', 'lang=ru', 'lang=ru&kind=asr'],
    ['translated', 'lang=ru', 'lang=ru&tlang=en'],
  ];
  for (const [label, before, after] of variants) await t.test(label, async () => {
    const selected = track('ru'); selected.baseUrl = selected.baseUrl.replace(before, after);
    const h = harness([selected]);
    await assert.rejects(h.context.getSubtitles(true), /выбранную дорожку/);
    assert.equal(h.requests.length + h.proxyRequests.length, 0);
  });
});

test('stale player material and track changes during a request are rejected', async (t) => {
  await t.test('stale player response', async () => {
    const h = harness();
    h.player.getPlayerResponse = () => ({ videoDetails: { videoId: 'oldVideo' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: h.tracks } } });
    await assert.rejects(h.context.getSubtitles(true), /подтвердить материал/);
    assert.equal(h.requests.length, 0);
  });
  await t.test('selected track changed', async () => {
    const h = harness();
    h.context.fetch = async () => { h.tracks[0].baseUrl += '&name=changed'; return { ok: true, text: async () => payload() }; };
    await assert.rejects(h.context.getSubtitles(true), /дорожка субтитров изменилась/);
  });
  await t.test('navigate away and return', async () => {
    const h = harness();
    h.context.fetch = async () => { h.document.dispatchEvent(new h.window.Event('yt-navigate-start')); return { ok: true, text: async () => payload() }; };
    await assert.rejects(h.context.getSubtitles(true), /Материал.*изменился/);
  });
});

test('ordinary subtitle path retains its open-DOM behavior', async () => {
  const h = harness();
  const result = await h.context.getSubtitles(false);
  assert.equal(result.text, 'English caption');
  assert.equal(h.requests.length, 0);
});

test('timed JSON segments retain literal text and line breaks without inserted spaces or entity decoding', async () => {
  const h = harness();
  const text = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Привет ' }, { utf8: '<A> &lt;\n🙂' }] }] });
  h.context.fetch = async () => ({ ok: true, text: async () => text });
  const result = await h.requestTimed();
  assert.equal(result.ok, true);
  assert.equal(result.timedText, '[00:00] Привет <A> &lt;\n🙂\n');
  assert.equal(result.chaptersUnavailable, false);
});

test('invalid or missing XML/VTT timestamps cannot produce synthetic timed speech', async (t) => {
  const values = ['<transcript><text dur="1">Untimed</text></transcript>',
    '<transcript><text start="bad" dur="1">Invalid</text></transcript>',
    '<transcript><text begin="00:61:00" dur="1">Invalid minutes</text></transcript>',
    'WEBVTT\n\n00:61:00.000 --> 00:61:01.000\nInvalid minutes\n'];
  for (const value of values) await t.test(value.slice(0, 45), async () => {
    const h = harness([track('ru')]);
    h.context.fetch = async () => ({ ok: true, text: async () => value });
    h.context.sendToBackground = async () => ({ ok: true, text: value });
    await assert.rejects(h.context.getSubtitles(true), /реальными таймкодами/);
  });
});

test('optional chapter fallback does not mask caption formatting failure', async () => {
  const h = harness();
  h.context.MendoCaptions = { ...require('../extension/captions.js'), readChapters() { throw new RangeError('Chapter limit'); },
    formatTimedTranscript() { throw new RangeError('Caption text limit'); } };
  const result = await h.requestTimed();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Caption text limit');
});

test('timed XML decodes entities once and preserves literal caption whitespace and Unicode', async () => {
  const h = harness();
  const xml = '<transcript><text start="0" dur="1"> A &amp;lt; &amp; &lt;tag&gt;\nПривет &#x1F642;</text></transcript>';
  h.context.fetch = async () => ({ ok: true, text: async () => xml });
  const result = await h.requestTimed();
  assert.equal(result.timedText, '[00:00]  A &lt; & <tag>\nПривет 🙂\n');
});

function modernRequest(videoId = 'fixture01') {
  const bytes = Buffer.from(videoId);
  const nested = Buffer.concat([Buffer.from([10, bytes.length]), bytes, Buffer.from([24, 1])]);
  return { updateEngagementPanelContentCommand: {
    contentSourcePanelIdentifier: { surface: 'ENGAGEMENT_PANEL_SURFACE_WATCH', tag: 'PAmodern_transcript_view' },
    globalConfiguration: { params: Buffer.concat([Buffer.from([170, 9, nested.length]), nested]).toString('base64') },
  } };
}
function modernResponse(videoId = 'fixture01', text = ' Actual <literal> &amp;\n🙂') {
  return { content: { engagementPanelSectionListRenderer: {
    identifier: { surface: 'ENGAGEMENT_PANEL_SURFACE_WATCH', tag: 'PAmodern_transcript_view' },
    content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ macroMarkersPanelItemViewModel: {
      panelId: 'PAmodern_transcript_view',
      item: { timelineItemViewModel: { contentItems: [{ transcriptSegmentViewModel: { simpleText: text, timestamp: '0:01' } }] } },
      onTap: { innertubeCommand: { watchEndpoint: { videoId, startTimeSeconds: 1 } } },
    } }] } }] } },
  } } };
}

test('timed hook exports actual fresh modern chapter headings without first opening the native panel', async () => {
  const h = harness([track('en', 'asr')]), body = modernResponse();
  const section = body.content.engagementPanelSectionListRenderer.content.sectionListRenderer.contents[0].itemSectionRenderer;
  section.header = { macroMarkersPanelItemViewModel: {
    panelId: 'PAmodern_transcript_view', item: { timelineChapterViewModel: { title: 'Chapter 1: Actual <intro>' } },
    onTap: { innertubeCommand: { watchEndpoint: { videoId: 'fixture01', startTimeSeconds: 0 } } },
  } };
  setupModern(h, body);
  const result = await h.requestTimed();
  assert.equal(result.ok, true);
  assert.equal(result.timedText, '[00:00] Chapter 1: Actual <intro>\n\n[00:01]  Actual <literal> &amp;\n🙂\n');
  assert.equal(result.attribution, 'unique-native-caption-track');
});

test('fresh modern cues retain available real initial chapters when the native panel response has no chapter headers', async () => {
  const h = harness([track('en', 'asr')]); setupModern(h);
  h.window.ytInitialData.currentVideoEndpoint = { watchEndpoint: { videoId: 'fixture01' } };
  h.window.ytInitialData.chapterRenderer = { timeRangeStartMillis: 0, title: { simpleText: 'Actual initial chapter' } };
  const result = await h.requestTimed();
  assert.equal(result.ok, true);
  assert.equal(result.timedText, '[00:00] Actual initial chapter\n\n[00:01]  Actual <literal> &amp;\n🙂\n');
});

test('fresh modern cues cannot import retained SPA initial metadata or unknown old DOM chapter headings', async () => {
  const h = harness([track('en', 'asr')]); setupModern(h);
  h.window.ytInitialData.currentVideoEndpoint = { watchEndpoint: { videoId: 'oldVideo' } };
  h.window.ytInitialData.chapterRenderer = { timeRangeStartMillis: 0, title: { simpleText: 'Old video chapter' } };
  h.document.body.insertAdjacentHTML('beforeend', '<ytd-transcript-section-header-renderer><span class="segment-timestamp">0:00</span><span class="segment-text">Old DOM chapter</span></ytd-transcript-section-header-renderer>');
  const result = await h.requestTimed();
  assert.equal(result.ok, true);
  assert.equal(result.timedText, '[00:01]  Actual <literal> &amp;\n🙂\n');
});

test('chapter fallback uses only DOM markers whose own structured endpoints prove the current video', () => {
  const h = harness([track('en')]);
  h.document.body.insertAdjacentHTML('beforeend', '<section target-id="engagement-panel-description-chapters"><ytd-macro-markers-list-item-renderer id="old"></ytd-macro-markers-list-item-renderer><ytd-macro-markers-list-item-renderer id="current"></ytd-macro-markers-list-item-renderer></section>');
  h.document.querySelector('#old').data = { title: { simpleText: 'Old DOM chapter' }, onTap: { watchEndpoint: { videoId: 'oldVideo', startTimeSeconds: 0 } } };
  h.document.querySelector('#current').data = { title: { simpleText: 'Actual DOM chapter' }, onTap: { watchEndpoint: { videoId: 'fixture01', startTimeSeconds: 0 } } };
  const result = h.context.buildTimedTranscriptResult({ videoId: 'fixture01', cues: [{ start: 1, text: 'Speech' }] }, 10);
  assert.equal(result.timedText, '[00:00] Actual DOM chapter\n\n[00:01] Speech\n');
});

test('fresh exact legacy transcript chapter metadata remains owned without current initial or DOM chapters', async () => {
  const h = harness([track('en')]), params = transcriptParams('fixture01', 'en'), body = transcriptResponse(params, 'Speech');
  h.window.ytInitialData = { currentVideoEndpoint: { watchEndpoint: { videoId: 'oldVideo' } }, getTranscriptEndpoint: { params } };
  body.header = { transcriptSectionHeaderRenderer: { startMs: '0', title: { simpleText: 'Actual fresh chapter' } } };
  h.context.fetch = async url => url.includes('/get_transcript') ? { ok: true, text: async () => JSON.stringify(body) } : { ok: false };
  h.context.sendToBackground = async () => ({ ok: false });
  const result = await h.requestTimed();
  assert.equal(result.ok, true);
  assert.equal(result.timedText, '[00:00] Actual fresh chapter\n\n[00:01.250] Speech\n');
});
function setupModern(h, body = modernResponse()) {
  h.window.ytInitialData = modernRequest();
  h.player.getOption = () => ({ ...h.tracks[0], name: '', translationLanguage: null });
  h.context.getInnertubeCfg = (key) => key === 'INNERTUBE_CONTEXT' ? { client: { clientName: 'WEB', clientVersion: 'fixture', hl: 'ru' } } : null;
  h.context.fetch = async (url, options) => {
    h.requests.push({ url, options });
    return url.includes('/get_panel') ? { ok: true, text: async () => JSON.stringify(body) } : { ok: false, status: 403 };
  };
  h.context.sendToBackground = async () => ({ ok: false });
}
test('sole automatic track uses a fresh native modern request bound to its video, preserving actual cue text and time', async () => {
  const h = harness([track('en', 'asr')]); setupModern(h);
  const result = await h.context.getSubtitles(true);
  assert.equal(result.text, ' Actual <literal> &amp;\n🙂');
  assert.equal(result.cues[0].start, 1);
  assert.equal(result.lang, 'en');
  assert.equal(result.attribution, 'unique-native-caption-track');
  const request = h.requests.find(r => r.url.includes('/get_panel'));
  const body = JSON.parse(request.options.body);
  assert.equal(body.params, h.window.ytInitialData.updateEngagementPanelContentCommand.globalConfiguration.params);
  assert.equal(body.panelId, 'PAmodern_transcript_view');
});

test('modern native inference accepts a sole manual or named track but rejects every additional language/kind/name', async (t) => {
  for (const kind of ['', 'asr']) await t.test(`sole ${kind || 'manual'} named`, async () => {
    const h = harness([track('en', kind, 'original')]); setupModern(h);
    h.player.getOption = () => ({ ...h.tracks[0], name: 'original', translationLanguage: null });
    assert.equal((await h.context.getSubtitles(true)).attribution, 'unique-native-caption-track');
  });
  for (const other of [track('ru'), track('en', 'asr'), track('en', '', 'other')]) await t.test(`additional ${other.languageCode}/${other.kind}/${other.vssId}`, async () => {
    const h = harness([track('en'), other]); setupModern(h);
    h.context.pickTrack = () => h.tracks[0];
    await assert.rejects(h.context.getSubtitles(true), /выбранную дорожку/);
    assert.equal(h.requests.filter(r => r.url.includes('/get_panel')).length, 0);
  });
});

test('modern inference rejects translated, unknown and contradictory native track metadata', async (t) => {
  for (const actual of [{}, { ...track('en'), translationLanguage: { languageCode: 'de' } }, track('en', 'asr'), { ...track('en'), name: 'other' }]) await t.test(JSON.stringify([actual.languageCode, actual.kind, actual.name, actual.translationLanguage?.languageCode]), async () => {
    const h = harness([track('en')]); setupModern(h); h.player.getOption = () => actual;
    await assert.rejects(h.context.getSubtitles(true), /выбранную дорожку/);
    assert.equal(h.requests.filter(r => r.url.includes('/get_panel')).length, 0);
  });
});

test('modern inference requires the complete current player caption list, not a sole tracklist fallback', async () => {
  const h = harness([track('en')]); setupModern(h);
  h.player.getPlayerResponse = () => ({ videoDetails: { videoId: 'fixture01' }, streamingData: {} });
  h.player.getOption = (module, option) => option === 'tracklist' ? h.tracks : { ...h.tracks[0], name: '', translationLanguage: null };
  await assert.rejects(h.context.getSubtitles(true), /выбранную дорожку/);
  assert.equal(h.requests.filter(r => r.url.includes('/get_panel')).length, 0);
});

test('modern response cannot contradict video, language, kind, translation or an explicit footer', async (t) => {
  const cases = [
    ['other video', b => { b.content.engagementPanelSectionListRenderer.content.sectionListRenderer.contents[0].itemSectionRenderer.contents[0].macroMarkersPanelItemViewModel.onTap.innertubeCommand.watchEndpoint.videoId = 'oldVideo'; }],
    ['language', b => { b.captionMetadata = { languageCode: 'ru' }; }],
    ['kind', b => { b.captionMetadata = { languageCode: 'en', kind: 'asr' }; }],
    ['translation', b => { b.translationLanguage = { languageCode: 'de' }; }],
    ['footer', b => { b.footer = { transcriptFooterRenderer: { languageMenu: {} } }; }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async () => {
    const body = modernResponse(); mutate(body); const h = harness([track('en')]); setupModern(h, body);
    await assert.rejects(h.context.getSubtitles(true), /выбранную дорожку/);
  });
});

test('modern fallback rejects stale commands, navigation and changed sole track after a fresh response', async (t) => {
  const stale = harness([track('en')]); setupModern(stale); stale.window.ytInitialData = modernRequest('oldVideo');
  await assert.rejects(stale.context.getSubtitles(true), /выбранную дорожку/);
  assert.equal(stale.requests.filter(r => r.url.includes('/get_panel')).length, 0);
  for (const change of ['navigate', 'second track', 'kind', 'name']) await t.test(change, async () => {
    const h = harness([track('en')]); setupModern(h); const fetch = h.context.fetch;
    h.context.fetch = async (url, options) => {
      if (url.includes('/get_panel')) {
        if (change === 'navigate') h.document.dispatchEvent(new h.window.Event('yt-navigate-start'));
        if (change === 'second track') h.tracks.push(track('ru'));
        if (change === 'kind') h.player.getOption = () => track('en', 'asr');
        if (change === 'name') h.player.getOption = () => ({ ...track('en'), name: 'changed' });
      }
      return fetch(url, options);
    };
    await assert.rejects(h.context.getSubtitles(true), /изменился|выбранную дорожку/);
  });
});

test('modern cues keep native chronological/equal times, zero and hours, omit chapter headers and enforce bounds', () => {
  const h = harness([track('en')]), body = modernResponse(), panel = body.content.engagementPanelSectionListRenderer;
  const first = panel.content.sectionListRenderer.contents[0].itemSectionRenderer.contents[0];
  const row = (startTimeSeconds, text) => { const item = structuredClone(first); item.macroMarkersPanelItemViewModel.onTap.innertubeCommand.watchEndpoint.startTimeSeconds = startTimeSeconds; item.macroMarkersPanelItemViewModel.item.timelineItemViewModel.contentItems[0].transcriptSegmentViewModel.simpleText = text; return item; };
  const items = [row(3601, 'hour'), row(0, 'zero'), row(0, 'equal'), { macroMarkersPanelItemViewModel: { item: { timelineChapterViewModel: { title: 'Chapter' } } } }];
  panel.content.sectionListRenderer.contents[0].itemSectionRenderer.contents = items;
  assert.deepEqual(JSON.parse(JSON.stringify(h.context.parseModernTimedTranscript(body, h.tracks[0], h.tracks, 'fixture01').cues.map(c => [c.start, c.text]))), [[0, 'zero'], [0, 'equal'], [3601, 'hour']]);
  for (const invalid of [undefined, -1, Infinity, '0', 7 * 86400 + 1]) {
    panel.content.sectionListRenderer.contents[0].itemSectionRenderer.contents = [row(invalid, 'bad')];
    assert.equal(h.context.parseModernTimedTranscript(body, h.tracks[0], h.tracks, 'fixture01'), null);
  }
  panel.content.sectionListRenderer.contents[0].itemSectionRenderer.contents = [row(0, 'x'.repeat(65537))];
  assert.equal(h.context.parseModernTimedTranscript(body, h.tracks[0], h.tracks, 'fixture01'), null);
  assert.equal(h.context.decodeModernTranscriptVideo('x'.repeat(8193)), null);
  assert.equal(h.context.decodeModernTranscriptVideo(Buffer.from('fixture01').toString('base64')), null);
});

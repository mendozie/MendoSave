const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseHTML } = require('linkedom');
const { readChapters, formatTimedTranscript } = require('../extension/captions.js');

test('native chapter float representations collapse to the same displayed millisecond heading', () => {
  assert.equal(formatTimedTranscript([{ start: 223, text: 'Speech' }], [
    { start: 222.39999, text: 'Resource management' },
    { start: 222.4, text: 'Resource management' },
  ]), '[03:42.400] Resource management\n\n[03:43] Speech\n');
});

test('modern transcript chapter titles use actual same-video watch endpoints without a rendered panel', () => {
  const row = (videoId, startTimeSeconds, title) => ({ macroMarkersPanelItemViewModel: {
    panelId: 'PAmodern_transcript_view', item: { timelineChapterViewModel: { title } },
    onTap: { innertubeCommand: { watchEndpoint: { videoId, startTimeSeconds } } },
  } });
  const data = { sectionListRenderer: { contents: [
    { itemSectionRenderer: { header: row('fixture01', 0, 'Chapter 1: <Intro> & 🙂') } },
    { itemSectionRenderer: { header: row('oldVideo', 5, 'Old chapter') } },
    { itemSectionRenderer: { header: row('fixture01', 8, 'Chapter 2: Next') } },
    { itemSectionRenderer: { header: row('fixture01', 10, 'After duration') } },
    { itemSectionRenderer: { header: row('fixture01', undefined, 'No time') } },
  ] } };
  assert.deepEqual(readChapters(data, null, 10, 'fixture01'), [
    { start: 0, text: 'Chapter 1: <Intro> & 🙂' }, { start: 8, text: 'Chapter 2: Next' },
  ]);
  assert.deepEqual(readChapters(data, null, 10), []);
});

test('timed TXT interleaves real chapters and spoken cues chronologically, including zero and over an hour', () => {
  assert.equal(formatTimedTranscript([
    { start: 3601.125, end: 3604, text: 'Поздняя реплика.' },
    { start: 0, end: 3, text: 'Добро пожаловать.' },
    { start: 5, end: 7, text: 'Перейдём к делу.' },
  ], [
    { start: 3600, text: 'Обсуждение' },
    { start: 0, text: 'Введение' },
  ]), '[00:00] Введение\n\n[00:00] Добро пожаловать.\n[00:05] Перейдём к делу.\n\n[01:00:00] Обсуждение\n\n[01:00:01.125] Поздняя реплика.\n');
});

test('without chapters only actual timed cues are exported, preserving stable equal-time speech and deduplicating rows', () => {
  const cues = [
    { start: 7, text: 'Later' },
    { start: 0, text: 'First' },
    { start: 0, text: 'Another speaker' },
    { start: 0, text: 'First' },
  ];
  const original = structuredClone(cues);
  assert.equal(formatTimedTranscript(cues), '[00:00] First\n[00:00] Another speaker\n[00:07] Later\n');
  assert.deepEqual(cues, original);
});

test('timed TXT preserves Unicode and literal markup, entities, backslashes and multiline speech as UTF-8', () => {
  const text = 'Кириллица 🙂 <script>x</script> &lt; A & B \\ "цитата"\nВторая строка';
  const result = formatTimedTranscript([{ start: 1.01, text }]);
  assert.equal(Buffer.from(result, 'utf8').toString('utf8'), '[00:01.010] Кириллица 🙂 <script>x</script> &lt; A & B \\ "цитата"\nВторая строка\n');
});

test('missing and invalid cue times do not invent transcript timing; chapters alone never become speech', () => {
  assert.equal(formatTimedTranscript([
    { text: 'Missing' }, { start: -1, text: 'Negative' }, { start: Infinity, text: 'Infinite' },
    { start: NaN, text: 'NaN' }, { start: '0', text: 'String' }, { start: 700000, text: 'Too long' },
    { start: 0, text: ' ' }, { start: 0, text: {} },
  ], [{ start: 0, text: 'Actual chapter' }]), null);
  assert.equal(formatTimedTranscript(null), null);
  assert.equal(formatTimedTranscript([{ start: 0, text: 'Valid' }], [{ start: NaN, text: 'Invalid' }, { start: 10, text: 'Past end' }], 10), '[00:00] Valid\n');
});

test('recognized chapter panel markers use explicit watch endpoint time and title, never description text', () => {
  const data = { engagementPanelSectionListRenderer: {
    targetId: 'engagement-panel-macro-markers-description-chapters', content: {
      macroMarkersListRenderer: { contents: [
        { macroMarkersListItemRenderer: { title: { simpleText: 'Начало' }, onTap: { watchEndpoint: { startTimeSeconds: 0 } } } },
        { macroMarkersListItemRenderer: { title: { runs: [{ text: 'Раздел' }] }, onTap: { watchEndpoint: { startTimeSeconds: '65' } } } },
        { macroMarkersListItemRenderer: { title: { simpleText: 'Нет времени' }, timeDescription: { simpleText: '2:00' } } },
      ] },
    },
  } };
  assert.deepEqual(readChapters(data), [{ start: 0, text: 'Начало' }, { start: 65, text: 'Раздел' }]);
});

test('chapter DOM extraction reads actual chapter and transcript headers, retaining caption description guard', () => {
  const { document } = parseHTML(`<html><body>
    <ytd-structured-description-content-renderer><span>0:00 Arbitrary description</span></ytd-structured-description-content-renderer>
    <ytd-transcript-section-header-renderer><span class="section-header-start-offset">0:00</span><span class="section-header-title">Вступление</span></ytd-transcript-section-header-renderer>
    <transcript-section-header-view-model><span class="ytwTranscriptSectionHeaderViewModelTimestamp">1:01:02</span><span class="ytwTranscriptSectionHeaderViewModelTitle">A &amp; B &amp;lt;</span></transcript-section-header-view-model>
    <ytd-transcript-section-header-renderer><span class="section-header-start-offset">1:60</span><span class="section-header-title">Bad seconds</span></ytd-transcript-section-header-renderer>
    <ytd-transcript-section-header-renderer><span class="section-header-start-offset">1:60:01</span><span class="section-header-title">Bad minutes</span></ytd-transcript-section-header-renderer>
    <ytd-macro-markers-list-item-renderer><span id="time">0:03</span><span id="title">Not chapter scoped</span></ytd-macro-markers-list-item-renderer>
    <ytd-engagement-panel-section-list-renderer target-id="engagement-panel-macro-markers-description-chapters">
      <ytd-macro-markers-list-item-renderer><span id="time">0:05</span><span id="title">Тема</span></ytd-macro-markers-list-item-renderer>
    </ytd-engagement-panel-section-list-renderer>
  </body></html>`);
  assert.deepEqual(readChapters(null, document, 4000), [
    { start: 0, text: 'Вступление' }, { start: 5, text: 'Тема' }, { start: 3662, text: 'A & B &lt;' },
  ]);
  assert.equal(require('../extension/captions.js').readTranscript(document, 4000), null);
});

test('chapter extraction traverses shadow roots and deduplicates parallel metadata and markup', () => {
  const { document } = parseHTML('<html><body><div id="host"></div></body></html>');
  const shadow = document.querySelector('#host').attachShadow({ mode: 'open' });
  shadow.innerHTML = '<timeline-chapter-view-model><span class="ytwTimelineChapterViewModelTimestamp">00:00</span><span class="ytwTimelineChapterViewModelTitle">Введение</span></timeline-chapter-view-model>';
  const data = { chapterRenderer: { timeRangeStartMillis: 0, title: { simpleText: 'Введение' } } };
  data.circular = data;
  assert.deepEqual(readChapters(data, document), [{ start: 0, text: 'Введение' }]);
});

test('metadata rejects malformed times and out-of-duration chapters without converting captions into chapters', () => {
  assert.deepEqual(readChapters({ contents: [
    { chapterRenderer: { timeRangeStartMillis: '1oops', title: { simpleText: 'Bad numeric' } } },
    { chapterRenderer: { timeRangeStartMillis: -1, title: { simpleText: 'Negative' } } },
    { chapterRenderer: { timeRangeStartMillis: Infinity, title: { simpleText: 'Infinity' } } },
    { chapterRenderer: { title: { simpleText: 'No time' } } },
    { chapterRenderer: { timeRangeStartMillis: 3000, title: { simpleText: 'End' } } },
    { transcriptSegmentRenderer: { startMs: 0, snippet: { simpleText: 'Spoken cue' } } },
  ] }, null, 3), []);
});

test('inherited renderer properties are not supplied chapter metadata', () => {
  const prototype = { chapterRenderer: { timeRangeStartMillis: 0, title: { simpleText: 'Inherited' } } };
  assert.deepEqual(readChapters(Object.create(prototype)), []);
});

test('oversized transcript rows and text fail explicitly rather than silently truncating output', () => {
  assert.throws(() => formatTimedTranscript(Array(50001).fill({ start: 0, text: 'Cue' })), RangeError);
  assert.throws(() => formatTimedTranscript([{ start: 0, text: 'x'.repeat(65537) }]), RangeError);
  assert.throws(() => formatTimedTranscript(Array.from({ length: 129 }, (_, index) => ({ start: index, text: 'x'.repeat(65536) }))), RangeError);
  assert.throws(() => formatTimedTranscript([{ start: 0, text: 'Cue' }], Array(2001).fill({ start: 0, text: 'Chapter' })), RangeError);
});

test('metadata traversal, depth, chapter titles and DOM traversal have finite limits', () => {
  assert.throws(() => readChapters(Array(100001).fill(0)), RangeError);
  let nested = { chapterRenderer: { timeRangeStartMillis: 0, title: { simpleText: 'Deep' } } };
  for (let index = 0; index < 65; index++) nested = { nested };
  assert.throws(() => readChapters(nested), RangeError);
  assert.throws(() => readChapters({ chapterRenderer: { timeRangeStartMillis: 0, title: { simpleText: 'x'.repeat(65537) } } }), RangeError);
  assert.throws(() => readChapters({ chapterRenderer: { timeRangeStartMillis: 0, title: { runs: Array(1001).fill({ text: 'x' }) } } }), RangeError);
  const { document } = parseHTML('<html><body>' + '<i></i>'.repeat(20001) + '</body></html>');
  assert.throws(() => readChapters(null, document), RangeError);
});

test('real structured chapter titles are separate from caption cues and exclude unrelated timestamps', () => {
  const data = { playerOverlays: { markersMap: [{ key: 'DESCRIPTION_CHAPTERS', value: { chapters: [
    { chapterRenderer: { timeRangeStartMillis: 5000, title: { runs: [{ text: 'Тема <A>' }, { text: ' & B' }] } } },
    { chapterRenderer: { timeRangeStartMillis: '0', title: { simpleText: 'Введение' } } },
    { chapterRenderer: { timeRangeStartMillis: '20000', title: { simpleText: 'После конца' } } },
  ] } }] }, description: '0:00 Не глава из metadata',
  transcript: { transcriptSectionHeaderRenderer: { startMs: '5000', title: { simpleText: 'Тема <A> & B' } } },
  unrelated: { macroMarkersListItemRenderer: { title: { simpleText: 'Непроверенная метка' }, onTap: { watchEndpoint: { startTimeSeconds: 8 } } } } };
  assert.deepEqual(readChapters(data, null, 20), [
    { start: 0, text: 'Введение' }, { start: 5, text: 'Тема <A> & B' },
  ]);
});

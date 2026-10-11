// Read actual transcript rows, never chapter headings or description timestamps.
function readTranscript(document, duration = 0) {
  const roots = [document];
  const rows = [];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    rows.push(...root.querySelectorAll('ytd-transcript-segment-renderer, ytm-transcript-segment-renderer, transcript-segment-view-model'));
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
  }
  // YouTube can retain legacy rows alongside its current view models. These
  // are parallel representations of the same speech, not additional cues.
  const modern = rows.filter((row) => row.localName === 'transcript-segment-view-model');
  const legacy = rows.filter((row) => row.localName !== 'transcript-segment-view-model');
  return readTranscriptRows(modern, duration) || readTranscriptRows(legacy, duration);
}

function readTranscriptRows(rows, duration) {
  const cues = [];
  const seen = new Set();
  for (const row of rows) {
    if (row.closest('ytd-watch-next-secondary-results-renderer')) continue;
    const timestamp = row.querySelector('.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp');
    const content = row.querySelector('.segment-text, [class*="segment-text"], [class*="segmentText"], span[role="text"]');
    const value = timestamp?.textContent.trim() || '';
    if (!/^\d+:\d{2}(?::\d{2})?$/.test(value)) continue;
    const parts = value.split(':').map(Number);
    if (parts.slice(1).some((part) => part >= 60)) continue;
    const start = parts.reduce((seconds, part) => seconds * 60 + part, 0);
    const text = content?.textContent.trim();
    if (!text || (duration > 0 && start >= duration)) continue;
    const key = `${start}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cues.push({ start, text });
  }
  if (!cues.length) return null;
  cues.sort((a, b) => a.start - b.start);
  for (let index = 0; index < cues.length; index++) {
    const next = cues[index + 1]?.start;
    cues[index].end = next > cues[index].start ? next
      : (duration > cues[index].start ? duration : cues[index].start + 4);
  }
  return { cues, lines: cues.map((cue) => cue.text) };
}
const TIMED_TRANSCRIPT_LIMITS = Object.freeze({ cues: 50000, chapters: 2000, text: 65536, totalText: 8 * 1024 * 1024, nodes: 100000, domNodes: 20000, depth: 64, seconds: 7 * 86400 });

// Separate TXT export. Inputs are actual timed cues and optional real chapters;
// never reconstruct timings from plain text. Text stays literal, with LF rows.
// Invalid rows are ignored; no valid cues returns null; oversized inputs throw.
function formatTimedTranscript(cues, chapters = [], duration = 0) {
  const budget = { text: 0 };
  const spoken = normalizeTimedRows(cues, TIMED_TRANSCRIPT_LIMITS.cues, duration, budget);
  if (!spoken.length) return null;
  const headings = normalizeTimedRows(chapters, TIMED_TRANSCRIPT_LIMITS.chapters, duration, budget);
  const rows = [
    ...spoken.map((cue) => ({ ...cue, chapter: false })),
    ...headings.map((chapter) => ({ ...chapter, chapter: true })),
  ].sort((a, b) => a.start - b.start || Number(b.chapter) - Number(a.chapter));
  const lines = [];
  for (const row of rows) {
    if (row.chapter && lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`[${formatTranscriptTime(row.start)}] ${row.text}`);
    if (row.chapter) lines.push('');
  }
  return lines.join('\n') + '\n';
}

function normalizeTimedRows(rows, limit, duration = 0, budget = { text: 0 }) {
  if (!Array.isArray(rows)) return [];
  if (rows.length > limit) throw new RangeError('Timed transcript row limit exceeded');
  const seen = new Set();
  return rows.filter((row) => {
    if (!row || !validTranscriptSeconds(row.start) || (validTranscriptSeconds(duration) && duration > 0 && row.start >= duration)
      || typeof row.text !== 'string') return false;
    budget.text += row.text.length;
    if (row.text.length > TIMED_TRANSCRIPT_LIMITS.text || budget.text > TIMED_TRANSCRIPT_LIMITS.totalText) throw new RangeError('Timed transcript text limit exceeded');
    if (!row.text.trim()) return false;
    const key = JSON.stringify([Math.round(row.start * 1000), row.text]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ start, text }) => ({ start, text }));
}

function validTranscriptSeconds(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= TIMED_TRANSCRIPT_LIMITS.seconds;
}

function readChapters(data, document, duration = 0, videoId = '') {
  const chapters = [];
  const visited = new WeakSet();
  const pending = [{ node: data, depth: 0, chapterPanel: false }];
  let count = 0;
  let textSize = 0;
  function add(start, text) {
    if (!validTranscriptSeconds(start) || typeof text !== 'string') return;
    if (text.length > TIMED_TRANSCRIPT_LIMITS.text) throw new RangeError('Chapter title text limit exceeded');
    if (!text.trim()) return;
    textSize += text.length;
    if (textSize > TIMED_TRANSCRIPT_LIMITS.totalText) throw new RangeError('Chapter total text limit exceeded');
    if (chapters.length >= TIMED_TRANSCRIPT_LIMITS.chapters) throw new RangeError('Chapter row limit exceeded');
    chapters.push({ start, text });
  }
  while (pending.length) {
    const { node, depth, chapterPanel } = pending.pop();
    if (!node || typeof node !== 'object' || visited.has(node)) continue;
    if (++count > TIMED_TRANSCRIPT_LIMITS.nodes || depth > TIMED_TRANSCRIPT_LIMITS.depth) throw new RangeError('Chapter metadata traversal limit exceeded');
    visited.add(node);
    const renderer = chapterField(node, 'chapterRenderer');
    if (renderer) add(chapterNumber(chapterField(renderer, 'timeRangeStartMillis'), 1000), chapterText(chapterField(renderer, 'title')));
    const header = chapterField(node, 'transcriptSectionHeaderRenderer');
    if (header) add(chapterNumber(chapterField(header, 'startMs'), 1000), chapterText(chapterField(header, 'title')));
    const modern = chapterField(node, 'macroMarkersPanelItemViewModel');
    const modernChapter = chapterField(chapterField(modern, 'item'), 'timelineChapterViewModel');
    const modernEndpoint = chapterField(chapterField(chapterField(modern, 'onTap'), 'innertubeCommand'), 'watchEndpoint');
    if (videoId && modernChapter && chapterField(modern, 'panelId') === 'PAmodern_transcript_view'
      && chapterField(modernEndpoint, 'videoId') === videoId) {
      add(chapterNumber(chapterField(modernEndpoint, 'startTimeSeconds')), chapterField(modernChapter, 'title'));
    }
    const target = chapterField(node, 'targetId');
    const markerKey = chapterField(node, 'key');
    const panel = chapterPanel || /chapters/.test(typeof target === 'string' ? target : '')
      || markerKey === 'DESCRIPTION_CHAPTERS' || markerKey === 'AUTO_CHAPTERS';
    const marker = chapterField(node, 'macroMarkersListItemRenderer');
    if (marker && panel) {
      const endpoint = chapterField(chapterField(marker, 'onTap'), 'watchEndpoint');
      add(chapterNumber(chapterField(endpoint, 'startTimeSeconds')), chapterText(chapterField(marker, 'title')));
    }
    // Count edges as well as objects: giant primitive arrays must be bounded.
    let edges = 0;
    for (const key in node) {
      if (!Object.hasOwn(node, key)) continue;
      if (++edges + count > TIMED_TRANSCRIPT_LIMITS.nodes || pending.length >= TIMED_TRANSCRIPT_LIMITS.nodes) throw new RangeError('Chapter metadata traversal limit exceeded');
      const value = node[key];
      if (value && typeof value === 'object') pending.push({ node: value, depth: depth + 1, chapterPanel: panel });
    }
    count += edges;
  }
  if (document) {
    const elements = [document];
    let inspected = 0;
    while (elements.length) {
      const element = elements.pop();
      if (++inspected > TIMED_TRANSCRIPT_LIMITS.domNodes) throw new RangeError('Chapter DOM traversal limit exceeded');
      if (element.matches?.('ytd-transcript-section-header-renderer, transcript-section-header-view-model, timeline-chapter-view-model, ytd-macro-markers-list-item-renderer')) {
        const marker = element.localName === 'ytd-macro-markers-list-item-renderer';
        const inChapterPanel = element.closest('[target-id*="chapters"], [panel-target-id*="chapters"]');
        if (!marker || inChapterPanel) {
          const timestamp = element.querySelector('.segment-timestamp, .section-header-start-offset, .ytwTranscriptSectionHeaderViewModelTimestamp, .ytwTimelineChapterViewModelTimestamp, .ytwTimelineChapterViewModelTimeStamp, #time');
          const title = element.querySelector('.segment-text, .section-header-title, .ytwTranscriptSectionHeaderViewModelTitle, .ytwTimelineChapterViewModelTitle, #title');
          add(chapterTimestamp(timestamp?.textContent), title?.textContent);
        }
      }
      if (element.shadowRoot) elements.push(element.shadowRoot);
      for (const child of element.children || []) {
        if (elements.length >= TIMED_TRANSCRIPT_LIMITS.domNodes) throw new RangeError('Chapter DOM traversal limit exceeded');
        elements.push(child);
      }
    }
  }
  return normalizeTimedRows(chapters, TIMED_TRANSCRIPT_LIMITS.chapters, duration).sort((a, b) => a.start - b.start);
}

function chapterField(node, key) {
  return node && typeof node === 'object' && Object.hasOwn(node, key) ? node[key] : undefined;
}

function chapterNumber(value, divisor = 1) {
  if (typeof value === 'string') {
    if (!/^\d{1,12}(?:\.\d{1,3})?$/.test(value)) return NaN;
    value = Number(value);
  }
  return typeof value === 'number' ? value / divisor : NaN;
}

function chapterTimestamp(value) {
  if (typeof value !== 'string' || value.length > 24) return NaN;
  const parts = value.trim().split(':');
  if (parts.length < 2 || parts.length > 3 || !/^\d{1,6}:\d{2}(?::\d{2})?$/.test(value.trim())) return NaN;
  if (parts.slice(1).some((part) => Number(part) >= 60)) return NaN;
  return parts.reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

function chapterText(value) {
  const simple = chapterField(value, 'simpleText');
  if (typeof simple === 'string') return simple;
  const runs = chapterField(value, 'runs');
  if (!Array.isArray(runs)) return '';
  if (runs.length > 1000) throw new RangeError('Chapter title runs limit exceeded');
  let text = '';
  for (const run of runs) {
    const part = chapterField(run, 'text');
    if (typeof part !== 'string') continue;
    if (text.length + part.length > TIMED_TRANSCRIPT_LIMITS.text) throw new RangeError('Chapter title text limit exceeded');
    text += part;
  }
  return text;
}

function formatTranscriptTime(seconds) {
  const millis = Math.round(seconds * 1000);
  const whole = Math.floor(millis / 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const secs = whole % 60;
  const parts = [minutes, secs].map((part) => String(part).padStart(2, '0'));
  if (hours) parts.unshift(String(hours).padStart(2, '0'));
  return parts.join(':') + (millis % 1000 ? `.${String(millis % 1000).padStart(3, '0')}` : '');
}

globalThis.MendoCaptions = { readTranscript, readChapters, formatTimedTranscript };
if (typeof module !== 'undefined') module.exports = { readTranscript, readChapters, formatTimedTranscript };

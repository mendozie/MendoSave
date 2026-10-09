// Read actual transcript rows, never chapter headings or description timestamps.
function readTranscript(document, duration = 0) {
  const roots = [document];
  const rows = [];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    rows.push(...root.querySelectorAll('ytd-transcript-segment-renderer, ytm-transcript-segment-renderer, transcript-segment-view-model'));
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
  }
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
globalThis.MendoCaptions = { readTranscript };
if (typeof module !== 'undefined') module.exports = { readTranscript };

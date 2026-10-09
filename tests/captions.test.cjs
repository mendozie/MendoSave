const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseHTML } = require('linkedom');
const { readTranscript } = require('../extension/captions.js');

test('caption extraction reads current transcript segments and excludes chapter labels', () => {
  const { document } = parseHTML(`<html><body>
    <ytd-structured-description-content-renderer><span>0:00</span><span>Intro</span></ytd-structured-description-content-renderer>
    <div id="secondary"><ytd-engagement-panel-section-list-renderer is-sync-scroll-panel>
      <timeline-chapter-view-model>Chapter 1: Intro</timeline-chapter-view-model>
      <transcript-segment-view-model>
        <div class="ytwTranscriptSegmentViewModelTimestamp">0:01</div>
        <div class="ytwTranscriptSegmentViewModelTimestampA11yLabel">1 second</div>
        <span role="text">First spoken line.</span>
      </transcript-segment-view-model>
      <transcript-segment-view-model>
        <div class="ytwTranscriptSegmentViewModelTimestamp">0:07</div>
        <span role="text">Last spoken line.</span>
      </transcript-segment-view-model>
    </ytd-engagement-panel-section-list-renderer></div>
  </body></html>`);
  assert.deepEqual(readTranscript(document, 19).cues, [
    { start: 1, end: 7, text: 'First spoken line.' },
    { start: 7, end: 19, text: 'Last spoken line.' },
  ]);
});

test('chapters alone are unavailable captions', () => {
  const { document } = parseHTML(`<html><body>
    <ytd-engagement-panel-section-list-renderer target-id="engagement-panel-macro-markers-description-chapters">
      <span>0:00</span><span>Intro</span><span>0:05</span><span>Chapter</span>
    </ytd-engagement-panel-section-list-renderer>
  </body></html>`);
  assert.equal(readTranscript(document, 19), null);
});

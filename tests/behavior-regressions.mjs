import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const title = read('title-helper.js');
const youtube = read('youtube-probe.js');
const hls = read('offscreen-v2.js');
const capture = read('hls-page-capture.js');
const content = read('content.js');

assert.match(title, /PAGE_MEDIA_CONTEXT/, 'SPA context changes must use the atomic service-worker context handshake');
assert.match(title, /pushState[\s\S]*replaceState/, 'History API navigation must be detected without reload');
assert.doesNotMatch(title, /setInterval\s*\(/, 'SPA title detection must remain event-driven, not poll the page');

assert.match(youtube, /scheduleProbe/, 'YouTube probing should be debounced');
assert.doesNotMatch(youtube, /setTimeout\(probe,\s*(?:300|900|1800|3200)/, 'YouTube must not run repeated probe bursts');

assert.match(hls, /transcodeTransportStream/, 'MPEG-TS HLS must pass through a real container conversion');
assert.doesNotMatch(hls, /saveBlob\([^\n]*\.ts/, 'the offscreen engine must never save raw .ts output');
assert.match(hls, /ContentProtection/, 'DASH content protection must remain rejected');
assert.match(hls, /info\.encrypted/, 'encrypted HLS must remain rejected');

assert.match(content, /HTTP\\s\*403[\s\S]*avd:capture-request/, 'YouTube 403 should trigger decoded-player fallback only after fetch failure');
assert.doesNotMatch(capture, /const yt = isYouTubeVideoButton/, 'YouTube downloads must not be intercepted before direct fetch is attempted');

console.log('SPA, performance, HLS-output, DRM-boundary, and YouTube fallback regression tests passed');

import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const title = read('title-helper.js');
const youtube = read('youtube-probe.js');
const hls = read('offscreen-v2.js');
const capture = read('hls-page-capture.js');
const content = read('content.js');
const navigation = read('spa-navigation-hook.js');
const manifest = JSON.parse(read('manifest.json'));

assert.match(title, /PAGE_MEDIA_CONTEXT/, 'SPA context changes must use the atomic service-worker context handshake');
assert.match(title, /avd:history-navigation/, 'isolated-world title tracking must consume the main-world navigation signal');
assert.doesNotMatch(title, /input\[type=["']checkbox["']\]:checked/, 'completed LMS checkboxes must not be mistaken for the active lesson');
assert.match(title, /215\s*-\s*Math\.min/, 'the heading closest to the player should outrank course-level navigation labels');
assert.doesNotMatch(title, /setInterval\s*\(/, 'SPA title detection must remain event-driven, not poll the page');
assert.match(navigation, /pushState[\s\S]*replaceState/, 'main-world History API navigation must be detected without reload');
assert.equal(manifest.content_scripts.some(x => x.world === 'MAIN' && x.js?.includes('spa-navigation-hook.js')), true, 'main-world SPA hook must be wired');
assert.equal(manifest.permissions.includes('storage'), true, 'session persistence requires the storage permission');
assert.equal(manifest.permissions.includes('webNavigation'), true, 'cross-frame player discovery requires webNavigation');
assert.equal(manifest.content_scripts[0].all_frames, true, 'capture fallback must be injected into embedded player frames');
assert.doesNotMatch(title, /attributeFilter:\s*\[[^\]]*['"]class['"]/, 'title tracking must not observe high-frequency page class mutations');

assert.match(youtube, /scheduleProbe/, 'YouTube probing should be debounced');
assert.doesNotMatch(youtube, /setTimeout\(probe,\s*(?:300|900|1800|3200)/, 'YouTube must not run repeated probe bursts');

assert.match(hls, /transcodeTransportStream/, 'MPEG-TS HLS must pass through a real container conversion');
assert.doesNotMatch(hls, /saveBlob\([^\n]*\.ts/, 'the offscreen engine must never save raw .ts output');
assert.match(hls, /ContentProtection/, 'DASH content protection must remain rejected');
assert.match(hls, /info\.encrypted/, 'encrypted HLS must remain rejected');

assert.match(content, /avd:youtube-refresh[\s\S]*DOWNLOAD_MEDIA[\s\S]*avd:youtube-refresh/, 'YouTube downloads should refresh signed streams and retry once');
assert.doesNotMatch(content, /YouTube video['"]?\}\}\)\)|detail:\{label:'YouTube video'/, 'YouTube failure must not start the real-time capture fallback');
assert.doesNotMatch(capture, /const yt = isYouTubeVideoButton/, 'YouTube downloads must not be intercepted before direct fetch is attempted');
assert.doesNotMatch(capture, /page-video-downloader-panel button/, 'HLS downloads must try the fast offscreen path before page capture');
assert.doesNotMatch(capture, /new MutationObserver/, 'capture fallback must not install a page-wide UI observer');
assert.match(content, /i\.kind==='hls'[\s\S]*CAPTURE_FRAME_VIDEO/, 'failed HLS conversion should retain cross-frame decoded-page capture as fallback');
assert.match(content, /CAPTURE_FRAME_VIDEO[\s\S]*frameId/, 'embedded HLS fallback must target the candidate frame');
assert.match(content, /i\.kind==='hls'[\s\S]*WARMUP_FRAME_VIDEO[\s\S]*3500[\s\S]*pullNetwork/, 'HLS download clicks should warm only the detected player and rescan');
assert.doesNotMatch(capture, /window\.top\s*!==\s*window\.self\)\s*return/, 'capture helper must remain available inside player frames');
assert.match(capture, /START_FRAME_VIDEO_CAPTURE[\s\S]*filenameBase/, 'player frames must accept titled capture requests');
assert.match(capture, /START_FRAME_VIDEO_WARMUP[\s\S]*video\.muted=true[\s\S]*video\.play\(\)[\s\S]*if\(wasPaused\)video\.pause/, 'frame warm-up must be muted, bounded, and restore paused state');
assert.match(capture, /PROBE_FRAME_VIDEO[\s\S]*visibleArea/, 'each injected frame must report whether it contains a visible video');
assert.match(content, /getManifest[\s\S]*Any Video Downloader\$\{EXT_VERSION/, 'panel must display the loaded extension version');
assert.doesNotMatch(content, /triggerPlayers|\.play\(\)[\s\S]{0,100}Scanning/, 'media scanning must never start page playback');
assert.doesNotMatch(content, /attributeFilter:\s*\[[^\]]*['"]class['"]/, 'media tracking must not observe high-frequency class mutations');
assert.match(content, /collectDeclarative[\s\S]*og:video[\s\S]*application\/ld\+json/, 'pre-play discovery should inspect bounded declarative media metadata');
assert.match(youtube, /accessibleFormatUrl/, 'YouTube pre-play probing should accept already-signed cipher URLs without deciphering protected signatures');
assert.match(youtube, /avd:youtube-refresh/, 'YouTube probe must support an explicit pre-download refresh');
assert.doesNotMatch(content, /setStatus\(['"]Finished\./, 'Download All must preserve the concrete filename/result status');

console.log('SPA, performance, HLS-output, DRM-boundary, and YouTube fallback regression tests passed');

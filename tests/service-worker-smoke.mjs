import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let runtimeListener;
let lastRuntimeMessage;
const noopEvent = { addListener() {} };

const chrome = {
  webRequest: { onBeforeRequest: noopEvent, onHeadersReceived: noopEvent },
  tabs: {
    onRemoved: noopEvent,
    onUpdated: noopEvent,
    sendMessage: async () => {}
  },
  runtime: {
    onMessage: { addListener(fn) { runtimeListener = fn; } },
    getURL: p => `chrome-extension://test/${p}`,
    getContexts: async () => [],
    sendMessage: async msg => { lastRuntimeMessage = msg; return { ok: true, merged: true }; }
  },
  offscreen: { createDocument: async () => {} },
  downloads: { download: async () => 1 }
};

const context = vm.createContext({ chrome, URL, console, setTimeout, clearTimeout, Promise, Map, Set, Number, String, Boolean, Math, RegExp, Error, Array, Object });
vm.runInContext(fs.readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8'), context, { filename: 'service-worker.js' });
assert.equal(typeof runtimeListener, 'function', 'service worker runtime message listener should register');

function message(msg, tabId = 1) {
  return new Promise((resolve, reject) => {
    try {
      const ret = runtimeListener(msg, { tab: { id: tabId, url: 'https://www.youtube.com/watch?v=test' } }, resolve);
      if (ret !== true && ['GET_MEDIA_CANDIDATES','UPSERT_MEDIA_CANDIDATES','CLEAR_MEDIA_CANDIDATES'].includes(msg.type)) {
        // synchronous sendResponse paths resolve immediately
      }
    } catch (e) { reject(e); }
  });
}

await message({ type: 'UPSERT_MEDIA_CANDIDATES', items: [
  { url: 'https://r1.googlevideo.com/videoplayback?itag=18', kind: 'video', mime: 'video/mp4', source: 'youtube-progressive', isProgressive: true, hasAudio: true, hasVideo: true, height: 360, bitrate: 500000 },
  { url: 'https://r1.googlevideo.com/videoplayback?itag=137&range=0-999', kind: 'video', mime: 'video/mp4', source: 'youtube-adaptive', hasAudio: false, hasVideo: true, height: 1080, bitrate: 3000000 },
  { url: 'https://r1.googlevideo.com/videoplayback?itag=140&range=0-999', kind: 'audio', mime: 'audio/mp4', source: 'youtube-adaptive', hasAudio: true, hasVideo: false, bitrate: 128000 }
] });

const yt = await message({ type: 'GET_MEDIA_CANDIDATES' });
assert.equal(yt.ok, true);
assert.equal(yt.items.length, 3, 'service worker should preserve both progressive and adaptive choices for the page planner');
const progressive = yt.items.find(x => x.source === 'youtube-progressive');
assert.equal(progressive.hasAudio, true, 'progressive metadata should preserve embedded audio');
const adaptiveVideo = yt.items.find(x => x.kind === 'video' && x.source === 'youtube-adaptive');
assert.equal(adaptiveVideo.height, 1080, 'adaptive quality metadata should be preserved');

lastRuntimeMessage = null;
const merged = await message({
  type: 'DOWNLOAD_MERGED_MEDIA',
  filenameBase: 'Test Video',
  video: adaptiveVideo,
  audio: yt.items.find(x => x.kind === 'audio')
});
assert.equal(merged.ok, true, 'merged-media request should resolve through the offscreen engine');
assert.equal(lastRuntimeMessage?.type, 'DOWNLOAD_MERGED_MEDIA');
assert.equal(lastRuntimeMessage?.target, 'offscreen');
assert.ok(!/[?&]range=/.test(lastRuntimeMessage.video.url), 'volatile YouTube range parameter should be stripped before local fetch');

await message({ type: 'CLEAR_MEDIA_CANDIDATES' });
await message({ type: 'UPSERT_MEDIA_CANDIDATES', items: [
  { url: 'https://video.xx.fbcdn.net/o1/v/t2/f2/video.mp4?token=abc&bytestart=0&byteend=999', kind: 'video', mime: 'video/mp4', contentLength: 1000 },
  { url: 'https://video.xx.fbcdn.net/o1/v/t2/f2/video.mp4?token=abc&bytestart=1000&byteend=1999', kind: 'video', mime: 'video/mp4', contentLength: 1000 }
] });
const meta = await message({ type: 'GET_MEDIA_CANDIDATES' });
assert.equal(meta.items.length, 1, 'Meta byte-range variants should deduplicate to one media candidate');

await message({ type: 'CLEAR_MEDIA_CANDIDATES' });
await message({ type: 'PAGE_MEDIA_CONTEXT', title: 'Lesson One', url: 'https://course.test/lesson' });
await message({ type: 'UPSERT_MEDIA_CANDIDATES', items: [
  { url: 'https://cdn.course.test/video.mp4?token=signed&range=0-0', kind: 'video', contentLength: 0 },
  { url: 'https://cdn.course.test/video.mp4?token=signed&range=1-999', kind: 'video', totalLength: 50000 }
] });
let lesson = await message({ type: 'GET_MEDIA_CANDIDATES' });
assert.equal(lesson.items.length, 1, 'generic zero-size/range observations should deduplicate');
assert.equal(lesson.items[0].totalLength, 50000, 'later useful size metadata should upgrade a zero-size observation');
await message({ type: 'PAGE_MEDIA_CONTEXT', title: 'Lesson One', url: 'https://course.test/lesson' });
lesson = await message({ type: 'GET_MEDIA_CANDIDATES' });
assert.equal(lesson.items.length, 1, 'repeated context events must not erase current-lesson media');
await message({ type: 'PAGE_MEDIA_CONTEXT', title: 'Lesson Two', url: 'https://course.test/lesson' });
lesson = await message({ type: 'GET_MEDIA_CANDIDATES' });
assert.equal(lesson.items.length, 0, 'a true SPA lesson change should clear stale media exactly once');

console.log('service-worker smoke tests passed');

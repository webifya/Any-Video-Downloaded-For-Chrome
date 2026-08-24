import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let runtimeListener;
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
    sendMessage: async () => ({ ok: true })
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
      if (ret !== true && msg.type !== 'DOWNLOAD_MEDIA') {
        // synchronous sendResponse paths resolve immediately
      }
    } catch (e) { reject(e); }
  });
}

await message({ type: 'UPSERT_MEDIA_CANDIDATES', items: [
  { url: 'https://r1.googlevideo.com/videoplayback?itag=18', kind: 'video', mime: 'video/mp4', source: 'youtube-progressive', progressive: true, hasAudio: true, height: 360, bitrate: 500000 },
  { url: 'https://r1.googlevideo.com/videoplayback?itag=137&range=0-999', kind: 'video', mime: 'video/mp4', source: 'youtube-adaptive', height: 1080, bitrate: 3000000 },
  { url: 'https://r1.googlevideo.com/videoplayback?itag=140&range=0-999', kind: 'audio', mime: 'audio/mp4', source: 'youtube-adaptive', bitrate: 128000 }
] });

const yt = await message({ type: 'GET_MEDIA_CANDIDATES' });
assert.equal(yt.ok, true);
assert.equal(yt.items.length, 1, 'complete YouTube progressive stream should suppress separate adaptive tracks');
assert.equal(yt.items[0].source, 'youtube-progressive');
assert.equal(yt.items[0].hasAudio, true);

await message({ type: 'CLEAR_MEDIA_CANDIDATES' });
await message({ type: 'UPSERT_MEDIA_CANDIDATES', items: [
  { url: 'https://video.xx.fbcdn.net/o1/v/t2/f2/video.mp4?token=abc&bytestart=0&byteend=999', kind: 'video', mime: 'video/mp4', contentLength: 1000 },
  { url: 'https://video.xx.fbcdn.net/o1/v/t2/f2/video.mp4?token=abc&bytestart=1000&byteend=1999', kind: 'video', mime: 'video/mp4', contentLength: 1000 }
] });
const meta = await message({ type: 'GET_MEDIA_CANDIDATES' });
assert.equal(meta.items.length, 1, 'Meta byte-range variants should deduplicate to one media candidate');

console.log('service-worker smoke tests passed');

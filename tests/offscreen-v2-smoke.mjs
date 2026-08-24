import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let runtimeListener;
let savedName = '';
const total = 20000;
const firstChunk = new Uint8Array(4096).fill(1);
const fullChunk = new Uint8Array(total).fill(2);

async function mockFetch(url, options = {}) {
  const range = options?.headers?.Range || options?.headers?.range || '';
  if (range) {
    return new Response(fullChunk, {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(total),
        'content-range': `bytes 0-${total - 1}/${total}`
      }
    });
  }
  return new Response(firstChunk, {
    status: 206,
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(firstChunk.byteLength),
      'content-range': `bytes 0-${firstChunk.byteLength - 1}/${total}`
    }
  });
}

class FakeElement {
  constructor() { this.style = {}; }
  click() { savedName = this.download || ''; }
  remove() {}
  addEventListener() {}
  removeEventListener() {}
}

const chrome = {
  runtime: {
    onMessage: { addListener(fn) { runtimeListener = fn; } },
    sendMessage: async () => ({ ok: true })
  }
};

const TestURL = URL;
TestURL.createObjectURL = () => 'blob:test';
TestURL.revokeObjectURL = () => {};

const context = vm.createContext({
  chrome,
  fetch: mockFetch,
  Response,
  Headers,
  Request,
  Blob,
  URL: TestURL,
  DOMParser: class {},
  MediaRecorder: class {},
  MediaStream: class {},
  AudioContext: class {},
  document: {
    body: { appendChild() {} },
    createElement() { return new FakeElement(); }
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  Math,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Set,
  Map,
  Error
});

vm.runInContext(fs.readFileSync(new URL('../offscreen-v2.js', import.meta.url), 'utf8'), context, { filename: 'offscreen-v2.js' });
assert.equal(typeof runtimeListener, 'function', 'offscreen processor should register a message listener');

const result = await new Promise((resolve, reject) => {
  try {
    const ret = runtimeListener({
      target: 'offscreen',
      type: 'DOWNLOAD_DIRECT',
      url: 'https://r1.googlevideo.com/videoplayback?itag=18',
      originalUrl: 'https://r1.googlevideo.com/videoplayback?itag=18&range=0-4095',
      filenameBase: 'Range Test',
      tabId: 1,
      mime: 'video/mp4',
      kind: 'video'
    }, {}, resolve);
    assert.equal(ret, true, 'download message should keep sendResponse alive');
  } catch (e) { reject(e); }
});

assert.equal(result.ok, true, result.error || 'range recovery should succeed');
assert.equal(savedName, 'Range Test.mp4', 'recovered media should save with the expected filename');
console.log('offscreen v2.5 partial-range recovery smoke test passed');

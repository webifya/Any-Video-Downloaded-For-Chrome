const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen;
const mediaByTab = new Map();

const VIDEO_EXT_RE = /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i;
const AUDIO_EXT_RE = /\.(?:m4a|aac|mp3|opus|ogg)(?:$|[?#])/i;
const HLS_RE = /\.m3u8(?:$|[?#])/i;
const DASH_RE = /\.mpd(?:$|[?#])/i;
const REQUEST_FILTER = { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] };

function mediaKind(url = '', mime = '') {
  const m = String(mime).toLowerCase();
  if (DASH_RE.test(url) || /dash\+xml/.test(m)) return 'dash';
  if (HLS_RE.test(url) || /mpegurl|x-mpegurl/.test(m)) return 'hls';
  if (VIDEO_EXT_RE.test(url) || /^video\//.test(m)) return 'video';
  if (AUDIO_EXT_RE.test(url) || /^audio\//.test(m)) return 'audio';
  // Adaptive MP4/WebM streams often use extensionless signed URLs (YouTube/Facebook/Vimeo).
  if (/mime=(?:video|audio)%2F/i.test(url) || /[?&]mime=(?:video|audio)\//i.test(url)) {
    return /mime=audio/i.test(decodeURIComponent(url)) ? 'audio' : 'video';
  }
  return '';
}

function upsert(tabId, item) {
  if (!Number.isInteger(tabId) || tabId < 0 || !item?.url) return;
  const arr = mediaByTab.get(tabId) || [];
  const idx = arr.findIndex(x => x.url === item.url);
  const merged = { ...(idx >= 0 ? arr[idx] : {}), ...item, seenAt: Date.now() };
  if (idx >= 0) arr.splice(idx, 1);
  arr.unshift(merged);
  mediaByTab.set(tabId, arr.slice(0, 140));
}

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return;
  const kind = mediaKind(details.url);
  if (!kind) return;
  upsert(details.tabId, { url: details.url, kind, requestType: details.type || '', frameId: details.frameId, source: 'request' });
}, REQUEST_FILTER);

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0) return;
  let mime = '', contentLength = 0;
  for (const header of details.responseHeaders || []) {
    const name = String(header.name || '').toLowerCase();
    if (name === 'content-type') mime = header.value || '';
    else if (name === 'content-length') contentLength = Number(header.value || 0) || 0;
  }
  const kind = mediaKind(details.url, mime);
  if (!kind) return;
  upsert(details.tabId, { url: details.url, kind, mime, contentLength, requestType: details.type || '', frameId: details.frameId, source: 'response' });
}, REQUEST_FILTER, ['responseHeaders']);

chrome.tabs.onRemoved.addListener(tabId => mediaByTab.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading') mediaByTab.delete(tabId); });

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Assemble user-requested unencrypted HLS/DASH media segments into local downloadable files.'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function safeBase(name) {
  return (name || 'Video').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 170) || 'Video';
}

function extensionFor(url, mime = '', kind = 'video') {
  try {
    const path = new URL(url).pathname.toLowerCase();
    for (const ext of ['.mp4','.webm','.mov','.m4v','.m4a','.aac','.mp3','.opus','.ogg']) if (path.endsWith(ext)) return ext;
  } catch (_) {}
  if (kind === 'audio') {
    if (/webm|opus|ogg/i.test(mime)) return '.webm';
    if (/mpeg|mp3/i.test(mime)) return '.mp3';
    return '.m4a';
  }
  if (/webm/i.test(mime)) return '.webm';
  if (/quicktime/i.test(mime)) return '.mov';
  return '.mp4';
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'GET_MEDIA_CANDIDATES') {
    const tabId = sender.tab?.id;
    sendResponse({ ok: true, items: Number.isInteger(tabId) ? (mediaByTab.get(tabId) || []) : [] });
    return;
  }
  if (msg?.type === 'CLEAR_MEDIA_CANDIDATES') {
    const tabId = sender.tab?.id;
    if (Number.isInteger(tabId)) mediaByTab.delete(tabId);
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'MEDIA_PROGRESS' && Number.isInteger(msg.tabId)) {
    chrome.tabs.sendMessage(msg.tabId, { type:'DOWNLOAD_PROGRESS', percent:msg.percent, phase:msg.phase, current:msg.current, total:msg.total, text:msg.text }).catch(() => {});
    return;
  }
  if (msg?.type === 'DOWNLOAD_MEDIA') {
    (async () => {
      const filenameBase = safeBase(msg.filenameBase);
      const kind = msg.kind || mediaKind(msg.url, msg.mime);
      const tabId = sender.tab?.id;
      if (kind === 'hls' || kind === 'dash') {
        await ensureOffscreen();
        const response = await chrome.runtime.sendMessage({ target:'offscreen', type: kind === 'dash' ? 'DOWNLOAD_DASH' : 'DOWNLOAD_HLS', url:msg.url, filenameBase, tabId });
        sendResponse(response || { ok:false, error:'No response from segmented-media downloader.' });
        return;
      }
      const id = await chrome.downloads.download({
        url: msg.url,
        filename: `${filenameBase}${kind === 'audio' ? ' - audio' : ''}${extensionFor(msg.url, msg.mime, kind)}`,
        saveAs: false,
        conflictAction: 'uniquify'
      });
      sendResponse({ ok:true, message:`Download started (#${id}).` });
    })().catch(error => sendResponse({ ok:false, error:error.message || String(error) }));
    return true;
  }
});

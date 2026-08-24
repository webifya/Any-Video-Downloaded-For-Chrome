const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen;
const mediaByTab = new Map();

const VIDEO_EXT_RE = /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i;
const AUDIO_EXT_RE = /\.(?:m4a|aac|mp3|opus|ogg)(?:$|[?#])/i;
const HLS_RE = /\.m3u8(?:$|[?#])/i;
const DASH_RE = /\.mpd(?:$|[?#])/i;
const REQUEST_FILTER = { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] };

const YT_AUDIO_ITAGS = new Set([139,140,141,171,172,249,250,251,256,258,325,328,599,600]);

function decodedUrl(url = '') { try { return decodeURIComponent(url); } catch (_) { return url; } }
function hostname(url = '') { try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; } }
function isGoogleVideo(h='') { return /(?:^|\.)googlevideo\.com$/i.test(h); }
function isMetaCdn(h='') { return /(?:^|\.)fbcdn\.net$|(?:^|\.)cdninstagram\.com$/i.test(h); }
function isVimeoCdn(h='') { return /(?:^|\.)vimeocdn\.com$|(?:^|\.)akamaized\.net$/i.test(h); }

function youtubeItagKind(url = '') {
  if (!/googlevideo\.com\/videoplayback/i.test(url)) return '';
  try {
    const u = new URL(url);
    const itag = Number(u.searchParams.get('itag') || 0);
    const mimeParam = decodedUrl(u.searchParams.get('mime') || u.searchParams.get('type') || '');
    if (/^audio\//i.test(mimeParam) || YT_AUDIO_ITAGS.has(itag)) return 'audio';
    if (/^video\//i.test(mimeParam)) return 'video';
    if (itag > 0) return 'video';
  } catch (_) {}
  return '';
}

function platformPathKind(url = '') {
  const h = hostname(url);
  const d = decodedUrl(url);
  if (isVimeoCdn(h)) {
    if (/\/(?:sep\/)?audio\//i.test(d) || /audio[_/-](?:init|segment|\d+)/i.test(d)) return 'audio';
    if (/\/(?:sep\/)?video\//i.test(d) || /video[_/-](?:init|segment|\d+)/i.test(d)) return 'video';
  }
  if (isMetaCdn(h)) {
    if (/[?&](?:mime|type)=audio(?:%2F|\/)/i.test(d) || /\/audio\//i.test(d)) return 'audio';
    if (/[?&](?:mime|type)=video(?:%2F|\/)/i.test(d) || /\/video\//i.test(d)) return 'video';
  }
  return '';
}

function mediaKind(url = '', mime = '') {
  const m = String(mime).toLowerCase();
  if (DASH_RE.test(url) || /dash\+xml/.test(m)) return 'dash';
  if (HLS_RE.test(url) || /mpegurl|x-mpegurl/.test(m)) return 'hls';
  if (VIDEO_EXT_RE.test(url) || /^video\//.test(m)) return 'video';
  if (AUDIO_EXT_RE.test(url) || /^audio\//.test(m)) return 'audio';
  const yt = youtubeItagKind(url); if (yt) return yt;
  const d = decodedUrl(url);
  if (/[?&](?:mime|type)=video(?:%2F|\/)/i.test(d)) return 'video';
  if (/[?&](?:mime|type)=audio(?:%2F|\/)/i.test(d)) return 'audio';
  return platformPathKind(url);
}

function stripVolatileRangeParams(url = '') {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (isGoogleVideo(h)) {
      for (const k of ['range','rn','rbuf']) u.searchParams.delete(k);
    } else if (isMetaCdn(h)) {
      for (const k of ['bytestart','byteend','range','start','end']) u.searchParams.delete(k);
    } else if (isVimeoCdn(h)) {
      for (const k of ['range','rn','rbuf']) u.searchParams.delete(k);
    }
    return u.href;
  } catch (_) { return url; }
}

function canonicalMediaKey(item) {
  try {
    const u = new URL(item.url);
    const h = u.hostname.toLowerCase();
    if (isGoogleVideo(h)) return `youtube:${item.kind}:${u.searchParams.get('itag') || item.itag || u.pathname}`;
    if (isMetaCdn(h) || isVimeoCdn(h)) return `${isMetaCdn(h) ? 'meta' : 'vimeo'}:${item.kind}:${stripVolatileRangeParams(u.href)}`;
    if (item.kind === 'hls' || item.kind === 'dash') {
      const c = new URL(u.href);
      for (const k of ['token','sig','signature','expires','exp']) c.searchParams.delete(k);
      return `${item.kind}:${c.origin}${c.pathname}`;
    }
    return `${item.kind}:${u.href.split('#')[0]}`;
  } catch (_) { return `${item.kind}:${item.url}`; }
}

function upsert(tabId, incoming) {
  if (!Number.isInteger(tabId) || tabId < 0 || !incoming?.url) return;
  const kind = incoming.kind || mediaKind(incoming.url, incoming.mime);
  if (!kind) return;
  const item = { ...incoming, kind };
  const arr = mediaByTab.get(tabId) || [];
  const key = canonicalMediaKey(item);
  const idx = arr.findIndex(x => canonicalMediaKey(x) === key);
  const previous = idx >= 0 ? arr[idx] : {};
  const merged = {
    ...previous,
    ...item,
    contentLength: Number(item.contentLength || 0) || Number(previous.contentLength || 0),
    totalLength: Number(item.totalLength || 0) || Number(previous.totalLength || 0),
    width: Number(item.width || 0) || Number(previous.width || 0),
    height: Number(item.height || 0) || Number(previous.height || 0),
    bitrate: Number(item.bitrate || 0) || Number(previous.bitrate || 0),
    qualityLabel: item.qualityLabel || previous.qualityLabel || '',
    progressive: Boolean(item.progressive || previous.progressive),
    hasAudio: Boolean(item.hasAudio || previous.hasAudio),
    source: item.source || previous.source || '',
    seenAt: Date.now()
  };
  if (idx >= 0) arr.splice(idx, 1);
  arr.unshift(merged);
  mediaByTab.set(tabId, arr.slice(0, 180));
}

function itemsForTab(tabId) {
  const items = mediaByTab.get(tabId) || [];
  // If YouTube exposes a complete progressive stream (video+audio together), prefer it and
  // suppress separate adaptive tracks. This gives the user one playable file whenever possible.
  const completeYoutube = items
    .filter(x => x.kind === 'video' && x.source === 'youtube-progressive' && x.hasAudio)
    .sort((a,b) => (b.height - a.height) || (b.bitrate - a.bitrate) || ((b.contentLength || 0) - (a.contentLength || 0)));
  if (completeYoutube.length) return [completeYoutube[0]];
  return items;
}

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return;
  const kind = mediaKind(details.url); if (!kind) return;
  upsert(details.tabId, { url: details.url, kind, requestType: details.type || '', frameId: details.frameId, source: 'request' });
}, REQUEST_FILTER);

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0) return;
  let mime = '', contentLength = 0, totalLength = 0, contentDisposition = '';
  for (const header of details.responseHeaders || []) {
    const name = String(header.name || '').toLowerCase();
    const value = header.value || '';
    if (name === 'content-type') mime = value;
    else if (name === 'content-length') contentLength = Number(value) || 0;
    else if (name === 'content-disposition') contentDisposition = value;
    else if (name === 'content-range') {
      const m = value.match(/\/\s*(\d+)\s*$/);
      if (m) totalLength = Number(m[1]) || 0;
    }
  }
  const kind = mediaKind(details.url, mime); if (!kind) return;
  upsert(details.tabId, { url: details.url, kind, mime, contentLength, totalLength, contentDisposition, requestType: details.type || '', frameId: details.frameId, source: 'response' });
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
      justification: 'Download and assemble user-requested accessible media locally, including signed direct media, HLS, and DASH streams.'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function safeBase(name) { return (name || 'Video').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 170) || 'Video'; }
function extensionFor(url, mime = '', kind = 'video') {
  try { const path = new URL(url).pathname.toLowerCase(); for (const ext of ['.mp4','.webm','.mov','.m4v','.m4a','.aac','.mp3','.opus','.ogg']) if (path.endsWith(ext)) return ext; } catch (_) {}
  if (kind === 'audio') { if (/webm|opus|ogg/i.test(mime)) return '.webm'; if (/mpeg|mp3/i.test(mime)) return '.mp3'; return '.m4a'; }
  if (/webm/i.test(mime)) return '.webm'; if (/quicktime/i.test(mime)) return '.mov'; return '.mp4';
}
function needsFetchedDownload(url='') {
  const h=hostname(url);
  return isGoogleVideo(h) || isMetaCdn(h) || isVimeoCdn(h);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'GET_MEDIA_CANDIDATES') {
    const tabId = sender.tab?.id;
    sendResponse({ ok: true, items: Number.isInteger(tabId) ? itemsForTab(tabId) : [] });
    return;
  }
  if (msg?.type === 'UPSERT_MEDIA_CANDIDATES') {
    const tabId = sender.tab?.id;
    if (Number.isInteger(tabId)) {
      for (const item of Array.isArray(msg.items) ? msg.items : []) upsert(tabId, { ...item, source: item.source || 'player-response' });
      sendResponse({ ok: true });
    } else sendResponse({ ok: false });
    return;
  }
  if (msg?.type === 'CLEAR_MEDIA_CANDIDATES') {
    const tabId = sender.tab?.id; if (Number.isInteger(tabId)) mediaByTab.delete(tabId); sendResponse({ ok: true }); return;
  }
  if (msg?.type === 'MEDIA_PROGRESS' && Number.isInteger(msg.tabId)) {
    chrome.tabs.sendMessage(msg.tabId, { type: 'DOWNLOAD_PROGRESS', percent: msg.percent, phase: msg.phase, current: msg.current, total: msg.total, text: msg.text }).catch(() => {}); return;
  }
  if (msg?.type === 'DOWNLOAD_MEDIA') {
    (async () => {
      const filenameBase = safeBase(msg.filenameBase);
      const kind = msg.kind || mediaKind(msg.url, msg.mime);
      const tabId = sender.tab?.id;
      if (!kind) throw new Error('Unsupported or expired media URL. Play the video and scan again.');
      if (kind === 'hls' || kind === 'dash' || needsFetchedDownload(msg.url)) {
        await ensureOffscreen();
        const type = kind === 'dash' ? 'DOWNLOAD_DASH' : kind === 'hls' ? 'DOWNLOAD_HLS' : 'DOWNLOAD_DIRECT';
        const response = await chrome.runtime.sendMessage({
          target:'offscreen', type, url: stripVolatileRangeParams(msg.url), originalUrl: msg.url,
          filenameBase, tabId, mime:msg.mime || '', kind, pageUrl: msg.pageUrl || sender.tab?.url || ''
        });
        sendResponse(response || { ok:false, error:'No response from media downloader.' });
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
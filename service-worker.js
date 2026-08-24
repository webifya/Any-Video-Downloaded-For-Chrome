const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen;
const mediaByTab = new Map();
const contextByTab = new Map();
const loadedTabs = new Set();
const restorePromises = new Map();
const persistTimers = new Map();
const SESSION_PREFIX = 'avd-tab-';

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
    if (isGoogleVideo(h)) for (const k of ['range','rn','rbuf']) u.searchParams.delete(k);
    else if (isMetaCdn(h)) for (const k of ['bytestart','byteend','range','start','end']) u.searchParams.delete(k);
    else if (isVimeoCdn(h)) for (const k of ['range','rn','rbuf']) u.searchParams.delete(k);
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
    // Players commonly express one logical file as many URL-level byte ranges.
    // Ignore only range selectors here; retain tokens/signatures and all identity params.
    for (const k of ['range','rn','rbuf','bytestart','byteend','start','end']) u.searchParams.delete(k);
    return `${item.kind}:${u.href.split('#')[0]}`;
  } catch (_) { return `${item.kind}:${item.url}`; }
}

function sessionKey(tabId) { return `${SESSION_PREFIX}${tabId}`; }
function isExpiredMediaUrl(item, now = Date.now()) {
  try {
    const u = new URL(item?.url || '');
    const raw = u.searchParams.get('expire') || u.searchParams.get('expires') || u.searchParams.get('exp') || '';
    if (raw && /^\d+$/.test(raw)) {
      const value = Number(raw);
      const expiresAt = value > 100000000000 ? value : value * 1000;
      if (expiresAt <= now + 60000) return true;
    }
  } catch (_) {}
  return Number(item?.seenAt || 0) > 0 && Number(item.seenAt) < now - 4 * 60 * 60 * 1000;
}
function compactItem(item) {
  return {
    url:item.url, originalUrl:item.originalUrl || '', kind:item.kind, mime:item.mime || '', source:item.source || '',
    contentLength:Number(item.contentLength || 0), totalLength:Number(item.totalLength || 0), width:Number(item.width || 0),
    height:Number(item.height || 0), bitrate:Number(item.bitrate || 0), qualityLabel:item.qualityLabel || '', itag:Number(item.itag || 0), frameId:Number.isInteger(item.frameId)?item.frameId:0,
    hasAudio:item.hasAudio, hasVideo:item.hasVideo, isProgressive:!!item.isProgressive, seenAt:Number(item.seenAt || Date.now())
  };
}
function queuePersist(tabId) {
  if (!chrome.storage?.session || !Number.isInteger(tabId)) return;
  clearTimeout(persistTimers.get(tabId));
  persistTimers.set(tabId, setTimeout(() => {
    persistTimers.delete(tabId);
    const value = { context:contextByTab.get(tabId) || '', items:(mediaByTab.get(tabId) || []).slice(0, 60).map(compactItem) };
    chrome.storage.session.set({ [sessionKey(tabId)]:value }).catch(() => {});
  }, 150));
}
async function restoreTab(tabId) {
  if (loadedTabs.has(tabId) || !chrome.storage?.session) return;
  if (restorePromises.has(tabId)) return restorePromises.get(tabId);
  const restoring = (async () => {
    try {
      const value = (await chrome.storage.session.get(sessionKey(tabId)))?.[sessionKey(tabId)];
      if (value?.context) contextByTab.set(tabId, value.context);
      if (!mediaByTab.has(tabId) && Array.isArray(value?.items)) {
        for (const item of value.items.slice(0, 60).filter(item => !isExpiredMediaUrl(item)).reverse()) upsert(tabId, item, false);
      }
    } catch (_) {}
    finally { loadedTabs.add(tabId); restorePromises.delete(tabId); }
  })();
  restorePromises.set(tabId, restoring);
  return restoring;
}
async function upsertAfterRestore(tabId, incoming) {
  await restoreTab(tabId);
  upsert(tabId, incoming);
}

function upsert(tabId, incoming, persist = true) {
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
    hasAudio: item.hasAudio !== undefined ? !!item.hasAudio : previous.hasAudio,
    hasVideo: item.hasVideo !== undefined ? !!item.hasVideo : previous.hasVideo,
    isProgressive: item.isProgressive !== undefined ? !!item.isProgressive : previous.isProgressive,
    seenAt: Date.now()
  };
  if (idx >= 0) arr.splice(idx, 1);
  arr.unshift(merged);
  mediaByTab.set(tabId, arr.slice(0, 180));
  loadedTabs.add(tabId);
  if (persist) queuePersist(tabId);
}

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return;
  const kind = mediaKind(details.url); if (!kind) return;
  upsertAfterRestore(details.tabId, { url: details.url, kind, requestType: details.type || '', frameId: details.frameId, source: 'request' }).catch(() => {});
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
  upsertAfterRestore(details.tabId, { url: details.url, kind, mime, contentLength, totalLength, contentDisposition, requestType: details.type || '', frameId: details.frameId, source: 'response' }).catch(() => {});
}, REQUEST_FILTER, ['responseHeaders']);

chrome.tabs.onRemoved.addListener(tabId => {
  mediaByTab.delete(tabId); contextByTab.delete(tabId); loadedTabs.delete(tabId); restorePromises.delete(tabId);
  clearTimeout(persistTimers.get(tabId)); persistTimers.delete(tabId);
  chrome.storage?.session?.remove(sessionKey(tabId)).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    mediaByTab.delete(tabId); contextByTab.delete(tabId); loadedTabs.add(tabId);
    chrome.storage?.session?.remove(sessionKey(tabId)).catch(() => {});
  }
});

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Download, assemble, and locally merge user-requested accessible media without remote executable code.'
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
function serializeMedia(item = {}) {
  return {
    url: stripVolatileRangeParams(item.url || ''),
    originalUrl: item.url || '',
    kind: item.kind || mediaKind(item.url, item.mime),
    mime: item.mime || '',
    bitrate: Number(item.bitrate || 0),
    width: Number(item.width || 0),
    height: Number(item.height || 0),
    qualityLabel: item.qualityLabel || ''
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'GET_MEDIA_CANDIDATES') {
    const tabId = sender.tab?.id;
    (async () => { if (Number.isInteger(tabId)) await restoreTab(tabId);const items=Number.isInteger(tabId)?(mediaByTab.get(tabId)||[]).filter(item=>!isExpiredMediaUrl(item)):[];if(Number.isInteger(tabId)&&items.length!==(mediaByTab.get(tabId)||[]).length){mediaByTab.set(tabId,items);queuePersist(tabId);}sendResponse({ok:true,items}); })();
    return true;
  }
  if (msg?.type === 'UPSERT_MEDIA_CANDIDATES') {
    const tabId = sender.tab?.id;
    (async () => {
      if (!Number.isInteger(tabId)) { sendResponse({ ok:false }); return; }
      await restoreTab(tabId);
      for (const item of Array.isArray(msg.items) ? msg.items : []) upsert(tabId, { ...item, source:item.source || 'player-response' });
      sendResponse({ ok:true });
    })().catch(() => sendResponse({ ok:false }));
    return true;
  }
  if (msg?.type === 'CLEAR_MEDIA_CANDIDATES') {
    const tabId = sender.tab?.id; if (Number.isInteger(tabId)) { mediaByTab.delete(tabId); loadedTabs.add(tabId); queuePersist(tabId); } sendResponse({ ok: true }); return;
  }
  if (msg?.type === 'PAGE_MEDIA_CONTEXT') {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) { sendResponse({ ok:false }); return; }
    (async () => {
      await restoreTab(tabId);
      const key = `${String(msg.url || sender.tab?.url || '')}|${String(msg.title || '').trim().toLowerCase()}`;
      if (key && contextByTab.get(tabId) !== key) { contextByTab.set(tabId, key); mediaByTab.delete(tabId); queuePersist(tabId); }
      sendResponse({ ok:true, context:key });
    })();
    return true;
  }
  if (msg?.type === 'MEDIA_PROGRESS' && Number.isInteger(msg.tabId)) {
    chrome.tabs.sendMessage(msg.tabId, { type: 'DOWNLOAD_PROGRESS', percent: msg.percent, phase: msg.phase, current: msg.current, total: msg.total, text: msg.text }).catch(() => {}); return;
  }
  if (msg?.type === 'FRAME_CAPTURE_PROGRESS') {
    const tabId=sender.tab?.id;if(Number.isInteger(tabId))chrome.tabs.sendMessage(tabId,{type:'DOWNLOAD_PROGRESS',percent:msg.percent,text:msg.text,phase:'frame-capture'}).catch(()=>{});return;
  }
  if (msg?.type === 'CAPTURE_FRAME_VIDEO') {
    (async()=>{const tabId=sender.tab?.id,frameId=Number(msg.frameId);if(!Number.isInteger(tabId)||!Number.isInteger(frameId)||frameId<=0)throw new Error('Embedded player frame was not identified.');const response=await chrome.tabs.sendMessage(tabId,{type:'START_FRAME_VIDEO_CAPTURE',label:msg.label||'HLS video',filenameBase:safeBase(msg.filenameBase)},{frameId});sendResponse(response||{ok:false,error:'Embedded player did not respond.'});})().catch(error=>sendResponse({ok:false,error:error.message||String(error)}));return true;
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
        const response = await chrome.runtime.sendMessage({ target:'offscreen', type, url: stripVolatileRangeParams(msg.url), originalUrl: msg.url, filenameBase, tabId, mime:msg.mime || '', kind, pageUrl: msg.pageUrl || sender.tab?.url || '' });
        sendResponse(response || { ok:false, error:'No response from media downloader.' });
        return;
      }
      const id = await chrome.downloads.download({ url: msg.url, filename: `${filenameBase}${kind === 'audio' ? ' - audio' : ''}${extensionFor(msg.url, msg.mime, kind)}`, saveAs: false, conflictAction: 'uniquify' });
      sendResponse({ ok:true, message:`Download started (#${id}).` });
    })().catch(error => sendResponse({ ok:false, error:error.message || String(error) }));
    return true;
  }
  if (msg?.type === 'DOWNLOAD_MERGED_MEDIA') {
    (async () => {
      const tabId = sender.tab?.id;
      if (!msg.video?.url || !msg.audio?.url) throw new Error('Both video and audio streams are required for merging.');
      await ensureOffscreen();
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen', type: 'DOWNLOAD_MERGED_MEDIA',
        video: serializeMedia(msg.video), audio: serializeMedia(msg.audio),
        filenameBase: safeBase(msg.filenameBase), tabId,
        pageUrl: msg.pageUrl || sender.tab?.url || ''
      });
      sendResponse(response || { ok:false, error:'No response from local merger.' });
    })().catch(error => sendResponse({ ok:false, error:error.message || String(error) }));
    return true;
  }
});

const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen;
const mediaByTab = new Map();

const VIDEO_EXT_RE = /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i;
const AUDIO_EXT_RE = /\.(?:m4a|aac|mp3|opus|ogg)(?:$|[?#])/i;
const HLS_RE = /\.m3u8(?:$|[?#])/i;
const DASH_RE = /\.mpd(?:$|[?#])/i;
const REQUEST_FILTER = { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] };

const YT_AUDIO_ITAGS = new Set([139,140,141,171,172,249,250,251,256,258,325,328,599,600]);
const YT_VIDEO_ITAGS = new Set([
  18,22,37,38,59,78,133,134,135,136,137,138,160,242,243,244,245,246,247,248,
  264,266,271,272,278,298,299,302,303,308,313,315,330,331,332,333,334,335,336,
  337,394,395,396,397,398,399,400,401,571,694,695,696,697,698,699,700,701,702
]);

function decodedUrl(url = '') { try { return decodeURIComponent(url); } catch (_) { return url; } }
function hostname(url = '') { try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; } }

function youtubeItagKind(url = '') {
  if (!/googlevideo\.com\/videoplayback/i.test(url)) return '';
  try {
    const u = new URL(url);
    const itag = Number(u.searchParams.get('itag') || 0);
    if (YT_AUDIO_ITAGS.has(itag)) return 'audio';
    if (YT_VIDEO_ITAGS.has(itag)) return 'video';
    const mime = decodedUrl(u.searchParams.get('mime') || u.searchParams.get('type') || '');
    if (/^audio\//i.test(mime)) return 'audio';
    if (/^video\//i.test(mime)) return 'video';
    if (itag > 0) return 'video';
  } catch (_) {}
  return '';
}

function platformPathKind(url = '') {
  const h = hostname(url);
  const d = decodedUrl(url);
  if (/vimeocdn\.com$|\.vimeocdn\.com$|akamaized\.net$|\.akamaized\.net$/i.test(h)) {
    if (/\/(?:sep\/)?audio\//i.test(d) || /audio[_/-](?:init|segment|\d+)/i.test(d)) return 'audio';
    if (/\/(?:sep\/)?video\//i.test(d) || /video[_/-](?:init|segment|\d+)/i.test(d)) return 'video';
  }
  if (/fbcdn\.net$|\.fbcdn\.net$|cdninstagram\.com$|\.cdninstagram\.com$/i.test(h)) {
    if (/[?&](?:mime|type)=audio(?:%2F|\/)/i.test(d) || /\/audio\//i.test(d)) return 'audio';
    if (/[?&](?:mime|type)=video(?:%2F|\/)/i.test(d) || /\/video\//i.test(d)) return 'video';
  }
  return '';
}

function mediaKind(url = '', mime = '') {
  const m = String(mime).toLowerCase();
  if (DASH_RE.test(url) || /(?:application\/)?dash\+xml/.test(m)) return 'dash';
  if (HLS_RE.test(url) || /mpegurl|x-mpegurl/.test(m)) return 'hls';
  if (VIDEO_EXT_RE.test(url) || /^video\//.test(m)) return 'video';
  if (AUDIO_EXT_RE.test(url) || /^audio\//.test(m)) return 'audio';
  const ytKind = youtubeItagKind(url); if (ytKind) return ytKind;
  const decoded = decodedUrl(url);
  if (/[?&](?:mime|type)=video(?:%2F|\/)/i.test(decoded)) return 'video';
  if (/[?&](?:mime|type)=audio(?:%2F|\/)/i.test(decoded)) return 'audio';
  return platformPathKind(url);
}

function canonicalMediaKey(item) {
  try {
    const u = new URL(item.url); const h = u.hostname.toLowerCase();
    if (/\.googlevideo\.com$|^googlevideo\.com$/i.test(h)) {
      const itag = u.searchParams.get('itag') || item.itag || '';
      return `youtube:${item.kind}:${itag || u.pathname}`;
    }
    if (/fbcdn\.net$|\.fbcdn\.net$|cdninstagram\.com$|\.cdninstagram\.com$/i.test(h)) {
      const clone = new URL(u.href); for (const key of ['bytestart','byteend','range','start','end']) clone.searchParams.delete(key);
      return `meta:${item.kind}:${clone.origin}${clone.pathname}?${clone.searchParams.toString()}`;
    }
    if (/vimeocdn\.com$|\.vimeocdn\.com$|akamaized\.net$|\.akamaized\.net$/i.test(h)) {
      const clone = new URL(u.href); for (const key of ['range','rn','rbuf']) clone.searchParams.delete(key);
      return `vimeo:${item.kind}:${clone.origin}${clone.pathname}?${clone.searchParams.toString()}`;
    }
    return `${item.kind}:${u.href}`;
  } catch (_) { return `${item.kind}:${item.url}`; }
}

function upsert(tabId, item) {
  if (!Number.isInteger(tabId) || tabId < 0 || !item?.url) return;
  const kind = item.kind || mediaKind(item.url, item.mime); if (!kind) return;
  item = { ...item, kind };
  const arr = mediaByTab.get(tabId) || [];
  const key = canonicalMediaKey(item);
  const idx = arr.findIndex(x => canonicalMediaKey(x) === key);
  const merged = { ...(idx >= 0 ? arr[idx] : {}), ...item, seenAt: Date.now() };
  if (idx >= 0) arr.splice(idx, 1);
  arr.unshift(merged);
  mediaByTab.set(tabId, arr.slice(0, 160));
}

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return;
  const kind = mediaKind(details.url); if (!kind) return;
  upsert(details.tabId, { url: details.url, kind, requestType: details.type || '', frameId: details.frameId, source: 'request' });
}, REQUEST_FILTER);

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0) return;
  let mime = '', contentLength = 0, acceptRanges = '';
  for (const header of details.responseHeaders || []) {
    const name = String(header.name || '').toLowerCase();
    if (name === 'content-type') mime = header.value || '';
    else if (name === 'content-length') contentLength = Number(header.value || 0) || 0;
    else if (name === 'accept-ranges') acceptRanges = header.value || '';
  }
  const kind = mediaKind(details.url, mime); if (!kind) return;
  upsert(details.tabId, { url: details.url, kind, mime, contentLength, acceptRanges, requestType: details.type || '', frameId: details.frameId, source: 'response' });
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
  return /googlevideo\.com$|\.googlevideo\.com$|fbcdn\.net$|\.fbcdn\.net$|cdninstagram\.com$|\.cdninstagram\.com$|vimeocdn\.com$|\.vimeocdn\.com$|akamaized\.net$|\.akamaized\.net$/i.test(h);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'GET_MEDIA_CANDIDATES') {
    const tabId = sender.tab?.id; sendResponse({ ok: true, items: Number.isInteger(tabId) ? (mediaByTab.get(tabId) || []) : [] }); return;
  }
  if (msg?.type === 'UPSERT_MEDIA_CANDIDATES') {
    const tabId = sender.tab?.id;
    if (Number.isInteger(tabId)) { for (const item of Array.isArray(msg.items) ? msg.items : []) upsert(tabId, { ...item, source: item.source || 'player-response' }); sendResponse({ ok: true }); }
    else sendResponse({ ok: false });
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
      if (kind === 'hls' || kind === 'dash' || needsFetchedDownload(msg.url)) {
        await ensureOffscreen();
        const type = kind === 'dash' ? 'DOWNLOAD_DASH' : kind === 'hls' ? 'DOWNLOAD_HLS' : 'DOWNLOAD_DIRECT';
        const response = await chrome.runtime.sendMessage({ target:'offscreen', type, url:msg.url, filenameBase, tabId, mime:msg.mime || '', kind });
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

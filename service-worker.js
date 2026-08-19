const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen;
const mediaByTab = new Map();

function isInteresting(url) {
  return /\.m3u8(?:$|[?#])/i.test(url) || /(?:m3u8|playlist|manifest)/i.test(url) || /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i.test(url);
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId < 0 || !isInteresting(details.url)) return;
  const arr = mediaByTab.get(details.tabId) || [];
  const filtered = arr.filter(x => x.url !== details.url);
  filtered.unshift({ url: details.url, timeStamp: details.timeStamp || Date.now(), type: details.type || '' });
  mediaByTab.set(details.tabId, filtered.slice(0, 80));
  chrome.tabs.sendMessage(details.tabId, { type: 'MEDIA_SEEN', url: details.url }).catch(() => {});
}, { urls: ['<all_urls>'] });

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
      justification: 'Download course HLS segments, assemble them and save a local MP4 Blob.'
    }).finally(() => creatingOffscreen = null);
  }
  await creatingOffscreen;
}

function extensionFor(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    for (const ext of ['.mp4', '.webm', '.mov', '.m4v']) if (path.endsWith(ext)) return ext;
  } catch (_) {}
  return '.mp4';
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'CLEAR_MEDIA_CANDIDATES') {
    const tabId = sender.tab?.id;
    if (tabId != null) mediaByTab.delete(tabId);
    sendResponse({ ok: true });
    return;
  }

  if (msg?.type === 'GET_MEDIA_CANDIDATES') {
    const tabId = sender.tab?.id;
    sendResponse({ ok: true, items: tabId == null ? [] : (mediaByTab.get(tabId) || []) });
    return;
  }

  if (msg?.type === 'HLS_PROGRESS' && Number.isInteger(msg.tabId)) {
    chrome.tabs.sendMessage(msg.tabId, {
      type: 'DOWNLOAD_PROGRESS',
      percent: msg.percent,
      phase: msg.phase,
      current: msg.current,
      total: msg.total,
      text: msg.text
    }).catch(() => {});
    return;
  }

  if (msg?.type === 'DOWNLOAD_MEDIA') {
    (async () => {
      const filenameBase = (msg.filenameBase || 'GHL Course Video').replace(/[\\/:*?"<>|]+/g, '-');
      const isHls = /\.m3u8(?:$|[?#])/i.test(msg.url) || /m3u8|playlist|manifest/i.test(msg.url);
      const tabId = sender.tab?.id;

      if (!isHls) {
        const id = await chrome.downloads.download({
          url: msg.url,
          filename: `${filenameBase}${extensionFor(msg.url)}`,
          saveAs: false,
          conflictAction: 'uniquify'
        });
        sendResponse({ ok: true, message: `Download started (#${id}).` });
        return;
      }

      await ensureOffscreen();
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen', type: 'DOWNLOAD_HLS', url: msg.url, filenameBase, tabId
      });
      sendResponse(response || { ok: false, error: 'No response from HLS downloader.' });
    })().catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
});

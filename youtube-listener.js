(() => {
  if (!/(^|\.)youtube\.com$/i.test(location.hostname)) return;

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'ANY_VIDEO_DOWNLOADER_YOUTUBE' || data.type !== 'STREAMS') return;
    const items = Array.isArray(data.items) ? data.items.filter(x => x && x.url && (x.kind === 'video' || x.kind === 'audio')) : [];
    if (!items.length) return;
    chrome.runtime.sendMessage({ type: 'UPSERT_MEDIA_CANDIDATES', items }).catch(() => {});
  }, false);
})();
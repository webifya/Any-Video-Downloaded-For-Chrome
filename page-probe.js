(() => {
  const sent = new Set();
  const RE = /\.(?:mp4|m4v|webm|mov|m3u8)(?:$|[?#])/i;

  function collect() {
    const items = [];
    const push = (url, source) => {
      if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
      if (!RE.test(url) && !/m3u8|playlist|manifest/i.test(url)) return;
      if (sent.has(url)) return;
      sent.add(url);
      items.push({ url, source });
    };

    document.querySelectorAll('video, video source').forEach(el => {
      push(el.currentSrc, 'dom');
      push(el.src, 'dom');
      push(el.getAttribute?.('src'), 'dom');
    });

    try {
      performance.getEntriesByType('resource').forEach(entry => push(entry.name, 'performance'));
    } catch (_) {}

    if (items.length) {
      window.postMessage({ source: 'PAGE_VIDEO_DOWNLOADER_PROBE', type: 'MEDIA_URLS', items }, '*');
    }
  }

  collect();
  const observer = new MutationObserver(collect);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  setInterval(collect, 2000);
})();

(() => {
  const MEDIA_RE = /\.(?:mp4|m4v|webm|mov|m3u8)(?:$|[?#])/i;

  function collect() {
    const urls = new Set();

    document.querySelectorAll('video, video source').forEach((el) => {
      for (const value of [el.currentSrc, el.src, el.getAttribute?.('src')]) {
        if (value && !value.startsWith('blob:')) urls.add(value);
      }
    });

    try {
      performance.getEntriesByType('resource').forEach((entry) => {
        const u = entry.name || '';
        if (MEDIA_RE.test(u) || /m3u8|playlist|manifest/i.test(u)) urls.add(u);
      });
    } catch (_) {}

    window.postMessage({
      source: 'GHL_VIDEO_DOWNLOADER_PROBE',
      type: 'MEDIA_URLS',
      urls: [...urls]
    }, '*');
  }

  collect();
  const timer = setInterval(collect, 2500);
  window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
})();

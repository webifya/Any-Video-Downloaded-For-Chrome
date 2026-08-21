(() => {
  if (window.top !== window.self) return;
  if (/^(chrome|edge|about|moz-extension|chrome-extension):/i.test(location.protocol)) return;

  // Some players (including iframe/custom players) expose no <video> element in
  // the top page. The main lightweight content script intentionally waits for a
  // video-related DOM mutation before showing its launcher. Trigger exactly one
  // zero-network sentinel mutation so the launcher is available on those pages
  // too, while media detection itself still happens only when the user opens it.
  function wakeLauncher() {
    if (document.getElementById('page-video-downloader-launcher')) return;
    const sentinel = document.createElement('video');
    sentinel.setAttribute('data-avd-launcher-sentinel', '1');
    sentinel.preload = 'none';
    sentinel.muted = true;
    sentinel.style.cssText = 'display:none!important;width:0!important;height:0!important;';
    (document.body || document.documentElement).appendChild(sentinel);
    setTimeout(() => sentinel.remove(), 1200);
  }

  if ('requestIdleCallback' in window) requestIdleCallback(wakeLauncher, { timeout: 1200 });
  else setTimeout(wakeLauncher, 350);
})();

(() => {
  if (!/(^|\.)youtube\.com$/i.test(location.hostname)) return;

  const AUDIO_ITAGS = new Set([139,140,141,171,172,249,250,251,256,258,325,328,599,600]);

  function emitFromResponse(resp) {
    try {
      const data = typeof resp === 'string' ? JSON.parse(resp) : resp;
      const streaming = data?.streamingData;
      if (!streaming) return;
      const formats = [...(streaming.formats || []), ...(streaming.adaptiveFormats || [])];
      const items = [];
      for (const f of formats) {
        const rawUrl = f?.url || '';
        if (!rawUrl) continue;
        const mime = String(f.mimeType || '').split(';')[0];
        const itag = Number(f.itag || 0);
        const kind = mime.startsWith('audio/') || AUDIO_ITAGS.has(itag) ? 'audio' : mime.startsWith('video/') ? 'video' : '';
        if (!kind) continue;
        items.push({
          url: rawUrl,
          kind,
          mime,
          contentLength: Number(f.contentLength || 0) || 0,
          bitrate: Number(f.bitrate || f.averageBitrate || 0) || 0,
          width: Number(f.width || 0) || 0,
          height: Number(f.height || 0) || 0,
          fps: Number(f.fps || 0) || 0,
          qualityLabel: f.qualityLabel || '',
          itag
        });
      }
      if (items.length) window.postMessage({ source: 'ANY_VIDEO_DOWNLOADER_YOUTUBE', type: 'STREAMS', items }, '*');
    } catch (_) {}
  }

  function probe() {
    try { emitFromResponse(window.ytInitialPlayerResponse); } catch (_) {}
    try { emitFromResponse(window.ytplayer?.config?.args?.player_response); } catch (_) {}
    try {
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') emitFromResponse(player.getPlayerResponse());
    } catch (_) {}
  }

  // Repeat initial probes so the isolated-world bridge has time to attach its message listener.
  probe();
  setTimeout(probe, 300);
  setTimeout(probe, 900);
  setTimeout(probe, 1800);
  setTimeout(probe, 3200);

  let lastHref = location.href;
  const onNavigate = () => {
    if (location.href !== lastHref) lastHref = location.href;
    setTimeout(probe, 200);
    setTimeout(probe, 700);
    setTimeout(probe, 1500);
    setTimeout(probe, 2800);
  };
  window.addEventListener('yt-navigate-finish', onNavigate, true);
  window.addEventListener('yt-page-data-updated', onNavigate, true);
  document.addEventListener('loadedmetadata', probe, true);
})();
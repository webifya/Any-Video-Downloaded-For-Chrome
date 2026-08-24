(() => {
  if (!/(^|\.)youtube\.com$/i.test(location.hostname)) return;

  const AUDIO_ITAGS = new Set([139,140,141,171,172,249,250,251,256,258,325,328,599,600]);

  function accessibleFormatUrl(format) {
    if (format?.url) return format.url;
    try {
      const cipher = new URLSearchParams(format?.signatureCipher || format?.cipher || '');
      const url = cipher.get('url');
      const signature = cipher.get('sig') || cipher.get('signature');
      if (!url || !signature || cipher.get('s')) return '';
      const out = new URL(url);
      out.searchParams.set(cipher.get('sp') || 'signature', signature);
      return out.href;
    } catch (_) { return ''; }
  }

  function emitFromResponse(resp) {
    try {
      const data = typeof resp === 'string' ? JSON.parse(resp) : resp;
      const streaming = data?.streamingData;
      if (!streaming) return;

      const progressive = Array.isArray(streaming.formats) ? streaming.formats : [];
      const adaptive = Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : [];
      const items = [];

      const add = (f, source, isProgressive) => {
        const rawUrl = accessibleFormatUrl(f);
        if (!rawUrl) return;
        const fullMime = String(f.mimeType || '');
        const mime = fullMime.split(';')[0];
        const itag = Number(f.itag || 0);
        const kind = mime.startsWith('audio/') || AUDIO_ITAGS.has(itag) ? 'audio' : mime.startsWith('video/') ? 'video' : '';
        if (!kind) return;

        const hasAudio = !!(isProgressive && kind === 'video') || !!f.audioQuality || !!f.audioSampleRate || !!f.audioChannels;
        const hasVideo = kind === 'video';
        items.push({
          url: rawUrl,
          kind,
          mime,
          fullMime,
          source,
          isProgressive: !!isProgressive,
          hasAudio,
          hasVideo,
          contentLength: Number(f.contentLength || 0) || 0,
          bitrate: Number(f.bitrate || f.averageBitrate || 0) || 0,
          width: Number(f.width || 0) || 0,
          height: Number(f.height || 0) || 0,
          fps: Number(f.fps || 0) || 0,
          qualityLabel: f.qualityLabel || '',
          itag
        });
      };

      for (const f of progressive) add(f, 'youtube-progressive', true);
      for (const f of adaptive) add(f, 'youtube-adaptive', false);

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

  let scheduled = 0;
  const scheduleProbe = (delay = 120) => {
    clearTimeout(scheduled);
    scheduled = setTimeout(probe, delay);
  };

  scheduleProbe(0);

  const onNavigate = () => {
    scheduleProbe(120);
  };

  window.addEventListener('yt-navigate-finish', onNavigate, true);
  window.addEventListener('yt-page-data-updated', onNavigate, true);
  document.addEventListener('loadedmetadata', () => scheduleProbe(0), true);
  document.addEventListener('avd:youtube-refresh', () => scheduleProbe(0));
})();

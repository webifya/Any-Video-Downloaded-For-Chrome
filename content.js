(() => {
  if (window.top !== window.self) return;
  if (/^(chrome|edge|about|moz-extension|chrome-extension):/i.test(location.protocol)) return;

  const state = { candidates: new Map(), panel: null, downloadingAll: false, currentLabel: '' };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = value => (value || 'Video').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 170) || 'Video';
  const isHls = url => /\.m3u8(?:$|[?#])/i.test(url || '') || /m3u8|playlist|manifest/i.test(url || '');
  const isDirect = url => /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i.test(url || '');

  function pageTitle() {
    return clean(document.querySelector('h1')?.textContent || document.title || location.hostname || 'Video');
  }

  function nearbyTitle(video, index) {
    const container = video.closest('article, section, figure, [class*="video"], [class*="player"], div');
    const heading = container?.querySelector('h1,h2,h3,h4,h5,h6,[class*="title"]');
    const t = clean(heading?.textContent || video.getAttribute('aria-label') || video.getAttribute('title') || '');
    return t && t !== 'Video' ? t : `${pageTitle()} - Video ${index + 1}`;
  }

  function normalizeCandidate(item) {
    const url = item?.url || '';
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null;
    const kind = item.kind || (isHls(url) ? 'hls' : isDirect(url) ? 'video' : '');
    if (!kind) return null;
    return { url, kind, mime: item.mime || '', contentLength: Number(item.contentLength || 0), source: item.source || 'page', name: clean(item.name || '') };
  }

  function remember(item) {
    const c = normalizeCandidate(item);
    if (!c) return;
    const prev = state.candidates.get(c.url) || {};
    state.candidates.set(c.url, { ...prev, ...c });
  }

  function domCandidates() {
    const out = [];
    const videos = [...document.querySelectorAll('video')];
    videos.forEach((video, index) => {
      const name = nearbyTitle(video, index);
      for (const url of [video.currentSrc, video.src, video.querySelector('source')?.src]) {
        if (!url || url.startsWith('blob:')) continue;
        out.push({ url, kind: isHls(url) ? 'hls' : 'video', source: 'dom', name });
      }
    });
    return out;
  }

  function injectProbe() {
    if (document.documentElement.dataset.pageVideoDownloaderProbe) return;
    document.documentElement.dataset.pageVideoDownloaderProbe = '1';
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('page-probe.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    if (event.data?.source !== 'PAGE_VIDEO_DOWNLOADER_PROBE' || event.data?.type !== 'MEDIA_URLS') return;
    for (const item of event.data.items || []) remember(item);
    render();
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'MEDIA_SEEN' && msg.item) {
      remember(msg.item);
      render();
      return;
    }
    if (msg?.type === 'DOWNLOAD_PROGRESS') {
      const wrap = document.getElementById('page-video-downloader-progress-wrap');
      const bar = document.getElementById('page-video-downloader-progress');
      const status = document.getElementById('page-video-downloader-status');
      if (!wrap || !bar || !status) return;
      wrap.style.display = 'block';
      bar.value = Math.max(0, Math.min(100, Number(msg.percent) || 0));
      status.textContent = `${state.currentLabel ? state.currentLabel + ': ' : ''}${msg.text || `${Math.round(bar.value)}%`}`;
    }
  });

  async function pullNetworkCandidates() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_MEDIA_CANDIDATES' });
      for (const item of result?.items || []) remember(item);
    } catch (_) {}
    for (const item of domCandidates()) remember(item);
  }

  function candidateStem(item) {
    try {
      const u = new URL(item.url);
      let path = u.pathname.toLowerCase();
      path = path.replace(/\/(?:\d{3,4}p|\d+x\d+|quality[-_]?\d+)(?=\/|$)/g, '/');
      path = path.replace(/(?:master|index|playlist|chunklist|media)[-_]?[a-z0-9.-]*\.m3u8$/i, 'playlist.m3u8');
      return `${u.origin}${path}`;
    } catch (_) { return item.url; }
  }

  function dedupedCandidates() {
    const items = [...state.candidates.values()];
    const direct = items.filter(x => x.kind === 'video');
    const hls = items.filter(x => x.kind === 'hls');
    const hlsGroups = new Map();
    for (const item of hls) {
      const stem = candidateStem(item);
      const arr = hlsGroups.get(stem) || [];
      arr.push(item);
      hlsGroups.set(stem, arr);
    }
    const selectedHls = [...hlsGroups.values()].map(group => group.find(x => /master\.m3u8|master|playlist/i.test(x.url)) || group[0]);
    const uniqueDirect = [];
    const seenDirect = new Set();
    for (const item of direct) {
      const key = item.url.split('#')[0];
      if (seenDirect.has(key)) continue;
      seenDirect.add(key);
      uniqueDirect.push(item);
    }
    const all = [...selectedHls, ...uniqueDirect];
    all.sort((a, b) => {
      if (a.name && !b.name) return -1;
      if (!a.name && b.name) return 1;
      return (b.contentLength || 0) - (a.contentLength || 0);
    });
    const page = pageTitle();
    return all.map((item, i) => ({ ...item, name: clean(item.name || `${page} - Video ${i + 1}`) }));
  }

  async function triggerVideoRequests() {
    const videos = [...document.querySelectorAll('video')].filter(v => {
      const r = v.getBoundingClientRect();
      return r.width > 60 && r.height > 40;
    });
    for (const video of videos) {
      const wasPaused = video.paused;
      const wasMuted = video.muted;
      const oldVolume = video.volume;
      try {
        video.muted = true;
        video.volume = 0;
        if (video.paused) await video.play();
      } catch (_) {}
      await sleep(1100);
      try {
        if (wasPaused) video.pause();
        video.muted = wasMuted;
        video.volume = oldVolume;
      } catch (_) {}
      await pullNetworkCandidates();
    }
  }

  async function scan(deep = false) {
    const status = document.getElementById('page-video-downloader-status');
    if (status) status.textContent = deep ? 'Scanning page and briefly starting videos to detect streams…' : 'Scanning page…';
    await pullNetworkCandidates();
    if (deep) await triggerVideoRequests();
    await sleep(300);
    await pullNetworkCandidates();
    render();
    const count = dedupedCandidates().length;
    if (status) status.textContent = count ? `${count} video${count === 1 ? '' : 's'} detected.` : 'No downloadable video stream detected yet.';
    return count;
  }

  async function downloadItem(item, index, total) {
    state.currentLabel = total > 1 ? `Video ${index + 1}/${total}` : item.name;
    const status = document.getElementById('page-video-downloader-status');
    if (status) status.textContent = `${state.currentLabel}: preparing ${item.name}…`;
    const result = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_MEDIA', url: item.url, kind: item.kind, mime: item.mime, filenameBase: item.name });
    if (!result?.ok) throw new Error(result?.error || 'Download failed');
    if (status && item.kind !== 'hls') status.textContent = `${state.currentLabel}: ${result.message || 'Download started.'}`;
  }

  async function downloadAll() {
    if (state.downloadingAll) return;
    state.downloadingAll = true;
    disableActions(true);
    try {
      await scan(true);
      const items = dedupedCandidates();
      if (!items.length) throw new Error('No downloadable videos were detected on this page.');
      for (let i = 0; i < items.length; i++) {
        try { await downloadItem(items[i], i, items.length); }
        catch (error) {
          const status = document.getElementById('page-video-downloader-status');
          if (status) status.textContent = `Video ${i + 1}/${items.length} failed: ${error.message || error}. Continuing…`;
        }
        await sleep(350);
      }
      const status = document.getElementById('page-video-downloader-status');
      if (status) status.textContent = `Finished processing ${items.length} detected video${items.length === 1 ? '' : 's'}.`;
    } catch (error) {
      const status = document.getElementById('page-video-downloader-status');
      if (status) status.textContent = `Download failed: ${error.message || error}`;
    } finally {
      state.downloadingAll = false;
      state.currentLabel = '';
      disableActions(false);
    }
  }

  function disableActions(disabled) {
    document.querySelectorAll('#page-video-downloader-panel button').forEach(btn => {
      if (btn.id !== 'page-video-downloader-close') btn.disabled = disabled;
    });
  }

  function createPanel() {
    if (state.panel?.isConnected) return state.panel;
    const panel = document.createElement('div');
    panel.id = 'page-video-downloader-panel';
    panel.innerHTML = `
      <div id="page-video-downloader-header">
        <span>Video Downloader</span>
        <button id="page-video-downloader-close" type="button" aria-label="Close">×</button>
      </div>
      <div id="page-video-downloader-body">
        <div id="page-video-downloader-actions">
          <button id="page-video-downloader-all" type="button">⬇ Download All</button>
          <button id="page-video-downloader-scan" class="secondary" type="button">↻ Scan</button>
        </div>
        <div id="page-video-downloader-summary">Scanning for videos…</div>
        <div id="page-video-downloader-progress-wrap">
          <progress id="page-video-downloader-progress" max="100" value="0"></progress>
          <span id="page-video-downloader-status"></span>
        </div>
        <div id="page-video-downloader-list"></div>
      </div>`;
    document.documentElement.appendChild(panel);
    panel.querySelector('#page-video-downloader-close').addEventListener('click', () => panel.remove());
    panel.querySelector('#page-video-downloader-scan').addEventListener('click', () => scan(true));
    panel.querySelector('#page-video-downloader-all').addEventListener('click', downloadAll);
    state.panel = panel;
    return panel;
  }

  function render() {
    const panel = createPanel();
    const items = dedupedCandidates();
    const summary = panel.querySelector('#page-video-downloader-summary');
    const list = panel.querySelector('#page-video-downloader-list');
    summary.textContent = items.length ? `${items.length} downloadable video${items.length === 1 ? '' : 's'} detected on this page.` : 'No video detected yet. Click Scan if the page uses a custom player.';
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="pvd-empty">Play a video or click Scan to help detect lazy-loaded streams.</div>';
      return;
    }
    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'pvd-item';
      const type = item.kind === 'hls' ? 'HLS' : (item.mime || 'Video');
      const size = item.contentLength ? ` • ${(item.contentLength / 1048576).toFixed(1)} MB` : '';
      row.innerHTML = '<div class="pvd-title"></div><div class="pvd-meta"></div><button type="button">Download</button>';
      row.querySelector('.pvd-title').textContent = item.name;
      row.querySelector('.pvd-meta').textContent = `${type}${size}`;
      row.querySelector('button').addEventListener('click', async () => {
        try {
          disableActions(true);
          await downloadItem(item, index, items.length);
        } catch (error) {
          const status = document.getElementById('page-video-downloader-status');
          if (status) status.textContent = `Download failed: ${error.message || error}`;
        } finally {
          state.currentLabel = '';
          disableActions(false);
        }
      });
      list.appendChild(row);
    });
  }

  injectProbe();
  createPanel();
  scan(false);
  const observer = new MutationObserver(() => {
    for (const item of domCandidates()) remember(item);
    render();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  setInterval(() => pullNetworkCandidates().then(render), 2500);
})();

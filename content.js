(() => {
  if (window.top !== window.self) return;
  if (/^(chrome|edge|about|moz-extension|chrome-extension):/i.test(location.protocol)) return;

  const state = {
    candidates: new Map(), launcher: null, panel: null, panelOpen: false,
    scanBusy: false, downloading: false, lastNetworkPull: 0,
    pageSignature: '', changeTimer: 0, epoch: Date.now(), currentLabel: ''
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sanitize = v => String(v || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 170);
  const clean = v => sanitize(v) || 'Video';
  const isHls = u => /\.m3u8(?:$|[?#])/i.test(u || '') || /(?:m3u8|playlist)/i.test(u || '');
  const isDash = u => /\.mpd(?:$|[?#])/i.test(u || '');
  const isDirect = u => /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i.test(u || '');
  const isAudio = u => /\.(?:m4a|aac|mp3|opus|ogg)(?:$|[?#])/i.test(u || '');

  function visible(el) {
    if (!el?.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function meta(name) {
    return sanitize(document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content || '');
  }

  function textFrom(selectors) {
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const t = sanitize(el.textContent);
        if (t) return t;
      }
    }
    return '';
  }

  function meaningfulTitle(value) {
    const t = sanitize(value);
    if (!t) return '';
    if (/^(home|courses?|lessons?|categories?|dashboard|instructor|videos?|watch|reels?|facebook|instagram|youtube|vimeo)$/i.test(t)) return '';
    if (/facebook\s*[-–—|•]\s*(?:log in|login|sign up)/i.test(t)) return '';
    return t;
  }

  function pageTitle() {
    const host = location.hostname.toLowerCase();

    if (/(^|\.)youtube\.com$/.test(host)) {
      return meaningfulTitle(textFrom(['ytd-watch-metadata h1 yt-formatted-string', '#title h1 yt-formatted-string', 'h1.ytd-watch-metadata'])) ||
        meaningfulTitle(meta('og:title')) || meaningfulTitle(document.title.replace(/\s*-\s*YouTube\s*$/i, '')) || 'YouTube Video';
    }
    if (/(^|\.)vimeo\.com$/.test(host)) {
      return meaningfulTitle(textFrom(['main h1', '[data-testid*="title"]', 'h1'])) || meaningfulTitle(meta('og:title')) || meaningfulTitle(document.title) || 'Vimeo Video';
    }
    if (/(^|\.)facebook\.com$/.test(host)) {
      return meaningfulTitle(meta('og:title')) || meaningfulTitle(textFrom(['[role="main"] h1', 'main h1', '[data-ad-preview="message"]'])) || meaningfulTitle(document.title) || 'Facebook Video';
    }
    if (/(^|\.)instagram\.com$/.test(host)) {
      return meaningfulTitle(meta('og:title')) || meaningfulTitle(textFrom(['article h1', 'article header', 'main h1'])) || meaningfulTitle(document.title.replace(/\s*[•|]\s*Instagram.*$/i, '')) || 'Instagram Video';
    }

    const activeSelectors = [
      '[aria-current="page"]', '[aria-current="true"]', '[data-active="true"]', '[data-selected="true"]',
      '[class*="lesson"][class*="active"]', '[class*="lesson"][class*="selected"]',
      '[class*="module"][class*="active"] [class*="lesson"]'
    ];
    for (const selector of activeSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const t = meaningfulTitle(el.textContent);
        if (t && t.length <= 180) return t;
      }
    }

    const breadcrumb = [...document.querySelectorAll('[aria-label*="breadcrumb" i] a,[aria-label*="breadcrumb" i] span,.breadcrumb a,.breadcrumb span,[class*="breadcrumb"] a,[class*="breadcrumb"] span')]
      .filter(visible).map(el => meaningfulTitle(el.textContent)).filter(Boolean).pop();
    if (breadcrumb) return breadcrumb;

    return meaningfulTitle(textFrom(['main h1', '[role="main"] h1', 'article h1', 'h1', 'main h2', '[role="main"] h2'])) ||
      meaningfulTitle(meta('og:title')) || meaningfulTitle(document.title) || sanitize(location.hostname) || 'Video';
  }

  function nearbyTitle(video) {
    const own = meaningfulTitle(video.getAttribute('aria-label') || video.getAttribute('title'));
    if (own) return own;
    const c = video.closest('article,section,figure,[class*="video"],[class*="player"]');
    return meaningfulTitle(c?.querySelector('h1,h2,h3,h4,h5,h6,[class*="title"]')?.textContent) || pageTitle();
  }

  function pageSignature() {
    const v = document.querySelector('video');
    const src = v?.currentSrc || v?.src || v?.querySelector('source')?.src || '';
    return `${location.href}|${pageTitle().toLowerCase()}|${src.startsWith('blob:') ? 'blob' : src}`;
  }

  function normalizeCandidate(item) {
    const url = item?.url || '';
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null;
    let kind = item.kind || '';
    if (!kind) {
      if (isDash(url)) kind = 'dash';
      else if (isHls(url)) kind = 'hls';
      else if (isAudio(url)) kind = 'audio';
      else if (isDirect(url)) kind = 'video';
    }
    if (!kind) return null;
    return {
      url, kind, mime: item.mime || '', name: sanitize(item.name), source: item.source || 'page',
      contentLength: Number(item.contentLength || 0), totalLength: Number(item.totalLength || 0),
      width: Number(item.width || 0), height: Number(item.height || 0), bitrate: Number(item.bitrate || 0),
      qualityLabel: sanitize(item.qualityLabel), itag: Number(item.itag || 0), seenAt: Number(item.seenAt || Date.now())
    };
  }

  function candidateKey(item) {
    try {
      const u = new URL(item.url), h = u.hostname.toLowerCase();
      if (/(?:^|\.)googlevideo\.com$/.test(h)) return `yt:${item.kind}:${u.searchParams.get('itag') || item.itag || u.pathname}`;
      if (/(?:^|\.)fbcdn\.net$|(?:^|\.)cdninstagram\.com$/.test(h)) {
        for (const k of ['bytestart','byteend','range','start','end']) u.searchParams.delete(k);
        return `meta:${item.kind}:${u.origin}${u.pathname}?${u.searchParams.toString()}`;
      }
      if (/(?:^|\.)vimeocdn\.com$|(?:^|\.)akamaized\.net$/.test(h)) {
        for (const k of ['range','rn','rbuf']) u.searchParams.delete(k);
        return `vimeo:${item.kind}:${u.origin}${u.pathname}?${u.searchParams.toString()}`;
      }
      return `${item.kind}:${u.href.split('#')[0]}`;
    } catch (_) { return `${item.kind}:${item.url}`; }
  }

  function remember(raw) {
    const item = normalizeCandidate(raw);
    if (!item) return false;
    // Discard stale network entries left over from a previous SPA lesson/video.
    if (item.seenAt && item.seenAt < state.epoch - 2500) return false;
    const key = candidateKey(item);
    const prev = state.candidates.get(key) || {};
    state.candidates.set(key, {
      ...prev, ...item,
      name: item.name || prev.name || '',
      contentLength: item.contentLength || prev.contentLength || 0,
      totalLength: item.totalLength || prev.totalLength || 0,
      width: item.width || prev.width || 0,
      height: item.height || prev.height || 0,
      bitrate: item.bitrate || prev.bitrate || 0,
      qualityLabel: item.qualityLabel || prev.qualityLabel || ''
    });
    return !prev.url;
  }

  function collectDomCandidates() {
    let changed = false;
    [...document.querySelectorAll('video')].forEach(video => {
      const name = nearbyTitle(video);
      const urls = [video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map(s => s.src)];
      for (const url of urls) {
        if (!url || url.startsWith('blob:')) continue;
        changed = remember({ url, kind: isDash(url) ? 'dash' : isHls(url) ? 'hls' : isAudio(url) ? 'audio' : 'video', name, source: 'dom' }) || changed;
      }
    });
    return changed;
  }

  function collectPerformanceCandidates() {
    let changed = false;
    try {
      const entries = performance.getEntriesByType('resource');
      const start = Math.max(0, entries.length - 160);
      for (let i = start; i < entries.length; i++) {
        const url = entries[i]?.name || '';
        if (!isDash(url) && !isHls(url) && !isDirect(url) && !isAudio(url)) continue;
        changed = remember({ url, source: 'performance', seenAt: performance.timeOrigin + entries[i].startTime }) || changed;
      }
    } catch (_) {}
    return changed;
  }

  async function pullNetwork(force = false) {
    const now = Date.now();
    if (!force && now - state.lastNetworkPull < 700) return false;
    state.lastNetworkPull = now;
    let changed = false;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'GET_MEDIA_CANDIDATES' });
      for (const item of r?.items || []) changed = remember(item) || changed;
    } catch (_) {}
    changed = collectDomCandidates() || changed;
    changed = collectPerformanceCandidates() || changed;
    return changed;
  }

  function actualSize(item) { return Math.max(Number(item.totalLength || 0), Number(item.contentLength || 0)); }

  function score(item) {
    let s = 0;
    if (item.kind === 'hls') s += 760;
    else if (item.kind === 'dash') s += 740;
    else if (item.kind === 'video') s += 650;
    else if (item.kind === 'audio') s += 450;

    // Prefer MP4/H.264-like direct video where available, while still allowing WebM/VP9.
    if (item.kind === 'video' && (/video\/mp4/i.test(item.mime) || /\.mp4(?:$|[?#])/i.test(item.url))) s += 180;
    if (item.kind === 'audio' && /audio\/(?:mp4|m4a|aac)/i.test(item.mime)) s += 100;
    if (/master\.m3u8|playlist/i.test(item.url)) s += 80;
    if (item.height) s += Math.min(260, item.height / 5);
    if (item.bitrate) s += Math.min(160, Math.log10(item.bitrate + 1) * 20);
    const size = actualSize(item);
    if (size > 0) s += Math.min(130, Math.log10(size + 1) * 18);
    return s;
  }

  function displayItems() {
    const all = [...state.candidates.values()];
    const videoCandidates = all.filter(x => ['video','hls','dash'].includes(x.kind)).sort((a,b) => score(b) - score(a));
    const audioCandidates = all.filter(x => x.kind === 'audio').sort((a,b) => score(b) - score(a));
    const title = pageTitle();
    const out = [];
    if (videoCandidates[0]) out.push({ ...videoCandidates[0], name: clean(title), outputLabel: 'Video' });
    if (audioCandidates[0]) out.push({ ...audioCandidates[0], name: clean(`${title} - Audio`), outputLabel: 'Audio' });
    return out;
  }

  function ensureLauncher() {
    if (state.launcher?.isConnected) return state.launcher;
    const b = document.createElement('button');
    b.id = 'page-video-downloader-launcher';
    b.type = 'button';
    b.title = 'Any Video Downloader';
    b.setAttribute('aria-label', 'Open Any Video Downloader');
    b.textContent = '⬇';
    b.addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation(); openPanel(); await scan(false);
    });
    document.documentElement.appendChild(b);
    state.launcher = b;
    return b;
  }

  function createPanel() {
    if (state.panel?.isConnected) return state.panel;
    const p = document.createElement('div');
    p.id = 'page-video-downloader-panel';
    p.innerHTML = `<div id="page-video-downloader-header"><span>Any Video Downloader</span><button id="page-video-downloader-close" type="button" aria-label="Close">×</button></div><div id="page-video-downloader-body"><div id="page-video-downloader-actions"><button id="page-video-downloader-all" type="button">⬇ Download All</button><button id="page-video-downloader-scan" class="secondary" type="button">↻ Scan</button></div><div id="page-video-downloader-summary">Ready.</div><div id="page-video-downloader-progress-wrap"><progress id="page-video-downloader-progress" max="100" value="0"></progress><span id="page-video-downloader-status"></span></div><div id="page-video-downloader-list"></div></div>`;
    document.documentElement.appendChild(p);
    p.querySelector('#page-video-downloader-close').onclick = closePanel;
    p.querySelector('#page-video-downloader-scan').onclick = () => scan(true);
    p.querySelector('#page-video-downloader-all').onclick = downloadAll;
    state.panel = p;
    return p;
  }

  function openPanel() { const p = createPanel(); p.style.display = 'block'; state.panelOpen = true; render(); }
  function closePanel() { if (state.panel) state.panel.style.display = 'none'; state.panelOpen = false; }
  function setStatus(text) { const el = document.getElementById('page-video-downloader-status'); if (el) el.textContent = text; }
  function disable(flag) { state.panel?.querySelectorAll('button').forEach(b => { if (b.id !== 'page-video-downloader-close') b.disabled = flag; }); }

  function render() {
    if (!state.panelOpen) return;
    const p = createPanel(), items = displayItems();
    const summary = p.querySelector('#page-video-downloader-summary'), list = p.querySelector('#page-video-downloader-list');
    const title = pageTitle();
    summary.textContent = items.length ? `${items.length} download option${items.length === 1 ? '' : 's'} • ${title}` : `Current page: ${title} • No downloadable media detected yet.`;
    list.replaceChildren();
    if (!items.length) {
      const e = document.createElement('div'); e.className = 'pvd-empty'; e.textContent = 'Play the video briefly, then click Scan.'; list.appendChild(e); return;
    }
    items.forEach((item, index) => {
      const row = document.createElement('div'); row.className = 'pvd-item';
      const titleEl = document.createElement('div'); titleEl.className = 'pvd-title'; titleEl.textContent = item.name;
      const metaEl = document.createElement('div'); metaEl.className = 'pvd-meta';
      const size = actualSize(item);
      const sizeText = size >= 16384 ? ` • ${(size / 1048576).toFixed(1)} MB` : '';
      const quality = item.qualityLabel || (item.height ? `${item.height}p` : '');
      const type = item.kind === 'audio' ? 'Audio' : item.kind === 'hls' ? 'HLS Video' : item.kind === 'dash' ? 'DASH Video' : (/webm/i.test(item.mime) ? 'WebM Video' : 'MP4 Video');
      metaEl.textContent = `${type}${quality ? ` • ${quality}` : ''}${sizeText}`;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = item.kind === 'audio' ? 'Download Audio' : 'Download Video';
      button.onclick = async () => {
        try { disable(true); await downloadItem(item, index, items.length); }
        catch (e) { setStatus(`Download failed: ${e.message || e}`); }
        finally { state.currentLabel = ''; disable(false); }
      };
      row.append(titleEl, metaEl, button); list.appendChild(row);
    });
  }

  async function triggerVisiblePlayers() {
    const videos = [...document.querySelectorAll('video')].filter(v => { const r = v.getBoundingClientRect(); return r.width > 80 && r.height > 50; });
    for (const v of videos.slice(0, 5)) {
      const paused = v.paused, muted = v.muted, volume = v.volume;
      try { v.muted = true; v.volume = 0; if (v.paused) await v.play(); } catch (_) {}
      await sleep(650);
      try { if (paused) v.pause(); v.muted = muted; v.volume = volume; } catch (_) {}
    }
  }

  async function scan(deep = false) {
    if (state.scanBusy) return displayItems().length;
    state.scanBusy = true;
    try {
      setStatus(deep ? `Scanning ${pageTitle()} and triggering the player…` : `Scanning ${pageTitle()}…`);
      await pullNetwork(true);
      if (deep) { await triggerVisiblePlayers(); await sleep(450); await pullNetwork(true); }
      render();
      const n = displayItems().length;
      setStatus(n ? `${n} download option${n === 1 ? '' : 's'} detected.` : 'No accessible video stream detected yet.');
      return n;
    } finally { state.scanBusy = false; }
  }

  async function downloadItem(item, index, total) {
    const current = pageTitle();
    const filenameBase = item.kind === 'audio' ? current : current;
    state.currentLabel = total > 1 ? `${index + 1}/${total}` : current;
    setStatus(`${state.currentLabel}: preparing…`);
    const r = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_MEDIA', url: item.url, kind: item.kind, mime: item.mime,
      filenameBase, pageUrl: location.href
    });
    if (!r?.ok) throw new Error(r?.error || 'Download failed');
    setStatus(r.message || 'Download started.');
  }

  async function downloadAll() {
    if (state.downloading) return;
    state.downloading = true; disable(true);
    try {
      await scan(true);
      const items = displayItems();
      if (!items.length) throw new Error('No downloadable media detected.');
      for (let i = 0; i < items.length; i++) {
        try { await downloadItem(items[i], i, items.length); }
        catch (e) { setStatus(`Item ${i + 1}/${items.length} failed: ${e.message || e}`); }
        await sleep(250);
      }
      setStatus(`Finished processing ${items.length} item${items.length === 1 ? '' : 's'}.`);
    } catch (e) { setStatus(`Download failed: ${e.message || e}`); }
    finally { state.downloading = false; state.currentLabel = ''; disable(false); }
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'DOWNLOAD_PROGRESS') return;
    const wrap = document.getElementById('page-video-downloader-progress-wrap');
    const bar = document.getElementById('page-video-downloader-progress');
    const status = document.getElementById('page-video-downloader-status');
    if (!wrap || !bar || !status) return;
    wrap.style.display = 'block';
    bar.value = Math.max(0, Math.min(100, Number(msg.percent) || 0));
    status.textContent = `${state.currentLabel ? `${state.currentLabel}: ` : ''}${msg.text || `${Math.round(bar.value)}%`}`;
  });

  async function resetForPageChange() {
    state.epoch = Date.now();
    state.candidates.clear(); state.lastNetworkPull = 0;
    try { await chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA_CANDIDATES' }); } catch (_) {}
    if (state.panelOpen) { render(); setStatus(`Page/video changed — waiting for ${pageTitle()}…`); }
    await sleep(750);
    await pullNetwork(true);
    if (state.panelOpen) render();
  }

  function checkForPageChange() {
    const sig = pageSignature();
    if (!state.pageSignature) { state.pageSignature = sig; return; }
    if (sig === state.pageSignature) return;
    state.pageSignature = sig;
    clearTimeout(state.changeTimer);
    state.changeTimer = setTimeout(resetForPageChange, 300);
  }

  function scheduleChangeCheck(delay = 450) {
    clearTimeout(state.changeTimer);
    state.changeTimer = setTimeout(() => { checkForPageChange(); collectDomCandidates(); }, delay);
  }

  const observer = new MutationObserver(mutations => {
    let relevant = false;
    for (const m of mutations) {
      if (m.type === 'attributes' || (m.type === 'childList' && m.addedNodes.length)) { relevant = true; break; }
    }
    if (relevant) scheduleChangeCheck(500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src','class','aria-current','data-active','data-selected'] });
  document.addEventListener('click', () => scheduleChangeCheck(650), true);
  addEventListener('popstate', () => scheduleChangeCheck(150));
  addEventListener('hashchange', () => scheduleChangeCheck(150));

  const init = () => { ensureLauncher(); collectDomCandidates(); state.pageSignature = pageSignature(); };
  if ('requestIdleCallback' in window) requestIdleCallback(init, { timeout: 1000 }); else setTimeout(init, 300);
})();

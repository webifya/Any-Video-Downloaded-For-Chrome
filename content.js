(() => {
  if (window.top !== window.self) return;
  if (/^(chrome|edge|about|moz-extension|chrome-extension):/i.test(location.protocol)) return;

  const state = {
    candidates: new Map(), launcher: null, panel: null, panelOpen: false,
    downloadingAll: false, currentLabel: '', scanBusy: false, lastNetworkPull: 0,
    pageSignature: '', changeTimer: 0, suppressChangeUntil: 0, epoch: Date.now()
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sanitize = v => String(v || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 170);
  const clean = v => sanitize(v) || 'Video';
  const isHls = u => /\.m3u8(?:$|[?#])/i.test(u || '') || /m3u8|playlist|manifest/i.test(u || '');
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

  function firstVisibleText(selectors) {
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const text = sanitize(el.textContent);
        if (text) return text;
      }
    }
    return '';
  }

  function meaningfulTitle(v) {
    const t = sanitize(v);
    if (!t) return '';
    if (/^(facebook|instagram|youtube|vimeo|home|watch|videos?|reels?)$/i.test(t)) return '';
    if (/facebook\s*[-–—|•]\s*(log in|login|sign up|লগ ইন)/i.test(t)) return '';
    return t;
  }

  function pageTitle() {
    const host = location.hostname.toLowerCase();

    if (/(^|\.)youtube\.com$/.test(host)) {
      return meaningfulTitle(firstVisibleText([
        'ytd-watch-metadata h1 yt-formatted-string', '#title h1 yt-formatted-string', 'h1.ytd-watch-metadata'
      ])) || meaningfulTitle(meta('og:title')) || meaningfulTitle(document.title.replace(/\s*-\s*YouTube\s*$/i, '')) || 'YouTube Video';
    }

    if (/(^|\.)vimeo\.com$/.test(host)) {
      return meaningfulTitle(firstVisibleText(['main h1', '[data-testid*="title"]', 'h1'])) || meaningfulTitle(meta('og:title')) || meaningfulTitle(document.title) || 'Vimeo Video';
    }

    if (/(^|\.)facebook\.com$/.test(host)) {
      return meaningfulTitle(meta('og:title')) ||
        meaningfulTitle(firstVisibleText(['[role="main"] h1', 'main h1', '[data-ad-preview="message"]'])) ||
        meaningfulTitle(document.title) || 'Facebook Video';
    }

    if (/(^|\.)instagram\.com$/.test(host)) {
      return meaningfulTitle(meta('og:title')) ||
        meaningfulTitle(firstVisibleText(['article h1', 'article header', 'main h1'])) ||
        meaningfulTitle(document.title.replace(/\s*[•|]\s*Instagram.*$/i, '')) || 'Instagram Video';
    }

    const selectedSelectors = [
      '[aria-current="page"]', '[aria-current="true"]', '[data-active="true"]', '[data-selected="true"]',
      '[class*="lesson"][class*="active"]', '[class*="lesson"][class*="selected"]'
    ];
    for (const selector of selectedSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const t = meaningfulTitle(el.textContent);
        if (t && t.length <= 180 && !/^(home|courses?|lessons?|categories?|next|previous)$/i.test(t)) return t;
      }
    }

    return meaningfulTitle(firstVisibleText(['main h1', '[role="main"] h1', 'article h1', 'h1', 'main h2'])) ||
      meaningfulTitle(meta('og:title')) || meaningfulTitle(document.title) || sanitize(location.hostname) || 'Video';
  }

  function nearbyTitle(video) {
    const labelled = meaningfulTitle(video.getAttribute('aria-label') || video.getAttribute('title'));
    if (labelled) return labelled;
    const c = video.closest('article,section,figure,[class*="video"],[class*="player"]');
    return meaningfulTitle(c?.querySelector('h1,h2,h3,h4,h5,h6,[class*="title"]')?.textContent) || pageTitle();
  }

  function signature() {
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
      else if (isDirect(url)) kind = 'video';
      else if (isAudio(url)) kind = 'audio';
    }
    if (!kind) return null;
    return {
      url, kind, mime: item.mime || '', contentLength: Number(item.contentLength || 0),
      source: item.source || 'page', name: sanitize(item.name), seenAt: Number(item.seenAt || Date.now())
    };
  }

  function keyFor(item) {
    try {
      const u = new URL(item.url);
      const h = u.hostname.toLowerCase();
      if (/\.googlevideo\.com$|^googlevideo\.com$/.test(h)) return `yt:${item.kind}:${u.searchParams.get('itag') || u.pathname}`;
      if (/fbcdn\.net$|\.fbcdn\.net$|cdninstagram\.com$|\.cdninstagram\.com$/.test(h)) {
        const c = new URL(u.href);
        for (const k of ['bytestart','byteend','range','start','end']) c.searchParams.delete(k);
        return `meta:${item.kind}:${c.origin}${c.pathname}?${c.searchParams.toString()}`;
      }
      if (/vimeocdn\.com$|\.vimeocdn\.com$|akamaized\.net$|\.akamaized\.net$/.test(h)) {
        const c = new URL(u.href);
        for (const k of ['range','rn','rbuf']) c.searchParams.delete(k);
        return `vimeo:${item.kind}:${c.origin}${c.pathname}?${c.searchParams.toString()}`;
      }
      return `${item.kind}:${u.href.split('#')[0]}`;
    } catch (_) { return `${item.kind}:${item.url}`; }
  }

  function remember(item) {
    const c = normalizeCandidate(item);
    if (!c) return false;
    if (c.seenAt < state.epoch - 1500) return false;
    const key = keyFor(c);
    const prev = state.candidates.get(key) || {};
    state.candidates.set(key, { ...prev, ...c, name: c.name || prev.name || '' });
    return !prev.url;
  }

  function collectDom() {
    let changed = false;
    [...document.querySelectorAll('video')].forEach(v => {
      const name = nearbyTitle(v);
      const urls = [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map(s => s.src)];
      for (const url of urls) {
        if (!url || url.startsWith('blob:')) continue;
        changed = remember({ url, kind: isDash(url) ? 'dash' : isHls(url) ? 'hls' : isAudio(url) ? 'audio' : 'video', source: 'dom', name }) || changed;
      }
    });
    return changed;
  }

  function collectPerformance() {
    let changed = false;
    try {
      const entries = performance.getEntriesByType('resource');
      const start = Math.max(0, entries.length - 180);
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
    if (!force && now - state.lastNetworkPull < 900) return false;
    state.lastNetworkPull = now;
    let changed = false;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'GET_MEDIA_CANDIDATES' });
      for (const item of r?.items || []) changed = remember(item) || changed;
    } catch (_) {}
    changed = collectDom() || changed;
    changed = collectPerformance() || changed;
    return changed;
  }

  function score(item) {
    let s = 0;
    if (item.kind === 'hls') s += 700;
    if (item.kind === 'dash') s += 650;
    if (item.kind === 'video') s += 600;
    if (item.kind === 'audio') s += 400;
    if (item.mime === 'video/mp4' || /\.mp4(?:$|[?#])/i.test(item.url)) s += 100;
    if (/master\.m3u8|playlist/i.test(item.url)) s += 80;
    if (item.contentLength > 0) s += Math.min(150, Math.log10(item.contentLength + 1) * 20);
    s += Math.min(50, Math.max(0, (item.seenAt - state.epoch) / 1000));
    return s;
  }

  function displayItems() {
    const items = [...state.candidates.values()].filter(x => x.contentLength !== 0 || x.kind === 'hls' || x.kind === 'dash' || x.source === 'request');
    const videos = items.filter(x => x.kind === 'video' || x.kind === 'hls' || x.kind === 'dash').sort((a, b) => score(b) - score(a));
    const audios = items.filter(x => x.kind === 'audio').sort((a, b) => score(b) - score(a));

    const current = pageTitle();
    const out = [];
    if (videos[0]) out.push({ ...videos[0], name: clean(current), outputLabel: 'MP4 Video' });
    if (audios[0]) out.push({ ...audios[0], name: clean(`${current} - Audio`), outputLabel: 'MP3 / Audio' });
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
    b.addEventListener('click', async e => { e.preventDefault(); e.stopPropagation(); openPanel(); await scan(false); });
    document.documentElement.appendChild(b);
    state.launcher = b;
    return b;
  }

  function createPanel() {
    if (state.panel?.isConnected) return state.panel;
    const p = document.createElement('div');
    p.id = 'page-video-downloader-panel';
    p.innerHTML = `<div id="page-video-downloader-header"><span>Any Video Downloader</span><button id="page-video-downloader-close" type="button">×</button></div><div id="page-video-downloader-body"><div id="page-video-downloader-actions"><button id="page-video-downloader-all" type="button">⬇ Download All</button><button id="page-video-downloader-scan" class="secondary" type="button">↻ Scan</button></div><div id="page-video-downloader-summary">Ready to scan.</div><div id="page-video-downloader-progress-wrap"><progress id="page-video-downloader-progress" max="100" value="0"></progress><span id="page-video-downloader-status"></span></div><div id="page-video-downloader-list"></div></div>`;
    document.documentElement.appendChild(p);
    p.querySelector('#page-video-downloader-close').onclick = closePanel;
    p.querySelector('#page-video-downloader-scan').onclick = () => scan(true);
    p.querySelector('#page-video-downloader-all').onclick = downloadAll;
    state.panel = p;
    return p;
  }

  function openPanel() { const p = createPanel(); p.style.display = 'block'; state.panelOpen = true; render(); }
  function closePanel() { if (state.panel) state.panel.style.display = 'none'; state.panelOpen = false; }
  function setStatus(t) { const s = document.getElementById('page-video-downloader-status'); if (s) s.textContent = t; }

  function render() {
    if (!state.panelOpen) return;
    const p = createPanel(), items = displayItems(), summary = p.querySelector('#page-video-downloader-summary'), list = p.querySelector('#page-video-downloader-list');
    const current = pageTitle();
    summary.textContent = items.length ? `${items.length} download option${items.length === 1 ? '' : 's'} • ${current}` : `Current page: ${current} • No downloadable media detected yet.`;
    list.replaceChildren();

    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'pvd-empty';
      e.textContent = 'Play the current video for a few seconds, then click Scan.';
      list.appendChild(e);
      return;
    }

    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'pvd-item';
      const title = document.createElement('div');
      title.className = 'pvd-title';
      title.textContent = item.name;
      const metaEl = document.createElement('div');
      metaEl.className = 'pvd-meta';
      const size = item.contentLength >= 16384 ? ` • ${(item.contentLength / 1048576).toFixed(1)} MB` : '';
      metaEl.textContent = `${item.outputLabel}${size}`;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = item.kind === 'audio' ? 'Download Audio' : 'Download MP4';
      b.onclick = async () => {
        try { disable(true); await downloadItem(item, index, items.length); }
        catch (e) { setStatus(`Download failed: ${e.message || e}`); }
        finally { state.currentLabel = ''; disable(false); }
      };
      row.append(title, metaEl, b);
      list.appendChild(row);
    });
  }

  async function trigger() {
    const vs = [...document.querySelectorAll('video')].filter(v => { const r = v.getBoundingClientRect(); return r.width > 60 && r.height > 40; });
    for (const v of vs.slice(0, 6)) {
      const paused = v.paused, muted = v.muted, vol = v.volume;
      try { v.muted = true; v.volume = 0; if (v.paused) await v.play(); } catch (_) {}
      await sleep(700);
      try { if (paused) v.pause(); v.muted = muted; v.volume = vol; } catch (_) {}
    }
  }

  async function scan(deep = false) {
    if (state.scanBusy) return displayItems().length;
    state.scanBusy = true;
    try {
      setStatus(deep ? `Scanning ${pageTitle()} and triggering the player…` : `Scanning ${pageTitle()}…`);
      await pullNetwork(true);
      if (deep) { await trigger(); await sleep(400); await pullNetwork(true); }
      render();
      const n = displayItems().length;
      setStatus(n ? `${n} clean download option${n === 1 ? '' : 's'} detected.` : `No downloadable media detected for ${pageTitle()} yet.`);
      return n;
    } finally { state.scanBusy = false; }
  }

  async function downloadItem(item, index, total) {
    const current = pageTitle();
    const filenameBase = item.kind === 'audio' ? `${current} - Audio` : current;
    state.currentLabel = item.kind === 'audio' ? 'Audio' : 'Video';
    setStatus(`${state.currentLabel}: preparing ${filenameBase}…`);
    const r = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_MEDIA', url: item.url, kind: item.kind, mime: item.mime, filenameBase });
    if (!r?.ok) throw new Error(r?.error || 'Download failed');
    if (item.kind !== 'hls' && item.kind !== 'dash') setStatus(`${state.currentLabel}: ${r.message || 'Download started.'}`);
  }

  async function downloadAll() {
    if (state.downloadingAll) return;
    state.downloadingAll = true;
    disable(true);
    try {
      await scan(true);
      const items = displayItems();
      if (!items.length) throw new Error('No downloadable media detected.');
      for (let i = 0; i < items.length; i++) {
        try { await downloadItem(items[i], i, items.length); }
        catch (e) { setStatus(`Item ${i + 1}/${items.length} failed: ${e.message || e}. Continuing…`); }
        await sleep(220);
      }
      setStatus(`Finished processing ${items.length} item${items.length === 1 ? '' : 's'}.`);
    } catch (e) { setStatus(`Download failed: ${e.message || e}`); }
    finally { state.downloadingAll = false; state.currentLabel = ''; disable(false); }
  }

  function disable(v) { state.panel?.querySelectorAll('button').forEach(b => { if (b.id !== 'page-video-downloader-close') b.disabled = v; }); }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'DOWNLOAD_PROGRESS') return;
    const w = document.getElementById('page-video-downloader-progress-wrap'), b = document.getElementById('page-video-downloader-progress'), s = document.getElementById('page-video-downloader-status');
    if (!w || !b || !s) return;
    w.style.display = 'block';
    b.value = Math.max(0, Math.min(100, Number(msg.percent) || 0));
    s.textContent = `${state.currentLabel ? state.currentLabel + ': ' : ''}${msg.text || Math.round(b.value) + '%'}`;
  });

  async function resetForPageChange() {
    if (Date.now() < state.suppressChangeUntil) return;
    state.suppressChangeUntil = Date.now() + 800;
    state.epoch = Date.now();
    state.candidates.clear();
    try { await chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA_CANDIDATES' }); } catch (_) {}
    state.lastNetworkPull = 0;
    if (state.panelOpen) { render(); setStatus(`Page/video changed — waiting for ${pageTitle()}…`); }
    await sleep(850);
    await pullNetwork(true);
    if (state.panelOpen) render();
  }

  function checkChange() {
    const sig = signature();
    if (!state.pageSignature) { state.pageSignature = sig; return; }
    if (sig === state.pageSignature) return;
    state.pageSignature = sig;
    clearTimeout(state.changeTimer);
    state.changeTimer = setTimeout(resetForPageChange, 250);
  }

  const observer = new MutationObserver(m => {
    if (!m.some(x => (x.type === 'childList' && x.addedNodes.length) || x.type === 'attributes')) return;
    clearTimeout(state.changeTimer);
    state.changeTimer = setTimeout(() => { checkChange(); if (document.querySelector('video')) collectDom(); }, 400);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src','class','aria-current','data-active','data-selected'] });

  const init = () => { ensureLauncher(); collectDom(); state.pageSignature = signature(); };
  if ('requestIdleCallback' in window) requestIdleCallback(init, { timeout: 1200 }); else setTimeout(init, 400);
  setInterval(checkChange, 1200);
})();

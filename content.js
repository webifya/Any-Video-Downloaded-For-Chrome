(() => {
  if (window.top !== window.self) return;
  if (/^(chrome|edge|about|moz-extension|chrome-extension):/i.test(location.protocol)) return;

  const state = {
    candidates: new Map(),
    launcher: null,
    panel: null,
    panelOpen: false,
    downloadingAll: false,
    currentLabel: '',
    scanBusy: false,
    lastNetworkPull: 0,
    pageSignature: '',
    changeTimer: 0,
    suppressChangeUntil: 0
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const sanitize = value => String(value || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 170);
  const clean = value => sanitize(value) || 'Video';
  const isHls = url => /\.m3u8(?:$|[?#])/i.test(url || '') || /m3u8|playlist|manifest/i.test(url || '');
  const isDirect = url => /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i.test(url || '');

  function visible(el) {
    if (!el?.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function candidateTexts(selector) {
    return [...document.querySelectorAll(selector)]
      .filter(visible)
      .map(el => sanitize(el.textContent))
      .filter(t => t && t.length >= 2 && t.length <= 180);
  }

  function lessonTitle() {
    // 1) Current/selected lesson in navigation.
    const selectedSelectors = [
      '[aria-current="page"]', '[aria-current="true"]',
      '[data-active="true"]', '[data-selected="true"]',
      '.active', '.selected',
      '[class*="lesson"][class*="active"]', '[class*="lesson"][class*="selected"]'
    ];
    for (const selector of selectedSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const t = sanitize(el.textContent);
        if (t && t.length <= 180 && !/^(home|courses?|lessons?|categories?|next|previous)$/i.test(t)) return t;
      }
    }

    // 2) Main visible lesson heading. This matches pages like DigitalMarketer where the lesson title is the H1.
    const headings = candidateTexts('main h1, [role="main"] h1, article h1, h1, main h2, [role="main"] h2');
    const heading = headings.find(t => !/^(lessons?|courses?|dashboard|instructor|about this lesson)$/i.test(t));
    if (heading) return heading;

    // 3) Breadcrumb / trail: use the last meaningful visible item.
    const crumbs = candidateTexts('[aria-label*="breadcrumb" i] a, [aria-label*="breadcrumb" i] span, .breadcrumb a, .breadcrumb span, [class*="breadcrumb"] a, [class*="breadcrumb"] span');
    if (crumbs.length) return crumbs[crumbs.length - 1];

    // 4) Page title as fallback.
    const doc = sanitize(document.title.replace(/\s*[|–—-]\s*[^|–—-]+$/, ''));
    return doc || sanitize(location.hostname) || 'Video';
  }

  function nearbyTitle(video, index) {
    const labelled = sanitize(video.getAttribute('aria-label') || video.getAttribute('title'));
    if (labelled) return labelled;
    const container = video.closest('article, section, figure, [class*="video"], [class*="player"]');
    const heading = sanitize(container?.querySelector('h1,h2,h3,h4,h5,h6,[class*="title"]')?.textContent);
    return heading || lessonTitle() || `Video ${index + 1}`;
  }

  function pageSignature() {
    const video = document.querySelector('video');
    const src = video?.currentSrc || video?.src || video?.querySelector('source')?.src || '';
    return `${location.href}|${lessonTitle().toLowerCase()}|${src.startsWith('blob:') ? 'blob' : src}`;
  }

  function normalizeCandidate(item) {
    const url = item?.url || '';
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null;
    const kind = item.kind || (isHls(url) ? 'hls' : isDirect(url) ? 'video' : '');
    if (!kind) return null;
    return {
      url,
      kind,
      mime: item.mime || '',
      contentLength: Number(item.contentLength || 0),
      source: item.source || 'page',
      // IMPORTANT: keep unnamed network candidates empty so they receive the CURRENT lesson title later.
      name: sanitize(item.name)
    };
  }

  function remember(item) {
    const c = normalizeCandidate(item);
    if (!c) return false;
    const prev = state.candidates.get(c.url) || {};
    const name = c.name || prev.name || '';
    state.candidates.set(c.url, { ...prev, ...c, name });
    return !prev.url;
  }

  function collectDomCandidates() {
    let changed = false;
    const videos = [...document.querySelectorAll('video')];
    videos.forEach((video, index) => {
      const name = nearbyTitle(video, index);
      const urls = [video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map(s => s.src)];
      for (const url of urls) {
        if (!url || url.startsWith('blob:')) continue;
        changed = remember({ url, kind: isHls(url) ? 'hls' : 'video', source: 'dom', name }) || changed;
      }
    });
    return changed;
  }

  function collectPerformanceCandidates() {
    let changed = false;
    try {
      const entries = performance.getEntriesByType('resource');
      const start = Math.max(0, entries.length - 180);
      for (let i = start; i < entries.length; i++) {
        const url = entries[i]?.name || '';
        if (!isHls(url) && !isDirect(url)) continue;
        changed = remember({ url, source: 'performance' }) || changed;
      }
    } catch (_) {}
    return changed;
  }

  async function pullNetworkCandidates(force = false) {
    const now = Date.now();
    if (!force && now - state.lastNetworkPull < 1000) return false;
    state.lastNetworkPull = now;
    let changed = false;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_MEDIA_CANDIDATES' });
      for (const item of result?.items || []) changed = remember(item) || changed;
    } catch (_) {}
    changed = collectDomCandidates() || changed;
    changed = collectPerformanceCandidates() || changed;
    return changed;
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
      const group = hlsGroups.get(stem) || [];
      group.push(item);
      hlsGroups.set(stem, group);
    }
    const selectedHls = [...hlsGroups.values()].map(group => group.find(x => /master\.m3u8|master|playlist/i.test(x.url)) || group[0]);
    const uniqueDirect = [];
    const seen = new Set();
    for (const item of direct) {
      const key = item.url.split('#')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueDirect.push(item);
    }
    const all = [...selectedHls, ...uniqueDirect];
    all.sort((a, b) => (b.contentLength || 0) - (a.contentLength || 0));
    const currentName = lessonTitle();
    return all.map((item, i) => ({
      ...item,
      // A single video gets exactly the current lesson/page name.
      // Multiple videos get a suffix only when needed.
      name: clean(item.name || (all.length === 1 ? currentName : `${currentName} - Video ${i + 1}`))
    }));
  }

  function ensureLauncher() {
    if (state.launcher?.isConnected) return state.launcher;
    const button = document.createElement('button');
    button.id = 'page-video-downloader-launcher';
    button.type = 'button';
    button.title = 'Any Video Downloader';
    button.setAttribute('aria-label', 'Open Any Video Downloader');
    button.textContent = '⬇';
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      openPanel();
      await scan(false);
    });
    document.documentElement.appendChild(button);
    state.launcher = button;
    return button;
  }

  function createPanel() {
    if (state.panel?.isConnected) return state.panel;
    const panel = document.createElement('div');
    panel.id = 'page-video-downloader-panel';
    panel.innerHTML = `
      <div id="page-video-downloader-header">
        <span>Any Video Downloader</span>
        <button id="page-video-downloader-close" type="button" aria-label="Close">×</button>
      </div>
      <div id="page-video-downloader-body">
        <div id="page-video-downloader-actions">
          <button id="page-video-downloader-all" type="button">⬇ Download All</button>
          <button id="page-video-downloader-scan" class="secondary" type="button">↻ Scan</button>
        </div>
        <div id="page-video-downloader-summary">Ready to scan.</div>
        <div id="page-video-downloader-progress-wrap">
          <progress id="page-video-downloader-progress" max="100" value="0"></progress>
          <span id="page-video-downloader-status"></span>
        </div>
        <div id="page-video-downloader-list"></div>
      </div>`;
    document.documentElement.appendChild(panel);
    panel.querySelector('#page-video-downloader-close').addEventListener('click', closePanel);
    panel.querySelector('#page-video-downloader-scan').addEventListener('click', () => scan(true));
    panel.querySelector('#page-video-downloader-all').addEventListener('click', downloadAll);
    state.panel = panel;
    return panel;
  }

  function openPanel() {
    const panel = createPanel();
    panel.style.display = 'block';
    state.panelOpen = true;
    render();
  }

  function closePanel() {
    if (state.panel) state.panel.style.display = 'none';
    state.panelOpen = false;
  }

  function setStatus(text) {
    const status = document.getElementById('page-video-downloader-status');
    if (status) status.textContent = text;
  }

  function render() {
    if (!state.panelOpen) return;
    const panel = createPanel();
    const items = dedupedCandidates();
    const summary = panel.querySelector('#page-video-downloader-summary');
    const list = panel.querySelector('#page-video-downloader-list');
    const current = lessonTitle();
    summary.textContent = items.length
      ? `${items.length} downloadable video${items.length === 1 ? '' : 's'} detected • ${current}`
      : `Current page: ${current} • No video detected yet. Play the video or click Scan.`;
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'pvd-empty';
      empty.textContent = 'Play the current video or click Scan to detect its stream.';
      list.appendChild(empty);
      return;
    }
    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'pvd-item';
      const title = document.createElement('div');
      title.className = 'pvd-title';
      title.textContent = item.name;
      const meta = document.createElement('div');
      meta.className = 'pvd-meta';
      const type = item.kind === 'hls' ? 'HLS' : (item.mime || 'Video');
      const size = item.contentLength ? ` • ${(item.contentLength / 1048576).toFixed(1)} MB` : '';
      meta.textContent = `${type}${size}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Download';
      button.addEventListener('click', async () => {
        try {
          disableActions(true);
          await downloadItem(item, index, items.length);
        } catch (error) {
          setStatus(`Download failed: ${error.message || error}`);
        } finally {
          state.currentLabel = '';
          disableActions(false);
        }
      });
      row.append(title, meta, button);
      list.appendChild(row);
    });
  }

  async function triggerVideoRequests() {
    const videos = [...document.querySelectorAll('video')].filter(v => {
      const r = v.getBoundingClientRect();
      return r.width > 60 && r.height > 40;
    });
    for (const video of videos.slice(0, 8)) {
      const wasPaused = video.paused;
      const wasMuted = video.muted;
      const oldVolume = video.volume;
      try {
        video.muted = true;
        video.volume = 0;
        if (video.paused) await video.play();
      } catch (_) {}
      await sleep(500);
      try {
        if (wasPaused) video.pause();
        video.muted = wasMuted;
        video.volume = oldVolume;
      } catch (_) {}
    }
  }

  async function scan(deep = false) {
    if (state.scanBusy) return dedupedCandidates().length;
    state.scanBusy = true;
    try {
      setStatus(deep ? `Scanning ${lessonTitle()} and briefly starting visible video…` : `Scanning ${lessonTitle()}…`);
      await pullNetworkCandidates(true);
      if (deep) {
        await triggerVideoRequests();
        await sleep(250);
        await pullNetworkCandidates(true);
      }
      render();
      const count = dedupedCandidates().length;
      setStatus(count ? `${count} video${count === 1 ? '' : 's'} detected for ${lessonTitle()}.` : `No downloadable stream detected for ${lessonTitle()} yet.`);
      return count;
    } finally {
      state.scanBusy = false;
    }
  }

  async function downloadItem(item, index, total) {
    // Re-resolve the filename at click time so SPA lesson changes always use the current title.
    const current = lessonTitle();
    const filenameBase = total === 1 ? current : (item.name || `${current} - Video ${index + 1}`);
    state.currentLabel = total > 1 ? `Video ${index + 1}/${total}` : current;
    setStatus(`${state.currentLabel}: preparing ${filenameBase}…`);
    const result = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_MEDIA',
      url: item.url,
      kind: item.kind,
      mime: item.mime,
      filenameBase
    });
    if (!result?.ok) throw new Error(result?.error || 'Download failed');
    if (item.kind !== 'hls') setStatus(`${state.currentLabel}: ${result.message || 'Download started.'}`);
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
        catch (error) { setStatus(`Video ${i + 1}/${items.length} failed: ${error.message || error}. Continuing…`); }
        await sleep(200);
      }
      setStatus(`Finished processing ${items.length} detected video${items.length === 1 ? '' : 's'} for ${lessonTitle()}.`);
    } catch (error) {
      setStatus(`Download failed: ${error.message || error}`);
    } finally {
      state.downloadingAll = false;
      state.currentLabel = '';
      disableActions(false);
    }
  }

  function disableActions(disabled) {
    state.panel?.querySelectorAll('button').forEach(btn => {
      if (btn.id !== 'page-video-downloader-close') btn.disabled = disabled;
    });
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'DOWNLOAD_PROGRESS') return;
    const wrap = document.getElementById('page-video-downloader-progress-wrap');
    const bar = document.getElementById('page-video-downloader-progress');
    const status = document.getElementById('page-video-downloader-status');
    if (!wrap || !bar || !status) return;
    wrap.style.display = 'block';
    bar.value = Math.max(0, Math.min(100, Number(msg.percent) || 0));
    status.textContent = `${state.currentLabel ? state.currentLabel + ': ' : ''}${msg.text || `${Math.round(bar.value)}%`}`;
  });

  async function resetForNewPage(reason = 'lesson changed') {
    if (Date.now() < state.suppressChangeUntil) return;
    state.suppressChangeUntil = Date.now() + 500;
    state.candidates.clear();
    state.lastNetworkPull = 0;
    try { await chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA_CANDIDATES' }); } catch (_) {}
    if (state.panelOpen) {
      setStatus(`${reason}. Waiting for the new video stream…`);
      render();
    }
    // Give SPA/custom player time to replace/reload its media source, then scan the NEW lesson only.
    await sleep(700);
    collectDomCandidates();
    await pullNetworkCandidates(true);
    if (state.panelOpen) render();
  }

  function schedulePageChangeCheck() {
    clearTimeout(state.changeTimer);
    state.changeTimer = setTimeout(async () => {
      const next = pageSignature();
      if (!state.pageSignature) {
        state.pageSignature = next;
        return;
      }
      if (next !== state.pageSignature) {
        state.pageSignature = next;
        await resetForNewPage('New lesson/page detected');
      }
    }, 250);
  }

  const observer = new MutationObserver(mutations => {
    let relevant = false;
    for (const m of mutations) {
      if (m.type === 'attributes') {
        if (['src', 'class', 'aria-current', 'data-active', 'data-selected'].includes(m.attributeName)) relevant = true;
      } else if (m.addedNodes.length || m.removedNodes.length) {
        relevant = true;
      }
      if (relevant) break;
    }
    if (!relevant) return;
    ensureLauncher();
    schedulePageChangeCheck();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'class', 'aria-current', 'data-active', 'data-selected']
  });

  // popstate covers browser/back-forward SPA navigation. The MutationObserver covers in-app lesson clicks.
  addEventListener('popstate', schedulePageChangeCheck);
  addEventListener('hashchange', schedulePageChangeCheck);

  const init = () => {
    ensureLauncher();
    collectDomCandidates();
    state.pageSignature = pageSignature();
  };
  if ('requestIdleCallback' in window) requestIdleCallback(init, { timeout: 1200 });
  else setTimeout(init, 350);
})();

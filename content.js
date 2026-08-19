(() => {
  if (window.top !== window.self && !document.querySelector('video')) return;

  const COURSE_KEY = 'ghlCourseBatchV133';
  const state = {
    media: new Map(),
    mountedVideo: null,
    downloading: false,
    batchBusy: false,
    navLock: false,
    lastLessonSignature: ''
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function text(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function cleanName(value) {
    return (value || 'GHL Course Video')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180) || 'GHL Course Video';
  }

  function normalizeUrl(value) {
    try {
      const u = new URL(value, location.href);
      u.hash = '';
      return u.href;
    } catch (_) {
      return value || '';
    }
  }

  function isHls(url) {
    return /\.m3u8(?:$|[?#])/i.test(url || '') || /(?:m3u8|playlist|manifest)/i.test(url || '');
  }

  function isDirectVideo(url) {
    return /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i.test(url || '');
  }

  function remember(url, source = 'page') {
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
    if (!isHls(url) && !isDirectVideo(url)) return;
    state.media.set(url, { url, source, seenAt: Date.now() });
  }

  function clearLocalMedia() {
    state.media.clear();
  }

  async function clearWorkerMedia() {
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA_CANDIDATES' });
    } catch (_) {}
  }

  async function resetMediaDetection() {
    clearLocalMedia();
    await clearWorkerMedia();
  }

  function injectProbe() {
    if (document.documentElement.dataset.ghlDownloaderProbe) return;
    document.documentElement.dataset.ghlDownloaderProbe = '1';
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page-probe.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    if (event.data?.source !== 'GHL_VIDEO_DOWNLOADER_PROBE' || event.data?.type !== 'MEDIA_URLS') return;
    for (const url of event.data.urls || []) remember(url, 'probe');
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'MEDIA_SEEN' && msg.url) remember(msg.url, 'network');
    if (msg?.type !== 'DOWNLOAD_PROGRESS') return;

    const row = document.getElementById('ghl-video-download-progress-row');
    const bar = document.getElementById('ghl-video-download-progress');
    const pct = document.getElementById('ghl-video-download-percent');
    const status = document.getElementById('ghl-video-download-status');
    if (!row || !bar || !pct) return;

    const percent = Math.max(0, Math.min(100, Number(msg.percent) || 0));
    row.style.display = 'flex';
    bar.value = percent;
    pct.textContent = `${Math.round(percent)}%`;
    if (status && msg.text) status.textContent = msg.text;
  });

  function findVideo() {
    const videos = [...document.querySelectorAll('video')].filter(v => {
      const r = v.getBoundingClientRect();
      return r.width > 100 && r.height > 70;
    });
    return videos.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    })[0] || document.querySelector('video');
  }

  function lessonName() {
    const active = getLessonAnchors().find(item => isActiveLesson(item.el));
    if (active?.title) return active.title;

    const candidates = [...document.querySelectorAll(
      '[class*="breadcrumb"] span, [class*="breadcrumb"] a, h1, h2, h3, [class*="lesson-title"], [class*="lesson_name"], [class*="title"]'
    )]
      .map(text)
      .filter(t => t.length >= 3 && t.length <= 220)
      .filter(t => !/about this lesson|instructor|dashboard|courses|categories|login|sign up/i.test(t));

    return cleanName(candidates.find(t => /^\d{1,3}\s*[-.)]/.test(t)) || document.title.split('|')[0]);
  }

  function isNumberedLesson(value) {
    return /^\d{1,3}\s*[-.)]\s*\S|^\d{1,3}\s*-\S/.test(value || '');
  }

  function badNavigationHref(href) {
    if (!href) return false;
    try {
      const u = new URL(href, location.href);
      const p = u.pathname.replace(/\/+$/, '').toLowerCase();
      if (/(^|\/)(dashboard|home)$/.test(p)) return true;
      if (/(^|\/)(courses?|products?|memberships?|communities)$/.test(p)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function getLessonAnchors() {
    const items = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const title = text(a);
      if (!isNumberedLesson(title)) continue;
      if (badNavigationHref(a.href)) continue;
      const key = normalizeUrl(a.href) + '|' + title;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ el: a, url: normalizeUrl(a.href), title: cleanName(title) });
    }
    return items;
  }

  function isActiveLesson(el) {
    if (!el) return false;
    if (el.matches('[aria-current="page"], [aria-current="true"], .active, .selected')) return true;
    return !!el.closest('[aria-current="page"], [aria-current="true"], .active, .selected, [class*="active"], [class*="selected"]');
  }

  function currentLessonIndex(items) {
    let index = items.findIndex(item => isActiveLesson(item.el));
    if (index >= 0) return index;

    const here = normalizeUrl(location.href);
    index = items.findIndex(item => item.url === here);
    if (index >= 0) return index;

    const name = lessonName().toLowerCase();
    return items.findIndex(item => item.title.toLowerCase() === name);
  }

  function nextLessonTarget() {
    const items = getLessonAnchors();
    if (!items.length) return null;
    const index = currentLessonIndex(items);
    if (index >= 0 && index + 1 < items.length) return items[index + 1];
    return null;
  }

  function visibleControls() {
    return [...document.querySelectorAll('a[href], button, [role="button"]')].filter(el => el.offsetParent !== null);
  }

  function findNextLessonControl() {
    return visibleControls().find(el => {
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${text(el)}`.trim();
      if (!/\bnext\b/i.test(label)) return false;
      if (/category|module|section|course|dashboard|home/i.test(label)) return false;
      return /lesson|step|video|continue/i.test(label) || !!el.closest('[class*="lesson"], [class*="player"], [class*="navigation"], nav');
    }) || null;
  }

  function findNextCategoryControl() {
    return visibleControls().find(el => {
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${text(el)}`.trim();
      return /next\s+(category|module|section)/i.test(label);
    }) || null;
  }

  function safeClick(target) {
    const el = target?.el || target;
    if (!el || !el.isConnected || el.offsetParent === null) return false;
    if (el.tagName === 'A' && badNavigationHref(el.href)) return false;
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (_) {}
    try {
      el.click();
      return true;
    } catch (_) {
      try {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  function lessonSignature() {
    const items = getLessonAnchors();
    const index = currentLessonIndex(items);
    const active = index >= 0 ? items[index] : null;
    return `${active?.title || lessonName()}|${active?.url || normalizeUrl(location.href)}`;
  }

  async function getNetworkCandidates() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_MEDIA_CANDIDATES' });
      for (const item of result?.items || []) remember(item.url, 'network-cache');
    } catch (_) {}
  }

  function bestMediaUrl(video) {
    const direct = [video?.currentSrc, video?.src, video?.querySelector('source')?.src]
      .find(url => url && !url.startsWith('blob:') && (isHls(url) || isDirectVideo(url)));
    if (direct) return direct;

    const candidates = [...state.media.values()].sort((a, b) => b.seenAt - a.seenAt);
    return candidates.find(item => isHls(item.url))?.url || candidates.find(item => isDirectVideo(item.url))?.url || '';
  }

  async function forcePlayback(video, status, elapsed) {
    if (!video) return;
    try {
      video.muted = true;
      video.volume = 0;
      video.autoplay = true;
      if (video.paused) await video.play();
    } catch (_) {
      const play = visibleControls().find(el => {
        const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${text(el)}`.trim();
        return /(^|\s)play(\s|$)/i.test(label);
      });
      try { play?.click(); } catch (_) {}
    }

    if (elapsed >= 6 && Number.isFinite(video.duration) && video.duration > 12) {
      try {
        const seek = Math.min(Math.max(2, video.duration * 0.04), 8);
        if (Math.abs(video.currentTime - seek) > 1) video.currentTime = seek;
      } catch (_) {}
    }
    if (status) status.textContent = `Waiting for GHL video stream… ${elapsed}s`;
  }

  async function detectMedia(status, timeout = 24000) {
    const started = Date.now();
    let video = findVideo();

    while (Date.now() - started < timeout) {
      video = findVideo() || video;
      await getNetworkCandidates();
      const url = bestMediaUrl(video);
      if (url) return url;

      const elapsed = Math.floor((Date.now() - started) / 1000);
      await forcePlayback(video, status, elapsed);
      await sleep(elapsed < 5 ? 700 : 1000);
    }
    return '';
  }

  async function getBatch() {
    return new Promise(resolve => chrome.storage.local.get(COURSE_KEY, result => resolve(result[COURSE_KEY] || null)));
  }

  async function setBatch(batch) {
    return new Promise(resolve => chrome.storage.local.set({ [COURSE_KEY]: batch }, resolve));
  }

  async function clearBatch() {
    return new Promise(resolve => chrome.storage.local.remove(COURSE_KEY, resolve));
  }

  function updateBatchUi(batch) {
    const all = document.getElementById('ghl-video-download-all-btn');
    const stop = document.getElementById('ghl-video-download-cancel-btn');
    const info = document.getElementById('ghl-video-batch-status');
    if (!all || !stop || !info) return;
    const active = !!batch?.active;
    all.style.display = active ? 'none' : '';
    stop.style.display = active ? '' : 'none';
    info.textContent = active ? `Automatic course download: ${batch.downloaded || 0} completed` : '';
  }

  async function downloadCurrent(status, btn, batchMode = false) {
    if (state.downloading) throw new Error('A download is already running.');
    state.downloading = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = batchMode ? 'Downloading course…' : 'Preparing…';
    }

    const progressRow = document.getElementById('ghl-video-download-progress-row');
    const progress = document.getElementById('ghl-video-download-progress');
    const percent = document.getElementById('ghl-video-download-percent');
    if (progressRow && progress && percent) {
      progressRow.style.display = 'flex';
      progress.value = 0;
      percent.textContent = '0%';
    }

    try {
      await resetMediaDetection();
      status.textContent = `Starting ${lessonName()} automatically to detect stream…`;
      const url = await detectMedia(status);
      if (!url) throw new Error('Full video stream not found after automatic playback.');

      status.textContent = isHls(url) ? 'Stream detected — preparing HLS download…' : 'Stream detected — starting download…';
      const result = await chrome.runtime.sendMessage({
        type: 'DOWNLOAD_MEDIA',
        url,
        filenameBase: lessonName()
      });
      if (!result?.ok) throw new Error(result?.error || 'Download failed');
      status.textContent = result.message || 'Download started.';
      return result;
    } finally {
      state.downloading = false;
      if (btn?.isConnected) {
        btn.disabled = false;
        btn.textContent = '⬇ Download Video';
      }
    }
  }

  async function navigateNext(batch, status) {
    const next = nextLessonTarget();
    if (next && safeClick(next)) {
      status.textContent = `Download complete. Moving to next lesson: ${next.title}`;
      batch.awaitingCategory = false;
      await setBatch(batch);
      return true;
    }

    const nextButton = findNextLessonControl();
    if (nextButton && safeClick(nextButton)) {
      status.textContent = 'Download complete. Moving to the next lesson…';
      batch.awaitingCategory = false;
      await setBatch(batch);
      return true;
    }

    const nextCategory = findNextCategoryControl();
    if (nextCategory && safeClick(nextCategory)) {
      status.textContent = 'Category complete. Moving to the next category…';
      batch.awaitingCategory = true;
      await setBatch(batch);
      return true;
    }

    return false;
  }

  async function startBatch(status) {
    if (!findVideo()) {
      status.textContent = 'Open a lesson with a video first, then click Download All Course Videos.';
      return;
    }
    const batch = {
      active: true,
      startedAt: Date.now(),
      completed: [],
      failed: [],
      downloaded: 0,
      retries: {},
      awaitingCategory: false
    };
    await setBatch(batch);
    state.navLock = false;
    status.textContent = 'Automatic course download started…';
    setTimeout(runBatch, 200);
  }

  async function stopBatch(status) {
    await clearBatch();
    state.navLock = false;
    updateBatchUi(null);
    if (status) status.textContent = 'Automatic course download stopped.';
  }

  async function runBatch() {
    if (state.batchBusy || state.downloading || state.navLock) return;
    const batch = await getBatch();
    updateBatchUi(batch);
    if (!batch?.active) return;

    const status = document.getElementById('ghl-video-download-status');
    const btn = document.getElementById('ghl-video-download-btn');
    if (!status) return;

    const video = findVideo();
    if (!video) {
      if (batch.awaitingCategory) {
        const first = getLessonAnchors()[0];
        if (first && safeClick(first)) {
          batch.awaitingCategory = false;
          await setBatch(batch);
          state.navLock = true;
          status.textContent = `Opening first lesson: ${first.title}`;
          return;
        }
      }
      setTimeout(runBatch, 900);
      return;
    }

    const signature = lessonSignature();
    if ((batch.completed || []).includes(signature)) {
      state.navLock = true;
      const moved = await navigateNext(batch, status);
      if (!moved) {
        await clearBatch();
        updateBatchUi(null);
        status.textContent = `Course complete — downloaded ${batch.downloaded || 0} videos.`;
      }
      return;
    }

    if (!btn) return;
    state.batchBusy = true;
    try {
      status.textContent = `Automatic download ${Number(batch.downloaded || 0) + 1}: ${lessonName()}`;
      await downloadCurrent(status, btn, true);

      batch.completed = [...new Set([...(batch.completed || []), signature])];
      batch.downloaded = Number(batch.downloaded || 0) + 1;
      delete (batch.retries || {})[signature];
      await setBatch(batch);
      updateBatchUi(batch);

      state.navLock = true;
      await sleep(700);
      const moved = await navigateNext(batch, status);
      if (!moved) {
        await clearBatch();
        updateBatchUi(null);
        status.textContent = `Course complete — downloaded ${batch.downloaded} videos.`;
      }
    } catch (error) {
      batch.retries = batch.retries || {};
      const tries = Number(batch.retries[signature] || 0) + 1;
      batch.retries[signature] = tries;
      await setBatch(batch);

      if (tries < 2) {
        status.textContent = `Could not detect the stream. Retrying ${lessonName()} once…`;
        await sleep(1800);
      } else {
        batch.failed = [...(batch.failed || []), { lesson: lessonName(), error: error.message || String(error) }];
        batch.completed = [...new Set([...(batch.completed || []), signature])];
        await setBatch(batch);
        status.textContent = `Could not download ${lessonName()}. Moving to the next lesson…`;
        state.navLock = true;
        await sleep(700);
        const moved = await navigateNext(batch, status);
        if (!moved) {
          await clearBatch();
          updateBatchUi(null);
        }
      }
    } finally {
      state.batchBusy = false;
      if (!state.navLock) setTimeout(runBatch, 350);
    }
  }

  function mount() {
    const video = findVideo();
    if (!video?.parentElement) return;

    const old = document.getElementById('ghl-video-downloader-wrap');
    if (state.mountedVideo === video && old?.isConnected) return;
    old?.remove();

    const wrap = document.createElement('div');
    wrap.id = 'ghl-video-downloader-wrap';

    const btn = document.createElement('button');
    btn.id = 'ghl-video-download-btn';
    btn.type = 'button';
    btn.textContent = '⬇ Download Video';

    const all = document.createElement('button');
    all.id = 'ghl-video-download-all-btn';
    all.type = 'button';
    all.textContent = '⬇ Download All Course Videos';

    const stop = document.createElement('button');
    stop.id = 'ghl-video-download-cancel-btn';
    stop.type = 'button';
    stop.textContent = '■ Stop Auto Download';
    stop.style.display = 'none';

    const status = document.createElement('span');
    status.id = 'ghl-video-download-status';
    status.textContent = 'File name: ' + lessonName();

    const batchInfo = document.createElement('span');
    batchInfo.id = 'ghl-video-batch-status';

    const row = document.createElement('div');
    row.id = 'ghl-video-download-progress-row';
    const progress = document.createElement('progress');
    progress.id = 'ghl-video-download-progress';
    progress.max = 100;
    progress.value = 0;
    const percent = document.createElement('span');
    percent.id = 'ghl-video-download-percent';
    percent.textContent = '0%';
    row.append(progress, percent);

    wrap.append(btn, all, stop, status, batchInfo, row);
    const container = video.closest('[class*="video"], [class*="player"], .aspect-video') || video.parentElement;
    container.insertAdjacentElement('afterend', wrap);

    btn.addEventListener('click', async () => {
      try {
        await downloadCurrent(status, btn, false);
      } catch (error) {
        status.textContent = `Download failed: ${error.message || error}`;
      }
    });
    all.addEventListener('click', () => startBatch(status));
    stop.addEventListener('click', () => stopBatch(status));

    state.mountedVideo = video;
    getBatch().then(batch => {
      updateBatchUi(batch);
      if (batch?.active) setTimeout(runBatch, 250);
    });
  }

  function detectLessonChange() {
    const signature = lessonSignature();
    if (!signature || signature === state.lastLessonSignature) return;

    const previous = state.lastLessonSignature;
    state.lastLessonSignature = signature;
    if (!previous) return;

    state.navLock = false;
    state.mountedVideo = null;
    clearLocalMedia();
    clearWorkerMedia();
    setTimeout(mount, 120);
    setTimeout(runBatch, 450);
  }

  injectProbe();
  state.lastLessonSignature = lessonSignature();
  mount();

  const observer = new MutationObserver(() => {
    detectLessonChange();
    mount();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-current'] });

  setInterval(() => {
    detectLessonChange();
    mount();
    runBatch();
  }, 1200);
})();
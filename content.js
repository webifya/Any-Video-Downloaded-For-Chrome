(() => {
  if (window.top !== window.self && !document.querySelector('video')) return;

  const COURSE_KEY = 'ghlCourseBatchV132';
  const state = {
    mediaUrls: new Map(),
    mountedFor: null,
    downloading: false,
    batchStarting: false,
    navLock: false,
    lessonToken: normalizeUrl(location.href)
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'DOWNLOAD_PROGRESS') return;
    const row = document.getElementById('ghl-video-download-progress-row');
    const bar = document.getElementById('ghl-video-download-progress');
    const pct = document.getElementById('ghl-video-download-percent');
    const status = document.getElementById('ghl-video-download-status');
    if (!row || !bar || !pct) return;
    row.style.display = 'flex';
    const percent = Math.max(0, Math.min(100, Number(msg.percent) || 0));
    bar.value = percent;
    pct.textContent = `${Math.round(percent)}%`;
    if (status && msg.text) status.textContent = msg.text;
  });

  function cleanName(name) {
    return (name || 'GHL Course Video')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180) || 'GHL Course Video';
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url, location.href);
      u.hash = '';
      return u.href;
    } catch (_) { return url || ''; }
  }

  function remember(url, source = 'page') {
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
    state.mediaUrls.set(url, { url, source, seenAt: Date.now() });
  }

  function clearLocalMedia() {
    state.mediaUrls.clear();
    try {
      performance.getEntriesByType('resource').forEach(entry => {
        const u = entry.name || '';
        if (isHls(u) || isDirectVideo(u)) remember(u, 'performance');
      });
    } catch (_) {}
  }

  async function clearWorkerMedia() {
    try { await chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA_CANDIDATES' }); } catch (_) {}
  }

  function injectProbe() {
    if (document.documentElement.dataset.ghlDownloaderProbe) return;
    document.documentElement.dataset.ghlDownloaderProbe = '1';
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('page-probe.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'GHL_VIDEO_DOWNLOADER_PROBE' || event.data?.type !== 'MEDIA_URLS') return;
    for (const u of event.data.urls || []) remember(u, 'probe');
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'MEDIA_SEEN' && msg.url) remember(msg.url, 'network');
  });

  function lessonName() {
    const breadcrumbNodes = [...document.querySelectorAll('[class*="breadcrumb"] a, [class*="breadcrumb"] span, nav[aria-label*="breadcrumb" i] a, nav[aria-label*="breadcrumb" i] span')];
    const breadcrumbTitles = breadcrumbNodes
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(t => /^\d{1,3}\s*[-.].{2,180}$/.test(t));
    if (breadcrumbTitles.length) return cleanName(breadcrumbTitles[breadcrumbTitles.length - 1]);

    const candidates = [...document.querySelectorAll('h1, h2, h3, [class*="lesson-title"], [class*="lesson_name"], [class*="title"]')]
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length >= 3 && t.length <= 220)
      .filter(t => !/about this lesson|instructor|login|sign up|courses|categories/i.test(t));
    const numbered = candidates.find(t => /^\d{1,3}\s*[-.]/.test(t));
    if (numbered) return cleanName(numbered);
    return cleanName(document.title.split('|')[0]);
  }

  function findVideo() {
    const videos = [...document.querySelectorAll('video')].filter(v => {
      const r = v.getBoundingClientRect();
      return r.width > 100 && r.height > 70;
    });
    return videos.sort((a,b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    })[0] || document.querySelector('video');
  }

  function isHls(u) { return /\.m3u8(?:$|[?#])/i.test(u || '') || /(?:m3u8|playlist|manifest)/i.test(u || ''); }
  function isDirectVideo(u) { return /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i.test(u || ''); }
  function isLikelySegment(u) { return /\.(?:m4s|ts|aac)(?:$|[?#])/i.test(u || '') || /segment|chunk|frag(?:ment)?/i.test(u || ''); }

  async function getNetworkCandidates() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'GET_MEDIA_CANDIDATES' });
      for (const item of r?.items || []) remember(item.url, 'network-cache');
    } catch (_) {}
  }

  function bestMediaUrl(video) {
    const direct = [video?.currentSrc, video?.src, video?.querySelector('source')?.src]
      .find(u => u && !u.startsWith('blob:') && (isHls(u) || isDirectVideo(u)));
    if (direct) return direct;

    const items = [...state.mediaUrls.values()].sort((a,b) => b.seenAt - a.seenAt);
    const hls = items.find(x => isHls(x.url));
    if (hls) return hls.url;
    const directVideo = items.find(x => isDirectVideo(x.url) && !isLikelySegment(x.url));
    return directVideo?.url || '';
  }

  async function forcePlayerActivity(video, status, elapsed, batch) {
    if (!video) return;
    try {
      video.muted = true;
      video.volume = 0;
      video.autoplay = true;
      if (video.paused) await video.play();
    } catch (_) {
      const play = [...document.querySelectorAll('button, [role="button"]')].find(el => {
        const t = ((el.getAttribute('aria-label') || '') + ' ' + (el.title || '') + ' ' + (el.textContent || '')).trim();
        return /(^|\s)play(\s|$)/i.test(t) && el.offsetParent !== null;
      });
      try { play?.click(); } catch (_) {}
    }

    if (elapsed >= 6 && Number.isFinite(video.duration) && video.duration > 12) {
      try {
        const target = Math.min(Math.max(2, video.duration * 0.04), 8);
        if (Math.abs(video.currentTime - target) > 1) video.currentTime = target;
      } catch (_) {}
    }
    if (status) status.textContent = batch
      ? `Waiting for GHL video stream… ${elapsed}s`
      : `Waiting for GHL video stream… ${elapsed}s`;
  }

  async function detectMediaUrl(status, options = {}) {
    const timeout = options.timeout || 22000;
    const started = Date.now();
    let lastVideo = findVideo();

    while (Date.now() - started < timeout) {
      const video = findVideo() || lastVideo;
      if (video) lastVideo = video;
      await getNetworkCandidates();
      const url = bestMediaUrl(video);
      if (url) return { url, video };

      const elapsed = Math.floor((Date.now() - started) / 1000);
      await forcePlayerActivity(video, status, elapsed, options.batch);
      await sleep(elapsed < 5 ? 700 : 1100);
    }
    return { url: '', video: lastVideo };
  }

  function lessonText(el) { return (el?.textContent || '').replace(/\s+/g, ' ').trim(); }
  function isNumberedLessonText(text) { return /^\d{1,3}\s*[-.)]\s*\S|^\d{1,3}\s*-\S/.test(text || ''); }

  function getLessonAnchors() {
    const unique = new Map();
    for (const a of [...document.querySelectorAll('a[href]')]) {
      const text = lessonText(a);
      if (!isNumberedLessonText(text)) continue;
      let u; try { u = new URL(a.href, location.href); } catch (_) { continue; }
      if (u.origin !== location.origin) continue;
      const url = normalizeUrl(u.href);
      if (!unique.has(url)) unique.set(url, { el:a, url, title:cleanName(text) });
    }
    return [...unique.values()];
  }

  function isCurrentLessonElement(el) {
    if (!el) return false;
    if (el.matches('[aria-current="page"], [aria-current="true"]')) return true;
    return !!el.closest('[aria-current="page"], [aria-current="true"], .active, [class*="active"], [class*="selected"]');
  }

  function nextLessonTarget() {
    const items = getLessonAnchors();
    const here = normalizeUrl(location.href);
    if (!items.length) return null;
    const exact = items.findIndex(x => x.url === here);
    if (exact >= 0 && exact + 1 < items.length) return items[exact + 1];
    const active = items.findIndex(x => isCurrentLessonElement(x.el));
    if (active >= 0 && active + 1 < items.length) return items[active + 1];
    const currentTitle = lessonName().toLowerCase();
    const sameTitle = items.findIndex(x => x.title.toLowerCase() === currentTitle);
    if (sameTitle >= 0 && sameTitle + 1 < items.length) return items[sameTitle + 1];
    return items.find(x => x.url !== here) || null;
  }

  function findNextCategoryControl() {
    const els = [...document.querySelectorAll('a[href], button, [role="button"]')];
    return els.find(el => /^\s*next\s+(category|module|section)\s*$/i.test(lessonText(el))) || null;
  }
  function firstLessonTarget() {
    const here = normalizeUrl(location.href);
    return getLessonAnchors().find(x => x.url !== here) || null;
  }

  async function getBatch() { return new Promise(resolve => chrome.storage.local.get(COURSE_KEY, r => resolve(r[COURSE_KEY] || null))); }
  async function setBatch(batch) { return new Promise(resolve => chrome.storage.local.set({ [COURSE_KEY]: batch }, resolve)); }
  async function clearBatch() { return new Promise(resolve => chrome.storage.local.remove(COURSE_KEY, resolve)); }

  async function startBatch(status) {
    if (!findVideo()) {
      status.textContent = 'Open a lesson with a video first, then click Download All Course Videos.';
      return;
    }
    const batch = { active:true, startedAt:Date.now(), courseOrigin:location.origin, completed:[], failures:[], count:0, awaitingCategory:false, lastLessonUrl:null, lastLessonTitle:null, retries:{} };
    await setBatch(batch);
    status.textContent = 'Automatic course download started. Preparing the current lesson…';
    setTimeout(maybeRunBatch, 200);
  }

  async function cancelBatch(status) {
    await clearBatch();
    if (status) status.textContent = 'Automatic course download stopped.';
    updateBatchControls(null);
  }

  function updateBatchControls(batch) {
    const allBtn = document.getElementById('ghl-video-download-all-btn');
    const cancelBtn = document.getElementById('ghl-video-download-cancel-btn');
    const batchText = document.getElementById('ghl-video-batch-status');
    if (!allBtn || !cancelBtn || !batchText) return;
    const active = !!batch?.active;
    allBtn.style.display = active ? 'none' : '';
    cancelBtn.style.display = active ? '' : 'none';
    batchText.textContent = active ? `Automatic course download: ${batch.count || 0} completed` : '';
  }

  async function download(btn, status, options = {}) {
    const name = options.filenameBase || lessonName();
    state.downloading = true;
    if (btn) { btn.disabled = true; btn.textContent = options.batch ? 'Downloading course…' : 'Preparing…'; }

    const progressRow = document.getElementById('ghl-video-download-progress-row');
    const progress = document.getElementById('ghl-video-download-progress');
    const percentText = document.getElementById('ghl-video-download-percent');
    if (progressRow && progress && percentText) {
      progressRow.style.display = 'flex'; progress.value = 0; percentText.textContent = '0%';
    }

    try {
      status.textContent = options.batch ? `Starting ${name} automatically to detect stream…` : 'Starting video automatically to detect stream…';
      const detected = await detectMediaUrl(status, { timeout: 22000, batch: !!options.batch });
      if (!detected.url) throw new Error('Full video stream not found after automatic playback and 22-second detection.');

      status.textContent = isHls(detected.url) ? 'Stream detected — preparing full HLS lesson…' : 'Stream detected — starting full video download…';
      const result = await chrome.runtime.sendMessage({ type:'DOWNLOAD_MEDIA', url:detected.url, filenameBase:name });
      if (!result?.ok) throw new Error(result?.error || 'Download failed');
      status.textContent = result.message || 'Download started.';
      return result;
    } finally {
      state.downloading = false;
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = '⬇ Download Video'; }
    }
  }

  async function resetForNewLesson() {
    clearLocalMedia();
    await clearWorkerMedia();
    state.lessonToken = normalizeUrl(location.href);
  }

  async function navigateAfterLesson(batch, status) {
    const next = nextLessonTarget();
    if (next) {
      status.textContent = `Download complete. Opening next lesson: ${next.title}`;
      batch.awaitingCategory = false;
      await setBatch(batch);
      await sleep(900);
      location.assign(next.url);
      return true;
    }
    const nextCategory = findNextCategoryControl();
    if (nextCategory) {
      status.textContent = 'Category complete. Opening the next category…';
      batch.awaitingCategory = true;
      await setBatch(batch);
      await sleep(600);
      if (nextCategory.tagName === 'A' && nextCategory.href) location.assign(nextCategory.href); else nextCategory.click();
      return true;
    }
    return false;
  }

  async function maybeRunBatch() {
    if (state.batchStarting || state.downloading || state.navLock) return;
    const batch = await getBatch();
    updateBatchControls(batch);
    if (!batch?.active || (batch.courseOrigin && batch.courseOrigin !== location.origin)) return;

    const status = document.getElementById('ghl-video-download-status');
    if (!status) return;

    let video = findVideo();
    if (!video && batch.awaitingCategory) {
      const first = firstLessonTarget();
      if (first) {
        state.navLock = true;
        batch.awaitingCategory = false;
        await setBatch(batch);
        status.textContent = `Opening first lesson in the new category: ${first.title}`;
        await sleep(500);
        location.assign(first.url);
        return;
      }
      setTimeout(maybeRunBatch, 1000);
      return;
    }
    if (!video) { setTimeout(maybeRunBatch, 1000); return; }

    const currentUrl = normalizeUrl(location.href);
    const currentTitle = lessonName();

    if ((batch.completed || []).includes(currentUrl)) {
      state.navLock = true;
      const moved = await navigateAfterLesson(batch, status);
      if (!moved) {
        await clearBatch(); updateBatchControls(null);
        status.textContent = `Course complete — downloaded ${batch.count || batch.completed.length} videos.`;
      }
      return;
    }

    const btn = document.getElementById('ghl-video-download-btn');
    if (!btn) return;
    state.batchStarting = true;
    updateBatchControls(batch);

    try {
      await resetForNewLesson();
      status.textContent = `Automatic download — video ${(batch.count || 0) + 1}: ${currentTitle}`;
      await download(btn, status, { batch:true, filenameBase:currentTitle });
      batch.completed = [...new Set([...(batch.completed || []), currentUrl])];
      batch.count = batch.completed.length;
      batch.lastLessonUrl = currentUrl;
      batch.lastLessonTitle = currentTitle;
      delete (batch.retries || {})[currentUrl];
      await setBatch(batch);
      updateBatchControls(batch);
      state.navLock = true;
      const moved = await navigateAfterLesson(batch, status);
      if (!moved) {
        await clearBatch(); updateBatchControls(null);
        status.textContent = `Course complete — downloaded ${batch.count} videos.`;
      }
    } catch (e) {
      batch.retries = batch.retries || {};
      const tries = (batch.retries[currentUrl] || 0) + 1;
      batch.retries[currentUrl] = tries;
      await setBatch(batch);

      if (tries < 2) {
        status.textContent = `Stream detection failed for ${currentTitle}. Retrying this lesson once…`;
        await resetForNewLesson();
        await sleep(2500);
        state.batchStarting = false;
        setTimeout(maybeRunBatch, 250);
        return;
      }

      batch.failures = [...(batch.failures || []), { url:currentUrl, title:currentTitle, error:e.message || String(e) }];
      batch.completed = [...new Set([...(batch.completed || []), currentUrl])];
      await setBatch(batch);
      status.textContent = `Could not download ${currentTitle}: ${e.message}. Moving to the next lesson…`;
      state.navLock = true;
      await sleep(1200);
      const moved = await navigateAfterLesson(batch, status);
      if (!moved) {
        const failed = batch.failures.length;
        await clearBatch(); updateBatchControls(null);
        status.textContent = `Course batch finished. ${batch.count || 0} downloaded, ${failed} failed.`;
      }
    } finally {
      state.batchStarting = false;
    }
  }

  function mount() {
    const video = findVideo();
    if (!video || !video.parentElement) return;
    const existing = document.getElementById('ghl-video-downloader-wrap');
    if (state.mountedFor === video && existing?.isConnected) return;
    existing?.remove();

    const wrap = document.createElement('div'); wrap.id = 'ghl-video-downloader-wrap';
    const btn = document.createElement('button'); btn.id='ghl-video-download-btn'; btn.type='button'; btn.textContent='⬇ Download Video';
    const allBtn = document.createElement('button'); allBtn.id='ghl-video-download-all-btn'; allBtn.type='button'; allBtn.textContent='⬇ Download All Course Videos';
    const cancelBtn = document.createElement('button'); cancelBtn.id='ghl-video-download-cancel-btn'; cancelBtn.type='button'; cancelBtn.textContent='■ Stop Auto Download'; cancelBtn.style.display='none';
    const status = document.createElement('span'); status.id='ghl-video-download-status'; status.textContent='File name: ' + lessonName();
    const batchText = document.createElement('span'); batchText.id='ghl-video-batch-status';
    const progressRow = document.createElement('div'); progressRow.id='ghl-video-download-progress-row';
    const progress = document.createElement('progress'); progress.id='ghl-video-download-progress'; progress.max=100; progress.value=0;
    const percentText = document.createElement('span'); percentText.id='ghl-video-download-percent'; percentText.textContent='0%';
    progressRow.append(progress, percentText); wrap.append(btn, allBtn, cancelBtn, status, batchText, progressRow);

    const container = video.closest('[class*="video"], [class*="player"], .aspect-video') || video.parentElement;
    container.insertAdjacentElement('afterend', wrap);

    btn.addEventListener('click', async () => {
      try {
        await resetForNewLesson();
        await download(btn, status, { filenameBase: lessonName() });
      } catch (e) { status.textContent = `Download failed: ${e.message}`; }
    });
    allBtn.addEventListener('click', () => startBatch(status));
    cancelBtn.addEventListener('click', () => cancelBatch(status));

    state.mountedFor = video;
    getBatch().then(updateBatchControls).then(() => setTimeout(maybeRunBatch, 200));
  }

  function watchLessonChange() {
    const now = normalizeUrl(location.href);
    if (now !== state.lessonToken) {
      state.lessonToken = now;
      state.navLock = false;
      state.mountedFor = null;
      clearLocalMedia();
      clearWorkerMedia();
      setTimeout(mount, 150);
      setTimeout(maybeRunBatch, 500);
    }
  }

  injectProbe();
  mount();
  const observer = new MutationObserver(() => { watchLessonChange(); mount(); });
  observer.observe(document.documentElement, { childList:true, subtree:true });
  setInterval(() => { watchLessonChange(); mount(); maybeRunBatch(); }, 1200);
})();

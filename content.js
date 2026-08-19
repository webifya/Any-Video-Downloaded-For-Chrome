(() => {
  if (window.top !== window.self) return;

  const BATCH_KEY = 'ghlCourseBatchV140';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const state = {
    media: new Map(), downloading: false, batchBusy: false, mountedVideo: null,
    lastPageKey: '', navigationDeadline: 0, lastControlsRoot: null
  };

  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const txt = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();

  function cleanName(value) {
    return (value || 'GHL Course Video').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 180) || 'GHL Course Video';
  }
  function normalizeTitle(value) { return cleanName(value).toLowerCase().replace(/\s+/g, ' ').trim(); }
  function normalizeUrl(value) {
    try { const u = new URL(value, location.href); u.hash = ''; return u.href; } catch (_) { return value || ''; }
  }
  function isHls(url) { return /\.m3u8(?:$|[?#])/i.test(url || '') || /(?:m3u8|playlist|manifest)/i.test(url || ''); }
  function isDirectVideo(url) { return /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i.test(url || ''); }
  function isNumberedLessonText(value) { return /^\s*\d{1,3}\s*(?:[-.)]|\s+-\s+)\s*\S/.test(value || ''); }

  function visible(el) {
    if (!el?.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findVideo() {
    const videos = qsa('video').filter(v => {
      const r = v.getBoundingClientRect();
      return r.width > 140 && r.height > 80 && visible(v);
    });
    return videos.sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    })[0] || qs('video');
  }

  function badDestination(href) {
    if (!href) return false;
    try {
      const u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol)) return false;
      if (u.origin !== location.origin) return true;
      const path = u.pathname.replace(/\/+$/, '').toLowerCase();
      if (/(^|\/)(dashboard|home|login|logout)$/.test(path)) return true;
      if (/(^|\/)(courses?|products?|memberships?|communities|library)$/.test(path) && !/lesson|post|module|chapter|category|training/i.test(path)) return true;
      return false;
    } catch (_) { return false; }
  }

  function interactiveAncestor(el) {
    if (!el) return null;
    if (el.matches?.('a[href], button, [role="button"], [role="link"], [tabindex]')) return el;
    return el.closest?.('a[href], button, [role="button"], [role="link"], [tabindex]') || null;
  }
  function candidateInteractiveElements(root = document) {
    return qsa('a[href], button, [role="button"], [role="link"], [tabindex]', root).filter(visible);
  }
  function extractLessonTitle(el) {
    const full = txt(el);
    if (isNumberedLessonText(full)) return cleanName(full);
    const numbered = qsa('span, div, p, strong, b', el).map(txt)
      .filter(t => t && t.length <= 220 && isNumberedLessonText(t)).sort((a, b) => a.length - b.length)[0];
    return numbered ? cleanName(numbered) : '';
  }

  function scoreRoot(root) {
    if (!root || root === document.body || !visible(root)) return -Infinity;
    const items = candidateInteractiveElements(root).map(el => extractLessonTitle(el)).filter(Boolean);
    const unique = new Set(items.map(normalizeTitle)).size;
    if (unique < 2) return -Infinity;
    const hint = `${root.id || ''} ${root.className || ''} ${root.getAttribute?.('role') || ''}`;
    let bonus = 0;
    if (/lesson|curriculum|sidebar|syllabus|chapter/i.test(hint)) bonus += 30;
    if (/course|module|category|menu|nav/i.test(hint)) bonus += 15;
    if (root.matches?.('aside, nav, ul, ol')) bonus += 12;
    const rect = root.getBoundingClientRect();
    const areaPenalty = Math.min(20, (rect.width * rect.height) / Math.max(1, innerWidth * innerHeight) * 8);
    return unique * 20 + bonus - areaPenalty;
  }

  function findCurriculumRoot() {
    const seeds = [];
    for (const el of candidateInteractiveElements(document)) {
      if (!extractLessonTitle(el)) continue;
      let p = el.parentElement;
      for (let depth = 0; p && depth < 7; depth++, p = p.parentElement) seeds.push(p);
    }
    let best = null, bestScore = -Infinity;
    for (const root of [...new Set(seeds)]) {
      const score = scoreRoot(root);
      if (score > bestScore) { bestScore = score; best = root; }
    }
    state.lastControlsRoot = best || state.lastControlsRoot;
    return best || state.lastControlsRoot || document;
  }

  function getLessonItems() {
    const root = findCurriculumRoot(), seen = new Set(), items = [];
    for (const el of candidateInteractiveElements(root)) {
      const title = extractLessonTitle(el);
      if (!title) continue;
      const key = normalizeTitle(title);
      if (seen.has(key)) continue;
      if (el.tagName === 'A' && badDestination(el.href)) continue;
      seen.add(key);
      items.push({ el, title, key, href: el.tagName === 'A' ? normalizeUrl(el.href) : '' });
    }
    return items;
  }

  function activeScore(el) {
    if (!el) return 0;
    let score = 0;
    if (el.matches?.('[aria-current="page"], [aria-current="true"], .active, .selected, [data-active="true"]')) score += 100;
    const holder = el.closest?.('[aria-current="page"], [aria-current="true"], .active, .selected, [data-active="true"], [class*="active"], [class*="selected"]');
    if (holder) score += 45;
    if (/current|playing|open/i.test(`${el.className || ''} ${holder?.className || ''}`)) score += 20;
    return score;
  }

  function headingLessonTitle() {
    const headings = qsa('h1, h2, h3, [class*="lesson-title"], [class*="lesson_name"], [data-testid*="lesson"]')
      .map(txt).filter(t => t.length >= 3 && t.length <= 220)
      .filter(t => !/about this lesson|instructor|dashboard|courses|categories|login|sign up/i.test(t));
    return headings.find(isNumberedLessonText) || headings[0] || '';
  }

  function currentLessonItem(items = getLessonItems()) {
    if (!items.length) return null;
    const byActive = items.map(item => ({ item, score: activeScore(item.el) })).sort((a, b) => b.score - a.score)[0];
    if (byActive?.score > 0) return byActive.item;
    const here = normalizeUrl(location.href);
    const byHref = items.find(item => item.href && item.href === here);
    if (byHref) return byHref;
    const heading = normalizeTitle(headingLessonTitle());
    if (heading) {
      return items.find(item => item.key === heading) || items.find(item => item.key.includes(heading) || heading.includes(item.key)) || null;
    }
    return null;
  }

  function lessonName() {
    const item = currentLessonItem();
    if (item?.title) return cleanName(item.title);
    const heading = headingLessonTitle();
    return cleanName(heading || document.title.split('|')[0]);
  }

  function pageKey() {
    const item = currentLessonItem(), video = findVideo();
    const src = video?.currentSrc || video?.src || '';
    return `${item?.key || normalizeTitle(lessonName())}|${normalizeUrl(location.href)}|${src.startsWith('blob:') ? 'blob' : src}`;
  }

  function remember(url, source = 'page') {
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
    if (!isHls(url) && !isDirectVideo(url)) return;
    state.media.set(url, { url, source, seenAt: Date.now() });
  }
  function clearLocalMedia() { state.media.clear(); }
  async function clearWorkerMedia() { try { await chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA_CANDIDATES' }); } catch (_) {} }
  async function resetMediaDetection() { clearLocalMedia(); await clearWorkerMedia(); }

  function injectProbe() {
    if (document.documentElement.dataset.ghlDownloaderProbe140) return;
    document.documentElement.dataset.ghlDownloaderProbe140 = '1';
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
    const row = qs('#ghl-video-download-progress-row'), bar = qs('#ghl-video-download-progress'), pct = qs('#ghl-video-download-percent'), status = qs('#ghl-video-download-status');
    if (!row || !bar || !pct) return;
    const percent = Math.max(0, Math.min(100, Number(msg.percent) || 0));
    row.style.display = 'flex'; bar.value = percent; pct.textContent = `${Math.round(percent)}%`;
    if (status && msg.text) status.textContent = msg.text;
  });

  async function getNetworkCandidates() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_MEDIA_CANDIDATES' });
      for (const item of result?.items || []) remember(item.url, 'network-cache');
    } catch (_) {}
  }
  function bestMediaUrl(video) {
    const direct = [video?.currentSrc, video?.src, qs('source', video)?.src]
      .find(url => url && !url.startsWith('blob:') && (isHls(url) || isDirectVideo(url)));
    if (direct) return direct;
    const candidates = [...state.media.values()].sort((a, b) => b.seenAt - a.seenAt);
    return candidates.find(item => isHls(item.url))?.url || candidates.find(item => isDirectVideo(item.url))?.url || '';
  }

  function findPlayControl() {
    return candidateInteractiveElements(document).find(el => {
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${txt(el)}`.trim();
      return /(^|\s)play(\s|$)/i.test(label) && !/replay|playlist/i.test(label);
    }) || null;
  }

  async function forcePlayback(video, status, elapsed) {
    video = findVideo() || video;
    if (!video) return;
    try { video.muted = true; video.volume = 0; video.autoplay = true; if (video.paused) await video.play(); }
    catch (_) { try { findPlayControl()?.click(); } catch (_) {} }
    if (elapsed >= 5 && Number.isFinite(video.duration) && video.duration > 12) {
      try {
        const seek = Math.min(Math.max(2, video.duration * 0.035), 7);
        if (Math.abs(video.currentTime - seek) > 1) video.currentTime = seek;
      } catch (_) {}
    }
    if (status) status.textContent = `Waiting for GHL video stream… ${elapsed}s`;
  }

  async function detectMedia(status, timeout = 30000) {
    const started = Date.now(); let video = findVideo();
    while (Date.now() - started < timeout) {
      video = findVideo() || video;
      await getNetworkCandidates();
      const url = bestMediaUrl(video);
      if (url) return url;
      const elapsed = Math.floor((Date.now() - started) / 1000);
      await forcePlayback(video, status, elapsed);
      await sleep(elapsed < 5 ? 650 : 1000);
    }
    return '';
  }

  async function getBatch() { return new Promise(resolve => chrome.storage.local.get(BATCH_KEY, r => resolve(r[BATCH_KEY] || null))); }
  async function setBatch(batch) { return new Promise(resolve => chrome.storage.local.set({ [BATCH_KEY]: batch }, resolve)); }
  async function clearBatch() { return new Promise(resolve => chrome.storage.local.remove(BATCH_KEY, resolve)); }
  function setStatus(message) { const status = qs('#ghl-video-download-status'); if (status) status.textContent = message; }

  function updateBatchUi(batch) {
    const all = qs('#ghl-video-download-all-btn'), stop = qs('#ghl-video-download-cancel-btn'), info = qs('#ghl-video-batch-status');
    if (!all || !stop || !info) return;
    const active = !!batch?.active, detected = getLessonItems().length;
    all.style.display = active ? 'none' : ''; stop.style.display = active ? '' : 'none';
    info.textContent = active ? `Automatic course download: ${batch.downloaded || 0} downloaded${detected ? ` • ${detected} lessons visible` : ''}` : (detected ? `${detected} lessons detected in current section` : '');
  }

  async function downloadCurrent(status, btn, batchMode = false) {
    if (state.downloading) throw new Error('A download is already running.');
    state.downloading = true;
    const fileBase = lessonName();
    if (btn) { btn.disabled = true; btn.textContent = batchMode ? 'Downloading course…' : 'Preparing…'; }
    const row = qs('#ghl-video-download-progress-row'), progress = qs('#ghl-video-download-progress'), percent = qs('#ghl-video-download-percent');
    if (row && progress && percent) { row.style.display = 'flex'; progress.value = 0; percent.textContent = '0%'; }
    try {
      await resetMediaDetection();
      status.textContent = `Starting ${fileBase} automatically to detect stream…`;
      const url = await detectMedia(status, 30000);
      if (!url) throw new Error('Full video stream not found after 30 seconds of automatic playback.');
      status.textContent = isHls(url) ? 'Stream detected — preparing HLS download…' : 'Stream detected — starting download…';
      const result = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_MEDIA', url, filenameBase: fileBase });
      if (!result?.ok) throw new Error(result?.error || 'Download failed');
      status.textContent = result.message || 'Download started.';
      return { ...result, fileBase };
    } finally {
      state.downloading = false;
      if (btn?.isConnected) { btn.disabled = false; btn.textContent = '⬇ Download Video'; }
    }
  }

  function findExplicitControl(pattern, rejectPattern = null) {
    const all = [...candidateInteractiveElements(findCurriculumRoot()), ...candidateInteractiveElements(document)], seen = new Set();
    for (const el of all) {
      if (seen.has(el)) continue; seen.add(el);
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${txt(el)}`.replace(/\s+/g, ' ').trim();
      if (!pattern.test(label) || rejectPattern?.test(label)) continue;
      if (el.tagName === 'A' && badDestination(el.href)) continue;
      return el;
    }
    return null;
  }

  async function clickAndVerify(el, description, timeout = 10000) {
    el = interactiveAncestor(el) || el;
    if (!el || !visible(el) || (el.tagName === 'A' && badDestination(el.href))) return false;
    const before = pageKey();
    state.navigationDeadline = Date.now() + timeout;
    try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (_) {}
    try { el.click(); }
    catch (_) { try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (_) { return false; } }
    setStatus(description);
    const started = Date.now();
    while (Date.now() - started < timeout) {
      await sleep(300);
      const now = pageKey();
      if (now !== before && (findVideo() || getLessonItems().length)) { state.navigationDeadline = 0; return true; }
    }
    state.navigationDeadline = 0;
    return false;
  }

  async function navigateToNextLesson(batch, status) {
    const items = getLessonItems(), current = currentLessonItem(items), completed = new Set(batch.completed || []);
    if (items.length) {
      let start = current ? items.findIndex(x => x.key === current.key) + 1 : 0;
      if (start < 0) start = 0;
      for (let i = start; i < items.length; i++) {
        const item = items[i];
        if (completed.has(item.key)) continue;
        if (await clickAndVerify(item.el, `Opening next lesson: ${item.title}`)) return true;
      }
    }
    const nextLesson = findExplicitControl(/\b(next\s+(lesson|step|video)|continue\s+(lesson|course)|continue)\b/i, /category|module|section|dashboard|home|course\s*home/i);
    if (nextLesson && await clickAndVerify(nextLesson, 'Opening the next lesson…')) return true;
    const nextCategory = findExplicitControl(/\bnext\s+(category|module|section|chapter)\b/i, /dashboard|home/i);
    if (nextCategory && await clickAndVerify(nextCategory, 'Opening the next category…', 12000)) {
      await sleep(700);
      const newItems = getLessonItems();
      const first = newItems.find(item => !completed.has(item.key));
      if (first && !findVideo()) return await clickAndVerify(first.el, `Opening first lesson: ${first.title}`);
      return true;
    }
    return false;
  }

  async function startBatch(status) {
    if (!findVideo()) { status.textContent = 'Open a lesson with a video first, then click Download All Course Videos.'; return; }
    const current = currentLessonItem();
    const batch = { active: true, startedAt: Date.now(), downloaded: 0, completed: [], failed: [], retries: {}, lastGoodUrl: normalizeUrl(location.href), lastGoodTitle: current?.title || lessonName() };
    await setBatch(batch);
    status.textContent = `Automatic course download started. ${getLessonItems().length} lessons currently detected.`;
    updateBatchUi(batch); setTimeout(runBatch, 250);
  }

  async function stopBatch(status) { await clearBatch(); updateBatchUi(null); if (status) status.textContent = 'Automatic course download stopped.'; }

  function looksLikeDashboardPage() {
    const path = location.pathname.replace(/\/+$/, '').toLowerCase();
    if (findVideo()) return false;
    return /(^|\/)(dashboard|home)$/.test(path) || /dashboard/i.test(document.title || '');
  }
  async function recoverFromBadNavigation(batch) {
    if (!batch?.active || !batch.lastGoodUrl || !looksLikeDashboardPage()) return false;
    location.replace(batch.lastGoodUrl); return true;
  }

  async function runBatch() {
    if (state.batchBusy || state.downloading || Date.now() < state.navigationDeadline) return;
    const batch = await getBatch(); updateBatchUi(batch);
    if (!batch?.active) return;
    if (await recoverFromBadNavigation(batch)) return;
    const status = qs('#ghl-video-download-status'), btn = qs('#ghl-video-download-btn');
    if (!status) return;
    if (!findVideo()) { setTimeout(runBatch, 900); return; }
    const current = currentLessonItem(), currentKey = current?.key || normalizeTitle(lessonName());
    if (!currentKey) return;
    batch.lastGoodUrl = normalizeUrl(location.href); batch.lastGoodTitle = current?.title || lessonName(); await setBatch(batch);

    if ((batch.completed || []).includes(currentKey)) {
      state.batchBusy = true;
      try {
        const moved = await navigateToNextLesson(batch, status);
        if (!moved) { await clearBatch(); updateBatchUi(null); status.textContent = `Course complete — downloaded ${batch.downloaded || 0} videos.`; }
      } finally { state.batchBusy = false; }
      return;
    }

    if (!btn) return;
    state.batchBusy = true;
    try {
      status.textContent = `Automatic download ${Number(batch.downloaded || 0) + 1}: ${lessonName()}`;
      await downloadCurrent(status, btn, true);
      batch.completed = [...new Set([...(batch.completed || []), currentKey])];
      batch.downloaded = Number(batch.downloaded || 0) + 1;
      batch.retries = batch.retries || {}; delete batch.retries[currentKey];
      batch.lastGoodUrl = normalizeUrl(location.href); batch.lastGoodTitle = lessonName();
      await setBatch(batch); updateBatchUi(batch);
      await sleep(600);
      const moved = await navigateToNextLesson(batch, status);
      if (!moved) { await clearBatch(); updateBatchUi(null); status.textContent = `Course complete — downloaded ${batch.downloaded} videos.`; }
    } catch (error) {
      batch.retries = batch.retries || {};
      const tries = Number(batch.retries[currentKey] || 0) + 1;
      batch.retries[currentKey] = tries; await setBatch(batch);
      if (tries < 3) {
        status.textContent = `Download failed for ${lessonName()}: ${error.message || error}. Retrying (${tries}/2)…`;
        await sleep(2000);
      } else {
        batch.failed = [...(batch.failed || []), { lesson: lessonName(), error: error.message || String(error) }];
        batch.completed = [...new Set([...(batch.completed || []), currentKey])]; await setBatch(batch);
        status.textContent = `Could not download ${lessonName()} after retries. Moving to the next lesson…`;
        await sleep(700);
        const moved = await navigateToNextLesson(batch, status);
        if (!moved) {
          const failures = batch.failed.length; await clearBatch(); updateBatchUi(null);
          status.textContent = `Course batch finished — ${batch.downloaded || 0} downloaded, ${failures} failed.`;
        }
      }
    } finally { state.batchBusy = false; setTimeout(runBatch, 450); }
  }

  function mount() {
    const video = findVideo(); if (!video?.parentElement) return;
    const old = qs('#ghl-video-downloader-wrap');
    if (state.mountedVideo === video && old?.isConnected) return;
    old?.remove();

    const wrap = document.createElement('div'); wrap.id = 'ghl-video-downloader-wrap';
    const btn = document.createElement('button'); btn.id = 'ghl-video-download-btn'; btn.type = 'button'; btn.textContent = '⬇ Download Video';
    const all = document.createElement('button'); all.id = 'ghl-video-download-all-btn'; all.type = 'button'; all.textContent = '⬇ Download All Course Videos';
    const stop = document.createElement('button'); stop.id = 'ghl-video-download-cancel-btn'; stop.type = 'button'; stop.textContent = '■ Stop Auto Download'; stop.style.display = 'none';
    const status = document.createElement('span'); status.id = 'ghl-video-download-status'; status.textContent = 'File name: ' + lessonName();
    const batchInfo = document.createElement('span'); batchInfo.id = 'ghl-video-batch-status';
    const row = document.createElement('div'); row.id = 'ghl-video-download-progress-row';
    const progress = document.createElement('progress'); progress.id = 'ghl-video-download-progress'; progress.max = 100; progress.value = 0;
    const percent = document.createElement('span'); percent.id = 'ghl-video-download-percent'; percent.textContent = '0%';
    row.append(progress, percent); wrap.append(btn, all, stop, status, batchInfo, row);
    const container = video.closest('[class*="video"], [class*="player"], .aspect-video') || video.parentElement;
    container.insertAdjacentElement('afterend', wrap);

    btn.addEventListener('click', async event => { event.preventDefault(); event.stopPropagation(); try { await downloadCurrent(status, btn, false); } catch (error) { status.textContent = `Download failed: ${error.message || error}`; } });
    all.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); startBatch(status); });
    stop.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); stopBatch(status); });
    state.mountedVideo = video;
    getBatch().then(batch => { updateBatchUi(batch); if (batch?.active) setTimeout(runBatch, 250); });
  }

  function detectPageChange() {
    const key = pageKey();
    if (!key || key === state.lastPageKey) return;
    const had = state.lastPageKey; state.lastPageKey = key;
    if (!had) return;
    state.mountedVideo = null; clearLocalMedia(); clearWorkerMedia();
    setTimeout(mount, 120); setTimeout(runBatch, 450);
  }

  injectProbe(); state.lastPageKey = pageKey(); mount();
  const observer = new MutationObserver(() => { detectPageChange(); mount(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-current', 'data-active', 'href'] });
  setInterval(() => { detectPageChange(); mount(); runBatch(); }, 1000);
})();
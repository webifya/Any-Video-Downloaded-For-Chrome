(() => {
  if (window.top !== window.self) return;

  const BATCH_KEY = 'ghlCourseBatchV140';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const txt = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const clean = value => (value || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 180);
  const keyOf = value => clean(value).toLowerCase().replace(/\s+/g, ' ').trim();
  const isLesson = value => /^\s*\d{1,3}\s*(?:[-.)]|\s+-\s+)\s*\S/.test(value || '');

  function visible(el) {
    if (!el?.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function extractTitle(el) {
    const full = txt(el);
    if (isLesson(full)) return clean(full);
    for (const n of el.querySelectorAll?.('span,div,p,strong,b') || []) {
      const t = txt(n);
      if (t.length <= 220 && isLesson(t)) return clean(t);
    }
    return '';
  }

  function lessonControls() {
    const out = [], seen = new Set();
    for (const el of document.querySelectorAll('a[href],button,[role="button"],[role="link"],[tabindex]')) {
      if (!visible(el)) continue;
      const title = extractTitle(el);
      if (!title) continue;
      const key = keyOf(title);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ el, title, key });
    }
    return out;
  }

  function headingTitle() {
    const candidates = [...document.querySelectorAll('h1,h2,h3,[class*="lesson-title"],[class*="lesson_name"],[data-testid*="lesson"]')]
      .map(txt)
      .filter(t => t && t.length <= 220);
    return clean(candidates.find(isLesson) || '');
  }

  function activeIndex(items) {
    const headingKey = keyOf(headingTitle());
    if (headingKey) {
      const exact = items.findIndex(x => x.key === headingKey);
      if (exact >= 0) return exact;
      const fuzzy = items.findIndex(x => x.key.includes(headingKey) || headingKey.includes(x.key));
      if (fuzzy >= 0) return fuzzy;
    }

    let best = -1, bestScore = 0;
    items.forEach((item, i) => {
      const el = item.el;
      let score = 0;
      if (el.matches?.('[aria-current="page"],[aria-current="true"],.active,.selected,[data-active="true"]')) score += 100;
      const holder = el.closest?.('[aria-current="page"],[aria-current="true"],.active,.selected,[data-active="true"],[class*="active"],[class*="selected"]');
      if (holder) score += 50;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  async function getBatch() {
    return new Promise(resolve => chrome.storage.local.get(BATCH_KEY, r => resolve(r[BATCH_KEY] || null)));
  }
  async function setBatch(batch) {
    return new Promise(resolve => chrome.storage.local.set({ [BATCH_KEY]: batch }, resolve));
  }

  async function enforceForwardOnlyStart() {
    await sleep(120);
    const batch = await getBatch();
    if (!batch?.active || batch.forwardOnlyInitialized) return;

    const items = lessonControls();
    const idx = activeIndex(items);
    if (idx < 0) return;

    const skipped = items.slice(0, idx).map(x => x.key);
    batch.completed = [...new Set([...(batch.completed || []), ...skipped])];
    batch.forwardOnlyInitialized = true;
    batch.startLessonKey = items[idx].key;
    batch.startLessonTitle = items[idx].title;
    batch.skippedBeforeStart = skipped;
    await setBatch(batch);

    const info = document.getElementById('ghl-video-batch-status');
    if (info) info.textContent = `Starting from current lesson: ${items[idx].title} • previous lessons skipped`;
  }

  document.addEventListener('click', event => {
    const btn = event.target?.closest?.('#ghl-video-download-all-btn');
    if (!btn) return;
    setTimeout(enforceForwardOnlyStart, 0);
  }, true);

  // Safety net: if the main script starts a batch programmatically, initialize it here too.
  setInterval(async () => {
    const batch = await getBatch();
    if (batch?.active && !batch.forwardOnlyInitialized) enforceForwardOnlyStart();
  }, 800);
})();

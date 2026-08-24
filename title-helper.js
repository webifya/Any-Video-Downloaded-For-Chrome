(() => {
  if (window.top !== window.self) return;

  const ID = 'avd-current-media-title';
  let timer = 0;
  let lastTitle = '';
  let lastUrl = location.href;

  const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const visible = el => {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const generic = s => !s || /^(home|courses?|categories?|lessons?|dashboard|instructor|watch|video|videos|reels?)$/i.test(s);

  function labelForInput(input) {
    const id = input.id;
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label && visible(label)) return clean(label.textContent);
    }
    const parent = input.closest('label,[role="radio"],[role="option"],li,div');
    return parent && visible(parent) ? clean(parent.textContent) : '';
  }

  function add(out, text, weight, reason) {
    const t = clean(text);
    if (!generic(t) && t.length >= 2 && t.length <= 180) out.push({ t, weight, reason });
  }

  function closestHeadingToPlayer(out) {
    const players = [...document.querySelectorAll('video,iframe,[class*="player"],[class*="video"]')]
      .filter(visible)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      });
    const player = players[0];
    if (!player) return;
    const pr = player.getBoundingClientRect();
    for (const el of document.querySelectorAll('h1,h2,h3,h4,[class*="lesson-title"],[class*="lesson_name"],[data-testid*="title"]')) {
      if (!visible(el) || el.id === ID) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > pr.top + 120) continue;
      const vertical = Math.max(0, pr.top - r.bottom);
      const horizontal = Math.max(0, Math.abs((r.left + r.width / 2) - (pr.left + pr.width / 2)) - pr.width / 2);
      const dist = vertical + horizontal * 0.2;
      if (dist <= 700) add(out, el.textContent, 150 - Math.min(80, dist / 8), 'near-player-heading');
    }
  }

  function currentTitle() {
    const out = [];

    // Checked lesson/radio controls are extremely reliable on course SPAs.
    for (const input of document.querySelectorAll('input[type="radio"]:checked,input[type="checkbox"]:checked')) {
      const t = labelForInput(input);
      if (t) add(out, t, 190, 'checked-control');
    }

    // Explicit current lesson states.
    const selected = [
      '[aria-selected="true"]', '[data-state="active"]', '[data-active="true"]', '[data-selected="true"]',
      '[role="option"][aria-selected="true"]', '[role="radio"][aria-checked="true"]',
      '[class*="lesson"][class*="active"]', '[class*="lesson"][class*="selected"]',
      '[class*="module"][class*="active"] [class*="lesson"]'
    ];
    for (const sel of selected) {
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el) || el.id === ID) continue;
        add(out, el.textContent, 175, 'selected-lesson');
      }
    }

    // The title immediately above the actual player is preferred over a course/module title.
    closestHeadingToPlayer(out);

    // Breadcrumbs: score later breadcrumb items higher than the course/root items.
    const crumbs = [...document.querySelectorAll('[aria-label*="breadcrumb" i] a,[aria-label*="breadcrumb" i] span,.breadcrumb a,.breadcrumb span,[class*="breadcrumb"] a,[class*="breadcrumb"] span')]
      .filter(el => visible(el) && el.id !== ID);
    crumbs.forEach((el, i) => add(out, el.textContent, 120 + i * 4, 'breadcrumb'));

    // Common LMS lesson sidebar patterns.
    for (const el of document.querySelectorAll('aside [aria-current="page"],aside [aria-current="true"],nav [aria-current="page"],[class*="lesson"] [aria-current="page"],[class*="lesson"] [aria-current="true"]')) {
      if (visible(el) && el.id !== ID) add(out, el.textContent, 165, 'sidebar-current');
    }

    // Main content heading fallback.
    for (const el of document.querySelectorAll('main h1,[role="main"] h1,article h1,main h2,[role="main"] h2')) {
      if (visible(el) && el.id !== ID) add(out, el.textContent, 105, 'main-heading');
    }

    // OpenGraph/document title are last-resort fallbacks only.
    add(out, document.querySelector('meta[property="og:title"]')?.content, 55, 'og-title');
    add(out, document.title.replace(/\s*[-|•]\s*(YouTube|Vimeo|Facebook|Instagram).*$/i, ''), 45, 'document-title');

    out.sort((a, b) => b.weight - a.weight || a.t.length - b.t.length);
    return out[0]?.t || '';
  }

  function ensureMarker() {
    let marker = document.getElementById(ID);
    if (marker) return marker;
    marker = document.createElement('span');
    marker.id = ID;
    marker.setAttribute('aria-current', 'page');
    marker.style.cssText = 'position:fixed!important;left:0!important;top:0!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;overflow:hidden!important;z-index:-2147483648!important;font-size:1px!important;line-height:1px!important;';
    // Put our marker before page navigation nodes so content.js sees this current-title marker first.
    document.documentElement.insertBefore(marker, document.documentElement.firstChild);
    return marker;
  }

  async function publish(title) {
    if (!title || title === lastTitle) return;
    const marker = ensureMarker();
    lastTitle = title;
    marker.textContent = title;

    // Toggle an observed attribute so the main content script immediately recalculates its page signature.
    marker.setAttribute('aria-current', 'false');
    marker.setAttribute('aria-current', 'page');
    marker.setAttribute('data-avd-title-version', String(Date.now()));

    // Atomically identify the new context and clear the old context once. This avoids
    // erasing early requests from the new player during a JS-only lesson transition.
    try { await chrome.runtime.sendMessage({ type: 'PAGE_MEDIA_CONTEXT', title, url: location.href }); } catch (_) {}
    document.dispatchEvent(new CustomEvent('avd:lesson-context-changed', { detail: { title, url: location.href } }));
  }

  function update() {
    timer = 0;
    const urlChanged = location.href !== lastUrl;
    if (urlChanged) lastUrl = location.href;
    const title = currentTitle();
    if (title) publish(title);
  }

  function schedule(delay = 180) {
    clearTimeout(timer);
    timer = setTimeout(update, delay);
  }

  const observer = new MutationObserver(records => {
    if (records.some(r => r.type === 'childList' || r.type === 'characterData' || r.type === 'attributes')) schedule(220);
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'aria-current', 'aria-selected', 'aria-checked', 'data-active', 'data-selected', 'data-state', 'src']
  });

  document.addEventListener('click', e => {
    if (e.target.closest('a,button,[role="button"],[role="option"],[role="radio"],[role="listitem"],li')) {
      schedule(80);
      setTimeout(update, 350);
      setTimeout(update, 900);
    }
  }, true);
  addEventListener('popstate', () => schedule(50), true);
  addEventListener('hashchange', () => schedule(50), true);

  document.addEventListener('avd:history-navigation', () => schedule(0));

  ensureMarker();
  update();
})();

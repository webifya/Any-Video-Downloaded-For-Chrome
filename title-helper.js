(() => {
  if (window.top !== window.self) return;
  const ID = 'avd-current-media-title';
  let timer = 0;
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const visible = el => {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const bad = s => !s || /^(home|courses?|categories?|lessons?|dashboard|instructor|growth accelerator|leads on demand)$/i.test(s);

  function candidates() {
    const out = [];
    const add = (el, weight) => {
      if (!visible(el)) return;
      const t = clean(el.textContent || el.getAttribute?.('aria-label') || '');
      if (!bad(t) && t.length <= 180) out.push({ t, weight });
    };

    // Explicit current/selected lesson states used by most LMS/SPAs.
    document.querySelectorAll('[aria-current="page"],[aria-current="true"],[aria-selected="true"],[data-active="true"],[data-selected="true"],.active,.selected,[class*="active"],[class*="selected"]').forEach(el => {
      if (el.id === ID) return;
      const text = clean(el.textContent);
      if (/lesson|module|video|overview|welcome|step|bonus|introduction|principle|flow|customer|growth/i.test(text)) add(el, 100);
    });

    // Breadcrumbs are particularly reliable on GHL/ClientClub course pages.
    document.querySelectorAll('nav a,nav span,[class*="breadcrumb"] a,[class*="breadcrumb"] span,[aria-label*="breadcrumb" i] a,[aria-label*="breadcrumb" i] span').forEach(el => add(el, 85));

    // Prefer the heading spatially closest to the visible video/player.
    const video = [...document.querySelectorAll('video,iframe')].filter(visible).sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width)[0];
    if (video) {
      const vr = video.getBoundingClientRect();
      document.querySelectorAll('h1,h2,h3').forEach(el => {
        if (!visible(el)) return;
        const r = el.getBoundingClientRect();
        const dist = Math.abs(r.bottom - vr.top);
        if (dist < 500) add(el, 95 - Math.min(40, dist / 15));
      });
    }

    // Course pages often have the lesson heading directly above the player even if no <video> exists yet.
    document.querySelectorAll('main h1,[role="main"] h1,main h2,[role="main"] h2').forEach(el => add(el, 70));
    return out.sort((a,b)=>b.weight-a.weight);
  }

  function update() {
    timer = 0;
    const best = candidates()[0]?.t;
    if (!best) return;
    let marker = document.getElementById(ID);
    if (!marker) {
      marker = document.createElement('span');
      marker.id = ID;
      marker.setAttribute('aria-current', 'page');
      marker.style.cssText = 'position:fixed!important;left:-2px!important;top:-2px!important;width:1px!important;height:1px!important;opacity:.001!important;pointer-events:none!important;overflow:hidden!important;z-index:-1!important;';
      document.documentElement.appendChild(marker);
    }
    if (marker.textContent !== best) marker.textContent = best;
  }

  function schedule() { clearTimeout(timer); timer = setTimeout(update, 350); }
  new MutationObserver(schedule).observe(document.documentElement, { subtree:true, childList:true, attributes:true, attributeFilter:['class','aria-current','aria-selected','data-active','data-selected'] });
  addEventListener('popstate', schedule, true);
  addEventListener('hashchange', schedule, true);
  document.addEventListener('click', e => {
    if (e.target.closest('a,button,[role="button"],[role="option"],[role="listitem"]')) setTimeout(update, 250);
  }, true);
  update();
})();

(() => {
  if (window.top !== window.self) return;

  let busy = false;
  const clean = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 170) || 'Video';

  function visible(el) {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 80 && r.height > 50 && s.display !== 'none' && s.visibility !== 'hidden';
  }

  function player() {
    return [...document.querySelectorAll('video')]
      .filter(visible)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      })[0] || null;
  }

  function title() {
    const marker = document.getElementById('avd-current-media-title');
    const marked = clean(marker?.textContent || '');
    if (marked && marked !== 'Video') return marked;
    const h = [...document.querySelectorAll('h1,h2,h3')].find(el => visible(el));
    return clean(h?.textContent || document.title || 'Video');
  }

  function status(text, pct) {
    const wrap = document.getElementById('page-video-downloader-progress-wrap');
    const bar = document.getElementById('page-video-downloader-progress');
    const s = document.getElementById('page-video-downloader-status');
    if (wrap) wrap.style.display = 'block';
    if (bar && Number.isFinite(pct)) bar.value = Math.max(0, Math.min(100, pct));
    if (s) s.textContent = text;
  }

  function recorderType() {
    const types = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    return types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; } }) || '';
  }

  function waitEvent(el, name, timeout = 12000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`Timed out waiting for ${name}.`)), timeout);
      const ok = () => done();
      const bad = () => done(new Error('The page video player reported an error.'));
      const done = err => {
        clearTimeout(timer);
        el.removeEventListener(name, ok);
        el.removeEventListener('error', bad);
        err ? reject(err) : resolve();
      };
      el.addEventListener(name, ok, { once: true });
      el.addEventListener('error', bad, { once: true });
    });
  }

  async function seek(video, time) {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    if (Math.abs((video.currentTime || 0) - time) < 0.15) return;
    const p = waitEvent(video, 'seeked', 15000);
    video.currentTime = Math.max(0, Math.min(time, Math.max(0, video.duration - 0.05)));
    await p;
  }

  function save(blob, name) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 180000);
  }

  async function captureHls() {
    if (busy) throw new Error('A page capture is already running.');
    const video = player();
    if (!video) throw new Error('No active page video element was found.');
    const capture = video.captureStream?.bind(video) || video.webkitCaptureStream?.bind(video);
    if (!capture) throw new Error('This Chrome build cannot capture the decoded page video.');
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration === Infinity) throw new Error('Video duration is not ready. Play the lesson briefly, then try again.');

    const original = {
      time: video.currentTime || 0,
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      rate: video.playbackRate,
      loop: video.loop
    };

    busy = true;
    let recorder, progressTimer;
    try {
      status('Preparing decoded HLS video…', 1);
      video.loop = false;
      video.playbackRate = 1;
      await seek(video, 0);

      // Start playback first so captureStream exposes the tracks on lazy-loaded players.
      const oldMuted = video.muted;
      video.muted = true;
      await video.play();
      await new Promise(r => setTimeout(r, 200));
      const stream = capture();
      const vTracks = stream.getVideoTracks();
      const aTracks = stream.getAudioTracks();
      if (!vTracks.length) throw new Error('The HLS player did not expose a capturable video track.');
      // Muting the element should not remove captureStream audio; restore the source mute state after capture begins.
      video.muted = oldMuted;

      const type = recorderType();
      const options = {};
      if (type) options.mimeType = type;
      options.videoBitsPerSecond = 8000000;
      if (aTracks.length) options.audioBitsPerSecond = 192000;
      recorder = new MediaRecorder(new MediaStream([...vTracks, ...aTracks]), options);
      const chunks = [];
      const stopped = new Promise((resolve, reject) => {
        recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
        recorder.onerror = e => reject(e.error || new Error('Chrome page-video recorder failed.'));
        recorder.onstop = resolve;
      });

      // Re-seek after stream creation so the recording begins at lesson time zero.
      video.pause();
      await seek(video, 0);
      recorder.start(1000);
      await video.play();
      const duration = video.duration;
      status(`Recording ${title()} from the decoded player… 0%`, 0);

      progressTimer = setInterval(() => {
        const pct = Math.max(0, Math.min(99, Math.round(((video.currentTime || 0) / duration) * 100)));
        status(`Recording decoded video… ${pct}%`, pct);
      }, 700);

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Decoded HLS capture exceeded the expected duration.')), Math.max(30000, (duration + 45) * 1000));
        const ended = () => { clearTimeout(timeout); resolve(); };
        const failed = () => { clearTimeout(timeout); reject(new Error('The page video failed during HLS capture.')); };
        video.addEventListener('ended', ended, { once: true });
        video.addEventListener('error', failed, { once: true });
      });

      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      const outType = recorder.mimeType || type || 'video/webm';
      const blob = new Blob(chunks, { type: outType });
      if (blob.size < 32768) throw new Error('Decoded HLS capture produced an unexpectedly small file.');
      const ext = /mp4/i.test(outType) ? '.mp4' : '.webm';
      const filename = `${title()}${ext}`;
      save(blob, filename);
      status(`Downloaded ${filename}`, 100);
      return filename;
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      try {
        if (recorder?.state && recorder.state !== 'inactive') recorder.stop();
        video.pause();
        video.muted = original.muted;
        video.volume = original.volume;
        video.playbackRate = original.rate;
        video.loop = original.loop;
        if (Number.isFinite(original.time)) await seek(video, original.time).catch(() => {});
        if (!original.paused) await video.play().catch(() => {});
      } catch (_) {}
      busy = false;
    }
  }

  function isHlsRowButton(button) {
    const row = button.closest('.pvd-item');
    return !!row?.querySelector('.pvd-meta')?.textContent?.includes('HLS Video');
  }

  function isHlsDownloadAll(button) {
    if (button.id !== 'page-video-downloader-all') return false;
    const panel = button.closest('#page-video-downloader-panel');
    const hlsRows = [...(panel?.querySelectorAll('.pvd-item') || [])].filter(row => row.querySelector('.pvd-meta')?.textContent?.includes('HLS Video'));
    return hlsRows.length === 1;
  }

  // Replace HLS button wording so users know this path creates a normal playable file.
  const decorate = () => {
    for (const row of document.querySelectorAll('#page-video-downloader-panel .pvd-item')) {
      if (!row.querySelector('.pvd-meta')?.textContent?.includes('HLS Video')) continue;
      const b = row.querySelector('button');
      if (b && !busy) b.textContent = 'Download MP4';
    }
  };
  new MutationObserver(decorate).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  document.addEventListener('click', e => {
    const button = e.target.closest('#page-video-downloader-panel button');
    if (!button || busy) return;
    if (!isHlsRowButton(button) && !isHlsDownloadAll(button)) return;

    // Intercept the old raw-.ts HLS path. We capture the already-decoded page player instead.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    captureHls().catch(err => status(`HLS MP4 capture failed: ${err.message || err}`, 0));
  }, true);

  document.addEventListener('avd:lesson-context-changed', () => setTimeout(decorate, 300));
})();

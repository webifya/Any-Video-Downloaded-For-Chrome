(() => {
  let busy = false;
  const clean = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 170) || 'Video';
  const isYouTube = /(^|\.)youtube\.com$/i.test(location.hostname);

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
    if (isYouTube) {
      const yt = [...document.querySelectorAll('ytd-watch-metadata h1 yt-formatted-string, #title h1 yt-formatted-string, h1.ytd-watch-metadata')]
        .find(visible);
      const ytTitle = clean(yt?.textContent || document.querySelector('meta[property="og:title"]')?.content || document.title.replace(/\s*-\s*YouTube\s*$/i, ''));
      if (ytTitle && ytTitle !== 'Video') return ytTitle;
    }
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
    if(window.top!==window.self)chrome.runtime.sendMessage({type:'FRAME_CAPTURE_PROGRESS',text,percent:Number.isFinite(pct)?pct:0}).catch(()=>{});
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

  async function captureDecodedPageVideo(label = 'video', filenameBase = '') {
    if (busy) throw new Error('A page capture is already running.');
    const video = player();
    if (!video) throw new Error('No active page video element was found.');
    const capture = video.captureStream?.bind(video) || video.webkitCaptureStream?.bind(video);
    if (!capture) throw new Error('This Chrome build cannot capture the decoded page video.');
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration === Infinity) throw new Error('Video duration is not ready. Play the video briefly, then try again.');

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
      status(`Preparing decoded ${label}…`, 1);
      video.loop = false;
      video.playbackRate = 1;
      await seek(video, 0);

      // Start playback first so captureStream exposes tracks on lazy/adaptive players.
      const oldMuted = video.muted;
      video.muted = true;
      await video.play();
      await new Promise(r => setTimeout(r, 250));
      const stream = capture();
      const vTracks = stream.getVideoTracks();
      const aTracks = stream.getAudioTracks();
      if (!vTracks.length) throw new Error('The page player did not expose a capturable video track.');
      video.muted = oldMuted;

      const type = recorderType();
      const options = {};
      if (type) options.mimeType = type;
      options.videoBitsPerSecond = 10000000;
      if (aTracks.length) options.audioBitsPerSecond = 192000;
      recorder = new MediaRecorder(new MediaStream([...vTracks, ...aTracks]), options);
      const chunks = [];
      const stopped = new Promise((resolve, reject) => {
        recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
        recorder.onerror = e => reject(e.error || new Error('Chrome page-video recorder failed.'));
        recorder.onstop = resolve;
      });

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
        const timeout = setTimeout(() => reject(new Error('Decoded page capture exceeded the expected duration.')), Math.max(30000, (duration + 45) * 1000));
        const ended = () => { clearTimeout(timeout); resolve(); };
        const failed = () => { clearTimeout(timeout); reject(new Error('The page video failed during capture.')); };
        video.addEventListener('ended', ended, { once: true });
        video.addEventListener('error', failed, { once: true });
      });

      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      const outType = recorder.mimeType || type || 'video/webm';
      const blob = new Blob(chunks, { type: outType });
      if (blob.size < 32768) throw new Error('Decoded page capture produced an unexpectedly small file.');
      const ext = /mp4/i.test(outType) ? '.mp4' : '.webm';
      const filename = `${clean(filenameBase||title())}${ext}`;
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

  document.addEventListener('avd:capture-request', e => {
    if (busy) return;
    captureDecodedPageVideo(e.detail?.label || 'video',e.detail?.filenameBase||'').catch(err => status(`Video capture failed: ${err.message || err}`, 0));
  });

  chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
    if(msg?.type==='START_FRAME_VIDEO_WARMUP'){
      (async()=>{const video=player();if(!video)throw new Error('No video element was found in the detected player frame.');const wasPaused=video.paused,wasMuted=video.muted,oldVolume=video.volume;try{video.muted=true;video.volume=0;status('Loading the embedded video stream…',1);await video.play();await new Promise(resolve=>setTimeout(resolve,Math.max(2000,Math.min(5000,Number(msg.durationMs)||3500))));return{ok:true};}finally{try{if(wasPaused)video.pause();video.muted=wasMuted;video.volume=oldVolume;}catch(_){}}})().then(sendResponse).catch(error=>sendResponse({ok:false,error:error.message||String(error)}));return true;
    }
    if(msg?.type!=='START_FRAME_VIDEO_CAPTURE')return;
    const video=player();if(!video){sendResponse({ok:false,error:'No active video element was found in the detected player frame.'});return;}
    const capture=video.captureStream?.bind(video)||video.webkitCaptureStream?.bind(video);if(!capture){sendResponse({ok:false,error:'The embedded player does not expose captureStream.'});return;}
    if(!Number.isFinite(video.duration)||video.duration<=0||video.duration===Infinity){sendResponse({ok:false,error:'Embedded video metadata is not ready.'});return;}
    captureDecodedPageVideo(msg.label||'HLS video',msg.filenameBase||'').catch(err=>status(`Video capture failed: ${err.message||err}`,0));sendResponse({ok:true,started:true});
  });

})();

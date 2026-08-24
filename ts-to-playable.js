// v2.5.1 compatibility layer: when the HLS engine assembles MPEG-TS, convert it
// locally through Chrome's native decoder/MediaRecorder instead of merely renaming TS bytes.
(() => {
  const nativeClick = HTMLAnchorElement.prototype.click;
  let bypass = false;

  function bestRecorderType() {
    const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];
    return types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; } }) || '';
  }

  async function waitReady(v) {
    if (v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0) return;
    await new Promise((resolve, reject) => {
      const done = (err) => { clearTimeout(to); v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', bad); err ? reject(err) : resolve(); };
      const ok = () => done();
      const bad = () => done(new Error('Chrome could not decode the assembled HLS transport stream.'));
      const to = setTimeout(() => done(new Error('Timed out preparing HLS conversion.')), 20000);
      v.addEventListener('loadedmetadata', ok, { once:true });
      v.addEventListener('error', bad, { once:true });
    });
  }

  async function convert(anchor) {
    const sourceName = anchor.download || 'Video.ts';
    const sourceUrl = anchor.href;
    const response = await fetch(sourceUrl);
    const input = await response.blob();
    const v = document.createElement('video');
    v.preload = 'auto'; v.muted = false; v.playsInline = true; v.style.display = 'none';
    const local = URL.createObjectURL(input);
    v.src = local;
    document.body.appendChild(v);
    try {
      await waitReady(v);
      const capture = v.captureStream?.bind(v) || v.webkitCaptureStream?.bind(v);
      if (!capture) throw new Error('Media capture is unavailable.');
      const stream = capture();
      if (!stream.getVideoTracks().length) throw new Error('No video track found in assembled HLS stream.');
      const type = bestRecorderType();
      const recorder = new MediaRecorder(stream, type ? { mimeType:type } : undefined);
      const parts = [];
      const stopped = new Promise((resolve, reject) => {
        recorder.ondataavailable = e => { if (e.data?.size) parts.push(e.data); };
        recorder.onerror = e => reject(e.error || new Error('HLS conversion failed.'));
        recorder.onstop = resolve;
      });
      recorder.start(1000);
      await v.play();
      await new Promise((resolve, reject) => {
        const limit = setTimeout(() => reject(new Error('HLS conversion exceeded expected duration.')), Math.max(30000, ((v.duration || 0) + 30) * 1000));
        v.addEventListener('ended', () => { clearTimeout(limit); resolve(); }, { once:true });
        v.addEventListener('error', () => { clearTimeout(limit); reject(new Error('HLS decode failed during conversion.')); }, { once:true });
      });
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      const outputType = recorder.mimeType || type || 'video/webm';
      const output = new Blob(parts, { type: outputType });
      if (output.size < 32768) throw new Error('Converted HLS file was unexpectedly small.');
      const ext = /mp4/i.test(outputType) ? '.mp4' : '.webm';
      const outName = sourceName.replace(/\.ts$/i, ext);
      const outUrl = URL.createObjectURL(output);
      const a = document.createElement('a');
      a.href = outUrl; a.download = outName; document.body.appendChild(a);
      bypass = true; nativeClick.call(a); bypass = false;
      a.remove(); setTimeout(() => URL.revokeObjectURL(outUrl), 180000);
    } finally {
      try { v.pause(); v.remove(); } catch (_) {}
      URL.revokeObjectURL(local);
    }
  }

  HTMLAnchorElement.prototype.click = function() {
    if (bypass || !/\.ts$/i.test(this.download || '') || !String(this.href || '').startsWith('blob:')) return nativeClick.call(this);
    convert(this).catch(err => {
      console.warn('Any Video Downloader: TS conversion unavailable, preserving original TS', err);
      bypass = true; nativeClick.call(this); bypass = false;
    });
  };
})();

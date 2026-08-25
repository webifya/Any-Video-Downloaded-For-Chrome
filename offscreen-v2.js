const AVD = (() => {
  const RANGE_CHUNK = 8 * 1024 * 1024;
  const MIN_MEDIA_BYTES = 16 * 1024;

  function report(tabId, percent, phase, current, total, text) {
    chrome.runtime.sendMessage({ type: 'MEDIA_PROGRESS', tabId, percent, phase, current, total, text }).catch(() => {});
  }

  function abs(base, rel) {
    const out = new URL(rel, base);
    const parent = new URL(base);
    for (const [k, v] of parent.searchParams) if (!out.searchParams.has(k)) out.searchParams.append(k, v);
    return out.href;
  }

  function cleanRangeParams(url = '') {
    try {
      const u = new URL(url);
      for (const key of ['range', 'rn', 'rbuf', 'bytestart', 'byteend', 'start', 'end']) u.searchParams.delete(key);
      return u.href;
    } catch (_) { return url; }
  }

  function parseContentRange(value = '') {
    const m = String(value).match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
    if (!m) return null;
    return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? 0 : Number(m[3]) };
  }

  async function fetchResponse(url, label, options = {}, retries = 2) {
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow', ...options });
        if (r.ok) return r;
        last = new Error(`HTTP ${r.status} while loading ${label}`);
        if (![401, 403, 404, 408, 416, 429, 500, 502, 503, 504].includes(r.status)) throw last;
      } catch (e) { last = e; }
      if (attempt < retries) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
    throw last || new Error(`Failed while loading ${label}`);
  }

  async function responseBlobWithProgress(r, tabId, label, startPct, endPct) {
    const expected = Number(r.headers.get('content-length') || 0) || 0;
    const reader = r.body?.getReader?.();
    if (!reader) return r.blob();
    const parts = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) { parts.push(value); received += value.byteLength; }
      if (expected > 0) {
        const pct = Math.max(startPct, Math.min(endPct, Math.round(startPct + (received / expected) * (endPct - startPct))));
        report(tabId, pct, 'fetch', received, expected, `${label}… ${pct}%`);
      }
    }
    return new Blob(parts, { type: r.headers.get('content-type') || 'application/octet-stream' });
  }

  async function fetchByRanges(url, total, mime, tabId, label, startPct, endPct) {
    const parts = [];
    let offset = 0;
    let index = 0;
    while (offset < total) {
      const end = Math.min(total - 1, offset + RANGE_CHUNK - 1);
      const r = await fetchResponse(url, label, { headers: { Range: `bytes=${offset}-${end}` } }, 1);
      if (r.status === 200) {
        const blob = await responseBlobWithProgress(r, tabId, label, startPct, endPct);
        if (blob.size >= total || offset === 0) return blob;
        throw new Error(`${label} server ignored range recovery unexpectedly.`);
      }
      const cr = parseContentRange(r.headers.get('content-range'));
      if (!cr || cr.start !== offset) throw new Error(`${label} returned an unexpected byte range.`);
      parts.push(await r.blob());
      offset = cr.end + 1;
      index++;
      const pct = Math.max(startPct, Math.min(endPct, Math.round(startPct + (offset / total) * (endPct - startPct))));
      report(tabId, pct, 'range-fetch', offset, total, `${label}… ${pct}% (${index} chunks)`);
      if (index > 20000) throw new Error(`${label} required too many byte-range requests.`);
    }
    return new Blob(parts, { type: mime || 'application/octet-stream' });
  }

  async function fetchCompleteMedia(media, tabId, label, startPct, endPct) {
    const candidates = [...new Set([cleanRangeParams(media.url || ''), cleanRangeParams(media.originalUrl || ''), media.url || '', media.originalUrl || ''].filter(Boolean))];
    let last;
    for (const candidate of candidates) {
      try {
        const r = await fetchResponse(candidate, label, {}, 1);
        const responseType = (r.headers.get('content-type') || media.mime || '').toLowerCase();
        if (/text\/|application\/(?:json|xml|html)/.test(responseType)) throw new Error(`${label} returned ${responseType} instead of media.`);
        const cr = parseContentRange(r.headers.get('content-range'));
        if (r.status === 206 && cr?.total && (cr.start > 0 || cr.end + 1 < cr.total)) {
          const rangedUrl = cleanRangeParams(candidate);
          const blob = await fetchByRanges(rangedUrl, cr.total, responseType, tabId, label, startPct, endPct);
          if (blob.size < Math.min(cr.total, MIN_MEDIA_BYTES)) throw new Error(`${label} range recovery was incomplete.`);
          return { blob, mime: responseType || media.mime || 'application/octet-stream' };
        }
        const blob = await responseBlobWithProgress(r, tabId, label, startPct, endPct);
        if (blob.size < MIN_MEDIA_BYTES) throw new Error(`${label} returned only a tiny/expired response.`);
        if (cr?.total && blob.size < cr.total * 0.95) {
          const recovered = await fetchByRanges(cleanRangeParams(candidate), cr.total, responseType, tabId, label, startPct, endPct);
          return { blob: recovered, mime: responseType || media.mime || recovered.type };
        }
        return { blob, mime: responseType || media.mime || blob.type };
      } catch (e) { last = e; }
    }
    throw last || new Error(`${label} could not be downloaded.`);
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 180000);
  }

  function extensionFor(mime = '', kind = 'video', sourceUrl = '') {
    try {
      const p = new URL(sourceUrl).pathname.toLowerCase();
      for (const ext of ['.mp4', '.webm', '.mov', '.m4v', '.m4a', '.aac', '.mp3', '.opus', '.ogg']) if (p.endsWith(ext)) return ext;
    } catch (_) {}
    const m = String(mime).toLowerCase();
    if (kind === 'audio') {
      if (/webm|opus|ogg/.test(m)) return '.webm';
      if (/mpeg|mp3/.test(m)) return '.mp3';
      return '.m4a';
    }
    if (/webm/.test(m)) return '.webm';
    if (/quicktime/.test(m)) return '.mov';
    return '.mp4';
  }

  function waitMetadata(el, timeout = 20000) {
    return new Promise((resolve, reject) => {
      if (el.readyState >= 1 && Number.isFinite(el.duration)) return resolve();
      const timer = setTimeout(() => done(new Error('Timed out while preparing local media.')), timeout);
      const ok = () => done();
      const bad = () => done(new Error('Chrome could not decode one of the selected media tracks.'));
      const done = err => {
        clearTimeout(timer);
        el.removeEventListener('loadedmetadata', ok);
        el.removeEventListener('error', bad);
        err ? reject(err) : resolve();
      };
      el.addEventListener('loadedmetadata', ok, { once: true });
      el.addEventListener('error', bad, { once: true });
    });
  }

  function recorderMime() {
    const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; } }) || '';
  }

  async function recordCombined(videoBlob, audioBlob, filenameBase, tabId, bitrate = 0) {
    if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is not available in this Chrome build.');
    const videoUrl = URL.createObjectURL(videoBlob);
    const audioUrl = URL.createObjectURL(audioBlob);
    const video = document.createElement('video');
    const audio = document.createElement('audio');
    video.preload = 'auto'; audio.preload = 'auto'; video.playsInline = true; video.muted = true;
    video.src = videoUrl; audio.src = audioUrl;
    video.style.display = audio.style.display = 'none';
    document.body.append(video, audio);
    let audioCtx, syncTimer, progressTimer;
    try {
      await Promise.all([waitMetadata(video), waitMetadata(audio)]);
      const duration = Math.min(video.duration || Infinity, audio.duration || Infinity);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not determine media duration for local merge.');
      const capture = video.captureStream?.bind(video) || video.webkitCaptureStream?.bind(video);
      if (!capture) throw new Error('Media-element capture is unavailable in this Chrome build.');
      const vTracks = capture().getVideoTracks();
      if (!vTracks.length) throw new Error('No decodable video track was available for local merge.');
      audioCtx = new AudioContext();
      await audioCtx.resume();
      const source = audioCtx.createMediaElementSource(audio);
      const destination = audioCtx.createMediaStreamDestination();
      source.connect(destination);
      const aTracks = destination.stream.getAudioTracks();
      if (!aTracks.length) throw new Error('No decodable audio track was available for local merge.');
      const type = recorderMime();
      const options = {};
      if (type) options.mimeType = type;
      if (bitrate > 0) options.videoBitsPerSecond = Math.max(1000000, Math.min(16000000, bitrate));
      options.audioBitsPerSecond = 192000;
      const recorder = new MediaRecorder(new MediaStream([...vTracks, ...aTracks]), options);
      const chunks = [];
      const stopped = new Promise((resolve, reject) => {
        recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
        recorder.onerror = e => reject(e.error || new Error('Local merge recorder failed.'));
        recorder.onstop = resolve;
      });
      video.currentTime = 0; audio.currentTime = 0;
      recorder.start(1000);
      report(tabId, 32, 'merge', 0, duration, 'Merging video + audio locally…');
      await Promise.all([video.play(), audio.play()]);
      syncTimer = setInterval(() => { if (Math.abs((video.currentTime || 0) - (audio.currentTime || 0)) > 0.18) { try { audio.currentTime = video.currentTime; } catch (_) {} } }, 800);
      progressTimer = setInterval(() => {
        const t = Math.min(duration, Math.max(0, video.currentTime || 0));
        const pct = Math.max(32, Math.min(97, Math.round(32 + (t / duration) * 65)));
        report(tabId, pct, 'merge', t, duration, `Merging locally… ${pct}%`);
      }, 1000);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Local merge exceeded expected duration.')), Math.max(30000, (duration + 30) * 1000));
        video.addEventListener('ended', () => { clearTimeout(timer); resolve(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Video decode failed during local merge.')); }, { once: true });
      });
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      const outType = recorder.mimeType || type || 'video/webm';
      const output = new Blob(chunks, { type: outType });
      if (output.size < 32768) throw new Error('Local merge produced an unexpectedly small output.');
      const ext = /mp4/i.test(outType) ? '.mp4' : '.webm';
      saveBlob(output, `${filenameBase}${ext}`);
      report(tabId, 100, 'done', output.size, output.size, `Complete — ${filenameBase}${ext}`);
      return { ok: true, merged: true, message: `Downloaded merged video with audio: ${filenameBase}${ext}` };
    } finally {
      if (syncTimer) clearInterval(syncTimer);
      if (progressTimer) clearInterval(progressTimer);
      try { video.pause(); audio.pause(); video.remove(); audio.remove(); } catch (_) {}
      try { if (audioCtx) await audioCtx.close(); } catch (_) {}
      URL.revokeObjectURL(videoUrl); URL.revokeObjectURL(audioUrl);
    }
  }

  async function transcodeTransportStream(input, filenameBase, tabId) {
    if (typeof MediaRecorder === 'undefined') throw new Error('Chrome cannot convert this HLS transport stream in this build.');
    const localUrl = URL.createObjectURL(input);
    const video = document.createElement('video');
    video.preload = 'auto'; video.playsInline = true; video.src = localUrl; video.style.display = 'none';
    document.body.appendChild(video);
    let recorder, progressTimer;
    try {
      await waitMetadata(video);
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('Chrome could not determine the HLS video duration.');
      const capture = video.captureStream?.bind(video) || video.webkitCaptureStream?.bind(video);
      if (!capture) throw new Error('Chrome cannot capture the decoded HLS stream in this build.');
      await video.play();
      await new Promise(resolve => setTimeout(resolve, 150));
      const stream = capture();
      if (!stream.getVideoTracks().length) throw new Error('The assembled HLS stream has no decodable video track.');
      video.pause(); video.currentTime = 0;
      const type = recorderMime();
      if (!type) throw new Error('Chrome exposes no MP4 or WebM recorder for HLS conversion.');
      recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 10000000, audioBitsPerSecond: 192000 });
      const chunks = [];
      const stopped = new Promise((resolve, reject) => {
        recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
        recorder.onerror = e => reject(e.error || new Error('HLS conversion recorder failed.'));
        recorder.onstop = resolve;
      });
      recorder.start(1000);
      await video.play();
      progressTimer = setInterval(() => {
        const pct = Math.max(32, Math.min(97, Math.round(32 + ((video.currentTime || 0) / video.duration) * 65)));
        report(tabId, pct, 'hls-convert', video.currentTime || 0, video.duration, `Converting HLS to a playable container… ${pct}%`);
      }, 1000);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('HLS conversion exceeded expected duration.')), Math.max(30000, (video.duration + 30) * 1000));
        video.addEventListener('ended', () => { clearTimeout(timer); resolve(); }, { once:true });
        video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome could not decode the HLS transport stream.')); }, { once:true });
      });
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      const outType = recorder.mimeType || type;
      const output = new Blob(chunks, { type: outType });
      if (output.size < 32768) throw new Error('HLS conversion produced an unexpectedly small file.');
      const ext = /mp4/i.test(outType) ? '.mp4' : '.webm';
      const filename = `${filenameBase}${ext}`;
      saveBlob(output, filename);
      report(tabId, 100, 'done', output.size, output.size, `Complete — ${filename}`);
      return { ok:true, message:`Downloaded ${filename}` };
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      try { if (recorder?.state && recorder.state !== 'inactive') recorder.stop(); video.pause(); video.remove(); } catch (_) {}
      URL.revokeObjectURL(localUrl);
    }
  }

  async function transmuxTransportStream(input) {
    const Transmuxer=globalThis.muxjs?.mp4?.Transmuxer||globalThis.muxjs?.Transmuxer;
    if(!Transmuxer)throw new Error('The local MPEG-TS transmuxer is unavailable.');
    const source=new Uint8Array(await input.arrayBuffer()),outputs=[];
    const transmuxer=new Transmuxer({remux:true,keepOriginalTimestamps:false});
    transmuxer.on('data',segment=>outputs.push(segment));
    transmuxer.push(source);transmuxer.flush();
    if(!outputs.length)throw new Error('The MPEG-TS stream contained no supported H.264/AAC media.');
    const parts=[];let outputType='video/mp4';
    outputs.forEach((segment,index)=>{if(index===0&&segment.initSegment?.byteLength)parts.push(segment.initSegment);if(segment.data?.byteLength)parts.push(segment.data);if(segment.type==='audio')outputType='audio/mp4';});
    const output=new Blob(parts,{type:outputType});
    if(output.size<32768)throw new Error('MPEG-TS transmuxing produced an unexpectedly small MP4.');
    return output;
  }

  async function downloadDirect(msg) {
    report(msg.tabId, 2, 'direct', 0, 0, `Preparing ${msg.kind === 'audio' ? 'audio' : 'video'} download…`);
    const media = await fetchCompleteMedia({ url: msg.url, originalUrl: msg.originalUrl, mime: msg.mime, kind: msg.kind }, msg.tabId, `Downloading ${msg.kind === 'audio' ? 'audio' : 'video'}`, 3, 97);
    if (/mp2t/i.test(media.mime)) throw new Error('Raw MPEG-TS cannot be saved directly; download the HLS playlist for MP4/WebM conversion.');
    const ext = extensionFor(media.mime, msg.kind, msg.url);
    const filename = `${msg.filenameBase}${msg.kind === 'audio' ? ' - audio' : ''}${ext}`;
    saveBlob(media.blob, filename);
    report(msg.tabId, 100, 'done', media.blob.size, media.blob.size, `Complete — ${filename}`);
    return { ok: true, message: `Downloaded ${filename}` };
  }

  async function downloadMerged(msg) {
    report(msg.tabId, 2, 'pair-fetch', 0, 0, 'Preparing adaptive video + audio…');
    const video = await fetchCompleteMedia(msg.video, msg.tabId, 'Downloading video track', 3, 18);
    const audio = await fetchCompleteMedia(msg.audio, msg.tabId, 'Downloading audio track', 19, 30);
    try {
      return await recordCombined(video.blob, audio.blob, msg.filenameBase, msg.tabId, Number(msg.video?.bitrate || 0));
    } catch (e) {
      const vExt = extensionFor(video.mime, 'video', msg.video?.url || '');
      const aExt = extensionFor(audio.mime, 'audio', msg.audio?.url || '');
      saveBlob(video.blob, `${msg.filenameBase}${vExt}`);
      saveBlob(audio.blob, `${msg.filenameBase} - audio${aExt}`);
      throw new Error(`${e.message} Valid source tracks were saved separately as a fallback.`);
    }
  }

  function parseAttrs(line = '') {
    const out = {};
    const body = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
    let m;
    while ((m = re.exec(body))) out[m[1].toUpperCase()] = String(m[2] || '').replace(/^"|"$/g, '');
    return out;
  }

  async function fetchText(url) { return (await fetchResponse(url, 'manifest')).text(); }

  function parseHlsMaster(text, base) {
    const lines = text.split(/\r?\n/), variants = [], audios = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(line);
        if ((a.TYPE || '').toUpperCase() === 'AUDIO' && a.URI) audios.push({ url: abs(base, a.URI), groupId: a['GROUP-ID'] || '', isDefault: /YES/i.test(a.DEFAULT || '') });
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(line);
        let j = i + 1;
        while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
        if (lines[j]) variants.push({ url: abs(base, lines[j].trim()), bandwidth: Number(a.BANDWIDTH || 0), audioGroup: a.AUDIO || '', codecs: a.CODECS || '' });
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { variants, audios };
  }

  function parseHlsMedia(text, base) {
    const lines = text.split(/\r?\n/), segments = [];
    let map = null, encrypted = false, duration = 0, pendingRange = null, previousRangeEnd = 0, previousRangeUrl = '';
    const byteRange = value => { const m=String(value||'').match(/^(\d+)(?:@(\d+))?$/);return m?{length:Number(m[1]),offset:m[2]===undefined?null:Number(m[2])}:null; };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/i.test(line)) encrypted = true;
      if (line.startsWith('#EXTINF:')) duration += Number((line.match(/^#EXTINF:([0-9.]+)/) || [])[1] || 0);
      if (line.startsWith('#EXT-X-MAP:')) {
        const attrs=parseAttrs(line);if(attrs.URI){const range=byteRange(attrs.BYTERANGE);map={url:abs(base,attrs.URI),range:range?{start:range.offset||0,end:(range.offset||0)+range.length-1}:null};}
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) pendingRange=byteRange(line.slice(line.indexOf(':')+1));
      else if (!line.startsWith('#')) {
        const url=abs(base,line);let range=null;
        if(pendingRange){const start=pendingRange.offset===null&&url===previousRangeUrl?previousRangeEnd+1:(pendingRange.offset||0);range={start,end:start+pendingRange.length-1};previousRangeEnd=range.end;previousRangeUrl=url;pendingRange=null;}
        segments.push({url,range});
      }
    }
    return { segments, map, encrypted, duration };
  }

  async function hlsPartBlob(part, label) {
    const headers=part.range?{Range:`bytes=${part.range.start}-${part.range.end}`}:{ };
    const response=await fetchResponse(part.url,label,{headers});
    const blob=await response.blob();
    if(!part.range||response.status===206)return blob;
    return blob.slice(part.range.start,part.range.end+1);
  }

  async function hlsTrackBlob(info, tabId, label, startPct, endPct) {
    if (info.encrypted) throw new Error('This HLS stream is encrypted/DRM-protected.');
    if (!info.segments.length) throw new Error(`No HLS ${label} segments were found.`);
    const parts = [];
    if (info.map) parts.push(await hlsPartBlob(info.map, `${label} initialization segment`));
    for (let i = 0; i < info.segments.length; i++) {
      parts.push(await hlsPartBlob(info.segments[i], `${label} segment`));
      const pct = Math.round(startPct + ((i + 1) / info.segments.length) * (endPct - startPct));
      report(tabId, pct, 'hls', i + 1, info.segments.length, `Downloading HLS ${label}… ${pct}%`);
    }
    const firstPath = new URL(info.segments[0].url).pathname.toLowerCase();
    const fmp4 = !!info.map || /\.m4s$|\.mp4$/i.test(firstPath);
    return new Blob(parts, { type: label === 'audio' ? (fmp4 ? 'audio/mp4' : 'audio/aac') : (fmp4 ? 'video/mp4' : 'video/mp2t') });
  }

  function hlsVariantSupported(variant) {
    const videoCodec=String(variant.codecs||'').split(',').map(x=>x.trim()).find(x=>/^(?:avc1|avc3|hvc1|hev1|av01|vp0?9)/i.test(x));
    if(!videoCodec||typeof MediaSource==='undefined'||typeof MediaSource.isTypeSupported!=='function')return true;
    const container=/^vp0?9/i.test(videoCodec)?'video/webm':'video/mp4';
    try{return MediaSource.isTypeSupported(`${container}; codecs="${videoCodec}"`);}catch(_){return true;}
  }

  async function downloadHls(msg) {
    report(msg.tabId, 1, 'playlist', 0, 0, 'Reading HLS playlist…');
    const text = await fetchText(msg.url);
    const master = parseHlsMaster(text, msg.url);
    if (!master.variants.length) {
      const info = parseHlsMedia(text, msg.url);
      const blob = await hlsTrackBlob(info, msg.tabId, 'video', 3, 97);
      if (/mp2t/.test(blob.type)) {
        report(msg.tabId, 32, 'hls-transmux', 0, blob.size, 'Transmuxing MPEG-TS to MP4 without re-encoding…');
        const mp4=await transmuxTransportStream(blob);
        report(msg.tabId,55,'hls-finalize',0,mp4.size,'Finalizing MP4 for desktop playback…');
        return transcodeTransportStream(mp4,msg.filenameBase,msg.tabId);
      }
      const ext = '.mp4';
      saveBlob(blob, `${msg.filenameBase}${ext}`);
      report(msg.tabId, 100, 'done', blob.size, blob.size, `Complete — ${msg.filenameBase}${ext}`);
      return { ok: true, message: `Downloaded ${msg.filenameBase}${ext}` };
    }
    const variant = master.variants.find(hlsVariantSupported) || master.variants[0];
    const vInfo = parseHlsMedia(await fetchText(variant.url), variant.url);
    let video = await hlsTrackBlob(vInfo, msg.tabId, 'video', 3, 18);
    const matching = master.audios.filter(a => !variant.audioGroup || a.groupId === variant.audioGroup);
    const audioDef = matching.find(a => a.isDefault) || matching[0];
    if (audioDef) {
      const aInfo = parseHlsMedia(await fetchText(audioDef.url), audioDef.url);
      let audio = await hlsTrackBlob(aInfo, msg.tabId, 'audio', 19, 30);
      if(/mp2t/.test(video.type)){report(msg.tabId,22,'hls-transmux',0,video.size,'Transmuxing HLS video track to fMP4…');video=await transmuxTransportStream(video);}
      if(/aac/.test(audio.type)){report(msg.tabId,27,'hls-transmux',0,audio.size,'Transmuxing HLS audio track to fMP4…');audio=await transmuxTransportStream(audio);}
      try { return await recordCombined(video, audio, msg.filenameBase, msg.tabId, variant.bandwidth); }
      catch (e) {
        if (/mp2t/.test(video.type)) throw new Error(`${e.message} No raw .ts file was saved; use the page-decoded capture fallback.`);
        saveBlob(video, `${msg.filenameBase}.mp4`);
        saveBlob(audio, `${msg.filenameBase} - audio${/aac/.test(audio.type) ? '.aac' : '.m4a'}`);
        throw new Error(`${e.message} Valid non-TS HLS tracks were saved separately as a fallback.`);
      }
    }
    if (/mp2t/.test(video.type)) {
      report(msg.tabId,32,'hls-transmux',0,video.size,'Transmuxing MPEG-TS to MP4 without re-encoding…');
      const mp4=await transmuxTransportStream(video);
      report(msg.tabId,55,'hls-finalize',0,mp4.size,'Finalizing MP4 for desktop playback…');
      return transcodeTransportStream(mp4,msg.filenameBase,msg.tabId);
    }
    const ext = '.mp4';
    saveBlob(video, `${msg.filenameBase}${ext}`);
    report(msg.tabId, 100, 'done', video.size, video.size, `Complete — ${msg.filenameBase}${ext}`);
    return { ok: true, message: `Downloaded ${msg.filenameBase}${ext}` };
  }

  function isoDuration(value = '') {
    const m = value.match(/P(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?/i);
    return m ? Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0) : 0;
  }

  function nodeBase(node, fallback) {
    const chain = [];
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) chain.unshift(n);
    let base = fallback;
    for (const n of chain) {
      const b = [...n.children].find(c => c.tagName?.toLowerCase().endsWith('baseurl'));
      if (b?.textContent?.trim()) base = abs(base, b.textContent.trim());
    }
    return base;
  }

  function replaceTemplate(tpl, rep, number, time) {
    return tpl.replace(/\$RepresentationID\$/g, rep.id || '').replace(/\$Bandwidth\$/g, String(rep.bandwidth || 0)).replace(/\$Number(?:%0\d+d)?\$/g, String(number)).replace(/\$Time\$/g, String(time ?? 0)).replace(/\$\$/g, '$');
  }

  function dashRepresentation(repEl, adap, mpdUrl, duration) {
    const mime = repEl.getAttribute('mimeType') || adap.getAttribute('mimeType') || '';
    const kind = (repEl.getAttribute('contentType') || adap.getAttribute('contentType') || mime.split('/')[0] || '').toLowerCase();
    const bandwidth = Number(repEl.getAttribute('bandwidth') || 0), height = Number(repEl.getAttribute('height') || 0);
    const base = nodeBase(repEl, mpdUrl);
    const segmentBase = repEl.querySelector(':scope > SegmentBase') || adap.querySelector(':scope > SegmentBase');
    if (segmentBase && base !== mpdUrl) return { kind, mime, bandwidth, height, direct: base, segments: [] };
    const list = repEl.querySelector(':scope > SegmentList') || adap.querySelector(':scope > SegmentList');
    if (list) {
      const segments = [];
      const init = list.querySelector(':scope > Initialization')?.getAttribute('sourceURL');
      if (init) segments.push(abs(base, init));
      for (const s of list.querySelectorAll(':scope > SegmentURL')) if (s.getAttribute('media')) segments.push(abs(base, s.getAttribute('media')));
      return { kind, mime, bandwidth, height, direct: '', segments };
    }
    const tpl = repEl.querySelector(':scope > SegmentTemplate') || adap.querySelector(':scope > SegmentTemplate');
    if (!tpl) return { kind, mime, bandwidth, height, direct: base !== mpdUrl ? base : '', segments: [] };
    const media = tpl.getAttribute('media') || '', init = tpl.getAttribute('initialization') || '';
    const timescale = Number(tpl.getAttribute('timescale') || 1), segDuration = Number(tpl.getAttribute('duration') || 0), startNumber = Number(tpl.getAttribute('startNumber') || 1);
    const rep = { id: repEl.getAttribute('id') || '', bandwidth };
    const points = [];
    const timeline = tpl.querySelector(':scope > SegmentTimeline');
    if (timeline) {
      let time = 0, number = startNumber;
      const entries = [...timeline.querySelectorAll(':scope > S')];
      for (let idx = 0; idx < entries.length && points.length < 20000; idx++) {
        const s = entries[idx], d = Number(s.getAttribute('d') || 0);
        if (!d) continue;
        if (s.hasAttribute('t')) time = Number(s.getAttribute('t') || 0);
        let repeat = Number(s.getAttribute('r') || 0);
        if (repeat < 0) {
          const nextT = Number(entries[idx + 1]?.getAttribute('t') || 0);
          repeat = nextT > time ? Math.max(0, Math.floor((nextT - time) / d) - 1) : (duration > 0 ? Math.max(0, Math.ceil(duration * timescale / d) - points.length - 1) : 0);
        }
        for (let r = 0; r <= repeat && points.length < 20000; r++) { points.push({ number: number++, time }); time += d; }
      }
    } else if (segDuration > 0 && duration > 0) {
      const count = Math.min(20000, Math.ceil(duration * timescale / segDuration));
      for (let i = 0; i < count; i++) points.push({ number: startNumber + i, time: i * segDuration });
    }
    const segments = [];
    if (init) segments.push(abs(base, replaceTemplate(init, rep, startNumber, 0)));
    for (const p of points) if (media) segments.push(abs(base, replaceTemplate(media, rep, p.number, p.time)));
    return { kind, mime, bandwidth, height, direct: '', segments };
  }

  async function parseDash(url) {
    const xml = await fetchText(url);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Could not parse DASH MPD.');
    if (doc.querySelector('ContentProtection')) throw new Error('This DASH stream is encrypted/DRM-protected.');
    const duration = isoDuration(doc.documentElement.getAttribute('mediaPresentationDuration') || '');
    const reps = [];
    for (const adap of doc.querySelectorAll('AdaptationSet')) for (const rep of adap.querySelectorAll(':scope > Representation')) reps.push(dashRepresentation(rep, adap, url, duration));
    return reps.filter(r => r.direct || r.segments.length);
  }

  async function dashBlob(rep, tabId, startPct, endPct) {
    if (rep.direct) return (await fetchCompleteMedia({ url: rep.direct, originalUrl: rep.direct, mime: rep.mime, kind: rep.kind }, tabId, `Downloading DASH ${rep.kind}`, startPct, endPct)).blob;
    const parts = [];
    for (let i = 0; i < rep.segments.length; i++) {
      parts.push(await (await fetchResponse(rep.segments[i], 'DASH segment')).blob());
      const pct = Math.round(startPct + ((i + 1) / rep.segments.length) * (endPct - startPct));
      report(tabId, pct, 'dash', i + 1, rep.segments.length, `Downloading DASH ${rep.kind}… ${pct}%`);
    }
    return new Blob(parts, { type: rep.mime || 'application/octet-stream' });
  }

  async function downloadDash(msg) {
    report(msg.tabId, 2, 'dash-manifest', 0, 0, 'Reading DASH manifest…');
    const reps = await parseDash(msg.url);
    const video = reps.filter(r => r.kind === 'video').sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0];
    const audio = reps.filter(r => r.kind === 'audio').sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!video && !audio) throw new Error('No downloadable DASH tracks were found.');
    if (video && audio) {
      const vb = await dashBlob(video, msg.tabId, 5, 18);
      const ab = await dashBlob(audio, msg.tabId, 19, 30);
      try { return await recordCombined(vb, ab, msg.filenameBase, msg.tabId, video.bandwidth); }
      catch (e) {
        saveBlob(vb, `${msg.filenameBase}${/webm/i.test(video.mime) ? '.webm' : '.mp4'}`);
        saveBlob(ab, `${msg.filenameBase} - audio${/webm|opus|ogg/i.test(audio.mime) ? '.webm' : '.m4a'}`);
        throw new Error(`${e.message} Valid DASH tracks were saved separately as a fallback.`);
      }
    }
    const rep = video || audio;
    const blob = await dashBlob(rep, msg.tabId, 5, 97);
    const ext = extensionFor(rep.mime, rep.kind, rep.direct || '');
    const filename = `${msg.filenameBase}${rep.kind === 'audio' ? ' - audio' : ''}${ext}`;
    saveBlob(blob, filename);
    report(msg.tabId, 100, 'done', blob.size, blob.size, `Complete — ${filename}`);
    return { ok: true, message: `Downloaded ${filename}` };
  }

  return { downloadDirect, downloadMerged, downloadHls, downloadDash, report, parseHlsMaster, parseHlsMedia, hlsVariantSupported, transmuxTransportStream };
})();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  let promise;
  if (msg.type === 'DOWNLOAD_DIRECT') promise = AVD.downloadDirect(msg);
  else if (msg.type === 'DOWNLOAD_MERGED_MEDIA') promise = AVD.downloadMerged(msg);
  else if (msg.type === 'DOWNLOAD_HLS') promise = AVD.downloadHls(msg);
  else if (msg.type === 'DOWNLOAD_DASH') promise = AVD.downloadDash(msg);
  if (!promise) return;
  promise.then(sendResponse).catch(err => {
    AVD.report(msg.tabId, 0, 'error', 0, 0, `Download failed: ${err.message || String(err)}`);
    sendResponse({ ok: false, error: err.message || String(err) });
  });
  return true;
});

function abs(base, rel) {
  const out = new URL(rel, base);
  const baseUrl = new URL(base);
  for (const [k, v] of baseUrl.searchParams) if (!out.searchParams.has(k)) out.searchParams.append(k, v);
  return out.href;
}

function report(tabId, percent, phase, current, total, text) {
  chrome.runtime.sendMessage({ type:'MEDIA_PROGRESS', tabId, percent, phase, current, total, text }).catch(() => {});
}

async function fetchWithRetry(url, label, retries = 2) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { credentials:'include', cache:'no-store' });
      if (r.ok) return r;
      last = new Error(`HTTP ${r.status} while loading ${label}`);
      if (![401,403,404,408,429,500,502,503,504].includes(r.status)) throw last;
    } catch (e) { last = e; }
    if (attempt < retries) await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
  }
  throw last || new Error(`Failed while loading ${label}`);
}

async function fetchText(url) { return (await fetchWithRetry(url, 'manifest')).text(); }
async function fetchBuffer(url, label='media segment') { return new Uint8Array(await (await fetchWithRetry(url, label)).arrayBuffer()); }
function concat(parts) {
  const size = parts.reduce((n,p) => n + p.byteLength, 0);
  const out = new Uint8Array(size); let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
  return out;
}

function safeExt(mime='', kind='video', url='') {
  const m=String(mime).toLowerCase();
  try {
    const p=new URL(url).pathname.toLowerCase();
    for (const ext of ['.mp4','.webm','.mov','.m4v','.m4a','.aac','.mp3','.opus','.ogg']) if (p.endsWith(ext)) return ext;
  } catch (_) {}
  if (kind==='audio') {
    if (/webm|opus|ogg/.test(m)) return '.webm';
    if (/mpeg|mp3/.test(m)) return '.mp3';
    return '.m4a';
  }
  if (/webm/.test(m)) return '.webm';
  if (/quicktime/.test(m)) return '.mov';
  return '.mp4';
}

function saveBlob(bytes, type, filename) {
  const blob = new Blob([bytes], { type });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = blobUrl; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
}

async function downloadDirect(url, filenameBase, tabId, mime='', kind='video') {
  report(tabId,2,'direct',0,0,`Preparing ${kind === 'audio' ? 'audio' : 'video'} download…`);
  const r=await fetchWithRetry(url, kind === 'audio' ? 'audio stream' : 'video stream', 1);
  const responseType=(r.headers.get('content-type')||mime||'').toLowerCase();
  if (/text\/|application\/(?:json|xml)/.test(responseType)) throw new Error(`Media server returned ${responseType || 'a non-media response'} instead of the video file.`);
  const expected=Number(r.headers.get('content-length')||0)||0;
  const reader=r.body?.getReader?.();
  const chunks=[]; let received=0;
  if (reader) {
    while (true) {
      const {done,value}=await reader.read();
      if (done) break;
      if (value?.byteLength) { chunks.push(value); received += value.byteLength; }
      if (expected > 0) {
        const pct=Math.max(3,Math.min(96,Math.round(received/expected*94)+2));
        report(tabId,pct,'direct',received,expected,`Downloading ${kind === 'audio' ? 'audio' : 'video'}… ${pct}%`);
      }
    }
  } else {
    const bytes=new Uint8Array(await r.arrayBuffer()); chunks.push(bytes); received=bytes.byteLength;
  }
  if (received < 16384) throw new Error('The media URL returned only a tiny/expired response. Play the video again and click Scan to refresh the stream URL.');
  const finalMime=responseType && !/octet-stream/.test(responseType) ? responseType : (mime || (kind==='audio'?'audio/mp4':'video/mp4'));
  const ext=safeExt(finalMime,kind,url);
  const filename=`${filenameBase}${kind==='audio'?' - audio':''}${ext}`;
  report(tabId,98,'save',received,expected||received,'Saving file… 98%');
  saveBlob(concat(chunks),finalMime,filename);
  report(tabId,100,'done',received,expected||received,`Complete — ${filename}`);
  return {ok:true,message:`Downloaded ${filename}`};
}

// ---------- HLS ----------
function parseMaster(text, base) {
  const lines = text.split(/\r?\n/), variants = [];
  for (let i=0;i<lines.length;i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const bw = Number((lines[i].match(/BANDWIDTH=(\d+)/)||[])[1]||0);
    let j=i+1; while (j<lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
    if (lines[j]) variants.push({ url:abs(base,lines[j].trim()), bw });
  }
  return variants.sort((a,b)=>b.bw-a.bw);
}
function parseMedia(text, base) {
  const lines=text.split(/\r?\n/), urls=[]; let mapUrl=null, encrypted=false, endList=false, duration=0;
  for (const raw of lines) {
    const line=raw.trim(); if (!line) continue;
    if (line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/i.test(line)) encrypted=true;
    if (line==='#EXT-X-ENDLIST') endList=true;
    if (line.startsWith('#EXTINF:')) duration += Number((line.match(/^#EXTINF:([0-9.]+)/)||[])[1]||0);
    if (line.startsWith('#EXT-X-MAP:')) { const m=line.match(/URI="([^"]+)"/i); if (m) mapUrl=abs(base,m[1]); }
    else if (!line.startsWith('#')) urls.push(abs(base,line));
  }
  return { mapUrl, urls, encrypted, endList, duration };
}
async function loadHls(url) {
  const text=await fetchText(url); const variants=parseMaster(text,url);
  if (variants.length) {
    let lastError;
    for (const variant of variants) {
      try { const parsed=parseMedia(await fetchText(variant.url),variant.url); if (parsed.urls.length) return { playlistUrl:variant.url, ...parsed }; }
      catch(e){ lastError=e; }
    }
    if (lastError) throw lastError;
  }
  return { playlistUrl:url, ...parseMedia(text,url) };
}
async function downloadHls(url, filenameBase, tabId) {
  report(tabId,1,'playlist',0,0,'Reading HLS playlist…');
  let info=await loadHls(url);
  if (info.encrypted) throw new Error('This HLS stream is encrypted/DRM-protected.');
  if (!info.urls.length) throw new Error('No HLS media segments found.');
  if (!info.endList && (info.urls.length<3 || info.duration<8)) { await new Promise(r=>setTimeout(r,1500)); info=await loadHls(info.playlistUrl); }
  const chunks=[]; const total=info.urls.length+(info.mapUrl?1:0); let completed=0;
  if (info.mapUrl) { chunks.push(await fetchBuffer(info.mapUrl,'initialization segment')); completed++; }
  for (const u of info.urls) { chunks.push(await fetchBuffer(u)); completed++; const pct=Math.max(3,Math.min(94,Math.round(completed/total*92))); report(tabId,pct,'download',completed,total,`Downloading HLS… ${completed}/${total} (${pct}%)`); }
  const bytes=concat(chunks); if (bytes.byteLength<100000) throw new Error('Detected stream is only a tiny preview/partial clip.');
  const firstPath=new URL(info.urls[0]).pathname.toLowerCase(); const fmp4=!!info.mapUrl || /\.m4s$|\.mp4$/i.test(firstPath);
  saveBlob(bytes,fmp4?'video/mp4':'video/mp2t',`${filenameBase}.mp4`);
  report(tabId,100,'done',total,total,`Complete — ${filenameBase}.mp4`);
  return { ok:true, message:`Downloaded ${filenameBase}.mp4` };
}

// ---------- DASH / MPD ----------
function parseISODuration(value='') {
  const m=value.match(/P(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?/i);
  if (!m) return 0; return Number(m[1]||0)*86400 + Number(m[2]||0)*3600 + Number(m[3]||0)*60 + Number(m[4]||0);
}
function inheritedAttr(rep, adap, name) { return rep.getAttribute(name) || adap.getAttribute(name) || ''; }
function childBase(node, fallback) { const b=node.querySelector(':scope > BaseURL'); return b?.textContent?.trim() ? abs(fallback,b.textContent.trim()) : fallback; }
function replaceTemplate(tpl, rep, number, time) {
  return tpl.replace(/\$RepresentationID\$/g,rep.id||'').replace(/\$Bandwidth\$/g,String(rep.bandwidth||0)).replace(/\$Number(?:%0\d+d)?\$/g,String(number)).replace(/\$Time\$/g,String(time ?? 0)).replace(/\$\$/g,'$');
}
function timelineNumbers(timeline, startNumber=1) {
  const result=[]; let currentTime=0, number=startNumber;
  for (const s of timeline.querySelectorAll(':scope > S')) {
    const d=Number(s.getAttribute('d')||0); if (!d) continue;
    if (s.hasAttribute('t')) currentTime=Number(s.getAttribute('t')||0);
    let r=Number(s.getAttribute('r')||0); if (r<0) r=0;
    for (let i=0;i<=r;i++) { result.push({number:number++,time:currentTime}); currentTime+=d; }
  }
  return result;
}
function buildRepresentation(repEl, adapEl, mpdUrl, mpdDuration) {
  const kind=(inheritedAttr(repEl,adapEl,'contentType') || inheritedAttr(repEl,adapEl,'mimeType').split('/')[0] || '').toLowerCase();
  const mime=inheritedAttr(repEl,adapEl,'mimeType');
  const codecs=inheritedAttr(repEl,adapEl,'codecs');
  const bandwidth=Number(repEl.getAttribute('bandwidth')||0);
  const width=Number(repEl.getAttribute('width')||0), height=Number(repEl.getAttribute('height')||0);
  let base=childBase(adapEl,mpdUrl); base=childBase(repEl,base);
  const tpl=repEl.querySelector(':scope > SegmentTemplate') || adapEl.querySelector(':scope > SegmentTemplate');
  if (!tpl) return {kind,mime,codecs,bandwidth,width,height,base,direct:base!==mpdUrl?base:'',segments:[]};
  const media=tpl.getAttribute('media')||'', initialization=tpl.getAttribute('initialization')||'';
  const timescale=Number(tpl.getAttribute('timescale')||1), duration=Number(tpl.getAttribute('duration')||0), startNumber=Number(tpl.getAttribute('startNumber')||1);
  const rep={id:repEl.getAttribute('id')||'',bandwidth};
  const segments=[];
  const timeline=tpl.querySelector(':scope > SegmentTimeline');
  let points=[];
  if (timeline) points=timelineNumbers(timeline,startNumber);
  else if (duration>0 && mpdDuration>0) { const count=Math.ceil(mpdDuration*timescale/duration); for (let i=0;i<count;i++) points.push({number:startNumber+i,time:i*duration}); }
  if (initialization) segments.push(abs(base,replaceTemplate(initialization,rep,startNumber,0)));
  for (const p of points) if (media) segments.push(abs(base,replaceTemplate(media,rep,p.number,p.time)));
  return {kind,mime,codecs,bandwidth,width,height,base,direct:'',segments};
}
async function parseDash(url) {
  const xml=await fetchText(url); const doc=new DOMParser().parseFromString(xml,'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Could not parse DASH MPD.');
  if (doc.querySelector('ContentProtection')) throw new Error('This DASH stream appears DRM/encryption protected.');
  const mpd=doc.documentElement; const duration=parseISODuration(mpd.getAttribute('mediaPresentationDuration')||'');
  const reps=[];
  for (const adap of doc.querySelectorAll('AdaptationSet')) for (const rep of adap.querySelectorAll(':scope > Representation')) reps.push(buildRepresentation(rep,adap,url,duration));
  return reps.filter(r => r.direct || r.segments.length);
}
async function downloadRep(rep, filename, tabId, startPct, endPct) {
  if (rep.direct && !rep.segments.length) {
    const bytes=await fetchBuffer(rep.direct,'DASH media'); saveBlob(bytes,rep.mime||'application/octet-stream',filename); return;
  }
  const chunks=[]; const total=rep.segments.length;
  for (let i=0;i<total;i++) {
    chunks.push(await fetchBuffer(rep.segments[i],'DASH segment'));
    const pct=Math.round(startPct+(i+1)/Math.max(1,total)*(endPct-startPct));
    report(tabId,pct,'dash',i+1,total,`Downloading DASH ${rep.kind || 'track'}… ${i+1}/${total} (${pct}%)`);
  }
  saveBlob(concat(chunks),rep.mime||'application/octet-stream',filename);
}
async function downloadDash(url, filenameBase, tabId) {
  report(tabId,2,'dash-manifest',0,0,'Reading DASH manifest…');
  const reps=await parseDash(url); if (!reps.length) throw new Error('No downloadable DASH representations found.');
  const videos=reps.filter(r=>r.kind==='video').sort((a,b)=>(b.height-a.height)||(b.bandwidth-a.bandwidth));
  const audios=reps.filter(r=>r.kind==='audio').sort((a,b)=>b.bandwidth-a.bandwidth);
  const video=videos[0], audio=audios[0];
  if (!video && !audio) throw new Error('No video/audio DASH tracks found.');
  if (video) await downloadRep(video,`${filenameBase}.mp4`,tabId,5,audio?72:96);
  if (audio) await downloadRep(audio,`${filenameBase} - audio.m4a`,tabId,video?74:5,96);
  report(tabId,100,'done',1,1,audio && video ? 'DASH complete — video and audio tracks saved separately.' : 'DASH download complete.');
  return { ok:true, separateTracks:!!(video&&audio), message: video&&audio ? 'DASH video and audio were downloaded separately. Browser-only merging is not yet bundled.' : 'DASH media downloaded.' };
}

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if (msg?.target!=='offscreen') return;
  let promise=null;
  if (msg.type==='DOWNLOAD_HLS') promise=downloadHls(msg.url,msg.filenameBase,msg.tabId);
  else if (msg.type==='DOWNLOAD_DASH') promise=downloadDash(msg.url,msg.filenameBase,msg.tabId);
  else if (msg.type==='DOWNLOAD_DIRECT') promise=downloadDirect(msg.url,msg.filenameBase,msg.tabId,msg.mime,msg.kind);
  if (!promise) return;
  promise.then(sendResponse).catch(err=>{ report(msg.tabId,0,'error',0,0,`Download failed: ${err.message||String(err)}`); sendResponse({ok:false,error:err.message||String(err)}); });
  return true;
});

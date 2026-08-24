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
      const r = await fetch(url, { credentials:'include', cache:'no-store', redirect:'follow' });
      if (r.ok) return r;
      last = new Error(`HTTP ${r.status} while loading ${label}`);
      if (![401,403,404,408,416,429,500,502,503,504].includes(r.status)) throw last;
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
  setTimeout(() => URL.revokeObjectURL(blobUrl), 180000);
}

async function responseToBytes(r, tabId, kind, startPct=3, endPct=96) {
  const expected=Number(r.headers.get('content-length')||0)||0;
  const reader=r.body?.getReader?.();
  const chunks=[]; let received=0;
  if (!reader) return new Uint8Array(await r.arrayBuffer());
  while (true) {
    const {done,value}=await reader.read();
    if (done) break;
    if (value?.byteLength) { chunks.push(value); received += value.byteLength; }
    if (expected > 0) {
      const pct=Math.max(startPct,Math.min(endPct,Math.round(startPct+(received/expected)*(endPct-startPct))));
      report(tabId,pct,'direct',received,expected,`Downloading ${kind === 'audio' ? 'audio' : 'video'}… ${pct}%`);
    }
  }
  return concat(chunks);
}

async function downloadDirect(url, originalUrl, filenameBase, tabId, mime='', kind='video') {
  report(tabId,2,'direct',0,0,`Preparing ${kind === 'audio' ? 'audio' : 'video'} download…`);
  let r;
  try { r=await fetchWithRetry(url, kind === 'audio' ? 'audio stream' : 'video stream', 1); }
  catch (firstError) {
    if (!originalUrl || originalUrl === url) throw firstError;
    r=await fetchWithRetry(originalUrl, kind === 'audio' ? 'audio stream' : 'video stream', 1);
  }
  const responseType=(r.headers.get('content-type')||mime||'').toLowerCase();
  if (/text\/|application\/(?:json|xml|html)/.test(responseType)) throw new Error(`Media server returned ${responseType || 'a non-media response'} instead of media.`);
  const bytes=await responseToBytes(r,tabId,kind);
  if (bytes.byteLength < 16384) throw new Error('The media URL returned only a tiny/expired response. Play the video again and click Scan.');
  const finalMime=responseType && !/octet-stream/.test(responseType) ? responseType : (mime || (kind==='audio'?'audio/mp4':'video/mp4'));
  const ext=safeExt(finalMime,kind,url);
  const filename=`${filenameBase}${kind==='audio'?' - audio':''}${ext}`;
  report(tabId,98,'save',bytes.byteLength,bytes.byteLength,'Saving file… 98%');
  saveBlob(bytes,finalMime,filename);
  report(tabId,100,'done',bytes.byteLength,bytes.byteLength,`Complete — ${filename}`);
  return {ok:true,message:`Downloaded ${filename}`};
}

// ---------- HLS ----------
function parseAttrs(line='') {
  const out={};
  const body=line.includes(':')?line.slice(line.indexOf(':')+1):line;
  const re=/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi; let m;
  while ((m=re.exec(body))) out[m[1].toUpperCase()]=String(m[2]||'').replace(/^"|"$/g,'');
  return out;
}

function parseMaster(text, base) {
  const lines=text.split(/\r?\n/), variants=[], audios=[];
  for (let i=0;i<lines.length;i++) {
    const line=lines[i].trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a=parseAttrs(line);
      if ((a.TYPE||'').toUpperCase()==='AUDIO' && a.URI) audios.push({url:abs(base,a.URI),groupId:a['GROUP-ID']||'',name:a.NAME||'',isDefault:/YES/i.test(a.DEFAULT||'')});
      continue;
    }
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const a=parseAttrs(line); let j=i+1;
    while (j<lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
    if (lines[j]) variants.push({url:abs(base,lines[j].trim()),bw:Number(a.BANDWIDTH||0),audioGroup:a.AUDIO||'',codecs:a.CODECS||''});
  }
  variants.sort((a,b)=>b.bw-a.bw);
  return {variants,audios};
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
  return {mapUrl,urls,encrypted,endList,duration};
}

async function loadMediaPlaylist(url) {
  const parsed=parseMedia(await fetchText(url),url);
  if (!parsed.endList && (parsed.urls.length<3 || parsed.duration<8)) {
    await new Promise(r=>setTimeout(r,1200));
    return {playlistUrl:url,...parseMedia(await fetchText(url),url)};
  }
  return {playlistUrl:url,...parsed};
}

async function loadHls(url) {
  const text=await fetchText(url);
  const master=parseMaster(text,url);
  if (!master.variants.length) return {video:{playlistUrl:url,...parseMedia(text,url)},audio:null};
  let lastError;
  for (const variant of master.variants) {
    try {
      const video=await loadMediaPlaylist(variant.url);
      if (!video.urls.length) continue;
      const matching=master.audios.filter(a=>!variant.audioGroup || a.groupId===variant.audioGroup);
      const audioDef=matching.find(a=>a.isDefault) || matching[0] || null;
      const audio=audioDef ? await loadMediaPlaylist(audioDef.url).catch(()=>null) : null;
      return {video,audio};
    } catch(e){lastError=e;}
  }
  throw lastError || new Error('No playable HLS variant found.');
}

async function downloadPlaylistTrack(info, tabId, label, startPct, endPct) {
  if (!info?.urls?.length) throw new Error(`No HLS ${label} segments found.`);
  if (info.encrypted) throw new Error('This HLS stream is encrypted/DRM-protected.');
  const parts=[]; const total=info.urls.length+(info.mapUrl?1:0); let done=0;
  if (info.mapUrl) { parts.push(await fetchBuffer(info.mapUrl,`${label} initialization segment`)); done++; }
  for (const u of info.urls) {
    parts.push(await fetchBuffer(u,`${label} segment`)); done++;
    const pct=Math.round(startPct+(done/Math.max(1,total))*(endPct-startPct));
    report(tabId,pct,'hls',done,total,`Downloading HLS ${label}… ${done}/${total} (${pct}%)`);
  }
  return {bytes:concat(parts),fmp4:!!info.mapUrl || /\.m4s$|\.mp4$/i.test(new URL(info.urls[0]).pathname)};
}

async function downloadHls(url, filenameBase, tabId) {
  report(tabId,1,'playlist',0,0,'Reading HLS playlist…');
  const info=await loadHls(url);
  const video=await downloadPlaylistTrack(info.video,tabId,'video',3,info.audio?70:96);
  if (video.bytes.byteLength<100000) throw new Error('Detected HLS stream is only a tiny preview/partial clip.');
  saveBlob(video.bytes,video.fmp4?'video/mp4':'video/mp2t',`${filenameBase}.mp4`);
  if (info.audio?.urls?.length) {
    const audio=await downloadPlaylistTrack(info.audio,tabId,'audio',72,96);
    if (audio.bytes.byteLength>16000) saveBlob(audio.bytes,audio.fmp4?'audio/mp4':'audio/aac',`${filenameBase} - audio.m4a`);
    report(tabId,100,'done',1,1,'HLS complete — video and separate audio track saved.');
    return {ok:true,separateTracks:true,message:'HLS video and audio were delivered separately and saved as separate files.'};
  }
  report(tabId,100,'done',1,1,`Complete — ${filenameBase}.mp4`);
  return {ok:true,message:`Downloaded ${filenameBase}.mp4`};
}

// ---------- DASH / MPD ----------
function parseISODuration(value='') {
  const m=value.match(/P(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?/i);
  if (!m) return 0; return Number(m[1]||0)*86400+Number(m[2]||0)*3600+Number(m[3]||0)*60+Number(m[4]||0);
}
function inheritedAttr(rep,adap,name){return rep.getAttribute(name)||adap.getAttribute(name)||'';}
function childBase(node,fallback){const b=node.querySelector(':scope > BaseURL');return b?.textContent?.trim()?abs(fallback,b.textContent.trim()):fallback;}
function replaceTemplate(tpl,rep,number,time){return tpl.replace(/\$RepresentationID\$/g,rep.id||'').replace(/\$Bandwidth\$/g,String(rep.bandwidth||0)).replace(/\$Number(?:%0\d+d)?\$/g,String(number)).replace(/\$Time\$/g,String(time??0)).replace(/\$\$/g,'$');}
function timelineNumbers(timeline,startNumber=1,maxCount=20000){
  const result=[]; let currentTime=0,number=startNumber;
  for(const s of timeline.querySelectorAll(':scope > S')){
    const d=Number(s.getAttribute('d')||0);if(!d)continue;if(s.hasAttribute('t'))currentTime=Number(s.getAttribute('t')||0);
    let r=Number(s.getAttribute('r')||0);if(r<0)r=0;
    for(let i=0;i<=r&&result.length<maxCount;i++){result.push({number:number++,time:currentTime});currentTime+=d;}
  }
  return result;
}
function buildRepresentation(repEl,adapEl,mpdUrl,mpdDuration){
  const kind=(inheritedAttr(repEl,adapEl,'contentType')||inheritedAttr(repEl,adapEl,'mimeType').split('/')[0]||'').toLowerCase();
  const mime=inheritedAttr(repEl,adapEl,'mimeType'),codecs=inheritedAttr(repEl,adapEl,'codecs');
  const bandwidth=Number(repEl.getAttribute('bandwidth')||0),width=Number(repEl.getAttribute('width')||0),height=Number(repEl.getAttribute('height')||0);
  let base=childBase(adapEl,mpdUrl);base=childBase(repEl,base);
  const list=repEl.querySelector(':scope > SegmentList')||adapEl.querySelector(':scope > SegmentList');
  if(list){
    const segments=[];const init=list.querySelector(':scope > Initialization')?.getAttribute('sourceURL');if(init)segments.push(abs(base,init));
    for(const s of list.querySelectorAll(':scope > SegmentURL')){const media=s.getAttribute('media');if(media)segments.push(abs(base,media));}
    return {kind,mime,codecs,bandwidth,width,height,direct:'',segments};
  }
  const tpl=repEl.querySelector(':scope > SegmentTemplate')||adapEl.querySelector(':scope > SegmentTemplate');
  if(!tpl)return {kind,mime,codecs,bandwidth,width,height,direct:base!==mpdUrl?base:'',segments:[]};
  const media=tpl.getAttribute('media')||'',initialization=tpl.getAttribute('initialization')||'';
  const timescale=Number(tpl.getAttribute('timescale')||1),duration=Number(tpl.getAttribute('duration')||0),startNumber=Number(tpl.getAttribute('startNumber')||1);
  const rep={id:repEl.getAttribute('id')||'',bandwidth};const segments=[];const timeline=tpl.querySelector(':scope > SegmentTimeline');let points=[];
  if(timeline)points=timelineNumbers(timeline,startNumber);
  else if(duration>0&&mpdDuration>0){const count=Math.min(20000,Math.ceil(mpdDuration*timescale/duration));for(let i=0;i<count;i++)points.push({number:startNumber+i,time:i*duration});}
  if(initialization)segments.push(abs(base,replaceTemplate(initialization,rep,startNumber,0)));
  for(const p of points)if(media)segments.push(abs(base,replaceTemplate(media,rep,p.number,p.time)));
  return {kind,mime,codecs,bandwidth,width,height,direct:'',segments};
}
async function parseDash(url){
  const xml=await fetchText(url);const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.querySelector('parsererror'))throw new Error('Could not parse DASH MPD.');
  if(doc.querySelector('ContentProtection'))throw new Error('This DASH stream appears DRM/encryption protected.');
  const duration=parseISODuration(doc.documentElement.getAttribute('mediaPresentationDuration')||'');const reps=[];
  for(const adap of doc.querySelectorAll('AdaptationSet'))for(const rep of adap.querySelectorAll(':scope > Representation'))reps.push(buildRepresentation(rep,adap,url,duration));
  return reps.filter(r=>r.direct||r.segments.length);
}
async function downloadRep(rep,filename,tabId,startPct,endPct){
  if(rep.direct&&!rep.segments.length){const bytes=await fetchBuffer(rep.direct,'DASH media');saveBlob(bytes,rep.mime||'application/octet-stream',filename);return;}
  const chunks=[];const total=rep.segments.length;
  for(let i=0;i<total;i++){chunks.push(await fetchBuffer(rep.segments[i],'DASH segment'));const pct=Math.round(startPct+(i+1)/Math.max(1,total)*(endPct-startPct));report(tabId,pct,'dash',i+1,total,`Downloading DASH ${rep.kind||'track'}… ${i+1}/${total} (${pct}%)`);}
  saveBlob(concat(chunks),rep.mime||'application/octet-stream',filename);
}
async function downloadDash(url,filenameBase,tabId){
  report(tabId,2,'dash-manifest',0,0,'Reading DASH manifest…');const reps=await parseDash(url);if(!reps.length)throw new Error('No downloadable DASH representations found.');
  const videos=reps.filter(r=>r.kind==='video').sort((a,b)=>(b.height-a.height)||(b.bandwidth-a.bandwidth));
  const audios=reps.filter(r=>r.kind==='audio').sort((a,b)=>b.bandwidth-a.bandwidth);const video=videos[0],audio=audios[0];
  if(!video&&!audio)throw new Error('No video/audio DASH tracks found.');
  if(video)await downloadRep(video,`${filenameBase}${/webm/i.test(video.mime)?'.webm':'.mp4'}`,tabId,5,audio?72:96);
  if(audio)await downloadRep(audio,`${filenameBase} - audio${/webm|opus|ogg/i.test(audio.mime)?'.webm':'.m4a'}`,tabId,video?74:5,96);
  report(tabId,100,'done',1,1,audio&&video?'DASH complete — video and audio tracks saved separately.':'DASH download complete.');
  return {ok:true,separateTracks:!!(video&&audio),message:video&&audio?'DASH video and audio were downloaded separately.':'DASH media downloaded.'};
}

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg?.target!=='offscreen')return;
  let promise=null;
  if(msg.type==='DOWNLOAD_HLS')promise=downloadHls(msg.url,msg.filenameBase,msg.tabId);
  else if(msg.type==='DOWNLOAD_DASH')promise=downloadDash(msg.url,msg.filenameBase,msg.tabId);
  else if(msg.type==='DOWNLOAD_DIRECT')promise=downloadDirect(msg.url,msg.originalUrl,msg.filenameBase,msg.tabId,msg.mime,msg.kind);
  if(!promise)return;
  promise.then(sendResponse).catch(err=>{report(msg.tabId,0,'error',0,0,`Download failed: ${err.message||String(err)}`);sendResponse({ok:false,error:err.message||String(err)});});
  return true;
});

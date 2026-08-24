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

function saveBlobObject(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 180000);
}
function saveBlob(bytes, type, filename) { saveBlobObject(new Blob([bytes], { type }), filename); }

async function responseToBytes(r, tabId, label, startPct=3, endPct=96) {
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
      report(tabId,pct,'fetch',received,expected,`${label}… ${pct}%`);
    }
  }
  return concat(chunks);
}

async function fetchMediaObject(media, tabId, label, startPct, endPct) {
  let r;
  try { r=await fetchWithRetry(media.url, label, 1); }
  catch (firstError) {
    if (!media.originalUrl || media.originalUrl === media.url) throw firstError;
    r=await fetchWithRetry(media.originalUrl, label, 1);
  }
  const responseType=(r.headers.get('content-type')||media.mime||'').toLowerCase();
  if (/text\/|application\/(?:json|xml|html)/.test(responseType)) throw new Error(`Media server returned ${responseType || 'a non-media response'} instead of media.`);
  const bytes=await responseToBytes(r,tabId,label,startPct,endPct);
  if (bytes.byteLength < 16384) throw new Error(`${label} returned only a tiny/expired response. Play the video again and click Scan.`);
  return { bytes, mime: responseType && !/octet-stream/.test(responseType) ? responseType : (media.mime || (media.kind==='audio'?'audio/mp4':'video/mp4')) };
}

async function downloadDirect(url, originalUrl, filenameBase, tabId, mime='', kind='video') {
  report(tabId,2,'direct',0,0,`Preparing ${kind === 'audio' ? 'audio' : 'video'} download…`);
  const result=await fetchMediaObject({url,originalUrl,mime,kind},tabId,`Downloading ${kind === 'audio' ? 'audio' : 'video'}`,3,96);
  const ext=safeExt(result.mime,kind,url);
  const filename=`${filenameBase}${kind==='audio'?' - audio':''}${ext}`;
  report(tabId,98,'save',result.bytes.byteLength,result.bytes.byteLength,'Saving file… 98%');
  saveBlob(result.bytes,result.mime,filename);
  report(tabId,100,'done',result.bytes.byteLength,result.bytes.byteLength,`Complete — ${filename}`);
  return {ok:true,message:`Downloaded ${filename}`};
}

// ---------- Local adaptive-track merger ----------
function waitMediaReady(el, timeoutMs=20000) {
  return new Promise((resolve,reject) => {
    if (el.readyState >= 1 && Number.isFinite(el.duration)) return resolve();
    const timer=setTimeout(()=>finish(new Error('Timed out while preparing media for local merge.')),timeoutMs);
    const finish=(err)=>{clearTimeout(timer);el.removeEventListener('loadedmetadata',ok);el.removeEventListener('error',bad);err?reject(err):resolve();};
    const ok=()=>finish();
    const bad=()=>finish(new Error('Chrome could not decode one of the adaptive tracks for local merge.'));
    el.addEventListener('loadedmetadata',ok,{once:true});
    el.addEventListener('error',bad,{once:true});
  });
}

function bestRecorderType() {
  const types=[
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; } }) || '';
}

async function mergeLocalBlobs(videoData, audioData, filenameBase, tabId, options={}) {
  if (typeof MediaRecorder === 'undefined') throw new Error('This Chrome build does not support the local MediaRecorder merge engine.');
  const videoBlob=new Blob([videoData.bytes],{type:videoData.mime||'video/mp4'});
  const audioBlob=new Blob([audioData.bytes],{type:audioData.mime||'audio/mp4'});
  const videoUrl=URL.createObjectURL(videoBlob), audioUrl=URL.createObjectURL(audioBlob);
  const video=document.createElement('video'), audio=document.createElement('audio');
  video.preload='auto'; audio.preload='auto'; video.playsInline=true; video.muted=true;
  video.src=videoUrl; audio.src=audioUrl;
  video.style.display='none'; audio.style.display='none';
  document.body.append(video,audio);

  let audioCtx=null, syncTimer=null, progressTimer=null;
  try {
    await Promise.all([waitMediaReady(video),waitMediaReady(audio)]);
    const duration=Math.min(
      Number.isFinite(video.duration)&&video.duration>0?video.duration:Infinity,
      Number.isFinite(audio.duration)&&audio.duration>0?audio.duration:Infinity
    );
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not determine track duration for local merge.');

    const capture=video.captureStream?.bind(video) || video.webkitCaptureStream?.bind(video);
    if (!capture) throw new Error('This Chrome build does not support media-element capture required for local merging.');
    const videoStream=capture();
    const videoTracks=videoStream.getVideoTracks();
    if (!videoTracks.length) throw new Error('No decodable video track was available to the local merge engine.');

    audioCtx=new AudioContext();
    await audioCtx.resume();
    const source=audioCtx.createMediaElementSource(audio);
    const destination=audioCtx.createMediaStreamDestination();
    source.connect(destination);
    const audioTracks=destination.stream.getAudioTracks();
    if (!audioTracks.length) throw new Error('No decodable audio track was available to the local merge engine.');

    const mergedStream=new MediaStream([...videoTracks,...audioTracks]);
    const mimeType=bestRecorderType();
    const recOptions={};
    if (mimeType) recOptions.mimeType=mimeType;
    const sourceBitrate=Number(options.bitrate||0);
    if (sourceBitrate>0) recOptions.videoBitsPerSecond=Math.max(800000,Math.min(12000000,sourceBitrate));
    recOptions.audioBitsPerSecond=192000;
    const recorder=new MediaRecorder(mergedStream,recOptions);
    const chunks=[];

    const done=new Promise((resolve,reject)=>{
      recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data);};
      recorder.onerror=e=>reject(e.error||new Error('Local media merge failed.'));
      recorder.onstop=()=>resolve();
    });

    video.currentTime=0; audio.currentTime=0;
    report(tabId,31,'merge',0,duration,'Merging video + audio locally… 31%');
    recorder.start(1000);
    await Promise.all([video.play(),audio.play()]);

    syncTimer=setInterval(()=>{
      if (!video.paused && !audio.paused && Math.abs(video.currentTime-audio.currentTime)>0.20) {
        try { audio.currentTime=video.currentTime; } catch (_) {}
      }
    },1000);
    progressTimer=setInterval(()=>{
      const t=Math.max(0,Math.min(duration,video.currentTime||0));
      const pct=Math.max(31,Math.min(97,Math.round(31+(t/duration)*66)));
      report(tabId,pct,'merge',t,duration,`Merging locally… ${pct}% (${Math.floor(t)}/${Math.ceil(duration)} sec)`);
    },1000);

    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Local merge exceeded the expected media duration.')),Math.max(30000,(duration+30)*1000));
      const finish=()=>{clearTimeout(timeout);resolve();};
      video.addEventListener('ended',finish,{once:true});
      video.addEventListener('error',()=>{clearTimeout(timeout);reject(new Error('Video decode failed during local merge.'));},{once:true});
    });
    if (recorder.state !== 'inactive') recorder.stop();
    await done;

    const outType=recorder.mimeType || mimeType || 'video/webm';
    const output=new Blob(chunks,{type:outType});
    if (output.size < 32768) throw new Error('Local merge produced an unexpectedly small output file.');
    const ext=/mp4/i.test(outType)?'.mp4':'.webm';
    const filename=`${filenameBase}${ext}`;
    report(tabId,99,'save',output.size,output.size,'Saving merged file… 99%');
    saveBlobObject(output,filename);
    report(tabId,100,'done',output.size,output.size,`Complete — ${filename}`);
    return {ok:true,merged:true,message:`Downloaded merged video with audio: ${filename}`};
  } finally {
    if(syncTimer)clearInterval(syncTimer);
    if(progressTimer)clearInterval(progressTimer);
    try{video.pause();audio.pause();}catch(_){}
    try{video.remove();audio.remove();}catch(_){}
    try{if(audioCtx)await audioCtx.close();}catch(_){}
    URL.revokeObjectURL(videoUrl); URL.revokeObjectURL(audioUrl);
  }
}

async function downloadMergedMedia(video, audio, filenameBase, tabId) {
  report(tabId,2,'pair-fetch',0,0,'Preparing adaptive video + audio…');
  const videoData=await fetchMediaObject(video,tabId,'Downloading video track',3,18);
  const audioData=await fetchMediaObject(audio,tabId,'Downloading audio track',19,30);
  try {
    return await mergeLocalBlobs(videoData,audioData,filenameBase,tabId,{bitrate:video.bitrate});
  } catch (mergeError) {
    // Never lose a successful fetch. If the browser codec/recorder cannot merge this pair,
    // save the two valid tracks and clearly report why.
    const vExt=safeExt(videoData.mime,'video',video.url), aExt=safeExt(audioData.mime,'audio',audio.url);
    saveBlob(videoData.bytes,videoData.mime,`${filenameBase}${vExt}`);
    saveBlob(audioData.bytes,audioData.mime,`${filenameBase} - audio${aExt}`);
    throw new Error(`${mergeError.message} The valid video and audio tracks were saved separately as a fallback.`);
  }
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
  if (!master.variants.length) return {video:{playlistUrl:url,...parseMedia(text,url)},audio:null,bitrate:0};
  let lastError;
  for (const variant of master.variants) {
    try {
      const video=await loadMediaPlaylist(variant.url);
      if (!video.urls.length) continue;
      const matching=master.audios.filter(a=>!variant.audioGroup || a.groupId===variant.audioGroup);
      const audioDef=matching.find(a=>a.isDefault) || matching[0] || null;
      const audio=audioDef ? await loadMediaPlaylist(audioDef.url).catch(()=>null) : null;
      return {video,audio,bitrate:variant.bw};
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
  const video=await downloadPlaylistTrack(info.video,tabId,'video',3,info.audio?18:96);
  if (video.bytes.byteLength<100000) throw new Error('Detected HLS stream is only a tiny preview/partial clip.');
  if (info.audio?.urls?.length) {
    const audio=await downloadPlaylistTrack(info.audio,tabId,'audio',19,30);
    if (audio.bytes.byteLength>16000) {
      try {
        return await mergeLocalBlobs(
          {bytes:video.bytes,mime:video.fmp4?'video/mp4':'video/mp2t'},
          {bytes:audio.bytes,mime:audio.fmp4?'audio/mp4':'audio/aac'},
          filenameBase,tabId,{bitrate:info.bitrate}
        );
      } catch (e) {
        saveBlob(video.bytes,video.fmp4?'video/mp4':'video/mp2t',`${filenameBase}.mp4`);
        saveBlob(audio.bytes,audio.fmp4?'audio/mp4':'audio/aac',`${filenameBase} - audio.m4a`);
        throw new Error(`${e.message} HLS tracks were saved separately as a fallback.`);
      }
    }
  }
  saveBlob(video.bytes,video.fmp4?'video/mp4':'video/mp2t',`${filenameBase}.mp4`);
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
async function downloadRepBytes(rep,tabId,startPct,endPct){
  if(rep.direct&&!rep.segments.length){
    const r=await fetchWithRetry(rep.direct,'DASH media');
    return {bytes:await responseToBytes(r,tabId,`Downloading DASH ${rep.kind||'track'}`,startPct,endPct),mime:rep.mime||r.headers.get('content-type')||'application/octet-stream'};
  }
  const chunks=[];const total=rep.segments.length;
  for(let i=0;i<total;i++){
    chunks.push(await fetchBuffer(rep.segments[i],'DASH segment'));
    const pct=Math.round(startPct+(i+1)/Math.max(1,total)*(endPct-startPct));
    report(tabId,pct,'dash',i+1,total,`Downloading DASH ${rep.kind||'track'}… ${i+1}/${total} (${pct}%)`);
  }
  return {bytes:concat(chunks),mime:rep.mime||'application/octet-stream'};
}
async function downloadDash(url,filenameBase,tabId){
  report(tabId,2,'dash-manifest',0,0,'Reading DASH manifest…');
  const reps=await parseDash(url);if(!reps.length)throw new Error('No downloadable DASH representations found.');
  const videos=reps.filter(r=>r.kind==='video').sort((a,b)=>(b.height-a.height)||(b.bandwidth-a.bandwidth));
  const audios=reps.filter(r=>r.kind==='audio').sort((a,b)=>b.bandwidth-a.bandwidth);const video=videos[0],audio=audios[0];
  if(!video&&!audio)throw new Error('No video/audio DASH tracks found.');
  if(video&&audio){
    const vd=await downloadRepBytes(video,tabId,5,18);
    const ad=await downloadRepBytes(audio,tabId,19,30);
    try { return await mergeLocalBlobs(vd,ad,filenameBase,tabId,{bitrate:video.bandwidth}); }
    catch(e){
      saveBlob(vd.bytes,vd.mime,`${filenameBase}${/webm/i.test(vd.mime)?'.webm':'.mp4'}`);
      saveBlob(ad.bytes,ad.mime,`${filenameBase} - audio${/webm|opus|ogg/i.test(ad.mime)?'.webm':'.m4a'}`);
      throw new Error(`${e.message} DASH tracks were saved separately as a fallback.`);
    }
  }
  const only=video||audio;const d=await downloadRepBytes(only,tabId,5,96);
  const filename=video?`${filenameBase}${/webm/i.test(d.mime)?'.webm':'.mp4'}`:`${filenameBase} - audio${/webm|opus|ogg/i.test(d.mime)?'.webm':'.m4a'}`;
  saveBlob(d.bytes,d.mime,filename);report(tabId,100,'done',1,1,`Complete — ${filename}`);return {ok:true,message:`Downloaded ${filename}`};
}

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg?.target!=='offscreen')return;
  let promise=null;
  if(msg.type==='DOWNLOAD_HLS')promise=downloadHls(msg.url,msg.filenameBase,msg.tabId);
  else if(msg.type==='DOWNLOAD_DASH')promise=downloadDash(msg.url,msg.filenameBase,msg.tabId);
  else if(msg.type==='DOWNLOAD_DIRECT')promise=downloadDirect(msg.url,msg.originalUrl,msg.filenameBase,msg.tabId,msg.mime,msg.kind);
  else if(msg.type==='DOWNLOAD_MERGED_MEDIA')promise=downloadMergedMedia(msg.video,msg.audio,msg.filenameBase,msg.tabId);
  if(!promise)return;
  promise.then(sendResponse).catch(err=>{report(msg.tabId,0,'error',0,0,`Download failed: ${err.message||String(err)}`);sendResponse({ok:false,error:err.message||String(err)});});
  return true;
});

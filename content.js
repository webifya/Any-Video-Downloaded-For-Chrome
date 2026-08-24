(() => {
  if (window.top !== window.self) return;
  if (/^(chrome|edge|about|moz-extension|chrome-extension):/i.test(location.protocol)) return;

  const state = {
    candidates: new Map(), launcher: null, panel: null, panelOpen: false,
    scanBusy: false, downloading: false, lastNetworkPull: 0,
    pageSignature: '', changeTimer: 0, epoch: Date.now(), currentLabel: ''
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sanitize = v => String(v || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0,170);
  const isHls = u => /\.m3u8(?:$|[?#])/i.test(u||'') || /[?&](?:format|type)=(?:application(?:%2F|\/)x-mpegurl|m3u8)(?:&|$)/i.test(u||'');
  const isDash = u => /\.mpd(?:$|[?#])/i.test(u||'');
  const isDirect = u => /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i.test(u||'');
  const isAudio = u => /\.(?:m4a|aac|mp3|opus|ogg)(?:$|[?#])/i.test(u||'');

  function visible(el){ if(!el?.isConnected)return false; const s=getComputedStyle(el); if(s.display==='none'||s.visibility==='hidden')return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0; }
  function meta(name){ return sanitize(document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content||''); }
  function textFrom(selectors){ for(const sel of selectors){ for(const el of document.querySelectorAll(sel)){ if(!visible(el))continue; const t=sanitize(el.textContent); if(t)return t; } } return ''; }
  function meaningful(v){ const t=sanitize(v); if(!t)return ''; if(/^(home|courses?|lessons?|categories?|dashboard|instructor|videos?|watch|reels?|facebook|instagram|youtube|vimeo)$/i.test(t))return ''; return t; }

  function pageTitle(){
    const h=location.hostname.toLowerCase();
    if(/(^|\.)youtube\.com$/.test(h)) return meaningful(textFrom(['ytd-watch-metadata h1 yt-formatted-string','#title h1 yt-formatted-string','h1.ytd-watch-metadata']))||meaningful(meta('og:title'))||meaningful(document.title.replace(/\s*-\s*YouTube\s*$/i,''))||'YouTube Video';
    if(/(^|\.)vimeo\.com$/.test(h)) return meaningful(textFrom(['main h1','[data-testid*="title"]','h1']))||meaningful(meta('og:title'))||meaningful(document.title)||'Vimeo Video';
    if(/(^|\.)facebook\.com$/.test(h)) return meaningful(meta('og:title'))||meaningful(textFrom(['[role="main"] h1','main h1','[data-ad-preview="message"]']))||meaningful(document.title)||'Facebook Video';
    if(/(^|\.)instagram\.com$/.test(h)) return meaningful(meta('og:title'))||meaningful(textFrom(['article h1','article header','main h1']))||meaningful(document.title.replace(/\s*[•|]\s*Instagram.*$/i,''))||'Instagram Video';
    const active=['[aria-current="page"]','[aria-current="true"]','[data-active="true"]','[data-selected="true"]','[class*="lesson"][class*="active"]','[class*="lesson"][class*="selected"]'];
    for(const sel of active) for(const el of document.querySelectorAll(sel)){ if(!visible(el))continue; const t=meaningful(el.textContent); if(t&&t.length<=180)return t; }
    const crumbs=[...document.querySelectorAll('[aria-label*="breadcrumb" i] a,[aria-label*="breadcrumb" i] span,.breadcrumb a,.breadcrumb span,[class*="breadcrumb"] a,[class*="breadcrumb"] span')].filter(visible).map(el=>meaningful(el.textContent)).filter(Boolean);
    if(crumbs.length)return crumbs[crumbs.length-1];
    return meaningful(textFrom(['main h1','[role="main"] h1','article h1','h1','main h2','[role="main"] h2']))||meaningful(meta('og:title'))||meaningful(document.title)||sanitize(location.hostname)||'Video';
  }

  function nearbyTitle(video){ const own=meaningful(video.getAttribute('aria-label')||video.getAttribute('title')); if(own)return own; const c=video.closest('article,section,figure,[class*="video"],[class*="player"]'); return meaningful(c?.querySelector('h1,h2,h3,h4,h5,h6,[class*="title"]')?.textContent)||pageTitle(); }
  function signature(){ const v=document.querySelector('video'); const src=v?.currentSrc||v?.src||v?.querySelector('source')?.src||''; return `${location.href}|${pageTitle().toLowerCase()}|${src.startsWith('blob:')?'blob':src}`; }

  function normalize(raw){
    const url=raw?.url||''; if(!url||url.startsWith('blob:')||url.startsWith('data:'))return null;
    let kind=raw.kind||''; if(!kind){ if(isDash(url))kind='dash'; else if(isHls(url))kind='hls'; else if(isAudio(url))kind='audio'; else if(isDirect(url))kind='video'; }
    if(!kind)return null;
    return {
      url,kind,mime:raw.mime||'',source:raw.source||'page',name:sanitize(raw.name),
      contentLength:Number(raw.contentLength||0),totalLength:Number(raw.totalLength||0),width:Number(raw.width||0),height:Number(raw.height||0),bitrate:Number(raw.bitrate||0),
      qualityLabel:sanitize(raw.qualityLabel),itag:Number(raw.itag||0),seenAt:Number(raw.seenAt||Date.now()),frameId:Number.isInteger(raw.frameId)?raw.frameId:0,
      hasAudio:raw.hasAudio===undefined?undefined:!!raw.hasAudio,hasVideo:raw.hasVideo===undefined?undefined:!!raw.hasVideo,isProgressive:!!(raw.isProgressive||raw.progressive)
    };
  }
  function key(item){
    try{
      const u=new URL(item.url),h=u.hostname.toLowerCase();
      if(/(?:^|\.)googlevideo\.com$/.test(h))return `yt:${item.kind}:${u.searchParams.get('itag')||item.itag||u.pathname}`;
      if(/(?:^|\.)fbcdn\.net$|(?:^|\.)cdninstagram\.com$/.test(h)){for(const k of ['bytestart','byteend','range','start','end'])u.searchParams.delete(k);return `meta:${item.kind}:${u.origin}${u.pathname}?${u.searchParams.toString()}`;}
      if(/(?:^|\.)vimeocdn\.com$|(?:^|\.)akamaized\.net$/.test(h)){for(const k of ['range','rn','rbuf'])u.searchParams.delete(k);return `vimeo:${item.kind}:${u.origin}${u.pathname}?${u.searchParams.toString()}`;}
      return `${item.kind}:${u.href.split('#')[0]}`;
    }catch(_){return `${item.kind}:${item.url}`;}
  }
  function remember(raw){
    const item=normalize(raw); if(!item)return false; if(item.seenAt<state.epoch-2500)return false;
    const k=key(item),prev=state.candidates.get(k)||{};
    state.candidates.set(k,{...prev,...item,name:item.name||prev.name||'',contentLength:item.contentLength||prev.contentLength||0,totalLength:item.totalLength||prev.totalLength||0,width:item.width||prev.width||0,height:item.height||prev.height||0,bitrate:item.bitrate||prev.bitrate||0,qualityLabel:item.qualityLabel||prev.qualityLabel||'',frameId:item.frameId||prev.frameId||0,hasAudio:item.hasAudio!==undefined?item.hasAudio:prev.hasAudio,hasVideo:item.hasVideo!==undefined?item.hasVideo:prev.hasVideo,isProgressive:item.isProgressive||prev.isProgressive||false});
    return !prev.url;
  }
  function collectDom(){ let changed=false; for(const v of document.querySelectorAll('video')){ const name=nearbyTitle(v); const urls=[v.currentSrc,v.src,...[...v.querySelectorAll('source')].map(s=>s.src)]; for(const url of urls){if(!url||url.startsWith('blob:'))continue;changed=remember({url,kind:isDash(url)?'dash':isHls(url)?'hls':isAudio(url)?'audio':'video',source:'dom',name,hasAudio:true,hasVideo:true})||changed;} } return changed; }
  function collectDeclarative(deep=false){
    let changed=false;
    const detectedTitle=pageTitle();
    const add=(url,source='metadata',name='')=>{if(typeof url!=='string')return;const raw=url.trim().replace(/\\u0026/g,'&').replace(/\\\//g,'/');let cleanUrl='';try{cleanUrl=new URL(raw,location.href).href;}catch(_){return;}if(!/^https?:\/\//i.test(cleanUrl))return;changed=remember({url:cleanUrl,source,name:name||detectedTitle})||changed;};
    for(const el of document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[name="twitter:player:stream"],link[rel="preload"][as="video"]')) add(el.content||el.href,'page-metadata');
    const attrs=['src','data-src','data-video-url','data-video-src','data-hls','data-hls-url','data-m3u8','data-mpd','data-stream-url'];
    for(const el of document.querySelectorAll('video,video source,[data-video-url],[data-video-src],[data-hls],[data-hls-url],[data-m3u8],[data-mpd],[data-stream-url]')) for(const attr of attrs) add(el.getAttribute?.(attr),'player-attribute',el.closest?.('[aria-label]')?.getAttribute('aria-label')||'');
    let visited=0;
    const walk=value=>{if(visited++>5000||value==null)return;if(typeof value==='string'){add(value,'embedded-config');return;}if(Array.isArray(value)){for(const item of value)walk(item);return;}if(typeof value==='object')for(const [k,v] of Object.entries(value)){if(/(?:url|src|file|manifest|playlist)$/i.test(k)&&typeof v==='string')add(v,'embedded-config');else if(typeof v==='object')walk(v);}};
    let budget=deep?750000:180000;
    const selector=deep?'script[type="application/ld+json"],script[type="application/json"],script#__NEXT_DATA__':'script[type="application/ld+json"]';
    for(const script of document.querySelectorAll(selector)){const text=script.textContent||'';if(!text||text.length>budget)continue;budget-=text.length;try{walk(JSON.parse(text));}catch(_){}if(budget<=0)break;}
    return changed;
  }
  function collectPerformance(){ let changed=false; try{const entries=performance.getEntriesByType('resource');for(let i=Math.max(0,entries.length-160);i<entries.length;i++){const url=entries[i]?.name||'';if(!isDash(url)&&!isHls(url)&&!isDirect(url)&&!isAudio(url))continue;changed=remember({url,source:'performance',seenAt:performance.timeOrigin+entries[i].startTime})||changed;}}catch(_){} return changed; }
  async function pullNetwork(force=false,deep=false){const now=Date.now();if(!force&&now-state.lastNetworkPull<700)return false;state.lastNetworkPull=now;let changed=false;try{const r=await chrome.runtime.sendMessage({type:'GET_MEDIA_CANDIDATES'});for(const item of r?.items||[])changed=remember(item)||changed;}catch(_){}changed=collectDom()||changed;changed=collectDeclarative(deep)||changed;changed=collectPerformance()||changed;return changed;}

  function sizeOf(i){return Math.max(i.totalLength||0,i.contentLength||0);}
  function score(i){let s=i.kind==='hls'?780:i.kind==='dash'?760:i.kind==='video'?650:450;if(i.kind==='video'&&(/video\/mp4/i.test(i.mime)||/\.mp4(?:$|[?#])/i.test(i.url)))s+=120;if(i.height)s+=Math.min(400,i.height/3);if(i.bitrate)s+=Math.min(180,Math.log10(i.bitrate+1)*22);if(sizeOf(i))s+=Math.min(120,Math.log10(sizeOf(i)+1)*16);return s;}
  function plan(){
    const all=[...state.candidates.values()];
    const videos=all.filter(i=>['video','hls','dash'].includes(i.kind)).sort((a,b)=>score(b)-score(a));
    const audios=all.filter(i=>i.kind==='audio').sort((a,b)=>score(b)-score(a));
    const bestVideo=videos[0]||null,bestAudio=audios[0]||null,title=pageTitle();
    let primary=null;
    if(bestVideo){
      const internallyHandled=bestVideo.kind==='hls'||bestVideo.kind==='dash';
      const alreadyHasAudio=bestVideo.hasAudio===true||bestVideo.isProgressive===true||bestVideo.source==='dom';
      if(!internallyHandled&&!alreadyHasAudio&&bestAudio) primary={mode:'merged',video:bestVideo,audio:bestAudio,name:title,label:'Video + Audio'};
      else primary={mode:'direct',item:bestVideo,name:title,label:alreadyHasAudio?'Video + Audio':'Video'};
    }
    const audioOnly=bestAudio?{mode:'direct',item:bestAudio,name:`${title} - Audio`,label:'Audio only'}:null;
    return {primary,audioOnly,title};
  }

  function ensureLauncher(){if(state.launcher?.isConnected)return state.launcher;const b=document.createElement('button');b.id='page-video-downloader-launcher';b.type='button';b.title='Any Video Downloader';b.setAttribute('aria-label','Open Any Video Downloader');b.textContent='⬇';b.onclick=async e=>{e.preventDefault();e.stopPropagation();openPanel();await scan(false);};document.documentElement.appendChild(b);state.launcher=b;return b;}
  function createPanel(){if(state.panel?.isConnected)return state.panel;const p=document.createElement('div');p.id='page-video-downloader-panel';p.innerHTML=`<div id="page-video-downloader-header"><span>Any Video Downloader</span><button id="page-video-downloader-close" type="button" aria-label="Close">×</button></div><div id="page-video-downloader-body"><div id="page-video-downloader-actions"><button id="page-video-downloader-all" type="button">⬇ Download All</button><button id="page-video-downloader-scan" class="secondary" type="button">↻ Scan</button></div><div id="page-video-downloader-summary">Ready.</div><div id="page-video-downloader-progress-wrap"><progress id="page-video-downloader-progress" max="100" value="0"></progress><span id="page-video-downloader-status"></span></div><div id="page-video-downloader-list"></div></div>`;document.documentElement.appendChild(p);p.querySelector('#page-video-downloader-close').onclick=closePanel;p.querySelector('#page-video-downloader-scan').onclick=()=>scan(true);p.querySelector('#page-video-downloader-all').onclick=downloadAll;state.panel=p;return p;}
  function openPanel(){const p=createPanel();p.style.display='block';state.panelOpen=true;render();}
  function closePanel(){if(state.panel)state.panel.style.display='none';state.panelOpen=false;}
  function setStatus(t){const el=document.getElementById('page-video-downloader-status');if(el)el.textContent=t;}
  function disable(v){state.panel?.querySelectorAll('button').forEach(b=>{if(b.id!=='page-video-downloader-close')b.disabled=v;});}
  function itemMeta(item,merged=false){if(merged)return `Best available video + audio • local merge`;const size=sizeOf(item);const q=item.qualityLabel||(item.height?`${item.height}p`:'');const type=item.kind==='audio'?'Audio':item.kind==='hls'?'HLS Video':item.kind==='dash'?'DASH Video':(/webm/i.test(item.mime)?'WebM Video':'MP4 Video');return `${type}${q?` • ${q}`:''}${size>=16384?` • ${(size/1048576).toFixed(1)} MB`:''}`;}

  function render(){
    if(!state.panelOpen)return;const p=createPanel(),pl=plan(),list=p.querySelector('#page-video-downloader-list'),summary=p.querySelector('#page-video-downloader-summary');list.replaceChildren();
    const opts=[pl.primary,pl.audioOnly].filter(Boolean);summary.textContent=opts.length?`${opts.length} download option${opts.length===1?'':'s'} • ${pl.title}`:`Current page: ${pl.title} • No downloadable media detected yet.`;
    if(!opts.length){const e=document.createElement('div');e.className='pvd-empty';e.textContent='Click Scan. Playback is not required when the page exposes an accessible media URL.';list.appendChild(e);return;}
    for(const option of opts){const row=document.createElement('div');row.className='pvd-item';const t=document.createElement('div');t.className='pvd-title';t.textContent=option.name;const m=document.createElement('div');m.className='pvd-meta';m.textContent=option.mode==='merged'?itemMeta(option.video,true):itemMeta(option.item,false);const b=document.createElement('button');b.type='button';b.textContent=option===pl.audioOnly?'Download Audio':option.mode==='merged'?'Download + Merge':'Download Video';b.onclick=async()=>{try{disable(true);await downloadOption(option);}catch(e){setStatus(`Download failed: ${e.message||e}`);}finally{state.currentLabel='';disable(false);}};row.append(t,m,b);list.appendChild(row);}
    if(pl.primary?.mode==='merged'){const n=document.createElement('div');n.className='pvd-empty';n.textContent='This site separates video and audio. The extension will fetch both and merge them locally into one playable file. The merge phase runs at media playback speed.';list.prepend(n);}
  }

  async function scan(deep=false){if(state.scanBusy)return;state.scanBusy=true;try{setStatus(`Scanning ${pageTitle()} without starting playback…`);await pullNetwork(true,deep);render();const pl=plan();setStatus(pl.primary?`Video detected for ${pl.title}.`:(pl.audioOnly?'Audio detected.':'No accessible pre-play media URL was exposed by this page.'));}finally{state.scanBusy=false;}}

  async function downloadOption(option){
    state.currentLabel=option.label;setStatus(`${option.label}: preparing…`);
    if(option.mode==='merged'){
      let video=option.video,audio=option.audio;
      if(/(?:^|\.)youtube\.com$/i.test(location.hostname)){
        document.dispatchEvent(new CustomEvent('avd:youtube-refresh'));
        await sleep(250);await pullNetwork(true);
        video=state.candidates.get(key(video))||video;audio=state.candidates.get(key(audio))||audio;
      }
      let r=await chrome.runtime.sendMessage({type:'DOWNLOAD_MERGED_MEDIA',video,audio,filenameBase:pageTitle(),pageUrl:location.href});
      if(!r?.ok&&/(?:HTTP\s*403|expired|unavailable|tiny)/i.test(r?.error||'')&&/(?:^|\.)youtube\.com$/i.test(location.hostname)){
        document.dispatchEvent(new CustomEvent('avd:youtube-refresh'));await sleep(500);await pullNetwork(true);
        video=state.candidates.get(key(video))||video;audio=state.candidates.get(key(audio))||audio;
        r=await chrome.runtime.sendMessage({type:'DOWNLOAD_MERGED_MEDIA',video,audio,filenameBase:pageTitle(),pageUrl:location.href});
      }
      if(!r?.ok)throw new Error(r?.error||'Local merge failed');setStatus(r.message||'Merged download complete.');return;
    }
    let i=option.item;
    if(/(?:^|\.)youtube\.com$/i.test(location.hostname)){
      document.dispatchEvent(new CustomEvent('avd:youtube-refresh'));await sleep(250);await pullNetwork(true);i=state.candidates.get(key(i))||i;
    }
    let r=await chrome.runtime.sendMessage({type:'DOWNLOAD_MEDIA',url:i.url,kind:i.kind,mime:i.mime,filenameBase:pageTitle(),pageUrl:location.href});
    if(!r?.ok&&/(?:HTTP\s*403|expired|unavailable|tiny)/i.test(r?.error||'')&&/(?:^|\.)youtube\.com$/i.test(location.hostname)){
      document.dispatchEvent(new CustomEvent('avd:youtube-refresh'));await sleep(500);await pullNetwork(true);i=state.candidates.get(key(i))||i;
      r=await chrome.runtime.sendMessage({type:'DOWNLOAD_MEDIA',url:i.url,kind:i.kind,mime:i.mime,filenameBase:pageTitle(),pageUrl:location.href});
    }
    if(!r?.ok){
      if(/(?:^|\.)youtube\.com$/i.test(location.hostname)&&/googlevideo\.com/i.test(i.url||''))throw new Error('YouTube did not expose a fresh downloadable stream URL. Reload the video page and scan again; real-time page recording was not started.');
      if(i.kind==='hls'&&/(?:decode|recorder|capture|convert|transport stream|MediaRecorder)/i.test(r?.error||'')){
        if(Number(i.frameId)>0){const fallback=await chrome.runtime.sendMessage({type:'CAPTURE_FRAME_VIDEO',frameId:Number(i.frameId),label:'HLS video',filenameBase:pageTitle()});if(!fallback?.ok)throw new Error(`${r.error||'HLS conversion failed'} Embedded-player fallback failed: ${fallback?.error||'frame unavailable'}`);setStatus(`Capturing ${pageTitle()} from its embedded player…`);}else{document.dispatchEvent(new CustomEvent('avd:capture-request',{detail:{label:'HLS video',filenameBase:pageTitle()}}));setStatus('Using the already-decoded page video fallback…');}
        return;
      }
      throw new Error(r?.error||'Download failed');
    }
    setStatus(r.message||'Download started.');
  }
  async function downloadAll(){if(state.downloading)return;state.downloading=true;disable(true);try{await scan(true);const pl=plan();if(!pl.primary&&!pl.audioOnly)throw new Error('No downloadable media detected.');if(pl.primary)await downloadOption(pl.primary);if(pl.audioOnly&&pl.primary?.mode!=='merged'){await sleep(250);await downloadOption(pl.audioOnly);}}catch(e){setStatus(`Download failed: ${e.message||e}`);}finally{state.downloading=false;state.currentLabel='';disable(false);}}

  chrome.runtime.onMessage.addListener(msg=>{if(msg?.type!=='DOWNLOAD_PROGRESS')return;const wrap=document.getElementById('page-video-downloader-progress-wrap'),bar=document.getElementById('page-video-downloader-progress'),status=document.getElementById('page-video-downloader-status');if(!wrap||!bar||!status)return;wrap.style.display='block';bar.value=Math.max(0,Math.min(100,Number(msg.percent)||0));status.textContent=`${state.currentLabel?state.currentLabel+': ':''}${msg.text||Math.round(bar.value)+'%'}`;});

  async function resetPage(){state.epoch=Date.now();state.candidates.clear();state.lastNetworkPull=0;try{await chrome.runtime.sendMessage({type:'PAGE_MEDIA_CONTEXT',title:pageTitle(),url:location.href});}catch(_){}if(state.panelOpen){render();setStatus(`Page/video changed — waiting for ${pageTitle()}…`);}await sleep(350);await pullNetwork(true);if(state.panelOpen)render();}
  function checkPage(){const sig=signature();if(!state.pageSignature){state.pageSignature=sig;return;}if(sig===state.pageSignature)return;state.pageSignature=sig;clearTimeout(state.changeTimer);state.changeTimer=setTimeout(resetPage,300);}
  function schedule(delay=450){clearTimeout(state.changeTimer);state.changeTimer=setTimeout(()=>{checkPage();collectDom();},delay);}
  const relevant='video,source,[aria-current],[aria-selected],[data-active],[data-selected],[data-video-url],[data-hls-url],[data-m3u8],[data-mpd]';
  const observer=new MutationObserver(ms=>{if(ms.some(m=>m.type==='attributes'||(m.type==='childList'&&(m.target?.matches?.(relevant)||[...m.addedNodes].some(n=>n.nodeType===1&&(n.matches?.(relevant)||n.querySelector?.(relevant)))))))schedule(300);});
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','aria-current','aria-selected','data-active','data-selected','data-video-url','data-hls-url','data-m3u8','data-mpd']});
  document.addEventListener('click',e=>{if(e.target.closest?.('a,[role="link"],[role="option"],[role="radio"],[aria-current],[data-lesson-id],[data-lesson],[class*="lesson"]'))schedule(250);},true);addEventListener('popstate',()=>schedule(100));addEventListener('hashchange',()=>schedule(100));
  document.addEventListener('loadedmetadata',()=>schedule(50),true);
  const init=()=>{ensureLauncher();collectDom();collectDeclarative(false);state.pageSignature=signature();};if('requestIdleCallback'in window)requestIdleCallback(init,{timeout:1000});else setTimeout(init,300);
})();

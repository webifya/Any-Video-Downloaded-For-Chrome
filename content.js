(() => {
  if (window.top !== window.self) return;
  if (/^(chrome|edge|about|moz-extension|chrome-extension):/i.test(location.protocol)) return;

  const state = { candidates:new Map(), launcher:null, panel:null, panelOpen:false, downloadingAll:false, currentLabel:'', scanBusy:false, lastNetworkPull:0, pageSignature:'', changeTimer:0, suppressChangeUntil:0 };
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const sanitize = v => String(v||'').replace(/[\\/:*?"<>|]+/g,'-').replace(/\s+/g,' ').trim().slice(0,170);
  const clean = v => sanitize(v)||'Video';
  const isHls = u => /\.m3u8(?:$|[?#])/i.test(u||'') || /m3u8|playlist|manifest/i.test(u||'');
  const isDash = u => /\.mpd(?:$|[?#])/i.test(u||'');
  const isDirect = u => /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i.test(u||'');
  const isAudio = u => /\.(?:m4a|aac|mp3|opus|ogg)(?:$|[?#])/i.test(u||'');

  function visible(el){ if(!el?.isConnected)return false; const s=getComputedStyle(el); if(s.display==='none'||s.visibility==='hidden')return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0; }
  function texts(sel){ return [...document.querySelectorAll(sel)].filter(visible).map(el=>sanitize(el.textContent)).filter(t=>t&&t.length>=2&&t.length<=180); }

  function lessonTitle(){
    const selectors=['[aria-current="page"]','[aria-current="true"]','[data-active="true"]','[data-selected="true"]','.active','.selected','[class*="lesson"][class*="active"]','[class*="lesson"][class*="selected"]'];
    for(const sel of selectors){ for(const el of document.querySelectorAll(sel)){ if(!visible(el))continue; const t=sanitize(el.textContent); if(t&&t.length<=180&&!/^(home|courses?|lessons?|categories?|next|previous)$/i.test(t)) return t; } }
    const hs=texts('main h1,[role="main"] h1,article h1,h1,main h2,[role="main"] h2');
    const h=hs.find(t=>!/^(lessons?|courses?|dashboard|instructor|about this lesson)$/i.test(t)); if(h)return h;
    const crumbs=texts('[aria-label*="breadcrumb" i] a,[aria-label*="breadcrumb" i] span,.breadcrumb a,.breadcrumb span,[class*="breadcrumb"] a,[class*="breadcrumb"] span');
    if(crumbs.length)return crumbs[crumbs.length-1];
    return sanitize(document.title.replace(/\s*[|–—-]\s*[^|–—-]+$/,''))||sanitize(location.hostname)||'Video';
  }

  function nearbyTitle(video,index){
    const labelled=sanitize(video.getAttribute('aria-label')||video.getAttribute('title')); if(labelled)return labelled;
    const c=video.closest('article,section,figure,[class*="video"],[class*="player"]');
    return sanitize(c?.querySelector('h1,h2,h3,h4,h5,h6,[class*="title"]')?.textContent)||lessonTitle()||`Video ${index+1}`;
  }

  function signature(){ const v=document.querySelector('video'); const src=v?.currentSrc||v?.src||v?.querySelector('source')?.src||''; return `${location.href}|${lessonTitle().toLowerCase()}|${src.startsWith('blob:')?'blob':src}`; }

  function normalizeCandidate(item){
    const url=item?.url||''; if(!url||url.startsWith('blob:')||url.startsWith('data:'))return null;
    let kind=item.kind||''; if(!kind){ if(isDash(url))kind='dash'; else if(isHls(url))kind='hls'; else if(isDirect(url))kind='video'; else if(isAudio(url))kind='audio'; }
    if(!kind)return null;
    return {url,kind,mime:item.mime||'',contentLength:Number(item.contentLength||0),source:item.source||'page',name:sanitize(item.name)};
  }
  function remember(item){ const c=normalizeCandidate(item); if(!c)return false; const prev=state.candidates.get(c.url)||{}; state.candidates.set(c.url,{...prev,...c,name:c.name||prev.name||''}); return !prev.url; }

  function collectDom(){ let changed=false; const vs=[...document.querySelectorAll('video')]; vs.forEach((v,i)=>{ const name=nearbyTitle(v,i); const urls=[v.currentSrc,v.src,...[...v.querySelectorAll('source')].map(s=>s.src)]; for(const url of urls){ if(!url||url.startsWith('blob:'))continue; changed=remember({url,kind:isDash(url)?'dash':isHls(url)?'hls':isAudio(url)?'audio':'video',source:'dom',name})||changed; } }); return changed; }
  function collectPerformance(){ let changed=false; try{ const entries=performance.getEntriesByType('resource'); const start=Math.max(0,entries.length-220); for(let i=start;i<entries.length;i++){ const url=entries[i]?.name||''; if(!isDash(url)&&!isHls(url)&&!isDirect(url)&&!isAudio(url))continue; changed=remember({url,source:'performance'})||changed; } }catch(_){} return changed; }
  async function pullNetwork(force=false){ const now=Date.now(); if(!force&&now-state.lastNetworkPull<900)return false; state.lastNetworkPull=now; let changed=false; try{ const r=await chrome.runtime.sendMessage({type:'GET_MEDIA_CANDIDATES'}); for(const item of r?.items||[]) changed=remember(item)||changed; }catch(_){} changed=collectDom()||changed; changed=collectPerformance()||changed; return changed; }

  function stem(item){ try{ const u=new URL(item.url); let p=u.pathname.toLowerCase(); p=p.replace(/\/(?:\d{3,4}p|\d+x\d+|quality[-_]?\d+)(?=\/|$)/g,'/'); p=p.replace(/(?:master|index|playlist|chunklist|media)[-_]?[a-z0-9.-]*\.m3u8$/i,'playlist.m3u8'); return `${u.origin}${p}`; }catch(_){return item.url;} }
  function deduped(){
    const items=[...state.candidates.values()];
    const manifests=items.filter(x=>x.kind==='dash'||x.kind==='hls');
    const grouped=new Map(); for(const item of manifests){ const k=stem(item); const g=grouped.get(k)||[]; g.push(item); grouped.set(k,g); }
    const selected=[...grouped.values()].map(g=>g.find(x=>x.kind==='dash')||g.find(x=>/master|playlist/i.test(x.url))||g[0]);
    const direct=[]; const seen=new Set();
    for(const item of items.filter(x=>x.kind==='video'||x.kind==='audio')){ const k=item.url.split('#')[0]; if(seen.has(k))continue; seen.add(k); direct.push(item); }
    let all=[...selected,...direct];
    // Prefer a manifest over dozens of its segment requests.
    if(selected.length) all=all.filter(x=>x.kind==='dash'||x.kind==='hls'||!/[?&](?:range|rn|rbuf|sq)=|\.m4s(?:$|[?#])/i.test(x.url));
    all.sort((a,b)=>{ const rank={dash:4,hls:3,video:2,audio:1}; return (rank[b.kind]-rank[a.kind])||((b.contentLength||0)-(a.contentLength||0)); });
    const current=lessonTitle();
    return all.map((item,i)=>({...item,name:clean(item.name||(all.length===1?current:`${current} - ${item.kind==='audio'?'Audio':item.kind==='dash'?'DASH':`Video ${i+1}`}`))}));
  }

  function ensureLauncher(){ if(state.launcher?.isConnected)return state.launcher; const b=document.createElement('button'); b.id='page-video-downloader-launcher'; b.type='button'; b.title='Any Video Downloader'; b.setAttribute('aria-label','Open Any Video Downloader'); b.textContent='⬇'; b.addEventListener('click',async e=>{e.preventDefault();e.stopPropagation();openPanel();await scan(false);}); document.documentElement.appendChild(b); state.launcher=b; return b; }
  function createPanel(){ if(state.panel?.isConnected)return state.panel; const p=document.createElement('div'); p.id='page-video-downloader-panel'; p.innerHTML=`<div id="page-video-downloader-header"><span>Any Video Downloader</span><button id="page-video-downloader-close" type="button">×</button></div><div id="page-video-downloader-body"><div id="page-video-downloader-actions"><button id="page-video-downloader-all" type="button">⬇ Download All</button><button id="page-video-downloader-scan" class="secondary" type="button">↻ Scan</button></div><div id="page-video-downloader-summary">Ready to scan.</div><div id="page-video-downloader-progress-wrap"><progress id="page-video-downloader-progress" max="100" value="0"></progress><span id="page-video-downloader-status"></span></div><div id="page-video-downloader-list"></div></div>`; document.documentElement.appendChild(p); p.querySelector('#page-video-downloader-close').onclick=closePanel; p.querySelector('#page-video-downloader-scan').onclick=()=>scan(true); p.querySelector('#page-video-downloader-all').onclick=downloadAll; state.panel=p; return p; }
  function openPanel(){ const p=createPanel(); p.style.display='block'; state.panelOpen=true; render(); }
  function closePanel(){ if(state.panel)state.panel.style.display='none'; state.panelOpen=false; }
  function setStatus(t){ const s=document.getElementById('page-video-downloader-status'); if(s)s.textContent=t; }

  function render(){ if(!state.panelOpen)return; const p=createPanel(), items=deduped(), summary=p.querySelector('#page-video-downloader-summary'), list=p.querySelector('#page-video-downloader-list'); const current=lessonTitle(); summary.textContent=items.length?`${items.length} media option${items.length===1?'':'s'} detected • ${current}`:`Current page: ${current} • No downloadable media detected yet.`; list.replaceChildren(); if(!items.length){ const e=document.createElement('div'); e.className='pvd-empty'; e.textContent='Play the current video or click Scan.'; list.appendChild(e); return; }
    const hasAdaptive=items.some(x=>x.kind==='dash') || (items.some(x=>x.kind==='video')&&items.some(x=>x.kind==='audio'));
    if(hasAdaptive){ const n=document.createElement('div'); n.className='pvd-empty'; n.textContent='Adaptive stream detected. DASH may save video and audio as separate files when the site provides separate tracks.'; list.appendChild(n); }
    items.forEach((item,index)=>{ const row=document.createElement('div'); row.className='pvd-item'; const title=document.createElement('div'); title.className='pvd-title'; title.textContent=item.name; const meta=document.createElement('div'); meta.className='pvd-meta'; const label=item.kind==='dash'?'DASH / MPD':item.kind==='hls'?'HLS':item.kind==='audio'?'Audio stream':(item.mime||'Video'); meta.textContent=`${label}${item.contentLength?` • ${(item.contentLength/1048576).toFixed(1)} MB`:''}`; const b=document.createElement('button'); b.type='button'; b.textContent='Download'; b.onclick=async()=>{try{disable(true);await downloadItem(item,index,items.length);}catch(e){setStatus(`Download failed: ${e.message||e}`);}finally{state.currentLabel='';disable(false);}}; row.append(title,meta,b); list.appendChild(row); }); }

  async function trigger(){ const vs=[...document.querySelectorAll('video')].filter(v=>{const r=v.getBoundingClientRect();return r.width>60&&r.height>40;}); for(const v of vs.slice(0,8)){ const paused=v.paused, muted=v.muted, vol=v.volume; try{v.muted=true;v.volume=0;if(v.paused)await v.play();}catch(_){} await sleep(600); try{if(paused)v.pause();v.muted=muted;v.volume=vol;}catch(_){} } }
  async function scan(deep=false){ if(state.scanBusy)return deduped().length; state.scanBusy=true; try{ setStatus(deep?`Scanning ${lessonTitle()} and triggering the player…`:`Scanning ${lessonTitle()}…`); await pullNetwork(true); if(deep){await trigger();await sleep(350);await pullNetwork(true);} render(); const n=deduped().length; setStatus(n?`${n} media option${n===1?'':'s'} detected for ${lessonTitle()}.`:`No downloadable media detected for ${lessonTitle()} yet.`); return n; }finally{state.scanBusy=false;} }

  async function downloadItem(item,index,total){ const current=lessonTitle(); const filenameBase=total===1?current:(item.name||`${current} - ${item.kind==='audio'?'Audio':`Video ${index+1}`}`); state.currentLabel=total>1?`${index+1}/${total}`:current; setStatus(`${state.currentLabel}: preparing ${filenameBase}…`); const r=await chrome.runtime.sendMessage({type:'DOWNLOAD_MEDIA',url:item.url,kind:item.kind,mime:item.mime,filenameBase}); if(!r?.ok)throw new Error(r?.error||'Download failed'); if(r.separateTracks)setStatus(`${current}: DASH video/audio saved separately.`); else if(item.kind!=='hls'&&item.kind!=='dash')setStatus(`${state.currentLabel}: ${r.message||'Download started.'}`); }
  async function downloadAll(){ if(state.downloadingAll)return; state.downloadingAll=true; disable(true); try{await scan(true); const items=deduped().filter(x=>x.kind!=='audio' || !deduped().some(y=>y.kind==='dash')); if(!items.length)throw new Error('No downloadable media detected.'); for(let i=0;i<items.length;i++){try{await downloadItem(items[i],i,items.length);}catch(e){setStatus(`Item ${i+1}/${items.length} failed: ${e.message||e}. Continuing…`);} await sleep(220);} setStatus(`Finished processing ${items.length} item${items.length===1?'':'s'}.`);}catch(e){setStatus(`Download failed: ${e.message||e}`);}finally{state.downloadingAll=false;state.currentLabel='';disable(false);} }
  function disable(v){ state.panel?.querySelectorAll('button').forEach(b=>{if(b.id!=='page-video-downloader-close')b.disabled=v;}); }

  chrome.runtime.onMessage.addListener(msg=>{ if(msg?.type!=='DOWNLOAD_PROGRESS')return; const w=document.getElementById('page-video-downloader-progress-wrap'),b=document.getElementById('page-video-downloader-progress'),s=document.getElementById('page-video-downloader-status'); if(!w||!b||!s)return; w.style.display='block'; b.value=Math.max(0,Math.min(100,Number(msg.percent)||0)); s.textContent=`${state.currentLabel?state.currentLabel+': ':''}${msg.text||Math.round(b.value)+'%'}`; });

  async function resetForPageChange(){ if(Date.now()<state.suppressChangeUntil)return; state.suppressChangeUntil=Date.now()+800; state.candidates.clear(); try{await chrome.runtime.sendMessage({type:'CLEAR_MEDIA_CANDIDATES'});}catch(_){} state.lastNetworkPull=0; if(state.panelOpen){render();setStatus(`Lesson/page changed — waiting for ${lessonTitle()}…`);} await sleep(700); await pullNetwork(true); if(state.panelOpen)render(); }
  function checkChange(){ const sig=signature(); if(!state.pageSignature){state.pageSignature=sig;return;} if(sig===state.pageSignature)return; state.pageSignature=sig; clearTimeout(state.changeTimer); state.changeTimer=setTimeout(resetForPageChange,220); }
  const observer=new MutationObserver(m=>{ let relevant=false; for(const x of m){ if(x.type==='childList'&&x.addedNodes.length){relevant=true;break;} if(x.type==='attributes'){relevant=true;break;} } if(!relevant)return; clearTimeout(state.changeTimer); state.changeTimer=setTimeout(()=>{checkChange();if(document.querySelector('video'))collectDom();},350); });
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','class','aria-current','data-active','data-selected']});

  const init=()=>{ensureLauncher();collectDom();state.pageSignature=signature();};
  if('requestIdleCallback'in window)requestIdleCallback(init,{timeout:1200}); else setTimeout(init,400);
  setInterval(checkChange,1200);
})();

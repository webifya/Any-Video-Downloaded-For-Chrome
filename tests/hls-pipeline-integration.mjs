import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let runtimeListener,savedBlob,savedName='';
const fixture=fs.readFileSync(new URL('./fixtures/mpegts-h264-aac.bin',import.meta.url));
const manifest='#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST\n';
const mockFetch=async url=>String(url).endsWith('.m3u8')?new Response(manifest,{headers:{'content-type':'application/vnd.apple.mpegurl'}}):new Response(fixture,{headers:{'content-type':'video/mp2t'}});

class FakeElement{
  constructor(tag='a'){this.tag=tag;this.style={};this.events=new Map();this.readyState=1;this.duration=1;this.currentTime=0;this.volume=1;this.muted=false;}
  click(){savedName=this.download||'';}remove(){}pause(){}
  addEventListener(name,fn){const list=this.events.get(name)||[];list.push(fn);this.events.set(name,list);}
  removeEventListener(name,fn){this.events.set(name,(this.events.get(name)||[]).filter(x=>x!==fn));}
  emit(name){for(const fn of this.events.get(name)||[])fn();}
  async play(){setTimeout(()=>{this.currentTime=this.duration;this.emit('ended');},10);}
  captureStream(){return{getVideoTracks:()=>[{}],getAudioTracks:()=>[{}]};}
}
class FakeMediaRecorder{
  static isTypeSupported(type){return /^video\/mp4/.test(type);}
  constructor(stream,options={}){this.stream=stream;this.mimeType=options.mimeType||'video/mp4';this.state='inactive';}
  start(){this.state='recording';}
  stop(){this.state='inactive';this.ondataavailable?.({data:new Blob([new Uint8Array(40000).fill(7)],{type:this.mimeType})});this.onstop?.();}
}
class FakeMediaStream{constructor(tracks){this.tracks=tracks;}}
class TestURL extends URL{}
TestURL.createObjectURL=blob=>{savedBlob=blob;return'blob:test';};
TestURL.revokeObjectURL=()=>{};
const chrome={runtime:{onMessage:{addListener(fn){runtimeListener=fn;}},sendMessage:async()=>({ok:true})}};
const context=vm.createContext({chrome,fetch:mockFetch,Response,Headers,Request,Blob,URL:TestURL,MediaRecorder:FakeMediaRecorder,MediaStream:FakeMediaStream,console,setTimeout,clearTimeout,setInterval,clearInterval,Promise,Math,Date,JSON,Number,String,Boolean,Array,Object,Set,Map,RegExp,Error,TypeError,Uint8Array,ArrayBuffer,DataView,Infinity,NaN,globalThis:null,document:{body:{appendChild(){}},createElement(tag){return new FakeElement(tag);}},DOMParser:class{}});
context.globalThis=context;context.window=context;context.self=context;
vm.runInContext(fs.readFileSync(new URL('../vendor/mux-mp4.min.js',import.meta.url),'utf8'),context,{filename:'mux-mp4.min.js'});
vm.runInContext(fs.readFileSync(new URL('../offscreen-v2.js',import.meta.url),'utf8'),context,{filename:'offscreen-v2.js'});

const result=await new Promise((resolve,reject)=>{try{const keepAlive=runtimeListener({target:'offscreen',type:'DOWNLOAD_HLS',url:'https://cdn.test/lesson.m3u8',filenameBase:'Lesson 13',tabId:1},{},resolve);assert.equal(keepAlive,true);}catch(error){reject(error);}});
assert.equal(result.ok,true,result.error||'HLS pipeline should complete');
assert.equal(savedName,'Lesson 13.mp4','type-routed MPEG-TS pipeline must save MP4 with the lesson title');
assert.match(savedBlob?.type||'',/^video\/mp4/,'saved HLS output must be a genuine MP4 Blob');
assert.ok(savedBlob.size>=40000,'final desktop file must come from the recorder finalization stage, not the raw streaming fragment');

console.log('end-to-end MPEG-TS HLS routing, desktop finalization, and MP4 save test passed');
process.exit(0);

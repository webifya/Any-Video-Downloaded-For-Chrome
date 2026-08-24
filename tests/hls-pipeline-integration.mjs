import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let runtimeListener,savedBlob,savedName='';
const fixture=fs.readFileSync(new URL('./fixtures/mpegts-h264-aac.bin',import.meta.url));
const manifest='#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST\n';
const mockFetch=async url=>String(url).endsWith('.m3u8')?new Response(manifest,{headers:{'content-type':'application/vnd.apple.mpegurl'}}):new Response(fixture,{headers:{'content-type':'video/mp2t'}});

class FakeElement{constructor(){this.style={};}click(){savedName=this.download||'';}remove(){}addEventListener(){}removeEventListener(){}pause(){}}
class TestURL extends URL{}
TestURL.createObjectURL=blob=>{savedBlob=blob;return'blob:test';};
TestURL.revokeObjectURL=()=>{};
const chrome={runtime:{onMessage:{addListener(fn){runtimeListener=fn;}},sendMessage:async()=>({ok:true})}};
const context=vm.createContext({chrome,fetch:mockFetch,Response,Headers,Request,Blob,URL:TestURL,console,setTimeout,clearTimeout,setInterval,clearInterval,Promise,Math,Date,JSON,Number,String,Boolean,Array,Object,Set,Map,RegExp,Error,TypeError,Uint8Array,ArrayBuffer,DataView,Infinity,NaN,globalThis:null,document:{body:{appendChild(){}},createElement(){return new FakeElement();}},DOMParser:class{}});
context.globalThis=context;context.window=context;context.self=context;
vm.runInContext(fs.readFileSync(new URL('../vendor/mux-mp4.min.js',import.meta.url),'utf8'),context,{filename:'mux-mp4.min.js'});
vm.runInContext(fs.readFileSync(new URL('../offscreen-v2.js',import.meta.url),'utf8'),context,{filename:'offscreen-v2.js'});

const result=await new Promise((resolve,reject)=>{try{const keepAlive=runtimeListener({target:'offscreen',type:'DOWNLOAD_HLS',url:'https://cdn.test/lesson.m3u8',filenameBase:'Lesson 13',tabId:1},{},resolve);assert.equal(keepAlive,true);}catch(error){reject(error);}});
assert.equal(result.ok,true,result.error||'HLS pipeline should complete');
assert.equal(savedName,'Lesson 13.mp4','type-routed MPEG-TS pipeline must save MP4 with the lesson title');
assert.equal(savedBlob?.type,'video/mp4','saved HLS output must be a genuine MP4 Blob');
const output=Buffer.from(await savedBlob.arrayBuffer());
for(const box of ['ftyp','moov','moof','mdat'])assert.ok(output.includes(Buffer.from(box)),`saved pipeline output must contain ${box}`);

console.log('end-to-end MPEG-TS HLS routing and MP4 save test passed');
process.exit(0);

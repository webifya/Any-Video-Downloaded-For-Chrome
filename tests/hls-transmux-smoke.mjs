import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const context=vm.createContext({console,Uint8Array,ArrayBuffer,DataView,Math,Date,JSON,Object,Array,Number,String,Boolean,RegExp,Error,TypeError,Infinity,NaN,setTimeout,clearTimeout});
context.window=context;
context.self=context;
vm.runInContext(fs.readFileSync(new URL('../vendor/mux-mp4.min.js',import.meta.url),'utf8'),context,{filename:'mux-mp4.min.js'});

assert.equal(typeof context.muxjs?.Transmuxer,'function','vendored MPEG-TS transmuxer must load without network access');
const run=input=>{const transmuxer=new context.muxjs.Transmuxer({remux:true,keepOriginalTimestamps:false}),segments=[];transmuxer.on('data',segment=>segments.push(segment));transmuxer.push(input);transmuxer.flush();return segments;};
const input=new Uint8Array(fs.readFileSync(new URL('./fixtures/mpegts-h264-aac.bin',import.meta.url)));
const segments=run(input);

assert.ok(segments.length>0,'real H.264/AAC MPEG-TS fixture must produce fMP4 output');
const output=Buffer.concat(segments.flatMap((segment,index)=>[...(index===0?[Buffer.from(segment.initSegment)]:[]),Buffer.from(segment.data)]));
for(const box of ['ftyp','moov','moof','mdat'])assert.ok(output.includes(Buffer.from(box)),`transmuxed MP4 must contain ${box}`);
assert.ok(output.length>32768,'transmuxed MP4 fixture must contain substantive media');

const aac=run(new Uint8Array(fs.readFileSync(new URL('./fixtures/aac-adts.bin',import.meta.url))));
assert.ok(aac.length>0&&aac.every(segment=>segment.type==='audio'),'standalone ADTS HLS audio must transmux into an audio-only fMP4 track');
const audioOutput=Buffer.concat(aac.flatMap((segment,index)=>[...(index===0?[Buffer.from(segment.initSegment)]:[]),Buffer.from(segment.data)]));
for(const box of ['ftyp','moov','moof','mdat'])assert.ok(audioOutput.includes(Buffer.from(box)),`transmuxed audio MP4 must contain ${box}`);

console.log('MPEG-TS video and standalone ADTS audio to fragmented MP4 fixture tests passed');

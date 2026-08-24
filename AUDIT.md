# Any Video Downloader v2.4.0 Technical Audit

## Scope

The extension was reviewed for direct/self-hosted media, GoHighLevel/course platforms, SPA navigation, embedded/custom players, signed CDN delivery, HLS, DASH, YouTube adaptive delivery, Facebook/Instagram byte ranges, Vimeo CDN delivery, and the major limitation where video and audio are delivered as separate tracks.

## Architecture after v2.4.0

1. `service-worker.js` observes likely media requests, canonicalizes byte-range variants, preserves quality/track metadata, and keeps a bounded per-tab candidate cache.
2. `content.js` derives the current page/lesson title, selects one primary video action, pairs a separate audio track when needed, and resets state on SPA/video changes.
3. `youtube-probe.js` reads accessible YouTube `streamingData` in the page world and marks progressive/adaptive, audio/video, quality and bitrate metadata.
4. `youtube-listener.js` bridges those candidates to the extension service worker.
5. `offscreen.js` handles signed direct fetches, unencrypted HLS/DASH assembly, and the local adaptive audio/video merge engine.
6. The local merge engine converts fetched cross-origin tracks to extension-local Blob URLs, decodes them in hidden media elements, synchronizes them, combines the tracks into a `MediaStream`, and records one output file with `MediaRecorder`.

## Issues fixed

### Duplicate range requests
Facebook, Instagram, YouTube, Vimeo and other CDNs often request many byte ranges for one logical stream. Range-specific parameters are canonicalized and repeated requests are collapsed into one logical candidate.

### Misleading 0 KB/tiny sizes
The service worker records total size from `Content-Range` when present and keeps useful earlier metadata when later requests contain zero or partial values.

### Stale SPA/course media
Course sites can switch lessons without reloading the document. The content layer detects meaningful URL/title/player changes, clears the old candidate set and rescans the new lesson.

### Signed CDN download failures
Known range parameters are removed before extension-local fetches. The original signed URL is retained and retried when the cleaned URL is rejected.

### Separate adaptive video/audio
This was the largest architectural limitation before v2.4.0. When the selected video lacks audio and a separate audio track is available, the UI now offers a single primary `Download + Merge` operation. Both tracks are fetched and merged locally.

### Cross-origin capture restriction
Chrome blocks direct `captureStream()` on cross-origin media. v2.4.0 does not capture the remote element. It first fetches authorized media through the extension and creates extension-origin Blob URLs, then performs local decoding/capture from those Blob URLs.

### Output container selection
The merge engine checks `MediaRecorder.isTypeSupported()`. It prefers MP4 recording when the installed Chrome build supports it and otherwise uses WebM. This avoids simply renaming incompatible bytes to `.mp4`.

### HLS separate audio
Master playlists and `EXT-X-MEDIA:TYPE=AUDIO` are parsed. When separate tracks are decodable locally, the extension attempts a single merged output; if Chrome cannot decode the source container, valid source tracks are preserved as fallback files.

### DASH separate audio/video
`SegmentTemplate`, `SegmentTimeline`, `SegmentList` and direct `BaseURL` representations are supported. The best video/audio representations are assembled, then the local merge engine attempts one playable output.

### Performance
There is no recurring full-page media scan loop. Heavy media scanning is user initiated; DOM navigation checks are debounced and network caches are bounded.

## Expected compatibility classes

- **Strong:** ordinary HTML5/self-hosted MP4/WebM; accessible direct media.
- **Strong/best effort:** GHL and similar course platforms using accessible direct media or unencrypted HLS.
- **Best effort with local merge:** YouTube, Facebook/Instagram, Vimeo and similar adaptive platforms when the browser exposes usable signed video/audio URLs.
- **Best effort:** X/Twitter, Reddit, Dailymotion, Twitch, TikTok, Loom, Streamable, Wistia, Brightcove, Bunny, Mux, Cloudflare Stream, JW Player and Video.js sites when accessible direct/HLS/DASH requests are exposed.
- **Unsupported by design:** DRM-protected playback or media that requires bypassing paywalls, authentication, subscription controls, or encryption/access controls.

## Remaining technical boundaries

### DRM/access controls
Widevine, PlayReady, FairPlay and equivalent DRM/access-control systems are intentionally not bypassed.

### Codec support
The local merger depends on codecs the installed Chrome build can decode and record. When a pair is not supported, the extension saves the valid source tracks separately instead of generating a corrupt output.

### Merge speed
The built-in local merge path uses native decode/capture/record and therefore runs near playback speed. This removes the silent-video limitation without shipping a large FFmpeg/WASM runtime or using a remote conversion server.

### Very large files
Large tracks are still held as local Blob/byte data during processing. Multi-gigabyte media can be constrained by browser memory. A future disk-backed OPFS/IndexedDB processing queue could reduce peak memory use.

### HLS MPEG-TS
Native HLS sources can use MPEG-TS. When Chrome cannot directly decode an assembled TS Blob through the local merge engine, the source media is retained rather than falsely claiming a successful MP4 conversion. A dedicated TS transmuxer would be required for guaranteed zero-reencode TS→MP4 conversion.

### Platform changes
Large platforms change stream signatures, codecs and player behavior regularly. Signed URLs can also expire; replaying the media and rescanning refreshes the candidate set.

## Validation

The repository includes GitHub Actions validation for JavaScript syntax, Manifest V3 JSON and service-worker smoke tests. The smoke suite covers adaptive-pair routing, YouTube track metadata preservation and Meta/Facebook range deduplication.

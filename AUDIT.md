# Any Video Downloader v2.4.1 Technical Audit

## Scope

The extension was reviewed for self-hosted media, GoHighLevel/course platforms, SPA navigation, embedded/custom players, signed CDN delivery, HLS, DASH, YouTube adaptive delivery, Facebook/Instagram byte ranges, Vimeo CDN delivery, and separate video/audio adaptive streams.

## Architecture

1. `service-worker.js` observes likely media requests, canonicalizes byte-range variants, preserves track/quality metadata, and keeps a bounded per-tab cache.
2. `content.js` determines the current page/lesson title, chooses one primary video action, pairs separate audio when required, and resets state on SPA/video changes.
3. `youtube-probe.js` reads accessible YouTube `streamingData` and reports progressive/adaptive, audio/video, resolution and bitrate metadata.
4. `youtube-listener.js` bridges those candidates to the extension service worker.
5. `offscreen.js` fetches signed direct media, assembles unencrypted HLS/DASH, and runs the local adaptive audio/video merge engine.
6. `format-guard.js` prevents MPEG-TS bytes from being mislabeled with an MP4 extension.
7. The offscreen document no longer contains the obsolete GHL sandbox iframe.

## Major fixes

### Duplicate and tiny range requests
Facebook, Instagram, YouTube, Vimeo and other CDNs frequently request many byte ranges for one logical stream. Range-specific parameters are canonicalized and repeated requests are collapsed. `Content-Range` total size is preferred over misleading chunk sizes.

### SPA/course lesson changes
The current page/lesson/video signature is monitored with debounced navigation and DOM events. Old candidates are cleared before the new lesson is scanned, preventing the previous video from being downloaded after a JavaScript-only lesson change.

### Signed CDN failures
Known range parameters are removed before extension-local fetch. The original signed URL is kept and retried if the cleaned URL is rejected.

### Separate video and audio
When a complete progressive file already includes audio, it can be downloaded directly. When the best video is video-only and a separate audio track exists, the UI creates one `Download + Merge` action.

The merger fetches both accessible tracks, creates extension-local Blob URLs, decodes them in the offscreen document, synchronizes playback, combines their media tracks and records one output using Chrome's native `MediaRecorder`. MP4 is preferred when supported by the installed Chrome build; otherwise WebM is used.

If Chrome cannot decode or record a particular codec/container pair, the successfully fetched source tracks are saved separately rather than generating a corrupt file.

### HLS
The HLS engine parses master variants and `EXT-X-MEDIA:TYPE=AUDIO`. Separate HLS tracks are merged locally when Chrome can decode them. MPEG-TS fallback data is saved as `.ts`, not falsely renamed `.mp4`.

### DASH
DASH handling supports `SegmentTemplate`, `SegmentTimeline`, `SegmentList`, and direct `BaseURL` representations. The best accessible video/audio tracks are assembled and sent through the local merge path. MPDs containing `ContentProtection` are rejected rather than bypassed.

### Performance
There is no recurring full-page media scan loop. Heavy scanning is user initiated, DOM checks are debounced, Performance API inspection is bounded, and the network candidate cache is capped.

## Expected compatibility

- **Strong:** ordinary HTML5/self-hosted MP4/WebM and accessible direct media.
- **Strong/best effort:** GHL and similar course platforms using accessible direct media or unencrypted HLS.
- **Best effort with local merge:** YouTube, Facebook/Instagram, Vimeo and similar adaptive platforms when usable signed video/audio URLs are exposed to the browser.
- **Best effort:** X/Twitter, Reddit, Dailymotion, Twitch, TikTok, Loom, Streamable, Wistia, Brightcove, Bunny, Mux, Cloudflare Stream, JW Player and Video.js sites using accessible direct/HLS/DASH delivery.
- **Unsupported by design:** DRM-protected/encrypted playback or media requiring bypass of paywalls, authentication, subscription controls or security/access controls.

## Remaining technical boundaries

The local merge stage operates near playback speed because it uses Chrome's native decode/capture/record pipeline instead of a large FFmpeg/WASM runtime or remote conversion server. Very large media can still consume significant browser memory because fetched/assembled data is processed locally. Platform stream formats and signed URLs can change, so rescanning after starting playback may be necessary when a URL expires.

These are implementation/platform boundaries; DRM or access-control bypass is intentionally outside the extension's behavior.

## Validation

The repository validation workflow performs JavaScript syntax checks, parses and asserts the Manifest V3 configuration, checks that the offscreen processor references all required local scripts, and runs service-worker smoke tests covering adaptive-pair routing, YouTube metadata preservation and Meta/Facebook byte-range deduplication.

# Any Video Downloader v2.5.0 Technical Audit

## Scope

The extension was reviewed for self-hosted media, GoHighLevel/course platforms, SPA navigation, embedded/custom players, signed CDN delivery, HLS, DASH, YouTube adaptive delivery, Facebook/Instagram byte ranges, Vimeo CDN delivery, partial `206` responses, and separate video/audio adaptive streams.

## Architecture

1. `service-worker.js` observes likely media requests, canonicalizes repeated range variants, preserves track/quality metadata, and keeps a bounded per-tab cache.
2. `content.js` determines the current page/lesson title, selects one primary video action, pairs separate audio when required, and resets state on SPA/video changes.
3. `youtube-probe.js` reads accessible YouTube `streamingData` and reports progressive/adaptive, audio/video, resolution and bitrate metadata.
4. `youtube-listener.js` bridges those candidates to the extension service worker.
5. `offscreen-v2.js` is the v2.5 media processor. It validates signed direct media, recovers incomplete byte-range downloads, assembles unencrypted HLS/DASH and locally combines accessible adaptive video/audio tracks.
6. `offscreen.html` loads only the active v2.5 processor.

## Major fixes

### Duplicate and tiny range requests

Facebook, Instagram, YouTube, Vimeo and other CDNs frequently issue many byte ranges for one logical stream. Range-specific parameters are canonicalized and repeated requests are collapsed. `Content-Range` total size is preferred over misleading individual chunk sizes.

### Partial `206` downloads

A detected CDN URL is not automatically assumed to represent the complete file. The v2.5 processor parses `Content-Range`; if the initial media response is partial, it requests the remaining byte ranges and assembles a complete Blob. Tiny, HTML, JSON, XML and obviously expired responses are rejected instead of being saved as video files.

This directly addresses cases where Chrome previously displayed “file wasn't available on site” or where a detected video produced only a small/partial file.

### Signed CDN failures

Volatile range parameters are removed before extension-local fetch, while the original signed URL is retained as fallback. This applies to Googlevideo and common Meta/Vimeo CDN range patterns.

### SPA/course lesson changes

The current page/lesson/video signature is monitored with debounced navigation and DOM events. Old candidates are cleared before the newly selected lesson is scanned, preventing a previous lesson video from being offered after JavaScript-only navigation.

### Separate video and audio

When a complete progressive file includes both tracks it can be downloaded directly. When the selected video is video-only and a separate audio track exists, the UI exposes a single primary `Download + Merge` path.

The processor fetches and validates both complete tracks, uses extension-local Blob URLs, decodes them in the offscreen document, synchronizes playback and records one local output with Chrome's native `MediaRecorder`. MP4 is used when supported by the installed Chrome build; otherwise WebM is used.

If the browser cannot decode/record a particular codec pair, the successfully fetched source tracks are preserved separately instead of generating a corrupt file.

### HLS

The HLS engine parses master variants and `EXT-X-MEDIA:TYPE=AUDIO`. Separate accessible audio renditions are paired with the selected video variant and locally merged when Chrome can decode them. MPEG-TS data is saved with a truthful `.ts` fallback rather than being mislabeled as MP4.

### DASH

DASH handling covers `SegmentTemplate`, `SegmentTimeline`, bounded negative timeline repeats, `SegmentList`, `SegmentBase`, direct `BaseURL` and inherited `BaseURL` resolution. Separate accessible video/audio representations are paired and sent through the local merge path. MPDs containing content protection are rejected rather than bypassed.

### Memory behavior

The old processor repeatedly converted/concatenated large typed arrays. v2.5 assembles recovered ranges and segmented media primarily as Blob parts, reducing duplicate in-memory copies. Browser/device resource limits still apply to very large media.

### Performance

There is no recurring full-page deep media scan loop. Heavy scanning is user initiated, DOM checks are debounced, Performance API inspection is bounded, and the network candidate cache is capped.

## Expected compatibility

- **Strong:** ordinary HTML5/self-hosted MP4/WebM and accessible direct media.
- **Strong/best effort:** GHL and similar course platforms using accessible direct media or unencrypted HLS.
- **Best effort with partial-response recovery/local merge:** YouTube, Facebook/Instagram, Vimeo and similar adaptive platforms when usable signed video/audio URLs are exposed to Chrome.
- **Best effort:** X/Twitter, Reddit, Dailymotion, Twitch, TikTok, Loom, Streamable, Wistia, Brightcove, Bunny, Mux, Cloudflare Stream, JW Player and Video.js sites using accessible direct/HLS/DASH delivery.
- **Unsupported by design:** DRM-protected/encrypted playback or media requiring bypass of paywalls, authentication, subscription controls or security/access controls.

## Remaining platform boundaries

The local merge stage can run near playback speed because it uses Chrome's native decode/capture/record pipeline rather than an external converter. Extremely large multi-gigabyte files can still be constrained by browser/device resources. Platform stream formats and signed URL schemes can also change, so a new scan after playback starts may occasionally be necessary.

DRM or access-control bypass is intentionally outside the extension's behavior.

## Validation

The repository validation workflow checks JavaScript syntax for `service-worker.js`, `content.js`, `offscreen-v2.js`, `youtube-listener.js`, `youtube-probe.js` and the smoke-test file; parses the Manifest V3 JSON; verifies that `offscreen.html` loads the v2.5 processor; and runs service-worker smoke tests for adaptive routing, YouTube metadata preservation and Meta byte-range deduplication.

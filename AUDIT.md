# Any Video Downloader v2.9.2 Technical Audit

## Scope

The extension was reviewed for self-hosted media, GoHighLevel/course platforms, SPA navigation, embedded/custom players, signed CDN delivery, HLS, DASH, YouTube adaptive delivery, Facebook/Instagram byte ranges, Vimeo CDN delivery, partial `206` responses, and separate video/audio adaptive streams.

## Architecture

1. `service-worker.js` observes likely media requests, canonicalizes repeated range variants, preserves track/quality metadata, and keeps a bounded per-tab cache mirrored to session-only storage for MV3 restart recovery.
2. `content.js` determines the current page/lesson title, selects one primary video action, pairs separate audio when required, and resets state on SPA/video changes.
3. `youtube-probe.js` reads accessible YouTube `streamingData` and reports progressive/adaptive, audio/video, resolution and bitrate metadata.
4. `youtube-listener.js` bridges those candidates to the extension service worker.
5. `offscreen-v2.js` is the media processor. It validates signed direct media, recovers incomplete byte-range downloads, assembles unencrypted HLS/DASH and locally combines accessible adaptive video/audio tracks.
6. `offscreen.html` loads only the active processor.

## Major fixes

### Duplicate and tiny range requests

Facebook, Instagram, YouTube, Vimeo and other CDNs frequently issue many byte ranges for one logical stream. Range-specific parameters are canonicalized and repeated requests are collapsed. `Content-Range` total size is preferred over misleading individual chunk sizes.

### Partial `206` downloads

A detected CDN URL is not automatically assumed to represent the complete file. The processor parses `Content-Range`; if the initial media response is partial, it requests the remaining byte ranges and assembles a complete Blob. Tiny, HTML, JSON, XML and obviously expired responses are rejected instead of being saved as video files.

This directly addresses cases where Chrome previously displayed “file wasn't available on site” or where a detected video produced only a small/partial file.

### Signed CDN failures

Volatile range parameters are removed before extension-local fetch, while the original signed URL is retained as fallback. This applies to Googlevideo and common Meta/Vimeo CDN range patterns.

### SPA/course lesson changes

The current page/lesson/video signature is monitored with debounced navigation, DOM, History API and player events. A minimal main-world hook publishes `pushState`/`replaceState` navigation to the isolated title detector. A service-worker context key, including hash routes, clears old candidates exactly once. No recurring full-page scan is used.

Course completion checkboxes are not considered current-lesson signals. The visible heading spatially nearest the player outranks course-level navigation, fixing the DigitalMarketer case where `Buyers From Scratch` was used instead of `What You'll Need`. The UI retains the processor's concrete completion/filename message rather than replacing it with a generic `Finished` state.

### Separate video and audio

When a complete progressive file includes both tracks it can be downloaded directly. When the selected video is video-only and a separate audio track exists, the UI exposes a single primary `Download + Merge` path.

The processor fetches and validates both complete tracks, uses extension-local Blob URLs, decodes them in the offscreen document, synchronizes playback and records one local output with Chrome's native `MediaRecorder`. MP4 is used when supported by the installed Chrome build; otherwise WebM is used.

If the browser cannot decode/record a particular codec pair, the successfully fetched source tracks are preserved separately instead of generating a corrupt file.

### HLS

The HLS engine parses master variants and `EXT-X-MEDIA:TYPE=AUDIO`. Separate accessible audio renditions are paired with the selected video variant and locally merged when Chrome can decode them. fMP4 output remains MP4; assembled MPEG-TS is decoded and recorded into a genuine MP4 or WebM container. Raw `.ts` is never saved. If Chrome lacks a compatible decoder/recorder, the extension reports the limitation rather than creating a corrupt or mislabeled file.

Fast offscreen HLS processing is attempted before page-decoded recording. The latter remains a compatibility fallback and no longer interrupts normal page playback for streams that can be assembled directly.

### DASH

DASH handling covers `SegmentTemplate`, `SegmentTimeline`, bounded negative timeline repeats, `SegmentList`, `SegmentBase`, direct `BaseURL` and inherited `BaseURL` resolution. Separate accessible video/audio representations are paired and sent through the local merge path. MPDs containing content protection are rejected rather than bypassed.

### Memory behavior

The old processor repeatedly converted/concatenated large typed arrays. The current processor assembles recovered ranges and segmented media primarily as Blob parts, reducing duplicate in-memory copies. Browser/device resource limits still apply to very large media.

### Performance

There is no recurring full-page scan loop and no observer watches global class or text mutations. DOM callbacks are filtered to relevant player/source/lesson nodes before scheduling a debounced check. Declarative configuration parsing is bounded by byte and node budgets, Performance API inspection is bounded, the network cache is capped, and YouTube probes are coalesced.

Scan and Download All never start page playback. Pre-play detection uses accessible DOM attributes, OpenGraph, JSON-LD/bounded JSON configuration, YouTube player response data, already-loaded manifests, and observed requests. A site that creates its only media URL after a genuine user play action cannot be detected beforehand without changing or bypassing that site's behavior.

YouTube downloads refresh the current player response immediately before fetching and retry a newly selected signed stream once. Explicitly expired and stale session URLs are pruned. Real-time decoded-page capture is not used for YouTube, preventing full-video waits and capture-duration timeouts. Unlike URL-paste web downloaders, this extension has no remote extraction/conversion backend; URLs are not submitted to a third-party service.

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

The validation workflow checks every extension/test script, parses and asserts the Manifest V3 wiring/version, and runs service-worker selection/context/deduplication tests, signed partial-range recovery, and regressions for event-driven SPA switching, YouTube probe/fallback behavior, HLS container guarantees, and DRM boundaries.

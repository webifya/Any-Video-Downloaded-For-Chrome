# Any Video Downloader v2.3.0 Technical Audit

## Scope

The extension was reviewed for direct/self-hosted media, course platforms, SPA navigation, embedded/custom players, signed CDN delivery, HLS, DASH, and common adaptive-stream patterns used by major video platforms.

## Architecture after audit

1. `service-worker.js` observes likely media network requests and maintains a bounded per-tab cache.
2. `content.js` performs lightweight DOM/title detection, presents one best video plus one best audio option, and refreshes state on SPA/video changes.
3. `youtube-probe.js` reads accessible YouTube player response metadata in the page world when available.
4. `youtube-listener.js` bridges those candidates back to the extension.
5. `offscreen.js` downloads signed direct media and assembles unencrypted HLS/DASH media locally.

## Issues found and fixed

### Duplicate range requests
Facebook, Instagram, YouTube, Vimeo and other CDNs often request many byte ranges for one logical stream. These were previously displayed as separate videos. Range-specific parameters are now canonicalized and candidates are deduplicated.

### Misleading 0 KB/tiny sizes
A range response's `Content-Length` is only the current byte chunk. The background detector now records total size from `Content-Range` when available and does not replace useful metadata with later zero values.

### Stale SPA media
Course sites can replace lessons without a full document reload. Candidate state is now reset on meaningful URL/title/player changes using debounced events and DOM changes rather than continuous polling.

### Signed CDN direct-download failures
Some signed CDN URLs fail when handed directly to `chrome.downloads`. Known range parameters are stripped before local extension fetch, with fallback to the original signed URL if required.

### HLS variants and separate audio
The HLS engine now parses master variants and `EXT-X-MEDIA:TYPE=AUDIO`. If audio is separate, valid video and audio files are saved separately.

### DASH coverage
DASH handling supports `SegmentTemplate`, `SegmentTimeline`, `SegmentList`, and direct `BaseURL` representations. DRM-marked MPDs are rejected rather than bypassed.

### Performance
There is no recurring page-wide media scan loop. Heavy scans occur when the user opens the downloader or clicks Scan/Download All. DOM changes are debounced and network caches are bounded.

## Expected compatibility classes

- Strong: ordinary HTML5/self-hosted MP4/WebM, accessible direct media, common unencrypted HLS.
- Strong/best effort: GHL/course platforms using direct media or unencrypted HLS.
- Best effort: Vimeo, Facebook/Instagram, YouTube, X/Twitter, Reddit, Dailymotion, Twitch, TikTok, Loom, Streamable, Wistia, Brightcove, Bunny, Mux, Cloudflare Stream, JW Player and Video.js sites when accessible media requests are exposed to the browser.
- Unsupported by design: DRM/encrypted/protected playback such as typical Netflix/Disney+/Prime/Hulu premium streams.

## Known limitations

- Adaptive video and audio may remain separate files because a local muxer/transcoder is not bundled.
- HLS MPEG-TS is saved with the requested lesson/video filename; browser/player compatibility depends on the actual container bytes.
- Extremely large segmented downloads are assembled in browser memory and can be constrained by available RAM.
- Websites can change player/network behavior at any time, so platform-specific compatibility is necessarily best effort.
- Signed URLs may expire; replaying the video and rescanning refreshes candidates.

## Release validation

The repository includes a GitHub Actions validation workflow that runs `node --check` against JavaScript source and parses `manifest.json` on every push and pull request.

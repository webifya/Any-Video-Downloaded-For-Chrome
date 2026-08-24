# Any Video Downloader

**Any Video Downloader** is a Chrome Manifest V3 extension for detecting and downloading accessible video/audio media from the current webpage.

![Install guide](docs/install-guide.svg)

## Current version

**v2.5.0 — Resilient media architecture**

v2.5.0 replaces the previous offscreen processor with a new media engine focused on the remaining real-world failure cases: signed CDN byte ranges, partial downloads, adaptive video/audio tracks, HLS/DASH variants, JavaScript course navigation, and large media assembly.

## Main features

- Direct MP4, WebM, MOV and M4V detection.
- Audio stream detection where exposed.
- Unencrypted HLS / M3U8 support.
- Unencrypted MPEG-DASH / MPD support.
- HLS master-playlist and separate-audio rendition handling.
- DASH `SegmentTemplate`, `SegmentTimeline`, `SegmentList`, `SegmentBase`, direct `BaseURL`, and inherited `BaseURL` handling.
- Network detection for custom/iframe players.
- Signed/range-based CDN handling for Googlevideo, Facebook/Instagram CDNs and Vimeo CDNs.
- Full-file recovery when a CDN exposes only a partial `206 Partial Content` request.
- Deduplication of repeated byte-range requests.
- Best available video selection plus local audio/video merge when the site separates tracks.
- Uses the current page/lesson/video title for filenames.
- Detects JavaScript/SPA lesson changes and clears stale media from the previous lesson.
- Live progress for direct media, byte-range recovery, HLS, DASH and local merge operations.
- No remote executable code or remote conversion server.

## Platform coverage

| Platform/type | Expected support |
|---|---|
| Self-hosted HTML5 MP4/WebM | Strong |
| GoHighLevel courses | Strong for accessible direct/HLS media |
| WordPress / HTML5 / Video.js / JW Player | Strong when accessible direct/HLS/DASH media is exposed |
| Wistia / Brightcove / Bunny / Mux / Cloudflare Stream | Best effort for accessible direct/HLS/DASH delivery |
| Vimeo | Direct/HLS/DASH best effort |
| YouTube | Progressive or adaptive video/audio detection; separate accessible tracks can be locally merged |
| Facebook / Reels | Signed direct/adaptive media best effort with byte-range recovery and deduplication |
| Instagram / Reels | Signed direct/adaptive media best effort |
| X/Twitter / Reddit / Dailymotion / Twitch / TikTok / Loom / Streamable | Best effort through direct/HLS/DASH/network detection |
| DRM services such as Netflix / Disney+ / Prime Video / Hulu | Not supported |

Large platforms frequently change player delivery methods and signed URLs, so no browser extension can guarantee every video on every service. This project intentionally does **not** bypass DRM, encryption, paywalls, authentication, or access controls.

## Signed CDN / partial-download recovery

A major issue on YouTube, Facebook, Instagram and some Vimeo/CDN configurations is that the browser may expose only a byte-range URL instead of the complete file. Older versions could detect the correct stream but still save only a partial file or get a Chrome “file wasn't available on site” error.

v2.5.0 now:

1. Removes volatile range parameters from the detected URL while preserving the signed URL as fallback.
2. Fetches the media inside the extension rather than handing fragile CDN URLs directly to Chrome Downloads.
3. Detects `206 Partial Content` and parses `Content-Range`.
4. If the response is incomplete, rebuilds the complete media using controlled byte-range requests.
5. Rejects tiny/expired/non-media responses instead of saving them as fake videos.

This is especially important for `googlevideo.com`, `fbcdn.net`, `cdninstagram.com`, Vimeo CDN and similar signed delivery systems.

## Adaptive video + audio merging

When a complete progressive file already contains both video and audio, it can be downloaded directly.

When the best available quality is split into separate accessible video and audio tracks, v2.5.0 uses this flow:

1. Fetch and validate the complete video track.
2. Fetch and validate the complete audio track.
3. Recover missing byte ranges when the CDN returned only partial content.
4. Convert the fetched tracks to extension-local Blob URLs.
5. Decode them in the offscreen media processor.
6. Synchronize video and audio.
7. Record one combined local output with Chrome's native `MediaRecorder`.
8. Save MP4 when supported by the installed Chrome build, otherwise WebM.

If the installed Chrome build cannot decode or record a particular codec pair, the valid source tracks are saved separately rather than producing a corrupt file.

The native merge phase still runs approximately at media playback speed. That is an intentional tradeoff that avoids remote conversion services and large remote/WASM executables while remaining compatible with Chrome Web Store remote-code rules.

## HLS safety

HLS sources can use fragmented MP4 or MPEG-TS. v2.5.0 preserves the real container type instead of simply renaming MPEG-TS bytes to `.mp4`. Separate HLS audio renditions are paired and locally merged when Chrome can decode the source pair.

## DASH improvements

The v2.5 processor handles:

- `SegmentTemplate`
- `SegmentTimeline`, including bounded negative repeats
- `SegmentList`
- `SegmentBase`
- direct and inherited `BaseURL`

When DASH exposes separate video and audio representations, the best accessible video and audio tracks are paired and merged locally when possible.

## Performance / memory architecture

The page-side extension remains event-driven and does not continuously deep-scan the page. The new media processor also avoids repeatedly concatenating giant typed arrays. HLS, DASH and recovered range chunks are assembled as Blob parts, which reduces unnecessary duplicate memory copies during large downloads.

Extremely large multi-gigabyte media can still be constrained by browser/device resources. The extension intentionally does not attempt to defeat browser storage or memory limits.

## Install on Chrome

1. Click **Code → Download ZIP** on this repository.
2. Extract the ZIP to a permanent folder.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted folder containing `manifest.json`.
7. After every update, click **Reload** for Any Video Downloader and fully refresh the video page.

![Usage guide](docs/usage-guide.svg)

## How to use

1. Open the page containing the video.
2. If the player lazy-loads media, play it for a few seconds.
3. Click the floating **↓** launcher.
4. Click **Scan** when necessary.
5. Use **Download Video** or **Download + Merge** for the primary video.
6. Use **Download Audio** only when an audio-only copy is also desired.

On course/SPA pages such as GHL or JavaScript course platforms, switch lessons normally. The extension detects the lesson/page change, clears stale stream URLs, and scans the newly loaded lesson.

## v2.5.0 fixes

- Replaced the old offscreen processor with `offscreen-v2.js`.
- Added full signed-CDN byte-range recovery for partial `206` media responses.
- Prevents partial YouTube/Meta/Vimeo files from being mistaken for complete downloads.
- Uses Blob-part assembly to avoid unnecessary large typed-array copies.
- Preserves correct HLS MPEG-TS vs fragmented-MP4 container naming.
- Expanded DASH parsing to `SegmentBase` and inherited `BaseURL` structures.
- Improved negative DASH timeline-repeat handling.
- Keeps local adaptive video+audio merging and separate-track fallback.
- Keeps current lesson/page title filenames and SPA stale-stream clearing.
- CI now validates the v2.5 processor JavaScript and manifest wiring.

See [AUDIT.md](AUDIT.md) for technical details.

## Permissions

- `downloads` — saves user-requested direct media.
- `offscreen` — locally fetches, assembles and merges user-requested media.
- `webRequest` — observes media requests generated by webpage players.
- `<all_urls>` — media commonly comes from a CDN/domain different from the webpage.

## Chrome Web Store single purpose

> Detect and download accessible video media from the web page the user is currently viewing for authorized offline use.

## Intentional boundaries

The extension does not bypass DRM/encrypted streams, paywalls, subscription controls, authentication restrictions, or website security controls.

Use the extension only for media you own or have permission to save.

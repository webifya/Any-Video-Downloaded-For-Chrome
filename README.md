# Any Video Downloader

**Any Video Downloader** is a Chrome Manifest V3 extension for detecting and downloading accessible video/audio media from the current webpage.

![Install guide](docs/install-guide.svg)

## Current version

**v2.4.1 — Adaptive merge stabilization**

v2.4.x changes the architecture for sites that deliver video and audio as separate adaptive tracks. The extension now fetches both accessible tracks and attempts to merge them locally inside Chrome into one playable file instead of leaving the user with a silent video plus a separate audio file.

v2.4.1 also removes the obsolete GHL sandbox processor, validates the new processor files in CI, and prevents MPEG-TS HLS bytes from being falsely named as MP4.

## Main features

- Direct MP4, WebM, MOV and M4V detection.
- Audio stream detection where exposed.
- Unencrypted HLS / M3U8 support.
- Unencrypted MPEG-DASH / MPD support.
- HLS master-playlist and separate-audio rendition handling.
- DASH `SegmentTemplate`, `SegmentTimeline`, `SegmentList`, and direct `BaseURL` handling.
- Network detection for custom/iframe players.
- Signed/range-based CDN handling for Googlevideo, Facebook/Instagram CDNs and Vimeo CDNs.
- Deduplication of repeated byte-range requests.
- Best available video selection plus local audio/video merge when the site separates tracks.
- Uses the current page/lesson/video title for filenames.
- Detects JavaScript/SPA lesson changes and clears stale media from the previous lesson.
- Live progress for fetched direct media, HLS, DASH and local merge operations.
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
| Facebook / Reels | Signed direct/adaptive media best effort with range-request deduplication |
| Instagram / Reels | Signed direct/adaptive media best effort |
| X/Twitter / Reddit / Dailymotion / Twitch / TikTok / Loom / Streamable | Best effort through direct/HLS/DASH/network detection |
| DRM services such as Netflix / Disney+ / Prime Video / Hulu | Not supported |

Large platforms frequently change player delivery methods and signed URLs, so no browser extension can guarantee every video on every service. This project intentionally does **not** bypass DRM, encryption, paywalls, authentication, or access controls.

## Adaptive video + audio merging

When a complete progressive file already contains both video and audio, it can be downloaded directly.

When the best available quality is split into separate accessible video and audio tracks, v2.4.1 uses this flow:

1. Fetch the selected video track locally.
2. Fetch the selected audio track locally.
3. Convert both to extension-local Blob URLs.
4. Decode them in the offscreen media processor.
5. Synchronize the video and audio tracks.
6. Combine them into one local `MediaStream`.
7. Record one output file with Chrome's native `MediaRecorder`.
8. Save MP4 when the installed Chrome build supports MP4 recording, otherwise save WebM.

No external converter or remote executable code is used.

### Merge fallback

Some uncommon codec/container combinations cannot be decoded or recorded by the installed Chrome build. In that case, the extension preserves the successfully fetched source tracks as separate files rather than creating a corrupt output.

The local merge phase runs at approximately media playback speed because it uses Chrome's native decode/capture/record pipeline. This keeps the extension relatively small and avoids an external conversion service or a large FFmpeg/WASM runtime.

## HLS container safety

Some HLS playlists use fragmented MP4 while others use MPEG-TS. v2.4.1 no longer labels raw MPEG-TS bytes as `.mp4`. If a source cannot be locally merged/transcoded and is actually MPEG-TS, the fallback is saved with the correct `.ts` container extension.

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

On course/SPA pages, switch lessons normally. The extension detects the lesson/page change, clears stale stream URLs, and scans the newly loaded lesson.

## v2.4.1 fixes

- Stabilized the v2.4 local adaptive audio/video merge path.
- Preserves `hasAudio`, `hasVideo`, progressive/adaptive, quality and bitrate metadata from player responses.
- Presents one primary video action instead of every adaptive network fragment.
- Pairs separate video/audio tracks automatically.
- Normalizes signed YouTube/Meta/Vimeo range URLs while retaining the original signed URL for fallback.
- Uses extension-local Blob URLs for the local merge stage.
- Chooses MP4 recording when supported by Chrome and WebM otherwise.
- HLS and DASH separate-track flows attempt local merge before falling back to separate source files.
- Removed the obsolete GHL `sandbox.html` processor reference from the offscreen document.
- Added a format guard so MPEG-TS data is not mislabeled as MP4.
- CI now validates the format guard, offscreen references, JavaScript syntax, manifest structure, adaptive-pair routing and Meta byte-range deduplication.

See [AUDIT.md](AUDIT.md) for the technical audit.

## Permissions

- `downloads` — saves user-requested direct media.
- `offscreen` — locally fetches, assembles and merges user-requested media.
- `webRequest` — observes media requests generated by webpage players.
- `<all_urls>` — media commonly comes from a CDN/domain different from the webpage.

## Chrome Web Store single purpose

> Detect and download accessible video media from the web page the user is currently viewing for authorized offline use.

## Remaining boundaries

The extension does not bypass DRM/encrypted streams, paywalls, subscription controls, authentication restrictions, or website security controls. These are intentional boundaries.

Very large media files still require substantial local memory because fetched/assembled media is processed in the browser. A future disk-backed processing queue could reduce peak memory use for multi-gigabyte media.

Use the extension only for media you own or have permission to save.

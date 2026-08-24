# Any Video Downloader

**Any Video Downloader** is a Chrome Manifest V3 extension for detecting and downloading accessible video/audio media from the current webpage.

![Install guide](docs/install-guide.svg)

## Current version

**v2.4.0 — Local adaptive merge architecture**

v2.4.0 changes the architecture for sites that deliver video and audio as separate adaptive tracks. Instead of forcing the user to keep a silent video file plus a separate audio file, the extension now fetches both accessible tracks and attempts to merge them locally inside Chrome into one playable file.

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

When the best available quality is split into separate accessible video and audio tracks, v2.4.0 uses this flow:

1. Fetch the selected video track locally.
2. Fetch the selected audio track locally.
3. Convert the fetched data to extension-local Blob URLs so cross-origin media is not captured directly.
4. Decode the two tracks in an offscreen document.
5. Synchronize video and audio playback.
6. Record the combined `MediaStream` with Chrome's local `MediaRecorder` implementation.
7. Save one merged MP4 when Chrome supports MP4 recording, otherwise save a WebM file.

No external converter or remote executable code is used.

### Merge fallback

Some uncommon codec/container combinations cannot be decoded or recorded by the installed Chrome build. In that case, the extension preserves the successfully downloaded source tracks as separate files rather than discarding them.

The local merge stage runs at approximately media playback speed because it uses Chrome's native decode/capture/record pipeline. This trades speed for a much smaller extension, no FFmpeg/WASM dependency, and Chrome Web Store-friendly local processing.

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
2. If the player lazy-loads its media, play it for a few seconds.
3. Click the floating **↓** launcher.
4. Click **Scan** when necessary.
5. Use **Download Video** or **Download + Merge** for the main video.
6. Use **Download Audio** when an audio-only copy is also desired.

On course/SPA pages, switch lessons normally. The extension detects the lesson/page change, clears old stream URLs, and scans the newly loaded lesson.

## v2.4.0 architecture fixes

- Added a new `DOWNLOAD_MERGED_MEDIA` processing path.
- Preserves `hasAudio`, `hasVideo`, progressive/adaptive, quality and bitrate metadata from player responses.
- The page UI now presents one primary video action instead of exposing every adaptive network fragment.
- Separate video/audio tracks are paired automatically.
- Signed YouTube/Meta/Vimeo range URLs are normalized before local fetch, with original signed URLs retained for fallback.
- Local blob URLs avoid cross-origin `captureStream()` restrictions during the merge stage.
- Native `MediaRecorder.isTypeSupported()` chooses MP4 when available and WebM otherwise.
- Audio/video synchronization is corrected during long merges.
- HLS and DASH separate-track flows now attempt local merge before falling back to separate files.
- The offscreen document uses the `BLOBS` reason so long fetch/merge jobs are not tied to Chrome's special audio-playback lifetime rule.
- Automated smoke tests cover adaptive pair routing, YouTube metadata preservation and Facebook/Meta byte-range deduplication.

See [AUDIT.md](AUDIT.md) for the technical audit.

## Permissions

- `downloads` — saves user-requested direct media.
- `offscreen` — locally fetches, assembles and merges user-requested media.
- `webRequest` — observes media requests generated by webpage players.
- `<all_urls>` — media commonly comes from a CDN/domain different from the webpage.

## Chrome Web Store single purpose

> Detect and download accessible video media from the web page the user is currently viewing for authorized offline use.

## Remaining boundaries

The extension does not bypass DRM/encrypted streams, paywalls, subscription controls, authentication restrictions, or website security controls. These are intentional boundaries, not bugs to work around.

Very large media files still require substantial local memory because fetched/assembled media is processed in the browser. The v2.4 architecture avoids external services and large bundled WASM binaries, but a future disk-backed processing queue could further reduce peak memory use for multi-gigabyte files.

Use the extension only for media you own or have permission to save.

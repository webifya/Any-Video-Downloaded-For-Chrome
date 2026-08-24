# Any Video Downloader

**Any Video Downloader** is a lightweight Chrome Manifest V3 extension for detecting and downloading accessible video/audio media from the current webpage.

![Install guide](docs/install-guide.svg)

## Current version

**v2.3.1 — Stability + complete-stream preference**

This release builds on the v2.3.0 cross-platform audit and fixes one of the biggest remaining adaptive-stream problems: when a platform exposes a complete progressive file containing both video and audio, the extension now prefers that single playable file over separate adaptive tracks.

## Main features

- Direct MP4, WebM, MOV and M4V detection.
- Audio stream detection (M4A/AAC/MP3/WebM/Opus where exposed).
- Unencrypted HLS / M3U8 support.
- Unencrypted MPEG-DASH / MPD support.
- HLS master-playlist handling, including separate audio renditions.
- DASH `SegmentTemplate`, `SegmentTimeline`, `SegmentList`, and direct `BaseURL` handling.
- Network detection for custom/iframe players even when the top page has no normal `<video>` URL.
- Signed/range-based CDN URL cleanup for YouTube/Googlevideo, Facebook/Instagram CDNs and Vimeo CDNs.
- Deduplication: shows the best main video plus the best separate audio option instead of dozens of byte-range fragments.
- Prefers a complete video+audio progressive stream when one is available.
- Uses the current page/lesson/video title for filenames.
- Detects SPA/JavaScript lesson changes and clears stale media from the previous lesson.
- Live progress for fetched direct media, HLS and DASH downloads.
- No remote executable code.

## Platform coverage

| Platform/type | Expected support |
|---|---|
| Self-hosted HTML5 MP4/WebM | Strong |
| GoHighLevel courses | Strong for accessible direct/HLS media |
| WordPress / HTML5 / Video.js / JW Player | Strong when media is direct/HLS/DASH and unencrypted |
| Wistia / Brightcove / Bunny / Mux / Cloudflare Stream | Best effort; commonly works when accessible HLS/DASH/direct URLs are exposed |
| Vimeo | Direct/HLS/DASH best effort |
| YouTube | Prefers progressive video+audio when exposed; otherwise adaptive video/audio best effort |
| Facebook / Reels | Signed direct/adaptive media best effort |
| Instagram / Reels | Signed direct/adaptive media best effort |
| X/Twitter / Reddit / Dailymotion / Twitch / TikTok / Loom / Streamable | Best effort through direct/HLS/DASH/network detection |
| Netflix / Disney+ / Prime Video / Hulu and other DRM services | Not supported |

No extension can guarantee every streaming site because players, signatures and delivery methods change frequently. This project intentionally does **not** bypass DRM, encryption, paywalls, authentication, or access controls.

## Adaptive-stream behavior

When a platform exposes a normal progressive MP4 containing both video and audio, v2.3.1 prefers it automatically. This is especially useful on YouTube when a combined progressive representation is available.

When a site only exposes separate adaptive tracks, the extension still saves two valid files rather than falsely renaming or corrupting them:

```text
Video Title.mp4
Video Title - audio.m4a
```

A browser-side general-purpose muxer is not bundled because that would substantially increase extension size and memory use. The current strategy prioritizes a complete progressive file first, then falls back to separate adaptive tracks only when necessary.

## Install on Chrome

1. Click **Code → Download ZIP** on this repository.
2. Extract the ZIP to a permanent folder.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted folder containing `manifest.json`.
7. After every update, click **Reload** for Any Video Downloader and refresh the video page.

![Usage guide](docs/usage-guide.svg)

## How to use

1. Open the page containing the video.
2. If the player lazy-loads media, play it for a few seconds.
3. Click the floating **↓** launcher.
4. Click **Scan** when necessary.
5. Download the main video, separate audio if needed, or **Download All**.

For course/SPA pages, switch to another lesson normally. The extension detects the page/lesson change, clears old stream URLs, and rescans the new lesson.

## v2.3.1 fixes

- YouTube player-response probing now distinguishes progressive formats from adaptive formats.
- Complete YouTube progressive streams containing audio are preferred over higher-resolution video-only adaptive tracks.
- Separate audio is hidden when the selected progressive file already contains audio.
- Service-worker candidate merging now preserves progressive/audio metadata instead of losing it when later network requests arrive.
- Added automated service-worker smoke tests for complete-stream preference and Meta/Facebook byte-range deduplication.
- CI now checks JavaScript syntax, manifest JSON, manifest basics, and media-selection smoke tests.

## v2.3.0 audit fixes

- Removed the recurring SPA polling loop; navigation detection is event/mutation-driven and debounced.
- Rebuilt candidate scoring so MP4 and higher-quality representations are preferred where metadata is available.
- Uses `Content-Range` total size instead of showing misleading tiny byte-range sizes.
- Preserves useful size/quality metadata when later requests contain empty values.
- Removes volatile range parameters before fetching signed CDN media and retries the original URL if the cleaned URL is rejected.
- Added HLS separate-audio playlist support.
- Added DASH `SegmentList` support and safer representation selection.
- Prevents stale media from one SPA lesson/video being offered on the next.
- Limits DOM/performance scanning and media caches to reduce page-load impact.

See [AUDIT.md](AUDIT.md) for the technical audit and known limitations.

## Permissions

- `downloads` — saves user-requested direct media.
- `offscreen` — locally fetches/assembles user-requested signed direct media, HLS and DASH.
- `webRequest` — observes media requests made by webpage players.
- `<all_urls>` — required because webpage media is often hosted on a different CDN/domain.

## Chrome Web Store single purpose

> Detect and download accessible video media from the web page the user is currently viewing for authorized offline use.

## Limitations

The extension does not bypass DRM, encrypted streams, paywalls, subscription controls, authentication restrictions, or website security controls. Large segmented downloads are assembled locally in browser memory, so extremely large files may be constrained by available memory.

Use it only for media you own or have permission to save.
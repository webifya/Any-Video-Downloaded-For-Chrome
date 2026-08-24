# Any Video Downloader

**Any Video Downloader** is a lightweight Chrome Manifest V3 extension for detecting and downloading accessible video/audio media from the current webpage.

![Install guide](docs/install-guide.svg)

## Current version

**v2.3.0 — Cross-platform audit release**

This release rebuilds the page detector and hardens the download engine for ordinary HTML5/self-hosted video, course platforms such as GoHighLevel, custom players, signed CDN URLs, HLS, DASH, and JavaScript/SPA navigation.

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
| YouTube | Adaptive video/audio detection best effort; tracks are commonly separate |
| Facebook / Reels | Signed direct/adaptive media best effort |
| Instagram / Reels | Signed direct/adaptive media best effort |
| X/Twitter / Reddit / Dailymotion / Twitch / TikTok / Loom / Streamable | Best effort through direct/HLS/DASH/network detection |
| Netflix / Disney+ / Prime Video / Hulu and other DRM services | Not supported |

No extension can guarantee every streaming site because players, signatures and delivery methods change frequently. This project intentionally does **not** bypass DRM, encryption, paywalls, authentication, or access controls.

## Important adaptive-stream behavior

Some sites deliver video and audio separately. When that happens the extension saves two valid files rather than falsely renaming or corrupting them, for example:

```text
Video Title.mp4
Video Title - audio.m4a
```

HLS/DASH may also produce separate tracks when the source itself separates them. Local muxing into one finished MP4 is not bundled yet.

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
5. Download the main video, separate audio, or **Download All**.

For course/SPA pages, switch to another lesson normally. v2.3.0 detects the page/lesson change, clears old stream URLs, and rescans the new lesson.

## v2.3.0 audit fixes

- Removed the recurring SPA polling loop; navigation detection is now event/mutation-driven and debounced.
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

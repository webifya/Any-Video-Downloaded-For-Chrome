# Any Video Downloader

**Any Video Downloader** is a lightweight Chrome Manifest V3 extension that detects accessible video media on web pages and lets you download individual videos or all detected videos from the current page.

![Any Video Downloader install guide](docs/install-guide.svg)

## Features

- Works on general web pages, not only GoHighLevel.
- Detects HTML5 video sources and direct MP4, WebM, MOV, and M4V files.
- Detects unencrypted HLS (`.m3u8`) streams.
- Supports custom and embedded video players through network media detection.
- Supports JavaScript/SPA lesson pages where the URL, lesson title, and video change without a full browser refresh.
- Automatically clears the previous lesson's cached video when a new lesson/page is detected.
- Uses the current page or lesson title as the downloaded filename whenever possible.
- Provides individual **Download** buttons and **Download All**.
- Includes **Scan** for lazy-loaded or custom video players.
- Shows HLS segment download progress.
- Uses a lightweight, on-demand architecture to reduce impact on page loading and playback.
- Does not use remote executable code.

## Current version

**v2.1.3**

### v2.1.3 fixes

- Fixed stale-video downloads on course sites that switch lessons using JavaScript without reloading the page.
- Detects meaningful SPA changes from URL, current lesson title, selected lesson state, and video source changes.
- Clears both the page candidate list and background media cache when the lesson changes.
- Rescans only after the new lesson/player has had time to load.
- Fixes generic filenames such as `Video.mp4` by resolving the filename from the current selected lesson, visible H1/H2, breadcrumb, or document title.
- Re-resolves the lesson/page title again at download time so a stale title cannot be reused after navigation.
- Keeps the launcher available on custom/embedded-player pages.

## Install on Google Chrome

Until the extension is available directly from the Chrome Web Store, you can install it manually from this repository.

### 1. Download the extension

Click the green **Code** button near the top of this GitHub repository, then choose **Download ZIP**.

Extract the ZIP to a permanent folder on your computer.

### 2. Open Chrome Extensions

Enter this in Chrome's address bar:

```text
chrome://extensions
```

Turn on **Developer mode** in the upper-right corner.

### 3. Load the extension

Click **Load unpacked** and choose the extracted folder containing `manifest.json`.

Chrome should now show **Any Video Downloader** in your installed extensions.

### 4. After an update

When you replace/update the extension files:

1. Go back to `chrome://extensions`.
2. Click **Reload** on Any Video Downloader.
3. Fully refresh the video/course page.

## How to use

![Any Video Downloader usage guide](docs/usage-guide.svg)

1. Open a webpage containing the video you want to save.
2. If necessary, play the video briefly so the website requests its real media stream.
3. Click the floating **↓** Any Video Downloader launcher.
4. The panel shows detected downloadable media for the **current** page/lesson.
5. If nothing appears, click **Scan**.
6. Click **Download** for one video or **Download All** for all detected videos on that page.
7. For HLS streams, download/segment progress is displayed in the panel.

### Course sites / JavaScript lesson navigation

If a course changes from Lesson 1 to Lesson 2 without a full page reload, v2.1.3 detects that transition automatically. The previous lesson media is discarded, the new lesson media is detected, and the downloaded filename should use the new lesson title.

Example:

```text
Welcome & Overview.mp4
Warnings & Disclaimers.mp4
Core Principles.mp4
```

rather than generic names such as:

```text
Video.mp4
```

## If the new lesson is not detected

1. Wait about one second after clicking the new lesson.
2. Play the new lesson briefly if the player lazy-loads its stream.
3. Open Any Video Downloader and click **Scan**.
4. If Chrome is still running an older unpacked build, go to `chrome://extensions`, click **Reload**, and fully refresh the course page.

## Performance design

The extension is intentionally designed to avoid slowing video-heavy pages:

- No continuous 2-second/2.5-second full-page scanning loops.
- No continuously injected resource-probe script.
- No automatic deep scan when a page loads.
- Heavy media/network scanning happens when the user opens the downloader or chooses **Scan / Download All**.
- SPA detection is debounced instead of continuously rescanning resources.
- Performance API inspection is capped instead of walking unlimited resource history.
- Background `webRequest` detection uses a bounded per-tab media cache.
- Deep-scan autoplay is user initiated and limited to a small number of visible players.

## Chrome permissions

- `downloads` — saves videos selected by the user to Chrome's Downloads folder.
- `offscreen` — assembles user-requested unencrypted HLS segments into a local downloadable media file.
- `webRequest` — detects media/HLS requests generated by webpage video players.
- `<all_urls>` — lets the extension work across websites and media/CDN domains.

## Chrome Web Store single purpose

> Detect and download accessible video media from the web page the user is currently viewing for authorized offline use.

## Limitations

Any Video Downloader does **not** attempt to bypass DRM, encrypted HLS, paywalls, subscription/access controls, authentication restrictions, or website security controls.

Use it only for videos you own or content you have permission to save for offline use.

## Repository

`webifya/Any-Video-Downloaded-For-Chrome`

# Any Video Downloader

**Any Video Downloader** is a lightweight Chrome Manifest V3 extension that detects accessible video media on web pages and lets you download individual videos or all detected media from the current page.

![Any Video Downloader install guide](docs/install-guide.svg)

## Features

- Works on general web pages, not only course platforms.
- Detects HTML5 video sources and direct MP4, WebM, MOV, and M4V files.
- Detects unencrypted HLS (`.m3u8`) streams.
- Detects DASH / MPEG-DASH (`.mpd`) manifests.
- Detects extensionless adaptive video/audio requests used by sites such as YouTube, Facebook, Vimeo, and similar players when those requests are visible to Chrome.
- Supports custom and embedded players through network media detection.
- Supports JavaScript/SPA lesson pages where the URL, lesson title, and video change without a full browser refresh.
- Clears the previous lesson's cached media when a new lesson/page is detected.
- Uses the current page or lesson title as the downloaded filename whenever possible.
- Provides individual **Download** buttons and **Download All**.
- Includes **Scan** for lazy-loaded/custom players.
- Shows HLS and DASH segment download progress.
- Uses a lightweight on-demand architecture to reduce impact on page loading and playback.
- Does not use remote executable code.

## Current version

**v2.2.0**

### v2.2.0 adaptive-stream upgrade

- Added DASH / MPD manifest detection.
- Added basic unencrypted DASH `SegmentTemplate` / `SegmentTimeline` downloading.
- Chooses the highest detected DASH video representation and highest detected audio representation.
- Detects separate adaptive audio streams as well as video streams.
- Better recognition of signed/extensionless media URLs used by large video platforms.
- Keeps v2.1.3 SPA lesson-switch detection and title-based filenames.
- HLS functionality remains unchanged.

### Important DASH note

Many large streaming sites deliver video and audio as **separate adaptive tracks**. Any Video Downloader v2.2.0 can detect/download those accessible tracks, but when a DASH source contains separate video and audio representations it currently saves them as two files:

```text
Lesson or Page Name.mp4
Lesson or Page Name - audio.m4a
```

A true browser-side MP4 muxer is not bundled yet. The extension does not download remote executable code or call an external conversion server.

Because large platforms frequently change their playback delivery, support for YouTube, Vimeo, Facebook, Instagram, and similar sites is best-effort rather than guaranteed. DRM/protected streams are not bypassed.

## Install on Google Chrome

Until the extension is available directly from the Chrome Web Store, install it manually from this repository.

### 1. Download the extension

Click the green **Code** button near the top of this GitHub repository and choose **Download ZIP**.

Extract the ZIP to a permanent folder on your computer.

### 2. Open Chrome Extensions

Enter:

```text
chrome://extensions
```

Turn on **Developer mode** in the upper-right corner.

### 3. Load the extension

Click **Load unpacked** and choose the extracted folder containing `manifest.json`.

Chrome should now show **Any Video Downloader**.

### 4. After an update

1. Go to `chrome://extensions`.
2. Click **Reload** on Any Video Downloader.
3. Fully refresh the video/course page.

## How to use

![Any Video Downloader usage guide](docs/usage-guide.svg)

1. Open a webpage containing the video you want to save.
2. Play the video briefly if the website lazy-loads the actual stream.
3. Click the floating **↓** Any Video Downloader launcher.
4. The panel shows detected media for the **current** page/lesson.
5. Click **Scan** if the stream has not appeared yet.
6. Click **Download** for one detected item or **Download All**.
7. HLS/DASH segment progress appears in the panel.

### Course sites / JavaScript navigation

When a course switches lessons without a normal page reload, the extension watches the current URL/title/selected lesson/video source. It clears the old media cache and detects the new lesson stream.

Expected filenames:

```text
Welcome & Overview.mp4
Warnings & Disclaimers.mp4
Core Principles.mp4
```

instead of:

```text
Video.mp4
```

## Platform notes

**YouTube:** Adaptive video/audio requests can be detected when exposed to the extension. YouTube commonly separates video and audio, so v2.2.0 may provide separate files rather than a single muxed MP4. Protected/DRM content is not supported.

**Vimeo:** Direct MP4, HLS, and unencrypted DASH delivery can work depending on the video's configuration and permissions.

**Facebook:** Direct/adaptive media may be detected. Facebook frequently changes signed delivery URLs and can separate audio/video, so compatibility can vary.

**Instagram:** Public/accessible direct MP4 media can work. Some Reels/posts use signed or changing delivery methods, so compatibility can vary.

## Performance design

The extension avoids continuous deep scanning:

- No continuously injected resource-probe script.
- No automatic deep media scan on every page load.
- Heavy media/network scanning occurs when the downloader is opened or **Scan / Download All** is used.
- SPA detection compares a lightweight page signature and debounces DOM changes.
- Performance API inspection is capped.
- Background webRequest media cache is bounded per tab.
- Deep-scan autoplay is user initiated and limited to a small number of visible players.

## Chrome permissions

- `downloads` — saves direct media selected by the user.
- `offscreen` — assembles user-requested unencrypted HLS/DASH segments locally.
- `webRequest` — detects media/HLS/DASH requests generated by webpage players.
- `<all_urls>` — allows detection/retrieval from webpages and separate CDN/media domains.

## Chrome Web Store single purpose

> Detect and download accessible video media from the web page the user is currently viewing for authorized offline use.

## Limitations

Any Video Downloader does **not** attempt to bypass:

- DRM-protected video
- encrypted HLS/DASH
- paywalls
- subscription/access controls
- authentication restrictions
- website security controls

Use it only for videos you own or content you have permission to save for offline use.

## Repository

`webifya/Any-Video-Downloaded-For-Chrome`

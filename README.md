# Any Video Downloader v2.1.1

Chrome Manifest V3 extension that detects accessible videos on the current page and lets the user download one video or all detected videos.

## Brand
- Product name: **Any Video Downloader**
- Repository: `webifya/Any-Video-Downloaded-For-Chrome`

## Performance design

The extension uses a lazy/on-demand architecture to avoid slowing video pages:

- No continuous 2-second/2.5-second page scanning loops.
- No injected page probe script.
- No automatic full downloader panel on page load.
- A small launcher appears only when an HTML5 video is present.
- Full media/network scanning happens when the user opens the downloader or clicks **Scan / Download All**.
- Mutation observation is limited to newly-added video/source elements and is debounced.
- Performance API inspection is capped to the newest 200 resource entries.
- Background webRequest listeners cache a limited number of media candidates per tab.
- Deep scan auto-play is user-initiated and capped to 12 visible players.

## Features
- Works on general web pages, not only GoHighLevel.
- Detects HTML5 video sources, direct MP4/WebM/MOV/M4V files, and unencrypted HLS (.m3u8) streams.
- Lightweight floating launcher with **Download All**, **Scan**, and individual download buttons.
- Can briefly start HTML5 videos muted during a user-requested deep scan so lazy-loaded streams become visible.
- Uses nearby headings/page title to create filenames.
- Shows HLS segment download progress.
- Rejects encrypted/DRM-protected HLS streams.
- No remote executable code.

## Chrome Web Store single purpose
Detect and download accessible video media from the web page the user is currently viewing for authorized offline use.

## Permissions
- `downloads`: save direct video files selected by the user.
- `offscreen`: assemble unencrypted HLS segments into a local downloadable file.
- `webRequest`: detect media requests made by page video players.
- `<all_urls>` host permission: required because the extension is intentionally designed to work across websites and video files/CDN streams may be hosted on different origins.

## Limitations
This extension does not bypass DRM, encrypted HLS, subscription controls, paywalls, or website access controls. Users should download only content they own or have permission to save.

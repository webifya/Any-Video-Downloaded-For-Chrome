# Video Downloader for Web Pages v2.0.0

Chrome Manifest V3 extension that detects accessible videos on the current page and lets the user download one video or all detected videos.

## Features
- Works on general web pages, not only GoHighLevel.
- Detects HTML5 video sources, direct MP4/WebM/MOV/M4V files, and unencrypted HLS (.m3u8) streams.
- Floating page panel with **Download All**, **Scan**, and individual download buttons.
- Can briefly start HTML5 videos muted during a deep scan so lazy-loaded streams become visible.
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
- `<all_urls>` host permission: required because the feature is intentionally designed to work across websites and video files/CDN streams may be hosted on different origins.

## Limitations
This extension does not bypass DRM, encrypted HLS, subscription controls, paywalls, or website access controls. Users should download only content they own or have permission to save.

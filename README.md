# GHL Course Video Downloader v1.3.2

Chrome Manifest V3 extension for downloading GoHighLevel course lesson videos.

## v1.3.2 fixes

- Buttons resolve the current GHL video player after SPA re-renders.
- Automatically plays the lesson muted when the real media stream is not visible yet.
- Waits up to 22 seconds for a real HLS/direct video request.
- Uses a small seek after metadata loads to force the player to request the actual stream when needed.
- Clears previous-lesson media candidates before each automatic lesson download.
- Retries a failed lesson once before moving on.
- Keeps automatic lesson/category navigation and live download percentage.
- Keeps the v1.2.2 original-segment download method for TS-based HLS lessons.

## Install

1. Extract this ZIP.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this folder.
5. Refresh the GHL course lesson page.

For batch downloading, open a lesson with a visible video and click **Download All Course Videos**.

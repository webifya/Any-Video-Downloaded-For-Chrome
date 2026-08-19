# GHL Course Video Downloader v1.4.0

Chrome Manifest V3 extension for downloading GoHighLevel course lesson videos.

## v1.4.0 reliability upgrade

- Rebuilt automatic navigation around the actual GHL curriculum/sidebar DOM instead of guessing or assigning URLs.
- Never uses `location.assign()` to jump to a guessed lesson URL.
- Detects the curriculum container with the highest concentration of numbered lesson controls.
- Clicks the next real lesson row and verifies that the lesson/player actually changed before continuing.
- Uses explicit **Next Lesson / Continue** and **Next Category / Module / Section** controls only as fallbacks.
- Blocks dashboard/home/course-root destinations from automatic navigation.
- If GHL unexpectedly lands on a dashboard during an active batch, the extension recovers the last known lesson.
- Tracks completed lessons by normalized lesson title, avoiding SPA URL duplication problems.
- Automatically plays videos muted and waits up to 30 seconds for the real HLS/direct stream.
- Retries failed stream detection twice before skipping a lesson.
- Clears media candidates between lessons to avoid downloading the previous lesson again.
- Shows live download percentage plus how many lessons are currently detected in the visible course section.
- Keeps the proven original HLS segment-joining method for TS-based GHL lessons.

## Install

1. Extract the ZIP.
2. Open `chrome://extensions`.
3. Remove/disable older versions of this extension.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select this folder.
6. Refresh the GHL lesson page.
7. Open the first lesson and click **Download All Course Videos**.

Chrome may ask whether to allow multiple downloads. Choose **Allow**.

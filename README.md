# GHL Course Video Downloader v1.4.1

Chrome Manifest V3 extension for downloading GoHighLevel course lesson videos.

## v1.4.1 forward-only start

- **Download All Course Videos now starts from the lesson you are currently viewing.**
- If you start from lesson 06, lessons 01–05 are marked as intentionally skipped for that batch.
- The current lesson downloads first, then the extension continues only forward to 07, the next category/module, and all later lessons.
- Previous lessons in the same section are never downloaded during that run.
- The helper matches the currently open lesson by the lesson heading first, then GHL's active/selected sidebar state as a fallback.
- Keeps the v1.4.0 curriculum/sidebar navigation, dashboard blocking/recovery, muted autoplay stream detection, retries, and live percentage progress.

## v1.4.0 reliability upgrade

- Rebuilt automatic navigation around the actual GHL curriculum/sidebar DOM instead of guessing or assigning URLs.
- Never uses `location.assign()` to jump to a guessed lesson URL.
- Detects the curriculum container with the highest concentration of numbered lesson controls.
- Clicks the next real lesson row and verifies that the lesson/player actually changed before continuing.
- Uses explicit **Next Lesson / Continue** and **Next Category / Module / Section** controls only as fallbacks.
- Blocks dashboard/home/course-root destinations from automatic navigation.
- Automatically plays videos muted and waits up to 30 seconds for the real HLS/direct stream.
- Retries failed stream detection twice before skipping a lesson.
- Clears media candidates between lessons to avoid downloading the previous lesson again.
- Shows live download percentage.
- Keeps the original HLS segment-joining method for TS-based GHL lessons.

## Install

1. Extract the ZIP.
2. Open `chrome://extensions`.
3. Remove/disable older versions of this extension.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select this folder.
6. Refresh the GHL lesson page.
7. Open whichever lesson you want to start from and click **Download All Course Videos**.

Example: if the page is currently on `06-I Don’t Know What I’m Doing - That’s Why I Need a System`, the batch starts with lesson 06, then 07, then moves forward into the next category. Lessons 01–05 are skipped.

Chrome may ask whether to allow multiple downloads. Choose **Allow**.

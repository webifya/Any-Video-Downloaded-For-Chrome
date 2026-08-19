# GHL Course Video Downloader v1.3.3

Chrome Manifest V3 extension for downloading GoHighLevel course lesson videos.

## v1.3.3 navigation fix

- Automatic mode no longer uses `location.assign()` to jump to collected lesson URLs.
- It stays inside the GHL course/lesson player and clicks the lesson controls that GHL rendered on the page.
- After a download, it first clicks the next numbered lesson in the lesson list.
- If needed, it falls back to GHL's visible **Next Lesson / Continue** control.
- At the end of a section, it clicks **Next Category / Next Module / Next Section** and continues from the first lesson there.
- Dashboard, Home, Courses, Products, Memberships, and other top-level links are explicitly rejected as batch navigation targets.
- Lesson changes are detected from GHL's active/selected lesson state, so SPA navigation can continue without reloading the whole site.
- Automatic muted playback, stream detection/retry, original TS/HLS segment downloading, and live download percentage remain enabled.

## Install

1. Extract the ZIP.
2. Open `chrome://extensions`.
3. Remove or disable the older version.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select the v1.3.3 folder.
6. Refresh the GHL lesson page.
7. Open the first lesson and click **Download All Course Videos**.

The automatic downloader should remain within the course player and move lesson → lesson → category rather than sending the browser to the dashboard.
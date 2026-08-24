# Changelog

## 2.9.6 - 2026-08-25

- Detects media elements inside open shadow roots used by component-based course players.
- Injects the player helper into matching `about:blank`, `data:`, `blob:`, and other origin-fallback frames.
- Keeps visible video area as the primary ranking signal but no longer rejects a genuine video merely because it is hidden or still initializing.
- Bounds shadow-tree inspection and runs it only for explicit player probing/capture, preserving lightweight normal-page behavior.

## 2.9.5 - 2026-08-25

- Probes every injected page/iframe frame and selects the largest visible video instead of trusting a possibly misleading HLS request frame ID.
- Uses discovered-frame routing for both the 3.5-second warm-up and decoded HLS capture fallback.
- Adds the loaded extension version to the panel header so unpacked-update problems are immediately visible.
- Adds `webNavigation` solely to enumerate frame IDs in the current tab for targeted player messaging.
- Added wrong-frame recovery, visible-player probing, permission, and version-display regression coverage.

## 2.9.4 - 2026-08-25

- Added a download-click-only HLS warm-up for lazy players: play the detected frame muted for 3.5 seconds, then rescan and download the refreshed manifest.
- Targets only the frame associated with the selected HLS candidate; unrelated page videos are never started.
- Restores mute, volume, and paused state after warm-up.
- Keeps ordinary Scan non-playing and retains embedded-frame capture only as a final compatibility fallback.
- Added service-worker frame routing and bounded player-state restoration tests.

## 2.9.3 - 2026-08-25

- Fixed `Video capture failed: No active page video element was found` when an HLS player lives in a cross-origin iframe.
- Preserved the network candidate's Chrome frame ID through caching, persistence, deduplication, and UI selection.
- Routed fallback capture to the exact embedded player frame and relayed its progress to the top-page downloader panel.
- Passed the top-page lesson title into frame capture so iframe/provider titles do not replace the intended filename.
- Added embedded-frame wiring, frame-ID preservation, and capture-routing regression coverage.

## 2.9.2 - 2026-08-25

- Fixed DigitalMarketer/course filename selection shown in the Loom recording: completed lesson checkboxes are no longer treated as the active lesson.
- Raised the visible heading nearest the player above course-level/sidebar labels, producing filenames such as `What You'll Need.mp4` instead of `Buyers From Scratch.mp4`.
- Stopped Download All from overwriting the real completion filename/message with the ambiguous status `Finished.`
- Added regression checks for LMS checkbox/title priority and preserved completion results.

## 2.9.1 - 2026-08-25

- Removed automatic decoded-page recording as the YouTube HTTP 403 fallback, eliminating full-duration capture timeouts.
- Refreshes YouTube player-response streams immediately before direct or merged downloads and retries once after an expired/403 response.
- Prunes cached signed media URLs when their explicit expiry has passed or their observation is older than four hours.
- Returns a prompt actionable error when YouTube exposes no fresh accessible URL; no player recording is started.
- Added signed-stream refresh, expiry-pruning, and no-YouTube-capture regression coverage.

## 2.9.0 - 2026-08-25

- Removed page-wide observation of high-frequency class and character-data mutations that could hang YouTube and complex SPAs.
- Removed the capture helper's whole-document mutation observer.
- Stopped Scan/Download All from automatically playing, muting, pausing, or seeking page videos.
- Added pre-play discovery from HTML attributes, OpenGraph metadata, JSON-LD, bounded JSON player configuration, and preloaded resource entries.
- Added support for already-signed YouTube cipher URLs while continuing to reject signatures requiring deciphering/access-control workarounds.
- Added performance and no-autoplay regression assertions.

## 2.8.0 - 2026-08-25

- Persisted bounded per-tab media/context state in session-only storage so Manifest V3 worker suspension no longer loses detections.
- Added a minimal main-world History API hook for reliable programmatic SPA navigation detection without polling.
- Changed HLS page recording to fallback-only behavior; fast fMP4 assembly and offscreen MPEG-TS conversion are attempted first.
- Included URL fragments in media-context identity so hash-routed lessons with identical titles reset correctly.
- Added regression coverage for session persistence, main-world SPA wiring, and HLS fast-path selection.

## 2.7.0 - 2026-08-24

- Made SPA lesson/video context switching atomic and event-driven; added History API detection and removed the recurring title scan.
- Coalesced YouTube player probes and changed decoded-player recording from the default path to a fallback for expired/HTTP 403 Googlevideo URLs.
- Generalized byte-range candidate deduplication while preserving signed identity parameters and useful size metadata.
- Ensured HLS MPEG-TS is converted into a genuine MP4 or WebM container; raw `.ts` output is no longer saved.
- Kept encrypted HLS, protected DASH, DRM, paywall, authentication, and access-control bypass out of scope.
- Added regression coverage for SPA context switching, zero-size/range deduplication, HLS output behavior, YouTube fallback, signed partial-range recovery, and service-worker media selection.

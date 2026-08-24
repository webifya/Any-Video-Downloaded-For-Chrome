# Changelog

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

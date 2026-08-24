# Changelog

## 2.7.0 - 2026-08-24

- Made SPA lesson/video context switching atomic and event-driven; added History API detection and removed the recurring title scan.
- Coalesced YouTube player probes and changed decoded-player recording from the default path to a fallback for expired/HTTP 403 Googlevideo URLs.
- Generalized byte-range candidate deduplication while preserving signed identity parameters and useful size metadata.
- Ensured HLS MPEG-TS is converted into a genuine MP4 or WebM container; raw `.ts` output is no longer saved.
- Kept encrypted HLS, protected DASH, DRM, paywall, authentication, and access-control bypass out of scope.
- Added regression coverage for SPA context switching, zero-size/range deduplication, HLS output behavior, YouTube fallback, signed partial-range recovery, and service-worker media selection.

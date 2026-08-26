# Upstream Comparison

## Baseline

- Upstream project: [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio), `main` at `89c0d230c3f1f792e5d9639781ebbf724c4efbfe` (verified 2026-08-27)
- This branch: [dreaum/Mineradio-Navidrome-Player](https://github.com/dreaum/Mineradio-Navidrome-Player/tree/main)
- Package identity: `mineradio-navidrome` `0.1.0`

The local branch and the upstream repository do not have a common Git ancestor, so this is a source-level functional comparison rather than a commit-range diff.

## Branch-specific Changes

- Adds a Navidrome provider backed by OpenSubsonic / Subsonic-compatible requests for library browsing, search, albums, artists, playlists, favourites, lyrics, cover art, and playback.
- Adds multi-server configuration with explicit HTTP confirmation, connection state reporting, and per-server active selection.
- Keeps credentials out of renderer state. The main process encrypts them with Electron secure storage in the current Windows user's application-data directory; the migration path re-encrypts prior local secrets without exposing plaintext to the UI.
- Adds a main-process media proxy so authentication data remains local while renderer playback, covers, and lyric requests use controlled application endpoints.
- Adds a unified local cache layer for Navidrome metadata, lyrics, covers, and network/audio fragments. Cover blobs use a bounded access-time eviction policy; the desktop build exposes one cache directory for lyrics, Chromium fragments, beat maps, and Wallpaper Engine scene copies.
- Adds local-library asset caching and prefetch for lyrics, covers, beat analysis, and media URLs, with cancellation and expiry handling to avoid repeated requests and decoding.
- Adds foreground resource controls: configurable foreground frame-rate caps, hidden/idle rendering short-circuits, lazy DOM rendering, and background-only application memory trimming with optional Windows memory-list release.
- Adds lifecycle cleanup for desktop lyrics, wallpaper overlays, and the mini player, releasing retained lyrics, beat maps, cover data URLs, object URLs, and renderer state when those surfaces close.
- Adds bounded range reads and metadata memory handling for large local MP3, FLAC, and M4A files, plus token checks so stale background library work cannot overwrite a newer library.
- Adds Windows audio-focus monitoring that can pause Mineradio when another media session is active and resume after the conflict clears.
- Keeps Mineradio's local-library playback and visual experience: lyric stage, particles, 3D playlist shelf, desktop lyrics, mini player, desktop mode, and visual controls.

These are capabilities observed in the current source tree; no fixed memory or FPS number is claimed without a device-specific benchmark.

## Deliberate Boundaries

- This repository is not a Navidrome service, music host, account provider, or installer release channel.
- `0.1.0` has no GitHub Release or update assets. Historical installation and release records are archived and must not be treated as Navidrome branch releases.

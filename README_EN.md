# Mineradio Navidrome Player

Mineradio Navidrome Player is a Windows Electron player branch based on Mineradio. It keeps the immersive lyric stage, particle visuals, 3D playlist shelf, mini player, and desktop mode while adding personal Navidrome library playback.

Development branch: [`Mineradio`](https://github.com/dreaum/Mineradio-Navidrome-Player/tree/Mineradio)

## Status

- Source version: `0.1.0`
- This repository currently provides source code only. No Windows installer or GitHub Release was published as part of this source sync.
- Navidrome connectivity uses OpenSubsonic / Subsonic-compatible endpoints and your own server account.

## Highlights

- Multiple Navidrome server profiles, switching, and connection validation
- Albums, artists, playlists, search, favourites, and lyrics
- Local media, cover, and lyric proxy with playback-quality selection
- Passwords are protected by Windows/Electron secure storage and are never committed to the repository
- Lyric stage, particles, 3D playlist shelf, desktop lyrics, mini player, and visual controls
- Local library import with MP3 / FLAC / M4A / WAV / OGG playback

## Development

```bash
npm install
npm start
npm test
npm run build:win
```

Build output is written to `dist/`. A successful local build is not a published release.

## Navidrome Setup

Enter your full Navidrome URL, username, and password in the app's server configuration. Prefer HTTPS. HTTP connections require explicit confirmation in the UI.

Configuration and encrypted credentials are stored only in the current Windows user's application data directory. See [PRIVACY.md](./PRIVACY.md).

## License

This branch is derived from [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) and is distributed under GPL-3.0-only. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).

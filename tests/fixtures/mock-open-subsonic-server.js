'use strict';

const http = require('node:http');

const port = Number(process.env.MINERADIO_MOCK_PORT) || 38453;
const host = '127.0.0.1';
const label = String(process.env.MINERADIO_MOCK_LABEL || 'Mock').replace(/[^a-z0-9 _-]/gi, '').trim() || 'Mock';

function silentWav(seconds) {
  const sampleRate = 8000;
  const dataSize = sampleRate * Math.max(1, Number(seconds) || 1);
  const wav = Buffer.alloc(44 + dataSize, 128);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

const wav = silentWav(90);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const songs = Array.from({ length: 165 }, (_, index) => ({
  id: `song-${index}`,
  title: `${label} Song ${index + 1}`,
  artist: index % 2 ? 'Glass Ensemble' : 'Mineradio Artist',
  album: `Mock Album ${Math.floor(index / 10) + 1}`,
  artistId: index % 2 ? 'artist-glass' : 'artist-mineradio',
  albumId: `album-${Math.floor(index / 10)}`,
  coverArt: `cover-${Math.floor(index / 10)}`,
  duration: 90,
  bitRate: 320,
}));
const playlists = new Map([
  ['playlist-1', { id: 'playlist-1', name: 'Server Mix', coverArt: 'cover-0', entry: songs.slice(0, 3) }],
]);
let nextPlaylistId = 2;

function payload(data) {
  return JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
}

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  const endpoint = url.pathname.replace(/^\/rest\//, '').replace(/\.view$/, '');
  if (endpoint === 'stream' || endpoint === 'getCoverArt') {
    const body = endpoint === 'stream' ? wav : png;
    const type = endpoint === 'stream' ? 'audio/wav' : 'image/png';
    const range = String(req.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Math.min(body.length, Number(range[1]) || 0);
      const end = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
      if (start > end || start >= body.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
        res.end();
        return;
      }
      const part = body.subarray(start, end + 1);
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': String(part.length), 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Accept-Ranges': 'bytes' });
      res.end(part);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(body.length), 'Accept-Ranges': 'bytes' });
    res.end(body);
    return;
  }

  if (endpoint === 'ping') return sendJson(res, { serverVersion: '0.99.0', type: 'mock', openSubsonic: true });
  if (endpoint === 'getLicense') return sendJson(res, { license: { valid: true } });
  if (endpoint === 'getAlbumList2') {
    const type = url.searchParams.get('type') || 'newest';
    const offset = Number(url.searchParams.get('offset')) || 0;
    const size = Number(url.searchParams.get('size')) || 12;
    const albums = Array.from({ length: Math.max(0, Math.min(size, 18 - offset)) }, (_, index) => ({ id: `album-${offset + index}`, name: `${type} Album ${offset + index + 1}`, artist: index % 2 ? 'Glass Ensemble' : 'Mineradio Artist', artistId: index % 2 ? 'artist-glass' : 'artist-mineradio', coverArt: `cover-${offset + index}`, songCount: 10 }));
    return sendJson(res, { albumList2: { album: albums } });
  }
  if (endpoint === 'getPlaylists') {
    const items = Array.from(playlists.values(), (playlist) => ({
      id: playlist.id,
      name: playlist.name,
      songCount: playlist.entry.length,
      coverArt: playlist.coverArt || '',
    }));
    return sendJson(res, { playlists: { playlist: items } });
  }
  if (endpoint === 'search3') {
    if (url.searchParams.get('query') === '""') {
      const offset = Number(url.searchParams.get('songOffset')) || 0;
      const count = Number(url.searchParams.get('songCount')) || 80;
      return sendJson(res, { searchResult3: { song: songs.slice(offset, offset + count) } });
    }
    return sendJson(res, { searchResult3: { song: songs.slice(0, 8), album: [{ id: 'album-0', name: 'Mock Album 1', artist: 'Mineradio Artist', coverArt: 'cover-0' }], artist: [{ id: 'artist-mineradio', name: 'Mineradio Artist', coverArt: 'cover-0' }] } });
  }
  if (endpoint === 'getArtists') return sendJson(res, { artists: { index: [{ name: 'G', artist: [{ id: 'artist-glass', name: 'Glass Ensemble', albumCount: 8 }] }, { name: 'M', artist: [{ id: 'artist-mineradio', name: 'Mineradio Artist', albumCount: 9 }] }] } });
  if (endpoint === 'getArtist') return sendJson(res, { artist: { id: url.searchParams.get('id'), name: 'Mineradio Artist', album: [{ id: 'album-0', name: 'Mock Album 1', artist: 'Mineradio Artist', coverArt: 'cover-0' }] } });
  if (endpoint === 'getAlbum') return sendJson(res, { album: { id: url.searchParams.get('id'), name: 'Mock Album 1', artist: 'Mineradio Artist', artistId: 'artist-mineradio', coverArt: 'cover-0', song: songs.slice(0, 10) } });
  if (endpoint === 'getPlaylist') {
    const id = String(url.searchParams.get('id') || '');
    const playlist = playlists.get(id);
    return sendJson(res, { playlist: playlist ? { ...playlist, entry: playlist.entry.slice() } : {} });
  }
  if (endpoint === 'createPlaylist') {
    const id = `playlist-${nextPlaylistId++}`;
    const entry = url.searchParams.getAll('songId').map((songId) => songs.find((song) => song.id === songId)).filter(Boolean);
    const playlist = { id, name: String(url.searchParams.get('name') || 'New Playlist'), coverArt: entry[0] && entry[0].coverArt || '', entry };
    playlists.set(id, playlist);
    return sendJson(res, { playlist: { ...playlist, entry: playlist.entry.slice() } });
  }
  if (endpoint === 'updatePlaylist') {
    const id = String(url.searchParams.get('playlistId') || '');
    const playlist = playlists.get(id);
    if (playlist) {
      if (url.searchParams.has('name')) playlist.name = String(url.searchParams.get('name') || playlist.name);
      const indexes = url.searchParams.getAll('songIndexToRemove').map(Number).filter(Number.isInteger).sort((a, b) => b - a);
      for (const index of indexes) {
        if (index >= 0 && index < playlist.entry.length) playlist.entry.splice(index, 1);
      }
      for (const songId of url.searchParams.getAll('songIdToAdd')) {
        const song = songs.find((item) => item.id === songId);
        if (song) playlist.entry.push(song);
      }
      playlist.coverArt = playlist.entry[0] && playlist.entry[0].coverArt || '';
    }
    return sendJson(res, {});
  }
  if (endpoint === 'deletePlaylist') {
    playlists.delete(String(url.searchParams.get('id') || ''));
    return sendJson(res, {});
  }
  if (endpoint === 'getStarred2') return sendJson(res, { starred2: { song: [{ ...songs[0], starred: '2026-01-01T00:00:00Z' }], album: [], artist: [] } });
  if (endpoint === 'getLyricsBySongId') return sendJson(res, { lyricsList: { structuredLyrics: [{ synced: true, line: [{ start: 0, duration: 2500, value: 'Mock synchronized lyric' }, { start: 2500, duration: 2500, value: 'Mineradio Navidrome' }] }] } });
  return sendJson(res, {});
});

server.listen(port, host, () => process.stdout.write(`MOCK_OPEN_SUBSONIC_READY http://${host}:${port}\n`));

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

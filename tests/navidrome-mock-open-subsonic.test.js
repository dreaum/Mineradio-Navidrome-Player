'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { makeToken } = require('../desktop/navidrome-client');
const { NavidromeService } = require('../desktop/navidrome-service');

function ok(payload) {
  return JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...payload } });
}

function startMockOpenSubsonic() {
  const calls = [];
  const songs = Array.from({ length: 165 }, (_, index) => ({
    id: `song-${index}`,
    title: `Song ${index}`,
    artist: index % 2 ? 'Artist B' : 'Artist A',
    album: `Album ${Math.floor(index / 10)}`,
    artistId: index % 2 ? 'artist-b' : 'artist-a',
    albumId: `album-${Math.floor(index / 10)}`,
    coverArt: `cover-${Math.floor(index / 10)}`,
    duration: 180 + index,
    bitRate: 320,
  }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const endpoint = url.pathname.replace(/^\/rest\//, '').replace(/\.view$/, '');
    assert.equal(url.searchParams.get('u'), 'listener');
    assert.equal(url.searchParams.get('t'), makeToken('secret', url.searchParams.get('s')));
    assert.equal(url.searchParams.has('p'), false);
    calls.push({ endpoint, params: new URLSearchParams(url.searchParams), range: String(req.headers.range || '') });

    if (endpoint === 'stream' || endpoint === 'getCoverArt') {
      const body = endpoint === 'stream' ? Buffer.from('0123456789') : Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const range = String(req.headers.range || '');
      if (endpoint === 'stream' && range === 'bytes=4-7') {
        res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Length': '4', 'Content-Range': 'bytes 4-7/10', 'Accept-Ranges': 'bytes' });
        res.end(body.subarray(4, 8));
        return;
      }
      res.writeHead(200, { 'Content-Type': endpoint === 'stream' ? 'audio/mpeg' : 'image/png', 'Content-Length': String(body.length), 'Accept-Ranges': 'bytes' });
      res.end(body);
      return;
    }

    let payload = {};
    if (endpoint === 'ping') payload = { serverVersion: '0.99.0', type: 'mock', openSubsonic: true };
    else if (endpoint === 'getLicense') payload = { license: { valid: true } };
    else if (endpoint === 'getAlbumList2') {
      const type = url.searchParams.get('type') || 'newest';
      payload = { albumList2: { album: [{ id: `${type}-album`, name: `${type} album`, artist: 'Artist A', coverArt: `${type}-cover` }] } };
    } else if (endpoint === 'getPlaylists') payload = { playlists: { playlist: [{ id: 'playlist-1', name: 'Server Mix', songCount: 2 }] } };
    else if (endpoint === 'search3') {
      if (url.searchParams.get('query') === '""') {
        const offset = Number(url.searchParams.get('songOffset')) || 0;
        const count = Number(url.searchParams.get('songCount')) || 80;
        payload = { searchResult3: { song: songs.slice(offset, offset + count) } };
      } else {
        payload = { searchResult3: { song: [songs[3]], album: [{ id: 'album-0', name: 'Album 0', artist: 'Artist B' }], artist: [{ id: 'artist-b', name: 'Artist B' }] } };
      }
    } else if (endpoint === 'getArtists') payload = { artists: { index: [{ name: 'A', artist: [{ id: 'artist-a', name: 'Artist A' }] }, { name: 'B', artist: [{ id: 'artist-b', name: 'Artist B' }] }] } };
    else if (endpoint === 'getArtist') payload = { artist: { id: 'artist-a', name: 'Artist A', album: [{ id: 'album-0', name: 'Album 0', artist: 'Artist A' }] } };
    else if (endpoint === 'getAlbum') payload = { album: { id: 'album-0', name: 'Album 0', artist: 'Artist A', artistId: 'artist-a', coverArt: 'cover-0', song: [{ id: 'song-album', title: 'Album Song' }] } };
    else if (endpoint === 'getPlaylist') payload = { playlist: { id: 'playlist-1', name: 'Server Mix', entry: [songs[0], songs[1]] } };
    else if (endpoint === 'getStarred2') payload = { starred2: { song: [{ ...songs[0], starred: '2026-01-01T00:00:00Z' }], album: [], artist: [] } };
    else if (endpoint === 'getLyricsBySongId') payload = url.searchParams.get('id') === 'song-empty'
      ? { lyricsList: { structuredLyrics: [] } }
      : { lyricsList: { structuredLyrics: [{ synced: true, line: [{ start: 1250, duration: 800, value: 'Timed lyric' }] }] } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(ok(payload));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function configStore(url) {
  return {
    list: () => [{ id: 'mock', name: 'Mock', url, username: 'listener', active: true }],
    active: () => ({ id: 'mock', name: 'Mock', url, username: 'listener', active: true }),
    get: (id) => id === 'mock' ? { id: 'mock', name: 'Mock', url, username: 'listener' } : null,
    password: () => 'secret',
    setActive: () => {},
    remove: () => true,
  };
}

test('mock OpenSubsonic covers browsing, paging, lyrics, media and mutations', async () => {
  const mock = await startMockOpenSubsonic();
  try {
    const service = new NavidromeService({ configStore: configStore(mock.url) });
    service.setMediaBaseUrl('http://127.0.0.1:54321');
    assert.equal((await service.verify({ url: mock.url, username: 'listener', password: 'secret', insecureConfirmed: true })).openSubsonic, true);

    const home = await service.home('mock');
    assert.equal(home.recent[0].name, 'recent album');
    assert.equal(home.playlists[0].name, 'Server Mix');
    assert.equal((await service.songs({ serverId: 'mock', offset: 0, size: 80 })).length, 80);
    assert.equal((await service.songs({ serverId: 'mock', offset: 80, size: 80 }))[0].id, 'song-80');
    assert.equal((await service.songs({ serverId: 'mock', offset: 160, size: 80 })).length, 5);
    assert.equal((await service.search('mock', 'Artist B')).artist[0].id, 'artist-b');
    assert.equal((await service.artists('mock')).length, 2);
    assert.equal((await service.artist('mock', 'artist-a')).albums[0].id, 'album-0');
    assert.equal((await service.album('mock', 'album-0')).song[0].artist, 'Artist A');
    assert.equal((await service.playlist('mock', 'playlist-1')).entry.length, 2);
    assert.equal((await service.favorites('mock')).song[0].starred, true);
    assert.deepEqual((await service.lyrics('mock', 'song-1')).lines, [{ t: 1.25, duration: 0.8, text: 'Timed lyric', source: 'navidrome' }]);
    assert.deepEqual((await service.lyrics('mock', 'song-empty')).lines, []);

    const mediaUrl = service.mediaPath('mock', 'stream', 'song-4', 192);
    const media = await service.mediaProxy.fetch(new URL(mediaUrl).searchParams.get('cap'), 'stream', 'bytes=4-7');
    assert.equal(media.status, 206);
    assert.equal(await media.text(), '4567');
    assert.deepEqual(service.mediaInfo(mediaUrl, 10), {
      ready: true,
      contentType: 'audio/mpeg',
      totalBytes: 10,
      bitRate: 8,
      requestedMaxBitRate: 192,
      updatedAt: service.mediaProxy.capabilities.get(new URL(mediaUrl).searchParams.get('cap')).mediaInfo.updatedAt,
    });
    await service.star('mock', 'song-1');
    await service.unstar('mock', 'song-1');
    await service.createPlaylist('mock', 'New Mix', ['song-1', 'song-2']);
    await service.updatePlaylist('mock', 'playlist-1', { name: 'Renamed' });
    await service.deletePlaylist('mock', 'playlist-1');

    const mediaCall = mock.calls.find((call) => call.endpoint === 'stream');
    assert.equal(mediaCall.params.get('maxBitRate'), '192');
    assert.equal(mediaCall.range, 'bytes=4-7');
    assert.equal(mock.calls.some((call) => call.endpoint === 'star' && call.params.get('id') === 'song-1'), true);
    assert.equal(mock.calls.some((call) => call.endpoint === 'createPlaylist' && call.params.getAll('songId').length === 2), true);
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
  }
});

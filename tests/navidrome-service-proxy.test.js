'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { NavidromeService, songFromApi, albumFromApi, artistFromApi } = require('../desktop/navidrome-service');

test('standard OpenSubsonic unknown metadata placeholders become concise Chinese fallbacks', () => {
  const song = songFromApi({ id: 'song-1', title: 'Track', artist: '[Unknown Artist]', album: 'Unknown Album' }, 'one');
  const album = albumFromApi({ id: 'album-1', name: '[Unknown Album]', artist: 'Unknown Artist' }, 'one');
  const artist = artistFromApi({ id: 'artist-1', name: '[Unknown Artist]' }, 'one');
  assert.equal(song.artist, '\u672a\u77e5\u6b4c\u624b');
  assert.equal(song.album, '\u672a\u77e5\u4e13\u8f91');
  assert.equal(album.name, '\u672a\u77e5\u4e13\u8f91');
  assert.equal(album.artist, '\u672a\u77e5\u6b4c\u624b');
  assert.equal(artist.name, '\u672a\u77e5\u6b4c\u624b');

  const displayFallback = songFromApi({
    id: 'song-display',
    title: 'Track',
    artist: '[Unknown Artist]',
    displayArtist: 'Display Artist',
    artists: [{ id: 'artist-display', name: 'Display Artist' }],
  }, 'one');
  assert.equal(displayFallback.artist, 'Display Artist');
  assert.equal(displayFallback.artistId, 'artist-display');
});

function configStore() {
  const servers = new Map([
    ['one', { id: 'one', url: 'https://one.example.test', username: 'listener' }],
    ['two', { id: 'two', url: 'https://two.example.test', username: 'listener' }],
  ]);
  return {
    list: () => Array.from(servers.values()).map((server) => ({ ...server, active: server.id === 'one' })),
    active: () => ({ ...servers.get('one'), active: true }),
    get: (id) => servers.get(id) ? { ...servers.get(id) } : null,
    password: () => 'secret',
    setActive: () => {},
    remove: () => true,
  };
}

function fakeClients(calls) {
  return ({ serverUrl }) => ({
    home: async () => {
      calls.home.push(serverUrl);
      return { recent: [{ id: serverUrl + '-recent' }], frequent: [], random: [], playlists: [] };
    },
    songs: async () => [], albums: async () => [], artists: async () => [], artist: async () => ({}), album: async () => ({}), search: async () => ({}), playlists: async () => [], playlist: async () => ({ entry: [{ id: 'a' }, { id: 'b' }] }), favorites: async () => ({}), lyrics: async () => ({}),
    media: async (endpoint, params, range) => {
      calls.media.push({ serverUrl, endpoint, params, range });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); controller.close(); } }), { status: range ? 206 : 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '4', 'content-range': range ? 'bytes 4-7/8' : '', 'accept-ranges': 'bytes' } });
    },
    nowPlaying: async () => ({}), scrobble: async () => ({}), star: async () => ({}), unstar: async () => ({}), createPlaylist: async () => ({}), updatePlaylist: async (_id, params) => {
      calls.updates.push(params);
      if (calls.failAfter && calls.updates.length >= calls.failAfter) {
        const error = new Error('failed');
        error.code = 'NAVIDROME_API_FAILED';
        throw error;
      }
      return {};
    }, deletePlaylist: async () => ({}), ping: async () => ({}), profile: async () => ({}),
  });
}

test('metadata cache is isolated by server and expires independently', async () => {
  let now = 1_000;
  const calls = { home: [], media: [], updates: [] };
  const service = new NavidromeService({ configStore: configStore(), clientFactory: fakeClients(calls), now: () => now });
  await service.home('one');
  await service.home('one');
  await service.home('two');
  assert.deepEqual(calls.home, ['https://one.example.test', 'https://two.example.test']);
  now += 24 * 60 * 60 * 1000 + 1;
  await service.home('one');
  assert.deepEqual(calls.home, ['https://one.example.test', 'https://two.example.test', 'https://one.example.test']);
});

test('editing a server can verify with its DPAPI-backed existing password', async () => {
  let received;
  const service = new NavidromeService({
    configStore: configStore(),
    clientFactory: (options) => {
      received = options;
      return { profile: async () => ({ serverVersion: 'test' }) };
    },
  });
  const profile = await service.verify({
    id: 'one',
    url: 'https://one.example.test',
    username: 'listener',
    password: '',
  });
  assert.equal(received.password, 'secret');
  assert.deepEqual(profile, { serverVersion: 'test' });
});

test('media capabilities keep bitrate and server identity private from the renderer', async () => {
  const calls = { home: [], media: [], updates: [] };
  const service = new NavidromeService({ configStore: configStore(), clientFactory: fakeClients(calls) });
  service.setMediaBaseUrl('http://127.0.0.1:3456');
  const url = service.mediaPath('two', 'stream', 'song-7', 192);
  assert.match(url, /^http:\/\/127\.0\.0\.1:3456\/api\/navidrome-media\?kind=stream&cap=/);
  assert.equal(url.includes('two.example.test'), false);
  assert.equal(url.includes('secret'), false);
  const capability = new URL(url).searchParams.get('cap');
  const upstream = await service.mediaProxy.fetch(capability, 'stream', 'bytes=1-');
  assert.equal(upstream.status, 206);
  assert.deepEqual(service.mediaInfo(url, 8), {
    ready: true,
    contentType: 'audio/mpeg',
    totalBytes: 8,
    bitRate: 8,
    requestedMaxBitRate: 192,
    updatedAt: service.mediaProxy.capabilities.get(capability).mediaInfo.updatedAt,
  });
  assert.deepEqual(calls.media, [{
    serverUrl: 'https://two.example.test', endpoint: 'stream', params: { id: 'song-7', maxBitRate: 192 }, range: 'bytes=1-',
  }]);
  await assert.rejects(service.mediaProxy.fetch('not-a-capability', 'stream'), (error) => error.code === 'NAVIDROME_MEDIA_CAPABILITY_INVALID');
  assert.throws(() => service.mediaInfo('https://two.example.test/rest/stream.view?cap=' + capability, 8), (error) => error.code === 'NAVIDROME_MEDIA_PROXY_INVALID');
});

test('playlist reorder reports partial changes and reloads the server state after a failed rebuild', async () => {
  const calls = { home: [], media: [], updates: [], failAfter: 2 };
  const service = new NavidromeService({ configStore: configStore(), clientFactory: fakeClients(calls) });
  const result = await service.reorderPlaylist('one', 'playlist-1', ['b', 'a']);
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.error, 'NAVIDROME_API_FAILED');
  assert.ok(result.playlist);
  assert.deepEqual(calls.updates, [
    { songIndexToRemove: ['1', '0'] },
    { songIdToAdd: ['b', 'a'] },
  ]);
});

test('playlist reorder rejects a partial song list before deleting anything', async () => {
  const calls = { home: [], media: [], updates: [] };
  const service = new NavidromeService({ configStore: configStore(), clientFactory: fakeClients(calls) });
  await assert.rejects(
    service.reorderPlaylist('one', 'playlist-1', ['b']),
    (error) => error && error.code === 'NAVIDROME_PLAYLIST_REORDER_INCOMPLETE'
  );
  assert.deepEqual(calls.updates, []);
});

test('playlist metadata mutations do not revoke an active media capability', async () => {
  const calls = { home: [], media: [], updates: [] };
  const service = new NavidromeService({ configStore: configStore(), clientFactory: fakeClients(calls) });
  service.setMediaBaseUrl('http://127.0.0.1:3456');
  const mediaUrl = service.mediaPath('one', 'stream', 'song-7', 0);
  const capability = new URL(mediaUrl).searchParams.get('cap');
  await service.updatePlaylist('one', 'playlist-1', { name: 'Renamed' });
  const upstream = await service.mediaProxy.fetch(capability, 'stream', 'bytes=0-');
  assert.equal(upstream.status, 206);
});

function request(port, target, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: target, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

test('loopback proxy rejects invalid capabilities and relays Range/206 without buffering audio', async () => {
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  const serverPath = path.join(__dirname, '..', 'server.js');
  delete require.cache[require.resolve(serverPath)];
  const server = require(serverPath);
  const calls = { home: [], media: [], updates: [] };
  const service = new NavidromeService({ configStore: configStore(), clientFactory: fakeClients(calls) });
  server.setNavidromeMediaProxy(service.mediaProxy);
  try {
    if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const port = server.address().port;
    service.setMediaBaseUrl(`http://127.0.0.1:${port}`);
    const denied = await request(port, '/api/navidrome-media?kind=stream&cap=invalid');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.length, 0);
    const issued = service.mediaPath('one', 'stream', 'song-9', 320);
    const ranged = await request(port, issued, { Range: 'bytes=4-7' });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers['content-range'], 'bytes 4-7/8');
    assert.deepEqual(ranged.body, Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(calls.media, [{
      serverUrl: 'https://one.example.test', endpoint: 'stream', params: { id: 'song-9', maxBitRate: 320 }, range: 'bytes=4-7',
    }]);
    const proxySource = fs.readFileSync(serverPath, 'utf8');
    const proxySection = proxySource.slice(proxySource.indexOf("if (pn === '/api/navidrome-media')"), proxySource.indexOf("if (LOGIN_EASTER_EGG_PROTECTED_ROUTES"));
    assert.equal(proxySection.includes('arrayBuffer()'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeStorage(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    value: (key) => values.get(key),
  };
}

function loadStore(api, storage) {
  const window = { navidrome: api, localStorage: storage };
  const context = vm.createContext({ window, localStorage: storage, indexedDB: null, console, Promise, Date, JSON, Array, Object, String, Number, Math, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'navidrome-store.js'), 'utf8'), context);
  return window.NavidromeStore;
}

test('NavidromeStore pages songs and persists isolated stable sessions', async () => {
  const calls = [];
  const albumCalls = [];
  let active = 'one';
  const servers = [{ id: 'one', active: true }, { id: 'two', active: false }];
  const api = {
    servers: async () => ({ ok: true, value: servers.map((item) => ({ ...item, active: item.id === active })) }),
    activeServer: async () => ({ ok: true, value: servers.find((item) => item.id === active) }),
    home: async () => ({ ok: true, value: { recent: [], frequent: [], random: [], playlists: [] } }),
    songs: async (options) => {
      calls.push({ ...options });
      const count = options.offset >= 160 ? 5 : 80;
      return { ok: true, value: Array.from({ length: count }, (_, index) => ({ id: `${options.serverId}-${options.offset + index}`, title: `Song ${options.offset + index}`, artist: index === 0 ? '[Unknown Artist]' : 'Artist', album: index === 0 ? 'Unknown Album' : 'Album', coverArt: `cover-${index}`, coverPath: `http://127.0.0.1:9999/api/navidrome-media?cap=${index}` })) };
    },
    albums: async (options) => {
      albumCalls.push({ ...options });
      const count = options.offset >= 160 ? 5 : 80;
      return { ok: true, value: Array.from({ length: count }, (_, index) => ({ id: `${options.serverId}-album-${options.offset + index}`, name: `Album ${options.offset + index}`, coverArt: `album-cover-${index}` })) };
    },
    activateServer: async (id) => { active = id; return { ok: true, value: servers.find((item) => item.id === id) }; },
    clearCache: async () => ({ ok: true, value: true }),
  };
  const storage = makeStorage({ 'mineradio-local-library-folder-v1': 'legacy' });
  const store = loadStore(api, storage);
  await store.initialize();
  assert.equal(storage.getItem('mineradio-local-library-folder-v1'), 'legacy');

  assert.equal((await store.loadSongs(true)).length, 80);
  assert.equal(store.state().songs[0].artist, '\u672a\u77e5\u6b4c\u624b');
  assert.equal(store.state().songs[0].album, '\u672a\u77e5\u4e13\u8f91');
  assert.equal((await store.loadSongs(false)).length, 160);
  assert.equal((await store.loadSongs(false)).length, 165);
  assert.deepEqual(calls.map((call) => call.offset), [0, 80, 160]);
  assert.equal(store.state().songsComplete, true);

  assert.equal((await store.loadAlbums(true)).length, 80);
  assert.equal((await store.loadAlbums(false)).length, 160);
  assert.equal((await store.loadAlbums(false)).length, 165);
  assert.deepEqual(albumCalls.map((call) => ({ serverId: call.serverId, type: call.type, offset: call.offset, size: call.size })), [
    { serverId: 'one', type: 'alphabeticalByName', offset: 0, size: 80 },
    { serverId: 'one', type: 'alphabeticalByName', offset: 80, size: 80 },
    { serverId: 'one', type: 'alphabeticalByName', offset: 160, size: 80 },
  ]);
  assert.equal(store.state().albumsComplete, true);

  store.writeSession('one', { currentIndex: 0, currentTime: 12, quality: '192', queue: [{ type: 'navidrome', serverId: 'one', id: 'song-a', title: 'A', coverArt: 'cover-a', coverPath: 'http://127.0.0.1:9999/api/navidrome-media?cap=expired' }] });
  store.writeSession('two', { currentIndex: 0, currentTime: 8, quality: 'original', queue: [{ type: 'navidrome', serverId: 'two', id: 'song-b', title: 'B', coverArt: 'cover-b' }] });
  assert.equal(store.readSession('one').queue[0].coverPath, undefined);
  assert.equal(store.readSession('one').queue[0].cover, undefined);
  assert.equal(store.readSession('one').queue[0].id, 'song-a');
  assert.equal(store.readSession('two').queue[0].id, 'song-b');

  await store.switchServer('two');
  assert.equal(store.currentServerId(), 'two');
  assert.equal(store.state().songs.length, 0);
  assert.equal(store.state().albums.length, 0);
  assert.equal(store.state().albumOffset, 0);
  assert.equal(store.state().albumsComplete, false);
  assert.equal((await store.loadAlbums(true))[0].id, 'two-album-0');
  assert.equal(store.state().albums.every((album) => album.serverId === 'two'), true);
});

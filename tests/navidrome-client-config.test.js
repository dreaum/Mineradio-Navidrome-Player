'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  NavidromeClient,
  NavidromeError,
  makeToken,
  normalizeServerUrl,
} = require('../desktop/navidrome-client');
const { NavidromeConfigStore } = require('../desktop/navidrome-config-store');

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function cryptoAdapter() {
  return {
    encryptString(value) { return Buffer.from(`sealed:${value}`, 'utf8'); },
    decryptString(value) {
      const text = Buffer.from(value).toString('utf8');
      if (!text.startsWith('sealed:')) throw new Error('invalid sealed payload');
      return text.slice('sealed:'.length);
    },
  };
}

test('normalizes only HTTP(S) server bases and keeps a reverse-proxy path', () => {
  assert.equal(normalizeServerUrl(' HTTPS://Music.Example.test/library///?ignored=1#fragment '), 'https://music.example.test/library');
  assert.throws(() => normalizeServerUrl('ftp://music.example.test'), (error) => error.code === 'SERVER_URL_PROTOCOL');
  assert.throws(() => normalizeServerUrl('https://user:pass@music.example.test'), (error) => error.code === 'SERVER_URL_INVALID');
});

test('Subsonic token authentication never puts the password in the request URL', () => {
  const client = new NavidromeClient({
    serverUrl: 'https://music.example.test/navidrome',
    username: 'listener',
    password: 'not-in-the-url',
    fetchImpl: async () => response({ 'subsonic-response': { status: 'ok' } }),
  });
  const url = client.authenticatedUrl('ping');
  assert.equal(url.pathname, '/navidrome/rest/ping.view');
  assert.equal(url.searchParams.get('u'), 'listener');
  assert.equal(url.searchParams.get('t'), makeToken('not-in-the-url', url.searchParams.get('s')));
  assert.equal(url.searchParams.has('p'), false);
  assert.equal(url.toString().includes('not-in-the-url'), false);
});

test('song pagination uses the Navidrome-supported search3 contract', async () => {
  let requestedUrl;
  const client = new NavidromeClient({
    serverUrl: 'https://music.example.test',
    username: 'listener',
    password: 'secret',
    fetchImpl: async (url) => {
      requestedUrl = url;
      return response({
        'subsonic-response': {
          status: 'ok',
          searchResult3: { song: [{ id: 'song-21', title: 'Twenty One' }] },
        },
      });
    },
  });

  const songs = await client.songs({ offset: 20, size: 10 });
  assert.equal(requestedUrl.pathname, '/rest/search3.view');
  assert.equal(requestedUrl.searchParams.get('query'), '""');
  assert.equal(requestedUrl.searchParams.get('artistCount'), '0');
  assert.equal(requestedUrl.searchParams.get('albumCount'), '0');
  assert.equal(requestedUrl.searchParams.get('songOffset'), '20');
  assert.equal(requestedUrl.searchParams.get('songCount'), '10');
  assert.deepEqual(songs, [{ id: 'song-21', title: 'Twenty One' }]);
});

test('song pagination prefers getAlphabeticalByName and preserves an empty page', async () => {
  const calls = [];
  const client = new NavidromeClient({
    serverUrl: 'https://music.example.test',
    username: 'listener',
    password: 'secret',
    fetchImpl: async (url) => {
      calls.push(url);
      return response({
        'subsonic-response': {
          status: 'ok',
          alphabeticalByName: { song: [] },
        },
      });
    },
  });

  assert.deepEqual(await client.songs({ offset: 200, size: 80 }), []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/rest/getAlphabeticalByName.view');
  assert.equal(calls[0].searchParams.get('offset'), '200');
  assert.equal(calls[0].searchParams.get('size'), '80');
  assert.deepEqual(NavidromeClient.extractSongPage({ songList2: { song: [] } }), { supported: true, songs: [] });
});

test('authentication failures and server text are sanitized before crossing the API boundary', async () => {
  const client = new NavidromeClient({
    serverUrl: 'https://music.example.test',
    username: 'listener',
    password: 'private-password',
    fetchImpl: async () => response({
      'subsonic-response': {
        status: 'failed',
        error: { code: 40, message: 'private-password https://music.example.test/rest/ping.view' },
      },
    }),
  });
  await assert.rejects(client.ping(), (error) => {
    assert.ok(error instanceof NavidromeError);
    assert.equal(error.code, 'NAVIDROME_AUTH_FAILED');
    assert.equal(error.message, 'Authentication failed');
    assert.equal(error.message.includes('private-password'), false);
    return true;
  });
});

test('lyrics expose only synchronized OpenSubsonic lines', async () => {
  const client = new NavidromeClient({
    serverUrl: 'https://music.example.test',
    username: 'listener',
    password: 'secret',
    fetchImpl: async () => response({
      'subsonic-response': {
        status: 'ok',
        lyricsList: {
          structuredLyrics: [
            { synced: false, line: [{ value: 'plain structure' }] },
            { synced: true, line: [{ start: 1234, duration: 900, value: 'timed line' }] },
          ],
        },
      },
    }),
  });
  assert.deepEqual(await client.lyrics('song-1'), {
    synced: true,
    lines: [{ start: 1234, duration: 900, text: 'timed line' }],
  });
});

test('embedded song metadata lyrics are parsed before remote lyric fallbacks', async () => {
  let endpoints = [];
  const client = new NavidromeClient({
    serverUrl: 'https://music.example.test',
    username: 'listener',
    password: 'secret',
    fetchImpl: async (url) => {
      endpoints.push(url.pathname);
      return response({
        'subsonic-response': {
          status: 'ok',
          song: { lyrics: '[00:01.250] Embedded line\n[00:02.500] Next line' },
        },
      });
    },
  });
  assert.deepEqual(await client.lyrics('song-embedded'), {
    synced: true,
    lines: [
      { start: 1250, duration: 0, text: 'Embedded line' },
      { start: 2500, duration: 0, text: 'Next line' },
    ],
  });
  assert.deepEqual(endpoints, ['/rest/getSong.view']);
});

test('audio metadata fallback maps synchronized tags and embedded LRC', () => {
  assert.deepEqual(NavidromeClient.parseAudioMetadataLyrics({ common: { lyrics: [{
    syncText: [{ timestamp: 2250, text: 'Tagged line' }, { timestamp: 3250, text: 'Next tagged line' }],
  }] } }), {
    synced: true,
    lines: [
      { start: 2250, duration: 0, text: 'Tagged line' },
      { start: 3250, duration: 0, text: 'Next tagged line' },
    ],
  });
  assert.deepEqual(NavidromeClient.parseAudioMetadataLyrics({ common: { lyrics: [{
    text: '[00:03.500] LRC tag line', syncText: [],
  }] } }), {
    synced: true,
    lines: [{ start: 3500, duration: 0, text: 'LRC tag line' }],
  });
  assert.deepEqual(NavidromeClient.parseAudioMetadataLyrics({
    common: {},
    native: { vorbis: [{ id: 'SYNCEDLYRICS', value: '[00:04.250] Native Vorbis line' }] },
  }), {
    synced: true,
    lines: [{ start: 4250, duration: 0, text: 'Native Vorbis line' }],
  });
  assert.deepEqual(NavidromeClient.parseAudioMetadataLyrics({
    common: { comment: [{ text: '[00:05.000] Comment lyric line' }] },
    native: {},
  }), {
    synced: true,
    lines: [{ start: 5000, duration: 0, text: 'Comment lyric line' }],
  });
  assert.equal(NavidromeClient.parseAudioMetadataLyrics({
    common: { comment: [{ text: 'ordinary album note' }] },
    native: {},
  }), null);
});

test('audio metadata fallback reads a bounded prefix and cancels the remote body', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled = true; },
  });
  const bytes = await NavidromeClient.readBodyPrefix(new Response(body), 2500);
  assert.equal(bytes.length, 2500);
  assert.equal(cancelled, true);
});

test('audio metadata fallback follows declared ID3 and FLAC metadata lengths', () => {
  const id3 = Buffer.alloc(10);
  id3.write('ID3', 0, 'ascii');
  id3[6] = 0;
  id3[7] = 0;
  id3[8] = 7;
  id3[9] = 104;
  assert.equal(NavidromeClient.audioMetadataPrefixLength(id3), 1010);

  const flac = Buffer.alloc(8);
  flac.write('fLaC', 0, 'ascii');
  flac[4] = 0x80;
  flac.writeUIntBE(34, 5, 3);
  assert.equal(NavidromeClient.audioMetadataPrefixLength(flac), 42);
  assert.equal(NavidromeClient.audioMetadataPrefixLength(Buffer.from('not audio')), 0);
});

test('lyrics fall back to bounded original-audio metadata after server endpoints are empty', async () => {
  const client = new NavidromeClient({
    serverUrl: 'https://music.example.test',
    username: 'listener',
    password: 'secret',
    fetchImpl: async () => response({ 'subsonic-response': { status: 'ok' } }),
  });
  client.request = async (endpoint) => endpoint === 'getSong'
    ? { song: { id: 'song-audio-tag', contentType: 'audio/mpeg' } }
    : {};
  let fallback;
  client.embeddedAudioLyrics = async (songId, contentType) => {
    fallback = { songId, contentType };
    return { synced: true, lines: [{ start: 1000, duration: 0, text: 'Audio tag' }] };
  };
  assert.deepEqual(await client.lyrics('song-audio-tag'), {
    synced: true,
    lines: [{ start: 1000, duration: 0, text: 'Audio tag' }],
  });
  assert.deepEqual(fallback, { songId: 'song-audio-tag', contentType: 'audio/mpeg' });
});

test('server records require encrypted secrets, reject duplicate identities, and gate HTTP', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-navidrome-config-'));
  try {
    const store = new NavidromeConfigStore({ directory, cryptoAdapter: cryptoAdapter() });
    assert.throws(() => store.save({ url: 'http://music.example.test', username: 'a', password: 'secret' }), (error) => error.code === 'NAVIDROME_HTTP_CONFIRMATION_REQUIRED');
    assert.throws(() => store.save({ url: '  http://music.example.test  ', username: 'a', password: 'secret' }), (error) => error.code === 'NAVIDROME_HTTP_CONFIRMATION_REQUIRED');

    const saved = store.save({
      name: 'Home server',
      url: 'http://music.example.test/',
      username: 'Listener',
      password: 'secret',
      insecureConfirmed: true,
    });
    assert.equal(saved.insecure, true);
    assert.ok(saved.insecureAcceptedAt);
    assert.equal(store.password(saved.id), 'secret');
    assert.deepEqual(Object.keys(store.list()[0]).sort(), ['active', 'connectionStatus', 'createdAt', 'id', 'insecure', 'insecureAcceptedAt', 'name', 'profile', 'updatedAt', 'url', 'username']);
    assert.equal(store.list()[0].connectionStatus, 'unknown');

    const configText = fs.readFileSync(path.join(directory, 'servers.json'), 'utf8');
    const secretText = fs.readFileSync(path.join(directory, 'server-secrets.json'), 'utf8');
    assert.equal(configText.includes('secret'), false);
    assert.equal(secretText.includes('secret'), false);
    assert.throws(() => store.save({
      url: 'http://music.example.test', username: 'listener', password: 'another-secret', insecureConfirmed: true,
    }), (error) => error.code === 'NAVIDROME_SERVER_DUPLICATE');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('saving a server fails closed when Windows credential encryption is unavailable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-navidrome-no-crypto-'));
  try {
    const store = new NavidromeConfigStore({ directory });
    assert.throws(() => store.save({ url: 'https://music.example.test', username: 'a', password: 'secret' }), (error) => error.code === 'NAVIDROME_ENCRYPTION_UNAVAILABLE');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

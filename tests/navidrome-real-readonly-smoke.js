'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { NavidromeClient } = require('../desktop/navidrome-client');
const { decryptChromiumV10, unprotectDpapiCurrentUser } = require('../desktop/navidrome-secret-migration');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function findLocalState(root) {
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isFile() && entry.name === 'Local State') return file;
      if (entry.isDirectory()) queue.push(file);
    }
  }
  throw new Error('NAVIDROME_LOCAL_STATE_NOT_FOUND');
}

async function decryptActivePassword(userData, serverId) {
  const secrets = readJson(path.join(userData, 'navidrome', 'server-secrets.json'));
  const encoded = String(secrets.values && secrets.values[serverId] || '');
  if (!encoded) throw new Error('NAVIDROME_SECRET_MISSING');
  const localState = readJson(findLocalState(userData));
  const protectedKey = Buffer.from(String(localState.os_crypt && localState.os_crypt.encrypted_key || ''), 'base64');
  if (protectedKey.length <= 5 || protectedKey.subarray(0, 5).toString('ascii') !== 'DPAPI') {
    throw new Error('NAVIDROME_DPAPI_KEY_INVALID');
  }
  const key = await unprotectDpapiCurrentUser(protectedKey.subarray(5));
  try {
    const plaintext = decryptChromiumV10(Buffer.from(encoded, 'base64'), key);
    try {
      return plaintext.toString('utf8');
    } finally {
      plaintext.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

async function scanMediaMarkers(client, songId) {
  const response = await client.media('download', { id: songId });
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('NAVIDROME_MEDIA_STREAM_UNAVAILABLE');
  const reader = response.body.getReader();
  const markerNames = ['LYRICS', 'UNSYNCEDLYRICS', 'SYNCEDLYRICS', 'USLT', 'SYLT', 'LYRICSBEGIN', 'LYRICS200'];
  const markerPatterns = [];
  for (const name of markerNames) {
    markerPatterns.push({ name, encoding: 'ascii', bytes: Buffer.from(name, 'ascii') });
    markerPatterns.push({ name, encoding: 'utf16le', bytes: Buffer.from(name, 'utf16le') });
    const utf16be = Buffer.from(name, 'utf16le');
    for (let index = 0; index + 1 < utf16be.length; index += 2) {
      const byte = utf16be[index];
      utf16be[index] = utf16be[index + 1];
      utf16be[index + 1] = byte;
    }
    markerPatterns.push({ name, encoding: 'utf16be', bytes: utf16be });
  }
  const matches = [];
  const seen = new Set();
  let tail = Buffer.alloc(0);
  let consumed = 0;
  const digest = crypto.createHash('sha256');
  const overlapBytes = 256;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value || []);
      if (!chunk.length) continue;
      digest.update(chunk);
      const window = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      const windowOffset = consumed - tail.length;
      for (const marker of markerPatterns) {
        let cursor = 0;
        while (cursor < window.length) {
          const index = window.indexOf(marker.bytes, cursor);
          if (index < 0) break;
          const offset = windowOffset + index;
          const key = `${marker.name}:${marker.encoding}:${offset}`;
          if (!seen.has(key)) {
            seen.add(key);
            matches.push({ marker: marker.name, encoding: marker.encoding, offset });
          }
          cursor = index + 1;
        }
      }
      const ascii = window.toString('latin1');
      const timePattern = /\[(?:\d{1,3}:)?\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]|\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g;
      let timeMatch;
      while ((timeMatch = timePattern.exec(ascii))) {
        const offset = windowOffset + timeMatch.index;
        const key = `LRC_TIME:ascii:${offset}`;
        if (!seen.has(key)) {
          seen.add(key);
          matches.push({ marker: 'LRC_TIME', encoding: 'ascii', offset });
        }
        if (matches.length >= 128) break;
      }
      consumed += chunk.length;
      tail = window.subarray(Math.max(0, window.length - overlapBytes));
    }
  } finally {
    try { await reader.cancel(); } catch (_error) { }
  }
  return { bytesScanned: consumed, sha256: digest.digest('hex').toUpperCase(), matches: matches.slice(0, 128) };
}

async function main() {
  if (process.env.MINERADIO_REAL_READONLY !== '1') throw new Error('MINERADIO_REAL_READONLY_REQUIRED');
  const userData = path.resolve(String(process.env.MINERADIO_REAL_USERDATA || ''));
  if (!path.isAbsolute(userData) || !fs.statSync(userData).isDirectory()) throw new Error('MINERADIO_REAL_USERDATA_INVALID');
  const config = readJson(path.join(userData, 'navidrome', 'servers.json'));
  const server = (config.servers || []).find((item) => item.id === config.activeServerId);
  if (!server) throw new Error('NAVIDROME_SERVER_NOT_SELECTED');
  const password = await decryptActivePassword(userData, server.id);
  const client = new NavidromeClient({ serverUrl: server.url, username: server.username, password });

  const profile = await client.profile();
  const [home, songs, albums, artists, playlists, favorites] = await Promise.all([
    client.home(),
    client.songs({ offset: 0, size: 20 }),
    client.albums({ offset: 0, size: 20 }),
    client.artists(),
    client.playlists(),
    client.favorites(),
  ]);
  if (!songs.length) throw new Error('NAVIDROME_REAL_LIBRARY_EMPTY');

  let exactSong = null;
  let exactSongId = String(process.env.MINERADIO_REAL_SONG_ID || '').trim();
  const exactSongQuery = String(process.env.MINERADIO_REAL_SONG_QUERY || '').trim();
  if (!exactSongId && exactSongQuery) {
    const result = await client.search(exactSongQuery);
    const normalizedQuery = exactSongQuery.toLowerCase();
    const match = (result.song || []).find((song) => String(song.title || song.name || '').toLowerCase().includes(normalizedQuery))
      || (result.song || [])[0];
    exactSongId = String(match && match.id || '');
    if (!exactSongId) throw new Error('NAVIDROME_REAL_SONG_NOT_FOUND');
  }
  if (exactSongId) {
    const songResponse = await client.request('getSong', { id: exactSongId });
    const songRecord = songResponse.song || {};
    const lyricResult = await client.lyrics(exactSongId);
    let media = await client.mediaPrefix(exactSongId, 64 * 1024);
    let required = NavidromeClient.audioMetadataPrefixLength(media.bytes) || 2 * 1024 * 1024;
    for (let attempt = 0; required > media.bytes.length && attempt < 3; attempt += 1) {
      media = await client.mediaPrefix(exactSongId, Math.min(required, 8 * 1024 * 1024));
      required = NavidromeClient.audioMetadataPrefixLength(media.bytes) || required;
    }
    const { parseBuffer } = await import('music-metadata');
    const metadata = await parseBuffer(media.bytes, { mimeType: media.contentType || songRecord.contentType || undefined }, { duration: false, skipCovers: true });
    const nativeTagIds = Array.from(new Set(Object.values(metadata.native || {}).flatMap((tags) => Array.isArray(tags) ? tags : [])
      .map((tag) => String(tag && tag.id || '')))).sort();
    const tailResponse = await client.media('download', { id: exactSongId }, 'bytes=-65536');
    const tail = Buffer.from(await tailResponse.arrayBuffer());
    const tailAscii = tail.toString('latin1');
    const flacBlocks = [];
    const vorbisKeys = [];
    if (media.bytes.subarray(0, 4).toString('ascii') === 'fLaC') {
      let offset = 4;
      while (offset + 4 <= media.bytes.length) {
        const type = media.bytes[offset] & 0x7f;
        const last = (media.bytes[offset] & 0x80) !== 0;
        const length = media.bytes.readUIntBE(offset + 1, 3);
        const start = offset + 4;
        const end = start + length;
        flacBlocks.push({ type, length, last });
        if (end > media.bytes.length) break;
        if (type === 4 && length >= 8) {
          let cursor = start;
          const vendorLength = media.bytes.readUInt32LE(cursor); cursor += 4 + vendorLength;
          if (cursor + 4 <= end) {
            const count = media.bytes.readUInt32LE(cursor); cursor += 4;
            for (let index = 0; index < count && cursor + 4 <= end; index += 1) {
              const size = media.bytes.readUInt32LE(cursor); cursor += 4;
              if (cursor + size > end) break;
              const entry = media.bytes.subarray(cursor, cursor + size).toString('utf8'); cursor += size;
              const separator = entry.indexOf('=');
              if (separator > 0) vorbisKeys.push(entry.slice(0, separator));
            }
          }
        }
        offset = end;
        if (last) break;
      }
    }
    const apeKeys = [];
    const apeFooter = tail.lastIndexOf(Buffer.from('APETAGEX', 'ascii'));
    if (apeFooter >= 0 && apeFooter + 32 <= tail.length) {
      const tagSize = tail.readUInt32LE(apeFooter + 12);
      const itemCount = tail.readUInt32LE(apeFooter + 16);
      let offset = Math.max(0, apeFooter + 32 - tagSize);
      if (tail.subarray(offset, offset + 8).toString('ascii') === 'APETAGEX') offset += 32;
      for (let index = 0; index < itemCount && offset + 8 < apeFooter; index += 1) {
        const valueSize = tail.readUInt32LE(offset);
        const keyEnd = tail.indexOf(0, offset + 8);
        if (keyEnd < 0 || keyEnd >= apeFooter) break;
        apeKeys.push(tail.subarray(offset + 8, keyEnd).toString('utf8'));
        offset = keyEnd + 1 + valueSize;
      }
    }
    exactSong = {
      serverPath: String(songRecord.path || ''),
      serverFields: Object.keys(songRecord).sort(),
      contentType: media.contentType || String(songRecord.contentType || ''),
      metadataBytes: media.bytes.length,
      declaredMetadataBytes: required,
      nativeTagIds,
      nativeGroups: Object.keys(metadata.native || {}).sort(),
      commonFields: Object.keys(metadata.common || {}).sort(),
      formatFields: Object.keys(metadata.format || {}).sort(),
      tailBytes: tail.length,
      tailRange: String(tailResponse.headers.get('content-range') || ''),
      tailMarkers: {
        apev2: apeFooter >= 0,
        lyrics3: /LYRICS(?:BEGIN|200)/i.test(tailAscii),
        id3v1: tail.length >= 128 && tail.subarray(tail.length - 128, tail.length - 125).toString('ascii') === 'TAG',
      },
      apeKeys,
      flacBlocks,
      vorbisKeys,
      commentLength: String(songRecord.comment || '').length,
      commentLooksTimed: /\[\d{1,3}:\d{1,2}(?:\.\d{1,3})?\]/.test(String(songRecord.comment || '')),
      displayArtistPresent: !!String(songRecord.displayArtist || '').trim(),
      artistPresent: !!String(songRecord.artist || '').trim(),
      lyricAvailable: !!((lyricResult.lines && lyricResult.lines.length) || lyricResult.text),
      synchronized: !!(lyricResult.synced && lyricResult.lines && lyricResult.lines.length),
    };
    if (process.env.MINERADIO_REAL_SCAN_MEDIA === '1') exactSong.fullMediaScan = await scanMediaMarkers(client, exactSongId);
    if (process.env.MINERADIO_REAL_EXACT_ONLY === '1') {
      process.stdout.write(`${JSON.stringify({ ok: true, exactSong }, null, 2)}\n`);
      return;
    }
  }

  const firstSong = songs[0];
  const search = await client.search(String(firstSong.title || firstSong.name || '').trim());
  const playlistDetails = await Promise.all(playlists.slice(0, 8).map((playlist) => client.playlist(playlist.id)));
  const playlistSongMap = new Map();
  for (let songIndex = 0; songIndex < 12 && playlistSongMap.size < 32; songIndex += 1) {
    for (const playlist of playlistDetails) {
      const song = (playlist.entry || [])[songIndex];
      if (song && song.id && !playlistSongMap.has(song.id)) playlistSongMap.set(song.id, song);
      if (playlistSongMap.size >= 32) break;
    }
  }
  const lyricSamples = Array.from(playlistSongMap.values()).slice(0, 32);
  if (!lyricSamples.length) lyricSamples.push(...songs.slice(0, 12));
  const lyricResults = await Promise.all(lyricSamples.map((song) => client.lyrics(song.id).catch(() => ({ synced: false }))));
  const { parseBuffer } = await import('music-metadata');
  const embeddedTagResults = [];
  for (const song of lyricSamples.slice(0, 20)) {
    try {
      const response = await client.media('download', { id: song.id }, 'bytes=0-2097151');
      const bytes = Buffer.from(await response.arrayBuffer());
      const metadata = await parseBuffer(bytes, { mimeType: response.headers.get('content-type') || song.contentType || undefined }, { duration: false, skipCovers: true });
      const plain = Array.isArray(metadata.common.lyrics) ? metadata.common.lyrics.filter(Boolean).length : 0;
      const synchronized = Array.isArray(metadata.common.synchronizedLyrics) ? metadata.common.synchronizedLyrics.filter(Boolean).length : 0;
      const lyricTagIds = Object.values(metadata.native || {}).flatMap((tags) => Array.isArray(tags) ? tags : [])
        .map((tag) => String(tag && tag.id || ''))
        .filter((id) => /lyr|sylt|uslt/i.test(id));
      embeddedTagResults.push({ parsed: true, plain, synchronized, lyricTagIds, status: response.status, type: String(response.headers.get('content-type') || song.contentType || 'unknown').split(';')[0] });
    } catch (_error) {
      embeddedTagResults.push({ parsed: false, plain: 0, synchronized: 0, status: null, type: String(song.contentType || 'unknown').split(';')[0] });
    }
  }
  const embeddedTagFormats = embeddedTagResults.reduce((counts, item) => {
    counts[item.type] = (counts[item.type] || 0) + 1;
    return counts;
  }, {});
  const embeddedLyricTagIds = Array.from(new Set(embeddedTagResults.flatMap((item) => item.lyricTagIds || []))).sort();
  const coverId = firstSong.coverArt || firstSong.albumId || '';
  const cover = coverId ? await client.media('getCoverArt', { id: coverId }, 'bytes=0-1') : null;
  const stream = await client.media('stream', { id: firstSong.id }, 'bytes=0-1');
  if (stream.body && typeof stream.body.cancel === 'function') await stream.body.cancel();
  if (cover && cover.body && typeof cover.body.cancel === 'function') await cover.body.cancel();

  let playlistEntries = null;
  if (playlistDetails.length) playlistEntries = (playlistDetails[0].entry || []).length;
  let albumSongs = null;
  if (albums.length) albumSongs = ((await client.album(albums[0].id)).song || []).length;
  let artistAlbums = null;
  if (artists.length) artistAlbums = ((await client.artist(artists[0].id)).album || []).length;

  const summary = {
    ok: true,
    profile: { openSubsonic: profile.openSubsonic, hasServerVersion: !!profile.serverVersion },
    home: {
      recent: home.recent.length,
      frequent: home.frequent.length,
      random: home.random.length,
      playlists: home.playlists.length,
    },
    library: { songs: songs.length, albums: albums.length, artists: artists.length },
    details: { albumSongs, artistAlbums, playlistEntries },
    search: { songs: (search.song || []).length, albums: (search.album || []).length, artists: (search.artist || []).length },
    favorites: {
      songs: (favorites.song || []).length,
      albums: (favorites.album || []).length,
      artists: (favorites.artist || []).length,
    },
    lyrics: {
      sampled: lyricResults.length,
      available: lyricResults.filter((item) => (item.lines && item.lines.length) || item.text).length,
      synchronized: lyricResults.filter((item) => item.synced && item.lines && item.lines.length).length,
      embeddedTagSampled: embeddedTagResults.length,
      embeddedTagParsed: embeddedTagResults.filter((item) => item.parsed).length,
      embeddedTagAvailable: embeddedTagResults.filter((item) => item.plain || item.synchronized).length,
      embeddedTagFormats,
      embeddedLyricTagIds,
    },
    media: {
      streamStatus: stream.status,
      streamRange: !!stream.headers.get('content-range'),
      coverStatus: cover ? cover.status : null,
      coverType: cover ? String(cover.headers.get('content-type') || '').split(';')[0] : null,
    },
    exactSong,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error && (error.code || error.message) || 'NAVIDROME_REAL_SMOKE_FAILED')}\n`);
  process.exitCode = 1;
});

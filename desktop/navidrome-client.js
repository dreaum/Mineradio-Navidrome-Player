const crypto = require('crypto');

const EMBEDDED_LYRICS_PROBE_BYTES = 64 * 1024;
const EMBEDDED_LYRICS_PREFIX_BYTES = 2 * 1024 * 1024;
const EMBEDDED_LYRICS_MAX_BYTES = 8 * 1024 * 1024;

class NavidromeError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'NavidromeError';
    this.code = code || 'NAVIDROME_REQUEST_FAILED';
    this.status = Number(status) || 0;
  }
}

function normalizeServerUrl(value) {
  const input = String(value || '').trim();
  if (!input) throw new NavidromeError('SERVER_URL_REQUIRED');
  let parsed;
  try {
    parsed = new URL(input);
  } catch (_e) {
    throw new NavidromeError('SERVER_URL_INVALID');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NavidromeError('SERVER_URL_PROTOCOL');
  }
  if (parsed.username || parsed.password || !parsed.hostname) {
    throw new NavidromeError('SERVER_URL_INVALID');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function makeToken(password, salt) {
  return crypto.createHash('md5').update(String(password) + String(salt), 'utf8').digest('hex');
}

function subsonicResponse(payload) {
  if (!payload || typeof payload !== 'object') throw new NavidromeError('NAVIDROME_RESPONSE_INVALID');
  const response = payload['subsonic-response'];
  if (!response || typeof response !== 'object') throw new NavidromeError('NAVIDROME_RESPONSE_INVALID');
  if (response.status !== 'ok') {
    const error = response.error || {};
    const code = Number(error.code) === 40 ? 'NAVIDROME_AUTH_FAILED' : 'NAVIDROME_API_FAILED';
    // Server supplied text is deliberately not exposed. It can contain endpoint
    // details and is not useful enough to justify crossing the process boundary.
    throw new NavidromeError(code, code === 'NAVIDROME_AUTH_FAILED' ? 'Authentication failed' : 'Navidrome request failed');
  }
  return response;
}

function appendParameters(url, params) {
  Object.keys(params || {}).forEach((key) => {
    const value = params[key];
    if (value == null || value === '') return;
    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(key, String(item)));
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return url;
}

class NavidromeClient {
  constructor({ serverUrl, username, password, fetchImpl } = {}) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.username = String(username || '').trim();
    this.password = String(password || '');
    this.fetch = fetchImpl || globalThis.fetch;
    if (!this.username || !this.password) throw new NavidromeError('NAVIDROME_CREDENTIALS_REQUIRED');
    if (typeof this.fetch !== 'function') throw new NavidromeError('NAVIDROME_FETCH_UNAVAILABLE');
  }

  authenticatedUrl(endpoint, params) {
    const name = String(endpoint || '').replace(/^\/+|\.view$/g, '');
    if (!/^[a-zA-Z0-9]+$/.test(name)) throw new NavidromeError('NAVIDROME_ENDPOINT_INVALID');
    const salt = makeSalt();
    const url = new URL(`${this.serverUrl}/rest/${name}.view`);
    appendParameters(url, {
      ...params,
      u: this.username,
      t: makeToken(this.password, salt),
      s: salt,
      v: '1.16.1',
      c: 'mineradio-navidrome',
      f: 'json',
    });
    return url;
  }

  async request(endpoint, params, options = {}) {
    const url = this.authenticatedUrl(endpoint, params);
    let response;
    try {
      response = await this.fetch(url, { signal: options.signal, redirect: 'error' });
    } catch (error) {
      throw new NavidromeError('NAVIDROME_NETWORK_FAILED', 'Network request failed');
    }
    if (!response.ok) throw new NavidromeError('NAVIDROME_HTTP_FAILED', `Server returned HTTP ${response.status}`, response.status);
    let payload;
    try {
      payload = await response.json();
    } catch (_e) {
      throw new NavidromeError('NAVIDROME_RESPONSE_INVALID');
    }
    return subsonicResponse(payload);
  }

  async media(endpoint, params, range) {
    const url = this.authenticatedUrl(endpoint, params);
    url.searchParams.delete('f');
    const headers = {};
    if (range) headers.Range = String(range);
    let response;
    try {
      response = await this.fetch(url, { headers, redirect: 'error' });
    } catch (error) {
      throw new NavidromeError('NAVIDROME_NETWORK_FAILED', 'Network request failed');
    }
    // A seek past the available representation is a valid HTTP range result.
    // Preserve it for the loopback media proxy instead of treating it as a
    // credential or upstream transport failure.
    if (!response.ok && response.status !== 206 && response.status !== 416) {
      throw new NavidromeError('NAVIDROME_MEDIA_FAILED', `Server returned HTTP ${response.status}`, response.status);
    }
    return response;
  }

  async ping() {
    return this.request('ping');
  }

  async profile() {
    const [ping, license] = await Promise.all([
      this.ping(),
      this.request('getLicense').catch(() => ({})),
    ]);
    return {
      serverVersion: String(ping.serverVersion || ''),
      type: String(ping.type || 'navidrome'),
      openSubsonic: ping.openSubsonic === true,
      license: license.license || null,
    };
  }

  async home() {
    const optional = (request) => request.catch((error) => {
      if (NavidromeClient.isFatalRequestError(error)) throw error;
      return {};
    });
    const [recent, random, frequent, playlists] = await Promise.all([
      optional(this.request('getAlbumList2', { type: 'recent', size: 12 })),
      optional(this.request('getAlbumList2', { type: 'random', size: 18 })),
      optional(this.request('getAlbumList2', { type: 'frequent', size: 12 })),
      optional(this.request('getPlaylists')),
    ]);
    return {
      recent: (recent.albumList2 && recent.albumList2.album) || [],
      random: (random.albumList2 && random.albumList2.album) || [],
      frequent: (frequent.albumList2 && frequent.albumList2.album) || [],
      playlists: (playlists.playlists && playlists.playlists.playlist) || [],
    };
  }

  async songs({ offset = 0, size = 80 } = {}) {
    const normalizedOffset = Math.max(0, Number(offset) || 0);
    const normalizedSize = Math.min(200, Math.max(1, Number(size) || 80));

    // Navidrome/OpenSubsonic deployments expose the alphabetical library
    // through different generations of the Subsonic API. Prefer the
    // Navidrome endpoint named by the compatibility contract, then try the
    // OpenSubsonic and legacy variants before using search3. A successful
    // response containing an empty page is still a valid page and must not be
    // replaced with a different ordering or duplicate fallback page.
    const pageRequests = [
      ['getAlphabeticalByName', { offset: normalizedOffset, size: normalizedSize }],
      ['getSongList2', { type: 'alphabeticalByName', offset: normalizedOffset, size: normalizedSize }],
      ['getSongList', { type: 'alphabeticalByName', offset: normalizedOffset, size: normalizedSize }],
    ];
    for (const [endpoint, params] of pageRequests) {
      try {
        const page = NavidromeClient.extractSongPage(await this.request(endpoint, params));
        if (page.supported) return page.songs;
      } catch (error) {
        if (NavidromeClient.isFatalRequestError(error)) throw error;
      }
    }

    const searchQueries = ['""', '*'];
    for (const query of searchQueries) {
      try {
        const response = await this.request('search3', {
          query,
          artistCount: 0,
          albumCount: 0,
          songOffset: normalizedOffset,
          songCount: normalizedSize,
        });
        if (response && response.searchResult3 && Array.isArray(response.searchResult3.song)) {
          return response.searchResult3.song;
        }
      } catch (error) {
        if (NavidromeClient.isFatalRequestError(error)) throw error;
      }
    }

    return this.songsFromAlbums(normalizedOffset, normalizedSize);
  }

  static extractSongPage(response) {
    const containers = [
      response && response.alphabeticalByName,
      response && response.songList2,
      response && response.songList,
      response && response.songs,
    ];
    for (const container of containers) {
      if (Array.isArray(container)) return { supported: true, songs: container };
      if (!container || typeof container !== 'object') continue;
      if (Array.isArray(container.song)) return { supported: true, songs: container.song };
      if (Array.isArray(container.entry)) return { supported: true, songs: container.entry };
    }
    if (response && Array.isArray(response.song)) return { supported: true, songs: response.song };
    return { supported: false, songs: [] };
  }

  static isFatalRequestError(error) {
    const code = String(error && error.code || '');
    return code === 'NAVIDROME_AUTH_FAILED'
      || code === 'NAVIDROME_NETWORK_FAILED'
      || code === 'NAVIDROME_CREDENTIALS_REQUIRED';
  }

  async songsFromAlbums(offset = 0, size = 80) {
    const target = Math.max(0, Number(offset) || 0) + Math.max(1, Number(size) || 80);
    const songs = [];
    let albumOffset = 0;
    const albumPageSize = 40;
    while (songs.length < target && albumOffset < 2000) {
      const response = await this.request('getAlbumList2', {
        type: 'alphabeticalByName',
        offset: albumOffset,
        size: albumPageSize,
      });
      const albums = (response.albumList2 && response.albumList2.album) || [];
      if (!Array.isArray(albums) || !albums.length) break;
      const details = await Promise.allSettled(albums.map((album) => this.album(album.id)));
      details.forEach((entry) => {
        if (entry.status !== 'fulfilled') return;
        const entries = entry.value && entry.value.song;
        if (Array.isArray(entries)) songs.push(...entries);
      });
      albumOffset += albums.length;
      if (albums.length < albumPageSize) break;
    }
    return songs.slice(Math.max(0, Number(offset) || 0), target);
  }

  async albums({ type = 'newest', offset = 0, size = 60 } = {}) {
    const response = await this.request('getAlbumList2', { type, offset: Math.max(0, offset), size: Math.min(200, Math.max(1, size)) });
    return (response.albumList2 && response.albumList2.album) || [];
  }

  async artists() {
    const response = await this.request('getArtists');
    const indexes = (response.artists && response.artists.index) || [];
    return indexes.flatMap((index) => index.artist || []);
  }

  async artist(id) {
    const response = await this.request('getArtist', { id });
    return response.artist || {};
  }

  async album(id) {
    const response = await this.request('getAlbum', { id });
    return response.album || {};
  }

  async search(query) {
    const response = await this.request('search3', { query, songCount: 60, albumCount: 30, artistCount: 30 });
    return response.searchResult3 || { song: [], album: [], artist: [] };
  }

  async playlists() {
    const response = await this.request('getPlaylists');
    return (response.playlists && response.playlists.playlist) || [];
  }

  async playlist(id) {
    const response = await this.request('getPlaylist', { id });
    return response.playlist || {};
  }

  async favorites() {
    const response = await this.request('getStarred2');
    return response.starred2 || { song: [], album: [], artist: [] };
  }

  static parseEmbeddedLyrics(song) {
    song = song || {};
    const candidates = [song.lyrics, song.lyricsList, song.lyric, song.unsyncedLyrics, song.synchronizedLyrics];
    const comment = String(song.comment || '').trim();
    if (NavidromeClient.looksLikeLyricsText(comment)) candidates.push(comment);
    const lines = [];
    const plain = [];
    const addText = (value) => {
      if (value == null) return;
      if (typeof value === 'string') {
        const text = value.trim();
        if (text) plain.push(text);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(addText);
        return;
      }
      if (typeof value !== 'object') return;
      const text = String(value.text || value.value || value.content || '').trim();
      const time = value.start ?? value.startTime ?? value.time ?? value.timestamp ?? value.t;
      if (text && time != null && Number.isFinite(Number(time))) {
        const numeric = Number(time);
        lines.push({ start: numeric < 100 ? numeric * 1000 : numeric, duration: Number(value.duration) || 0, text });
      } else if (text) {
        plain.push(text);
      }
      if (value.line && value.line !== value) addText(value.line);
      if (value.lines && value.lines !== value) addText(value.lines);
      if (value.lyrics && value.lyrics !== value) addText(value.lyrics);
      if (value.structuredLyrics && value.structuredLyrics !== value) addText(value.structuredLyrics);
    };
    candidates.forEach(addText);
    const lrc = plain.join('\n');
    const lrcLines = [];
    lrc.split(/\r?\n/).forEach((row) => {
      const match = row.match(/^\s*\[(\d{1,3}):(\d{1,2})(?:\.(\d{1,3}))?\]\s*(.*)$/);
      if (!match) return;
      const fraction = String(match[3] || '').padEnd(3, '0').slice(0, 3);
      const text = String(match[4] || '').trim();
      if (text) lrcLines.push({ start: (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number(fraction), duration: 0, text });
    });
    const merged = lines.concat(lrcLines).sort((a, b) => a.start - b.start);
    if (merged.length) return { synced: true, lines: merged };
    return lrc ? { synced: false, text: lrc } : null;
  }

  static looksLikeLyricsText(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    if (/\[(?:\d{1,3}:)?\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]|\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text)) return true;
    return /^(?:lyrics?|unsyncedlyrics?|syncedlyrics?)\s*[:=]/i.test(text) && /\r?\n/.test(text);
  }

  static parseLyricsResponse(response) {
    response = response || {};
    const list = response.lyricsList || {};
    const structuredLyrics = Array.isArray(list.structuredLyrics) ? list.structuredLyrics : [];
    const structured = structuredLyrics.find((item) => item && item.synced === true && Array.isArray(item.line));
    const plainEntries = Array.isArray(list.lyrics) ? list.lyrics : [];
    const plainText = plainEntries.map((item) => String(item && item.value || '')).filter(Boolean).join('\n');
    if (structured && Array.isArray(structured.line)) {
      const result = {
        synced: true,
        lines: structured.line.map((line) => ({ start: Number(line.start) || 0, duration: Number(line.duration) || 0, text: String(line.value || '') })).filter((line) => line.text),
      };
      if (plainText) result.text = plainText;
      return result;
    }
    const structuredPlain = structuredLyrics
      .filter((item) => item && Array.isArray(item.line))
      .flatMap((item) => item.line.map((line) => String(line && line.value || '')).filter(Boolean));
    const text = plainText || structuredPlain.join('\n');
    const legacy = response.lyrics || {};
    const legacyText = String(legacy.value || legacy.text || '').trim();
    return text || legacyText ? { synced: false, text: text || legacyText } : { synced: false };
  }

  static parseAudioMetadataLyrics(metadata) {
    const tags = metadata && metadata.common && Array.isArray(metadata.common.lyrics)
      ? metadata.common.lyrics
      : [];
    const lines = [];
    const plain = [];
    for (const tag of tags) {
      if (!tag) continue;
      if (Array.isArray(tag.syncText)) {
        for (const item of tag.syncText) {
          const text = String(item && item.text || '').trim();
          const timestamp = Number(item && item.timestamp);
          if (text && Number.isFinite(timestamp)) lines.push({ start: Math.max(0, timestamp), duration: 0, text });
        }
      }
      const text = String(tag.text || '').trim();
      if (text) plain.push(text);
    }
    if (lines.length) return { synced: true, lines: lines.sort((a, b) => a.start - b.start) };
    const nativeSynced = [];
    const nativePlain = [];
    const nativeGroups = metadata && metadata.native && typeof metadata.native === 'object'
      ? Object.values(metadata.native)
      : [];
    for (const group of nativeGroups) {
      if (!Array.isArray(group)) continue;
      for (const tag of group) {
        const id = String(tag && tag.id || '').replace(/[\s_-]+/g, '').toUpperCase();
        if (!/^(?:LYRICS|UNSYNCEDLYRICS?|SYNCEDLYRICS?|SYNCLYRICS)$/.test(id)) continue;
        const value = tag && tag.value;
        const text = String(value && typeof value === 'object' ? (value.text || value.value || '') : value || '').trim();
        if (!text) continue;
        if (id === 'SYNCEDLYRICS' || id === 'SYNCEDLYRIC' || id === 'SYNCLYRICS') nativeSynced.push(text);
        else nativePlain.push(text);
      }
    }
    const commentValues = metadata && metadata.common && Array.isArray(metadata.common.comment)
      ? metadata.common.comment
      : [];
    for (const comment of commentValues) {
      const text = String(comment && typeof comment === 'object' ? (comment.text || comment.value || '') : comment || '').trim();
      if (NavidromeClient.looksLikeLyricsText(text)) nativePlain.push(text);
    }
    return NavidromeClient.parseEmbeddedLyrics({ lyrics: nativeSynced.concat(plain, nativePlain) });
  }

  static async readBodyPrefix(response, limit = EMBEDDED_LYRICS_PREFIX_BYTES) {
    const cap = Math.max(1, Number(limit) || EMBEDDED_LYRICS_PREFIX_BYTES);
    if (!response || !response.body || typeof response.body.getReader !== 'function') return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (size < cap) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = Buffer.from(result.value || []);
        if (!chunk.length) continue;
        const remaining = cap - size;
        chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
        size += Math.min(chunk.length, remaining);
        if (chunk.length >= remaining) break;
      }
    } finally {
      try { await reader.cancel(); } catch (_error) { }
    }
    return Buffer.concat(chunks, size);
  }

  static audioMetadataPrefixLength(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
    if (bytes.length >= 10 && bytes.subarray(0, 3).toString('ascii') === 'ID3') {
      const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
      return 10 + size + ((bytes[5] & 0x10) ? 10 : 0);
    }
    if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'fLaC') {
      let offset = 4;
      while (offset + 4 <= bytes.length) {
        const last = (bytes[offset] & 0x80) !== 0;
        const length = bytes.readUIntBE(offset + 1, 3);
        const end = offset + 4 + length;
        if (end > bytes.length) return end;
        offset = end;
        if (last) return offset;
      }
      return offset + 4;
    }
    return 0;
  }

  async mediaPrefix(songId, limit) {
    const cap = Math.max(1, Math.min(EMBEDDED_LYRICS_MAX_BYTES, Number(limit) || EMBEDDED_LYRICS_PREFIX_BYTES));
    const response = await this.media('download', { id: songId }, `bytes=0-${cap - 1}`);
    return {
      bytes: await NavidromeClient.readBodyPrefix(response, cap),
      contentType: String(response.headers.get('content-type') || '').split(';')[0],
    };
  }

  async embeddedAudioLyrics(songId, contentType) {
    try {
      let media = await this.mediaPrefix(songId, EMBEDDED_LYRICS_PROBE_BYTES);
      let required = NavidromeClient.audioMetadataPrefixLength(media.bytes) || EMBEDDED_LYRICS_PREFIX_BYTES;
      for (let attempt = 0; required > media.bytes.length && media.bytes.length < EMBEDDED_LYRICS_MAX_BYTES && attempt < 3; attempt += 1) {
        media = await this.mediaPrefix(songId, Math.min(required, EMBEDDED_LYRICS_MAX_BYTES));
        required = NavidromeClient.audioMetadataPrefixLength(media.bytes) || required;
      }
      const bytes = media.bytes;
      if (!bytes.length) return null;
      const { parseBuffer } = await import('music-metadata');
      const metadata = await parseBuffer(bytes, {
        mimeType: media.contentType || String(contentType || '').split(';')[0] || undefined,
      }, { duration: false, skipCovers: true });
      return NavidromeClient.parseAudioMetadataLyrics(metadata);
    } catch (error) {
      if (error && /AUTH|CREDENTIAL|UNAUTHORIZED/i.test(String(error.code || error.message || ''))) throw error;
      return null;
    }
  }

  async lyrics(songId) {
    let embedded = null;
    try {
      const songResponse = await this.request('getSong', { id: songId });
      embedded = NavidromeClient.parseEmbeddedLyrics(songResponse.song || {});
      if (embedded && ((embedded.lines && embedded.lines.length) || embedded.text)) return embedded;
    } catch (error) {
      if (error && /AUTH|CREDENTIAL|UNAUTHORIZED/i.test(String(error.code || error.message || ''))) throw error;
    }
    let primary = null;
    try {
      primary = NavidromeClient.parseLyricsResponse(await this.request('getLyricsBySongId', { id: songId }));
      if ((primary.lines && primary.lines.length) || primary.text) return primary;
    } catch (error) {
      if (error && /AUTH|CREDENTIAL|UNAUTHORIZED/i.test(String(error.code || error.message || ''))) throw error;
    }
    const songResponse = await this.request('getSong', { id: songId });
    const song = songResponse.song || {};
    const artist = String(song.artist || song.albumArtist || '').trim();
    const title = String(song.title || '').trim();
    if (!artist && !title) return await this.embeddedAudioLyrics(songId, song.contentType) || primary || { synced: false };
    try {
      const legacy = NavidromeClient.parseLyricsResponse(await this.request('getLyrics', { artist, title }));
      if ((legacy.lines && legacy.lines.length) || legacy.text) return legacy;
    } catch (error) {
      if (error && /AUTH|CREDENTIAL|UNAUTHORIZED/i.test(String(error.code || error.message || ''))) throw error;
    }
    return await this.embeddedAudioLyrics(songId, song.contentType) || primary || { synced: false };
  }

  nowPlaying(id) { return this.request('scrobble', { id, submission: false }); }
  scrobble(id) { return this.request('scrobble', { id, submission: true }); }
  star(id) { return this.request('star', { id }); }
  unstar(id) { return this.request('unstar', { id }); }
  createPlaylist(name, songIds) { return this.request('createPlaylist', { name, songId: songIds || [] }); }
  updatePlaylist(id, params) { return this.request('updatePlaylist', { playlistId: id, ...params }); }
  deletePlaylist(id) { return this.request('deletePlaylist', { id }); }
}

module.exports = {
  NavidromeClient,
  NavidromeError,
  normalizeServerUrl,
  makeSalt,
  makeToken,
  appendParameters,
  EMBEDDED_LYRICS_PROBE_BYTES,
  EMBEDDED_LYRICS_PREFIX_BYTES,
  EMBEDDED_LYRICS_MAX_BYTES,
};

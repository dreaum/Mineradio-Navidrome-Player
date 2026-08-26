const { NavidromeClient, NavidromeError, normalizeServerUrl } = require('./navidrome-client');
const { NavidromeMediaProxy } = require('./navidrome-media-proxy');

const METADATA_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeBitRate(value) {
  const rate = Number(value) || 0;
  return rate === 128 || rate === 192 || rate === 320 ? rate : 0;
}

function firstText() {
  for (let index = 0; index < arguments.length; index += 1) {
    const value = String(arguments[index] == null ? '' : arguments[index]).trim();
    if (value) return value;
  }
  return '';
}

function metadataText(value, kind) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  const normalized = text.replace(/^\[|\]$/g, '').trim().toLowerCase();
  if (normalized === 'unknown' || normalized === `unknown ${kind}`) return '';
  return text;
}

function firstMetadataText(kind, fallback) {
  for (let index = 2; index < arguments.length; index += 1) {
    const value = metadataText(arguments[index], kind);
    if (value) return value;
  }
  return fallback;
}

function firstNamedItem(value) {
  if (!Array.isArray(value)) return '';
  for (const item of value) {
    const text = metadataText(item && (item.name || item.title || item.artist), 'artist');
    if (text) return text;
  }
  return '';
}

function firstNamedId(value) {
  if (!Array.isArray(value)) return '';
  const item = value.find((entry) => entry && entry.id);
  return item ? String(item.id) : '';
}

function songFromApi(song, serverId) {
  song = song || {};
  const coverId = song.coverArt || song.albumId || '';
  const album = firstMetadataText('album', '\u672a\u77e5\u4e13\u8f91', song.album, song.albumName);
  const artist = firstMetadataText(
    'artist',
    '\u672a\u77e5\u6b4c\u624b',
    song.artist,
    song.artistName,
    song.displayArtist,
    song.albumArtist,
    song.displayAlbumArtist,
    firstNamedItem(song.artists),
    firstNamedItem(song.albumArtists)
  );
  const title = firstText(song.title, song.name, '未命名歌曲');
  return {
    id: String(song.id || ''),
    serverId,
    type: 'navidrome',
    name: title,
    title,
    artist,
    album,
    albumId: String(song.albumId || ''),
    artistId: String(song.artistId || firstNamedId(song.artists) || firstNamedId(song.albumArtists) || ''),
    duration: Number(song.duration) || 0,
    track: Number(song.track) || 0,
    year: Number(song.year) || 0,
    genre: String(song.genre || ''),
    contentType: String(song.contentType || ''),
    bitRate: Number(song.bitRate) || 0,
    starred: !!song.starred,
    coverArt: String(coverId),
  };
}

function albumFromApi(album, serverId) {
  album = album || {};
  const coverId = album.coverArt || album.id || '';
  const title = firstMetadataText('album', '\u672a\u77e5\u4e13\u8f91', album.name, album.title);
  return {
    id: String(album.id || ''),
    serverId,
    name: title,
    title,
    artist: firstMetadataText(
      'artist',
      '\u672a\u77e5\u6b4c\u624b',
      album.artist,
      album.artistName,
      album.displayArtist,
      album.albumArtist,
      album.displayAlbumArtist,
      firstNamedItem(album.artists),
      firstNamedItem(album.albumArtists)
    ),
    artistId: String(album.artistId || firstNamedId(album.artists) || firstNamedId(album.albumArtists) || ''),
    year: Number(album.year) || 0,
    songCount: Number(album.songCount) || 0,
    duration: Number(album.duration) || 0,
    coverArt: String(coverId),
  };
}

function artistFromApi(artist, serverId) {
  artist = artist || {};
  const coverId = artist.coverArt || artist.id || '';
  return {
    id: String(artist.id || ''),
    serverId,
    name: firstMetadataText('artist', '\u672a\u77e5\u6b4c\u624b', artist.name, artist.artist),
    albumCount: Number(artist.albumCount) || 0,
    coverArt: String(coverId),
  };
}

function playlistFromApi(playlist, serverId) {
  playlist = playlist || {};
  const coverId = playlist.coverArt || playlist.id || '';
  return {
    id: String(playlist.id || ''),
    serverId,
    name: firstText(playlist.name, '未命名歌单'),
    songCount: Number(playlist.songCount) || 0,
    duration: Number(playlist.duration) || 0,
    owner: String(playlist.owner || ''),
    public: playlist.public === true,
    changed: String(playlist.changed || ''),
    coverArt: String(coverId),
  };
}

function lyricLines(payload) {
  if (payload && payload.synced && Array.isArray(payload.lines)) {
    return payload.lines.map((line) => ({
      t: Math.max(0, Number(line.start) || 0) / 1000,
      duration: Math.max(0, Number(line.duration) || 0) / 1000,
      text: String(line.text || ''),
      source: 'navidrome',
    })).filter((line) => line.text);
  }
  return [];
}

class NavidromeService {
  constructor({ configStore, clientFactory, now = () => Date.now() } = {}) {
    if (!configStore) throw new Error('NAVIDROME_CONFIG_STORE_REQUIRED');
    this.configStore = configStore;
    this.clientFactory = clientFactory || ((options) => new NavidromeClient(options));
    this.now = now;
    this.metadata = new Map();
    this.mediaProxy = new NavidromeMediaProxy({ service: this, now });
  }

  servers() { return this.configStore.list(); }
  activeServer() { return this.configStore.active(); }

  _client(serverId) {
    const server = this.configStore.get(serverId || (this.activeServer() || {}).id);
    if (!server) throw new NavidromeError('NAVIDROME_SERVER_NOT_FOUND');
    return this.clientFactory({ serverUrl: server.url, username: server.username, password: this.configStore.password(server.id) });
  }

  _serverId(serverId) {
    const id = String(serverId || (this.activeServer() || {}).id || '');
    if (!id) throw new NavidromeError('NAVIDROME_SERVER_NOT_SELECTED');
    return id;
  }

  async verify(input) {
    const normalizedUrl = normalizeServerUrl(input && input.url);
    if (normalizedUrl.startsWith('http:') && input.insecureConfirmed !== true) {
      throw new NavidromeError('NAVIDROME_HTTP_CONFIRMATION_REQUIRED');
    }
    const existing = input && input.id ? this.configStore.get(String(input.id)) : null;
    const password = String(input && input.password || '') || (existing ? this.configStore.password(existing.id) : '');
    const client = this.clientFactory({ serverUrl: normalizedUrl, username: input.username, password });
    return client.profile();
  }

  async save(input) {
    const normalizedUrl = normalizeServerUrl(input && input.url);
    if (normalizedUrl.startsWith('http:') && input.insecureConfirmed !== true) {
      throw new NavidromeError('NAVIDROME_HTTP_CONFIRMATION_REQUIRED');
    }
    const existing = input && input.id ? this.configStore.get(String(input.id)) : null;
    const password = String(input && input.password || '') || (existing ? this.configStore.password(existing.id) : '');
    const effectiveInput = { ...(input || {}), url: normalizedUrl, password };
    const profile = await this.verify(effectiveInput);
    return this.configStore.save({ ...effectiveInput, profile }, { makeActive: true });
  }

  async activate(id) {
    const client = this._client(id);
    await client.ping();
    this.configStore.setActive(id);
    return this.activeServer();
  }

  remove(id) {
    this.mediaProxy.clearServer(id);
    this.clearCache(id);
    return this.configStore.remove(id);
  }

  clearCache(serverId) {
    this.clearMetadata(serverId);
    if (serverId) this.mediaProxy.clearServer(serverId);
    else this.mediaProxy.clear();
  }

  clearMetadata(serverId) {
    const prefix = serverId ? `${serverId}:` : '';
    for (const key of this.metadata.keys()) if (!prefix || key.startsWith(prefix)) this.metadata.delete(key);
  }

  async _cached(serverId, name, load) {
    const key = `${serverId}:${name}`;
    const cached = this.metadata.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const value = await load();
    this.metadata.set(key, { expiresAt: this.now() + METADATA_TTL_MS, value });
    return value;
  }

  async home(serverId) {
    const id = this._serverId(serverId);
    // Keep only API metadata in the 24 hour cache. Media capabilities are
    // intentionally short-lived, so they must be created for every response.
    const result = await this._cached(id, 'home', () => this._client(id).home());
    return {
      recent: result.recent.map((item) => albumFromApi(item, id)),
      random: result.random.map((item) => albumFromApi(item, id)),
      frequent: result.frequent.map((item) => albumFromApi(item, id)),
      playlists: result.playlists.map((item) => playlistFromApi(item, id)),
    };
  }

  async songs(options = {}) {
    const id = this._serverId(options.serverId);
    const offset = Math.max(0, Number(options.offset) || 0);
    const size = Math.min(200, Math.max(1, Number(options.size) || 80));
    const result = await this._client(id).songs({ offset, size });
    return result.map((item) => songFromApi(item, id));
  }

  async albums(options = {}) {
    const id = this._serverId(options.serverId);
    const result = await this._client(id).albums(options);
    return result.map((item) => albumFromApi(item, id));
  }

  async artists(serverId) {
    const id = this._serverId(serverId);
    const result = await this._cached(id, 'artists', () => this._client(id).artists());
    return result.map((item) => artistFromApi(item, id));
  }

  async artist(serverId, artistId) {
    const id = this._serverId(serverId);
    const result = await this._client(id).artist(artistId);
    return { ...artistFromApi(result, id), albums: (result.album || []).map((item) => albumFromApi(item, id)) };
  }

  async album(serverId, albumId) {
    const id = this._serverId(serverId);
    const result = await this._client(id).album(albumId);
    const mappedAlbum = albumFromApi(result, id);
    const songs = (result.song || []).map((item) => songFromApi({
      album: mappedAlbum.name,
      artist: mappedAlbum.artist,
      albumId: mappedAlbum.id,
      artistId: mappedAlbum.artistId,
      coverArt: mappedAlbum.coverArt,
      ...item,
    }, id));
    return { ...mappedAlbum, song: songs };
  }

  async search(serverId, query) {
    const id = this._serverId(serverId);
    const result = await this._client(id).search(String(query || '').trim());
    return {
      song: (result.song || []).map((item) => songFromApi(item, id)),
      album: (result.album || []).map((item) => albumFromApi(item, id)),
      artist: (result.artist || []).map((item) => artistFromApi(item, id)),
    };
  }

  async playlists(serverId) {
    const id = this._serverId(serverId);
    const result = await this._cached(id, 'playlists', () => this._client(id).playlists());
    return result.map((item) => playlistFromApi(item, id));
  }

  async playlist(serverId, playlistId) {
    const id = this._serverId(serverId);
    const result = await this._client(id).playlist(playlistId);
    return { ...playlistFromApi(result, id), entry: (result.entry || []).map((item) => songFromApi(item, id)) };
  }

  async favorites(serverId) {
    const id = this._serverId(serverId);
    const result = await this._client(id).favorites();
    return {
      song: (result.song || []).map((item) => songFromApi(item, id)),
      album: (result.album || []).map((item) => albumFromApi(item, id)),
      artist: (result.artist || []).map((item) => artistFromApi(item, id)),
    };
  }

  async lyrics(serverId, songId) {
    const id = this._serverId(serverId);
    const result = await this._client(id).lyrics(songId);
    return { ...result, lines: lyricLines(result) };
  }

  mediaPath(serverId, kind, id, maxBitRate) {
    const actualId = this._serverId(serverId);
    const cap = this.mediaProxy.issue({ serverId: actualId, kind, id, maxBitRate: normalizeBitRate(maxBitRate) });
    if (!this.mediaBaseUrl) throw new NavidromeError('NAVIDROME_MEDIA_PROXY_UNAVAILABLE');
    return `${this.mediaBaseUrl}/api/navidrome-media?kind=${encodeURIComponent(kind)}&cap=${encodeURIComponent(cap)}`;
  }

  mediaInfo(mediaUrl, durationSeconds) {
    if (!this.mediaBaseUrl) throw new NavidromeError('NAVIDROME_MEDIA_PROXY_UNAVAILABLE');
    let parsed;
    let base;
    try {
      parsed = new URL(String(mediaUrl || ''));
      base = new URL(this.mediaBaseUrl);
    } catch (_error) {
      throw new NavidromeError('NAVIDROME_MEDIA_PROXY_INVALID');
    }
    if (
      parsed.origin !== base.origin
      || parsed.pathname !== '/api/navidrome-media'
      || parsed.searchParams.get('kind') !== 'stream'
    ) {
      throw new NavidromeError('NAVIDROME_MEDIA_PROXY_INVALID');
    }
    return this.mediaProxy.info(parsed.searchParams.get('cap'), durationSeconds);
  }

  setMediaBaseUrl(value) {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new NavidromeError('NAVIDROME_MEDIA_PROXY_INVALID');
    this.mediaBaseUrl = url.origin;
  }

  async fetchMedia(serverId, endpoint, params, range) {
    const client = this._client(serverId);
    return client.media(endpoint, params, range);
  }

  async nowPlaying(serverId, songId) { return this._client(this._serverId(serverId)).nowPlaying(songId); }
  async scrobble(serverId, songId) { return this._client(this._serverId(serverId)).scrobble(songId); }
  async star(serverId, songId) { const value = await this._client(this._serverId(serverId)).star(songId); this.clearMetadata(serverId); return value; }
  async unstar(serverId, songId) { const value = await this._client(this._serverId(serverId)).unstar(songId); this.clearMetadata(serverId); return value; }
  async createPlaylist(serverId, name, songIds) { const value = await this._client(this._serverId(serverId)).createPlaylist(name, songIds); this.clearMetadata(serverId); return value; }
  async updatePlaylist(serverId, playlistId, params) { const value = await this._client(this._serverId(serverId)).updatePlaylist(playlistId, params); this.clearMetadata(serverId); return value; }
  async deletePlaylist(serverId, playlistId) { const value = await this._client(this._serverId(serverId)).deletePlaylist(playlistId); this.clearMetadata(serverId); return value; }

  async addPlaylistSongs(serverId, playlistId, songIds) {
    const value = await this.updatePlaylist(serverId, playlistId, { songIdToAdd: Array.isArray(songIds) ? songIds : [songIds] });
    return value;
  }

  async removePlaylistSongs(serverId, playlistId, indexes) {
    const value = await this.updatePlaylist(serverId, playlistId, { songIndexToRemove: Array.isArray(indexes) ? indexes : [indexes] });
    return value;
  }

  async reorderPlaylist(serverId, playlistId, songIds) {
    const id = this._serverId(serverId);
    const client = this._client(id);
    const actual = await client.playlist(playlistId);
    const entries = Array.isArray(actual.entry) ? actual.entry : [];
    const target = Array.isArray(songIds) ? songIds.map(String).filter(Boolean) : [];
    const actualIds = entries.map((entry) => String(entry && entry.id || ''));
    const counts = (values) => values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map());
    const actualCounts = counts(actualIds);
    const targetCounts = counts(target);
    const sameSongs = target.length === actualIds.length
      && targetCounts.size === actualCounts.size
      && Array.from(actualCounts.entries()).every(([songId, count]) => targetCounts.get(songId) === count);
    if (!sameSongs) throw new NavidromeError('NAVIDROME_PLAYLIST_REORDER_INCOMPLETE');
    let changed = false;
    try {
      // Subsonic accepts repeated songIndexToRemove parameters. Send bounded
      // descending batches so large playlists do not require one request per
      // track, while every later index remains stable after earlier batches.
      const removeIndexes = [];
      for (let index = entries.length - 1; index >= 0; index -= 1) removeIndexes.push(String(index));
      const batchSize = 80;
      for (let offset = 0; offset < removeIndexes.length; offset += batchSize) {
        await client.updatePlaylist(playlistId, { songIndexToRemove: removeIndexes.slice(offset, offset + batchSize) });
        changed = true;
      }
      if (target.length) {
        await client.updatePlaylist(playlistId, { songIdToAdd: target });
        changed = true;
      }
    } catch (error) {
      this.clearMetadata(id);
      const refreshed = await this.playlist(id, playlistId).catch(() => null);
      return { ok: false, partial: changed, playlist: refreshed, error: error.code || 'NAVIDROME_PLAYLIST_REORDER_FAILED' };
    }
    this.clearMetadata(id);
    return { ok: true, playlist: await this.playlist(id, playlistId) };
  }
}

module.exports = { NavidromeService, normalizeBitRate, songFromApi, albumFromApi, artistFromApi, playlistFromApi, lyricLines, METADATA_TTL_MS };

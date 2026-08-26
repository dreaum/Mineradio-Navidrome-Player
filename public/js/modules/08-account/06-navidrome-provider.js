var navidromeRendererReady = false;
var navidromePlaybackReport = {
  key: '',
  token: 0,
  nowPlayingSent: false,
  scrobbleSent: false,
  lastWallAt: 0,
  lastMediaTime: 0,
  listenedSeconds: 0
};

function navidromeApiValue(result, fallbackCode) {
  if (!result || !result.ok) throw new Error(result && result.error || fallbackCode || 'NAVIDROME_OPERATION_FAILED');
  return result.value;
}

function navidromeCurrentServerId() {
  return window.NavidromeStore && typeof window.NavidromeStore.currentServerId === 'function'
    ? window.NavidromeStore.currentServerId()
    : '';
}

function navidromeIsConnected() {
  return !!navidromeCurrentServerId();
}

function navidromeCurrentServerProfile() {
  var state = window.NavidromeStore && typeof window.NavidromeStore.state === 'function' ? window.NavidromeStore.state() : null;
  return state && state.activeServer || null;
}

// A configured server remains an actionable source while its DPAPI secret is
// being repaired. Do not make Navidrome disappear from the original player
// menus just because it is not currently connected.
function navidromeHasConfiguredServer() {
  if (navidromeIsConnected()) return true;
  var state = window.NavidromeStore && typeof window.NavidromeStore.state === 'function'
    ? window.NavidromeStore.state()
    : null;
  return !!(state && Array.isArray(state.servers) && state.servers.length);
}

function navidromeConnectionHint() {
  if (navidromeIsConnected()) return '';
  return navidromeHasConfiguredServer() ? 'Navidrome 尚未连通，请重新输入密码' : '添加 Navidrome 服务器';
}

function renderNavidromeTopAccountPill() {
  var server = navidromeCurrentServerProfile() || {};
  var name = String(server.name || server.url || 'Navidrome');
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="#07131b"/><circle cx="48" cy="48" r="34" fill="#5cb0e6" opacity=".18"/><text x="48" y="57" text-anchor="middle" font-family="Arial,sans-serif" font-size="25" font-weight="700" fill="#d8efff">ND</text></svg>';
  return '<span class="top-account-pill" data-account-provider="navidrome"><img src="data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg) + '" alt=""><span class="top-account-name">' + escHtml(name) + '</span><span class="account-source-dot navidrome"></span></span>';
}

function navidromePlaylistIdentity(serverId, playlistId) {
  return 'navidrome:' + String(serverId || navidromeCurrentServerId()) + ':' + String(playlistId || '');
}

function parseNavidromePlaylistIdentity(value) {
  value = String(value || '');
  if (value.indexOf('navidrome:') === 0) value = value.slice('navidrome:'.length);
  var separator = value.indexOf(':');
  if (separator < 0) return { serverId: navidromeCurrentServerId(), playlistId: value };
  return { serverId: value.slice(0, separator), playlistId: value.slice(separator + 1) };
}

function navidromeNormalizeSong(song) {
  if (!song) return song;
  song.type = 'navidrome';
  song.provider = 'navidrome';
  song.source = 'navidrome';
  song.serverId = String(song.serverId || navidromeCurrentServerId());
  song.name = String(song.name || song.title || '未命名歌曲');
  song.title = song.name;
  song.artist = String(song.artist || '未知歌手');
  song.album = String(song.album || '未知专辑');
  song.coverPath = String(song.coverPath || '');
  song.cover = String(song.coverPath || song.cover || '');
  if (song.id) likedSongMap['navidrome:' + song.serverId + ':' + song.id] = !!song.starred;
  return song;
}

async function navidromeAlbumDetailForSong(song) {
  if (!song || !song.albumId) throw new Error('NAVIDROME_ALBUM_ID_MISSING');
  var album = await window.NavidromeStore.album(String(song.albumId));
  album = album || {};
  var songs = navidromeNormalizeSongs(album.song || []);
  await navidromeHydrateCovers(album, false);
  return {
    provider: 'navidrome',
    album: Object.assign({}, album, {
      name: album.name || album.title || song.album || '未知专辑',
      artist: album.artist || song.artist || '未知歌手',
      cover: album.cover || album.coverPath || song.cover || ''
    }),
    songs: songs
  };
}

async function navidromeArtistDetailForSong(song) {
  if (!song || !song.artistId) throw new Error('NAVIDROME_ARTIST_ID_MISSING');
  var artist = await window.NavidromeStore.artist(String(song.artistId));
  artist = artist || {};
  var albums = Array.isArray(artist.albums) ? artist.albums.slice(0, 12) : [];
  var settled = await Promise.allSettled(albums.map(function (album) {
    return window.NavidromeStore.album(String(album && album.id || ''));
  }));
  var songs = [];
  settled.forEach(function (entry) {
    if (entry.status !== 'fulfilled') return;
    songs = songs.concat(navidromeNormalizeSongs(entry.value && entry.value.song || []));
  });
  songs = songs.slice(0, 36);
  await navidromeHydrateCovers(songs, false);
  return {
    artist: {
      name: artist.name || song.artist || '未知歌手',
      avatar: artist.cover || artist.coverPath || song.cover || ''
    },
    songs: songs
  };
}

function navidromeNormalizeSongs(songs) {
  songs = Array.isArray(songs) ? songs : [];
  for (var i = 0; i < songs.length; i++) navidromeNormalizeSong(songs[i]);
  return songs;
}

function navidromeHydrateCovers(value, fetchMissing) {
  var serverId = navidromeCurrentServerId();
  if (!serverId || !window.NavidromeCache) return Promise.resolve(value);
  var hydrate = fetchMissing ? window.NavidromeCache.hydrateCovers : window.NavidromeCache.hydrateCoverPaths;
  if (typeof hydrate !== 'function') return Promise.resolve(value);
  return Promise.resolve(hydrate(value, serverId, !!fetchMissing)).then(function (hydrated) {
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) visit(node[i]);
        return;
      }
      if (node.coverPath) node.cover = node.coverPath;
      if (node.type === 'navidrome') navidromeNormalizeSong(node);
      Object.keys(node).forEach(function (key) { visit(node[key]); });
    }
    visit(hydrated);
    return hydrated;
  });
}

async function navidromeSearchCatalog(query) {
  if (!navidromeIsConnected()) return { song: [], album: [], artist: [] };
  var result = await window.NavidromeStore.search(String(query || '').trim());
  var songs = navidromeNormalizeSongs(result && result.song || []);
  var albums = Array.isArray(result && result.album) ? result.album : [];
  var artists = Array.isArray(result && result.artist) ? result.artist : [];
  await navidromeHydrateCovers({ songs: songs, albums: albums, artists: artists }, false);
  return { song: songs, album: albums, artist: artists };
}

async function navidromeSearchSongs(query) {
  var result = await navidromeSearchCatalog(query);
  return result.song || [];
}

async function navidromeHomeDiscoverData(force) {
  if (!navidromeIsConnected()) return { loggedIn: false, dailySongs: [], playlists: [], podcasts: [] };
  var home = await window.NavidromeStore.loadHome(!!force);
  home = home || {};
  var albums = [];
  var seen = Object.create(null);
  [home.recent || [], home.frequent || [], home.random || []].forEach(function (items) {
    items.forEach(function (album) {
      var key = String(album && album.id || '');
      if (!key || seen[key] || albums.length >= 12) return;
      seen[key] = true;
      albums.push(album);
    });
  });
  var settled = await Promise.allSettled(albums.map(function (album) {
    return window.NavidromeStore.album(String(album.id || ''));
  }));
  var songs = [];
  settled.forEach(function (entry, index) {
    if (entry.status !== 'fulfilled') return;
    var detail = entry.value || {};
    var song = detail.song && detail.song[0];
    if (!song) return;
    song = navidromeNormalizeSong(song);
    if (!song.cover && albums[index]) song.cover = albums[index].cover || albums[index].coverPath || '';
    songs.push(song);
  });
  // A server may expose the song library while omitting album discovery
  // (or return album rows without ids). Keep Home useful in that case by
  // taking the first paged library batch as the recommendation seed.
  if (!songs.length) {
    try {
      var librarySongs = await window.NavidromeStore.loadSongs(!!force);
      songs = navidromeNormalizeSongs((librarySongs || []).slice(0, 12));
    } catch (_error) { songs = []; }
  }
  await navidromeHydrateCovers(songs, false);
  var homePlaylists = Array.isArray(home.playlists) ? home.playlists : [];
  if (!homePlaylists.length) {
    // Some Navidrome versions omit getPlaylists from the home aggregate.
    // Read the same catalog endpoint used by the original playlist panel.
    try { homePlaylists = await window.NavidromeStore.loadPlaylists(!!force); } catch (_error) { homePlaylists = navidromePlaylists || []; }
  }
  var playlists = homePlaylists.map(function (playlist) {
    playlist.serverId = String(playlist.serverId || navidromeCurrentServerId());
    playlist.provider = 'navidrome';
    playlist.source = 'navidrome';
    return playlist;
  });
  return {
    loggedIn: true,
    mode: 'member',
    dailySongs: songs,
    playlists: playlists,
    podcasts: [],
    updatedAt: Date.now()
  };
}

async function navidromeLoadPlaylists(force) {
  if (!navidromeIsConnected()) return [];
  var items = [];
  try {
    items = await window.NavidromeStore.loadPlaylists(!!force);
  } catch (_error) {
    // A server may expose playback and the song library while disabling
    // getPlaylists. Keep the library source visible instead of hiding every
    // Navidrome entry behind one optional endpoint.
    items = [];
  }
  items = Array.isArray(items) ? items : [];
  for (var i = 0; i < items.length; i++) {
    items[i].provider = 'navidrome';
    items[i].source = 'navidrome';
    items[i].serverId = String(items[i].serverId || navidromeCurrentServerId());
    items[i].trackCount = Number(items[i].trackCount || items[i].songCount) || 0;
    items[i].creator = items[i].creator || items[i].owner || 'Navidrome';
    items[i].cover = items[i].cover || items[i].coverPath || '';
  }
  // The original Mineradio shelf needs an explicit library entry. It is a
  // virtual playlist: rows are fetched by the existing paged song loader.
  var storeState = window.NavidromeStore.state && window.NavidromeStore.state() || {};
  var cachedSongs = Array.isArray(storeState.songs) ? storeState.songs : [];
  var librarySeed = cachedSongs[0] || (storeState.home && storeState.home.recent && storeState.home.recent[0]) || null;
  items.unshift({
    id: 'navidrome-songs',
    name: '全部歌曲',
    provider: 'navidrome',
    source: 'navidrome',
    serverId: navidromeCurrentServerId(),
    creator: 'Navidrome 曲库',
    trackCount: cachedSongs.length,
    trackCountPending: !storeState.songsComplete,
    virtual: true,
    libraryAllSongs: true,
    shelfPane: 'mine',
    cover: librarySeed && (librarySeed.cover || librarySeed.coverPath) || ''
  });
  items.splice(1, 0, {
    id: 'navidrome-albums',
    name: '专辑',
    provider: 'navidrome',
    source: 'navidrome',
    serverId: navidromeCurrentServerId(),
    creator: 'Navidrome 曲库',
    trackCount: 0,
    virtual: true,
    virtualCatalog: 'albums',
    shelfPane: 'mine',
    cover: librarySeed && (librarySeed.cover || librarySeed.coverPath) || ''
  }, {
    id: 'navidrome-artists',
    name: '艺术家',
    provider: 'navidrome',
    source: 'navidrome',
    serverId: navidromeCurrentServerId(),
    creator: 'Navidrome 曲库',
    trackCount: 0,
    virtual: true,
    virtualCatalog: 'artists',
    shelfPane: 'mine',
    cover: ''
  });

  // OpenSubsonic exposes starred tracks separately from normal playlists. A
  // failure here must not discard ordinary server playlists or the library.
  var favorites = null;
  try { favorites = await window.NavidromeStore.loadFavorites(!!force); } catch (_error) { favorites = null; }
  var favoriteSongs = Array.isArray(favorites && favorites.song) ? navidromeNormalizeSongs(favorites.song) : [];
  if (favoriteSongs.length) {
    items.push({
      id: 'navidrome-favorites',
      name: '收藏',
      provider: 'navidrome',
      source: 'navidrome',
      serverId: navidromeCurrentServerId(),
      creator: 'Navidrome',
      trackCount: favoriteSongs.length,
      virtual: true,
      shelfPane: 'fav',
      cover: favoriteSongs[0].cover || favoriteSongs[0].coverPath || ''
    });
  }
  try { await navidromeHydrateCovers(items, true); } catch (_error) { }
  return items;
}

function navidromeCatalogPlaylistKind(playlistId) {
  playlistId = String(playlistId || '');
  if (playlistId === 'navidrome-albums') return 'albums';
  if (playlistId === 'navidrome-artists') return 'artists';
  if (playlistId.indexOf('navidrome-artist-albums:') === 0) return 'artist-albums';
  if (playlistId.indexOf('navidrome-album:') === 0) return 'album';
  return '';
}

function navidromeAlbumCatalogItem(album) {
  album = album || {};
  return Object.assign({}, album, {
    type: 'navidrome-album',
    provider: 'navidrome',
    source: 'navidrome',
    serverId: String(album.serverId || navidromeCurrentServerId()),
    id: String(album.id || ''),
    albumId: String(album.id || ''),
    name: String(album.name || album.title || '未命名专辑'),
    title: String(album.name || album.title || '未命名专辑'),
    artist: String(album.artist || '未知艺术家'),
    cover: String(album.cover || album.coverPath || '')
  });
}

function navidromeArtistCatalogItem(artist) {
  artist = artist || {};
  return Object.assign({}, artist, {
    type: 'navidrome-artist',
    provider: 'navidrome',
    source: 'navidrome',
    serverId: String(artist.serverId || navidromeCurrentServerId()),
    id: String(artist.id || ''),
    artistId: String(artist.id || ''),
    name: String(artist.name || '未知艺术家'),
    title: String(artist.name || '未知艺术家'),
    artist: (Number(artist.albumCount) || 0) ? (Number(artist.albumCount) + ' 张专辑') : 'Navidrome 艺术家',
    cover: String(artist.cover || artist.coverPath || '')
  });
}

async function navidromeAlbumCollectionPage(offset, limit) {
  offset = Math.max(0, Number(offset) || 0);
  limit = Math.max(1, Number(limit) || 48);
  var target = offset + limit;
  var state = window.NavidromeStore.state();
  var albums = state.albums || [];
  while (albums.length < target && !state.albumsComplete) {
    albums = await window.NavidromeStore.loadAlbums(albums.length === 0);
    state = window.NavidromeStore.state();
  }
  state = window.NavidromeStore.state();
  albums = state.albums || albums || [];
  var page = albums.slice(offset, target).map(navidromeAlbumCatalogItem);
  await navidromeHydrateCovers(page, false);
  var total = state.albumsComplete ? albums.length : Math.max(albums.length, target + 1);
  return {
    playlist: { id: 'navidrome-albums', name: '专辑', provider: 'navidrome', serverId: navidromeCurrentServerId(), trackCount: total, virtual: true, virtualCatalog: 'albums' },
    tracks: page,
    total: total,
    nextOffset: offset + page.length,
    hasMore: !state.albumsComplete || offset + page.length < albums.length
  };
}

async function navidromeArtistCollectionPage(offset, limit) {
  offset = Math.max(0, Number(offset) || 0);
  limit = Math.max(1, Number(limit) || 48);
  var artists = await window.NavidromeStore.loadArtists();
  artists = Array.isArray(artists) ? artists : [];
  var page = artists.slice(offset, offset + limit).map(navidromeArtistCatalogItem);
  await navidromeHydrateCovers(page, false);
  return {
    playlist: { id: 'navidrome-artists', name: '艺术家', provider: 'navidrome', serverId: navidromeCurrentServerId(), trackCount: artists.length, virtual: true, virtualCatalog: 'artists' },
    tracks: page,
    total: artists.length,
    nextOffset: offset + page.length,
    hasMore: offset + page.length < artists.length
  };
}

async function navidromeArtistAlbumCollectionPage(artistId, offset, limit) {
  offset = Math.max(0, Number(offset) || 0);
  limit = Math.max(1, Number(limit) || 48);
  var artist = await window.NavidromeStore.artist(String(artistId || ''));
  var albums = Array.isArray(artist && artist.albums) ? artist.albums : [];
  var page = albums.slice(offset, offset + limit).map(navidromeAlbumCatalogItem);
  await navidromeHydrateCovers(page, false);
  return {
    playlist: { id: 'navidrome-artist-albums:' + String(artistId || ''), name: String(artist && artist.name || '艺术家'), provider: 'navidrome', serverId: navidromeCurrentServerId(), trackCount: albums.length, virtual: true, virtualCatalog: 'artist-albums' },
    tracks: page,
    total: albums.length,
    nextOffset: offset + page.length,
    hasMore: offset + page.length < albums.length
  };
}

async function navidromeAlbumSongPage(albumId, offset, limit) {
  offset = Math.max(0, Number(offset) || 0);
  limit = Math.max(1, Number(limit) || 48);
  var album = await window.NavidromeStore.album(String(albumId || ''));
  var tracks = navidromeNormalizeSongs(album && album.song || []);
  await navidromeHydrateCovers(tracks, false);
  var page = tracks.slice(offset, offset + limit);
  return {
    playlist: Object.assign({}, album || {}, { id: 'navidrome-album:' + String(albumId || ''), name: String(album && (album.name || album.title) || '专辑'), provider: 'navidrome', serverId: navidromeCurrentServerId(), trackCount: tracks.length, virtual: true }),
    tracks: page,
    total: tracks.length,
    nextOffset: offset + page.length,
    hasMore: offset + page.length < tracks.length
  };
}

async function navidromePlaylistPage(playlistId, offset, limit) {
  var identity = parseNavidromePlaylistIdentity(playlistId);
  if (identity.serverId && identity.serverId !== navidromeCurrentServerId()) throw new Error('NAVIDROME_SERVER_CHANGED');
  var catalogKind = navidromeCatalogPlaylistKind(identity.playlistId);
  if (catalogKind === 'albums') return navidromeAlbumCollectionPage(offset, limit);
  if (catalogKind === 'artists') return navidromeArtistCollectionPage(offset, limit);
  if (catalogKind === 'artist-albums') return navidromeArtistAlbumCollectionPage(String(identity.playlistId).slice('navidrome-artist-albums:'.length), offset, limit);
  if (catalogKind === 'album') return navidromeAlbumSongPage(String(identity.playlistId).slice('navidrome-album:'.length), offset, limit);
  if (String(identity.playlistId) === 'navidrome-songs') {
    return navidromeSongCollectionPage(offset, limit);
  }
  if (String(identity.playlistId) === 'navidrome-favorites') {
    var favorites = null;
    try { favorites = await window.NavidromeStore.loadFavorites(false); } catch (_error) { favorites = null; }
    var favoriteTracks = navidromeNormalizeSongs(favorites && favorites.song || []);
    await navidromeHydrateCovers(favoriteTracks, false);
    offset = Math.max(0, Number(offset) || 0);
    limit = Math.max(1, Number(limit) || favoriteTracks.length || 1);
    var favoritePage = favoriteTracks.slice(offset, offset + limit);
    return {
      playlist: {
        id: 'navidrome-favorites', name: '收藏', provider: 'navidrome', source: 'navidrome',
        serverId: identity.serverId, creator: 'Navidrome', trackCount: favoriteTracks.length, virtual: true, shelfPane: 'fav'
      },
      tracks: favoritePage,
      total: favoriteTracks.length,
      nextOffset: offset + favoritePage.length,
      hasMore: offset + favoritePage.length < favoriteTracks.length
    };
  }
  var detail = await window.NavidromeStore.playlist(String(identity.playlistId || ''));
  var tracks = navidromeNormalizeSongs(detail && detail.entry || []);
  await navidromeHydrateCovers(tracks, false);
  offset = Math.max(0, Number(offset) || 0);
  limit = Math.max(1, Number(limit) || tracks.length || 1);
  var page = tracks.slice(offset, offset + limit);
  return {
    playlist: Object.assign({}, detail || {}, {
      provider: 'navidrome',
      source: 'navidrome',
      serverId: identity.serverId,
      cover: detail && (detail.cover || detail.coverPath) || '',
      trackCount: tracks.length
    }),
    tracks: page,
    total: tracks.length,
    nextOffset: offset + page.length,
    hasMore: offset + page.length < tracks.length
  };
}

async function navidromeSongCollectionPage(offset, limit) {
  offset = Math.max(0, Number(offset) || 0);
  limit = Math.max(1, Number(limit) || 48);
  var target = offset + limit;
  var songs = window.NavidromeStore.state().songs || [];
  while (songs.length < target && !window.NavidromeStore.state().songsComplete) {
    songs = await window.NavidromeStore.loadSongs(songs.length === 0);
  }
  var state = window.NavidromeStore.state();
  songs = state.songs || songs || [];
  var page = navidromeNormalizeSongs(songs.slice(offset, target));
  await navidromeHydrateCovers(page, false);
  return {
    playlist: { id: 'navidrome-songs', name: '全部歌曲', provider: 'navidrome', serverId: navidromeCurrentServerId(), trackCount: state.songsComplete ? songs.length : Math.max(songs.length, target + 1) },
    tracks: page,
    total: state.songsComplete ? songs.length : Math.max(songs.length, target + 1),
    nextOffset: offset + page.length,
    hasMore: !state.songsComplete || offset + page.length < songs.length
  };
}

function openNavidromeSongCollection() {
  if (!navidromeIsConnected()) {
    openNavidromeServerModal();
    return false;
  }
  homeForcedOpen = false;
  homeSuppressed = true;
  setHomeControlsLocked(false);
  updateEmptyHomeVisibility({ forceLoad: false });
  togglePlaylistPanel(false);
  if (shelfManager && typeof shelfManager.openExternalContent === 'function') {
    return shelfManager.openExternalContent('navidrome-songs', '全部歌曲', { provider: 'navidrome', serverId: navidromeCurrentServerId() });
  }
  return false;
}

async function openNavidromeLibraryShelf() {
  if (!navidromeIsConnected()) {
    openNavidromeServerModal();
    return false;
  }
  homeForcedOpen = false;
  homeSuppressed = true;
  setHomeControlsLocked(false);
  updateEmptyHomeVisibility({ forceLoad: false });
  togglePlaylistPanel(false);
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) {
    safeShelfCloseContent('navidrome-library-open');
  }
  try {
    await navidromeSyncProviderState(true);
  } catch (_error) {
    await refreshUserPlaylists(true).catch(function () {});
  }
  var hasServerLibrary = Array.isArray(navidromePlaylists) && navidromePlaylists.some(function (item) {
    return item && item.provider === 'navidrome';
  });
  if (!hasServerLibrary) return openNavidromeSongCollection();
  var shelfMode = shelfManager && shelfManager.getMode ? shelfManager.getMode() : 'off';
  if (shelfMode === 'off' && typeof setShelfMode === 'function') {
    setShelfMode('side');
  } else if (shelfMode === 'side' && shelfManager && typeof shelfManager.setMode === 'function') {
    shelfManager.setMode('side');
  }
  safeShelfRebuild('navidrome-library-open', false);
  if (shelfManager && shelfManager.getMode && shelfManager.getMode() === 'side') {
    setShelfPinnedOpen(true, true);
  } else if (typeof setFocusZone === 'function') {
    setFocusZone(null, true);
  }
  return true;
}

function navidromeMaxBitRateForQuality(quality) {
  quality = String(quality || '').toLowerCase();
  return quality === '320' || quality === '192' || quality === '128' ? Number(quality) : 0;
}

function navidromeLinesToLrc(lines) {
  lines = Array.isArray(lines) ? lines : [];
  var output = '';
  for (var i = 0; i < lines.length; i++) {
    var seconds = Math.max(0, Number(lines[i] && lines[i].t) || 0);
    var minutes = Math.floor(seconds / 60);
    var remainder = seconds - minutes * 60;
    var secText = remainder.toFixed(3).padStart(6, '0');
    output += '[' + String(minutes).padStart(2, '0') + ':' + secText + ']' + String(lines[i] && lines[i].text || '') + '\n';
  }
  return output;
}

async function navidromeFetchLyricResponse(song) {
  var result = await window.navidrome.lyrics(song.serverId, song.id);
  var value = navidromeApiValue(result, 'NAVIDROME_LYRICS_FAILED') || {};
  if (Array.isArray(value.lines) && value.lines.length) return { lyric: navidromeLinesToLrc(value.lines) };
  if (value.text) return { lyric: String(value.text) };
  return { lyric: '' };
}

function navidromeStartPlaybackReporting(song, media, token) {
  if (!song || !media) return;
  navidromePlaybackReport = {
    key: queueItemKey(song),
    token: token,
    nowPlayingSent: false,
    scrobbleSent: false,
    lastWallAt: performance.now(),
    lastMediaTime: Math.max(0, Number(media.currentTime) || 0),
    listenedSeconds: 0
  };
  window.navidrome.nowPlaying(song.serverId, song.id).then(function (result) {
    if (token === trackSwitchToken && result && result.ok) navidromePlaybackReport.nowPlayingSent = true;
  }).catch(function () {});
}

function navidromeUpdatePlaybackReporting(media) {
  var song = currentCoverSong();
  if (!song || songProviderKey(song) !== 'navidrome' || !media || media !== audio) return;
  var report = navidromePlaybackReport;
  if (report.token !== trackSwitchToken || report.key !== queueItemKey(song) || report.scrobbleSent) return;
  var now = performance.now();
  var mediaTime = Math.max(0, Number(media.currentTime) || 0);
  if (!media.paused && report.lastWallAt > 0) {
    var wallDelta = Math.max(0, (now - report.lastWallAt) / 1000);
    var mediaDelta = mediaTime - report.lastMediaTime;
    if (wallDelta <= 30 && mediaDelta >= 0 && mediaDelta <= wallDelta * Math.max(0.25, Number(media.playbackRate) || 1) + 2) {
      report.listenedSeconds += mediaDelta;
    }
  }
  report.lastWallAt = now;
  report.lastMediaTime = mediaTime;
  var duration = Math.max(Number(media.duration) || 0, Number(song.duration) || 0);
  if (duration <= 30 || report.listenedSeconds < Math.min(240, duration / 2)) return;
  report.scrobbleSent = true;
  window.navidrome.scrobble(song.serverId, song.id).catch(function () {});
}

function navidromeHumanError(code) {
  var labels = {
    NAVIDROME_HTTP_CONFIRMATION_REQUIRED: '必须确认 HTTP 风险后才能继续。',
    NAVIDROME_AUTH_FAILED: '用户名或密码无效。',
    NAVIDROME_NETWORK_FAILED: '无法连接服务器。',
    NAVIDROME_HTTP_FAILED: '服务器返回了异常状态。',
    NAVIDROME_SERVER_DUPLICATE: '该服务器和用户名已经存在。',
    NAVIDROME_ENCRYPTION_UNAVAILABLE: 'Windows 凭据加密不可用。',
    NAVIDROME_SECRET_UNREADABLE: '无法读取已保存的加密凭据。'
  };
  return labels[String(code || '')] || '操作失败，请检查服务器设置。';
}

function navidromeServerStatus(text, kind) {
  var node = document.getElementById('navidrome-server-status');
  if (!node) return;
  node.textContent = String(text || '');
  node.classList.remove('success', 'error');
  if (kind) node.classList.add(kind);
}

function renderNavidromeServerModal(editId) {
  var state = window.NavidromeStore && window.NavidromeStore.state ? window.NavidromeStore.state() : { servers: [] };
  var list = document.getElementById('navidrome-server-list');
  var html = '';
  for (var i = 0; i < state.servers.length; i++) {
    var server = state.servers[i] || {};
    var credentialState = String(server.connectionStatus || '');
    var stateLabel = credentialState === 'credentials-unreadable' || credentialState === 'credentials-missing'
      ? '<span class="navidrome-server-state error">需重新输入密码</span>'
      : (credentialState === 'verified' && server.active ? '<span class="navidrome-server-state success">已连接</span>' : '');
    html += '<div class="navidrome-server-card' + (server.active ? ' active' : '') + '"><div class="navidrome-server-copy"><div class="navidrome-server-name">' + escHtml(server.name || server.url) + (server.insecure ? '<span class="navidrome-insecure">不安全连接</span>' : '') + stateLabel + '</div><div class="navidrome-server-meta">' + escHtml(server.url || '') + ' · ' + escHtml(server.username || '') + '</div></div><div class="navidrome-server-actions">' +
      (!server.active ? '<button type="button" data-nav-action="switch" data-nav-id="' + escHtml(server.id) + '" title="切换服务器">↔</button>' : '') +
      '<button type="button" data-nav-action="edit" data-nav-id="' + escHtml(server.id) + '" title="编辑服务器">✎</button>' +
      '<button type="button" data-nav-action="cache" data-nav-id="' + escHtml(server.id) + '" title="清理缓存">⌫</button>' +
      '<button type="button" data-nav-action="remove" data-nav-id="' + escHtml(server.id) + '" title="删除服务器">×</button></div></div>';
  }
  if (list) list.innerHTML = html;
  var target = null;
  if (editId) {
    for (var j = 0; j < state.servers.length; j++) if (state.servers[j].id === editId) target = state.servers[j];
  }
  var heading = document.getElementById('navidrome-server-heading');
  if (heading) heading.textContent = target ? '编辑 Navidrome 服务器' : 'Navidrome 服务器';
  document.getElementById('navidrome-server-id').value = target ? target.id : '';
  document.getElementById('navidrome-server-name').value = target ? target.name : '';
  document.getElementById('navidrome-server-url').value = target ? target.url : '';
  document.getElementById('navidrome-server-username').value = target ? target.username : '';
  document.getElementById('navidrome-server-password').value = '';
  document.getElementById('navidrome-server-password').required = !target || /credentials-(?:unreadable|missing|unavailable)/.test(String(target.connectionStatus || ''));
  document.getElementById('navidrome-http-confirm').checked = !!(target && target.insecure);
  updateNavidromeHttpRisk();
  navidromeServerStatus('', '');
}

function openNavidromeServerModal(editId) {
  closeLoginModal();
  closeUserModal();
  renderNavidromeServerModal(editId);
  openGsapModal(document.getElementById('navidrome-server-modal-mask'));
}

function closeNavidromeServerModal() {
  closeGsapModal(document.getElementById('navidrome-server-modal-mask'));
}

function updateNavidromeHttpRisk() {
  var value = String(document.getElementById('navidrome-server-url').value || '').trim();
  var insecure = /^http:/i.test(value);
  document.getElementById('navidrome-http-risk').hidden = !insecure;
  document.getElementById('navidrome-http-confirm-row').hidden = !insecure;
  if (!insecure) document.getElementById('navidrome-http-confirm').checked = false;
}

function navidromeServerFormData() {
  return {
    id: document.getElementById('navidrome-server-id').value,
    name: document.getElementById('navidrome-server-name').value,
    url: document.getElementById('navidrome-server-url').value,
    username: document.getElementById('navidrome-server-username').value,
    password: document.getElementById('navidrome-server-password').value,
    insecureConfirmed: document.getElementById('navidrome-http-confirm').checked
  };
}

async function verifyNavidromeServerForm() {
  try {
    navidromeServerStatus('正在验证连接…', '');
    var profile = await window.NavidromeStore.verifyServer(navidromeServerFormData());
    navidromeServerStatus('连接成功' + (profile && profile.serverVersion ? ' · ' + profile.serverVersion : ''), 'success');
  } catch (error) {
    navidromeServerStatus(navidromeHumanError(error && error.message), 'error');
  }
}

async function submitNavidromeServerForm(event) {
  if (event) event.preventDefault();
  try {
    navidromeServerStatus('正在保存并连接…', '');
    await saveNavidromePlaybackSession();
    resetNavidromePlaybackForServerChange('save-server');
    await window.NavidromeStore.saveServer(navidromeServerFormData());
    await navidromeSyncProviderState(true);
    restoreNavidromePlaybackSession(navidromeCurrentServerId());
    closeNavidromeServerModal();
    showToast('Navidrome 音源已连接');
  } catch (error) {
    window.__navidromeServerSubmitError = String(error && (error.stack || error.message) || error || 'NAVIDROME_SERVER_SAVE_FAILED');
    navidromeServerStatus(navidromeHumanError(error && error.message), 'error');
  }
}

async function switchNavidromeServer(id) {
  try {
    await saveNavidromePlaybackSession();
    resetNavidromePlaybackForServerChange('switch-server');
    await window.NavidromeStore.switchServer(String(id || ''));
    navidromePlaylists = [];
    await navidromeSyncProviderState(true);
    restoreNavidromePlaybackSession(navidromeCurrentServerId());
    renderNavidromeServerModal();
    showToast('已切换 Navidrome 服务器');
  } catch (error) { navidromeServerStatus(navidromeHumanError(error && error.message), 'error'); }
}

async function clearNavidromeServerCache(id) {
  try { await window.NavidromeStore.clearCache(String(id || '')); showToast('Navidrome 缓存已清理'); }
  catch (_error) { showToast('Navidrome 缓存清理失败'); }
}

async function removeNavidromeServer(id) {
  if (!window.confirm('彻底删除此服务器配置及其 Navidrome 缓存？')) return;
  try {
    if (String(id || '') === navidromeCurrentServerId()) {
      await saveNavidromePlaybackSession();
      resetNavidromePlaybackForServerChange('remove-server');
    }
    await window.NavidromeStore.removeServer(String(id || ''));
    navidromePlaylists = [];
    await navidromeSyncProviderState(true);
    renderNavidromeServerModal();
  } catch (_error) { navidromeServerStatus('删除服务器失败。', 'error'); }
}

async function navidromeSyncProviderState(refreshPlaylists) {
  var connected = navidromeIsConnected();
  document.body.classList.toggle('navidrome-connected', connected);
  var button = document.getElementById('search-mode-navidrome');
  if (button) button.classList.toggle('connected', connected);
  if (typeof renderUserBtn === 'function') renderUserBtn();
  if (connected && refreshPlaylists) {
    try { navidromePlaylists = await navidromeLoadPlaylists(true); }
    catch (_error) { navidromePlaylists = []; }
  } else if (!connected) navidromePlaylists = [];
  if (typeof rebuildUserPlaylistsFromCatalog === 'function' && refreshPlaylists) {
    rebuildUserPlaylistsFromCatalog({ animate: false, preserveScroll: true, reason: 'navidrome-provider-sync' });
  }
  if (typeof syncPlaylistPanelSourceLabel === 'function') syncPlaylistPanelSourceLabel();
  if (connected && refreshPlaylists) {
    // Saving or switching a server must invalidate the pre-connection Home
    // snapshot as well as the playlist catalog.
    if (typeof loadHomeDiscover === 'function') await loadHomeDiscover(true);
    if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: false });
  }
}

function saveNavidromePlaybackSession() {
  var serverId = navidromeCurrentServerId();
  if (!serverId || !window.NavidromeStore || typeof window.NavidromeStore.writeSession !== 'function') return Promise.resolve(false);
  var queue = Array.isArray(playQueue) ? playQueue.filter(function (song) {
    return songProviderKey(song) === 'navidrome' && String(song.serverId || '') === serverId;
  }) : [];
  if (!queue.length) {
    window.NavidromeStore.writeSession(serverId, null);
    return Promise.resolve(true);
  }
  var activeSong = currentIdx >= 0 && playQueue[currentIdx] ? playQueue[currentIdx] : null;
  var activeKey = activeSong ? queueItemKey(activeSong) : '';
  var sessionIndex = queue.findIndex(function (song) { return queueItemKey(song) === activeKey; });
  window.NavidromeStore.writeSession(serverId, {
    currentIndex: sessionIndex >= 0 ? sessionIndex : 0,
    currentTime: audio && isFinite(audio.currentTime) ? audio.currentTime : 0,
    quality: getProviderPlaybackQuality('navidrome'),
    queue: queue
  });
  return Promise.resolve(true);
}

function resetNavidromePlaybackForServerChange(reason) {
  if (!navidromePlaybackReport) {
    navidromePlaybackReport = {
      key: '',
      token: 0,
      nowPlayingSent: false,
      scrobbleSent: false,
      lastWallAt: 0,
      lastMediaTime: 0,
      listenedSeconds: 0
    };
  }
  trackSwitchToken++;
  if (typeof cancelPlaylistQueueHydration === 'function') cancelPlaylistQueueHydration(reason || 'navidrome-server-change');
  if (typeof cancelPendingTrackFallbackLyrics === 'function') cancelPendingTrackFallbackLyrics();
  if (typeof lyricQueuePrefetchToken !== 'undefined') lyricQueuePrefetchToken++;
  if (typeof lyricQueuePrefetchTimer !== 'undefined' && lyricQueuePrefetchTimer) {
    clearTimeout(lyricQueuePrefetchTimer);
    lyricQueuePrefetchTimer = 0;
  }
  if (typeof resetCuefieldAutoMix === 'function') resetCuefieldAutoMix(reason || 'navidrome-server-change');
  if (audio) {
    try {
      audio.pause();
      audio.onended = null;
      audio.removeAttribute('src');
      audio.__mineradioQueueItemKey = '';
      audio.__mineradioTrackSwitchToken = 0;
      audio.load();
    } catch (_error) {}
  }
  playing = false;
  setPlayIcon(false);
  playQueue = [];
  currentIdx = -1;
  currentLocalSong = null;
  restoredLastPlaybackSnapshot = null;
  pendingPlaybackResumeAt = 0;
  navidromePlaybackReport.token++;
  navidromePlaybackReport.key = '';
  if (typeof resetLyricsForTrackSwitch === 'function') resetLyricsForTrackSwitch();
  if (typeof loadCoverFromUrl === 'function') loadCoverFromUrl('');
  if (typeof safeShelfCloseContent === 'function') safeShelfCloseContent(reason || 'navidrome-server-change');
  if (typeof togglePlaylistPanel === 'function') togglePlaylistPanel(false);
  safeRenderQueuePanel(reason || 'navidrome-server-change', { animate: false, scrollCurrent: false, deferWhenHidden: false });
  safeShelfRebuild(reason || 'navidrome-server-change', true);
  if (typeof updateLikeButtons === 'function') updateLikeButtons();
}

function restoreNavidromePlaybackSession(serverId) {
  serverId = String(serverId || navidromeCurrentServerId());
  if (!serverId || !window.NavidromeStore || typeof window.NavidromeStore.readSession !== 'function') return false;
  var session = window.NavidromeStore.readSession(serverId);
  var queue = session && Array.isArray(session.queue) ? session.queue.map(function (song) {
    return navidromeNormalizeSong(Object.assign({}, song, { serverId: serverId }));
  }).filter(function (song) { return song && song.id; }) : [];
  if (!queue.length) return false;
  playQueue = queue;
  currentIdx = Math.max(0, Math.min(queue.length - 1, Number(session.currentIndex) || 0));
  pendingPlaybackResumeAt = Math.max(0, Number(session.currentTime) || 0);
  if (session.quality) setProviderPlaybackQuality('navidrome', session.quality);
  var song = currentCoverSong();
  if (song && typeof updateControlTrackInfo === 'function') updateControlTrackInfo(song);
  if (song) {
    var title = document.getElementById('thumb-title');
    var artist = document.getElementById('thumb-artist');
    if (title) title.textContent = song.name || song.title || '上一首';
    if (artist) artist.textContent = song.artist || 'Navidrome';
  }
  safeRenderQueuePanel('navidrome-session-restore', { animate: false, scrollCurrent: false, deferWhenHidden: false });
  safeShelfRebuild('navidrome-session-restore', true);
  // Saved queues intentionally omit process-local cover capability URLs. Fetch
  // fresh paths from `coverArt` so the restored main bar and queue do not keep
  // broken images until an album detail happens to hydrate them.
  Promise.resolve(navidromeHydrateCovers(queue, false)).then(function () {
    if (playQueue !== queue || navidromeCurrentServerId() !== serverId) return;
    for (var i = 0; i < queue.length; i++) navidromeNormalizeSong(queue[i]);
    var current = currentCoverSong();
    if (current && current.cover && typeof loadCoverFromUrl === 'function') {
      loadCoverFromUrl(songCoverSrc(current, 400), { deferHeavy: true, delay: 0, timeout: 1200 });
    }
    safeRenderQueuePanel('navidrome-session-cover-refresh', { animate: false, scrollCurrent: false, deferWhenHidden: false });
    safeShelfRebuild('navidrome-session-cover-refresh', true);
  }).catch(function (error) {
    console.warn('[NavidromeSessionCoverRefresh]', error && error.message || error);
  });
  forcePlaybackControlsInteractive();
  return true;
}

function bindNavidromeServerModal() {
  var mask = document.getElementById('navidrome-server-modal-mask');
  if (mask && !mask.__navidromeBackdropBound) {
    mask.__navidromeBackdropBound = true;
    mask.addEventListener('click', function (event) { if (event.target === mask) closeNavidromeServerModal(); });
  }
  var list = document.getElementById('navidrome-server-list');
  if (list && !list.__navidromeActionsBound) {
    list.__navidromeActionsBound = true;
    list.addEventListener('click', function (event) {
      var button = event.target && event.target.closest ? event.target.closest('[data-nav-action]') : null;
      if (!button) return;
      var action = button.getAttribute('data-nav-action');
      var id = button.getAttribute('data-nav-id') || '';
      if (action === 'switch') switchNavidromeServer(id);
      else if (action === 'edit') renderNavidromeServerModal(id);
      else if (action === 'cache') clearNavidromeServerCache(id);
      else if (action === 'remove') removeNavidromeServer(id);
    });
  }
}

function promptNavidromeCredentialRepair(event) {
  var code = String(event && event.detail && event.detail.code || '');
  if (!/SECRET|ENCRYPTION|CREDENTIAL/i.test(code)) return;
  showToast('Navidrome 密码密文不可用，请重新输入密码');
  setTimeout(function () {
    openNavidromeServerModal(String(event && event.detail && event.detail.serverId || ''));
  }, 260);
}

function initializeNavidromeProvider() {
  if (navidromeRendererReady || !window.NavidromeStore || !window.navidrome) return;
  navidromeRendererReady = true;
  bindNavidromeServerModal();
  var credentialPrompted = false;
  window.NavidromeStore.subscribe(function (event) {
    if (/^(ready|servers|switch-complete|switch-failed|connection-invalid)$/.test(event.type)) navidromeSyncProviderState(false);
    if (event.type === 'connection-invalid' && !credentialPrompted) {
      credentialPrompted = true;
      promptNavidromeCredentialRepair(event);
    }
  });
  window.NavidromeStore.initialize().then(function () {
    return navidromeSyncProviderState(false).then(function () {
      restoreNavidromePlaybackSession(navidromeCurrentServerId());
      if (navidromeIsConnected()) {
        refreshUserPlaylists(true);
        loadHomeDiscover(true);
        updateEmptyHomeVisibility({ forceLoad: true });
      }
    });
  }).catch(function (error) {
    console.warn('[NavidromeProvider]', error && error.message || error);
  });
}

initializeNavidromeProvider();

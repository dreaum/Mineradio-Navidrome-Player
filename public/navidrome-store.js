(function () {
  'use strict';

  var SESSION_KEY = 'mineradio-navidrome-sessions-v1';

  function clone(value) {
    if (value == null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (_error) { return value; }
  }

  function errorCode(error) {
    return String(error && (error.code || error.message) || 'NAVIDROME_OPERATION_FAILED');
  }

  function metadataValue(value, kind, fallback) {
    var text = String(value == null ? '' : value).trim();
    var normalized = text.replace(/^\[|\]$/g, '').trim().toLowerCase();
    return !text || normalized === 'unknown' || normalized === ('unknown ' + kind) ? fallback : text;
  }

  function normalizeSong(song, serverId) {
    song = song || {};
    return {
      type: 'navidrome',
      serverId: String(song.serverId || serverId || ''),
      id: String(song.id || ''),
      title: String(song.title || song.name || '未命名歌曲'),
      name: String(song.name || song.title || '未命名歌曲'),
      artist: metadataValue(song.artist, 'artist', '\u672a\u77e5\u6b4c\u624b'),
      album: metadataValue(song.album, 'album', '\u672a\u77e5\u4e13\u8f91'),
      artistId: String(song.artistId || ''),
      albumId: String(song.albumId || ''),
      duration: Number(song.duration) || 0,
      bitRate: Number(song.bitRate) || 0,
      starred: !!song.starred,
      coverArt: String(song.coverArt || ''),
      coverPath: String(song.coverPath || ''),
      cover: String(song.cover || song.coverPath || '')
    };
  }

  function normalizeSongs(list, serverId) {
    list = Array.isArray(list) ? list : [];
    var output = new Array(list.length);
    for (var i = 0; i < list.length; i += 1) output[i] = normalizeSong(list[i], serverId);
    return output;
  }

  function mediaRecord(item, serverId) {
    item = clone(item || {}) || {};
    var name = String(item.name || item.title || '').trim();
    var normalizedName = name.replace(/^\[|\]$/g, '').trim().toLowerCase();
    if (normalizedName === 'unknown album') name = '\u672a\u77e5\u4e13\u8f91';
    else if (normalizedName === 'unknown artist') name = '\u672a\u77e5\u827a\u672f\u5bb6';
    if (name) { item.name = name; item.title = name; }
    if (item.artist != null) item.artist = metadataValue(item.artist, 'artist', '\u672a\u77e5\u6b4c\u624b');
    item.serverId = String(item.serverId || serverId || '');
    item.coverArt = String(item.coverArt || item.id || '');
    item.coverPath = String(item.coverPath || '');
    item.cover = String(item.cover || item.coverPath || '');
    item.provider = 'navidrome';
    item.source = 'navidrome';
    if (item.trackCount == null) item.trackCount = Number(item.songCount) || 0;
    if (!item.creator) item.creator = String(item.owner || 'Navidrome');
    return item;
  }

  function mediaRecords(list, serverId) {
    list = Array.isArray(list) ? list : [];
    var output = new Array(list.length);
    for (var i = 0; i < list.length; i += 1) output[i] = mediaRecord(list[i], serverId);
    return output;
  }

  function hydrateMedia(value, serverId, cacheResources) {
    var cache = window.NavidromeCache;
    if (!cache) return Promise.resolve(value);
    if (cacheResources && typeof cache.hydrateCovers === 'function') return cache.hydrateCovers(value, serverId, true);
    if (typeof cache.hydrateCoverPaths === 'function') return cache.hydrateCoverPaths(value, serverId);
    return Promise.resolve(value);
  }

  function stableSong(song) {
    var normalized = normalizeSong(song, song && song.serverId);
    delete normalized.coverPath;
    // `/api/navidrome-media` uses a process-local capability token. Keeping it
    // in a persisted queue makes the restored list point at an expired cover.
    if (normalized.type === 'navidrome' && /^http:\/\/127\.0\.0\.1:\d+\/api\/navidrome-media(?:\?|$)/i.test(normalized.cover)) {
      delete normalized.cover;
    }
    return normalized;
  }

  function readJson(key, fallback) {
    try {
      var value = JSON.parse(localStorage.getItem(key) || 'null');
      return value == null ? fallback : value;
    } catch (_error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_error) {}
  }

  function makeStore(api) {
    var listeners = [];
    var state = {
      ready: false,
      loading: false,
      servers: [],
      activeServer: null,
      home: { recent: [], frequent: [], random: [], playlists: [] },
      songs: [],
      albums: [],
      artists: [],
      playlists: [],
      favorites: { song: [], album: [], artist: [] },
      search: { query: '', song: [], album: [], artist: [] },
      requestSeq: 0,
      songOffset: 0,
      songsComplete: false,
      albumOffset: 0,
      albumsComplete: false,
      error: ''
    };

    function snapshot() { return clone(state); }
    function emit(type, detail) {
      var event = { type: type, detail: detail || {}, state: snapshot() };
      for (var i = 0; i < listeners.length; i += 1) {
        try { listeners[i](event); } catch (_error) {}
      }
    }

    function call(method) {
      var args = Array.prototype.slice.call(arguments, 1);
      if (!api || typeof api[method] !== 'function') return Promise.reject(new Error('NAVIDROME_UNAVAILABLE'));
      return Promise.resolve(api[method].apply(api, args)).then(function (result) {
        if (!result || !result.ok) throw new Error(result && result.error || 'NAVIDROME_OPERATION_FAILED');
        return result.value;
      });
    }

    function currentId() { return String(state.activeServer && state.activeServer.id || ''); }

    function serverCredentialsUsable(server) {
      var status = String(server && server.connectionStatus || '');
      return !!server && status !== 'credentials-missing' && status !== 'credentials-unreadable' && status !== 'credentials-unavailable';
    }

    function credentialErrorForServer(server) {
      var status = String(server && server.connectionStatus || '');
      if (status === 'credentials-missing') return 'NAVIDROME_SECRET_MISSING';
      if (status === 'credentials-unavailable') return 'NAVIDROME_ENCRYPTION_UNAVAILABLE';
      return 'NAVIDROME_SECRET_UNREADABLE';
    }

    function markConnectionInvalid(serverId, error, reason) {
      serverId = String(serverId || currentId() || '');
      var code = errorCode(error);
      state.activeServer = null;
      resetServerData();
      state.loading = false;
      state.error = code;
      for (var i = 0; i < state.servers.length; i += 1) {
        if (String(state.servers[i] && state.servers[i].id || '') !== serverId) continue;
        if (/SECRET|ENCRYPTION|CREDENTIAL/i.test(code)) state.servers[i].connectionStatus = 'credentials-unreadable';
      }
      emit('connection-invalid', { serverId: serverId, code: code, reason: String(reason || '') });
      return null;
    }

    function metadata(key, load) {
      var id = currentId();
      var cache = window.NavidromeCache;
      if (!id || !cache || typeof cache.metadata !== 'function') return Promise.resolve().then(load);
      return cache.metadata(id, key, load);
    }

    function resetServerData() {
      state.home = { recent: [], frequent: [], random: [], playlists: [] };
      state.songs = [];
      state.albums = [];
      state.artists = [];
      state.playlists = [];
      state.favorites = { song: [], album: [], artist: [] };
      state.search = { query: '', song: [], album: [], artist: [] };
      state.songOffset = 0;
      state.songsComplete = false;
      state.albumOffset = 0;
      state.albumsComplete = false;
      state.error = '';
    }

    function refreshServers() {
      return Promise.all([call('servers'), call('activeServer')]).then(function (values) {
        state.servers = Array.isArray(values[0]) ? values[0] : [];
        var configuredActive = values[1] || null;
        state.activeServer = serverCredentialsUsable(configuredActive) ? configuredActive : null;
        emit('servers');
        return configuredActive;
      });
    }

    function loadHome(force) {
      var id = currentId();
      if (!id) return Promise.resolve(state.home);
      var seq = state.requestSeq;
      state.loading = true;
      emit('loading', { scope: 'home' });
      var load = function () { return call('home', id); };
      var request = force ? load() : metadata('home', load);
      return request.then(function (home) {
        if (seq !== state.requestSeq || id !== currentId()) return state.home;
        home = home || {};
        state.home = {
          recent: mediaRecords(home.recent, id),
          frequent: mediaRecords(home.frequent, id),
          random: mediaRecords(home.random, id),
          playlists: mediaRecords(home.playlists, id)
        };
        return hydrateMedia(state.home, id, true).then(function () {
          state.playlists = state.home.playlists;
          state.loading = false;
          state.error = '';
          emit('home');
          return state.home;
        });
      }).catch(function (error) {
        if (seq === state.requestSeq) {
          state.loading = false;
          state.error = errorCode(error);
          emit('error', { scope: 'home', code: state.error });
        }
        throw error;
      });
    }

    function initialize() {
      return refreshServers().then(function (configuredActive) {
        state.ready = true;
        emit('ready');
        if (!configuredActive) return null;
        if (!serverCredentialsUsable(configuredActive)) {
          return markConnectionInvalid(configuredActive.id, new Error(credentialErrorForServer(configuredActive)), 'startup-credentials');
        }
        return call('activateServer', configuredActive.id).then(function (server) {
          state.activeServer = server || configuredActive;
          emit('switch-complete', { server: clone(state.activeServer), startup: true });
          return loadHome(false);
        }).catch(function (error) {
          return markConnectionInvalid(configuredActive.id, error, 'startup-validation');
        });
      });
    }

    function switchServer(id) {
      id = String(id || '');
      if (!id || id === currentId()) return Promise.resolve(state.activeServer);
      var token = ++state.requestSeq;
      emit('switch-start', { from: currentId(), to: id, token: token });
      resetServerData();
      if (window.NavidromeCache && typeof window.NavidromeCache.releaseOtherServerUrls === 'function') {
        window.NavidromeCache.releaseOtherServerUrls(id);
      }
      return call('activateServer', id).then(function (server) {
        if (token !== state.requestSeq) return null;
        state.activeServer = server || null;
        for (var i = 0; i < state.servers.length; i += 1) state.servers[i].active = state.servers[i].id === id;
        emit('switch-complete', { server: clone(server), token: token });
        return loadHome(true).then(function () { return state.activeServer; });
      }).catch(function (error) {
        if (token === state.requestSeq) {
          markConnectionInvalid(id, error, 'switch-server');
          emit('switch-failed', { to: id, token: token, code: state.error });
        }
        throw error;
      });
    }

    function saveServer(input) {
      ++state.requestSeq;
      return call('saveServer', input || {}).then(function (server) {
        return refreshServers().then(function () {
          resetServerData();
          state.activeServer = server || state.activeServer;
          emit('switch-complete', { server: clone(state.activeServer), saved: true });
          return loadHome(true).then(function () { return state.activeServer; });
        });
      }).catch(function (error) {
        var serverId = input && input.id || currentId();
        if (/SECRET|ENCRYPTION|CREDENTIAL|AUTH/i.test(errorCode(error))) markConnectionInvalid(serverId, error, 'save-server');
        throw error;
      });
    }

    function verifyServer(input) { return call('verifyServer', input || {}); }

    function removeServer(id) {
      id = String(id || '');
      return Promise.resolve(window.NavidromeCache && window.NavidromeCache.clear ? window.NavidromeCache.clear(id) : null)
        .catch(function () {})
        .then(function () { return call('removeServer', id); })
        .then(function () {
          if (id === currentId()) {
            ++state.requestSeq;
            state.activeServer = null;
            resetServerData();
            emit('switch-start', { from: id, to: '' });
          }
          return refreshServers();
        });
    }

    function clearCache(id) {
      id = String(id || '');
      var local = window.NavidromeCache && window.NavidromeCache.clear ? window.NavidromeCache.clear(id) : Promise.resolve();
      return Promise.resolve(local).then(function () { return call('clearCache', id); });
    }

    function loadSongs(reset) {
      var id = currentId();
      if (!id) return Promise.resolve([]);
      if (reset) { state.songs = []; state.songOffset = 0; state.songsComplete = false; }
      if (state.songsComplete) return Promise.resolve(state.songs);
      var seq = state.requestSeq;
      var offset = state.songOffset;
      return metadata('songs:' + offset + ':80', function () { return call('songs', { serverId: id, offset: offset, size: 80 }); }).then(function (songs) {
        if (seq !== state.requestSeq || id !== currentId()) return state.songs;
        songs = normalizeSongs(songs, id);
        state.songs = reset ? songs : state.songs.concat(songs);
        state.songOffset = state.songs.length;
        state.songsComplete = songs.length < 80;
        return hydrateMedia(songs, id, false).then(function () {
          emit('songs', { reset: !!reset });
          return state.songs;
        });
      });
    }

    function loadAlbums(reset) {
      var id = currentId();
      if (!id) return Promise.resolve([]);
      if (reset) { state.albums = []; state.albumOffset = 0; state.albumsComplete = false; }
      if (state.albumsComplete) return Promise.resolve(state.albums);
      var seq = state.requestSeq;
      var offset = state.albumOffset;
      var pageSize = 80;
      return metadata('albums:alphabeticalByName:' + offset + ':' + pageSize, function () {
        return call('albums', { serverId: id, type: 'alphabeticalByName', offset: offset, size: pageSize });
      }).then(function (items) {
        if (seq !== state.requestSeq || id !== currentId()) return state.albums;
        items = mediaRecords(items, id);
        state.albums = reset ? items : state.albums.concat(items);
        state.albumOffset = state.albums.length;
        state.albumsComplete = items.length < pageSize;
        return hydrateMedia(items, id, false).then(function () {
          emit('albums', { reset: !!reset });
          return state.albums;
        });
      });
    }

    function loadArtists() {
      var id = currentId();
      if (!id) return Promise.resolve([]);
      return metadata('artists', function () { return call('artists', id); })
        .then(function (items) { state.artists = mediaRecords(items, id); return hydrateMedia(state.artists, id, false); })
        .then(function () { emit('artists'); return state.artists; });
    }

    function album(id) {
      var serverId = currentId();
      return metadata('album:' + id, function () { return call('album', serverId, id); }).then(function (value) {
        value = mediaRecord(value, serverId);
        value.song = normalizeSongs(value.song, serverId);
        return hydrateMedia(value, serverId, false);
      });
    }
    function artist(id) {
      var serverId = currentId();
      return metadata('artist:' + id, function () { return call('artist', serverId, id); }).then(function (value) {
        value = mediaRecord(value, serverId);
        value.albums = mediaRecords(value.albums, serverId);
        return hydrateMedia(value, serverId, false);
      });
    }
    function playlist(id) {
      var serverId = currentId();
      return metadata('playlist:' + id, function () { return call('playlist', serverId, id); }).then(function (value) {
        value = mediaRecord(value, serverId);
        value.entry = normalizeSongs(value.entry, serverId);
        return hydrateMedia(value, serverId, false);
      });
    }

    function search(query) {
      query = String(query || '').trim();
      var serverId = currentId();
      state.searchRequestSeq = (Number(state.searchRequestSeq) || 0) + 1;
      var seq = state.searchRequestSeq;
      var generation = state.requestSeq;
      state.search = { query: query, song: [], album: [], artist: [] };
      if (!query || !serverId) { emit('search'); return Promise.resolve(state.search); }
      return metadata('search:' + query.toLocaleLowerCase(), function () { return call('search', serverId, query); }).then(function (result) {
        if (seq !== state.searchRequestSeq || generation !== state.requestSeq || serverId !== currentId()) return state.search;
        result = result || {};
        state.search = {
          query: query,
          song: normalizeSongs(result.song, serverId),
          album: mediaRecords(result.album, serverId),
          artist: mediaRecords(result.artist, serverId)
        };
        return hydrateMedia(state.search, serverId, false).then(function () { emit('search'); return state.search; });
      });
    }

    function loadPlaylists(force) {
      var id = currentId();
      if (!id) return Promise.resolve([]);
      var load = function () { return call('playlists', id); };
      return (force ? load() : metadata('playlists', load)).then(function (items) {
        state.playlists = mediaRecords(items, id);
        return hydrateMedia(state.playlists, id, true).then(function () { emit('playlists'); return state.playlists; });
      });
    }

    function loadFavorites(force) {
      var id = currentId();
      if (!id) return Promise.resolve(state.favorites);
      var load = function () { return call('favorites', id); };
      return (force ? load() : metadata('favorites', load)).then(function (value) {
        value = value || {};
        state.favorites = {
          song: normalizeSongs(value.song, id),
          album: mediaRecords(value.album, id),
          artist: mediaRecords(value.artist, id)
        };
        return hydrateMedia(state.favorites, id, false).then(function () { emit('favorites'); return state.favorites; });
      });
    }

    function invalidate() {
      var id = currentId();
      return clearCache(id).then(function () { return Promise.all([loadHome(true), loadPlaylists(true), loadFavorites(true)]); });
    }

    function invalidateMetadata(serverId) {
      serverId = String(serverId || currentId());
      var cache = window.NavidromeCache;
      if (!serverId || !cache || typeof cache.clearMetadata !== 'function') return Promise.resolve();
      return Promise.resolve(cache.clearMetadata(serverId));
    }

    function sessions() {
      var data = readJson(SESSION_KEY, {});
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    }

    function readSession(serverId) {
      var value = sessions()[String(serverId || currentId())];
      return value && typeof value === 'object' ? clone(value) : null;
    }

    function writeSession(serverId, session) {
      serverId = String(serverId || currentId());
      if (!serverId) return;
      var data = sessions();
      if (!session) delete data[serverId];
      else {
        var queue = Array.isArray(session.queue) ? session.queue : [];
        var stableQueue = new Array(queue.length);
        for (var i = 0; i < queue.length; i += 1) stableQueue[i] = stableSong(queue[i]);
        data[serverId] = {
          version: 1,
          serverId: serverId,
          currentIndex: Math.max(-1, Number(session.currentIndex) || 0),
          currentTime: Math.max(0, Number(session.currentTime) || 0),
          quality: String(session.quality || 'original'),
          queue: stableQueue,
          updatedAt: Date.now()
        };
      }
      writeJson(SESSION_KEY, data);
    }

    return {
      initialize: initialize,
      state: function () { return snapshot(); },
      subscribe: function (listener) { if (typeof listener === 'function') listeners.push(listener); return function () { var i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); }; },
      currentServerId: currentId,
      refreshServers: refreshServers,
      verifyServer: verifyServer,
      saveServer: saveServer,
      switchServer: switchServer,
      removeServer: removeServer,
      clearCache: clearCache,
      loadHome: loadHome,
      loadSongs: loadSongs,
      loadAlbums: loadAlbums,
      loadArtists: loadArtists,
      album: album,
      artist: artist,
      search: search,
      loadPlaylists: loadPlaylists,
      loadFavorites: loadFavorites,
      playlist: playlist,
      invalidate: invalidate,
      invalidateMetadata: invalidateMetadata,
      readSession: readSession,
      writeSession: writeSession,
      normalizeSong: normalizeSong,
      normalizeSongs: normalizeSongs
    };
  }

  window.NavidromeStore = makeStore(window.navidrome);
})();

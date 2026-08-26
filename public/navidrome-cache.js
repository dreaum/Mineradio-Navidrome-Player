(function () {
  'use strict';

  var DB_NAME = 'mineradio-navidrome-cache-v1';
  var DB_VERSION = 1;
  var METADATA_TTL_MS = 24 * 60 * 60 * 1000;
  var RESOURCE_LIMIT_BYTES = 100 * 1024 * 1024;
  var COVER_MAX_BYTES = 24 * 1024 * 1024;
  var openPromise = null;
  var objectUrls = Object.create(null);

  function safeClone(value) {
    if (value == null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (_error) { return value; }
  }

  function now() { return Date.now(); }
  function serverKey(serverId, key) { return String(serverId || '') + '\u001f' + String(key || ''); }

  function openDatabase() {
    if (openPromise) return openPromise;
    if (!window.indexedDB) return Promise.reject(new Error('NAVIDROME_CACHE_UNAVAILABLE'));
    openPromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        ['metadata', 'lyrics', 'resources'].forEach(function (name) {
          var store = db.objectStoreNames.contains(name) ? request.transaction.objectStore(name) : db.createObjectStore(name, { keyPath: 'id' });
          if (!store.indexNames.contains('serverId')) store.createIndex('serverId', 'serverId', { unique: false });
          if (name !== 'resources' && !store.indexNames.contains('expiresAt')) store.createIndex('expiresAt', 'expiresAt', { unique: false });
          if (name === 'resources' && !store.indexNames.contains('lastAccessAt')) store.createIndex('lastAccessAt', 'lastAccessAt', { unique: false });
        });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('NAVIDROME_CACHE_OPEN_FAILED')); };
    });
    return openPromise;
  }

  function transaction(storeName, mode, operation) {
    return openDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var store = tx.objectStore(storeName);
        var settled = false;
        var result;
        function finish(callback, value) {
          if (settled) return;
          settled = true;
          callback(value);
        }
        // An IndexedDB request can succeed before its write transaction has
        // committed. Resolve only after the transaction terminal event.
        tx.oncomplete = function () { finish(resolve, result); };
        tx.onerror = function () { finish(reject, tx.error || new Error('NAVIDROME_CACHE_TRANSACTION_FAILED')); };
        tx.onabort = function () { finish(reject, tx.error || new Error('NAVIDROME_CACHE_TRANSACTION_ABORTED')); };
        try {
          operation(store, tx, function (value) { result = value; });
        } catch (error) {
          try { tx.abort(); } catch (_abortError) {}
          finish(reject, error);
        }
      });
    });
  }

  function readRecord(storeName, id) {
    return transaction(storeName, 'readonly', function (store, _tx, setResult) {
      var request = store.get(id);
      request.onsuccess = function () { setResult(request.result || null); };
    }).then(function (value) { return value || null; });
  }

  function putRecord(storeName, record) {
    return transaction(storeName, 'readwrite', function (store) {
      store.put(record);
    });
  }

  function stripLoopbackPaths(value) {
    var cloned = safeClone(value);
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (Object.prototype.hasOwnProperty.call(node, 'coverPath')) node.coverPath = '';
      Object.keys(node).forEach(function (key) { visit(node[key]); });
    }
    visit(cloned);
    return cloned;
  }

  function urlForResource(id, blob) {
    var current = objectUrls[id];
    if (current) return current;
    var url = URL.createObjectURL(blob);
    objectUrls[id] = url;
    return url;
  }

  function releaseResourceUrl(id) {
    var url = objectUrls[id];
    if (!url) return;
    try { URL.revokeObjectURL(url); } catch (_error) {}
    delete objectUrls[id];
  }

  function resourceId(serverId, coverId) { return serverKey(serverId, 'cover:' + String(coverId || '')); }

  function getCover(serverId, coverId) {
    if (!serverId || !coverId) return Promise.resolve('');
    var id = resourceId(serverId, coverId);
    return readRecord('resources', id).then(function (record) {
      if (!record || !(record.blob instanceof Blob)) return '';
      record.lastAccessAt = now();
      putRecord('resources', record).catch(function () {});
      return urlForResource(id, record.blob);
    });
  }

  function resourceTotals() {
    return transaction('resources', 'readonly', function (store, _tx, setResult) {
      var records = [];
      var request = store.openCursor();
      request.onsuccess = function () {
        var cursor = request.result;
        if (!cursor) { setResult(records); return; }
        records.push(cursor.value);
        cursor.continue();
      };
    }).then(function (records) { return records || []; });
  }

  function trimResources(extraBytes, protectedId) {
    return resourceTotals().then(function (records) {
      var total = records.reduce(function (sum, record) { return sum + Math.max(0, Number(record.size) || 0); }, 0);
      var over = total + Math.max(0, Number(extraBytes) || 0) - RESOURCE_LIMIT_BYTES;
      if (over <= 0) return;
      records.sort(function (left, right) { return (Number(left.lastAccessAt) || 0) - (Number(right.lastAccessAt) || 0); });
      var victims = [];
      for (var i = 0; i < records.length && over > 0; i += 1) {
        var record = records[i];
        if (!record || record.id === protectedId) continue;
        victims.push(record.id);
        over -= Math.max(0, Number(record.size) || 0);
      }
      if (!victims.length) return;
      return transaction('resources', 'readwrite', function (store) {
        victims.forEach(function (id) { store.delete(id); releaseResourceUrl(id); });
      });
    });
  }

  function readCoverBlob(response, type) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      return response.blob().then(function (blob) {
        if (blob.size > COVER_MAX_BYTES) throw new Error('NAVIDROME_COVER_TOO_LARGE');
        return blob;
      });
    }
    var reader = response.body.getReader();
    var chunks = [];
    var total = 0;
    function cancel() { try { return reader.cancel(); } catch (_error) { return Promise.resolve(); } }
    function pump() {
      return reader.read().then(function (part) {
        if (part.done) return new Blob(chunks, { type:type });
        var chunk = part.value;
        total += chunk && chunk.byteLength || 0;
        if (total > COVER_MAX_BYTES) return Promise.resolve(cancel()).then(function () { throw new Error('NAVIDROME_COVER_TOO_LARGE'); });
        chunks.push(chunk);
        return pump();
      });
    }
    return pump();
  }

  function isLoopbackMediaUrl(value) {
    try {
      var url = new URL(String(value || ''));
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/api/navidrome-media';
    } catch (_error) {
      return false;
    }
  }

  function cacheCover(serverId, coverId, sourceUrl) {
    if (!serverId || !coverId || !isLoopbackMediaUrl(sourceUrl)) return Promise.resolve('');
    var id = resourceId(serverId, coverId);
    return getCover(serverId, coverId).then(function (existing) {
      if (existing) return existing;
      return fetch(sourceUrl, { credentials: 'omit', mode: 'cors' }).then(function (response) {
        if (!response.ok) throw new Error('NAVIDROME_COVER_FETCH_FAILED');
        var type = String(response.headers.get('content-type') || '').toLowerCase();
        var length = Number(response.headers.get('content-length') || 0);
        if (!type.startsWith('image/') || length > COVER_MAX_BYTES) throw new Error('NAVIDROME_COVER_INVALID');
        return readCoverBlob(response, type);
      }).then(function (blob) {
        if (!(blob instanceof Blob) || !String(blob.type || '').toLowerCase().startsWith('image/') || blob.size > COVER_MAX_BYTES) return '';
        return trimResources(blob.size, id).then(function () {
          return putRecord('resources', { id: id, serverId: String(serverId), kind: 'cover', coverId: String(coverId), blob: blob, size: blob.size, createdAt: now(), lastAccessAt: now() });
        }).then(function () { return urlForResource(id, blob); });
      });
    });
  }

  function hydrateCovers(value, serverId, fetchMissing) {
    var jobs = [];
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      var id = String(node.coverArt || '');
      if (id) {
        var originalPath = String(node.coverPath || '');
        jobs.push(getCover(serverId, id).then(function (cached) {
          if (cached) { node.coverPath = cached; return; }
          if (!fetchMissing) return;
          var source = originalPath
            ? Promise.resolve(originalPath)
            : issueCoverPath(serverId, id);
          return source.then(function (path) {
            return cacheCover(serverId, id, path).then(function (url) { if (url) node.coverPath = url; });
          }).catch(function () {});
        }));
      }
      Object.keys(node).forEach(function (key) { visit(node[key]); });
    }
    visit(value);
    return Promise.all(jobs).then(function () { return value; });
  }

  function hydrateCoverPaths(value, serverId) {
    var jobs = [];
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      var id = String(node.coverArt || '');
      if (id && !node.coverPath) {
        jobs.push(getCover(serverId, id).then(function (cached) {
          if (cached) { node.coverPath = cached; return; }
          return issueCoverPath(serverId, id).then(function (path) { node.coverPath = path; }).catch(function () {});
        }));
      }
      Object.keys(node).forEach(function (key) { visit(node[key]); });
    }
    visit(value);
    return Promise.all(jobs).then(function () { return value; });
  }

  function issueCoverPath(serverId, coverId) {
    var api = window.navidrome;
    if (!api || typeof api.mediaPath !== 'function') return Promise.reject(new Error('NAVIDROME_COVER_PATH_UNAVAILABLE'));
    return api.mediaPath(String(serverId), 'cover', String(coverId), 0).then(function (result) {
      if (!result || !result.ok || !result.value) throw new Error(result && result.error || 'NAVIDROME_COVER_PATH_UNAVAILABLE');
      return String(result.value);
    });
  }

  function readCached(storeName, serverId, key) {
    var id = serverKey(serverId, key);
    return readRecord(storeName, id).then(function (record) {
      if (!record || record.expiresAt <= now()) return null;
      return safeClone(record.value);
    });
  }

  function writeCached(storeName, serverId, key, value) {
    return putRecord(storeName, {
      id: serverKey(serverId, key),
      serverId: String(serverId),
      key: String(key),
      value: stripLoopbackPaths(value),
      updatedAt: now(),
      expiresAt: now() + METADATA_TTL_MS,
    });
  }

  function cached(storeName, serverId, key, load) {
    if (typeof load !== 'function') return Promise.reject(new Error('NAVIDROME_CACHE_LOAD_REQUIRED'));
    if (!serverId) return Promise.resolve().then(load);
    return readCached(storeName, serverId, key).then(function (hit) {
      if (hit != null) return hydrateCovers(hit, serverId, true);
      return Promise.resolve().then(load).then(function (value) {
        writeCached(storeName, serverId, key, value).catch(function () {});
        return hydrateCovers(value, serverId, true);
      });
    }).catch(function () {
      return Promise.resolve().then(load);
    });
  }

  function deleteServerFromStore(storeName, serverId) {
    return transaction(storeName, 'readwrite', function (store, _tx, setResult) {
      var request = store.index('serverId').openCursor(IDBKeyRange.only(String(serverId)));
      request.onsuccess = function () {
        var cursor = request.result;
        if (!cursor) { setResult(); return; }
        releaseResourceUrl(cursor.value && cursor.value.id);
        cursor.delete();
        cursor.continue();
      };
    });
  }

  function clear(serverId) {
    var stores = ['metadata', 'lyrics', 'resources'];
    if (!serverId) {
      Object.keys(objectUrls).forEach(releaseResourceUrl);
      return Promise.all(stores.map(function (storeName) {
        return transaction(storeName, 'readwrite', function (store) { store.clear(); });
      })).then(function () {});
    }
    return Promise.all(stores.map(function (storeName) { return deleteServerFromStore(storeName, serverId); })).then(function () {});
  }

  function clearMetadata(serverId) {
    if (!serverId) {
      return transaction('metadata', 'readwrite', function (store) { store.clear(); }).then(function () {});
    }
    return deleteServerFromStore('metadata', serverId).then(function () {});
  }

  function releaseOtherServerUrls(serverId) {
    var prefix = String(serverId || '') + '\u001f';
    Object.keys(objectUrls).forEach(function (id) { if (!id.startsWith(prefix)) releaseResourceUrl(id); });
  }

  window.NavidromeCache = {
    metadata: function (serverId, key, load) { return cached('metadata', serverId, key, load); },
    lyrics: function (serverId, key, load) { return cached('lyrics', serverId, key, load); },
    clear: clear,
    clearMetadata: clearMetadata,
    releaseOtherServerUrls: releaseOtherServerUrls,
    hydrateCovers: hydrateCovers,
    hydrateCoverPaths: hydrateCoverPaths,
    limits: { metadataTtlMs: METADATA_TTL_MS, resourceBytes: RESOURCE_LIMIT_BYTES },
  };
})();

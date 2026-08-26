const crypto = require('crypto');

class NavidromeMediaProxy {
  constructor({ service, ttlMs = 2 * 60 * 60 * 1000, maxCapabilities = 2048, now = () => Date.now() } = {}) {
    this.service = service;
    this.ttlMs = ttlMs;
    this.maxCapabilities = Math.max(64, Number(maxCapabilities) || 2048);
    this.now = now;
    this.capabilities = new Map();
  }

  issue({ serverId, kind, id, maxBitRate } = {}) {
    if (!serverId || !id || (kind !== 'stream' && kind !== 'cover')) throw new Error('NAVIDROME_MEDIA_REQUEST_INVALID');
    this.prune();
    while (this.capabilities.size >= this.maxCapabilities) this.capabilities.delete(this.capabilities.keys().next().value);
    const capability = crypto.randomBytes(24).toString('base64url');
    this.capabilities.set(capability, {
      serverId,
      kind,
      id: String(id),
      maxBitRate: Number(maxBitRate) || 0,
      expiresAt: this.now() + this.ttlMs,
      mediaInfo: null,
    });
    return capability;
  }

  prune() {
    const now = this.now();
    for (const [capability, record] of this.capabilities) if (!record || record.expiresAt <= now) this.capabilities.delete(capability);
  }

  async fetch(capability, kind, range) {
    this.prune();
    const record = this.capabilities.get(String(capability || ''));
    if (!record) {
      const error = new Error('NAVIDROME_MEDIA_CAPABILITY_INVALID');
      error.code = 'NAVIDROME_MEDIA_CAPABILITY_INVALID';
      throw error;
    }
    if (kind && kind !== record.kind) {
      const error = new Error('NAVIDROME_MEDIA_CAPABILITY_INVALID');
      error.code = 'NAVIDROME_MEDIA_CAPABILITY_INVALID';
      throw error;
    }
    const endpoint = record.kind === 'cover' ? 'getCoverArt' : 'stream';
    const params = record.kind === 'cover' ? { id: record.id } : { id: record.id, maxBitRate: record.maxBitRate || undefined };
    const response = await this.service.fetchMedia(record.serverId, endpoint, params, range);
    if (record.kind === 'stream') this.captureMediaInfo(record, response);
    return response;
  }

  captureMediaInfo(record, response) {
    if (!record || !response || !response.headers || typeof response.headers.get !== 'function') return;
    const status = Number(response.status) || 0;
    const contentRange = String(response.headers.get('content-range') || '');
    const rangeMatch = /\/(\d+)$/.exec(contentRange);
    const contentLength = Math.max(0, Number(response.headers.get('content-length')) || 0);
    const totalBytes = rangeMatch
      ? Math.max(0, Number(rangeMatch[1]) || 0)
      : (status !== 206 ? contentLength : 0);
    const previous = record.mediaInfo || {};
    record.mediaInfo = {
      contentType: String(response.headers.get('content-type') || previous.contentType || '').split(';')[0],
      totalBytes: totalBytes || Math.max(0, Number(previous.totalBytes) || 0),
      status,
      updatedAt: this.now(),
    };
  }

  info(capability, durationSeconds) {
    this.prune();
    const record = this.capabilities.get(String(capability || ''));
    if (!record || record.kind !== 'stream') {
      const error = new Error('NAVIDROME_MEDIA_CAPABILITY_INVALID');
      error.code = 'NAVIDROME_MEDIA_CAPABILITY_INVALID';
      throw error;
    }
    const mediaInfo = record.mediaInfo || {};
    const duration = Math.max(0, Number(durationSeconds) || 0);
    const totalBytes = Math.max(0, Number(mediaInfo.totalBytes) || 0);
    return {
      ready: totalBytes > 0 && duration > 0,
      contentType: String(mediaInfo.contentType || ''),
      totalBytes,
      bitRate: totalBytes > 0 && duration > 0 ? Math.round(totalBytes * 8 / duration) : 0,
      requestedMaxBitRate: Math.max(0, Number(record.maxBitRate) || 0),
      updatedAt: Math.max(0, Number(mediaInfo.updatedAt) || 0),
    };
  }

  clearServer(serverId) {
    for (const [capability, record] of this.capabilities) if (record.serverId === serverId) this.capabilities.delete(capability);
  }

  clear() {
    this.capabilities.clear();
  }
}

module.exports = { NavidromeMediaProxy };

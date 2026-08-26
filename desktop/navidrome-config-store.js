const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeServerUrl, NavidromeError } = require('./navidrome-client');

function safeJsonFile(fsImpl, filePath, fallback) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (_e) {
    return fallback;
  }
}

function atomicWrite(fsImpl, filePath, value) {
  const directory = path.dirname(filePath);
  fsImpl.mkdirSync(directory, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fsImpl.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  fsImpl.renameSync(tempPath, filePath);
}

class NavidromeConfigStore {
  constructor({ directory, cryptoAdapter, fsImpl = fs } = {}) {
    if (!directory) throw new Error('NAVIDROME_STORE_DIRECTORY_REQUIRED');
    this.directory = directory;
    this.fs = fsImpl;
    this.crypto = cryptoAdapter;
    this.configPath = path.join(directory, 'servers.json');
    this.secretPath = path.join(directory, 'server-secrets.json');
  }

  _config() {
    const data = safeJsonFile(this.fs, this.configPath, { schema: 1, activeServerId: '', servers: [] });
    return { schema: 1, activeServerId: String(data.activeServerId || ''), servers: Array.isArray(data.servers) ? data.servers : [] };
  }

  _secrets() {
    const data = safeJsonFile(this.fs, this.secretPath, { schema: 1, values: {} });
    return { schema: 1, values: data && typeof data.values === 'object' && data.values ? data.values : {} };
  }

  _requireEncryption() {
    if (!this.crypto || typeof this.crypto.encryptString !== 'function' || typeof this.crypto.decryptString !== 'function') throw new NavidromeError('NAVIDROME_ENCRYPTION_UNAVAILABLE');
  }

  _credentialStatus(id) {
    const encoded = this._secrets().values[id];
    if (!encoded) return 'credentials-missing';
    if (!this.crypto || typeof this.crypto.decryptString !== 'function') return 'credentials-unavailable';
    try {
      const value = this.crypto.decryptString(Buffer.from(encoded, 'base64'));
      return String(value || '') ? 'readable' : 'credentials-unreadable';
    } catch (_error) {
      // Keep the configured server visible so the user can re-enter its
      // password. Never expose the underlying DPAPI error or ciphertext.
      return 'credentials-unreadable';
    }
  }

  list() {
    const data = this._config();
    return data.servers.map(({ id, name, url, username, insecureAcceptedAt, createdAt, updatedAt, profile }) => {
      const credentialStatus = this._credentialStatus(id);
      return {
        id,
        name,
        url,
        username,
        insecure: url.startsWith('http:'),
        insecureAcceptedAt: insecureAcceptedAt || '',
        createdAt,
        updatedAt,
        profile: profile || null,
        connectionStatus: credentialStatus === 'readable' ? (profile ? 'verified' : 'unknown') : credentialStatus,
        active: id === data.activeServerId,
      };
    });
  }

  active() {
    return this.list().find((server) => server.active) || null;
  }

  get(id) {
    const item = this._config().servers.find((server) => server.id === id);
    return item ? { ...item } : null;
  }

  password(id) {
    this._requireEncryption();
    const encoded = this._secrets().values[id];
    if (!encoded) throw new NavidromeError('NAVIDROME_SECRET_MISSING');
    try {
      return this.crypto.decryptString(Buffer.from(encoded, 'base64'));
    } catch (_e) {
      throw new NavidromeError('NAVIDROME_SECRET_UNREADABLE');
    }
  }

  save(input, { makeActive = true } = {}) {
    this._requireEncryption();
    const url = normalizeServerUrl(input && input.url);
    const username = String(input && input.username || '').trim();
    let password = String(input && input.password || '');
    const name = String(input && input.name || '').trim() || new URL(url).host;
    const existingId = String(input && input.id || '');
    if (!username) throw new NavidromeError('NAVIDROME_CREDENTIALS_REQUIRED');
    if (url.startsWith('http:') && input.insecureConfirmed !== true) throw new NavidromeError('NAVIDROME_HTTP_CONFIRMATION_REQUIRED');
    const config = this._config();
    const duplicate = config.servers.find((server) => server.id !== existingId && server.url === url && server.username.toLowerCase() === username.toLowerCase());
    if (duplicate) throw new NavidromeError('NAVIDROME_SERVER_DUPLICATE');
    const now = new Date().toISOString();
    const id = existingId || crypto.randomUUID();
    const prior = config.servers.find((server) => server.id === id);
    // Editing a server does not require exposing or re-entering its existing
    // password. A missing secret is still an explicit configuration error.
    if (!password && prior) password = this.password(id);
    if (!password) throw new NavidromeError('NAVIDROME_CREDENTIALS_REQUIRED');
    const record = { id, name, url, username, insecureAcceptedAt: url.startsWith('http:') ? (prior && prior.insecureAcceptedAt || now) : '', createdAt: prior && prior.createdAt || now, updatedAt: now, profile: input.profile || prior && prior.profile || null };
    const index = config.servers.findIndex((server) => server.id === id);
    if (index < 0) config.servers.push(record); else config.servers[index] = record;
    if (makeActive) config.activeServerId = id;
    const secrets = this._secrets();
    secrets.values[id] = this.crypto.encryptString(password).toString('base64');
    atomicWrite(this.fs, this.secretPath, secrets);
    atomicWrite(this.fs, this.configPath, config);
    return this.list().find((server) => server.id === id);
  }

  setActive(id) {
    const config = this._config();
    if (!config.servers.some((server) => server.id === id)) throw new NavidromeError('NAVIDROME_SERVER_NOT_FOUND');
    config.activeServerId = id;
    atomicWrite(this.fs, this.configPath, config);
    return this.active();
  }

  remove(id) {
    const config = this._config();
    if (!config.servers.some((server) => server.id === id)) return false;
    config.servers = config.servers.filter((server) => server.id !== id);
    if (config.activeServerId === id) config.activeServerId = config.servers[0] && config.servers[0].id || '';
    const secrets = this._secrets();
    delete secrets.values[id];
    atomicWrite(this.fs, this.configPath, config);
    atomicWrite(this.fs, this.secretPath, secrets);
    return true;
  }
}

module.exports = { NavidromeConfigStore };

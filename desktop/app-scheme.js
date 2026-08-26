'use strict';

const fs = require('fs');
const path = require('path');

const APP_SCHEME = 'mineradio';
const APP_HOST = 'app';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function registerMineradioAppScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

function safeStaticPath(rootDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(pathname || '/'));
  } catch (_error) {
    return '';
  }
  if (!decoded || decoded.includes('\0') || decoded.includes('\\')) return '';
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!relative || relative.split('/').some((part) => part === '..')) return '';
  const root = path.resolve(rootDir);
  const file = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (file !== root && !file.startsWith(prefix)) return '';
  return file;
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function requestBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return Promise.resolve(undefined);
  return request.arrayBuffer().then((value) => Buffer.from(value));
}

function installMineradioAppScheme(protocol, { rootDir, getLocalServerPort } = {}) {
  if (!rootDir || typeof getLocalServerPort !== 'function') throw new Error('MINERADIO_APP_SCHEME_CONFIG_REQUIRED');
  protocol.handle(APP_SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch (_error) {
      return jsonError('MINERADIO_APP_URL_INVALID', 400);
    }
    if (url.hostname !== APP_HOST) return jsonError('MINERADIO_APP_HOST_INVALID', 404);

    const pathname = url.pathname || '/';
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const port = Number(getLocalServerPort()) || 0;
      if (!port) return jsonError('MINERADIO_LOCAL_SERVER_UNAVAILABLE', 503);
      const target = `http://127.0.0.1:${port}${pathname}${url.search}`;
      const headers = new Headers(request.headers || {});
      headers.delete('host');
      const body = await requestBody(request);
      try {
        return await fetch(target, {
          method: request.method,
          headers,
          body,
          redirect: 'error',
          ...(body === undefined ? {} : { duplex: 'half' }),
        });
      } catch (_error) {
        return jsonError('MINERADIO_LOCAL_SERVER_UNAVAILABLE', 503);
      }
    }

    const file = safeStaticPath(rootDir, pathname);
    if (!file) return jsonError('MINERADIO_STATIC_PATH_INVALID', 400);
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) return jsonError('MINERADIO_STATIC_NOT_FOUND', 404);
      const body = request.method === 'HEAD' ? undefined : await fs.promises.readFile(file);
      const headers = {
        'Cache-Control': pathname === '/' || pathname === '/index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
        'Content-Length': String(stat.size),
        'Content-Type': MIME_TYPES.get(path.extname(file).toLowerCase()) || 'application/octet-stream',
      };
      return new Response(body, { status: 200, headers });
    } catch (_error) {
      return jsonError('MINERADIO_STATIC_NOT_FOUND', 404);
    }
  });
}

module.exports = {
  APP_SCHEME,
  APP_HOST,
  registerMineradioAppScheme,
  installMineradioAppScheme,
};

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const exe = process.env.MINERADIO_DIAG_EXECUTABLE
  ? path.resolve(process.env.MINERADIO_DIAG_EXECUTABLE)
  : path.join(root, 'dist', 'win-unpacked', 'Mineradio Navidrome.exe');
const useSourceElectron = process.env.MINERADIO_DIAG_SOURCE === '1';
const userData = process.env.MINERADIO_DIAG_USERDATA
  ? path.resolve(process.env.MINERADIO_DIAG_USERDATA)
  : path.join(root, 'dist', 'win-unpacked', 'userdata');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = require('node:net').createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP_TIMEOUT')));
    req.on('error', reject);
  });
}

async function waitFor(fn, message, timeout = 20000) {
  const expires = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < expires) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  const error = new Error(message);
  if (lastError) error.cause = lastError;
  throw error;
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP_CONNECT_TIMEOUT')), 8000);
      this.socket.onopen = () => { clearTimeout(timer); resolve(); };
      this.socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP_CONNECT_FAILED')); };
    });
    this.socket.onmessage = (event) => {
      let payload;
      try { payload = JSON.parse(String(event.data)); } catch (_error) { return; }
      if (!payload.id || !this.pending.has(payload.id)) return;
      const pending = this.pending.get(payload.id);
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(`${pending.method}: ${payload.error.message}`));
      else pending.resolve(payload.result || {});
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'CDP_EVALUATE_FAILED');
    }
    return result.result && result.result.value;
  }

  close() {
    try { this.socket && this.socket.close(); } catch (_error) {}
  }
}

async function main() {
  console.error('[diag] main-start');
  if (!useSourceElectron && !fs.existsSync(exe)) throw new Error('EXE_NOT_FOUND: ' + exe);
  if (!fs.existsSync(userData)) throw new Error('USERDATA_NOT_FOUND: ' + userData);
  const port = await freePort();
  const electronBinary = useSourceElectron ? require('electron') : exe;
  const launchArgs = useSourceElectron ? [root] : [];
  launchArgs.push(
    `--remote-debugging-port=${port}`,
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-gpu-sandbox',
    '--in-process-gpu',
  );
  const app = spawn(electronBinary, launchArgs, {
    cwd: useSourceElectron ? root : path.dirname(exe),
    env: {
      ...process.env,
      MINERADIO_STARTUP_QA_USER_DATA: userData,
      MINERADIO_STARTUP_QA_HIDDEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  app.on('exit', (code, signal) => console.error('[diag] child-exit', code, signal, stderr));
  app.on('error', (error) => console.error('[diag] child-error', error && error.stack || error));
  console.error('[diag] spawned', app.pid, exe);
  let stderr = '';
  app.stderr.on('data', (chunk) => { stderr += String(chunk); });
  try {
    console.error('[diag] waiting-target', port);
    const targets = await waitFor(async () => {
      const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
      return list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    }, 'DEVTOOLS_TARGET_NOT_FOUND', 30000);
    const cdp = new CdpClient(targets.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await waitFor(() => cdp.evaluate('window.__mineradioModulesReady === true || !!window.__mineradioModulesError || document.readyState === "complete"'), 'RENDERER_NOT_READY', 30000);
    const moduleState = await cdp.evaluate(`({
      ready: window.__mineradioModulesReady === true,
      error: window.__mineradioModulesError || '',
      navStore: !!window.NavidromeStore,
      navReady: !!(window.NavidromeStore && window.NavidromeStore.state && window.NavidromeStore.state().ready),
      body: document.body ? document.body.innerText.slice(0, 240) : ''
    })`);
    const before = await cdp.evaluate(`(() => ({
      connected: typeof navidromeIsConnected === 'function' && navidromeIsConnected(),
      server: window.NavidromeStore.currentServerId(),
      songs: window.NavidromeStore.state().songs.length,
      queue: Array.isArray(playQueue) ? playQueue.length : null,
      audio: audio ? { src: audio.src, paused: audio.paused, readyState: audio.readyState, error: audio.error && audio.error.message } : null
    }))()`);
    const result = await cdp.evaluate(`(async () => {
      const page = await navidromeSongCollectionPage(0, 8);
      const songs = (page && page.tracks || []).filter(Boolean);
      if (!songs.length) throw new Error('NO_NAVIDROME_SONGS_FOR_PLAYBACK');
      playQueue = songs.slice(0, 5);
      currentIdx = -1;
      const playReturn = await playQueueAt(0, { manual: true });
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return {
        songCount: songs.length,
        playReturn,
        current: currentCoverSong && currentCoverSong() ? { name: currentCoverSong().name, id: currentCoverSong().id, provider: currentCoverSong().type || currentCoverSong().provider } : null,
        queue: Array.isArray(playQueue) ? playQueue.map((song) => song && song.name).slice(0, 5) : null,
        currentIdx,
        playing,
        audio: audio ? {
          src: audio.src,
          currentSrc: audio.currentSrc,
          paused: audio.paused,
          ended: audio.ended,
          readyState: audio.readyState,
          networkState: audio.networkState,
          currentTime: audio.currentTime,
          duration: audio.duration,
          muted: audio.muted,
          volume: audio.volume,
          error: audio.error ? { code: audio.error.code, message: audio.error.message } : null
        } : null
      };
    })()`);
    cdp.close();
    process.stdout.write(JSON.stringify({ ok: true, moduleState, before, result, stderr: stderr.slice(-4000) }, null, 2) + '\n');
  } finally {
    try { app.kill(); } catch (_error) {}
  }
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack || error) + '\n');
  process.exitCode = 1;
});

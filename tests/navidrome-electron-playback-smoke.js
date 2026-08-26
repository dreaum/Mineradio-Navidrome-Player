'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'mock-open-subsonic-server.js');
const packagedExecutable = process.argv[2] || process.env.MINERADIO_SMOKE_EXECUTABLE || '';
const electron = packagedExecutable ? path.resolve(packagedExecutable) : require('electron');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-nav-playback-'));
const children = new Set();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2500);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill(); } catch (_error) { clearTimeout(timer); resolve(); }
  });
}

async function cleanup() {
  await Promise.all(Array.from(children, stopChild));
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_error) {}
}

async function waitFor(check, message, timeout = 20000, interval = 120) {
  const expires = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < expires) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  const error = new Error(message);
  if (lastError) error.cause = lastError;
  throw error;
}

function startMock(port) {
  const child = spawn(process.execPath, [fixture], {
    cwd: root,
    env: { ...process.env, MINERADIO_MOCK_PORT: String(port), MINERADIO_MOCK_LABEL: 'Playback' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  child.once('exit', () => children.delete(child));
  return waitFor(() => {
    if (child.exitCode != null) throw new Error(`Mock server exited (${child.exitCode})`);
    return output.includes('MOCK_OPEN_SUBSONIC_READY');
  }, 'Mock OpenSubsonic server did not start', 8000).then(() => child);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.logs = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DevTools WebSocket timed out')), 8000);
      this.socket.onopen = () => { clearTimeout(timer); resolve(); };
      this.socket.onerror = () => { clearTimeout(timer); reject(new Error('DevTools WebSocket failed')); };
    });
    this.socket.onmessage = (event) => {
      let payload;
      try { payload = JSON.parse(String(event.data)); } catch (_error) { return; }
      if (payload.method === 'Runtime.consoleAPICalled') {
        const values = (payload.params.args || []).map((arg) => arg.value == null ? arg.description : arg.value);
        this.logs.push(`[console.${payload.params.type}] ${values.join(' ')}`);
        return;
      }
      if (payload.method === 'Runtime.exceptionThrown') {
        const detail = payload.params && payload.params.exceptionDetails;
        this.logs.push(`[exception] ${detail && (detail.exception && detail.exception.description || detail.text) || 'unknown'}`);
        return;
      }
      if (!payload.id || !this.pending.has(payload.id)) return;
      const pending = this.pending.get(payload.id);
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(`${pending.method}: ${payload.error.message}`));
      else pending.resolve(payload.result || {});
    };
    this.socket.onclose = () => {
      for (const pending of this.pending.values()) pending.reject(new Error('DevTools WebSocket closed'));
      this.pending.clear();
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception && response.exceptionDetails.exception.description;
      throw new Error(detail || response.exceptionDetails.text || 'Renderer evaluation failed');
    }
    return response.result && response.result.value;
  }

  close() {
    try { this.socket.close(); } catch (_error) {}
  }
}

async function devtoolsTarget(port) {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((target) => {
      if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
      try {
        const url = new URL(String(target.url || ''));
        const stableApp = url.protocol === 'mineradio:' && url.hostname === 'app';
        const legacyLocal = url.protocol === 'http:' && url.hostname === '127.0.0.1';
        return (stableApp || legacyLocal) && (url.pathname === '/' || url.pathname === '/index.html');
      } catch (_error) {
        return false;
      }
    }) || null;
  }, 'Mineradio renderer did not expose a DevTools target', 25000, 150);
}

async function launchElectron(debugPort) {
  const launchArgs = [
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-gpu-sandbox',
    '--in-process-gpu',
    '--password-store=basic',
  ];
  if (!packagedExecutable) launchArgs.unshift('.');
  const child = spawn(electron, launchArgs, {
    cwd: packagedExecutable ? path.dirname(electron) : root,
    env: {
      ...process.env,
      MINERADIO_STARTUP_QA_USER_DATA: userData,
      MINERADIO_STARTUP_QA_HIDDEN: '1',
      MINERADIO_STARTUP_QA_INSECURE_CRYPTO: '1',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  let diagnostics = '';
  const collect = (chunk) => { diagnostics = (diagnostics + String(chunk)).slice(-8000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.once('exit', () => children.delete(child));
  try {
    const target = await devtoolsTarget(debugPort);
    const cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await waitFor(() => cdp.evaluate(`window.__mineradioModulesReady === true || !!window.__mineradioModulesError`), 'Renderer did not initialize', 35000);
    const moduleError = await cdp.evaluate(`window.__mineradioModulesError || ''`);
    if (moduleError) throw new Error(`Renderer module initialization failed: ${moduleError}`);
    return { child, cdp, diagnostics: () => diagnostics };
  } catch (error) {
    if (diagnostics) error.message += `\nElectron diagnostics:\n${diagnostics}`;
    throw error;
  }
}

async function playbackState(cdp) {
  return cdp.evaluate(`(() => {
    const song = typeof currentCoverSong === 'function' ? currentCoverSong() : null;
    const metadata = navigator.mediaSession && navigator.mediaSession.metadata;
    return {
      currentIdx,
      songId: song && song.id || '',
      title: song && (song.name || song.title) || '',
      artist: song && song.artist || '',
      playing: !!playing,
      audio: audio ? {
        src: audio.src,
        paused: audio.paused,
        ended: audio.ended,
        readyState: audio.readyState,
        networkState: audio.networkState,
        currentTime: audio.currentTime,
        duration: audio.duration,
        error: audio.error ? { code: audio.error.code, message: audio.error.message } : null
      } : null,
      mediaSession: navigator.mediaSession ? {
        playbackState: navigator.mediaSession.playbackState,
        title: metadata && metadata.title || '',
        artist: metadata && metadata.artist || ''
      } : null
    };
  })()`);
}

function assertActivePlayback(state, expectedIndex, phase) {
  assert.equal(state.currentIdx, expectedIndex, `${phase}: wrong queue index: ${JSON.stringify(state)}`);
  assert.ok(state.songId, `${phase}: current song is missing: ${JSON.stringify(state)}`);
  assert.equal(state.playing, true, `${phase}: renderer playing flag is false: ${JSON.stringify(state)}`);
  assert.ok(state.audio && state.audio.src.includes('/api/navidrome-media?'), `${phase}: Navidrome media URL is missing: ${JSON.stringify(state)}`);
  assert.equal(state.audio.paused, false, `${phase}: audio is paused: ${JSON.stringify(state)}`);
  assert.equal(state.audio.ended, false, `${phase}: audio already ended: ${JSON.stringify(state)}`);
  assert.ok(state.audio.readyState >= 2, `${phase}: audio has no decoded data: ${JSON.stringify(state)}`);
  assert.equal(state.audio.error, null, `${phase}: media error: ${JSON.stringify(state)}`);
  assert.ok(state.mediaSession, `${phase}: Media Session is unavailable: ${JSON.stringify(state)}`);
  assert.equal(state.mediaSession.title, state.title, `${phase}: Media Session title was lost: ${JSON.stringify(state)}`);
  assert.equal(state.mediaSession.artist, state.artist, `${phase}: Media Session artist was lost: ${JSON.stringify(state)}`);
  assert.equal(state.mediaSession.playbackState, 'playing', `${phase}: Media Session state is not playing: ${JSON.stringify(state)}`);
}

async function run() {
  assert.equal(process.platform, 'win32', 'Electron playback smoke is Windows-only');
  const [mockPort, debugPort] = await Promise.all([freePort(), freePort()]);
  await startMock(mockPort);
  const app = await launchElectron(debugPort);
  const { cdp } = app;
  try {
    await cdp.evaluate(`(async () => {
      await window.NavidromeStore.saveServer({
        name: 'Playback Server',
        url: ${JSON.stringify(`http://127.0.0.1:${mockPort}`)},
        username: 'listener',
        password: 'secret',
        insecureConfirmed: true
      });
      await navidromeSyncProviderState(true);
      return window.NavidromeStore.currentServerId();
    })()`);
    await waitFor(() => cdp.evaluate(`window.NavidromeStore.currentServerId() && navidromeIsConnected()`), 'Mock Navidrome server was not activated', 20000);

    const setup = await cdp.evaluate(`(async () => {
      const page = await navidromeSongCollectionPage(0, 3);
      const tracks = page && Array.isArray(page.tracks) ? page.tracks.filter(Boolean).slice(0, 3) : [];
      if (tracks.length < 3) throw new Error('NAVIDROME_PLAYBACK_TRACKS_MISSING');
      playQueue = tracks;
      currentIdx = -1;
      const started = await playQueueAt(0, { manual: true });
      return { started, ids: tracks.map((song) => song.id), titles: tracks.map((song) => song.name) };
    })()`);
    assert.equal(setup.started, true, `Initial playQueueAt failed: ${JSON.stringify(setup)}`);
    await waitFor(async () => {
      const state = await playbackState(cdp);
      return state.currentIdx === 0 && state.audio && !state.audio.paused && state.audio.readyState >= 2 && state.audio.currentTime > 0.05;
    }, 'Initial audio did not start', 25000);
    const first = await playbackState(cdp);
    assertActivePlayback(first, 0, 'initial');

    const nextResult = await cdp.evaluate(`nextTrack(true)`);
    assert.equal(nextResult, true, 'nextTrack did not report successful playback');
    await waitFor(async () => {
      const state = await playbackState(cdp);
      return state.currentIdx === 1 && state.songId === setup.ids[1] && state.audio && !state.audio.paused && state.audio.readyState >= 2;
    }, 'Next track did not become playable', 25000);
    const next = await playbackState(cdp);
    assert.equal(next.songId, setup.ids[1], `nextTrack selected the wrong song: ${JSON.stringify(next)}`);
    assertActivePlayback(next, 1, 'next');

    const previousResult = await cdp.evaluate(`prevTrack(true)`);
    assert.equal(previousResult, true, 'prevTrack did not report successful playback');
    await waitFor(async () => {
      const state = await playbackState(cdp);
      return state.currentIdx === 0 && state.songId === setup.ids[0] && state.audio && !state.audio.paused && state.audio.readyState >= 2;
    }, 'Previous track did not become playable', 25000);
    const previous = await playbackState(cdp);
    assertActivePlayback(previous, 0, 'previous');

    process.stdout.write(`${JSON.stringify({ ok: true, first, next, previous }, null, 2)}\n`);
  } catch (error) {
    const state = await playbackState(cdp).catch(() => null);
    error.message += `\nRenderer state: ${JSON.stringify(state)}\nRenderer logs:\n${cdp.logs.slice(-80).join('\n')}\nElectron diagnostics:\n${app.diagnostics()}`;
    throw error;
  } finally {
    cdp.close();
    await stopChild(app.child);
    children.delete(app.child);
  }
}

run().catch((error) => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exitCode = 1;
}).finally(cleanup);

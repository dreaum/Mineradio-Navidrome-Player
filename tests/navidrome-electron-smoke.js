'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'mock-open-subsonic-server.js');
const packagedExecutable = process.env.MINERADIO_SMOKE_EXECUTABLE
  ? path.resolve(process.env.MINERADIO_SMOKE_EXECUTABLE)
  : '';
const electron = packagedExecutable || require('electron');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-nav-smoke-'));
const artifactDir = path.join(root, 'verification', 'navidrome-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
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

async function waitFor(check, message, timeout = 12000, interval = 100) {
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

function startMock(port, label) {
  const child = spawn(process.execPath, [fixture], {
    cwd: root,
    env: { ...process.env, MINERADIO_MOCK_PORT: String(port), MINERADIO_MOCK_LABEL: label },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
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
    this.socket = null;
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
    // The main renderer uses the stable mineradio://app origin. Keep the
    // smoke test tied to the main page while allowing startup query
    // parameters and retry URL to vary.
    return targets.find((target) => {
      if (!target || target.type !== 'page') return false;
      try {
        const url = new URL(String(target.url || ''));
        const stableApp = url.protocol === 'mineradio:' && url.hostname === 'app';
        const legacyLocal = url.protocol === 'http:' && url.hostname === '127.0.0.1'
          && /^(?:3000|[0-9]+)$/.test(url.port || '3000');
        return (stableApp || legacyLocal) && (url.pathname === '/' || url.pathname === '/index.html');
      } catch (_error) {
        return false;
      }
    }) || null;
  }, 'Mineradio renderer did not expose a DevTools target', 20000, 150);
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
    cwd: packagedExecutable ? path.dirname(packagedExecutable) : root,
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
  const collect = (chunk) => { diagnostics = (diagnostics + String(chunk)).slice(-5000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.once('exit', () => children.delete(child));
  try {
    const target = await devtoolsTarget(debugPort);
    const cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await waitFor(() => cdp.evaluate(`
      location.protocol === 'mineradio:' &&
      !!window.NavidromeStore &&
      !!document.getElementById('navidrome-server-modal-mask') &&
      (window.__mineradioModulesReady === true || !!window.__mineradioModulesError)
    `), 'Renderer did not initialize', 30000);
    const moduleError = await cdp.evaluate(`window.__mineradioModulesError || ''`);
    if (moduleError) throw new Error(`Renderer module initialization failed: ${moduleError}`);
    return { child, cdp, target };
  } catch (error) {
    if (diagnostics) error.message += `\nElectron diagnostics:\n${diagnostics}`;
    throw error;
  }
}

async function closeElectron(instance) {
  if (!instance) return;
  if (instance.cdp) {
    // Close through the exposed desktop IPC so renderer unload/pagehide hooks
    // flush the per-server playback session before Electron exits.
    try { await instance.cdp.evaluate(`window.desktopWindow && window.desktopWindow.close()`); } catch (_error) {}
    await delay(250);
    instance.cdp.close();
  }
  await waitFor(
    () => instance.child && (instance.child.exitCode != null || instance.child.signalCode != null),
    'Electron did not exit cleanly after closing the main window',
    12000,
    120
  ).catch(() => null);
  await stopChild(instance.child);
  children.delete(instance.child);
  await delay(700);
}

async function waitRenderer(cdp, expression, message, timeout = 12000) {
  return waitFor(() => cdp.evaluate(expression), message, timeout, 120);
}

async function setWindowSize(instance, width, height) {
  await instance.cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: height,
  });
  await delay(700);
}

async function screenshot(cdp, name) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const capture = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const target = path.join(artifactDir, name);
  fs.writeFileSync(target, Buffer.from(capture.data, 'base64'));
  return target;
}

function fillServerExpression(name, url) {
  return `(async()=>{
    const values=${JSON.stringify({ name, url })};
    document.getElementById('navidrome-server-id').value='';
    document.getElementById('navidrome-server-name').value=values.name;
    document.getElementById('navidrome-server-url').value=values.url;
    document.getElementById('navidrome-server-username').value='listener';
    document.getElementById('navidrome-server-password').value='secret';
    document.getElementById('navidrome-http-confirm').checked=false;
    updateNavidromeHttpRisk();
    return {
      riskVisible:!document.getElementById('navidrome-http-risk').hidden,
      confirmVisible:!document.getElementById('navidrome-http-confirm-row').hidden
    };
  })()`;
}

async function saveServer(cdp, name, url, verifyGate) {
  const risk = await cdp.evaluate(fillServerExpression(name, url));
  assert.deepEqual(risk, { riskVisible: true, confirmVisible: true });
  if (verifyGate) {
    await cdp.evaluate(`verifyNavidromeServerForm()`);
    const rejected = await waitRenderer(cdp, `document.getElementById('navidrome-server-status').classList.contains('error')`, 'HTTP confirmation gate did not reject verification');
    assert.equal(rejected, true);
  }
  await cdp.evaluate(`document.getElementById('navidrome-http-confirm').checked=true; verifyNavidromeServerForm()`);
  await waitRenderer(cdp, `document.getElementById('navidrome-server-status').classList.contains('success')`, 'Mock server verification failed');
  await cdp.evaluate(`submitNavidromeServerForm()`);
  try {
    await waitRenderer(cdp, `window.NavidromeStore.currentServerId() && !document.getElementById('login-modal').classList.contains('show') && !document.getElementById('navidrome-server-modal-mask').classList.contains('show')`, 'Server was not saved and activated', 20000);
  } catch (error) {
    const state = await cdp.evaluate(`(() => ({
      serverId:window.NavidromeStore.currentServerId(),
      store:window.NavidromeStore.state(),
      status:document.getElementById('navidrome-server-status').textContent,
      statusClass:document.getElementById('navidrome-server-status').className,
      submitError:window.__navidromeServerSubmitError || '',
      loginVisible:document.getElementById('login-modal').classList.contains('show'),
      serverVisible:document.getElementById('navidrome-server-modal-mask').classList.contains('show')
    }))()`);
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
  return cdp.evaluate(`window.NavidromeStore.currentServerId()`);
}

async function assertHomeLayout(instance, width, height, imageName) {
  await setWindowSize(instance, width, height);
  const layout = await instance.cdp.evaluate(`(async()=>{
    homeSuppressed=false;
    homeForcedOpen=true;
    setHomeControlsLocked(true);
    updateEmptyHomeVisibility({forceLoad:false});
    openHomePlayerConsole();
    await new Promise(r=>setTimeout(r,500));
    updateHomePlayerSafeArea();
    const bar=document.getElementById('bottom-bar').getBoundingClientRect();
    const home=document.getElementById('empty-home').getBoundingClientRect();
    const shellNode=document.querySelector('#empty-home .empty-home-shell');
    const shell=shellNode.getBoundingClientRect();
    const shellStyle=getComputedStyle(shellNode);
    const nodes=Array.from(document.querySelectorAll('#empty-home .home-card,#empty-home .home-tile')).filter(el=>{
      const s=getComputedStyle(el); const r=el.getBoundingClientRect();
      return s.display!=='none' && s.visibility!=='hidden' && r.width>0 && r.height>0;
    });
    const rects=nodes.map(el=>el.getBoundingClientRect());
    const visibleRects=rects.filter(r=>r.bottom>shell.top && r.top<shell.bottom && r.right>shell.left && r.left<shell.right);
    const sectionRects=Array.from(shellNode.children).filter(el=>getComputedStyle(el).display!=='none').map(el=>el.getBoundingClientRect());
    const canvas=document.querySelector('#canvas-container canvas');
    return {
      innerWidth,innerHeight,
      tileCount:rects.length,
      visibleTileCount:visibleRects.length,
      visibleTileBottom:Math.max.apply(null,visibleRects.map(r=>Math.min(r.bottom,shell.bottom))),
      tileRight:Math.max.apply(null,rects.map(r=>r.right)),
      contentBottom:Math.max.apply(null,sectionRects.map(r=>r.bottom)),
      homeBottom:home.bottom,
      shellBottom:shell.bottom,
      shellRight:shell.right,
      shellClientHeight:shellNode.clientHeight,
      shellScrollHeight:shellNode.scrollHeight,
      shellOverflowY:shellStyle.overflowY,
      barTop:bar.top,
      barHeight:bar.height,
      safeBottom:getComputedStyle(document.documentElement).getPropertyValue('--mineradio-home-safe-bottom'),
      canvasVisible:!!(canvas && canvas.width>0 && canvas.height>0),
      duplicateWorkspace:!!document.getElementById('navidrome-app')
    };
  })()`);
  assert.equal(layout.duplicateWorkspace, false);
  assert.equal(layout.canvasVisible, true);
  assert.ok(layout.tileCount >= 4, `Home content missing at ${width}x${height}: ${JSON.stringify(layout)}`);
  assert.ok(layout.visibleTileCount > 0, `Home viewport is empty at ${width}x${height}`);
  assert.ok(layout.homeBottom <= layout.barTop - 8, `Home viewport overlaps player at ${width}x${height}: ${JSON.stringify(layout)}`);
  assert.ok(layout.shellBottom <= layout.barTop - 8, `Home shell overlaps player at ${width}x${height}: ${JSON.stringify(layout)}`);
  assert.ok(layout.visibleTileBottom <= layout.barTop - 8, `Visible Home content overlaps player at ${width}x${height}: ${JSON.stringify(layout)}`);
  assert.ok(layout.contentBottom <= layout.barTop - 8 || /auto|scroll/.test(layout.shellOverflowY), `Home overflow is not scroll-contained at ${width}x${height}: ${JSON.stringify(layout)}`);
  assert.ok(layout.shellRight <= layout.innerWidth + 1, `Home shell overflows right edge at ${width}x${height}: ${JSON.stringify(layout)}`);
  assert.ok(layout.tileRight <= layout.innerWidth + 1, `Home overflows right edge at ${width}x${height}: ${JSON.stringify(layout)}`);
  await screenshot(instance.cdp, imageName);
  return layout;
}

async function assertCanvasPixels(cdp) {
  const result = await cdp.evaluate(`(()=>{
    const canvas=document.querySelector('#canvas-container canvas');
    const gl=renderer && renderer.getContext ? renderer.getContext() : null;
    if(!canvas||!gl) return {ready:false};
    renderer.render(scene,camera);
    const rect=canvas.getBoundingClientRect();
    let particleCount=0,visiblePoints=0;
    scene.traverse(object=>{
      if(!object||object.type!=='Points'||object.visible===false) return;
      visiblePoints++;
      const position=object.geometry&&object.geometry.attributes&&object.geometry.attributes.position;
      if(position) particleCount+=Number(position.count)||0;
    });
    return {
      ready:true,
      width:canvas.width,
      height:canvas.height,
      visible:rect.width>0&&rect.height>0&&getComputedStyle(canvas).visibility!=='hidden',
      visiblePoints,
      particleCount,
      alpha:uniforms&&uniforms.uAlpha ? Number(uniforms.uAlpha.value)||0 : 0
    };
  })()`);
  assert.equal(result.ready && result.visible, true, `3D canvas is unavailable: ${JSON.stringify(result)}`);
  assert.ok(result.width > 0 && result.height > 0, `3D canvas has no drawable area: ${JSON.stringify(result)}`);
  assert.ok(result.visiblePoints > 0 && result.particleCount > 0 && result.alpha > 0.05, `3D particle stage is inactive: ${JSON.stringify(result)}`);
}

async function run() {
  assert.equal(process.platform, 'win32', 'Electron smoke test is Windows-only');
  const [mockPortA, mockPortB, debugPortA] = await Promise.all([freePort(), freePort(), freePort()]);
  await Promise.all([startMock(mockPortA, 'Alpha'), startMock(mockPortB, 'Beta')]);

  let app = await launchElectron(debugPortA);
  const cdp = app.cdp;
  await cdp.evaluate(`if(document.body.classList.contains('splash-active')) dismissSplash({instant:true})`);
  await waitRenderer(cdp, `!document.body.classList.contains('splash-active')`, 'Startup splash did not dismiss', 6000);
  const firstRun = await cdp.evaluate(`(()=>({
    modal:document.getElementById('login-modal').classList.contains('show'),
    workspace:!!document.getElementById('navidrome-app'),
    bottom:!!document.getElementById('bottom-bar'),
    home:!!document.getElementById('empty-home'),
    oldSongs:playQueue.length
  }))()`);
  assert.deepEqual(firstRun, { modal: false, workspace: false, bottom: true, home: true, oldSongs: 0 });

  await cdp.evaluate(`onUserBtnClick()`);
  await waitRenderer(cdp, `document.getElementById('navidrome-server-modal-mask').classList.contains('show')`, 'Navidrome-only account entry did not open the server modal');

  const serverA = await saveServer(cdp, 'Alpha Server', `http://127.0.0.1:${mockPortA}`, true);
  const connectedAccount = await cdp.evaluate(`(() => ({
    loginVisible:document.getElementById('login-modal').classList.contains('show'),
    serverVisible:document.getElementById('navidrome-server-modal-mask').classList.contains('show'),
    navPill:!!document.querySelector('#user-btn [data-account-provider="navidrome"]')
  }))()`);
  assert.deepEqual(connectedAccount, { loginVisible: false, serverVisible: false, navPill: true });
  await cdp.evaluate(`onUserBtnClick()`);
  await waitRenderer(cdp, `document.getElementById('user-modal').classList.contains('show') && document.getElementById('user-provider-navidrome').classList.contains('active')`, 'Connected Navidrome source did not enter the original account view');
  assert.equal(await cdp.evaluate(`document.getElementById('navidrome-server-modal-mask').classList.contains('show')`), false);
  await cdp.evaluate(`document.getElementById('account-add-navidrome').click()`);
  await waitRenderer(cdp, `document.getElementById('navidrome-server-modal-mask').classList.contains('show')`, 'Navidrome account view did not expose server management');
  assert.equal(await cdp.evaluate(`document.getElementById('login-modal').classList.contains('show')`), false);
  await cdp.evaluate(`closeNavidromeServerModal()`);
  await waitRenderer(cdp, `window.NavidromeStore.state().home.random.length>0 && homeDiscoverState.songs.length>0 && homeDiscoverState.songs.every(song=>song.provider==='navidrome') && document.querySelectorAll('#home-tile-row .home-tile').length>0`, 'Navidrome Home data did not render', 20000);
  await cdp.evaluate(`if(document.body.classList.contains('splash-active')) dismissSplash()`);
  await waitRenderer(cdp, `!document.body.classList.contains('splash-active') && document.body.classList.contains('empty-home-active')`, 'Home did not activate after the startup transition', 6000);
  await delay(500);
  await cdp.evaluate(`if(document.body.classList.contains('visual-guide-active')) closeVisualGuide(true)`);
  await waitRenderer(cdp, `!document.body.classList.contains('visual-guide-active')`, 'Startup visual guide did not close before layout verification');
  await assertHomeLayout(app, 1280, 720, 'home-1280x720.png');
  await assertHomeLayout(app, 1440, 900, 'home-1440x900.png');
  await assertCanvasPixels(cdp);

  await cdp.evaluate(`(async()=>{
    loginStatus=Object.assign({},loginStatus,{loggedIn:true});
    homeDiscoverState.loaded=false;
    await loadHomeDiscover(true);
  })()`);
  const parallelSourceHome = await cdp.evaluate(`(()=>({
    songs:homeDiscoverState.songs.map(song=>song.provider),
    hasNavidromeTab:!!document.querySelector('[data-home-recommend-source="navidrome"]'),
    hasNavidromeSearchMode:!!document.querySelector('#search-mode-navidrome'),
    controlSources:typeof controlSourceProviders==='function'?controlSourceProviders().map(item=>item.key):[],
    topPills:Array.from(document.querySelectorAll('#user-btn [data-account-provider]')).map(node=>node.getAttribute('data-account-provider'))
  }))()`);
  assert.ok(parallelSourceHome.songs.length > 0 && parallelSourceHome.songs.every((provider) => provider === 'navidrome'), `Legacy login hid Navidrome Home content: ${JSON.stringify(parallelSourceHome)}`);
  assert.equal(parallelSourceHome.hasNavidromeTab, true);
  assert.equal(parallelSourceHome.hasNavidromeSearchMode, true);
  assert.ok(parallelSourceHome.controlSources.includes('navidrome'), `Navidrome source disappeared from the playback source menu: ${JSON.stringify(parallelSourceHome)}`);
  assert.ok(parallelSourceHome.topPills.includes('navidrome'), `Navidrome management pill disappeared beside another provider: ${JSON.stringify(parallelSourceHome)}`);
  await cdp.evaluate(`openHomePlatformRecommendations('navidrome')`);
  await waitRenderer(cdp, `document.querySelectorAll('#home-platform-recommend-list [data-home-recommend-kind="navidrome-song"],#home-platform-recommend-list [data-home-recommend-kind="navidrome-playlist"]').length>0`, 'Navidrome recommendation tab did not show server content', 15000);
  await cdp.evaluate(`closeHomePlatformRecommendations(); loginStatus=Object.assign({},loginStatus,{loggedIn:false}); renderUserBtn()`);

  await cdp.evaluate(`openPlaylistPanelTab('playlists'); document.getElementById('playlist-panel').classList.add('show')`);
  await waitRenderer(cdp, `navidromePlaylists.length>0 && userPlaylists.some(item=>item&&item.provider==='navidrome')`, 'Navidrome playlist did not enter the original playlist catalog', 15000);
  const playlistCollision = await cdp.evaluate(`(()=>{
    const nav=navidromePlaylists.find(item=>item&&!item.virtual);
    if(!nav) return {ready:false};
    neteasePlaylists=[{id:nav.id,name:'Collision from another source',provider:'netease'}];
    rebuildUserPlaylistsFromCatalog({animate:false,preserveScroll:true,reason:'smoke-provider-collision'});
    return {ready:true,count:userPlaylists.filter(item=>String(item.id)===String(nav.id)).length,providers:userPlaylists.filter(item=>String(item.id)===String(nav.id)).map(item=>item.provider)};
  })()`);
  assert.deepEqual(playlistCollision, { ready: true, count: 2, providers: ['navidrome', 'netease'] });
  await cdp.evaluate(`neteasePlaylists=[]; rebuildUserPlaylistsFromCatalog({animate:false,preserveScroll:true,reason:'smoke-clear-provider-collision'})`);
  await waitRenderer(cdp, `Array.from(document.querySelectorAll('#pl-list .pl-card[data-playlist-provider="navidrome"]')).some(card=>!['navidrome-favorites','navidrome-songs','navidrome-albums','navidrome-artists'].includes(card.getAttribute('data-playlist-id')) && card.getAttribute('data-playlist-id'))`, 'Navidrome server playlist did not render in the original side panel', 15000);
  const playlistProbe = await cdp.evaluate(`(async()=>{try{
    const card=Array.from(document.querySelectorAll('#pl-list .pl-card[data-playlist-provider="navidrome"]')).find(card=>!['navidrome-favorites','navidrome-songs','navidrome-albums','navidrome-artists'].includes(card.getAttribute('data-playlist-id')) && card.getAttribute('data-playlist-id'));
    const page=await navidromePlaylistPage(navidromePlaylistIdentity(card.getAttribute('data-playlist-server'),card.getAttribute('data-playlist-id')),0,20);
    return {ok:true,tracks:page.tracks&&page.tracks.length,total:page.total};
  }catch(error){return {ok:false,error:String(error&&error.message||error)}}})()`);
  assert.equal(playlistProbe.ok, true, `Navidrome playlist API failed: ${JSON.stringify(playlistProbe)}`);
  await cdp.evaluate(`Array.from(document.querySelectorAll('#pl-list .pl-card[data-playlist-provider="navidrome"]')).find(card=>!['navidrome-favorites','navidrome-songs','navidrome-albums','navidrome-artists'].includes(card.getAttribute('data-playlist-id')) && card.getAttribute('data-playlist-id')).click()`);
  try {
    await waitRenderer(cdp, `playlistPanelDetailState.key && !playlistPanelDetailState.loading && !playlistPanelDetailState.loadingMore`, 'Navidrome playlist detail request did not settle', 15000);
  } catch (error) {
    const detailState = await cdp.evaluate(`(() => ({
      state: playlistPanelDetailState,
      cards: Array.from(document.querySelectorAll('#pl-list .pl-card')).map(card => ({
        provider: card.getAttribute('data-playlist-provider'),
        id: card.getAttribute('data-playlist-id'),
        expanded: card.getAttribute('aria-expanded')
      })),
      detail: !!document.querySelector('#pl-list .pl-inline-detail')
    }))()`);
    throw new Error(`${error.message}: ${JSON.stringify(detailState)}`);
  }
  const expandedPlaylist = await cdp.evaluate(`(()=>( {
    expanded:(()=>{const card=Array.from(document.querySelectorAll('#pl-list .pl-card[data-playlist-provider="navidrome"]')).find(card=>!['navidrome-favorites','navidrome-songs','navidrome-albums','navidrome-artists'].includes(card.getAttribute('data-playlist-id')) && card.getAttribute('data-playlist-id'));return card&&card.getAttribute('aria-expanded')})(),
    key:playlistPanelDetailState.key,
    error:playlistPanelDetailState.error,
    message:playlistPanelDetailState.message,
    tracks:playlistPanelDetailState.tracks.length,
    rows:document.querySelectorAll('#pl-list [data-pl-detail-row]').length,
    names:Array.from(document.querySelectorAll('#pl-list [data-pl-detail-row] .pl-detail-row-title')).map(el=>el.textContent.trim())
  }))()`);
  assert.equal(expandedPlaylist.error, '', `Navidrome playlist detail failed: ${JSON.stringify(expandedPlaylist)}`);
  assert.equal(expandedPlaylist.tracks, 3, `Navidrome playlist tracks were not loaded: ${JSON.stringify(expandedPlaylist)}`);
  assert.equal(expandedPlaylist.expanded, 'true', `Navidrome playlist card is not expanded: ${JSON.stringify(expandedPlaylist)}`);
  assert.equal(expandedPlaylist.rows, 3, `Navidrome playlist rows were not rendered: ${JSON.stringify(expandedPlaylist)}`);
  await cdp.evaluate(`Array.from(document.querySelectorAll('#pl-list .pl-card[data-playlist-provider="navidrome"]')).find(card=>!['navidrome-favorites','navidrome-songs','navidrome-albums','navidrome-artists'].includes(card.getAttribute('data-playlist-id')) && card.getAttribute('data-playlist-id')).click()`);
  await waitRenderer(cdp, `!playlistPanelDetailState.key && !document.querySelector('#pl-list .pl-inline-detail')`, 'Navidrome playlist did not collapse when clicked again');
  assert.equal(await cdp.evaluate(`Array.from(document.querySelectorAll('#pl-list .pl-card[data-playlist-provider="navidrome"]')).find(card=>!['navidrome-favorites','navidrome-songs','navidrome-albums','navidrome-artists'].includes(card.getAttribute('data-playlist-id')) && card.getAttribute('data-playlist-id')).getAttribute('aria-expanded')`), 'false');

  const createdPlaylist = await cdp.evaluate(`(async()=>{
    const originalPrompt=window.prompt;
    window.prompt=()=> 'Smoke CRUD';
    try { await createNavidromePlaylistFromPanel(); } finally { window.prompt=originalPrompt; }
    const playlist=navidromePlaylists.find(item=>item&&item.name==='Smoke CRUD');
    return playlist ? {id:String(playlist.id),serverId:String(playlist.serverId||navidromeCurrentServerId())} : null;
  })()`);
  assert.ok(createdPlaylist && createdPlaylist.id, `Navidrome playlist UI create failed: ${JSON.stringify(createdPlaylist)}`);
  await cdp.evaluate(`(async()=>{
    navidromeMutationValue(await window.navidrome.addPlaylistSongs(${JSON.stringify(createdPlaylist.serverId)},${JSON.stringify(createdPlaylist.id)},['song-0','song-1']),'NAVIDROME_PLAYLIST_ADD_FAILED');
    await invalidateNavidromePlaylistMetadata(${JSON.stringify(createdPlaylist.serverId)});
    await navidromeSyncProviderState(true);
  })()`);
  await waitRenderer(cdp, `Array.from(document.querySelectorAll('#pl-list .pl-card[data-playlist-provider="navidrome"]')).some(card=>card.getAttribute('data-playlist-id')===${JSON.stringify(createdPlaylist.id)})`, 'Created Navidrome playlist did not enter the original side panel', 15000);
  await cdp.evaluate(`Array.from(document.querySelectorAll('#pl-list .pl-card[data-playlist-provider="navidrome"]')).find(card=>card.getAttribute('data-playlist-id')===${JSON.stringify(createdPlaylist.id)}).click()`);
  await waitRenderer(cdp, `playlistPanelDetailState.key && !playlistPanelDetailState.loading && playlistPanelDetailState.tracks.length===2`, 'Created Navidrome playlist songs did not load', 15000);
  const originalCrudOrder = await cdp.evaluate(`playlistPanelDetailState.tracks.map(song=>song.id)`);
  assert.deepEqual(originalCrudOrder, ['song-0', 'song-1']);
  await cdp.evaluate(`(async()=>{
    const originalPrompt=window.prompt;
    window.prompt=()=> 'Smoke Renamed';
    try { await renameNavidromePlaylistPanel(); } finally { window.prompt=originalPrompt; }
  })()`);
  await waitRenderer(cdp, `navidromePlaylists.some(item=>item&&item.id===${JSON.stringify(createdPlaylist.id)}&&item.name==='Smoke Renamed')`, 'Navidrome playlist rename did not reach the server-backed catalog', 15000);
  await cdp.evaluate(`reorderNavidromePlaylistPanel(0,1)`);
  await waitRenderer(cdp, `!playlistPanelDetailState.loading && playlistPanelDetailState.tracks.length===2 && playlistPanelDetailState.tracks[0].id==='song-1'`, 'Navidrome playlist reorder did not persist', 15000);
  await cdp.evaluate(`removeNavidromePlaylistTrack(0)`);
  await waitRenderer(cdp, `!playlistPanelDetailState.loading && playlistPanelDetailState.tracks.length===1 && playlistPanelDetailState.tracks[0].id==='song-0'`, 'Navidrome playlist track removal did not persist', 15000);
  await cdp.evaluate(`(async()=>{
    const originalConfirm=window.confirm;
    window.confirm=()=>true;
    try { await deleteNavidromePlaylistPanel(); } finally { window.confirm=originalConfirm; }
  })()`);
  await waitRenderer(cdp, `!navidromePlaylists.some(item=>item&&item.id===${JSON.stringify(createdPlaylist.id)}) && !playlistPanelDetailState.key`, 'Navidrome playlist delete did not persist', 15000);

  await cdp.evaluate(`if(document.body.classList.contains('visual-guide-active')) closeVisualGuide(true)`);
  await delay(250);
  await screenshot(cdp, 'playlist-panel-collapsed.png');
  await cdp.evaluate(`togglePlaylistPanel(false)`);

  const preservedCatalog = await cdp.evaluate(`(async()=>{
    await refreshLoginStatus();
    return {
      navidrome:navidromePlaylists.length,
      user:userPlaylists.filter(item=>item&&item.provider==='navidrome').length
    };
  })()`);
  assert.ok(preservedCatalog.navidrome > 0 && preservedCatalog.user > 0, `Legacy login refresh removed Navidrome playlists: ${JSON.stringify(preservedCatalog)}`);

  await cdp.evaluate(`(async()=>{fx.shelfCameraMode='dynamic'; focusHover.wantType='shelf-side'; orbit.focus.active=false; await openHomeLibrary()})()`);
  try {
    await waitRenderer(cdp, `shelfPinnedOpen && !shelfManager.hasOpenContent() && shelfManager.getCards().some(card=>card.item&&card.item.provider==='navidrome')`, 'Home library did not open the original Navidrome shelf', 20000);
  } catch (error) {
    const shelfState = await cdp.evaluate(`(() => ({
      pinned: shelfPinnedOpen,
      mode: shelfManager && shelfManager.getMode && shelfManager.getMode(),
      open: shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent(),
      navidrome: navidromePlaylists.length,
      user: userPlaylists.filter(item => item && item.provider === 'navidrome').length,
      cards: shelfManager && shelfManager.getCards ? shelfManager.getCards().map(card => ({ provider: card.item && card.item.provider, playlistId: card.item && card.item.playlistId })) : [],
      rebuildError: (() => { try { shelfManager.rebuild(false); return ''; } catch (error) { return String(error && error.stack || error); } })()
    }))()`);
    throw new Error(`${error.message}: ${JSON.stringify(shelfState)}`);
  }
  const libraryShelf = await cdp.evaluate(`(()=>({
    pinned:shelfPinnedOpen,
    focus:orbit.focus.type,
    cards:shelfManager.getCards().map(card=>({title:card.item&&card.item.title,provider:card.item&&card.item.provider,playlistId:card.item&&card.item.playlistId}))
  }))()`);
  assert.equal(libraryShelf.pinned, true);
  assert.ok(libraryShelf.cards.some(card=>card.provider==='navidrome' && /navidrome-songs$/.test(card.playlistId)), `All-songs shelf card missing: ${JSON.stringify(libraryShelf)}`);
  assert.ok(libraryShelf.cards.some(card=>card.provider==='navidrome' && /navidrome-albums$/.test(card.playlistId)), `Album catalog shelf card missing: ${JSON.stringify(libraryShelf)}`);
  assert.ok(libraryShelf.cards.some(card=>card.provider==='navidrome' && /navidrome-artists$/.test(card.playlistId)), `Artist catalog shelf card missing: ${JSON.stringify(libraryShelf)}`);
  assert.ok(libraryShelf.cards.some(card=>card.provider==='navidrome' && !/navidrome-(songs|favorites|albums|artists)$/.test(card.playlistId)), `Server playlist shelf card missing: ${JSON.stringify(libraryShelf)}`);
  await cdp.evaluate(`if(document.body.classList.contains('visual-guide-active')) closeVisualGuide(true)`);
  await delay(250);
  await screenshot(cdp, 'navidrome-library-shelf.png');

  await cdp.evaluate(`(()=>{const cards=shelfManager.getCards();const card=cards.find(item=>item.item&&/navidrome-artists$/.test(item.item.playlistId));shelfManager.openContent(card.index)})()`);
  await waitRenderer(cdp, `shelfManager.hasOpenContent() && shelfManager.getContentList().getRows().some(row=>row.song&&row.song.type==='navidrome-artist')`, 'Artist catalog did not open in the original 3D detail', 20000);
  const artistCatalog = await cdp.evaluate(`(()=>{const rows=shelfManager.getContentList().getRows();return {rows:rows.length,artists:rows.filter(row=>row.song&&row.song.type==='navidrome-artist').map(row=>row.song.name),focus:orbit.focus.type}})()`);
  assert.ok(artistCatalog.rows > 0 && artistCatalog.artists.includes('Mineradio Artist'), `Artist catalog rows missing: ${JSON.stringify(artistCatalog)}`);
  assert.equal(artistCatalog.focus, 'shelf-detail');
  await cdp.evaluate(`if(document.body.classList.contains('visual-guide-active')) closeVisualGuide(true)`);
  await delay(250);
  await screenshot(cdp, 'artists-detail-1440x900.png');
  await cdp.evaluate(`(()=>{const cl=shelfManager.getContentList();cl.openCatalogRow(cl.getRows().find(row=>row.song&&row.song.id==='artist-mineradio'))})()`);
  await waitRenderer(cdp, `shelfManager.getContentList().getRows().some(row=>row.song&&row.song.type==='navidrome-album'&&row.song.id==='album-0')`, 'Artist albums did not replace the 3D detail content', 20000);
  await cdp.evaluate(`(()=>{const cl=shelfManager.getContentList();cl.openCatalogRow(cl.getRows().find(row=>row.song&&row.song.type==='navidrome-album'))})()`);
  await waitRenderer(cdp, `shelfManager.getContentList().getRows().some(row=>row.song&&row.song.type==='navidrome')`, 'Album songs did not replace the 3D detail content', 20000);
  const albumSongs = await cdp.evaluate(`(()=>{const rows=shelfManager.getContentList().getRows();return {rows:rows.length,songs:rows.filter(row=>row.song&&row.song.type==='navidrome').map(row=>row.song.name)}})()`);
  assert.ok(albumSongs.rows > 0 && albumSongs.songs.some(name=>name.startsWith('Alpha')), `Album song rows missing: ${JSON.stringify(albumSongs)}`);
  await cdp.evaluate(`if(document.body.classList.contains('visual-guide-active')) closeVisualGuide(true)`);
  await delay(250);
  await screenshot(cdp, 'album-songs-detail-1440x900.png');
  await cdp.evaluate(`(()=>{const cl=shelfManager.getContentList();cl.playRow(cl.getRows().find(row=>row.song&&row.song.type==='navidrome'))})()`);
  await waitRenderer(cdp, `currentCoverSong()&&currentCoverSong().name.startsWith('Alpha')&&audio.src.includes('/api/navidrome-media?')`, 'Album song did not enter the original player', 20000);
  await cdp.evaluate(`safeShelfCloseContent('electron-smoke-catalog')`);

  await cdp.evaluate(`(()=>{const cards=shelfManager.getCards();const card=cards.find(item=>item.item&&/navidrome-songs$/.test(item.item.playlistId));shelfManager.openContent(card.index)})()`);
  await waitRenderer(cdp, `window.NavidromeStore.state().songs.length===80 && shelfManager.hasOpenContent()`, 'All-songs detail did not open', 20000);
  await delay(900);
  const detail = await cdp.evaluate(`(()=>{
    const cl=shelfManager.getContentList();
    const rows=cl.getRows();
    const row=rows.find(r=>r && r.mesh && r.mesh.visible);
    let projected=null,clickable=false;
    if(row){
      const p=new THREE.Vector3(); row.mesh.getWorldPosition(p); p.project(camera);
      projected={x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2};
      clickable=!!cl.pickRowAtScreen(projected.x,projected.y);
    }
    return {
      open:cl.isOpen(),
      focusActive:orbit.focus.active,
      focusType:orbit.focus.type,
      wanted:focusHover.wantType,
      rows:rows.length,
      rowVisible:!!row,
      rowOpacity:row&&row.mesh.material.opacity,
      parentVisible:!!(row&&row.mesh.parent&&row.mesh.parent.visible),
      projected,clickable
    };
  })()`);
  assert.equal(detail.open, true);
  assert.equal(detail.focusActive, true);
  assert.equal(detail.focusType, 'shelf-detail');
  assert.equal(detail.wanted, 'shelf-detail');
  assert.ok(detail.rows > 0 && detail.rows <= 20, `Detail virtualization failed: ${JSON.stringify(detail)}`);
  assert.equal(detail.rowVisible && detail.parentVisible && detail.clickable, true, `Detail row is not visible/clickable: ${JSON.stringify(detail)}`);
  assert.ok(detail.rowOpacity > 0.05);
  assert.ok(detail.projected.x >= 0 && detail.projected.x <= 1440 && detail.projected.y >= 0 && detail.projected.y <= 900);
  await cdp.evaluate(`if(document.body.classList.contains('visual-guide-active')) closeVisualGuide(true)`);
  await delay(250);
  await screenshot(cdp, 'songs-detail-1440x900.png');
  await assertCanvasPixels(cdp);

  await cdp.evaluate(`shelfManager.getContentList().scrollBy(70)`);
  await waitRenderer(cdp, `window.NavidromeStore.state().songs.length===160`, 'Second song page did not load', 15000);
  await cdp.evaluate(`shelfManager.getContentList().scrollBy(80)`);
  await waitRenderer(cdp, `window.NavidromeStore.state().songs.length===165 && window.NavidromeStore.state().songsComplete`, 'Final song page did not load', 15000);
  const virtualRows = await cdp.evaluate(`shelfManager.getContentList().getRows().length`);
  assert.ok(virtualRows <= 20, `All songs were rendered into WebGL (${virtualRows})`);

  await cdp.evaluate(`(async()=>{safeShelfCloseContent('electron-smoke'); setSearchMode('navidrome'); $input.value='Mineradio'; await doSearch('Mineradio')})()`);
  const search = await cdp.evaluate(`(()=>({
    songs:document.querySelectorAll('#search-results .search-result').length,
    sections:Array.from(document.querySelectorAll('#search-results .search-history-head span:first-child')).map(el=>el.textContent.trim()),
    albums:window.NavidromeStore.state().search.album.length,
    artists:window.NavidromeStore.state().search.artist.length
  }))()`);
  assert.deepEqual(search.sections.slice(0, 3), ['艺术家', '专辑', '歌曲']);
  assert.ok(search.songs >= 2 && search.albums > 0 && search.artists > 0);

  await cdp.evaluate(`document.querySelector('#search-results [data-search-facet="album"]').click()`);
  await waitRenderer(cdp, `document.getElementById('track-detail-modal').classList.contains('show') && document.getElementById('track-detail-heading').textContent==='专辑详情' && document.querySelectorAll('#album-song-list .artist-song-item').length===10`, 'Search album did not open the original detail modal', 15000);
  await cdp.evaluate(`closeTrackDetailModal()`);
  await waitRenderer(cdp, `!document.getElementById('track-detail-modal').classList.contains('show')`, 'Album detail modal did not close');
  await cdp.evaluate(`document.querySelector('#search-results [data-search-facet="artist"]').click()`);
  await waitRenderer(cdp, `document.getElementById('track-detail-modal').classList.contains('show') && document.getElementById('track-detail-heading').textContent==='歌手详情'`, 'Search artist did not open the original detail modal', 15000);
  await waitRenderer(cdp, `document.querySelector('#artist-hot-songs') && !document.querySelector('#artist-hot-songs .detail-loading')`, 'Search artist detail did not settle', 15000);
  const artistDetail = await cdp.evaluate(`(()=>( {
    rows:document.querySelectorAll('#artist-hot-songs .artist-song-item').length,
    text:document.getElementById('artist-hot-songs').textContent.trim(),
    title:document.querySelector('#track-detail-body .detail-title').textContent.trim()
  }))()`);
  assert.ok(artistDetail.rows > 0, `Search artist detail has no songs: ${JSON.stringify(artistDetail)}`);
  await cdp.evaluate(`closeTrackDetailModal()`);
  await waitRenderer(cdp, `!document.getElementById('track-detail-modal').classList.contains('show')`, 'Artist detail modal did not close');

  await cdp.evaluate(`playSearchResult(0)`);
  await waitRenderer(cdp, `audio && audio.src.includes('/api/navidrome-media?') && currentCoverSong() && currentCoverSong().name.startsWith('Alpha')`, 'Search result did not start playback', 20000);
  await waitRenderer(cdp, `audio && audio.readyState>=2 && !audio.paused`, 'Search result media did not become playable', 20000);
  await cdp.evaluate(`queueSearchResult(1);`);
  await waitRenderer(cdp, `lyricsLines.some(line=>String(line.text||'').includes('Mock synchronized lyric'))`, 'Synchronized lyrics did not load', 15000);
  await waitRenderer(cdp, `currentCoverSong() && String(currentCoverSong().cover||currentCoverSong().coverPath||'').length>0`, 'Cover capability did not hydrate', 15000);
  await waitRenderer(cdp, `uniforms.uHasCover.value>0`, 'Cover texture did not render', 15000);
  const playback = await cdp.evaluate(`(()=>({
    paused:audio.paused,
    queue:playQueue.length,
    queueNames:playQueue.map(song=>song && song.name),
    queueIds:playQueue.map(song=>song && song.id),
    currentIdx,
    current:currentCoverSong().name,
    audioUrl:audio.src,
    currentTime:audio.currentTime,
    duration:audio.duration,
    ended:audio.ended,
    readyState:audio.readyState,
    mediaError:audio.error&&audio.error.message,
    playingState:playing,
    cover:currentCoverSong().cover,
    coverTexture:uniforms.uHasCover.value,
    lyrics:lyricsLines.map(line=>line.text)
  }))()`);
  assert.equal(playback.paused, false, `Playback is not active: ${JSON.stringify(playback)}`);
  assert.ok(playback.queue >= 2, `Queued search result was lost: ${JSON.stringify(playback)}`);
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/api\/navidrome-media\?kind=stream&cap=/.test(playback.audioUrl));
  assert.ok(playback.cover.includes('/api/navidrome-media?') || /^blob:/.test(playback.cover));
  assert.ok(playback.lyrics.includes('Mock synchronized lyric'));

  await cdp.evaluate(`togglePlay()`);
  await waitRenderer(cdp, `audio.paused`, 'Pause control did not pause audio');
  await cdp.evaluate(`togglePlay()`);
  await waitRenderer(cdp, `!audio.paused`, 'Pause control did not resume audio');
  await cdp.evaluate(`audio.currentTime=4`);
  await waitRenderer(cdp, `audio.currentTime>=3.5`, 'Seek did not update playback position');
  const beforeNext = await cdp.evaluate(`currentCoverSong().name`);
  await cdp.evaluate(`nextTrack()`);
  await waitRenderer(cdp, `currentCoverSong() && currentCoverSong().name!==${JSON.stringify(beforeNext)} && audio.src.includes('/api/navidrome-media?')`, 'Next did not advance the queue', 15000);

  await cdp.evaluate(`toggleLikeSong(currentCoverSong())`);
  await waitRenderer(cdp, `currentCoverSong() && currentCoverSong().starred===true`, 'star did not update the current song', 15000);
  await cdp.evaluate(`toggleLikeSong(currentCoverSong())`);
  await waitRenderer(cdp, `currentCoverSong() && currentCoverSong().starred===false`, 'unstar did not update the current song', 15000);
  await cdp.evaluate(`saveNavidromePlaybackSession()`);

  const serverB = await saveServer(cdp, 'Beta Server', `http://127.0.0.1:${mockPortB}`, false);
  assert.notEqual(serverA, serverB);
  const switchedEmpty = await cdp.evaluate(`(()=>({
    active:window.NavidromeStore.currentServerId(),queue:playQueue.length,index:currentIdx,
    audio:audio&&audio.getAttribute('src'),lyrics:lyricsLines.length,cover:uniforms.uHasCover.value
  }))()`);
  assert.deepEqual(switchedEmpty, { active: serverB, queue: 0, index: -1, audio: null, lyrics: 0, cover: 0 });

  await cdp.evaluate(`setSearchMode('navidrome'); $input.value='Beta'; doSearch('Beta')`);
  await waitRenderer(cdp, `playlist.length>1 && playlist[0].name.startsWith('Beta')`, 'Second server search did not load');
  await cdp.evaluate(`playSearchResult(0)`);
  await waitRenderer(cdp, `currentCoverSong() && currentCoverSong().name.startsWith('Beta') && audio.src.includes('/api/navidrome-media?')`, 'Second server playback failed', 15000);
  await cdp.evaluate(`saveNavidromePlaybackSession(); switchNavidromeServer(${JSON.stringify(serverA)})`);
  await waitRenderer(cdp, `window.NavidromeStore.currentServerId()===${JSON.stringify(serverA)} && playQueue.length>0 && playQueue[0].name.startsWith('Alpha')`, 'First server session was not restored', 20000);
  const restoredA = await cdp.evaluate(`(()=>({audio:audio&&audio.getAttribute('src'),lyrics:lyricsLines.length,cover:uniforms.uHasCover.value,queue:playQueue.map(s=>s.name)}))()`);
  assert.equal(restoredA.audio, null);
  assert.equal(restoredA.lyrics, 0);
  assert.equal(restoredA.cover, 0);
  assert.ok(restoredA.queue.every((name) => name.startsWith('Alpha')));

  await cdp.evaluate(`switchNavidromeServer(${JSON.stringify(serverB)})`);
  await waitRenderer(cdp, `window.NavidromeStore.currentServerId()===${JSON.stringify(serverB)} && playQueue.length>0 && playQueue[0].name.startsWith('Beta')`, 'Second server session was not restored', 20000);
  await screenshot(cdp, 'server-beta-restored.png');
  await closeElectron(app);
  app = null;

  const debugPortB = await freePort();
  app = await launchElectron(debugPortB);
  try {
    await waitRenderer(app.cdp, `window.NavidromeStore.state().ready && window.NavidromeStore.currentServerId()`, 'Restart did not initialize the active server', 20000);
  } catch (error) {
    const restartState = await app.cdp.evaluate(`(() => ({
      store: window.NavidromeStore && window.NavidromeStore.state(),
      rendererReady: typeof navidromeRendererReady === 'undefined' ? null : navidromeRendererReady,
      href: location.href,
      title: document.title,
      bodyClass: document.body && document.body.className,
      bodyChildren: document.body && document.body.children.length,
      serverModal: document.getElementById('navidrome-server-modal-mask') && document.getElementById('navidrome-server-modal-mask').className,
      status: document.getElementById('navidrome-server-status') && document.getElementById('navidrome-server-status').textContent
    }))()`);
    const files = fs.readdirSync(userData, { withFileTypes: true }).map((entry) => entry.name);
    const startupStatePath = path.join(userData, 'startup-state.json');
    const startupState = fs.existsSync(startupStatePath) ? fs.readFileSync(startupStatePath, 'utf8') : '';
    throw new Error(`${error.message}: ${JSON.stringify({ restartState, files, startupState })}`);
  }
  await delay(1800);
  const restart = await app.cdp.evaluate(`(()=>({
    active:window.NavidromeStore.currentServerId(),
    queue:playQueue.map(s=>({name:s.name,serverId:s.serverId})),
    audio:audio&&audio.getAttribute('src'),
    workspace:!!document.getElementById('navidrome-app')
  }))()`);
  assert.equal(restart.active, serverB);
  assert.equal(restart.workspace, false);
  assert.equal(restart.audio, null);
  assert.ok(restart.queue.length > 0 && restart.queue.every((song) => song.name.startsWith('Beta') && song.serverId === serverB), `Restart restored wrong session: ${JSON.stringify(restart)}`);
  await closeElectron(app);
  app = null;

  process.stdout.write(`Electron smoke passed; screenshots: ${artifactDir}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exitCode = 1;
}).finally(cleanup);

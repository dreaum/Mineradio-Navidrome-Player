'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const htmlSource = read('public/index.html');
const loaderSource = read('public/js/index-loader.js');
const stateSource = read('public/js/modules/00-state/00-core-stores.js');
const searchSource = read('public/js/modules/05-playback/07-search.js');
const detailSource = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
const playlistSource = read('public/js/modules/06-lyrics/02-playlist-detail.js');
const playlistShellSource = read('public/js/modules/06-lyrics/01-playlist-panel-shell.js');
const providerSource = read('public/js/modules/08-account/06-navidrome-provider.js');
const loginUtilsSource = read('public/js/modules/08-account/01-login-modal-utils.js');
const homeDiscoverSource = read('public/js/modules/05-playback/03-home-discover-weather.js');
const homeDashboardSource = read('public/js/modules/05-playback/03a-home-dashboard.js');
const homeActionsSource = read('public/js/modules/05-playback/04-home-empty-wallpaper.js');
const shelfSource = read('public/js/modules/04-shelf/01-manager-core.js');
const contentListSource = read('public/js/modules/04-shelf/03-content-list-manager.js');
const cardInteractionSource = read('public/js/modules/04-shelf/05-card-interactions.js');
const focusCameraSource = read('public/js/modules/01-scene/03-focus-cinema-camera.js');
const storeSource = read('public/navidrome-store.js');
const cacheSource = read('public/navidrome-cache.js');
const loginStatusSource = read('public/js/modules/08-account/02-login-status.js');
const logoutSource = read('public/js/modules/08-account/04-user-modal-logout.js');
const preloadSource = read('desktop/preload.js');
const mainSource = read('desktop/main.js');
const serverSource = read('server.js');
const qualitySource = read('public/js/modules/05-playback/00-api-quality-output.js');
const playbackSource = read('public/js/modules/05-playback/13-playback-start-audio.js');

test('renderer keeps the upstream Mineradio shell and adds no second Navidrome workspace', () => {
  assert.doesNotMatch(htmlSource, /navidrome-app\.(?:css|js)|navidrome-workspace-btn|id="navidrome-app"/);
  assert.match(htmlSource, /id="empty-home"/);
  assert.match(htmlSource, /id="playlist-panel"/);
  assert.match(htmlSource, /id="bottom-bar"/);
  assert.match(htmlSource, /id="search-mode-navidrome"/);
  assert.match(htmlSource, /id="account-add-navidrome"/);
  assert.match(htmlSource, /id="user-provider-navidrome"/);
  assert.match(htmlSource, /id="login-provider-navidrome"[^>]*data-login-provider="navidrome"/);
  assert.match(loaderSource, /06-navidrome-provider\.js/);
  assert.match(loaderSource, /modulePaths\.map\(readModule\)\.join\('\\n'\)/);
  assert.match(loaderSource, /window\.__mineradioModulesReady = true/);
});

test('Navidrome edition removes the upstream updater and its original-repository route', () => {
  assert.match(htmlSource, /id="file-input"|id="local-folder-input"/);
  assert.doesNotMatch(htmlSource, /id="update-modal"|id="update-entry"/);
  assert.doesNotMatch(loaderSource, /00-update-preview\.js/);
  assert.doesNotMatch(read('public/js/modules/08-account/01-login-modal-utils.js'), /closeUpdatePanel|update-modal/);
  assert.doesNotMatch(preloadSource, /openUpdatePage|mineradio-open-update-page/);
  assert.doesNotMatch(mainSource, /mineradio-open-update-page/);
  assert.match(stateSource, /neteasePlaylists/);
  assert.match(stateSource, /qqPlaylists/);
  assert.match(stateSource, /kugouPlaylists/);
  assert.match(stateSource, /qishuiPlaylists/);
  assert.match(stateSource, /spotifyPlaylists/);
  assert.match(preloadSource, /importLocalMusicFiles/);
  assert.match(mainSource, /mineradio-local-library-import/);
});

test('account and platform recommendation entry points expose only Navidrome', () => {
  const accountTabs = htmlSource.match(/<div class="user-platform-tabs" id="user-platform-tabs">([\s\S]*?)<\/div>/);
  const accountActions = htmlSource.match(/<div class="account-modal-actions">([\s\S]*?)<\/div>/);
  const recommendationTabs = htmlSource.match(/<div id="home-platform-recommend-tabs"[\s\S]*?>[\s\S]*?<\/div>/);
  assert.ok(accountTabs && accountActions && recommendationTabs);
  assert.match(accountTabs[1], /user-provider-navidrome/);
  assert.doesNotMatch(accountTabs[1], /user-provider-(?:netease|qq|kugou|qishui|spotify|both)/);
  assert.match(accountActions[1], /account-add-navidrome/);
  assert.doesNotMatch(accountActions[1], /account-add-(?:netease|qq|kugou|qishui|spotify)/);
  assert.match(recommendationTabs[0], /data-home-recommend-source="navidrome"/);
  assert.doesNotMatch(recommendationTabs[0], /data-home-recommend-source="(?:netease|qq|kugou|qishui|spotify)"/);
  assert.match(homeDashboardSource, /var source = 'navidrome';/);
  assert.match(loginUtilsSource, /function onUserBtnClick[\s\S]{0,420}openNavidromeServerModal\(\)/);
  assert.doesNotMatch(loginStatusSource, /function renderUserBtn\(\)[\s\S]{0,900}accountProviderExternalRenderList/);
});

test('Navidrome server setup is an optional glass modal instead of a startup gate', () => {
  assert.match(htmlSource, /id="navidrome-server-modal-mask" class="modal-mask"/);
  assert.match(htmlSource, /class="modal navidrome-server-modal"/);
  assert.match(providerSource, /function openNavidromeServerModal/);
  assert.doesNotMatch(providerSource, /showLoginModal\(\{[^}]*startup/);
  assert.doesNotMatch(providerSource, /function initializeNavidromeProvider[\s\S]*?openNavidromeServerModal\(/);
});

test('portable startup re-encrypts legacy Navidrome secrets without importing provider sessions', () => {
  assert.match(mainSource, /await migrateLegacyNavidromeConfig\(\)/);
  assert.match(mainSource, /reencryptLegacyNavidromeSecrets\(\{/);
  assert.match(mainSource, /encryptString: \(value\) => safeStorage\.encryptString\(value\)/);
  assert.match(mainSource, /if \(STARTUP_QA_USER_DATA_PATH\) return/);
});

test('Navidrome provider reuses original search, player detail and playlist contracts', () => {
  assert.match(searchSource, /MUSIC_SEARCH_PROVIDER_ORDER = \[[^\]]*'navidrome'/);
  assert.match(searchSource, /navidromeSearchCatalog\(q\)/);
  assert.match(searchSource, /navidromeSearchGroupHtml\('艺术家', 'artist'/);
  assert.match(searchSource, /openNavidromeSearchFacet/);
  assert.match(searchSource, /function searchProviderStatus\(provider\) \{\s*if \(provider === 'navidrome'\)/);
  assert.match(detailSource, /navidromeAlbumDetailForSong\(song\)/);
  assert.match(detailSource, /navidromeArtistDetailForSong\(song\)/);
  assert.match(playlistSource, /if \(playlistPanelDetailState\.key === key\)[\s\S]{0,260}playlistPanelDetailState\.key = ''/);
  assert.match(playlistSource, /provider === 'navidrome'[\s\S]{0,120}navidromePlaylistPage/);
  assert.match(providerSource, /return 'navidrome:' \+ String\(serverId \|\| navidromeCurrentServerId\(\)\) \+ ':' \+ String\(playlistId \|\| ''\)/);
  assert.match(providerSource, /value = value\.slice\('navidrome:'\.length\)/);
  assert.doesNotMatch(providerSource, /value = value\.slice\(11\)/);
  assert.match(providerSource, /if \(node\.type === 'navidrome'\) navidromeNormalizeSong\(node\)/);
  assert.doesNotMatch(providerSource, /node\.type === 'navidrome' \|\| node\.serverId/);
  assert.match(playlistSource, /provider === 'navidrome'\) return \{ provider: provider, serverId: parts\.shift\(\) \|\| '', id: parts\.join\(':'\) \}/);
  assert.match(playlistShellSource, /function openPlaylistPanelTab\([\s\S]{0,420}setPeek\(panel, true, 'pl'\);\s*switchPlaylistTab\(tab\)[\s\S]{0,140}schedulePlaylistPanelVirtualRender\(\)/);
  assert.match(providerSource, /id: 'navidrome-songs'/);
  assert.match(providerSource, /id: 'navidrome-albums'/);
  assert.match(providerSource, /id: 'navidrome-artists'/);
  assert.match(providerSource, /libraryAllSongs: true/);
  assert.match(providerSource, /identity\.playlistId\) === 'navidrome-songs'[\s\S]{0,100}navidromeSongCollectionPage/);
  assert.match(providerSource, /catalogKind === 'albums'\) return navidromeAlbumCollectionPage/);
  assert.match(providerSource, /catalogKind === 'artists'\) return navidromeArtistCollectionPage/);
  assert.match(providerSource, /catalogKind === 'artist-albums'\) return navidromeArtistAlbumCollectionPage/);
  assert.match(providerSource, /catalogKind === 'album'\) return navidromeAlbumSongPage/);
  assert.match(contentListSource, /function openNavidromeCatalogItem\(row\)/);
  assert.match(contentListSource, /item\.type === 'navidrome-artist'[\s\S]{0,120}navidrome-artist-albums:/);
  assert.match(contentListSource, /navidrome-album:/);
  assert.match(contentListSource, /openCatalogRow: function \(row\) \{ return openNavidromeCatalogItem\(row\); \}/);
  assert.match(cardInteractionSource, /cl\.openCatalogRow\(rowHit\.row\)/);
  assert.match(playlistSource, /pl\.libraryAllSongs[\s\S]{0,220}按需加载服务器曲库/);
});

test('playlist detail and virtual list state initialize before provider synchronization', () => {
  const loader = read('public/js/index-loader.js');
  const stateIndex = loader.indexOf("js/modules/00-state/01-perf-render-state.js");
  const peekIndex = loader.indexOf("js/modules/10-shell/02-peek-panels-upload.js");
  const providerIndex = loader.indexOf("js/modules/08-account/06-navidrome-provider.js");
  const state = read('public/js/modules/00-state/01-perf-render-state.js');
  const detail = read('public/js/modules/06-lyrics/02-playlist-detail.js');
  const peekShell = read('public/js/modules/10-shell/02-peek-panels-upload.js');

  assert.ok(stateIndex >= 0 && providerIndex > stateIndex && peekIndex > providerIndex);
  assert.match(state, /var playlistPanelDetailState = \{/);
  assert.match(state, /var playlistPanelVirtualCache = \{/);
  assert.match(state, /var peekTimers = \{ search: null, fx: null, pl: null \};/);
  assert.match(state, /var secondaryPlaylistEdgeGuard = \{/);
  assert.doesNotMatch(detail, /^var playlistPanelDetailState =/m);
  assert.doesNotMatch(detail, /^var playlistPanelVirtualCache =/m);
  assert.match(detail, /querySelectorAll\('\.pl-card\[data-playlist-id\]'\)/);
  assert.match(detail, /event\.__mineradioPlaylistCardHandled = true/);
  assert.doesNotMatch(peekShell, /^var peekTimers =/m);
  assert.doesNotMatch(peekShell, /^var secondaryPlaylistEdgeGuard =/m);
  assert.match(peekShell, /playlistPanelMotionRange\(type\) \|\| \(type === 'close'/);
});

test('Navidrome connection participates in the original Home and shelf source contracts', () => {
  assert.match(loginUtilsSource, /function hasAnyConnectedMusicSource\(\)/);
  assert.match(loginUtilsSource, /hasAnyPlatformLogin\(\) \|\|/);
  assert.match(homeDiscoverSource, /loggedOutHome = !homeDiscoverState\.loggedIn && !hasAnyConnectedMusicSource\(\)/);
  assert.match(homeDashboardSource, /hasAnyConnectedMusicSource/);
  assert.match(homeDiscoverSource, /var navidromeConnected = typeof navidromeIsConnected === 'function' && navidromeIsConnected\(\);/);
  assert.match(homeDiscoverSource, /var data = navidromeConnected\s*\? await navidromeHomeDiscoverData/);
  assert.doesNotMatch(homeDiscoverSource, /!hasAnyPlatformLogin\(\) && typeof navidromeIsConnected/);
  assert.match(htmlSource, /data-home-recommend-source="navidrome"/);
  assert.match(homeDashboardSource, /source === 'navidrome'/);
  assert.match(playlistShellSource, /provider \+ ':' \+ String\(pl\.serverId \|\| ''\) \+ ':' \+ String\(pl\.id \|\| ''\)/);
  assert.match(playlistShellSource, /\['navidrome', 'netease', 'spotify', 'qq', 'kugou', 'qishui'\]/);
  assert.match(playlistShellSource, /userPlaylists = navidromePlaylists\.concat\(neteasePlaylists/);
  assert.match(loginStatusSource, /userPlaylists = \(navidromePlaylists \|\| \[\]\)\.concat\(qqPlaylists/);
  assert.match(logoutSource, /userPlaylists = \(navidromePlaylists \|\| \[\]\)\.concat\(qqPlaylists/);
  assert.match(homeActionsSource, /navidromeIsConnected\(\)[\s\S]{0,100}openNavidromeLibraryShelf\(\)/);
  assert.match(providerSource, /async function openNavidromeLibraryShelf\(\)[\s\S]{0,900}navidromeSyncProviderState\(true\)[\s\S]{0,900}setShelfPinnedOpen\(true, true\)/);
  assert.match(providerSource, /shelfMode === 'side'[\s\S]{0,160}shelfManager\.setMode\('side'\)/);
  assert.match(shelfSource, /function sig\(items\) \{\s*if \(hasAnyConnectedMusicSource\(\)/);
  assert.match(focusCameraSource, /if \(focusHover\.wantType === type\)[\s\S]{0,180}if \(type && immediate\)/);
});

test('configured Navidrome remains visible while credentials need repair', () => {
  assert.match(providerSource, /function navidromeHasConfiguredServer\(\)/);
  assert.match(searchSource, /navidromeVisible = typeof navidromeHasConfiguredServer/);
  assert.match(searchSource, /navidromeUnavailable = provider\.key === 'navidrome'/);
  assert.match(playlistShellSource, /Navidrome 尚未连通 · 请重新输入密码/);
  assert.match(playlistShellSource, /重新输入密码并连接/);
  assert.match(homeDashboardSource, /Navidrome 已配置 · 请重新输入密码后加载服务器歌曲与歌单/);
});

test('Navidrome is a first-class login workflow source', () => {
  const loginFlowSource = read('public/js/modules/08-account/03-login-modal-flows.js');
  assert.match(loginFlowSource, /LOGIN_WORKFLOW_PROVIDERS = \[[^\]]*'navidrome'/);
  assert.match(loginFlowSource, /provider === 'navidrome'[^\n]*navidromeIsConnected/);
  assert.match(loginFlowSource, /provider === 'navidrome'[\s\S]{0,120}openNavidromeServerModal/);
});

test('single NavidromeStore owns server metadata and keeps original local state untouched', () => {
  assert.match(storeSource, /function switchServer\(id\)/);
  assert.match(storeSource, /emit\('switch-start'/);
  assert.match(storeSource, /SESSION_KEY = 'mineradio-navidrome-sessions-v1'/);
  assert.match(storeSource, /delete normalized\.coverPath/);
  assert.doesNotMatch(storeSource, /removeItem\('mineradio-local-library/);
  assert.doesNotMatch(storeSource, /removeItem\('mineradio-playback-session/);
  assert.doesNotMatch(storeSource, /mediaPath|cap=/);
  assert.match(storeSource, /function invalidateMetadata\(serverId\)/);
  assert.match(cacheSource, /function clearMetadata\(serverId\)/);
});

test('Navidrome is the primary connected library without removing legacy sources', () => {
  assert.match(searchSource, /MUSIC_SEARCH_PROVIDER_ORDER = \['navidrome', 'netease', 'qq', 'kugou', 'qishui', 'spotify'\]/);
  assert.match(searchSource, /\(navidromeSongs \|\| \[\]\)\.forEach[\s\S]{0,160}\(neteaseSongs \|\| \[\]\)\.forEach/);
  assert.match(playlistSource, /window\.navidrome\.playlist\(current\.identity\.serverId, current\.identity\.id\)/);
  assert.match(playlistSource, /ids\.length !== completeTracks\.length/);
});

test('renderer IPC remains capability based and does not expose credentials', () => {
  assert.match(preloadSource, /contextBridge\.exposeInMainWorld\('navidrome'/);
  assert.match(preloadSource, /mediaPath:/);
  assert.match(preloadSource, /mediaInfo:/);
  assert.match(mainSource, /ipcMain\.handle\('navidrome-media-info'/);
  assert.doesNotMatch(preloadSource, /password\(\)|makeToken|makeSalt/);
  assert.match(mainSource, /NavidromeConfigStore/);
  assert.match(serverSource, /api\/navidrome-media/);
});

test('Navidrome quality switching reports measured stream bitrate instead of source metadata bitrate', () => {
  assert.match(qualitySource, /function scheduleNavidromeQualitySwitchNotice/);
  assert.match(qualitySource, /window\.navidrome\.mediaInfo\(data\.url, duration\)/);
  assert.match(playbackSource, /scheduleNavidromeQualitySwitchNotice\(audio, data, song, token\)/);
  assert.doesNotMatch(playbackSource, /br:\s*Number\(song\.bitRate\)/);
});

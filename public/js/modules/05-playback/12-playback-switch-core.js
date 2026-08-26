function pauseCurrentAudioForTrackSwitch() {
  playToggleBusy = false;
  if (!audio) return;
  try {
    audioFadeSerial++;
    clearAudioFadeTimers();
    audio.onended = null;
    audio.pause();
  } catch (e) { }
  playing = false;
  setPlayIcon(false);
  syncPlaybackStateFromAudioEvent('track-switch');
}

function syncPlaybackStateFromAudioEvent(reason) {
  if (typeof updatePlaybackResumePauseMarker === 'function') updatePlaybackResumePauseMarker(reason);
  var isPlaying = !!(audio && audio.src && !audio.paused && !audio.ended);
  playing = isPlaying;
  setPlayIcon(isPlaying);
  if (!isPlaying) hideLoading();
  if (reason === 'play' || reason === 'playing') {
    switchPlaybackVisualToEmily();
    if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume(reason);
  }
  forcePlaybackControlsInteractive();
  updateSystemMediaSessionPlaybackState(reason);
}

function systemMediaSessionArtwork(meta) {
  var cover = meta && meta.cover ? String(meta.cover) : '';
  if (!cover) return [];
  var match = /^data:([^;,]+)[;,]/i.exec(cover);
  var type = match && match[1] ? match[1].toLowerCase() : 'image/jpeg';
  return [
    { src: cover, sizes: '96x96', type: type },
    { src: cover, sizes: '256x256', type: type },
    { src: cover, sizes: '512x512', type: type }
  ];
}

var systemMediaSessionState = { signature: '', playbackState: '', positionAt: 0 };

function updateSystemMediaSessionMetadata() {
  if (!navigator.mediaSession || typeof MediaMetadata === 'undefined') return false;
  var meta = currentDesktopSongMeta();
  var signature = [meta.title, meta.artist, meta.album, meta.cover].join('|');
  if (signature === systemMediaSessionState.signature) return false;
  try {
    var metadata = {
      title: meta.title || 'Mineradio',
      artist: meta.artist || '',
      album: meta.album || 'Mineradio',
      artwork: systemMediaSessionArtwork(meta)
    };
    try {
      navigator.mediaSession.metadata = new MediaMetadata(metadata);
    } catch (_) {
      // Chromium rejects malformed data/blob artwork; keep the card alive
      // with the track fields even when a provider cover URL is unusable.
      metadata.artwork = [];
      navigator.mediaSession.metadata = new MediaMetadata(metadata);
    }
    systemMediaSessionState.signature = signature;
    return true;
  } catch (error) {
    console.warn('[SystemMediaSession] metadata update failed:', error && error.message || error);
    return false;
  }
}

function updateSystemMediaSessionPosition(force) {
  if (!navigator.mediaSession || typeof navigator.mediaSession.setPositionState !== 'function' || !audio) return;
  var now = performance.now();
  if (!force && now - systemMediaSessionState.positionAt < 900) return;
  var duration = getPlaybackDurationSeconds();
  if (!isFinite(duration) || duration <= 0) return;
  var position = Math.max(0, Math.min(duration, getPlaybackCurrentSeconds()));
  try {
    navigator.mediaSession.setPositionState({
      duration: duration,
      position: position,
      playbackRate: audio.playbackRate > 0 ? audio.playbackRate : 1
    });
    systemMediaSessionState.positionAt = now;
  } catch (_) { }
}

function pushWindowsPlaybackState() {
  var api = typeof getDesktopWindowApi === 'function' ? getDesktopWindowApi() : null;
  if (!api || typeof api.updatePlaybackState !== 'function') return;
  var meta = currentDesktopSongMeta();
  var lyric = '';
  try {
    var snapshot = typeof currentDesktopLyricSnapshot === 'function' ? currentDesktopLyricSnapshot() : null;
    lyric = snapshot && snapshot.text || '';
  } catch (_) { }
  Promise.resolve(api.updatePlaybackState({
    playing: !!(audio && audio.src && !audio.paused && !audio.ended),
    hasTrack: !!(playQueue && currentIdx >= 0 && playQueue[currentIdx]),
    title: meta.title || 'Mineradio',
    artist: meta.artist || '',
    album: meta.album || 'Mineradio',
    lyric: lyric
  })).catch(function () { });
}

function updateSystemMediaSessionPlaybackState() {
  pushWindowsPlaybackState();
  if (!navigator.mediaSession) return;
  try {
    var hasQueuedTrack = !!(playQueue && currentIdx >= 0 && playQueue[currentIdx]);
    var nextState = audio && audio.src
      ? (audio.paused || audio.ended ? 'paused' : 'playing')
      : (hasQueuedTrack ? 'paused' : 'none');
    if (nextState !== systemMediaSessionState.playbackState) {
      navigator.mediaSession.playbackState = nextState;
      systemMediaSessionState.playbackState = nextState;
    }
    var changed = updateSystemMediaSessionMetadata();
    updateSystemMediaSessionPosition(changed);
  } catch (error) {
    console.warn('[SystemMediaSession] state update failed:', error && error.message || error);
  }
}

function configureSystemMediaSessionControls() {
  if (!navigator.mediaSession || typeof navigator.mediaSession.setActionHandler !== 'function') return;
  var handlers = {
    play: function () { if (!audio || audio.paused || audio.ended) togglePlay(); },
    pause: function () { if (audio && !audio.paused && !audio.ended) togglePlay(); },
    previoustrack: function () {
      try { Promise.resolve(prevTrack(true)).catch(function (error) { console.warn('[SystemMediaSession] previous track failed:', error); }); } catch (error) { console.warn('[SystemMediaSession] previous track failed:', error); }
    },
    nexttrack: function () {
      try { Promise.resolve(nextTrack(true)).catch(function (error) { console.warn('[SystemMediaSession] next track failed:', error); }); } catch (error) { console.warn('[SystemMediaSession] next track failed:', error); }
    },
    seekbackward: function (details) { if (audio) audio.currentTime = Math.max(0, getPlaybackCurrentSeconds() - (details && details.seekOffset || 10)); },
    seekforward: function (details) { if (audio) audio.currentTime = Math.min(getPlaybackDurationSeconds() || Number.MAX_SAFE_INTEGER, getPlaybackCurrentSeconds() + (details && details.seekOffset || 10)); },
    seekto: function (details) { if (audio && details && isFinite(details.seekTime)) audio.currentTime = Math.max(0, Math.min(getPlaybackDurationSeconds() || details.seekTime, details.seekTime)); }
  };
  Object.keys(handlers).forEach(function (action) {
    try { navigator.mediaSession.setActionHandler(action, handlers[action]); } catch (_) { }
  });
}

configureSystemMediaSessionControls();

function runDesktopPlaybackCommand(payload) {
  var command = String(payload && payload.command || payload || '').trim();
  try {
    if (command === 'previous') return Promise.resolve(prevTrack(true)).catch(function (error) { console.warn('[TrayPlayback] previous failed:', error); });
    if (command === 'next') return Promise.resolve(nextTrack(true)).catch(function (error) { console.warn('[TrayPlayback] next failed:', error); });
    if (command === 'toggle-play' || command === 'pause') return Promise.resolve(togglePlay()).catch(function (error) { console.warn('[TrayPlayback] toggle failed:', error); });
  } catch (error) {
    console.warn('[TrayPlayback] command failed:', command, error);
  }
  return Promise.resolve(false);
}

function bindDesktopTrayPlaybackCommands() {
  var api = window.desktopWindow;
  if (!api || typeof api.onPlaybackCommand !== 'function') return;
  api.onPlaybackCommand(runDesktopPlaybackCommand);
}

bindDesktopTrayPlaybackCommands();

function isPlaybackRecursionError(err) {
  var msg = String((err && err.message) || err || '');
  return err instanceof RangeError || /maximum call stack size exceeded/i.test(msg);
}

function safePlaybackStep(label, fn) {
  try {
    return fn();
  } catch (err) {
    console.warn('[PlaybackSetupStep]', label, err);
    return null;
  }
}

function playbackFailureNoticeFromError(err) {
  if (typeof playbackRestrictionNotice !== 'function') return null;
  var msg = String(err && err.message ? err.message : (err || '')).trim();
  if (!msg) return null;
  var lower = msg.toLowerCase();
  var category = '';
  if (/vip_required|paid_required|trial_only|need_vip|only_vip|member|vip|会员|付费|购买/.test(lower + msg)) category = 'vip_required';
  else if (/401|403|login_required|auth|cookie|credential|unauthorized|forbidden/.test(lower)) category = 'login_required';
  else if (/copyright|not playable|unavailable/.test(lower)) category = 'copyright_unavailable';
  else if (/url.*empty|no url|no supported source/.test(lower)) category = 'url_unavailable';
  if (!category) return null;
  var song = playQueue && currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
  return playbackRestrictionNotice(song, { reason: category, message: msg });
}

function playbackFailureToastText(err) {
  var contextualNotice = playbackFailureNoticeFromError(err);
  if (contextualNotice) return contextualNotice.title + '：' + contextualNotice.body;
  if (isPlaybackRecursionError(err)) return '播放准备异常，已保持播放器可操作';
  var msg = String(err && err.message ? err.message : (err || '')).trim();
  var lower = msg.toLowerCase();
  if (/notallowederror|play\(\) failed|user gesture|autoplay/.test(lower)) return '播放失败：浏览器拦截了自动播放，请点一次播放按钮';
  if (/notsupportederror|no supported source|decode|media_err_decode/.test(lower)) return '播放失败：音频格式或解码失败，建议换源或降低音质';
  if (/notfounderror|setSinkId|sink|output device|audio output/.test(lower)) return '播放失败：当前输出设备不可用，请切回系统默认输出';
  if (/aborterror|aborted|interrupted/.test(lower)) return '播放已被新的切歌操作中断';
  if (/network|failed to fetch|timeout|econnreset|etimedout|err_connection|http 5|502|503|504/.test(lower)) return '播放失败：音频网络请求超时或服务端不可用';
  if (/401|403|login_required|auth|cookie|credential|unauthorized|forbidden/.test(lower)) return '播放失败：平台登录态或播放授权失效，请重新登录对应接口';
  if (/vip_required|paid_required|trial_only|need_vip|only_vip|member/.test(lower)) return '播放失败：歌曲需要 VIP、购买或更高权限';
  if (/copyright|unavailable|not playable|url.*empty|no url/.test(lower)) return '播放失败：平台没有返回可播放地址，建议换源';
  return '播放失败：' + (msg || '未知原因，请尝试换源或重新登录');
}
function scheduleAudioResumePosition(media, seconds, token) {
  seconds = Math.max(0, Number(seconds) || 0);
  if (!media || seconds < 0.35) return;
  var applied = false;
  function applyResume() {
    if (applied || token !== trackSwitchToken || !media) return;
    var duration = Number(media.duration) || 0;
    var target = duration > 0 ? Math.min(seconds, Math.max(0, duration - 0.45)) : seconds;
    try {
      media.currentTime = target;
      applied = true;
      if (typeof syncBeatMapPlaybackCursor === 'function') syncBeatMapPlaybackCursor(target, true);
      if (typeof syncPodcastDjMapCursor === 'function') syncPodcastDjMapCursor(target, true);
      updatePlaybackProgressUi();
    } catch (e) { }
  }
  media.addEventListener('loadedmetadata', applyResume, { once: true });
  media.addEventListener('canplay', applyResume, { once: true });
  setTimeout(applyResume, 520);
  applyResume();
}

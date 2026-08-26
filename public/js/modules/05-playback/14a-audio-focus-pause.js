var audioFocusPauseBusy = false;
var audioFocusPauseByExternalMedia = false;
var audioFocusPauseUnsubscribe = null;

function configureAudioFocusPauseMonitor() {
  var api = typeof getDesktopWindowApi === 'function' ? getDesktopWindowApi() : null;
  if (!api || typeof api.configureAudioFocusPause !== 'function') return;
  Promise.resolve(api.configureAudioFocusPause({ enabled: !!(fx && fx.audioFocusPause) })).catch(function () { });
}

async function handleAudioFocusConflict(payload) {
  if (!fx || fx.audioFocusPause !== true || audioFocusPauseBusy) return;
  var active = !!(payload && payload.active);
  if (active) {
    if (!audio || !audio.src || audio.paused || audio.ended) return;
    audioFocusPauseBusy = true;
    try {
      if (typeof clearAlbumGaplessPreload === 'function') clearAlbumGaplessPreload('other-media');
      if (typeof clearAudioFadeTimers === 'function') clearAudioFadeTimers();
      restorePlaybackGain();
      audio.pause();
      if (audio.paused) {
        audioFocusPauseByExternalMedia = true;
        playing = false;
        setPlayIcon(false);
        hideLoading();
        safePlaybackStep('other-media-listen-stats', function () { updateListenStatsTick(true); });
        safePlaybackStep('other-media-sync-state', function () { syncPlaybackStateFromAudioEvent('other-media'); });
        showToast('检测到其他媒体播放，已立即暂停');
      }
    } finally { audioFocusPauseBusy = false; }
    return;
  }
  if (!audioFocusPauseByExternalMedia || !audio || !audio.paused || !audio.src) return;
  audioFocusPauseBusy = true;
  try {
    audioFocusPauseByExternalMedia = false;
    await playAudio({ silent: true, fade: true });
    showToast('其他媒体已结束，继续播放');
  } finally { audioFocusPauseBusy = false; }
}

function bindAudioFocusPauseMonitor() {
  var api = typeof getDesktopWindowApi === 'function' ? getDesktopWindowApi() : null;
  if (!api) return;
  if (!audioFocusPauseUnsubscribe && typeof api.onAudioFocusConflict === 'function') audioFocusPauseUnsubscribe = api.onAudioFocusConflict(handleAudioFocusConflict);
  configureAudioFocusPauseMonitor();
}

if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', bindAudioFocusPauseMonitor);
else setTimeout(bindAudioFocusPauseMonitor, 0);

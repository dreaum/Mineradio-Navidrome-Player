'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8');
const playback = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '05-playback', '12-playback-switch-core.js'), 'utf8');
const overlay = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js'), 'utf8');

test('Windows background playback follows the configured close behavior', () => {
  assert.match(preload, /updatePlaybackState:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('mineradio-playback-state'/);
  assert.match(main, /ipcMain\.handle\('mineradio-playback-state'/);
  assert.doesNotMatch(main, /BACKGROUND_PLAYBACK_ON_CLOSE/);
  assert.doesNotMatch(main, /backgroundPlaybackState\.playing === true/);
  assert.match(main, /if \(!appQuitting && closeBehavior === 'tray'\)/);
  assert.match(main, /win\.hide\(\)/);
});

test('Windows Media Session publishes title, artist, album, artwork and transport actions', () => {
  assert.match(playback, /navigator\.mediaSession\.metadata\s*=\s*new MediaMetadata/);
  assert.match(playback, /album:\s*meta\.album\s*\|\|\s*'Mineradio'/);
  assert.match(playback, /systemMediaSessionArtwork\(meta\)/);
  for (const action of ['play', 'pause', 'previoustrack', 'nexttrack']) {
    assert.match(playback, new RegExp(`${action}:`));
  }
  assert.match(playback, /updatePlaybackState\(\{/);
});

test('desktop lyric snapshot remains the lyric path for Windows background mode', () => {
  assert.match(playback, /currentDesktopLyricSnapshot\(\)/);
  assert.match(playback, /lyric:\s*lyric/);
  assert.match(overlay, /setDesktopLyricsEnabled/);
});

test('background tray menu exposes previous, pause and next playback controls', () => {
  assert.match(main, /sendPlaybackCommandToRenderer\('previous'\)/);
  assert.match(main, /sendPlaybackCommandToRenderer\('toggle-play'\)/);
  assert.match(main, /sendPlaybackCommandToRenderer\('next'\)/);
  assert.match(preload, /onPlaybackCommand:\s*\(callback\)/);
  assert.match(preload, /ipcRenderer\.on\('mineradio-playback-command'/);
  assert.match(playback, /command === 'previous'.*prevTrack\(true\)/s);
  assert.match(playback, /command === 'next'.*nextTrack\(true\)/s);
  assert.match(playback, /command === 'toggle-play'.*togglePlay\(\)/s);
});

'use strict';

const { spawn } = require('child_process');

const SAMPLE_INTERVAL_MS = 1250;
const REQUIRED_ACTIVE_SAMPLES = 2;

function powerShellEncodedCommand(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

function normalizePidList(value) {
  const items = Array.isArray(value) ? value : (value == null ? [] : [value]);
  const unique = new Set();
  for (const item of items) {
    const pid = Math.floor(Number(item));
    if (Number.isFinite(pid) && pid > 0) unique.add(pid);
  }
  return Array.from(unique);
}

function normalizeMediaSourceList(value) {
  const items = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return Array.from(new Set(items.map((item) => String(item || '').trim()).filter(Boolean)));
}

function makeAudioSessionMonitorScript(intervalMs) {
  return [
    'Add-Type @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    '\'@',
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]',
    'while ($true) {',
    '  try {',
    '    $op = $managerType::RequestAsync()',
    '    $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1',
    '    $task = $asTaskMethod.MakeGenericMethod($managerType).Invoke($null, @($op))',
    '    $manager = $task.Result',
    '    $sessions = $manager.GetSessions()',
    '    $playing = @($sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 4 -and $_.SourceAppUserModelId -notmatch "mineradio" } | ForEach-Object { $_.SourceAppUserModelId })',
    '    @{ playing = ($playing.Count -gt 0); sources = @($playing) } | ConvertTo-Json -Compress',
    '  } catch { @{ playing = $false; sources = @() } | ConvertTo-Json -Compress }',
    '  Start-Sleep -Milliseconds ' + Math.max(500, Math.round(Number(intervalMs) || SAMPLE_INTERVAL_MS)),
    '}',
  ].join('\r\n');
}

class AudioFocusMonitor {
  constructor(options = {}) { this.onConflict = options.onConflict || (() => {}); this.intervalMs = Math.max(500, Number(options.intervalMs) || SAMPLE_INTERVAL_MS); this.requiredSamples = Math.max(1, Number(options.requiredSamples) || REQUIRED_ACTIVE_SAMPLES); this.enabled = false; this.child = null; this.stdout = ''; this.activeSamples = 0; this.inactiveSamples = 0; this.conflictActive = false; this.restartTimer = null; }
  start() { this.enabled = true; if (process.platform !== 'win32' || this.child) return { ok: process.platform === 'win32', supported: process.platform === 'win32' }; const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', powerShellEncodedCommand(makeAudioSessionMonitorScript(this.intervalMs))], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); this.child = child; child.stdout.on('data', (chunk) => this.consumeOutput(chunk)); child.once('exit', () => this.handleExit(child)); child.once('error', () => this.handleExit(child)); return { ok: true, supported: true }; }
  stop() { this.enabled = false; this.activeSamples = 0; this.inactiveSamples = 0; this.conflictActive = false; if (this.restartTimer) clearTimeout(this.restartTimer); this.restartTimer = null; const child = this.child; this.child = null; if (child && !child.killed) { try { child.kill(); } catch (_) {} } return { ok: true, supported: process.platform === 'win32' }; }
  handleExit(child) { if (this.child !== child) return; this.child = null; if (!this.enabled || process.platform !== 'win32') return; this.restartTimer = setTimeout(() => { this.restartTimer = null; if (this.enabled && !this.child) this.start(); }, 1500); }
  consumeOutput(chunk) { this.stdout += String(chunk || ''); let end = this.stdout.indexOf('\n'); while (end >= 0) { const line = this.stdout.slice(0, end).trim(); this.stdout = this.stdout.slice(end + 1); if (line) { try { const payload = JSON.parse(line); this.acceptCandidateSources(payload && payload.playing ? (payload.sources || ['external-media']) : []); } catch (_) {} } end = this.stdout.indexOf('\n'); } }
  acceptCandidateSources(value) { if (!this.enabled) return; const sources = normalizeMediaSourceList(value); if (!sources.length) { this.activeSamples = 0; this.inactiveSamples += 1; if (this.conflictActive && this.inactiveSamples >= this.requiredSamples) { this.conflictActive = false; this.inactiveSamples = 0; try { this.onConflict({ active: false, detectedAt: Date.now() }); } catch (_) {} } return; } this.inactiveSamples = 0; this.activeSamples += 1; if (this.conflictActive || this.activeSamples < this.requiredSamples) return; this.conflictActive = true; try { this.onConflict({ active: true, sources, detectedAt: Date.now() }); } catch (_) {} }
}

module.exports = { AudioFocusMonitor, makeAudioSessionMonitorScript, normalizePidList, normalizeMediaSourceList };

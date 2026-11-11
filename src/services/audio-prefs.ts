// Panel toggles: ally proximity, voice on camera, and shared RESET (below).
// Values are stored explicitly as '1' or '0'; a missing key reads as its
// current default.

import { setForceTurnRelay } from './privacy';
import type { RoomHostOptions } from '../core/room-policy';

const ALLY_PROXIMITY_KEY = 'lolproxchat.allyProximity';
const CAMERA_LISTEN_KEY = 'lolproxchat.cameraListen';
const VISIBLE_ENEMIES_KEY = 'lolproxchat.visibleEnemiesOnly';
const PRIVATE_ROOM_KEY = 'lolproxchat.privateRoomCode';
const ADAPTIVE_TRACKING_KEY = 'lolproxchat.adaptiveTracking';
const MATCH_RECAP_KEY = 'lolproxchat.matchRecap';
const ROOM_HOST_OPTIONS_KEY = 'lolproxchat.roomHostOptions';
const DEAD_VOICE_MODE_KEY = 'lolproxchat.deadVoiceMode';

export type DeadVoiceMode = 'off' | 'ghosts' | 'ghosts-nearby';
export function getDeadVoiceMode(): DeadVoiceMode {
  try {
    const value = localStorage.getItem(DEAD_VOICE_MODE_KEY);
    return value === 'off' || value === 'ghosts-nearby' ? value : 'ghosts';
  } catch { return 'ghosts'; }
}
export function setDeadVoiceMode(mode: DeadVoiceMode): void {
  try { localStorage.setItem(DEAD_VOICE_MODE_KEY, mode); } catch { /* optional preference */ }
}

export function getSavedRoomHostOptions(): RoomHostOptions {
  const defaults: RoomHostOptions = { forcedMode: 'inherit', muffling: 'inherit', spatial: 'inherit', trackingFps: 0, chaosEnabled: false, chaosIntervalSec: 45, chaosDurationScale: 1, deadVoiceMode: 'inherit' };
  try {
    const saved = JSON.parse(localStorage.getItem(ROOM_HOST_OPTIONS_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return defaults;
    return {
      forcedMode: ['inherit', 'nearby', 'camera', 'rift'].includes(saved.forcedMode) ? saved.forcedMode : defaults.forcedMode,
      muffling: ['inherit', 'on', 'off'].includes(saved.muffling) ? saved.muffling : defaults.muffling,
      spatial: ['inherit', 'on', 'off'].includes(saved.spatial) ? saved.spatial : defaults.spatial,
      trackingFps: [0, 36, 42, 48].includes(saved.trackingFps) ? saved.trackingFps : defaults.trackingFps,
      chaosEnabled: saved.chaosEnabled === true,
      chaosIntervalSec: [20, 30, 45, 60, 90, 120].includes(saved.chaosIntervalSec) ? saved.chaosIntervalSec : defaults.chaosIntervalSec,
      chaosDurationScale: [0.5, 0.75, 1, 1.5, 2].includes(saved.chaosDurationScale) ? saved.chaosDurationScale : defaults.chaosDurationScale,
      deadVoiceMode: ['inherit', 'ghosts', 'ghosts-nearby', 'off'].includes(saved.deadVoiceMode) ? saved.deadVoiceMode : defaults.deadVoiceMode,
    };
  } catch { return defaults; }
}

export function setSavedRoomHostOptions(options: RoomHostOptions): void {
  try { localStorage.setItem(ROOM_HOST_OPTIONS_KEY, JSON.stringify(options)); } catch { /* optional preference */ }
}

/** Whether to automatically open the local post-match recap. Off by default. */
export function getMatchRecapEnabled(): boolean {
  try { return localStorage.getItem(MATCH_RECAP_KEY) === '1'; } catch { return false; }
}

export function setMatchRecapEnabled(enabled: boolean): void {
  try { localStorage.setItem(MATCH_RECAP_KEY, enabled ? '1' : '0'); } catch { /* optional preference */ }
}

export function getAdaptiveTracking(): boolean {
  try { return localStorage.getItem(ADAPTIVE_TRACKING_KEY) !== '0'; } catch { return true; }
}
export function setAdaptiveTracking(enabled: boolean): void {
  try { localStorage.setItem(ADAPTIVE_TRACKING_KEY, enabled ? '1' : '0'); } catch { /* optional preference */ }
}

function readToggle(key: string): boolean {
  return localStorage.getItem(key) !== '0';
}

function writeToggle(key: string, enabled: boolean): void {
  localStorage.setItem(key, enabled ? '1' : '0');
}

// Ally proximity (#22): teammates fade with distance (the same vision-range
// falloff as enemies) instead of always playing at full volume. Default on, so
// out of the box the whole lobby is positional; turning it off trades that for
// hearing your whole team everywhere.
export function getAllyProximity(): boolean {
  return readToggle(ALLY_PROXIMITY_KEY);
}

export function setAllyProximity(enabled: boolean): void {
  writeToggle(ALLY_PROXIMITY_KEY, enabled);
}

// Put every panel toggle back to its default (on) once, on the first launch of
// a build that carries this. A 2026-10-08 test had a player hear their ally at
// full volume across the map for a whole game — what Ally proximity off does —
// so every tester starts the next version from the same, known settings rather
// than whatever an earlier version, or an earlier stray click, left stored.
// Anyone who wants one off turns it off again, and it then stays off: this runs
// once per install, not per launch. Version 2 (2026-10-16) adds the toggles
// that became default-on then: Camera mode, Shared RESET, App audio and Hide
// IP (privacy.ts).
const AUDIO_DEFAULTS_KEY = 'lolproxchat.audioDefaultsApplied';
const AUDIO_DEFAULTS_VERSION = '3';

/** Returns whether it changed anything this time. Never throws. */
export function applyAudioDefaultsOnce(): boolean {
  try {
    const previousVersion = localStorage.getItem(AUDIO_DEFAULTS_KEY);
    if (previousVersion === AUDIO_DEFAULTS_VERSION) return false;
    // Camera-only and voice-on-camera defaults made ordinary proximity audio
    // behave like screen/camera chat on first launch. Migrate v2 installs to
    // champion-based nearby voice; users can still select either camera mode.
    if (previousVersion === '2') {
      writeToggle(CAMERA_ONLY_KEY, false);
      writeToggle(CAMERA_LISTEN_KEY, false);
      localStorage.setItem(AUDIO_DEFAULTS_KEY, AUDIO_DEFAULTS_VERSION);
      return true;
    }
    writeToggle(ALLY_PROXIMITY_KEY, true);
    writeToggle(CAMERA_LISTEN_KEY, false);
    writeToggle(CAMERA_ONLY_KEY, false);
    writeToggle(VISIBLE_ENEMIES_KEY, true);
    writeToggle(SHARED_RESET_KEY, true);
    writeToggle(APP_AUDIO_KEY, true);
    setForceTurnRelay(true);
    localStorage.setItem(AUDIO_DEFAULTS_KEY, AUDIO_DEFAULTS_VERSION);
    return true;
  } catch {
    return false;
  }
}

// "Voice on camera" (#36): hear the map from wherever the camera is looking as
// well as from the champion's own position.
//
// One-way and mutual, both deliberately. One-way because the camera is a point
// you listen from, never one you are heard at: pan onto a fight and you hear
// it, while the people in it hear you only from where your champion stands.
// Mutual because a camera only counts between two players who have both
// turned this on: with it off you publish no camera, nobody else's can reach
// you, and you are heard only by players actually near you on the map.
//
// Default on since v0.5.18, the maintainer's call. It widens what the app can
// tell you about enemies beyond your champion's own vision, which is the
// boundary docs/compliance.md draws; the mutual rule above is what still lets
// one player opt out unilaterally.
export function getCameraListen(): boolean {
  return readToggle(CAMERA_LISTEN_KEY);
}

export function setCameraListen(enabled: boolean): void {
  writeToggle(CAMERA_LISTEN_KEY, enabled);
}

// Camera mode (camera-hearing.ts): hear exactly the players whose icons are
// inside your camera rectangle, and nobody else; be heard by whoever has your
// icon inside theirs. It replaces proximity and voice on camera while on, and
// needs no position of your own, so it does not depend on the tracker finding
// your icon. It is optional; Nearby Voices is the default.
const CAMERA_ONLY_KEY = 'lolproxchat.cameraOnly';
const RIFT_VOICES_KEY = 'lolproxchat.riftVoices';
const SPATIAL_AUDIO_KEY = 'lolproxchat.spatialAudio';
const VOICE_MUFFLING_KEY = 'lolproxchat.voiceMuffling';
const RIFT_STEREO_CAMERA_KEY = 'lolproxchat.riftStereoCamera';

/** In Rift Voices, pan from the camera while retaining champion-based range. */
export function getRiftStereoFromCamera(): boolean {
  try { return localStorage.getItem(RIFT_STEREO_CAMERA_KEY) === '1'; } catch { return false; }
}

export function setRiftStereoFromCamera(enabled: boolean): void {
  try { localStorage.setItem(RIFT_STEREO_CAMERA_KEY, enabled ? '1' : '0'); } catch { /* optional preference */ }
}

export function getVoiceMuffling(): boolean {
  try { return readToggle(VOICE_MUFFLING_KEY); } catch { return true; }
}

export function setVoiceMuffling(enabled: boolean): void { writeToggle(VOICE_MUFFLING_KEY, enabled); }

export function getSpatialAudio(): boolean {
  try { return readToggle(SPATIAL_AUDIO_KEY); } catch { return true; }
}

export function setSpatialAudio(enabled: boolean): void { writeToggle(SPATIAL_AUDIO_KEY, enabled); }

export function getRiftVoices(): boolean {
  try { return readToggle(RIFT_VOICES_KEY) && !getCameraOnly(); } catch { return false; }
}

export function setRiftVoices(enabled: boolean): void {
  writeToggle(RIFT_VOICES_KEY, enabled);
  if (enabled) setCameraOnly(false);
}

export function getCameraOnly(): boolean {
  try {
    return readToggle(CAMERA_ONLY_KEY);
  } catch {
    return true;
  }
}

export function setCameraOnly(enabled: boolean): void {
  writeToggle(CAMERA_ONLY_KEY, enabled);
}

/** In proximity mode, only keep enemy voices whose icons are currently drawn
 * on our minimap. This uses local CV and shares no positions with peers. */
export function getVisibleEnemiesOnly(): boolean {
  try { return readToggle(VISIBLE_ENEMIES_KEY); } catch { return true; }
}

export function setVisibleEnemiesOnly(enabled: boolean): void {
  try { writeToggle(VISIBLE_ENEMIES_KEY, enabled); } catch { /* optional */ }
}

/** Blank keeps the automatic public match room. */
export function getPrivateRoomCode(): string {
  try { return localStorage.getItem(PRIVATE_ROOM_KEY) ?? ''; } catch { return ''; }
}

export function setPrivateRoomCode(code: string): void {
  try {
    const clean = code.trim().replace(/\s+/g, '').toLowerCase();
    if (clean) localStorage.setItem(PRIVATE_ROOM_KEY, clean);
    else localStorage.removeItem(PRIVATE_ROOM_KEY);
  } catch { /* a room code is optional */ }
}

// Shared RESET: pressing RESET also asks everyone else in the game to re-find
// their own icon, and their RESETs re-find ours — but only between players who
// have all turned this on. On by default since 2026-10-16, stored like the
// toggles above: a missing or unreadable key is on.
//
// With it off the client tells the server so on join, the server sends it no
// shared RESET at all, and a 'reset' that arrives anyway (an older or
// misbehaving server) is dropped here — see Orchestrator.handleRemoteReset.
const SHARED_RESET_KEY = 'lolproxchat.sharedReset';

export function getSharedReset(): boolean {
  try {
    return readToggle(SHARED_RESET_KEY);
  } catch {
    return true;
  }
}

export function setSharedReset(enabled: boolean): void {
  writeToggle(SHARED_RESET_KEY, enabled);
}

// App audio (app-audio-output.ts): voices played by lolproxchat.exe itself, so OBS's
// Application Audio Capture can take them on their own track. On by default
// since 2026-10-16, stored like the toggles above (a missing key is on). With
// speakers it can bring echo back (the browser's echo canceller no longer
// hears what is played): speaker users turn it off. Its device is the Rust side's own list (a device name, not a
// browser device id); missing means the Windows default.
const APP_AUDIO_KEY = 'lolproxchat.appAudio';
const APP_AUDIO_DEVICE_KEY = 'lolproxchat.appAudioDevice';

export function getAppAudio(): boolean {
  try {
    return readToggle(APP_AUDIO_KEY);
  } catch {
    return true;
  }
}

export function setAppAudio(enabled: boolean): void {
  writeToggle(APP_AUDIO_KEY, enabled);
}

export function getAppAudioDevice(): string | null {
  try {
    return localStorage.getItem(APP_AUDIO_DEVICE_KEY) || null;
  } catch {
    return null;
  }
}

export function setAppAudioDevice(name: string | null): void {
  try {
    if (name) localStorage.setItem(APP_AUDIO_DEVICE_KEY, name);
    else localStorage.removeItem(APP_AUDIO_DEVICE_KEY);
  } catch { /* not stored: the default device is used */ }
}

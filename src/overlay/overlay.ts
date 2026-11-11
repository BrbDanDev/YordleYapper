import { setLoggingEnabled } from '../core/logging';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { ReplayPlayback, type ReplayApiState } from '../services/replay';
import { listAppOutputDevices } from '../services/app-audio-output';
import { BASE_VOICE_RANGE, MAX_SHOUT_RANGE, QUIET_VOICE_RANGE, SHOUT_LEVEL_THRESHOLD, VoiceDebugSimulator, voiceRangeForLevel } from '../services/voice-debug-simulator';
import { MAP_DIMENSIONS, MapType } from '../core/types';
import { getDefaultServerUrl, getServerUrl } from '../core/config';
import {
  checkForUpdate,
  downloadAndApply,
  isAutoUpdateEnabled,
  setAutoUpdateEnabled,
} from '../services/updater';
import {
  getStoredInputDeviceId,
  setStoredInputDeviceId,
  getStoredOutputDeviceId,
  setStoredOutputDeviceId,
  listAudioDevices,
  probeMicPermission,
} from '../services/devices';
import { getForceTurnRelay, setForceTurnRelay } from '../services/privacy';
import {
  getAllyProximity, setAllyProximity, getCameraListen, setCameraListen, getSharedReset, setSharedReset,
  getCameraOnly, setCameraOnly,
  getRiftVoices, setRiftVoices,
  getRiftStereoFromCamera, setRiftStereoFromCamera,
  getSpatialAudio, setSpatialAudio,
  getVoiceMuffling, setVoiceMuffling,
  getVisibleEnemiesOnly, setVisibleEnemiesOnly, getPrivateRoomCode, setPrivateRoomCode,
  getAdaptiveTracking, setAdaptiveTracking,
  getDeadVoiceMode, setDeadVoiceMode,
  getMatchRecapEnabled, setMatchRecapEnabled,
  getSavedRoomHostOptions, setSavedRoomHostOptions,
  getAppAudio, setAppAudio, getAppAudioDevice, setAppAudioDevice,
  applyAudioDefaultsOnce,
} from '../services/audio-prefs';
import { shouldSendSize } from './resize-helpers';
import { browserKeyToWin32Vk, humanizeVk } from '../core/keymap';
import {
  LANGUAGES, Lang, StringKey, applyTranslations, getLanguage, setLanguage, t, translateKey, translateStatus,
} from './i18n';
import '../core/window-globals';
import type { RoomHostOptions, RoomState } from '../core/room-policy';

// Before any panel button reads them. The background window does the same; it
// runs once per install whichever window gets there first.
applyAudioDefaultsOnce();

// Content can exceed the user's window size; the WebView scrolls while the
// native window retains the dimensions they chose.
function syncOverlayHeight(): void {
  // Preserve the user's native window size. Long settings scroll inside the
  // WebView instead of programmatically resizing the native window.
}

interface NearbyPeer {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  isMuted: boolean;
  isMutedByLocal: boolean;
  isDead: boolean;
}

interface OverlayState {
  selfMuted: boolean;
  muteAll: boolean;
  nearbyPeers: NearbyPeer[];
  trackingState?: string;
  lastPosition?: { x: number; y: number } | null;
  cameraPosition?: { x: number; y: number } | null;
  mapType?: MapType | null;
  filteredImageUrl?: string | null;
  detectedMinimapBounds?: { screenX: number; screenY: number; screenWidth: number; screenHeight: number } | null;
  localTeam?: 'ORDER' | 'CHAOS' | null;
  lifecycleStatus?: string;
  /** Shared RESET from another player, while the panel should say so. */
  remoteReset?: { from: string | null } | null;
}

const playerList = document.getElementById('player-list')!;
const btnSelfMute = document.getElementById('btn-self-mute') as HTMLButtonElement;
const btnMuteAll = document.getElementById('btn-mute-all')!;
const btnSettings = document.getElementById('btn-settings')!;
const btnDebug = document.getElementById('btn-debug')!;
const btnCollapse = document.getElementById('btn-collapse')!;
const panel = document.getElementById('panel')!;
const settingsPanel = document.getElementById('settings-panel')!;
const dragHandle = document.getElementById('drag-handle')!;

// Debug overlay state — always starts off; user toggles per session. (The
// logging module starts silenced; switching it off here as well would undo a
// Debug state the other bundle's copy had already set.)
let debugEnabled = false;
const voiceDebug = document.getElementById('voice-debug')!;
const voiceSimulator = new VoiceDebugSimulator();
const voiceSimStart = document.getElementById('voice-sim-start') as HTMLButtonElement;
const voiceSimStatus = document.getElementById('voice-sim-status')!;
const voiceSimLoudness = document.getElementById('voice-sim-loudness') as HTMLInputElement;
const voiceSimLoudnessLabel = document.getElementById('voice-sim-loudness-label')!;
const voiceSimLoudnessTitle = document.getElementById('voice-sim-loudness-title')!;
const voiceSimRange = document.getElementById('voice-sim-range')!;
const voiceSimMuffling = document.getElementById('voice-sim-muffling') as HTMLButtonElement;
const voiceSimHidden = document.getElementById('voice-sim-hidden') as HTMLButtonElement;
const voiceSimStereo = document.getElementById('voice-sim-stereo') as HTMLButtonElement;
const voiceSimRecord = document.getElementById('voice-sim-record') as HTMLButtonElement;
const voiceSimClearRecording = document.getElementById('voice-sim-clear-recording') as HTMLButtonElement;
const voiceSimPlacement = document.getElementById('voice-sim-placement')!;
const voiceSimMarker = document.getElementById('voice-sim-marker') as HTMLSpanElement;
let voiceRecorder: MediaRecorder | null = null;
let voiceRecordingStream: MediaStream | null = null;
let voiceRecordingTimeout: number | null = null;
let recordingMutedByLab = false;
let voiceMeasureContext: AudioContext | null = null;
let voiceMeasureAnalyser: AnalyserNode | null = null;
let voiceMeasureSource: MediaStreamAudioSourceNode | null = null;
let voiceMeasureSilencer: GainNode | null = null;
let voiceMeasureTimer: number | null = null;
let voiceMeasureRmsTotal = 0;
let voiceMeasureRmsFrames = 0;
let voiceMeasureBuffer = new Float32Array(0);

function updateVoiceSimReadout(): void {
  const recording = voiceSimulator.usesRecording;
  voiceSimLoudnessTitle.textContent = recording ? 'Recorded voice loudness' : 'Simulated voice loudness';
  voiceSimLoudness.disabled = recording;
  voiceSimLoudnessLabel.textContent = recording ? `${Math.round(voiceSimulator.activeLoudness * 100)}%` : voiceSimLoudness.value;
  voiceSimulator.setLoudness(Number(voiceSimLoudness.value) / 100);
  voiceSimRange.textContent = `Quiet ${QUIET_VOICE_RANGE}–${BASE_VOICE_RANGE}u (now ${voiceRangeForLevel(voiceSimulator.activeLoudness)}u) · loud voice up to ${MAX_SHOUT_RANGE}u · reverb fades by ${voiceSimulator.echoRange}u · shout threshold ${Math.round(SHOUT_LEVEL_THRESHOLD * 100)}%.`;
}

function beginVoiceLoudnessMeasurement(stream: MediaStream): void {
  const context = voiceMeasureContext ?? new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  const silencer = context.createGain();
  analyser.fftSize = 1024;
  silencer.gain.value = 0;
  source.connect(analyser);
  analyser.connect(silencer).connect(context.destination);
  voiceMeasureContext = context;
  voiceMeasureSource = source;
  voiceMeasureAnalyser = analyser;
  voiceMeasureSilencer = silencer;
  voiceMeasureBuffer = new Float32Array(analyser.fftSize);
  voiceMeasureRmsTotal = 0;
  voiceMeasureRmsFrames = 0;
  voiceMeasureTimer = window.setInterval(() => {
    if (!voiceMeasureAnalyser) return;
    voiceMeasureAnalyser.getFloatTimeDomainData(voiceMeasureBuffer);
    let sum = 0;
    for (const sample of voiceMeasureBuffer) sum += sample * sample;
    const rms = Math.sqrt(sum / voiceMeasureBuffer.length);
    if (rms > 0.005) { voiceMeasureRmsTotal += rms; voiceMeasureRmsFrames++; }
  }, 50);
  if (context.state === 'suspended') void context.resume().catch(() => undefined);
}

function prepareVoiceLoudnessMeasurement(): void {
  if (!voiceMeasureContext) voiceMeasureContext = new AudioContext();
  if (voiceMeasureContext.state === 'suspended') void voiceMeasureContext.resume().catch(() => undefined);
}

function endVoiceLoudnessMeasurement(): number {
  if (voiceMeasureTimer !== null) window.clearInterval(voiceMeasureTimer);
  voiceMeasureTimer = null;
  voiceMeasureSource?.disconnect();
  voiceMeasureAnalyser?.disconnect();
  voiceMeasureSilencer?.disconnect();
  voiceMeasureSource = null;
  voiceMeasureAnalyser = null;
  voiceMeasureSilencer = null;
  const rms = voiceMeasureRmsFrames ? voiceMeasureRmsTotal / voiceMeasureRmsFrames : 0;
  const normalized = Math.max(0, Math.min(1, (rms - 0.025) / 0.16));
  const context = voiceMeasureContext;
  voiceMeasureContext = null;
  if (context) void context.close().catch(() => undefined);
  voiceMeasureBuffer = new Float32Array(0);
  voiceMeasureRmsTotal = 0;
  voiceMeasureRmsFrames = 0;
  return normalized;
}
function setVoiceSimToggle(button: HTMLButtonElement, enabled: boolean): void {
  button.textContent = onOff(enabled);
  button.classList.toggle('active', enabled);
  button.setAttribute('aria-pressed', String(enabled));
}
updateVoiceSimReadout();
voiceSimLoudness.addEventListener('input', updateVoiceSimReadout);
voiceSimMuffling.addEventListener('click', () => {
  const enabled = voiceSimMuffling.getAttribute('aria-pressed') !== 'true';
  setVoiceSimToggle(voiceSimMuffling, enabled);
  voiceSimulator.setMuffling(enabled);
});
voiceSimStereo.addEventListener('click', () => {
  const enabled = voiceSimStereo.getAttribute('aria-pressed') !== 'true';
  setVoiceSimToggle(voiceSimStereo, enabled);
  voiceSimulator.setStereo(enabled);
});
voiceSimHidden.addEventListener('click', () => {
  const enabled = voiceSimHidden.getAttribute('aria-pressed') !== 'true';
  setVoiceSimToggle(voiceSimHidden, enabled);
  voiceSimulator.setHidden(enabled);
});
voiceSimStart.addEventListener('click', async () => {
  if (voiceSimulator.isRunning) {
    stopVoiceRecording();
    await voiceSimulator.stop();
    voiceSimStart.textContent = 'ENABLE LOCAL AUDIO';
    voiceSimStatus.textContent = 'Local second player disconnected.';
    return;
  }
  voiceSimStart.disabled = true;
  try {
    await voiceSimulator.start();
    voiceSimStart.textContent = 'STOP LOCAL AUDIO';
    voiceSimStatus.textContent = 'Second player connected through local WebRTC; click the map to test the receive and effects path.';
  } catch (error) {
    voiceSimStatus.textContent = 'Audio could not start: ' + String(error);
    await voiceSimulator.stop();
  } finally { voiceSimStart.disabled = false; }
});

function stopVoiceRecording(): void {
  if (voiceRecordingTimeout !== null) window.clearTimeout(voiceRecordingTimeout);
  voiceRecordingTimeout = null;
  if (voiceRecorder?.state === 'recording') voiceRecorder.stop();
}

function restoreMicAfterLocalRecording(): void {
  voiceRecordingStream?.getTracks().forEach((track) => track.stop());
  voiceRecordingStream = null;
  voiceSimRecord.disabled = false;
  btnSelfMute.disabled = false;
  if (recordingMutedByLab) btnSelfMute.click();
  recordingMutedByLab = false;
}

voiceSimRecord.addEventListener('click', async () => {
  if (voiceRecorder?.state === 'recording') { stopVoiceRecording(); return; }
  if (!voiceSimulator.isRunning) {
    voiceSimRecord.disabled = true;
    try {
      await voiceSimulator.start();
      voiceSimStart.textContent = 'STOP LOCAL AUDIO';
    } catch (error) {
      voiceSimStatus.textContent = 'Could not start local audio: ' + String(error);
      voiceSimRecord.disabled = false;
      return;
    }
    voiceSimRecord.disabled = false;
  }
  voiceSimRecord.disabled = true;
  recordingMutedByLab = !btnSelfMute.classList.contains('active');
  if (recordingMutedByLab) btnSelfMute.click();
  btnSelfMute.disabled = true;
  try {
    prepareVoiceLoudnessMeasurement();
    const selectedMic = getStoredInputDeviceId();
    const audioConstraints: MediaTrackConstraints = {
      ...(selectedMic ? { deviceId: { exact: selectedMic } } : {}),
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    };
    try {
      voiceRecordingStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (deviceError) {
      if (!selectedMic) throw deviceError;
      console.warn('[Voice Lab] Selected microphone failed; retrying the Windows default:', deviceError);
      voiceRecordingStream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      } });
    }
    const parts: BlobPart[] = [];
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
      .find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(voiceRecordingStream, mimeType ? { mimeType } : undefined);
    beginVoiceLoudnessMeasurement(voiceRecordingStream);
    voiceRecorder = recorder;
    recorder.ondataavailable = (event): void => { if (event.data.size > 0) parts.push(event.data); };
    recorder.onstop = (): void => {
      voiceRecorder = null;
      voiceSimRecord.textContent = 'RECORD TEST VOICE';
      const measuredRmsLevel = endVoiceLoudnessMeasurement();
      restoreMicAfterLocalRecording();
      const sample = new Blob(parts, { type: recorder.mimeType || 'audio/webm' });
      if (sample.size === 0) { voiceSimStatus.textContent = 'No audio was captured. Try recording again.'; return; }
      voiceSimulator.setRecording(sample, measuredRmsLevel);
      updateVoiceSimReadout();
      voiceSimClearRecording.disabled = false;
      voiceSimStatus.textContent = `Voice saved in memory · measured loudness ${Math.round(measuredRmsLevel * 100)}%. It will send through the simulated player's WebRTC connection.`;
    };
    recorder.start();
    voiceSimRecord.disabled = false;
    voiceSimRecord.textContent = 'STOP RECORDING';
    voiceSimStatus.textContent = 'Recording locally for up to 10 seconds; live room mic is muted.';
    voiceRecordingTimeout = window.setTimeout(stopVoiceRecording, 10_000);
  } catch (error) {
    endVoiceLoudnessMeasurement();
    restoreMicAfterLocalRecording();
    voiceSimStatus.textContent = 'Microphone recording unavailable: ' + String(error);
  }
});
voiceSimClearRecording.addEventListener('click', () => {
  voiceSimulator.clearRecording();
  updateVoiceSimReadout();
  voiceSimClearRecording.disabled = true;
  voiceSimStatus.textContent = 'Recording cleared. The simulated player will use the synthetic test tone.';
});

// Every toggle shows ON/OFF in the panel language.
const onOff = (on: boolean): string => t(on ? 'settings.on' : 'settings.off');

// Per-player volume cache (so sliders don't reset on re-render)
const playerVolumes: Map<string, number> = new Map();

// Tauri handles window dragging and resizing via its window config.
// The drag handle uses Tauri's built-in data-tauri-drag-region attribute
// (set in the HTML). No manual drag/resize logic needed.

// --- Controls ---
// MIC / VOL buttons signal their muted state via the `.active` color only —
// the label stays "MIC" / "VOL" (no "OFF" suffix) so the button width doesn't
// jump and the icon-button row stays visually stable.
btnSelfMute.addEventListener('click', () => {
  const nowMuted = !btnSelfMute.classList.contains('active');
  btnSelfMute.classList.toggle('active', nowMuted);
  sendToBackground('toggleSelfMute', {});
});

btnMuteAll.addEventListener('click', () => {
  const nowMuted = !btnMuteAll.classList.contains('active');
  btnMuteAll.classList.toggle('active', nowMuted);
  sendToBackground('toggleMuteAll', {});
});

// "Wrong position?": the header's POS button (always in reach, collapsed or
// not) and the labelled RESET row in Settings do the same thing. Both light up
// for 2s so a click mid-game visibly registered.
const btnResetPosition = document.getElementById('btn-reset-position')!;
const btnResetHeader = document.getElementById('btn-reset-header')!;
let resetFeedbackId: ReturnType<typeof setTimeout> | null = null;
function resetPosition(): void {
  sendToBackground('resetPosition', {});
  btnResetPosition.textContent = t('settings.searching');
  btnResetHeader.classList.add('searching');
  if (resetFeedbackId !== null) clearTimeout(resetFeedbackId);
  resetFeedbackId = setTimeout(() => {
    btnResetPosition.textContent = t('settings.reset');
    if (!shownRemoteReset) btnResetHeader.classList.remove('searching');
    resetFeedbackId = null;
  }, 2000);
}
btnResetPosition.addEventListener('click', resetPosition);
btnResetHeader.addEventListener('click', resetPosition);

// Shared RESET from another player: say who (only a name in this room ever
// gets here — see Orchestrator.handleRemoteReset) and light the POS button,
// which is all a collapsed panel shows.
const resetNotice = document.getElementById('reset-notice')!;
let shownRemoteReset: { from: string | null } | null = null;
function renderRemoteReset(remote: { from: string | null } | null): void {
  shownRemoteReset = remote;
  if (!remote) {
    resetNotice.classList.add('hidden');
    if (resetFeedbackId === null) btnResetHeader.classList.remove('searching');
    return;
  }
  resetNotice.textContent = remote.from
    ? t('notice.sharedReset', { name: remote.from })
    : t('notice.sharedResetAnon');
  resetNotice.classList.remove('hidden');
  btnResetHeader.classList.add('searching');
}

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
  if (!settingsPanel.classList.contains('hidden')) {
    refreshDeviceLists();
  }
  syncOverlayHeight();
});

// --- Audio device pickers ---
const inputDeviceSelect = document.getElementById('input-device') as HTMLSelectElement;
const outputDeviceSelect = document.getElementById('output-device') as HTMLSelectElement;

async function refreshDeviceLists(): Promise<void> {
  try {
    let { inputs, outputs } = await listAudioDevices();
    // Empty labels mean the user hasn't granted mic permission yet. Trigger
    // a one-shot probe so labels populate; then re-enumerate.
    if (inputs.some((d) => !d.label) || outputs.some((d) => !d.label)) {
      try {
        await probeMicPermission();
        ({ inputs, outputs } = await listAudioDevices());
      } catch {
        // User denied or no mic present — fall through with whatever labels we have
      }
    }
    populateDeviceSelect(inputDeviceSelect, inputs, getStoredInputDeviceId());
    populateDeviceSelect(outputDeviceSelect, outputs, getStoredOutputDeviceId());
    if (getAppAudio()) await populateAppOutputs();
  } catch (e) {
    console.warn('[Overlay] device enumeration failed:', e);
  }
}

/** App audio on: Output Device lists what lolproxchat.exe itself can play on
 *  (Rust's own list, by name), so what is picked is exactly what plays. */
async function populateAppOutputs(): Promise<void> {
  const { devices } = await listAppOutputDevices();
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = t('settings.default');
  const opts = [defaultOpt, ...devices.map((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    return opt;
  })];
  outputDeviceSelect.replaceChildren(...opts);
  const chosen = getAppAudioDevice();
  outputDeviceSelect.value = chosen && devices.includes(chosen) ? chosen : '';
}

function populateDeviceSelect(
  select: HTMLSelectElement,
  devices: MediaDeviceInfo[],
  selectedId: string | null,
): void {
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = t('settings.default');
  const opts: HTMLOptionElement[] = [defaultOpt];
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || t(d.kind === 'audiooutput' ? 'settings.unnamedOutput' : 'settings.unnamedInput');
    opts.push(opt);
  }
  select.replaceChildren(...opts);
  select.value = selectedId && devices.some((d) => d.deviceId === selectedId) ? selectedId : '';
}

inputDeviceSelect.addEventListener('change', () => {
  const id = inputDeviceSelect.value || null;
  setStoredInputDeviceId(id);
  sendToBackground('setInputDevice', { id });
});

outputDeviceSelect.addEventListener('change', () => {
  if (getAppAudio()) {
    const name = outputDeviceSelect.value || null;
    setAppAudioDevice(name);
    sendToBackground('setAppAudioDevice', { name });
    return;
  }
  const id = outputDeviceSelect.value || null;
  setStoredOutputDeviceId(id);
  sendToBackground('setOutputDevice', { id });
});

// App audio (OBS): voices played by lolproxchat.exe itself. Applied live; the
// output picker switches to lolproxchat.exe's own device list while on.
const btnAppAudio = document.getElementById('btn-app-audio') as HTMLButtonElement;
function syncAppAudioButton(): void {
  const on = getAppAudio();
  btnAppAudio.textContent = onOff(on);
  btnAppAudio.classList.toggle('active', on);
}
queueMicrotask(syncAppAudioButton);
btnAppAudio.addEventListener('click', () => {
  const enabled = !getAppAudio();
  setAppAudio(enabled);
  syncAppAudioButton();
  void refreshDeviceLists();
  sendToBackground('setAppAudio', { enabled });
});

const btnSpatialAudio = document.getElementById('btn-spatial-audio') as HTMLButtonElement;
function syncSpatialAudioButton(): void {
  const on = getSpatialAudio();
  btnSpatialAudio.textContent = onOff(on);
  btnSpatialAudio.classList.toggle('active', on);
  btnSpatialAudio.setAttribute('aria-pressed', String(on));
  syncRiftStereoCameraButton();
}
queueMicrotask(syncSpatialAudioButton);
btnSpatialAudio.addEventListener('click', () => {
  setSpatialAudio(!getSpatialAudio());
  syncSpatialAudioButton();
});

const btnVoiceMuffling = document.getElementById('btn-voice-muffling') as HTMLButtonElement;
function syncVoiceMufflingButton(): void {
  const on = getVoiceMuffling();
  btnVoiceMuffling.textContent = onOff(on);
  btnVoiceMuffling.classList.toggle('active', on);
  btnVoiceMuffling.setAttribute('aria-pressed', String(on));
}
queueMicrotask(syncVoiceMufflingButton);
btnVoiceMuffling.addEventListener('click', () => { setVoiceMuffling(!getVoiceMuffling()); syncVoiceMufflingButton(); });

// Refresh if user plugs / unplugs a device while the panel is open
navigator.mediaDevices.addEventListener('devicechange', () => {
  if (!settingsPanel.classList.contains('hidden')) {
    refreshDeviceLists();
  }
});

let collapsed = false;
btnCollapse.addEventListener('click', () => {
  collapsed = !collapsed;
  panel.classList.toggle('collapsed', collapsed);
  btnCollapse.textContent = collapsed ? '\u00AB' : '\u00BB';
  btnCollapse.title = t(collapsed ? 'header.expand' : 'header.collapse');
  // Close settings when collapsing
  if (collapsed) {
    settingsPanel.classList.add('hidden');
  }
});

const btnAutoUpdate = document.getElementById('btn-autoupdate') as HTMLButtonElement;
const btnCheckUpdate = document.getElementById('btn-check-update') as HTMLButtonElement;
const updateStatus = document.getElementById('update-status')!;

// --- Auto-update UI ---
function syncAutoUpdateButton(): void {
  const on = isAutoUpdateEnabled();
  btnAutoUpdate.textContent = onOff(on);
  btnAutoUpdate.classList.toggle('active', on);
}
queueMicrotask(syncAutoUpdateButton);

btnAutoUpdate.addEventListener('click', () => {
  setAutoUpdateEnabled(!isAutoUpdateEnabled());
  syncAutoUpdateButton();
});

// Kept as a key so a language switch re-renders the line instead of wiping it.
let updateStatusMsg: { key: StringKey; params: Record<string, string> } | null = null;
function setUpdateStatus(key: StringKey | null, params: Record<string, string> = {}): void {
  updateStatusMsg = key ? { key, params } : null;
  updateStatus.textContent = key ? t(key, params) : '';
}

async function runUpdateCheck(triggeredByUser: boolean): Promise<void> {
  setUpdateStatus('update.checking');
  try {
    const info = await checkForUpdate();
    if (info.update_available && info.download_url) {
      setUpdateStatus('update.available', { version: String(info.latest_version) });
      await downloadAndApply(info.download_url);
      // If apply succeeds, the process exits before we reach here
    } else {
      if (triggeredByUser) setUpdateStatus('update.upToDate', { version: String(info.current_version) });
      else setUpdateStatus(null);
    }
  } catch (e) {
    setUpdateStatus('update.failed', { error: (e as Error).message });
  }
}

btnCheckUpdate.addEventListener('click', () => {
  runUpdateCheck(true);
});

const btnOpenLogs = document.getElementById('btn-open-logs') as HTMLButtonElement;
btnOpenLogs.addEventListener('click', () => {
  sendToBackground('openLogFolder', {});
});

// Expose for background.ts to trigger an auto-check on launch
window.__proxchatRunUpdateCheck = runUpdateCheck;

// Force-TURN privacy toggle. New peer connections created after this is
// flipped honor the new setting; existing connections keep whatever policy
// they were created with (would need to re-join the game to apply).
const btnForceTurn = document.getElementById('btn-force-turn') as HTMLButtonElement;
function syncForceTurnButton(): void {
  const on = getForceTurnRelay();
  btnForceTurn.textContent = onOff(on);
  btnForceTurn.classList.toggle('active', on);
}
queueMicrotask(syncForceTurnButton);
btnForceTurn.addEventListener('click', () => {
  setForceTurnRelay(!getForceTurnRelay());
  syncForceTurnButton();
});

// Ally-proximity toggle (#22). When ON, teammates fade with distance (the same
// falloff as enemies) instead of always playing at full volume. The orchestrator
// reads this fresh on each /compute-volumes tick, so flipping it takes effect on
// the next position update — no reconnect needed.
const btnAllyProximity = document.getElementById('btn-ally-proximity') as HTMLButtonElement;
function syncAllyProximityButton(): void {
  const on = getAllyProximity();
  btnAllyProximity.textContent = onOff(on);
  btnAllyProximity.classList.toggle('active', on);
}
queueMicrotask(syncAllyProximityButton);
btnAllyProximity.addEventListener('click', () => {
  setAllyProximity(!getAllyProximity());
  syncAllyProximityButton();
});

// Voice-on-camera toggle (#36). When ON, the orchestrator sends the minimap
// camera-rectangle centre as the point we hear from, so panning the camera moves
// your ears without moving your champion. Read fresh on each /compute-volumes
// tick, so flipping it takes effect on the next position update.
const btnCameraListen = document.getElementById('btn-camera-listen') as HTMLButtonElement;
function syncCameraListenButton(): void {
  const on = getCameraListen();
  btnCameraListen.textContent = onOff(on);
  btnCameraListen.classList.toggle('active', on);
  btnCameraListen.setAttribute('aria-pressed', String(on));
}
queueMicrotask(syncCameraListenButton);
btnCameraListen.addEventListener('click', () => {
  setCameraListen(!getCameraListen());
  syncCameraListenButton();
});

// Present the two camera behaviors as one clear listening-mode choice.
const hearingMode = document.getElementById('hearing-mode') as HTMLSelectElement;
const hearingModeDescription = document.getElementById('hearing-mode-description')!;
const visibleEnemiesRow = document.getElementById('visible-enemies-row')!;
const visibleEnemiesHint = document.getElementById('visible-enemies-hint')!;
const cameraListenRow = document.getElementById('camera-listen-row')!;
const cameraListenHint = document.getElementById('camera-listen-hint')!;
const riftStereoCameraRow = document.getElementById('rift-stereo-camera-row')!;
const riftStereoCameraHint = document.getElementById('rift-stereo-camera-hint')!;
const btnRiftStereoCamera = document.getElementById('btn-rift-stereo-camera') as HTMLButtonElement;
let hostForcedMode: string | null = null;
function syncRiftStereoCameraButton(): void {
  const on = getRiftStereoFromCamera();
  btnRiftStereoCamera.textContent = onOff(on);
  btnRiftStereoCamera.classList.toggle('active', on);
  btnRiftStereoCamera.setAttribute('aria-pressed', String(on));
  const forcedMono = btnSpatialAudio.disabled && hostSpatial.value === 'off';
  btnRiftStereoCamera.disabled = forcedMono || (!btnSpatialAudio.disabled && !getSpatialAudio());
}
btnRiftStereoCamera.addEventListener('click', () => {
  setRiftStereoFromCamera(!getRiftStereoFromCamera());
  syncRiftStereoCameraButton();
});
queueMicrotask(syncRiftStereoCameraButton);
function syncHearingMode(): void {
  const camera = hostForcedMode ? hostForcedMode === 'camera' : getCameraOnly();
  const rift = hostForcedMode ? hostForcedMode === 'rift' : getRiftVoices();
  hearingMode.value = hostForcedMode ?? (camera ? 'camera' : rift ? 'rift' : 'nearby');
  hearingModeDescription.textContent = t(camera ? 'settings.modeScreenDescription' : rift ? 'settings.modeRiftDescription' : 'settings.modeNearbyDescription');
  visibleEnemiesRow.classList.toggle('hidden', camera);
  visibleEnemiesHint.classList.toggle('hidden', camera);
  cameraListenRow.classList.toggle('hidden', camera);
  cameraListenHint.classList.toggle('hidden', camera);
  riftStereoCameraRow.classList.toggle('hidden', !rift);
  riftStereoCameraHint.classList.toggle('hidden', !rift);
}
hearingMode.addEventListener('change', () => {
  setCameraOnly(hearingMode.value === 'camera');
  setRiftVoices(hearingMode.value === 'rift');
  syncHearingMode();
});
queueMicrotask(syncHearingMode);

const deadVoiceModeSelect = document.getElementById('dead-voice-mode') as HTMLSelectElement;
deadVoiceModeSelect.value = getDeadVoiceMode();
deadVoiceModeSelect.addEventListener('change', () => setDeadVoiceMode(deadVoiceModeSelect.value as 'off' | 'ghosts' | 'ghosts-nearby'));

const voiceServerUrl = document.getElementById('voice-server-url') as HTMLInputElement;
const voiceServerStatus = document.getElementById('voice-server-status')!;
const selfHostStatus = document.getElementById('self-host-status')!;
const selfHostStart = document.getElementById('btn-self-host-start') as HTMLButtonElement;
const selfHostStop = document.getElementById('btn-self-host-stop') as HTMLButtonElement;
let selfHostStarted = false;
voiceServerUrl.value = getServerUrl();
document.getElementById('btn-voice-server-save')!.addEventListener('click', () => {
  sendToBackground('configureVoiceServer', { url: voiceServerUrl.value });
  voiceServerStatus.textContent = 'Applying server address…';
});
document.getElementById('btn-voice-server-default')!.addEventListener('click', () => {
  voiceServerUrl.value = getDefaultServerUrl();
  sendToBackground('configureVoiceServer', { url: '' });
  voiceServerStatus.textContent = 'Switching back to the default service…';
});
 selfHostStart.addEventListener('click', async () => {
  selfHostStart.disabled = true;
  selfHostStatus.textContent = 'Starting the local voice server and ngrok tunnel…';
  try {
    const url = await invoke<string>('start_self_host');
    selfHostStarted = true;
    voiceServerUrl.value = url;
    sendToBackground('configureVoiceServer', { url });
    selfHostStatus.textContent = `Tunnel ready: ${url}. Share this address with the other players; they must enter it under Voice server.`;
    selfHostStop.classList.remove('hidden');
  } catch (error) {
    selfHostStatus.textContent = String(error);
  } finally { selfHostStart.disabled = false; }
});
selfHostStop.addEventListener('click', async () => {
  selfHostStop.disabled = true;
  try {
    await invoke('stop_self_host');
    selfHostStarted = false;
    selfHostStop.classList.add('hidden');
    voiceServerUrl.value = getDefaultServerUrl();
    sendToBackground('configureVoiceServer', { url: '' });
    selfHostStatus.textContent = 'Hosting stopped. Your app is switching back to the default service.';
  } catch (error) { selfHostStatus.textContent = String(error); }
  finally { selfHostStop.disabled = false; }
});
void listen<any>('network:server-configured', (event) => {
  voiceServerStatus.textContent = event.payload?.ok
    ? `Using ${event.payload.url}. Everyone joining this room must choose the same server.`
    : (event.payload?.message ?? 'Could not change voice server.');
  if (!event.payload?.ok && selfHostStarted) {
    void invoke('stop_self_host').catch(() => {});
    selfHostStarted = false;
    selfHostStop.classList.add('hidden');
  }
}).catch(() => { /* overlay may open after event */ });

const hostOptionsGroup = document.getElementById('host-options-group')!;
const hostMode = document.getElementById('host-mode') as HTMLSelectElement;
const hostMuffling = document.getElementById('host-muffling') as HTMLSelectElement;
const hostSpatial = document.getElementById('host-spatial') as HTMLSelectElement;
const hostTracking = document.getElementById('host-tracking') as HTMLSelectElement;
const hostChaosEnabled = document.getElementById('host-chaos-enabled') as HTMLButtonElement;
const hostChaosInterval = document.getElementById('host-chaos-interval') as HTMLSelectElement;
const hostChaosDuration = document.getElementById('host-chaos-duration') as HTMLSelectElement;
const hostDeadVoice = document.getElementById('host-dead-voice') as HTMLSelectElement;
const hostOptionsHint = document.getElementById('host-options-hint')!;
let latestRoomState: RoomState | null = null;
function publishHostOptions(): void {
  const options = {
    forcedMode: hostMode.value, muffling: hostMuffling.value, spatial: hostSpatial.value,
    trackingFps: Number(hostTracking.value),
    chaosEnabled: hostChaosEnabled.getAttribute('aria-pressed') === 'true',
    chaosIntervalSec: Number(hostChaosInterval.value), chaosDurationScale: Number(hostChaosDuration.value),
    deadVoiceMode: hostDeadVoice.value,
  } as RoomHostOptions;
  setSavedRoomHostOptions(options);
  sendToBackground('setHostOptions', options);
}
for (const select of [hostMode, hostMuffling, hostSpatial, hostTracking, hostChaosInterval, hostChaosDuration, hostDeadVoice]) select.addEventListener('change', publishHostOptions);
hostChaosEnabled.addEventListener('click', () => {
  const enabled = hostChaosEnabled.getAttribute('aria-pressed') !== 'true';
  hostChaosEnabled.setAttribute('aria-pressed', String(enabled));
  hostChaosEnabled.textContent = onOff(enabled);
  hostChaosEnabled.classList.toggle('active', enabled);
  publishHostOptions();
});
function applyRoomState(state: RoomState): void {
  const becamePrivateHost = state?.isPrivate === true && state?.isHost === true &&
    (latestRoomState?.isPrivate !== true || latestRoomState?.isHost !== true);
  latestRoomState = state;
  const preconfiguredPrivateRoom = !state?.isPrivate && getPrivateRoomCode().length >= 12;
  const isPrivateHost = !!state?.isPrivate && !!state?.isHost;
  hostOptionsGroup.classList.toggle('hidden', !(isPrivateHost || preconfiguredPrivateRoom));
  const defaults: RoomHostOptions = { forcedMode: 'inherit', muffling: 'inherit', spatial: 'inherit', trackingFps: 0, chaosEnabled: false, chaosIntervalSec: 45, chaosDurationScale: 1, deadVoiceMode: 'inherit' };
  const opts: RoomHostOptions = state?.isPrivate && !state.isHost
    ? (state.options ?? defaults)
    : (state?.options ?? getSavedRoomHostOptions());
  hostOptionsHint.textContent = !state?.isPrivate
    ? 'Saved locally. These settings publish if you are the first player to join this private room.'
    : state.isHost
      ? (state.protocolVersion === 2 ? 'Host settings are synced to this private room.' : 'Host settings use the compatible room presence channel on older servers. All room members need Yordle Yapper open.')
      : 'Only the private-room host can change these rules.';
  hostForcedMode = state?.isPrivate && opts.forcedMode && opts.forcedMode !== 'inherit' ? opts.forcedMode : null;
  hostMode.value = opts.forcedMode ?? 'inherit';
  hostMuffling.value = opts.muffling ?? 'inherit';
  hostSpatial.value = opts.spatial ?? 'inherit';
  hostTracking.value = String(opts.trackingFps ?? 0);
  hostChaosInterval.value = String(opts.chaosIntervalSec ?? 45);
  hostChaosDuration.value = String(opts.chaosDurationScale ?? 1);
  hostDeadVoice.value = opts.deadVoiceMode ?? 'inherit';
  const chaosOn = state?.isPrivate && opts.chaosEnabled === true;
  hostChaosEnabled.setAttribute('aria-pressed', String(!!chaosOn));
  hostChaosEnabled.textContent = onOff(!!chaosOn);
  hostChaosEnabled.classList.toggle('active', !!chaosOn);
  hearingMode.disabled = !!state?.isPrivate && !!opts.forcedMode && opts.forcedMode !== 'inherit';
  if (hearingMode.disabled) hearingMode.value = opts.forcedMode ?? 'nearby';
  syncHearingMode();
  btnSpatialAudio.disabled = !!state?.isPrivate && !!opts.spatial && opts.spatial !== 'inherit';
  syncRiftStereoCameraButton();
  btnVoiceMuffling.disabled = !!state?.isPrivate && !!opts.muffling && opts.muffling !== 'inherit';
  deadVoiceModeSelect.disabled = !!state?.isPrivate && !!opts.deadVoiceMode && opts.deadVoiceMode !== 'inherit';
  if (deadVoiceModeSelect.disabled) deadVoiceModeSelect.value = opts.deadVoiceMode ?? 'ghosts';
  else deadVoiceModeSelect.value = getDeadVoiceMode();
  if (becamePrivateHost && !state.options) publishHostOptions();
}
window.addEventListener('roomStateUpdate', ((event: CustomEvent) => applyRoomState(event.detail)) as EventListener);
void listen<RoomState>('room:state', (event) => applyRoomState(event.payload)).catch((error) => console.warn('[Overlay] room state listener failed:', error));

void listen<any>('network:status', (event) => {
  const status = document.getElementById('room-connection-status');
  if (!status) return;
  const state = event.payload?.state;
  status.textContent = state === 'connected' ? 'Voice room connected and synced.'
    : state === 'joining' ? 'Connected to server; joining voice room…'
      : state === 'reconnecting' ? 'Network interrupted; reconnecting and restoring room state…'
        : state === 'legacy-server' ? 'Connected to an older server. Host options and Chaos sync may not work until it is updated.'
          : state === 'unstable' ? 'Voice network is unstable; reconnecting if needed…' : 'Not connected to a voice room.';
});
void listen<{ volumeRttMs: number; succeeded: boolean }>('network:health', (event) => {
  const status = document.getElementById('room-connection-status');
  if (!status || !status.textContent?.startsWith('Voice room connected')) return;
  const { volumeRttMs, succeeded } = event.payload;
  status.textContent = succeeded
    ? `Voice room connected and synced · proximity update ${volumeRttMs} ms`
    : `Voice room connected · proximity update delayed or failed (${volumeRttMs} ms)`;
});

const btnVisibleEnemies = document.getElementById('btn-visible-enemies') as HTMLButtonElement;
function syncVisibleEnemiesButton(): void {
  const on = getVisibleEnemiesOnly();
  btnVisibleEnemies.textContent = onOff(on);
  btnVisibleEnemies.classList.toggle('active', on);
  btnVisibleEnemies.setAttribute('aria-pressed', String(on));
}
queueMicrotask(syncVisibleEnemiesButton);
btnVisibleEnemies.addEventListener('click', () => {
  setVisibleEnemiesOnly(!getVisibleEnemiesOnly());
  syncVisibleEnemiesButton();
});

const btnAdaptiveTracking = document.getElementById('btn-adaptive-tracking') as HTMLButtonElement;
function syncAdaptiveTracking(): void {
  const on = getAdaptiveTracking();
  btnAdaptiveTracking.textContent = onOff(on);
  btnAdaptiveTracking.classList.toggle('active', on);
  btnAdaptiveTracking.setAttribute('aria-pressed', String(on));
}
queueMicrotask(syncAdaptiveTracking);
btnAdaptiveTracking.addEventListener('click', () => { setAdaptiveTracking(!getAdaptiveTracking()); syncAdaptiveTracking(); });

const btnMatchRecap = document.getElementById('btn-match-recap') as HTMLButtonElement;
function syncMatchRecap(): void {
  const on = getMatchRecapEnabled();
  btnMatchRecap.textContent = onOff(on);
  btnMatchRecap.classList.toggle('active', on);
  btnMatchRecap.setAttribute('aria-pressed', String(on));
}
queueMicrotask(syncMatchRecap);
btnMatchRecap.addEventListener('click', () => {
  setMatchRecapEnabled(!getMatchRecapEnabled());
  syncMatchRecap();
});

const replayConsentButton = document.getElementById('btn-replay-consent') as HTMLButtonElement;
const replayConsentStatus = document.getElementById('replay-consent-status')!;
const replayFileInput = document.getElementById('replay-file') as HTMLInputElement;
const replayPlaybackStatus = document.getElementById('replay-playback-status')!;
const replayPlayback = new ReplayPlayback();
let replayLoaded = false;
let replayPollRunning = false;
function setReplayConsentButton(enabled: boolean): void {
  replayConsentButton.textContent = onOff(enabled);
  replayConsentButton.classList.toggle('active', enabled);
  replayConsentButton.setAttribute('aria-pressed', String(enabled));
}
replayConsentButton.addEventListener('click', () => {
  const enabled = replayConsentButton.getAttribute('aria-pressed') !== 'true';
  setReplayConsentButton(enabled);
  sendToBackground('setReplayConsent', { enabled });
});
void listen<{ enabled: boolean }>('replay:consent', (event) => setReplayConsentButton(event.payload.enabled));
void listen<{ state: string; message: string }>('replay:status', (event) => {
  replayConsentStatus.textContent = event.payload.message;
  replayConsentStatus.dataset.state = event.payload.state;
});
document.getElementById('btn-open-replay-folder')!.addEventListener('click', () => {
  void invoke('open_replay_folder').catch((error) => { replayPlaybackStatus.textContent = `Could not open replay folder: ${String(error)}`; });
});
document.getElementById('btn-load-replay')!.addEventListener('click', () => replayFileInput.click());
replayFileInput.addEventListener('change', async () => {
  const file = replayFileInput.files?.[0];
  if (!file) return;
  try {
    const count = await replayPlayback.load(file);
    replayLoaded = true;
    replayPlaybackStatus.textContent = `${file.name} loaded · ${count} voices. Start this match in League Replay; playback follows its camera and timeline.`;
  } catch (error) {
    replayLoaded = false;
    replayPlayback.close();
    replayPlaybackStatus.textContent = `Could not load replay: ${String(error)}`;
  } finally { replayFileInput.value = ''; }
});
window.setInterval(async () => {
  if (!replayLoaded || replayPollRunning) return;
  replayPollRunning = true;
  try {
    const state = await invoke<ReplayApiState | null>('get_league_replay_state');
    if (state) await replayPlayback.update(state);
    else replayPlaybackStatus.textContent = 'Waiting for League Replay API. Enable EnableReplayApi=1 under [General] in game.cfg, then open a replay.';
  } catch (error) {
    console.warn('[Replay] Replay API polling failed:', error);
  } finally { replayPollRunning = false; }
}, 200);

// Optional private match room: the automatic match room remains the default.
const roomCodeInput = document.getElementById('private-room-code') as HTMLInputElement;
const roomCodeStatus = document.getElementById('room-code-status')!;
const roomCodePattern = /^[a-z0-9_-]{12,48}$/;
function syncRoomCodeStatus(): void {
  const code = roomCodeInput.value.trim().replace(/\s+/g, '').toLowerCase();
  if (!code) {
    setPrivateRoomCode('');
    roomCodeStatus.textContent = t('settings.roomCodeAutomatic');
  } else if (!roomCodePattern.test(code)) {
    setPrivateRoomCode('');
    roomCodeStatus.textContent = t('settings.roomCodeInvalid');
  } else {
    roomCodeInput.value = code;
    setPrivateRoomCode(code);
    roomCodeStatus.textContent = t('settings.roomCodeReady');
  }
  applyRoomState(latestRoomState ?? { peers: [], host: null, isHost: false, isPrivate: false });
}
roomCodeInput.value = getPrivateRoomCode();
syncRoomCodeStatus();
roomCodeInput.addEventListener('change', syncRoomCodeStatus);
roomCodeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') roomCodeInput.blur(); });
document.getElementById('btn-generate-room')!.addEventListener('click', () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  roomCodeInput.value = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  syncRoomCodeStatus();
});
document.getElementById('btn-copy-room')!.addEventListener('click', () => {
  const code = roomCodeInput.value.trim();
  if (!roomCodePattern.test(code)) { roomCodeStatus.textContent = t('settings.roomCodeInvalid'); return; }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    void navigator.clipboard.writeText(code).then(
      () => { roomCodeStatus.textContent = t('settings.roomCopied'); },
      () => { roomCodeStatus.textContent = t('settings.roomCopyFailed'); },
    );
  } catch { roomCodeStatus.textContent = t('settings.roomCopyFailed'); }
});
document.getElementById('btn-clear-room')!.addEventListener('click', () => {
  roomCodeInput.value = '';
  syncRoomCodeStatus();
});

// Shared RESET (opt-in, off by default): see audio-prefs.ts.
const btnSharedReset = document.getElementById('btn-shared-reset') as HTMLButtonElement;
function syncSharedResetButton(): void {
  const on = getSharedReset();
  btnSharedReset.textContent = onOff(on);
  btnSharedReset.classList.toggle('active', on);
}
queueMicrotask(syncSharedResetButton);
btnSharedReset.addEventListener('click', () => {
  // Reaches the server on the next position tick (Orchestrator).
  setSharedReset(!getSharedReset());
  syncSharedResetButton();
  syncRoomCodeStatus();
});

// v0.3 (#1): PTT + toggle-mute key rebind. The Rust WH_KEYBOARD_LL hook
// reads the bound VK code from atomics it exposes via set_ptt_key /
// set_toggle_key Tauri commands. UI pattern: click the button → "Press a
// key..." prompt → capture next keydown → translate to Win32 VK → persist
// + push to Rust.
const PTT_VK_KEY = 'lolproxchat.pttVk';
const TOGGLE_VK_KEY = 'lolproxchat.toggleVk';
// The key left of 1 on this keyboard layout (º on Spanish, ` on US), asked of
// Rust at startup. Until v0.5.16 this was Caps Lock, whose toggle the hook has
// to cancel on every press — which left testers unable to type capitals. A
// stored bind, Caps Lock included, is kept. VK_OEM_3 until Rust answers.
let DEFAULT_PTT_VK: number | null = 0xC0;
const FORBIDDEN_CODES = new Set([
  'Escape', 'Tab',
  // Common LoL bindings — would conflict with gameplay even though our
  // hook fires first.
  'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyD', 'KeyF', 'KeyB', 'KeyP',
  // Modifier-only is bad UX (always pressed during typing combos)
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

// Re-label the bind buttons when the language changes (key names are
// localized too: Caps Lock is Bloq Mayús on a Spanish keyboard).
const bindRelabelers: Array<() => void> = [];

/** Layout names for the OEM punctuation keys, whose US names mislead on
 *  other layouts (VK_OEM_5 is "\\" on US and "º" on Spanish). */
const layoutKeyNames = new Map<number, string>();
function keyLabel(vk: number): string {
  return layoutKeyNames.get(vk) ?? translateKey(humanizeVk(vk));
}
async function learnKeyName(vk: number): Promise<void> {
  if (vk < 0xBA || layoutKeyNames.has(vk)) return;
  try {
    const name = await invoke<string | null>('key_name', { vk });
    if (name) {
      layoutKeyNames.set(vk, name);
      bindRelabelers.forEach((f) => f());
    }
  } catch { /* the US name stays */ }
}

function setupBindButton(buttonId: string, storageKey: string, backgroundCmd: string, defaultVk: number | null): void {
  const btn = document.getElementById(buttonId) as HTMLButtonElement;
  if (!btn) return;
  const stored = localStorage.getItem(storageKey);
  let boundVk = stored !== null ? parseInt(stored, 10) : defaultVk;
  if (boundVk) void learnKeyName(boundVk);
  const label = (): string =>
    boundVk !== null && !Number.isNaN(boundVk) && boundVk > 0 ? keyLabel(boundVk) : t('settings.unbound');
  btn.textContent = label();
  // Mid-capture the button shows the prompt (or a 1.5s rejection, which then
  // restores label() in whatever language is current by then).
  bindRelabelers.push(() => { btn.textContent = btn.disabled ? t('settings.pressKey') : label(); });

  btn.addEventListener('click', () => {
    btn.textContent = t('settings.pressKey');
    btn.classList.add('active');
    btn.disabled = true;
    const restore = (text: string) => {
      btn.textContent = text;
      btn.classList.remove('active');
      btn.disabled = false;
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('keydown', onKey, true);
      if (e.code === 'Escape') {
        restore(label());
        return;
      }
      if (FORBIDDEN_CODES.has(e.code)) {
        restore(t('settings.forbiddenKey'));
        setTimeout(() => restore(label()), 1500);
        return;
      }
      const vk = browserKeyToWin32Vk(e.code);
      if (vk === null) {
        restore(t('settings.unsupportedKey'));
        setTimeout(() => restore(label()), 1500);
        return;
      }
      localStorage.setItem(storageKey, String(vk));
      sendToBackground(backgroundCmd, { vk });
      boundVk = vk;
      void learnKeyName(vk);
      restore(label());
    };
    window.addEventListener('keydown', onKey, true);
  });
}

queueMicrotask(async () => {
  try {
    DEFAULT_PTT_VK = await invoke<number>('default_ptt_key');
  } catch { /* keep VK_OEM_3 */ }
  setupBindButton('btn-bind-ptt', PTT_VK_KEY, 'setPttKey', DEFAULT_PTT_VK);
  setupBindButton('btn-bind-toggle', TOGGLE_VK_KEY, 'setToggleKey', null);
  // Push the PTT key to Rust on startup — the stored bind, or the default the
  // button shows, so the label and the watched key always agree.
  const ptt = localStorage.getItem(PTT_VK_KEY);
  const pttVk = ptt !== null ? parseInt(ptt, 10) : DEFAULT_PTT_VK;
  if (pttVk !== null && !Number.isNaN(pttVk)) sendToBackground('setPttKey', { vk: pttVk });
  const toggle = localStorage.getItem(TOGGLE_VK_KEY);
  if (toggle !== null) sendToBackground('setToggleKey', { vk: parseInt(toggle, 10) });
});

btnDebug.addEventListener('click', () => {
  debugEnabled = !debugEnabled;
  voiceDebug.classList.toggle('hidden', !debugEnabled);
  btnDebug.textContent = onOff(debugEnabled);
  btnDebug.classList.toggle('active', debugEnabled);
  setLoggingEnabled(debugEnabled);
  // Read by orchestrator when emitting scanner:scene events so the scanner
  // window only renders the tracking dot while Debug is on.
  window.__lolproxchat_debug_enabled = debugEnabled;
  // Hide the HSV thumbnail immediately when Debug flips off.
  if (!debugEnabled) {
    debugFilterThumb.classList.add('hidden');
    debugFilterThumb.removeAttribute('src');
    if (voiceSimulator.isRunning) voiceSimStart.click();
  }
  // v0.3 (#11): re-fit window for new debug-row visibility
  syncOverlayHeight();
});

// HSV-filtered minimap preview — shown only while Debug is on. Listens to the
// same scanner:scene event the scanner window does; the panel renders the
// filtered image (which used to live painted on the scanner itself, but that
// fed back into the next capture cycle and required excluding the scanner
// from capture, which broke ShadowPlay / OBS).
const debugFilterThumb = document.getElementById('debug-filter-thumb') as HTMLImageElement;
function updateVoiceSimPlacement(state: OverlayState): void {
  if (!voiceSimulator.isRunning || voiceSimulator.placedDistance === null) return;
  const mode = (document.getElementById('hearing-mode') as HTMLSelectElement).value;
  const listener = mode === 'camera' && state.cameraPosition ? state.cameraPosition : state.lastPosition;
  if (!listener) return;
  const directionListener = mode === 'camera' || (mode === 'rift' && getRiftStereoFromCamera())
    ? state.cameraPosition ?? listener
    : listener;
  const distance = voiceSimulator.updateListener(listener, directionListener);
  if (distance === null) return;
  const loudness = voiceSimulator.activeLoudness;
  const shouting = loudness >= SHOUT_LEVEL_THRESHOLD;
  const sound = distance >= voiceSimulator.echoRange
    ? 'out of range'
    : shouting && distance > voiceSimulator.currentShoutingRange ? 'reverb enabled' : 'no reverb';
  const anchor = mode === 'camera' && state.cameraPosition ? 'camera' : 'champion';
  const direction = mode === 'rift' && getRiftStereoFromCamera() && state.cameraPosition ? ', stereo follows camera' : '';
  voiceSimPlacement.textContent = `Second player: ${distance}u from ${anchor}, voice level ${Math.round(loudness * 100)}%${direction}, ${sound}.`;
}

listen<{ filteredImageUrl: string | null; debugEnabled: boolean }>('scanner:scene', (event) => {
  const { filteredImageUrl, debugEnabled: dbg } = event.payload;
  if (dbg && filteredImageUrl) {
    if (debugFilterThumb.src !== filteredImageUrl) debugFilterThumb.src = filteredImageUrl;
    debugFilterThumb.classList.remove('hidden');
  } else {
    debugFilterThumb.classList.add('hidden');
    if (!filteredImageUrl) debugFilterThumb.removeAttribute('src');
  }
}).catch((e) => console.warn('[Overlay] scanner:scene listen failed:', e));

debugFilterThumb.addEventListener('click', async (event) => {
  if (!debugEnabled || !lastState?.mapType || !lastState.detectedMinimapBounds) {
    voiceSimPlacement.textContent = 'Waiting for a supported, detected game minimap.';
    return;
  }
  const bounds = debugFilterThumb.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const xFraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const yFraction = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
  const dimensions = MAP_DIMENSIONS[lastState.mapType];
  const source = { x: xFraction * dimensions.width, y: (1 - yFraction) * dimensions.height };
  const hearingMode = (document.getElementById('hearing-mode') as HTMLSelectElement).value;
  const listener = hearingMode === 'camera' && lastState.cameraPosition
    ? lastState.cameraPosition
    : lastState.lastPosition;
  if (!listener) {
    voiceSimPlacement.textContent = 'Waiting for your champion position. Keep Debug on until tracking finds you.';
    return;
  }
  try {
    if (!voiceSimulator.isRunning) {
      await voiceSimulator.start();
      voiceSimStart.textContent = 'STOP LOCAL AUDIO';
      voiceSimStatus.textContent = 'Second player connected through local WebRTC.';
    }
    const hidden = voiceSimHidden.getAttribute('aria-pressed') === 'true';
    const directionListener = hearingMode === 'camera' || (hearingMode === 'rift' && getRiftStereoFromCamera())
      ? lastState.cameraPosition ?? listener
      : listener;
    await voiceSimulator.placeSpeaker(source, listener, hidden, directionListener);
    voiceSimMarker.style.left = (xFraction * 100) + '%';
    voiceSimMarker.style.top = (yFraction * 100) + '%';
    voiceSimMarker.classList.remove('hidden');
    updateVoiceSimPlacement(lastState);
  } catch (error) {
    voiceSimStatus.textContent = 'Could not place local speaker: ' + String(error);
  }
});

// v0.3 (#11): also re-fit when the thumbnail finishes loading (async image
// load can change scrollHeight after the toggle click already fired) and on
// every overlayUpdate (peer list grows / shrinks).
debugFilterThumb.addEventListener('load', syncOverlayHeight);
const panelEl = document.querySelector('.panel');
if (panelEl) {
  new ResizeObserver(syncOverlayHeight).observe(panelEl);
}
window.addEventListener('DOMContentLoaded', syncOverlayHeight);

// The input mode is remembered, and pushed at load as well as on change: it
// used to be neither, so Push to Talk chosen in the lobby (or in the previous
// game) showed on the panel while the next game's mic ran always-open. The
// keyboard hook only watches the push-to-talk key in push-to-talk mode.
const INPUT_MODE_KEY = 'lolproxchat.inputMode';
const inputModeSelect = document.getElementById('input-mode') as HTMLSelectElement;
function applyInputMode(): void {
  const mode = inputModeSelect.value;
  sendToBackground('updateSettings', { inputMode: mode });
  sendToBackground('setPttActive', { active: mode === 'ptt' });
}
try {
  const storedMode = localStorage.getItem(INPUT_MODE_KEY);
  if (storedMode === 'ptt' || storedMode === 'always') inputModeSelect.value = storedMode;
} catch { /* default: Always Open */ }
inputModeSelect.addEventListener('change', () => {
  try { localStorage.setItem(INPUT_MODE_KEY, inputModeSelect.value); } catch { /* still applied */ }
  applyInputMode();
});
applyInputMode();

const volumeInput = document.getElementById('input-volume') as HTMLInputElement;
const volumeLabel = document.getElementById('volume-label')!;
volumeInput.addEventListener('input', () => {
  const raw = parseInt(volumeInput.value);
  volumeLabel.textContent = String(raw);
  sendToBackground('updateSettings', { inputVolume: raw / 100 });
});

function sendToBackground(action: string, payload: any): void {
  // In Tauri, both background and overlay run in the same WebView,
  // so we use window events for communication
  window.dispatchEvent(new CustomEvent('overlayAction', { detail: { action, payload } }));
}

// Report the panel's current size to Rust so the click-through hit-test
// follows collapse/expand/settings open. Multiply by devicePixelRatio
// because offsetWidth/Height are CSS pixels but the Rust side compares
// against physical-pixel cursor coords from GetCursorPos.
let lastSentPanelWidth: number | null = null;
let lastSentPanelHeight: number | null = null;
const reportPanelSize = () => {
  const dpr = window.devicePixelRatio || 1;
  // The hit-test must match the native window bounds, including transparent
  // resize edges, rather than the content's natural (scrollable) height.
  const width = Math.round(window.innerWidth * dpr);
  const height = Math.round(window.innerHeight * dpr);
  // Same dedupe as syncOverlayHeight — the hit-rect only needs updating when
  // the panel actually changed size (collapse/expand/settings open).
  if (!shouldSendSize(lastSentPanelWidth, width) && !shouldSendSize(lastSentPanelHeight, height)) return;
  lastSentPanelWidth = width;
  lastSentPanelHeight = height;
  sendToBackground('panelResize', { width, height });
};
new ResizeObserver(reportPanelSize).observe(panel);
window.addEventListener('resize', reportPanelSize);
// Initial report once the layout has settled
requestAnimationFrame(reportPanelSize);

// --- Track active player row DOM elements for in-place updates ---
const playerRows: Map<string, {
  row: HTMLElement;
  nameSpan: HTMLElement;
  indicator: HTMLElement | null;
  volSlider: HTMLInputElement;
  muteBtn: HTMLButtonElement;
}> = new Map();

// Track whether a player slider is being actively dragged
let activeSliderPlayer: string | null = null;

function createPlayerRow(peer: NearbyPeer, localTeam: 'ORDER' | 'CHAOS' | null | undefined): HTMLElement {
  const row = document.createElement('div');
  const isAlly = localTeam ? peer.team === localTeam : peer.team === 'ORDER';
  row.className = 'player-row ' + (isAlly ? 'ally' : 'enemy');

  const nameSpan = document.createElement('span');
  nameSpan.className = 'player-name';
  nameSpan.textContent = peer.championName;
  nameSpan.title = peer.summonerName;
  row.appendChild(nameSpan);

  const indicator = document.createElement('span');
  indicator.className = 'player-muted-indicator';
  if (peer.isDead) {
    indicator.textContent = t('players.dead');
  } else if (peer.isMuted) {
    indicator.textContent = t('players.muted');
  } else {
    indicator.style.display = 'none';
  }
  row.appendChild(indicator);

  const volSlider = document.createElement('input') as HTMLInputElement;
  volSlider.type = 'range';
  volSlider.className = 'player-volume';
  volSlider.min = '0';
  volSlider.max = '100';
  volSlider.value = String(Math.round((playerVolumes.get(peer.summonerName) ?? 1.0) * 100));
  volSlider.addEventListener('mousedown', () => { activeSliderPlayer = peer.summonerName; });
  volSlider.addEventListener('mouseup', () => { activeSliderPlayer = null; });
  volSlider.addEventListener('input', () => {
    const vol = parseInt(volSlider.value) / 100;
    playerVolumes.set(peer.summonerName, vol);
    sendToBackground('setPlayerVolume', { name: peer.summonerName, volume: vol });
  });
  row.appendChild(volSlider);

  const muteBtn = document.createElement('button') as HTMLButtonElement;
  muteBtn.className = 'player-mute-btn' + (peer.isMutedByLocal ? ' muted' : '');
  muteBtn.textContent = t(peer.isMutedByLocal ? 'players.mutedByYou' : 'players.mute');
  muteBtn.addEventListener('click', () => {
    // Flip the UI immediately so the user gets feedback without waiting
    // for the next broadcastOverlayState tick. Backend state will confirm.
    const nowMuted = !muteBtn.classList.contains('muted');
    muteBtn.classList.toggle('muted', nowMuted);
    muteBtn.textContent = t(nowMuted ? 'players.mutedByYou' : 'players.mute');
    console.log('[Overlay] Mute toggled for', peer.summonerName, '→', nowMuted);
    sendToBackground('toggleMutePlayer', { name: peer.summonerName });
  });
  row.appendChild(muteBtn);

  playerRows.set(peer.summonerName, { row, nameSpan, indicator, volSlider, muteBtn });
  return row;
}

function updatePlayerRow(peer: NearbyPeer): void {
  const entry = playerRows.get(peer.summonerName);
  if (!entry) return;

  // Update indicator
  if (peer.isDead) {
    entry.indicator!.textContent = t('players.dead');
    entry.indicator!.style.display = '';
  } else if (peer.isMuted) {
    entry.indicator!.textContent = t('players.muted');
    entry.indicator!.style.display = '';
  } else {
    entry.indicator!.style.display = 'none';
  }

  // Don't touch slider if user is actively dragging it
  if (activeSliderPlayer !== peer.summonerName) {
    const expected = String(Math.round((playerVolumes.get(peer.summonerName) ?? 1.0) * 100));
    if (entry.volSlider.value !== expected) {
      entry.volSlider.value = expected;
    }
  }

  // Update mute button
  const isMuted = peer.isMutedByLocal;
  entry.muteBtn.className = 'player-mute-btn' + (isMuted ? ' muted' : '');
  entry.muteBtn.textContent = t(isMuted ? 'players.mutedByYou' : 'players.mute');
}

// --- Render state ---
let lastState: OverlayState | null = null;

function renderState(state: OverlayState): void {
  lastState = state;
  updateVoiceSimPlacement(state);
  // Color-only mute indication (see the click handlers) — label stays static.
  btnSelfMute.classList.toggle('active', state.selfMuted);
  btnMuteAll.classList.toggle('active', state.muteAll);

  // Sort: allies first, then by champion name
  const localTeam = state.localTeam ?? null;
  const sortedPeers = [...state.nearbyPeers].sort((a, b) => {
    if (localTeam) {
      const aAlly = a.team === localTeam;
      const bAlly = b.team === localTeam;
      if (aAlly !== bAlly) return aAlly ? -1 : 1;
    }
    return a.championName.localeCompare(b.championName);
  });

  // Build set of current peer names for diffing
  const currentNames = new Set(sortedPeers.map(p => p.summonerName));

  // Remove rows for peers that left
  for (const [name, entry] of playerRows) {
    if (!currentNames.has(name)) {
      entry.row.remove();
      playerRows.delete(name);
    }
  }

  // Update existing rows or create new ones, in sorted order.
  // Only reorder DOM when the sort order *actually* changed — re-appending
  // a slider mid-drag detaches it from its pointer-event sequence, which
  // is why the per-player volume slider felt "clicky" / had to be re-grabbed
  // at every tick (issue #12). At 10 Hz position ticks the order rarely
  // changes, so the common case is now a no-op.
  const desiredOrder = sortedPeers.map(p => p.summonerName);
  const currentOrder: string[] = [];
  for (const child of Array.from(playerList.children)) {
    for (const [name, entry] of playerRows) {
      if (entry.row === child) { currentOrder.push(name); break; }
    }
  }
  const orderChanged = currentOrder.length !== desiredOrder.length
    || currentOrder.some((n, i) => n !== desiredOrder[i]);

  for (const peer of sortedPeers) {
    let entry = playerRows.get(peer.summonerName);
    if (entry) {
      updatePlayerRow(peer);
    } else {
      const row = createPlayerRow(peer, localTeam);
      playerList.appendChild(row);
      entry = playerRows.get(peer.summonerName);
    }
    if (orderChanged && entry && entry.row.parentElement === playerList) {
      playerList.appendChild(entry.row);
    }
  }

  renderRemoteReset(state.remoteReset ?? null);

  // Show/hide empty state with lifecycle-aware text
  const emptyText = state.lifecycleStatus ? translateStatus(state.lifecycleStatus) : t('players.waiting');
  const emptyState = playerList.querySelector('.empty-state');
  if (sortedPeers.length === 0) {
    if (!emptyState) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state';
      emptyDiv.textContent = emptyText;
      playerList.appendChild(emptyDiv);
    } else if (emptyState.textContent !== emptyText) {
      emptyState.textContent = emptyText;
    }
  } else if (emptyState) {
    emptyState.remove();
  }

  // Debug info: tracking state + position (only when debug enabled)
  const dbgEl = document.getElementById('debug-info')!;
  if (debugEnabled && (state.trackingState || state.lastPosition)) {
    const parts: string[] = [];
    if (state.trackingState) parts.push('tracking: ' + state.trackingState);
    if (state.lastPosition) {
      parts.push('pos: (' + Math.round(state.lastPosition.x) + ',' + Math.round(state.lastPosition.y) + ')');
    }
    dbgEl.textContent = parts.join(' | ');
    dbgEl.classList.remove('hidden');
  } else {
    dbgEl.classList.add('hidden');
  }
}

// --- Listen for state updates from background ---
window.addEventListener('overlayUpdate', ((event: CustomEvent) => {
  renderState(event.detail);
}) as EventListener);

// --- Language ---
// Applied at load, and again live from the Settings drop-down: everything the
// panel shows is re-labelled in place, no restart.
const languageSelect = document.getElementById('language') as HTMLSelectElement;
for (const { code, name } of LANGUAGES) {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = name;
  languageSelect.appendChild(opt);
}

function applyLanguage(): void {
  const lang = getLanguage();
  document.documentElement.lang = lang;
  languageSelect.value = lang;
  applyTranslations(document, lang);
  if (resetFeedbackId === null) btnResetPosition.textContent = t('settings.reset');
  btnCollapse.title = t(collapsed ? 'header.expand' : 'header.collapse');
  syncAutoUpdateButton();
  syncForceTurnButton();
  syncAllyProximityButton();
  syncCameraListenButton();
  syncHearingMode();
  syncVisibleEnemiesButton();
  syncAppAudioButton();
  syncSharedResetButton();
  syncRoomCodeStatus();
  btnDebug.textContent = onOff(debugEnabled);
  for (const relabel of bindRelabelers) relabel();
  if (updateStatusMsg) updateStatus.textContent = t(updateStatusMsg.key, updateStatusMsg.params);
  if (!settingsPanel.classList.contains('hidden')) refreshDeviceLists();
  if (lastState) renderState(lastState);
}

languageSelect.addEventListener('change', () => {
  setLanguage(languageSelect.value as Lang);
  applyLanguage();
});
// After the bind buttons are set up (queued above), so they are relabelled too.
queueMicrotask(applyLanguage);

console.log('Yordle Yapper overlay loaded');

export {};

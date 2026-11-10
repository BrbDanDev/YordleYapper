import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { echoForDistance, MAX_ECHO_RANGE, shoutRangeForLevel, voiceRangeForLevel } from './voice-debug-simulator';

export interface ReplayPosition { x: number; y: number }
export interface ReplayTrackInput {
  name: string;
  champion: string;
  team: string;
  local: boolean;
  stream: MediaStream;
}
interface ReplayTrack {
  name: string;
  champion: string;
  team: string;
  local: boolean;
  startedAt: number;
  endedAt: number;
  positions: Array<[number, number, number, number]>;
  bytes: number;
  audio?: Blob;
}
interface ReplayManifest { version: 1; createdAt: string; map: string; tracks: ReplayTrack[] }
export interface ReplayApiState {
  playback: { paused: boolean; time: number; speed: number; length: number };
  render: { cameraPosition: { x: number; y: number; z: number }; cameraRotation: { x: number; y: number; z: number } };
}

const MIME = typeof MediaRecorder !== 'undefined'
  ? ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type)) || ''
  : '';

/** All audio is WebM/Opus. Position samples and timing are delta-light metadata;
 * the YYRP container stores already-compressed audio without recompressing it. */
export class ReplayRecorder {
  private tracks = new Map<string, { meta: ReplayTrack; recorder: MediaRecorder; chunks: Blob[] }>();
  private active = false;
  private startedAt = 0;
  private lastPositionSample = -Infinity;
  private baseGameTime = 0;
  private map = 'Unknown';
  private readyBlob: Blob | null = null;
  private exporting = false;

  get isActive(): boolean { return this.active; }
  get hasReplay(): boolean { return this.readyBlob !== null; }

  /** Nudge the local monotonic clock toward League's simulation clock to avoid
   * gradual drift on long matches or when the client briefly hitches. */
  syncGameTime(gameTime: number | null | undefined): void {
    if (!this.active || !Number.isFinite(gameTime)) return;
    const error = gameTime! - this.gameTimeNow();
    this.baseGameTime += Math.max(-0.15, Math.min(0.15, error * 0.2));
  }

  async start(inputs: ReplayTrackInput[], gameTime: number, map: string): Promise<void> {
    if (!Number.isFinite(gameTime) || gameTime < 0) throw new Error('League game time is unavailable.');
    if (!MIME) throw new Error('This Windows audio engine does not support Opus replay recording.');
    this.readyBlob = null;
    this.tracks.clear();
    this.active = true;
    this.startedAt = performance.now();
    this.lastPositionSample = -Infinity;
    this.baseGameTime = gameTime;
    this.map = map || 'Unknown';
    this.addTracks(inputs);
    if (!this.tracks.size) { this.active = false; throw new Error('No audio tracks are ready to record.'); }
    console.info('[Replay] Recording started after room-wide consent:', this.tracks.size, 'audio tracks');
  }

  addTracks(inputs: ReplayTrackInput[]): void {
    if (!this.active) return;
    for (const input of inputs) {
      if (this.tracks.has(input.name) || input.stream.getAudioTracks().length === 0) continue;
      const recorder = new MediaRecorder(input.stream, { mimeType: MIME, audioBitsPerSecond: 20000 });
      const meta: ReplayTrack = { name: input.name, champion: input.champion, team: input.team, local: input.local,
        startedAt: this.gameTimeNow(), endedAt: 0, positions: [], bytes: 0 };
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) { chunks.push(event.data); meta.bytes += event.data.size; } };
      recorder.onerror = (event) => console.warn('[Replay] Recorder error for', input.name, event);
      recorder.start(5000);
      this.tracks.set(input.name, { meta, recorder, chunks });
    }
  }

  sample(positions: Record<string, ReplayPosition>, levels: Record<string, number>): void {
    if (!this.active) return;
    const now = performance.now();
    if (now - this.lastPositionSample < 250) return;
    this.lastPositionSample = now;
    const t = this.gameTimeNow();
    for (const [name, pos] of Object.entries(positions)) {
      const track = this.tracks.get(name)?.meta;
      if (!track || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
      const level = Math.max(0, Math.min(1, levels[name] ?? 0));
      const sample: [number, number, number, number] = [Math.round((t - track.startedAt) * 10) / 10, Math.round(pos.x), Math.round(pos.y), Math.round(level * 100) / 100];
      const prev = track.positions[track.positions.length - 1];
      if (!prev || prev[0] !== sample[0]) track.positions.push(sample);
    }
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    const captures = [...this.tracks.values()];
    await Promise.all(captures.map(({ recorder }) => new Promise<void>((resolve) => {
      if (recorder.state === 'inactive') return resolve();
      recorder.addEventListener('stop', () => resolve(), { once: true });
      try { recorder.stop(); } catch { resolve(); }
    })));
    const end = this.gameTimeNow();
    const tracks = captures.map(({ meta, chunks }) => {
      meta.endedAt = end;
      meta.audio = new Blob(chunks, { type: MIME });
      return meta;
    }).filter((track) => (track.audio?.size ?? 0) > 0);
    if (!tracks.length) { this.tracks.clear(); return; }
    const manifest: ReplayManifest = { version: 1, createdAt: new Date().toISOString(), map: this.map, tracks };
    const json = new TextEncoder().encode(JSON.stringify(manifest, (key, value) => key === 'audio' ? undefined : value));
    const header = new Uint8Array(8);
    header.set([0x59, 0x59, 0x52, 0x50], 0); // YYRP
    new DataView(header.buffer).setUint32(4, json.byteLength, true);
    const audio = tracks.map((track) => track.audio!);
    this.readyBlob = new Blob([header, json, ...audio], { type: 'application/vnd.yordleyapper.replay' });
    console.info('[Replay] Ready:', tracks.length, 'tracks,', Math.round(this.readyBlob.size / 1024 / 1024 * 10) / 10, 'MiB');
    this.tracks.clear();
    await emit('replay:status', { state: 'ready', message: `Replay ready · ${Math.round(this.readyBlob.size / 1024 / 1024 * 10) / 10} MB. Saving locally…` });
  }

  async save(): Promise<string> {
    if (!this.readyBlob || this.exporting) throw new Error('No finished replay is ready to save.');
    this.exporting = true;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `Yordle-Yapper-${stamp}.yyr`;
    try {
      await invoke('replay_export_begin', { name });
      const reader = this.readyBlob.stream().getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Small IPC batches bound transient memory even for long matches.
        for (let i = 0; i < value.length; i += 128 * 1024) {
          await invoke('replay_export_chunk', { bytes: Array.from(value.subarray(i, i + 128 * 1024)) });
        }
      }
      const path = await invoke<string>('replay_export_finish');
      this.readyBlob = null;
      await emit('replay:status', { state: 'saved', message: `Replay saved · ${path}` });
      return path;
    } catch (error) {
      await invoke('replay_export_cancel').catch(() => undefined);
      await emit('replay:status', { state: 'ready', message: `Replay is ready but could not be saved: ${String(error)}` });
      throw error;
    } finally { this.exporting = false; }
  }

  private gameTimeNow(): number { return this.baseGameTime + (performance.now() - this.startedAt) / 1000; }
}

export async function parseReplay(file: Blob): Promise<{ manifest: ReplayManifest; audio: Blob[] }> {
  if (file.size < 8) throw new Error('This file is too small to be a Yordle Yapper replay.');
  const head = new DataView(await file.slice(0, 8).arrayBuffer());
  const magic = new Uint8Array(head.buffer, 0, 4);
  if (magic[0] !== 0x59 || magic[1] !== 0x59 || magic[2] !== 0x52 || magic[3] !== 0x50) throw new Error('This is not a .yyr replay file.');
  const length = head.getUint32(4, true);
  if (length < 2 || length > 32 * 1024 * 1024 || 8 + length > file.size) throw new Error('Replay metadata is invalid.');
  const manifest = JSON.parse(new TextDecoder().decode(await file.slice(8, 8 + length).arrayBuffer())) as ReplayManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.tracks) || manifest.tracks.length > 10) throw new Error('Replay format version is not supported.');
  let offset = 8 + length;
  const audio: Blob[] = [];
  for (const track of manifest.tracks) {
    if (!Number.isSafeInteger(track.bytes) || track.bytes < 0 || offset + track.bytes > file.size) throw new Error('Replay audio data is incomplete.');
    audio.push(file.slice(offset, offset + track.bytes, 'audio/webm'));
    offset += track.bytes;
  }
  return { manifest, audio };
}

/** Synchronizes recorded voices to the user's live League replay clock/camera. */
export class ReplayPlayback {
  private context: AudioContext | null = null;
  private voices: Array<{ track: ReplayTrack; audio: HTMLAudioElement; panner: PannerNode; gain: GainNode; low: BiquadFilterNode; high: BiquadFilterNode; delay: DelayNode; reverbSend: GainNode; source: MediaElementAudioSourceNode; url: string }> = [];
  private reverb: ConvolverNode | null = null;
  private reverbOut: GainNode | null = null;
  private listener = false;

  async load(file: Blob): Promise<number> {
    this.close();
    const context = new AudioContext();
    this.context = context;
    if (context.state === 'suspended') await context.resume();
    const { manifest, audio } = await parseReplay(file);
    const impulse = context.createBuffer(2, context.sampleRate * 2, context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      let seed = 0x51f15e + channel * 7919;
      for (let i = 0; i < data.length; i++) {
        seed = (seed * 16807) % 2147483647;
        const time = i / context.sampleRate;
        data[i] = ((seed / 1073741823.5) - 1) * Math.exp(-time * (channel ? 3.35 : 3)) * (time < 0.12 ? 1 : 0.72) * 0.32;
      }
    }
    this.reverb = context.createConvolver(); this.reverb.buffer = impulse;
    this.reverbOut = context.createGain(); this.reverbOut.gain.value = 0.32;
    this.reverb.connect(this.reverbOut).connect(context.destination);
    for (let index = 0; index < manifest.tracks.length; index++) {
      const track = manifest.tracks[index];
      const url = URL.createObjectURL(audio[index]);
      const element = new Audio(url);
      element.preload = 'auto';
      const source = context.createMediaElementSource(element);
      const gain = context.createGain();
      const high = context.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 75;
      const low = context.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 18000;
      const panner = context.createPanner();
      panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = 1; panner.maxDistance = 1; panner.rolloffFactor = 0;
      const delay = context.createDelay(2.1); delay.delayTime.value = 0.12;
      const reverbSend = context.createGain(); reverbSend.gain.value = 0;
      source.connect(high).connect(low).connect(gain).connect(panner).connect(context.destination);
      panner.connect(reverbSend).connect(delay).connect(this.reverb);
      this.voices.push({ track, audio: element, panner, gain, low, high, delay, reverbSend, source, url });
    }
    this.listener = true;
    return this.voices.length;
  }

  async update(state: ReplayApiState): Promise<void> {
    const ctx = this.context;
    if (!ctx || !this.listener) return;
    const time = state.playback.time;
    const camera = state.render.cameraPosition;
    const rotation = state.render.cameraRotation;
    const playbackSpeed = state.playback.speed > 0 ? state.playback.speed : (state.playback.paused ? 0 : 1);
    const yaw = Number.isFinite(rotation?.y) ? rotation.y * Math.PI / 180 : 0;
    const listener = ctx.listener;
    listener.positionX.setTargetAtTime(camera.x || 0, ctx.currentTime, 0.12);
    listener.positionY.setTargetAtTime(0, ctx.currentTime, 0.12);
    listener.positionZ.setTargetAtTime(camera.z || 0, ctx.currentTime, 0.12);
    listener.forwardX.setTargetAtTime(Math.sin(yaw), ctx.currentTime, 0.12);
    listener.forwardY.setTargetAtTime(0, ctx.currentTime, 0.12);
    listener.forwardZ.setTargetAtTime(-Math.cos(yaw), ctx.currentTime, 0.12);
    listener.upX.setTargetAtTime(0, ctx.currentTime, 0.12); listener.upY.setTargetAtTime(1, ctx.currentTime, 0.12); listener.upZ.setTargetAtTime(0, ctx.currentTime, 0.12);
    for (const voice of this.voices) {
      const { track, audio } = voice;
      const relativeTime = time - track.startedAt;
      const active = relativeTime >= 0 && relativeTime <= track.endedAt - track.startedAt;
      if (!active || state.playback.paused || playbackSpeed === 0) { audio.pause(); continue; }
      const target = Math.max(0, relativeTime);
      if (!Number.isFinite(audio.currentTime) || Math.abs(audio.currentTime - target) > 0.35) {
        try { audio.currentTime = target; } catch { /* wait for metadata */ }
      }
      audio.playbackRate = Math.max(0.25, Math.min(2, playbackSpeed));
      if (audio.paused) void audio.play().catch(() => undefined);
      const pos = interpolate(track.positions, relativeTime);
      if (!pos) { voice.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.15); continue; }
      voice.panner.positionX.setTargetAtTime(pos.x, ctx.currentTime, 0.15);
      voice.panner.positionY.setTargetAtTime(0, ctx.currentTime, 0.15);
      voice.panner.positionZ.setTargetAtTime(pos.y, ctx.currentTime, 0.15);
      const distance = Math.hypot(pos.x - (camera.x || 0), pos.y - (camera.z || 0));
      const level = pos.level;
      const normalRange = voiceRangeForLevel(level);
      const shouting = level >= 0.55;
      const shoutRange = shoutRangeForLevel(level);
      const audibleRange = shouting ? MAX_ECHO_RANGE : normalRange;
      const t = Math.max(0, Math.min(1, (distance - 180) / Math.max(1, audibleRange - 180)));
      const smooth = t * t * (3 - 2 * t);
      voice.gain.gain.setTargetAtTime(1 - smooth, ctx.currentTime, 0.18);
      const muffling = Math.max(0, Math.min(1, (distance - 350) / 3000));
      voice.low.frequency.setTargetAtTime(18000 - muffling * 16000, ctx.currentTime, 0.22);
      voice.high.frequency.setTargetAtTime(75 + muffling * 325, ctx.currentTime, 0.22);
      const reverb = shouting ? echoForDistance(distance, shoutRange) : { mix: 0, delay: 0.12 };
      voice.reverbSend.gain.setTargetAtTime(reverb.mix, ctx.currentTime, 0.22);
      voice.delay.delayTime.setTargetAtTime(reverb.delay, ctx.currentTime, 0.22);
    }
  }

  close(): void {
    for (const voice of this.voices) { voice.audio.pause(); voice.audio.src = ''; URL.revokeObjectURL(voice.url); }
    this.voices = [];
    this.listener = false;
    this.reverb = null; this.reverbOut = null;
    if (this.context) void this.context.close().catch(() => undefined);
    this.context = null;
  }
}

function interpolate(samples: Array<[number, number, number, number]>, time: number): (ReplayPosition & { level: number }) | null {
  if (!samples.length) return null;
  let lo = 0, hi = samples.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (samples[mid][0] <= time) lo = mid + 1; else hi = mid; }
  const a = samples[Math.max(0, lo - 1)];
  const b = samples[Math.min(samples.length - 1, lo)];
  if (time - a[0] > 3) return null;
  const span = b[0] - a[0];
  const t = span > 0 ? Math.max(0, Math.min(1, (time - a[0]) / span)) : 0;
  return { x: a[1] + (b[1] - a[1]) * t, y: a[2] + (b[2] - a[2]) * t, level: a[3] + (b[3] - a[3]) * t };
}

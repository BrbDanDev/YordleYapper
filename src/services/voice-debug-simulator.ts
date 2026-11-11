import { PeerConnection } from './peer-connection';
import { getStoredOutputDeviceId } from './devices';

/** Ranges used by the local voice lab's synthetic proximity response. */
export const BASE_VOICE_RANGE = 2300;
export const QUIET_VOICE_RANGE = 1250;
export const MAX_SHOUT_RANGE = 2600;
export const MAX_ECHO_RANGE = 3600;
export const SHOUT_LEVEL_THRESHOLD = 0.55;
export const MAX_ECHO_DELAY_SECONDS = 2;

interface Position { x: number; y: number }

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function shoutRangeForLevel(level: number): number {
  const levelAboveThreshold = clamp((level - SHOUT_LEVEL_THRESHOLD) / (1 - SHOUT_LEVEL_THRESHOLD), 0, 1);
  return Math.round(BASE_VOICE_RANGE + levelAboveThreshold * (MAX_SHOUT_RANGE - BASE_VOICE_RANGE));
}

export function voiceRangeForLevel(level: number): number {
  if (level >= SHOUT_LEVEL_THRESHOLD) return BASE_VOICE_RANGE;
  return Math.round(QUIET_VOICE_RANGE + clamp(level / SHOUT_LEVEL_THRESHOLD, 0, 1) * (BASE_VOICE_RANGE - QUIET_VOICE_RANGE));
}

export function echoForDistance(distance: number, shoutRange: number): { mix: number; delay: number } {
  if (distance <= shoutRange || distance >= MAX_ECHO_RANGE) return { mix: 0, delay: 0.12 };
  const t = clamp((distance - shoutRange) / (MAX_ECHO_RANGE - shoutRange), 0, 1);
  return { mix: 0.06 + t * 0.48, delay: 0.12 + t * (MAX_ECHO_DELAY_SECONDS - 0.12) };
}

/**
 * One local, two-participant voice test. The recorded/sample talker is sent
 * through a real local WebRTC loopback; the receiving side is the production
 * PeerConnection playback/effects graph used for remote participants.
 */
export class VoiceDebugSimulator {
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private player: { peer: PeerConnection; closeSender: () => void } | null = null;
  private sourceNodes: AudioNode[] = [];
  private oscillators: OscillatorNode[] = [];
  private sampleElement: HTMLAudioElement | null = null;
  private sampleSource: MediaElementAudioSourceNode | null = null;
  private sampleUrl: string | null = null;
  private recordingBlob: Blob | null = null;
  private recordingLoudness = 0;
  private loudness = 0.4;
  private muffling = true;
  private stereo = true;
  private hidden = false;
  private speaker: Position | null = null;
  private listener: Position | null = null;
  private directionListener: Position | null = null;
  private ticker: number | null = null;
  private closing = false;

  get isRunning(): boolean { return this.context !== null; }
  get shoutingRange(): number { return shoutRangeForLevel(this.activeLoudness); }
  get echoRange(): number { return MAX_ECHO_RANGE; }
  get recordingReady(): boolean { return this.recordingBlob !== null; }
  get usesRecording(): boolean { return this.recordingBlob !== null; }
  get activeLoudness(): number { return this.recordingBlob ? this.recordingLoudness : this.loudness; }
  get placedDistance(): number | null { return this.speaker && this.listener ? Math.round(Math.hypot(this.speaker.x - this.listener.x, this.speaker.y - this.listener.y)) : null; }
  get currentShoutingRange(): number { return shoutRangeForLevel(this.activeLoudness); }

  async start(): Promise<void> {
    if (this.context) return;
    const context = new AudioContext();
    this.context = context;
    try {
      if (context.state === 'suspended') await context.resume();
      const destination = context.createMediaStreamDestination();
      this.destination = destination;
      this.sampleElement = new Audio();
      this.sampleElement.loop = true;
      this.sampleElement.preload = 'auto';
      this.sampleSource = context.createMediaElementSource(this.sampleElement);
      this.sampleSource.connect(destination);
      if (this.recordingBlob) this.playRecording();
      else this.startTone();
      this.player = await PeerConnection.createLocalTest('Voice Lab · Second Player', destination.stream);
      await this.player.peer.setOutputDevice(getStoredOutputDeviceId());
      this.ticker = window.setInterval(() => this.update(), 50);
      this.update();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  setLoudness(value: number): void { this.loudness = clamp(value, 0, 1); this.update(); }
  setMuffling(value: boolean): void { this.muffling = value; this.update(); }
  setStereo(value: boolean): void { this.stereo = value; this.update(); }
  setRecording(blob: Blob, loudness: number): void {
    this.recordingBlob = blob;
    this.recordingLoudness = clamp(loudness, 0, 1);
    if (this.context) this.playRecording();
    this.update();
  }
  clearRecording(): void {
    this.recordingBlob = null;
    this.recordingLoudness = 0;
    if (this.context) this.startTone();
    this.update();
  }
  setHidden(value: boolean): void { this.hidden = value; this.update(); }

  /** Select exactly one simulated player's position on the debug map. */
  async placeSpeaker(source: Position, listener: Position, hidden: boolean, directionListener = listener): Promise<number> {
    if (!this.context || !this.player) throw new Error('The second-player WebRTC test is not ready.');
    // Map placement is a user gesture. Retry here for samples captured with
    // the 10-second auto-stop, which may have lost autoplay activation.
    if (this.recordingBlob && this.sampleElement?.paused) {
      void this.sampleElement.play().catch((error) => console.warn('[Voice Lab] Sample playback is still blocked:', error));
    }
    this.speaker = { ...source };
    this.listener = { ...listener };
    this.directionListener = { ...directionListener };
    this.hidden = hidden;
    this.update();
    return this.placedDistance ?? 0;
  }

  /** Keep the simulated peer at its fixed map position while the listener moves. */
  updateListener(listener: Position, directionListener = listener): number | null {
    if (!this.speaker) return null;
    this.listener = { ...listener };
    this.directionListener = { ...directionListener };
    this.update();
    return this.placedDistance;
  }

  async stop(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.ticker !== null) window.clearInterval(this.ticker);
    this.ticker = null;
    const player = this.player;
    this.player = null;
    player?.peer.close();
    player?.closeSender();
    this.sampleElement?.pause();
    this.sampleElement?.removeAttribute('src');
    this.sampleElement?.load();
    this.sampleElement = null;
    this.sampleSource?.disconnect();
    this.sampleSource = null;
    this.stopTone();
    for (const node of this.sourceNodes) { try { node.disconnect(); } catch { /* already disconnected */ } }
    this.sourceNodes = [];
    if (this.sampleUrl) URL.revokeObjectURL(this.sampleUrl);
    this.sampleUrl = null;
    this.destination = null;
    const context = this.context;
    this.context = null;
    this.speaker = null;
    this.listener = null;
    this.directionListener = null;
    if (context) await context.close().catch(() => undefined);
    this.closing = false;
  }

  private startTone(): void {
    if (!this.context || !this.destination || !this.sampleSource) return;
    this.stopTone();
    this.sampleElement?.pause();
    if (this.sampleUrl) URL.revokeObjectURL(this.sampleUrl);
    this.sampleUrl = null;
    const voiceMix = this.context.createGain();
    voiceMix.gain.value = 0.16;
    const oscillator = this.context.createOscillator();
    const harmonic = this.context.createOscillator();
    oscillator.type = 'triangle'; oscillator.frequency.value = 235;
    harmonic.type = 'sawtooth'; harmonic.frequency.value = 470;
    oscillator.connect(voiceMix); harmonic.connect(voiceMix);
    voiceMix.connect(this.destination);
    oscillator.start(); harmonic.start();
    this.oscillators.push(oscillator, harmonic);
    this.sourceNodes.push(voiceMix);
  }

  private stopTone(): void {
    for (const oscillator of this.oscillators) { try { oscillator.stop(); } catch { /* already stopped */ } }
    for (const node of this.sourceNodes) { try { node.disconnect(); } catch { /* already disconnected */ } }
    this.oscillators = [];
    this.sourceNodes = [];
  }

  private playRecording(): void {
    if (!this.sampleElement || !this.sampleSource || !this.context || !this.destination || !this.recordingBlob) return;
    this.stopTone();
    if (this.sampleUrl) URL.revokeObjectURL(this.sampleUrl);
    this.sampleUrl = URL.createObjectURL(this.recordingBlob);
    this.sampleElement.src = this.sampleUrl;
    void this.sampleElement.play().catch((error) => console.warn('[Voice Lab] Sample playback failed:', error));
  }

  /** Derive proximity, level, occlusion and HRTF from the two map positions. */
  private update(): void {
    const context = this.context;
    const player = this.player?.peer;
    const source = this.speaker;
    const listener = this.listener;
    if (!context || !player || !source || !listener) return;
    const dx = source.x - listener.x;
    const dy = source.y - listener.y;
    const distance = Math.hypot(dx, dy);
    const level = this.activeLoudness;
    const shouting = level >= SHOUT_LEVEL_THRESHOLD;
    const shoutRange = shoutRangeForLevel(level);
    const hearLimit = shouting
      ? BASE_VOICE_RANGE + clamp((level - SHOUT_LEVEL_THRESHOLD) / (1 - SHOUT_LEVEL_THRESHOLD), 0, 1) * (MAX_ECHO_RANGE - BASE_VOICE_RANGE)
      : voiceRangeForLevel(level);
    const fullVolumeRange = Math.min(200, hearLimit * (200 / BASE_VOICE_RANGE));
    const fade = clamp((distance - fullVolumeRange) / Math.max(1, hearLimit - fullVolumeRange), 0, 1);
    const volume = distance <= fullVolumeRange ? 1 : distance >= hearLimit ? 0 : (1 - fade) ** 2;
    player.setVolume(volume);
    player.stepVolume(performance.now());

    const hidden = this.muffling && this.hidden;
    const muffling = this.muffling
      ? Math.min(1, clamp((distance - (hidden ? 180 : 450)) / (hidden ? 1120 : 1380), 0, 1) * 0.84 + (hidden ? 0.64 : 0))
      : 0;
    const direction = this.directionListener ?? listener;
    const panDx = source.x - direction.x;
    const panDy = source.y - direction.y;
    const panLength = Math.max(1, Math.hypot(panDx, panDy));
    const echo = shouting ? echoForDistance(distance, shoutRange) : { mix: 0, delay: 0.12 };
    player.setVoiceEffects({
      muffling,
      panX: this.stereo ? clamp(panDx / panLength, -1, 1) : 0,
      panZ: this.stereo ? clamp(-panDy / panLength, -1, 1) : -0.1,
      spatial: this.stereo,
      echoMix: echo.mix,
      echoDelay: echo.delay,
    });
  }
}

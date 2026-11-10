/** One-speaker local sound check for production distance, filters, reverb and HRTF. */
export const BASE_VOICE_RANGE = 2300;
export const QUIET_VOICE_RANGE = 1250;
export const MAX_SHOUT_RANGE = 2600;
export const MAX_ECHO_RANGE = 3600;
export const SHOUT_LEVEL_THRESHOLD = 0.55;
export const MAX_ECHO_DELAY_SECONDS = 2;

interface PlacedVoice {
  sourceNode: AudioNode;
  oscillators: OscillatorNode[];
  extraNodes: AudioNode[];
  mediaElement?: HTMLAudioElement;
  objectUrl?: string;
  high: BiquadFilterNode;
  low: BiquadFilterNode;
  panner: PannerNode;
  dry: GainNode;
  reverb: ConvolverNode;
  wet: GainNode;
  distance: number;
  sourcePosition: { x: number; y: number };
  listenerPosition: { x: number; y: number };
  hidden: boolean;
  panX: number;
  panZ: number;
}

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

function makeRoomImpulse(context: AudioContext): AudioBuffer {
  const length = Math.floor(context.sampleRate * MAX_ECHO_DELAY_SECONDS);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    let seed = 0x51f15e + channel * 7919;
    for (let i = 0; i < length; i++) {
      seed = (seed * 16807) % 2147483647;
      const time = i / context.sampleRate;
      const noise = (seed / 1073741823.5) - 1;
      data[i] = noise * Math.exp(-time * (channel === 0 ? 3 : 3.35)) * (time < 0.12 ? 1 : 0.72) * 0.32;
    }
  }
  return impulse;
}

/** Single speaker. Creating the context is silent; only placing a voice plays sound. */
export class VoiceDebugSimulator {
  private context: AudioContext | null = null;
  private placedVoice: PlacedVoice | null = null;
  private loudness = 0.55;
  private recordingLoudness = 0;
  private muffling = true;
  private stereo = true;
  private recordingBlob: Blob | null = null;

  get isRunning(): boolean { return this.context !== null; }
  get shoutingRange(): number { return shoutRangeForLevel(this.activeLoudness); }
  get echoRange(): number { return MAX_ECHO_RANGE; }
  get recordingReady(): boolean { return this.recordingBlob !== null; }
  get usesRecording(): boolean { return this.recordingBlob !== null; }
  get activeLoudness(): number { return this.recordingBlob ? this.recordingLoudness : this.loudness; }
  get placedDistance(): number | null { return this.placedVoice ? Math.round(this.placedVoice.distance) : null; }
  get currentShoutingRange(): number { return shoutRangeForLevel(this.activeLoudness); }

  async start(): Promise<void> {
    if (this.context) return;
    const ctx = new AudioContext();
    await ctx.resume();
    this.context = ctx;
  }

  setLoudness(value: number): void { this.loudness = clamp(value, 0, 1); this.update(); }
  setMuffling(value: boolean): void { this.muffling = value; this.update(); }
  setStereo(value: boolean): void { this.stereo = value; this.update(); }
  setRecording(blob: Blob, loudness: number): void { this.recordingBlob = blob; this.recordingLoudness = clamp(loudness, 0, 1); this.update(); }
  clearRecording(): void { this.recordingBlob = null; this.recordingLoudness = 0; this.update(); }

  /** Place the one virtual speaker at the clicked map position. */
  placeSpeaker(source: { x: number; y: number }, listener: { x: number; y: number }, hidden: boolean, directionListener = listener): number {
    const ctx = this.context;
    if (!ctx) throw new Error('Audio is not ready. Click the map again to start it.');
    if (this.placedVoice) this.disposeVoice(this.placedVoice);
    const dx = source.x - listener.x;
    const dy = source.y - listener.y;
    const distance = Math.hypot(dx, dy);
    const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 75;
    const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 18000;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse';
    panner.refDistance = 1; panner.maxDistance = 3; panner.rolloffFactor = 0.65;
    const dry = ctx.createGain();
    const reverb = ctx.createConvolver(); reverb.buffer = makeRoomImpulse(ctx);
    const wet = ctx.createGain(); wet.gain.value = 0;
    const send = ctx.createGain(); send.gain.value = 1;
    const mix = ctx.createGain();
    high.connect(low).connect(panner);
    panner.connect(dry).connect(mix);
    panner.connect(send).connect(reverb).connect(wet).connect(mix);
    mix.connect(ctx.destination);

    const panDx = source.x - directionListener.x;
    const panDy = source.y - directionListener.y;
    const panLength = Math.max(1, Math.hypot(panDx, panDy));
    panner.positionX.value = this.stereo ? clamp(panDx / panLength, -1, 1) : 0;
    panner.positionY.value = 0;
    panner.positionZ.value = this.stereo ? clamp(-panDy / panLength, -1, 1) : -0.1;

    let sourceNode: AudioNode;
    const oscillators: OscillatorNode[] = [];
    const extraNodes: AudioNode[] = [];
    let mediaElement: HTMLAudioElement | undefined;
    let objectUrl: string | undefined;
    if (this.recordingBlob) {
      objectUrl = URL.createObjectURL(this.recordingBlob);
      mediaElement = new Audio(objectUrl);
      mediaElement.loop = true;
      mediaElement.preload = 'auto';
      sourceNode = ctx.createMediaElementSource(mediaElement);
      sourceNode.connect(high);
    } else {
      const oscillator = ctx.createOscillator(); oscillator.type = 'triangle'; oscillator.frequency.value = 235;
      const harmonic = ctx.createOscillator(); harmonic.type = 'sawtooth'; harmonic.frequency.value = 470;
      const voiceMix = ctx.createGain(); voiceMix.gain.value = 0.16;
      oscillator.connect(voiceMix); harmonic.connect(voiceMix); voiceMix.connect(high);
      oscillator.start(); harmonic.start();
      extraNodes.push(voiceMix);
      sourceNode = oscillator;
      oscillators.push(oscillator, harmonic);
    }

    const voice: PlacedVoice = {
      sourceNode, oscillators, extraNodes, mediaElement, objectUrl, high, low, panner, dry, reverb, wet,
      distance, sourcePosition: { ...source }, listenerPosition: { ...listener }, hidden,
      panX: panDx / panLength, panZ: -panDy / panLength,
    };
    this.placedVoice = voice;
    this.update();
    if (mediaElement) void mediaElement.play().catch((error) => console.warn('[Voice Lab] Sample playback failed:', error));
    return Math.round(distance);
  }

  /** Move the listener while the map-placed speaker stays fixed in world space. */
  updateListener(listener: { x: number; y: number }, directionListener = listener): number | null {
    const voice = this.placedVoice;
    const ctx = this.context;
    if (!voice || !ctx) return null;
    const dx = voice.sourcePosition.x - listener.x;
    const dy = voice.sourcePosition.y - listener.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    voice.listenerPosition = { ...listener };
    voice.distance = length;
    const panDx = voice.sourcePosition.x - directionListener.x;
    const panDy = voice.sourcePosition.y - directionListener.y;
    const panLength = Math.max(1, Math.hypot(panDx, panDy));
    voice.panX = panDx / panLength;
    voice.panZ = -panDy / panLength;
    const now = ctx.currentTime;
    voice.panner.positionX.setTargetAtTime(this.stereo ? clamp(voice.panX, -1, 1) : 0, now, 0.12);
    voice.panner.positionY.setTargetAtTime(0, now, 0.12);
    voice.panner.positionZ.setTargetAtTime(this.stereo ? clamp(voice.panZ, -1, 1) : -0.1, now, 0.12);
    this.update();
    return Math.round(length);
  }

  async stop(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    if (this.placedVoice) this.disposeVoice(this.placedVoice);
    this.placedVoice = null;
    if (ctx) await ctx.close().catch(() => undefined);
  }

  private update(): void {
    const voice = this.placedVoice;
    const ctx = this.context;
    if (!voice || !ctx) return;
    const now = ctx.currentTime;
    const activeLoudness = this.activeLoudness;
    const shoutRange = shoutRangeForLevel(activeLoudness);
    const voicedShouting = activeLoudness >= SHOUT_LEVEL_THRESHOLD;
    const shoutProgress = clamp((activeLoudness - SHOUT_LEVEL_THRESHOLD) / (1 - SHOUT_LEVEL_THRESHOLD), 0, 1);
    const hearLimit = voicedShouting
      ? BASE_VOICE_RANGE + shoutProgress * (MAX_ECHO_RANGE - BASE_VOICE_RANGE)
      : voiceRangeForLevel(activeLoudness);
    const fullVolumeRange = Math.min(200, hearLimit * (200 / BASE_VOICE_RANGE));
    const t = clamp((voice.distance - fullVolumeRange) / Math.max(1, hearLimit - fullVolumeRange), 0, 1);
    const volume = voice.distance <= fullVolumeRange ? 1 : (voice.distance >= hearLimit ? 0 : (1 - t) ** 2);
    const mufflingStart = voice.hidden ? 250 : 700;
    const distanceMuffling = clamp((voice.distance - mufflingStart) / Math.max(1, hearLimit - mufflingStart), 0, 1) * 0.75;
    const muffling = this.muffling ? Math.min(1, distanceMuffling + (voice.hidden ? 0.55 : 0)) : 0;
    const echo = voicedShouting ? echoForDistance(voice.distance, shoutRange) : { mix: 0, delay: 0.12 };
    voice.high.frequency.setTargetAtTime(75 + muffling * 115, now, 0.3);
    voice.low.frequency.setTargetAtTime(18000 - muffling * 16350, now, 0.3);
    voice.dry.gain.setTargetAtTime(volume * (echo.mix > 0 ? 0.78 : 1), now, 0.3);
    voice.wet.gain.setTargetAtTime(echo.mix, now, 0.35);
    // The IR provides a diffuse two-second room tail; only its send level
    // changes with range, avoiding a discrete delayed-repeat sound.
  }

  private disposeVoice(voice: PlacedVoice): void {
    voice.mediaElement?.pause();
    if (voice.objectUrl) URL.revokeObjectURL(voice.objectUrl);
    for (const oscillator of voice.oscillators) { try { oscillator.stop(); } catch { /* already stopped */ } }
    for (const node of voice.extraNodes) { try { node.disconnect(); } catch { /* already disconnected */ } }
    for (const node of [voice.sourceNode, voice.high, voice.low, voice.panner, voice.dry, voice.reverb, voice.wet]) {
      try { node.disconnect(); } catch { /* already disconnected */ }
    }
  }
}

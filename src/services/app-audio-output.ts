// "App audio" (Settings → "App audio (OBS)"): the peers' voices played by
// lolproxchat.exe itself instead of by WebView2.
//
// WebView2 plays everything from a separate msedgewebview2.exe audio process,
// which OBS's Application Audio Capture cannot pick up. With this on, each
// peer's voice goes into a Web Audio graph that outputs to no device
// (sinkId 'none'); a worklet cuts the mix into 10 ms chunks of mono f32, and
// they go to Rust (audio_out.rs), which plays them on the chosen device.
//
// Chromium only pulls a remote WebRTC track while a media element plays it, so
// each peer's <audio> element keeps playing — MUTED, which (measured with the
// Windows session meters, 2026-10-14) outputs nothing. A muted element is also
// never blocked by the autoplay policy. Peer volume is applied by a GainNode
// per peer here instead of element.volume.
//
// Echo: the browser's echo canceller only knows what the browser plays, which
// is now nothing, so with SPEAKERS the others may hear themselves back. Hence
// off by default, meant for streamers on headphones.

import { invoke } from '@tauri-apps/api/core';

/** One peer's way into the mix. */
export interface AppTap {
  setGain(value: number, reverbTail?: boolean): void;
  setVoiceEffects(options: { muffling: number; panX: number; panZ: number; spatial: boolean; echoMix?: number; echoDelay?: number; chaosHighpass?: number; chaosBandpass?: number }): void;
  disconnect(reverbTailMs?: number): void;
}

interface TapState {
  stream: MediaStream;
  gain: number;
  muffling: number;
  panX: number;
  panZ: number;
  spatial: boolean;
  echoMix: number;
  echoDelay: number;
  chaosHighpass: number;
  chaosBandpass: number;
  nodes: { src: MediaStreamAudioSourceNode; hi: BiquadFilterNode; lo: BiquadFilterNode; pan: PannerNode; g: GainNode; wet: GainNode; reverb: ConvolverNode; send: GainNode; mix: GainNode } | null;
}

interface OutStatus {
  running: boolean;
  device: string | null;
  sampleRate: number;
  bufferedMs: number;
  underruns: number;
  dropped: number;
  error: string | null;
}

export interface OutDevices {
  devices: string[];
  default: string | null;
}

/** Chunks per second sent to Rust (10 ms each). */
const CHUNKS_PER_SEC = 100;
/** Consecutive failed sends after which app audio gives up. */
const MAX_SEND_FAILURES = 50;
/** How often the Rust side is checked (device lost, rate changed). */
const STATUS_POLL_MS = 2000;

function makeRoomImpulse(context: AudioContext): AudioBuffer {
  const length = Math.floor(context.sampleRate * 2);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    let seed = 0x51f15e + channel * 7919;
    for (let i = 0; i < length; i++) {
      seed = (seed * 16807) % 2147483647;
      const noise = (seed / 1073741823.5) - 1;
      const time = i / context.sampleRate;
      data[i] = noise * Math.exp(-time * (channel === 0 ? 3.0 : 3.35)) * (time < 0.12 ? 1 : 0.72) * 0.32;
    }
  }
  return impulse;
}

// Collects the mono mix into chunks and hands them to the page.
const WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.n = options.processorOptions.chunk;
    this.buf = new Float32Array(this.n * 2);
    this.i = 0;
  }
  process(inputs) {
    const channels = inputs[0] || [];
    const len = channels[0] ? channels[0].length : 128;
    for (let k = 0; k < len; k++) {
      this.buf[this.i * 2] = channels[0] ? channels[0][k] : 0;
      this.buf[this.i * 2 + 1] = channels[1] ? channels[1][k] : (channels[0] ? channels[0][k] : 0);
      this.i++;
      if (this.i === this.n) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.n);
        this.i = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

export function listAppOutputDevices(): Promise<OutDevices> {
  return invoke<OutDevices>('audio_out_devices');
}

export class AppAudioOutput {
  private ctx: AudioContext | null = null;
  private mixer: GainNode | null = null;
  private tapNode: AudioWorkletNode | null = null;
  private taps = new Set<TapState>();
  private sendFailures = 0;
  private statusTimer: number | null = null;
  private stopped = false;

  /** `onFailed`: called once if app audio stops working for good; the caller
   *  goes back to playing in the browser. */
  constructor(private readonly onFailed: (reason: string) => void) {}

  /** Opens `device` (null: the Windows default). False when it could not. */
  async start(device: string | null): Promise<boolean> {
    try {
      const st = await invoke<OutStatus>('audio_out_start', { device });
      await this.buildGraph(st.sampleRate);
      console.log('[AppAudio] Voices play from lolproxchat.exe on "' + st.device + '" at ' + st.sampleRate + ' Hz');
      this.statusTimer = window.setInterval(() => { void this.checkStatus(); }, STATUS_POLL_MS) as unknown as number;
      return true;
    } catch (e) {
      console.warn('[AppAudio] Could not start, voices stay in the browser:', e);
      await this.teardown();
      return false;
    }
  }

  /** Switches device; the graph is rebuilt if the new one runs at another rate. */
  async setDevice(device: string | null): Promise<void> {
    if (this.stopped) return;
    try {
      const st = await invoke<OutStatus>('audio_out_start', { device });
      if (this.ctx && st.sampleRate !== this.ctx.sampleRate) await this.buildGraph(st.sampleRate);
      console.log('[AppAudio] Output now "' + st.device + '" at ' + st.sampleRate + ' Hz');
    } catch (e) {
      this.fail('device switch failed: ' + e);
    }
  }

  /** A peer's voice into the mix, silent until setGain. Works for a stream
   *  that already has its audio track. */
  attach(stream: MediaStream): AppTap {
    const tap: TapState = { stream, gain: 0, muffling: 0, panX: 0, panZ: -0.1, spatial: true, echoMix: 0, echoDelay: 0.12, chaosHighpass: 0, chaosBandpass: 0, nodes: null };
    this.taps.add(tap);
    this.connectTap(tap);
    return {
      setGain: (value: number, reverbTail = false) => {
        tap.gain = value;
        if (tap.nodes && this.ctx) {
          const now = this.ctx.currentTime;
          tap.nodes.g.gain.setTargetAtTime(value * (1 - tap.echoMix * 0.25), now, 0.02);
          tap.nodes.wet.gain.setTargetAtTime(reverbTail ? Math.max(tap.echoMix * 0.72, 0.28) : value * tap.echoMix * 0.72, now, 0.02);
          if (reverbTail) window.setTimeout(() => {
            if (tap.nodes && this.ctx) tap.nodes.wet.gain.setTargetAtTime(tap.gain * tap.echoMix * 0.72, this.ctx.currentTime, 0.12);
          }, 2200);
        }
      },
      setVoiceEffects: (options) => {
        tap.muffling = options.muffling; tap.panX = options.panX; tap.panZ = options.panZ; tap.spatial = options.spatial;
        tap.echoMix = Math.max(0, Math.min(0.54, options.echoMix ?? 0));
        tap.echoDelay = Math.max(0.12, Math.min(2, options.echoDelay ?? 0.12));
        tap.chaosHighpass = options.chaosHighpass ?? 0;
        tap.chaosBandpass = options.chaosBandpass ?? 0;
        this.applyTapEffects(tap);
      },
      disconnect: (reverbTailMs = 0) => {
        const nodes = tap.nodes;
        if (!nodes) return;
        nodes.src.disconnect();
        if (reverbTailMs > 0 && this.ctx) {
          const now = this.ctx.currentTime;
          nodes.g.gain.setTargetAtTime(0, now, 0.025);
          nodes.wet.gain.setTargetAtTime(Math.max(nodes.wet.gain.value, 0.28), now, 0.04);
          window.setTimeout(() => { this.disposeTap(tap); this.taps.delete(tap); }, reverbTailMs);
        } else { this.disposeTap(tap); this.taps.delete(tap); }
      },
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.teardown();
    await invoke('audio_out_stop').catch(() => { /* already gone */ });
  }

  // ---- internals ----

  private disposeTap(tap: TapState): void {
    const nodes = tap.nodes;
    if (!nodes) return;
    nodes.src.disconnect(); nodes.hi.disconnect(); nodes.lo.disconnect(); nodes.pan.disconnect();
    nodes.g.disconnect(); nodes.wet.disconnect(); nodes.reverb.disconnect(); nodes.send.disconnect(); nodes.mix.disconnect();
    tap.nodes = null;
  }

  private connectTap(tap: TapState): void {
    if (!this.ctx || !this.mixer || tap.stream.getAudioTracks().length === 0) return;
    const src = this.ctx.createMediaStreamSource(tap.stream);
    const hi = this.ctx.createBiquadFilter(); hi.type = 'highpass'; hi.frequency.value = 75;
    const lo = this.ctx.createBiquadFilter(); lo.type = 'lowpass'; lo.frequency.value = 18000;
    const pan = this.ctx.createPanner(); pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 1; pan.maxDistance = 3; pan.rolloffFactor = 0.65;
    const g = this.ctx.createGain();
    const wet = this.ctx.createGain();
    const send = this.ctx.createGain(); send.gain.value = 1;
    const reverb = this.ctx.createConvolver(); reverb.buffer = makeRoomImpulse(this.ctx);
    const mix = this.ctx.createGain();
    g.gain.value = tap.gain * (1 - tap.echoMix * 0.25); wet.gain.value = tap.gain * tap.echoMix * 0.72;
    src.connect(hi).connect(lo).connect(pan);
    pan.connect(g).connect(mix); pan.connect(send).connect(reverb).connect(wet).connect(mix);
    mix.connect(this.mixer);
    tap.nodes = { src, hi, lo, pan, g, wet, reverb, send, mix };
    this.applyTapEffects(tap);
  }

  private applyTapEffects(tap: TapState): void {
    if (!tap.nodes || !this.ctx) return;
    const now = this.ctx.currentTime;
    tap.nodes.lo.frequency.setTargetAtTime(tap.chaosBandpass > 0 ? 3600 : 18000 - tap.muffling * 16350, now, 0.45);
    tap.nodes.hi.frequency.setTargetAtTime(tap.chaosBandpass > 0 ? 650 : 75 + tap.muffling * 115 + Math.max(0, Math.min(1, tap.chaosHighpass / 1000)) * 400, now, 0.45);
    tap.nodes.pan.positionX.setTargetAtTime(tap.spatial ? Math.max(-1, Math.min(1, tap.panX)) : 0, now, 0.12);
    tap.nodes.pan.positionY.setTargetAtTime(0, now, 0.12);
    tap.nodes.pan.positionZ.setTargetAtTime(tap.spatial ? Math.max(-1, Math.min(1, tap.panZ)) : -0.1, now, 0.12);
    tap.nodes.g.gain.setTargetAtTime(tap.gain * (1 - tap.echoMix * 0.25), now, 0.16);
    tap.nodes.wet.gain.setTargetAtTime(tap.gain * tap.echoMix * 0.72, now, 0.2);
  }

  /** (Re)builds the silent mixing graph at `sampleRate`, the device's. */
  private async buildGraph(sampleRate: number): Promise<void> {
    for (const tap of this.taps) this.disposeTap(tap);
    if (this.ctx) await this.ctx.close().catch(() => undefined);
    // sinkId 'none': processed, never played by the browser.
    const ctx = new AudioContext({ sampleRate, sinkId: { type: 'none' } } as AudioContextOptions);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const mixer = ctx.createGain();
    const tapNode = new AudioWorkletNode(ctx, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { chunk: Math.round(sampleRate / CHUNKS_PER_SEC) },
    });
    tapNode.port.onmessage = (e: MessageEvent<Float32Array>) => this.send(e.data);
    mixer.connect(tapNode);
    // Only so the graph is pulled; this context plays to no device.
    tapNode.connect(ctx.destination);
    this.ctx = ctx;
    this.mixer = mixer;
    this.tapNode = tapNode;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    if (ctx.state === 'suspended') {
      const resume = (): void => { void ctx.resume(); };
      document.addEventListener('click', resume, { once: true });
      document.addEventListener('keydown', resume, { once: true });
      console.warn('[AppAudio] Mix suspended until the next click or key press');
    }
    for (const tap of this.taps) this.connectTap(tap);
  }

  private send(chunk: Float32Array): void {
    if (this.stopped) return;
    invoke('audio_out_push', new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      .then(() => { this.sendFailures = 0; })
      .catch((e) => {
        if (++this.sendFailures === MAX_SEND_FAILURES) this.fail('sending audio failed: ' + e);
      });
  }

  /** Every STATUS_POLL_MS: Rust may have moved to the default device (the
   *  chosen one went away) at another rate, or stopped altogether. */
  private async checkStatus(): Promise<void> {
    if (this.stopped || !this.ctx) return;
    try {
      const st = await invoke<OutStatus>('audio_out_status');
      if (!st.running) {
        this.fail('output stopped: ' + (st.error ?? 'unknown'));
        return;
      }
      if (st.sampleRate !== this.ctx.sampleRate) {
        console.log('[AppAudio] Output moved to "' + st.device + '" at ' + st.sampleRate + ' Hz; rebuilding the mix');
        await this.buildGraph(st.sampleRate);
      }
    } catch (e) {
      this.fail('status check failed: ' + e);
    }
  }

  private fail(reason: string): void {
    if (this.stopped) return;
    console.warn('[AppAudio] Giving up, voices go back to the browser: ' + reason);
    void this.stop();
    this.onFailed(reason);
  }

  private async teardown(): Promise<void> {
    if (this.statusTimer !== null) clearInterval(this.statusTimer);
    this.statusTimer = null;
    if (this.tapNode) this.tapNode.port.onmessage = null;
    for (const tap of this.taps) { tap.nodes?.src.disconnect(); tap.nodes?.g.disconnect(); tap.nodes = null; }
    if (this.ctx) await this.ctx.close().catch(() => undefined);
    this.ctx = null;
    this.mixer = null;
    this.tapNode = null;
  }
}

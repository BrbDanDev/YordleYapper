import type { AppAudioOutput, AppTap } from './app-audio-output';
import { getIceServers } from '../core/config';
import { getForceTurnRelay } from './privacy';

// Time-based EMA on per-peer volume targets. Damps CV-jitter spikes without
// introducing audible ramp delay on normal updates. Three properties:
//   • First call (prev == null) snaps to the new value so new peers don't
//     start playing at 1.0 before the proximity pipeline catches up.
//   • Getting LOUDER is slow. A long gap between updates (a peer re-entering
//     hearing range after being far away) must not snap to a loud value.
//   • Getting QUIETER is fast, and deliberately faster than it used to be.
//     The two directions are not symmetric in what they cost: a slow ramp up
//     protects the listener from a sudden blast, while a slow ramp down just
//     means hearing someone you should no longer hear. Measured on a real
//     session, a peer going out of range took a median 4.9 s to fall silent —
//     the hold window plus a ramp this gentle — which a tester reported as
//     still hearing an enemy about four seconds after panning the camera off
//     them. Falling quiet quickly has no audible downside; there is nothing to
//     startle.
// Exported so tests can verify the math without a real RTCPeerConnection.
// Time constants, in seconds, for the two directions. Falling is quicker for
// the reason above; both are long enough that a step at the smoothing rate
// stays small, which is what keeps the gain change click-free without WebAudio
// ramping.
const RISE_TAU_SEC = 0.30;
const FALL_TAU_SEC = 0.2;

// Ceilings on a single step, whatever the elapsed time says. The exponential
// alone tends to 1 as dt grows, so one long gap — a throttled timer, a paused
// session — would jump straight to the target. That is unacceptable upwards,
// where it means a peer who re-enters range arrives at full volume in one step,
// and merely untidy downwards, where an abrupt drop to silence can click.
const RISE_ALPHA_CAP = 0.3;
const FALL_ALPHA_CAP = 0.4;

export function nextSmoothedVolume(
  prev: number | null,
  target: number,
  nowMs: number,
  lastUpdateMs: number,
): number {
  const clamped = Math.max(0, Math.min(1, target));
  if (prev === null) return clamped;
  const dtSec = Math.max(0, (nowMs - lastUpdateMs) / 1000);
  const falling = clamped < prev;
  const tau = falling ? FALL_TAU_SEC : RISE_TAU_SEC;
  const cap = falling ? FALL_ALPHA_CAP : RISE_ALPHA_CAP;
  const alpha = Math.min(cap, 1 - Math.exp(-dtSec / tau));
  return prev * (1 - alpha) + clamped * alpha;
}

function makeRoomImpulse(context: AudioContext): AudioBuffer {
  const seconds = 2;
  const length = Math.floor(context.sampleRate * seconds);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    let seed = 0x51f15e + channel * 7919;
    for (let i = 0; i < length; i++) {
      seed = (seed * 16807) % 2147483647;
      const noise = (seed / 1073741823.5) - 1;
      const time = i / context.sampleRate;
      const decay = Math.exp(-time * (channel === 0 ? 2.2 : 2.45));
      const early = time < 0.12 ? 1.0 : 0.72;
      data[i] = noise * decay * early * 0.42;
    }
  }
  return impulse;
}


/**
 * Render an ICE candidate as `type addr:port proto` for diagnostic logs.
 * Parses the SDP "candidate:..." line because not every browser exposes the
 * convenience getters (.address, .type, etc.) on RTCIceCandidate.
 */
function describeCandidate(c: RTCIceCandidateInit | null): string {
  if (!c) return 'end-of-candidates';
  const cand = c.candidate || '';
  if (!cand) return 'end-of-candidates';
  const parts = cand.split(' ');
  // Format: "candidate:foundation component proto priority addr port typ TYPE ..."
  const proto = parts[2] || '?';
  const addr = parts[4] || '?';
  const port = parts[5] || '?';
  const typeIdx = parts.indexOf('typ');
  const type = typeIdx > 0 ? parts[typeIdx + 1] : '?';
  return `${type} ${addr}:${port} ${proto.toLowerCase()}`;
}

export class PeerConnection {
  private pc: RTCPeerConnection;
  private remoteStream: MediaStream = new MediaStream();
  private audioElement: HTMLAudioElement;
  private processedElement: HTMLAudioElement;
  private effectSource: MediaStreamAudioSourceNode | null = null;
  private effectContext: AudioContext | null = null;
  private effectGain: GainNode | null = null;
  private lowPass: BiquadFilterNode | null = null;
  private highPass: BiquadFilterNode | null = null;
  private panner: PannerNode | null = null;
  private dryGain: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  private reverbGain: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private voiceReverbMix = 0;
  private reverbTailTimer: number | null = null;
  private audioDestination: MediaStreamAudioDestinationNode | null = null;
  private effectsGraphFailed = false;
  // Output device the user picked, and the one actually in effect on the
  // element. Kept apart so applySinkId() can retry without re-setting a sink
  // that already took.
  private desiredSinkId: string | null = null;
  private appliedSinkId: string | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;
  readonly remoteName: string;

  /** Raw inbound voice track, recorded only after every room participant opts in. */
  getReplayStream(): MediaStream { return this.remoteStream; }

  // Playback is element-only: the remote stream plays through `audioElement`,
  // whose .volume carries the proximity gain. An earlier parallel WebAudio
  // gain-node path was removed — the muted element wasn't reliably silent in
  // WebView2, so both played at once, causing echo/double + a muddied level
  // (issues #19 / #21).
  // Default to silent. Volume is supposed to come from the proximity pipeline
  // (applyPeerVolumes → setVolume). If a peer connects before that pipeline
  // has produced a value for them (e.g. during tracking SCANNING state where
  // only allies get a volume), defaulting to 1.0 would play them at full
  // volume regardless of in-game distance — exactly the "hear across the
  // map at startup" bug reported on #6 / #7.
  private targetVolume = 0;
  private muted = false;
  // Outer-loop EMA on volume targets so brief CV tracking glitches don't
  // produce audible dropouts. null = first call (snap to value, no smoothing).
  private smoothedVolume: number | null = null;
  private lastSetVolumeMs = 0;
  // App audio (app-audio-output.ts): while set, the element only pulls the
  // track, always muted, and the voice is heard through `appTap` instead.
  private appOut: AppAudioOutput | null = null;
  private appTap: AppTap | null = null;

  onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  // Fired when ICE has fully failed. The audio layer is responsible for
  // re-issuing an offer (initiator side only) so we don't restart from both
  // ends and race. Capped retry counter lives here to avoid loops.
  onIceFailed: (() => void) | null = null;
  iceRestartAttempts = 0;
  static readonly MAX_ICE_RESTARTS = 2;

  private constructor(
    remoteName: string,
    iceServers: RTCIceServer[],
    iceTransportPolicy: RTCIceTransportPolicy = 'all',
  ) {
    this.remoteName = remoteName;
    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
    if (iceTransportPolicy === 'relay') {
      console.log('[WebRTC] Forcing TURN relay for', remoteName, '— no direct P2P candidates will be used');
    }
    this.audioElement = new Audio();
    this.audioElement.autoplay = true;
    this.audioElement.srcObject = this.remoteStream;
    this.audioElement.muted = true;
    // Start silent; the proximity pipeline (applyPeerVolumes → setVolume) sets
    // the real gain. The element is the sole audible path (see field comment).
    this.audioElement.volume = 0;
    this.processedElement = new Audio();
    this.processedElement.autoplay = true;

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        console.log('[WebRTC] Local ICE → ' + remoteName + ':', describeCandidate(event.candidate.toJSON()));
        this.onIceCandidate(event.candidate);
      } else if (!event.candidate) {
        console.log('[WebRTC] Local ICE gathering complete for ' + remoteName);
      }
    };

    this.pc.ontrack = (event) => {
      console.log('[WebRTC] Got remote track from', remoteName, 'kind:', event.track.kind);
      this.remoteStream.addTrack(event.track);
      // App Audio already owns the filtered/spatialized Web Audio path. Do not
      // build a second per-peer AudioContext that is muted and discarded.
      if (this.appOut) this.attachAppTap();
      else this.attachEffectsGraph();
      // Ensure audio plays (autoplay may be blocked by Chromium policy)
      this.tryPlay();
      // Re-apply the output device now that the element has a live track.
      // Chromium rejects setSinkId with AbortError on an element whose stream
      // is still empty, which is exactly when connectToPeer used to call it —
      // NotOtakuu's 2026-09-12 log shows the failure ~230ms before the track
      // arrived, silently leaving that peer on the default device.
      void this.applySinkId();
    };

    this.pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state with', remoteName, ':', this.pc.connectionState);
      if (this.pc.connectionState === 'connected') {
        // Successful (re)connect — reset the restart budget for any future failure.
        this.iceRestartAttempts = 0;
      }
      if (this.pc.connectionState === 'failed' &&
          this.iceRestartAttempts < PeerConnection.MAX_ICE_RESTARTS) {
        this.iceRestartAttempts++;
        console.warn('[WebRTC] Connection failed with', remoteName,
          '— triggering ICE restart attempt', this.iceRestartAttempts);
        this.onIceFailed?.();
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state with', remoteName, ':', this.pc.iceConnectionState);
    };

    this.startStatsLogging();
  }

  static async create(remoteName: string): Promise<PeerConnection> {
    const iceServers = await getIceServers();
    const policy: RTCIceTransportPolicy = getForceTurnRelay() ? 'relay' : 'all';
    return new PeerConnection(remoteName, iceServers, policy);
  }

  /**
   * Create a local WebRTC loopback that behaves like a second voice-chat
   * participant. The sender is local, but the recorded audio still crosses an
   * actual RTCPeerConnection and enters this class through its normal ontrack,
   * effects, gain, autoplay, and playback path. No signaling server is used.
   */
  static async createLocalTest(remoteName: string, outgoing: MediaStream): Promise<{ peer: PeerConnection; closeSender: () => void }> {
    const peer = new PeerConnection(remoteName, [], 'all');
    const sender = new RTCPeerConnection({ iceServers: [] });
    sender.ontrack = (event) => {
      console.log('[Voice Lab] Loopback received remote test track:', event.track.kind);
      peer.remoteStream.addTrack(event.track);
      if (peer.appOut) peer.attachAppTap();
      else peer.attachEffectsGraph();
      peer.tryPlay();
      void peer.applySinkId();
    };
    try {
      for (const track of outgoing.getAudioTracks()) sender.addTrack(track, outgoing);
      const offer = await sender.createOffer();
      await sender.setLocalDescription(offer);
      await PeerConnection.waitForIceGathering(sender);
      await peer.handleOffer(sender.localDescription!);
      await PeerConnection.waitForIceGathering(peer.pc);
      await sender.setRemoteDescription(peer.pc.localDescription!);
      await new Promise<void>((resolve, reject) => {
        if (sender.connectionState === 'connected') { resolve(); return; }
        const timeout = window.setTimeout(() => reject(new Error('Local WebRTC voice test did not connect.')), 5000);
        const changed = (): void => {
          if (sender.connectionState === 'connected') { window.clearTimeout(timeout); resolve(); }
          else if (sender.connectionState === 'failed') { window.clearTimeout(timeout); reject(new Error('Local WebRTC voice test failed to connect.')); }
        };
        sender.addEventListener('connectionstatechange', changed);
        changed();
      });
      console.log('[Voice Lab] Local second-player WebRTC connection established');
      return { peer, closeSender: () => sender.close() };
    } catch (error) {
      sender.close();
      peer.close();
      throw error;
    }
  }

  private static waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = window.setTimeout(done, 2500);
      function done(): void {
        window.clearTimeout(timeout);
        pc.removeEventListener('icegatheringstatechange', changed);
        resolve();
      }
      function changed(): void { if (pc.iceGatheringState === 'complete') done(); }
      pc.addEventListener('icegatheringstatechange', changed);
    });
  }

  /** Route this peer's audio to the chosen output device via the element sink. */
  async setOutputDevice(deviceId: string | null): Promise<void> {
    this.desiredSinkId = deviceId;
    await this.applySinkId();
  }

  /**
   * Push `desiredSinkId` onto the audio element. Safe to call repeatedly — it's
   * retried from ontrack because setSinkId only reliably succeeds once the
   * element has a track to route.
   */
  private async applySinkId(): Promise<void> {
    const el = (this.effectsGraphFailed ? this.audioElement : this.processedElement) as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof el.setSinkId !== 'function') return;
    // '' is Chromium's "system default device". Picking Default in Settings
    // used to be a no-op here, leaving peers stuck on the previously chosen
    // device until the next session.
    const sink = this.desiredSinkId ?? '';
    if (this.appliedSinkId === sink) return;
    try {
      await el.setSinkId(sink);
      this.appliedSinkId = sink;
    } catch (e) {
      // Not fatal and not necessarily final — ontrack retries once the stream
      // is live. Logged at debug volume so a first-attempt miss isn't alarming.
      console.log('[WebRTC] setSinkId deferred for ' + this.remoteName + ':', e);
    }
  }

  private applyGain(value: number): void {
    const v = Math.max(0, Math.min(1, value));
    if (this.appOut) {
      // App audio: the element stays muted; the voice's level is its tap's.
      this.appTap?.setGain(this.muted ? 0 : v);
      return;
    }
    if (this.effectGain && this.effectContext) {
      this.effectGain.gain.setTargetAtTime(v, this.effectContext.currentTime, 0.025);
    } else if (this.effectsGraphFailed) {
      this.audioElement.volume = v;
    } else {
      this.processedElement.volume = v;
    }
  }

  private attachEffectsGraph(): void {
    if (this.appOut || this.effectContext || this.remoteStream.getAudioTracks().length === 0) return;
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(this.remoteStream);
      const highPass = ctx.createBiquadFilter();
      highPass.type = 'highpass';
      highPass.frequency.value = 75;
      const lowPass = ctx.createBiquadFilter();
      lowPass.type = 'lowpass';
      lowPass.frequency.value = 18000;
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.maxDistance = 3;
      panner.rolloffFactor = 0.65;
      const dry = ctx.createGain();
      const reverbSend = ctx.createGain(); reverbSend.gain.value = 1;
      const reverb = ctx.createConvolver(); reverb.buffer = makeRoomImpulse(ctx);
      const reverbGain = ctx.createGain(); reverbGain.gain.value = 0;
      const mix = ctx.createGain();
      const gain = ctx.createGain(); gain.gain.value = this.smoothedVolume ?? this.targetVolume;
      const destination = ctx.createMediaStreamDestination();
      source.connect(highPass).connect(gain).connect(lowPass).connect(panner);
      panner.connect(dry).connect(mix);
      panner.connect(reverbSend).connect(reverb).connect(reverbGain).connect(mix);
      mix.connect(destination);
      this.processedElement.srcObject = destination.stream;
      this.effectContext = ctx;
      this.effectSource = source;
      this.highPass = highPass;
      this.lowPass = lowPass;
      this.panner = panner;
      this.dryGain = dry;
      this.reverbSend = reverbSend;
      this.reverbGain = reverbGain;
      this.reverb = reverb;
      this.effectGain = gain;
      this.audioDestination = destination;
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => undefined);
        const resume = (): void => {
          void ctx.resume().then(() => this.processedElement.play()).catch(() => undefined);
          document.removeEventListener('click', resume);
          document.removeEventListener('keydown', resume);
        };
        document.addEventListener('click', resume, { once: true });
        document.addEventListener('keydown', resume, { once: true });
      }
    } catch (e) {
      console.warn('[Audio] Voice effects unavailable for ' + this.remoteName + ':', e);
      this.effectsGraphFailed = true;
      this.audioElement.muted = false;
      this.audioElement.volume = this.smoothedVolume ?? this.targetVolume;
    }
  }

  /** Apply smooth vocal occlusion and moving HRTF position. */
  setVoiceEffects(options: { muffling: number; panX?: number; panZ?: number; spatial: boolean; echoMix?: number; echoDelay?: number; chaosHighpass?: number; chaosBandpass?: number; chaosPitch?: number }): void {
    const playbackRate = Math.max(0.75, Math.min(1.5, options.chaosPitch ?? 1));
    this.audioElement.playbackRate = playbackRate;
    this.processedElement.playbackRate = playbackRate;
    const panX = Math.max(-1, Math.min(1, options.panX ?? 0));
    const panZ = Math.max(-1, Math.min(1, options.panZ ?? -0.1));
    if (this.effectContext && this.lowPass && this.highPass && this.panner) {
      const now = this.effectContext.currentTime;
      const muffling = Math.max(0, Math.min(1, options.muffling));
      const chaosHighpass = Math.max(0, Math.min(1, (options.chaosHighpass ?? 0) / 1000));
      const chaosBandpass = Math.max(0, Math.min(1, options.chaosBandpass ?? 0));
      const lowTarget = chaosBandpass > 0 ? 3600 : 18000 - muffling * 16350;
      const highTarget = chaosBandpass > 0 ? 650 : 75 + muffling * 115 + chaosHighpass * 400;
      this.lowPass.frequency.setTargetAtTime(lowTarget, now, 0.62);
      this.highPass.frequency.setTargetAtTime(highTarget, now, 0.62);
      this.panner.positionX.setTargetAtTime(options.spatial ? panX : 0, now, 0.12);
      this.panner.positionY.setTargetAtTime(0, now, 0.12);
      this.panner.positionZ.setTargetAtTime(options.spatial ? panZ : -0.1, now, 0.12);
      const mix = Math.max(0, Math.min(0.8, options.echoMix ?? 0));
      this.voiceReverbMix = mix * 0.9;
      this.dryGain?.gain.setTargetAtTime(1 - mix * 0.18, now, 0.32);
      if (this.reverbTailTimer === null) this.reverbGain?.gain.setTargetAtTime(this.voiceReverbMix, now, 0.38);
    }
    this.appTap?.setVoiceEffects({ muffling: options.muffling, panX, panZ, spatial: options.spatial, echoMix: options.echoMix, echoDelay: options.echoDelay, chaosHighpass: options.chaosHighpass, chaosBandpass: options.chaosBandpass });
  }

  /**
   * Play this voice through lolproxchat.exe (app audio) instead of the browser, or
   * back through the browser with null. The element keeps playing either way —
   * Chromium only delivers a remote track's audio while an element plays it —
   * but muted while app audio has the voice.
   */
  setAppOutput(out: AppAudioOutput | null): void {
    if (out === this.appOut) return;
    this.appTap?.disconnect();
    this.appTap = null;
    this.appOut = out;
    if (out) {
      this.disposeEffectsGraph();
      this.attachAppTap();
    }
    else this.attachEffectsGraph();
    this.processedElement.muted = !!out || this.muted;
    this.audioElement.muted = !!out || !this.effectsGraphFailed || this.muted;
    this.applyGain(this.smoothedVolume ?? this.targetVolume);
    if (!out) void this.applySinkId();
  }

  private attachAppTap(): void {
    if (!this.appOut || this.appTap || this.remoteStream.getAudioTracks().length === 0) return;
    this.appTap = this.appOut.attach(this.remoteStream);
    this.appTap.setGain(this.muted ? 0 : (this.smoothedVolume ?? this.targetVolume));
  }

  /**
   * Every peer in every log of the 2026-10-07 test hit an AbortError on its
   * first play(), and the gesture retry below waits for a click on the panel,
   * which nobody makes mid-game. So whenever this peer should be audible and
   * the element is not playing, ask again — from the volume ticker, which runs
   * whether or not the volume is changing (an ally sits at 1.0 all game).
   */
  private ensurePlaying(nowMs: number): void {
    // App Audio routes through the native mixer, but Chromium still needs the
    // muted source element playing to keep pulling the WebRTC remote track.
    const output = this.appOut || this.effectsGraphFailed ? this.audioElement : this.processedElement;
    if (this.muted || !this.targetVolume || !output.paused) return;
    if (this.remoteStream.getAudioTracks().length === 0) return;
    if (nowMs - this.lastPlayRetryAt < PeerConnection.PLAY_RETRY_MS) return;
    this.lastPlayRetryAt = nowMs;
    Promise.resolve()
      .then(() => output.play())
      .then(() => console.log('[WebRTC] Playback started for', this.remoteName))
      .catch(() => { /* the next tick retries */ });
  }

  private lastPlayRetryAt = -Infinity;
  static readonly PLAY_RETRY_MS = 2000;

  private tryPlay(): void {
    this.audioElement.play().catch(() => undefined);
    const output = this.effectsGraphFailed ? this.audioElement : this.processedElement;
    output.play().catch((err) => {
      // Autoplay blocked by browser policy — retry on next user gesture.
      // Log explicitly so a user reporting "voice doesn't work" with Debug on
      // can be told to click anywhere in the overlay to unblock playback.
      console.warn('[WebRTC] Autoplay blocked for', this.remoteName,
        '— will retry on next user gesture:', err?.name || err);
      const resume = () => {
        output.play().catch((retryErr) => {
          console.warn('[WebRTC] Autoplay retry still blocked for', this.remoteName, ':',
            retryErr?.name || retryErr);
        });
        document.removeEventListener('click', resume);
        document.removeEventListener('keydown', resume);
      };
      document.addEventListener('click', resume, { once: true });
      document.addEventListener('keydown', resume, { once: true });
    });
  }

  addLocalStream(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      this.pc.addTrack(track, stream);
    }
  }

  async createOffer(options?: { iceRestart?: boolean }): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer(options);
    offer.sdp = this.enhanceOpusSdp(offer.sdp || '');
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    answer.sdp = this.enhanceOpusSdp(answer.sdp || '');
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /**
   * Modify SDP to set Opus bitrate to 128kbps and disable DTX.
   * DTX (Discontinuous Transmission) stops sending packets during silence
   * to save bandwidth, but the ramp out of silence-mode at speech onset
   * clips the first packet or two — audible as missing word starts. The
   * bandwidth cost of always-on transmission is trivial for voice.
   */
  private enhanceOpusSdp(sdp: string): string {
    return sdp.replace(
      /a=fmtp:111 (.*)/g,
      (match, params) => {
        let enhanced = params;
        if (!enhanced.includes('maxaveragebitrate')) {
          enhanced += ';maxaveragebitrate=128000';
        }
        // Explicitly disable DTX so word starts/ends aren't clipped.
        if (!enhanced.includes('usedtx')) {
          enhanced += ';usedtx=0';
        }
        return 'a=fmtp:111 ' + enhanced;
      }
    );
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    console.log('[WebRTC] Remote ICE ← ' + this.remoteName + ':', describeCandidate(candidate));
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  private async flushPendingCandidates(): Promise<void> {
    for (const c of this.pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(c));
    }
    this.pendingCandidates = [];
  }

  /**
   * Where this peer's gain should end up. Only records the target — the glide
   * towards it is driven by stepVolume on a local timer.
   *
   * These used to be the same call, one EMA step per setVolume, which tied the
   * fade rate to how often the proximity loop ran. That loop awaits a round
   * trip to the signaling server, so on a real connection it ticks nearer 6 Hz
   * than the 10 it is written for, and a peer going out of range took several
   * seconds to fall quiet instead of well under one.
   */
  setVolume(volume: number): void {
    const wasAudible = this.targetVolume > 0;
    this.targetVolume = Math.max(0, Math.min(1, volume));
    if (wasAudible && this.targetVolume === 0) this.ringOutReverb();
    if (this.smoothedVolume === null) {
      // First value for this peer snaps, so a new peer does not audibly ramp
      // up from silence to wherever they actually are.
      this.smoothedVolume = this.targetVolume;
      this.lastSetVolumeMs = performance.now();
      if (!this.muted) this.applyGain(this.smoothedVolume);
    }
  }

  private ringOutReverb(): void {
    this.appTap?.setGain(0, true);
    const now = this.effectContext?.currentTime;
    if (now === undefined || !this.reverbGain) return;
    this.reverbGain.gain.setTargetAtTime(Math.max(this.voiceReverbMix, 0.28), now, 0.025);
    if (this.reverbTailTimer !== null) window.clearTimeout(this.reverbTailTimer);
    this.reverbTailTimer = window.setTimeout(() => {
      this.reverbTailTimer = null;
      if (this.effectContext && this.reverbGain) this.reverbGain.gain.setTargetAtTime(this.voiceReverbMix, this.effectContext.currentTime, 0.12);
    }, 2200);
  }

  /** One smoothing step towards the target. Driven by AudioService's ticker. */
  stepVolume(nowMs: number): void {
    if (this.smoothedVolume === null) return;
    this.ensurePlaying(nowMs);
    if (this.smoothedVolume === this.targetVolume) {
      this.lastSetVolumeMs = nowMs;
      return;
    }
    this.smoothedVolume = nextSmoothedVolume(
      this.smoothedVolume, this.targetVolume, nowMs, this.lastSetVolumeMs,
    );
    this.lastSetVolumeMs = nowMs;
    // Settle exactly rather than approaching forever, so a peer that should be
    // silent reaches zero instead of an inaudible-but-nonzero gain.
    if (Math.abs(this.smoothedVolume - this.targetVolume) < 0.005) {
      this.smoothedVolume = this.targetVolume;
    }
    if (!this.muted) this.applyGain(this.smoothedVolume);
  }

  /**
   * How loud this peer's voice is arriving right now, 0..1 — WebRTC's own
   * per-packet level (1.0 = 0 dBov), read before our volume is applied. 0
   * before any audio has arrived. Drives the "who is speaking" overlay.
   */
  getAudioLevel(): number {
    let level = 0;
    const now = performance.now();
    for (const r of this.pc.getReceivers()) {
      if (r.track?.kind !== 'audio' || typeof r.getSynchronizationSources !== 'function') continue;
      for (const s of r.getSynchronizationSources()) {
        // Synchronization sources retain their last packet sample briefly;
        // do not let an old non-zero sample keep the overlay stuck on.
        if (!Number.isFinite(s.timestamp) || now - s.timestamp > 350 || now < s.timestamp) continue;
        level = Math.max(level, s.audioLevel ?? 0);
      }
    }
    return level;
  }

  /** Current (smoothed) output gain, for indicators that should reflect audible speech. */
  getAudibleGain(): number {
    if (this.muted) return 0;
    return Math.max(0, Math.min(1, this.smoothedVolume ?? this.targetVolume));
  }

  mute(): void {
    this.muted = true;
    this.audioElement.muted = true;
    this.processedElement.muted = true;
    this.appTap?.setGain(0);
  }

  unmute(): void {
    this.muted = false;
    // Under app audio the element stays muted: it only pulls the track.
    this.processedElement.muted = !!this.appOut;
    this.audioElement.muted = !!this.appOut || !this.effectsGraphFailed;
    // Resume at where the glide has actually reached, not at the target it is
    // still travelling towards — otherwise unmuting jumps the gain.
    this.applyGain(this.smoothedVolume ?? this.targetVolume);
  }

  close(): void {
    if (this.statsIntervalId !== null) {
      clearInterval(this.statsIntervalId);
      this.statsIntervalId = null;
    }
    const reverbTailMs = this.muted ? 0 : 2200;
    if (reverbTailMs > 0) this.ringOutReverb();
    this.appTap?.disconnect(reverbTailMs);
    this.appTap = null;
    this.remoteStream.getTracks().forEach((t) => t.stop());
    this.pc.close();
    this.audioElement.pause();
    this.audioElement.srcObject = null;
    const finish = (): void => this.disposeEffectsGraph();
    if (reverbTailMs > 0) window.setTimeout(finish, reverbTailMs);
    else finish();
  }

  /** Release the filtered path when App Audio takes over, or when this peer closes. */
  private disposeEffectsGraph(): void {
    if (this.reverbTailTimer !== null) window.clearTimeout(this.reverbTailTimer);
    this.reverbTailTimer = null;
    this.effectSource?.disconnect();
    this.highPass?.disconnect();
    this.effectGain?.disconnect();
    this.lowPass?.disconnect();
    this.panner?.disconnect();
    this.dryGain?.disconnect();
    this.reverbSend?.disconnect();
    this.reverb?.disconnect();
    this.reverbGain?.disconnect();
    this.processedElement.pause();
    this.processedElement.srcObject = null;
    this.audioDestination?.stream.getTracks().forEach((track) => track.stop());
    const context = this.effectContext;
    this.effectContext = null;
    void context?.close().catch(() => undefined);
    this.effectSource = null;
    this.highPass = null;
    this.effectGain = null;
    this.lowPass = null;
    this.panner = null;
    this.dryGain = null;
    this.reverbSend = null;
    this.reverb = null;
    this.reverbGain = null;
    this.audioDestination = null;
    this.effectsGraphFailed = false;
  }

  // Periodic getStats snapshot — selected candidate pair, RTT, bytes flowing.
  // Logged via the standard console.log path which is gated by Debug toggle.
  // Without these, ICE failures are opaque (we only see "failed" with no
  // context about which pair was tried or what the RTT looked like).
  private statsIntervalId: number | null = null;
  private startStatsLogging(): void {
    this.statsIntervalId = window.setInterval(() => {
      this.logStatsSnapshot().catch(() => { /* non-fatal */ });
    }, 10_000) as unknown as number;
  }

  private async logStatsSnapshot(): Promise<void> {
    const stats = await this.pc.getStats();
    let pair: any = null;
    let outAudio: any = null;
    let inAudio: any = null;
    const byId = new Map<string, any>();
    stats.forEach((r: any) => {
      byId.set(r.id, r);
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      if (r.type === 'outbound-rtp' && r.kind === 'audio') outAudio = r;
      if (r.type === 'inbound-rtp' && r.kind === 'audio') inAudio = r;
    });
    const parts: string[] = [
      'conn=' + this.pc.connectionState,
      'ice=' + this.pc.iceConnectionState,
    ];
    if (pair) {
      const local = byId.get(pair.localCandidateId);
      const remote = byId.get(pair.remoteCandidateId);
      const fmt = (c: any) => c ? `${c.candidateType}:${c.address || c.ip || '?'}:${c.port || '?'}/${c.protocol || '?'}` : '?';
      parts.push('pair=' + fmt(local) + '<->' + fmt(remote));
      if (typeof pair.currentRoundTripTime === 'number') {
        parts.push('rtt=' + Math.round(pair.currentRoundTripTime * 1000) + 'ms');
      }
    } else {
      parts.push('pair=none');
    }
    if (outAudio) parts.push('outBytes=' + outAudio.bytesSent);
    if (inAudio) parts.push('inBytes=' + inAudio.bytesReceived);
    if (inAudio && typeof inAudio.packetsLost === 'number') parts.push('lost=' + inAudio.packetsLost);
    console.log('[WebRTC stats]', this.remoteName, parts.join(' '));
  }
}

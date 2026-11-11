/** Voice range/effect curves shared by Rift mode and old-server fallback. */
export const RIFT_BASE_RANGE = 2300;
export const RIFT_QUIET_RANGE = 1250;
export const RIFT_SHOUT_RANGE = 2600;
export const RIFT_MAX_RANGE = 3600;
export const RIFT_SHOUT_LEVEL = 0.55;
const RIFT_REVERB_LEVEL_MIN = 0.12;
const RIFT_REVERB_LEVEL_MAX = 0.36;
const RIFT_REVERB_SHOUT_MIN = 2300;
const RIFT_REVERB_SHOUT_MAX = 2600;
const RIFT_REVERB_CUTOFF = 3600;
const FULL_VOLUME_RANGE = 200;

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(value: number): number {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
}

export function riftVoiceProfile(level: number): { range: number; shoutRange: number; loudness: number } {
  const voice = clamp(level);
  const shoutProgress = smoothstep((voice - RIFT_SHOUT_LEVEL) / (1 - RIFT_SHOUT_LEVEL));
  const quietProgress = smoothstep(voice / RIFT_SHOUT_LEVEL);
  const range = voice >= RIFT_SHOUT_LEVEL
    ? RIFT_BASE_RANGE + shoutProgress * (RIFT_MAX_RANGE - RIFT_BASE_RANGE)
    : RIFT_QUIET_RANGE + quietProgress * (RIFT_BASE_RANGE - RIFT_QUIET_RANGE);
  const shoutRange = RIFT_BASE_RANGE + shoutProgress * (RIFT_SHOUT_RANGE - RIFT_BASE_RANGE);
  // Reverb builds gradually with vocal energy; ordinary speech stays dry.
  const loudness = smoothstep((voice - 0.35) / 0.55);
  return { range, shoutRange, loudness };
}

/** Smooth range falloff matching Rift scoring, for clients using older servers. */
export function riftVoiceVolume(distance: number, level: number): number {
  const { range } = riftVoiceProfile(level);
  if (!Number.isFinite(distance) || distance >= range) return 0;
  if (distance <= FULL_VOLUME_RANGE) return 1;
  const t = (distance - FULL_VOLUME_RANGE) / (range - FULL_VOLUME_RANGE);
  return 1 - smoothstep(t);
}

/** Previously working receiver-level reverb curve, restored for live voices. */
export function riftShoutReverbMix(distance: number, audioLevel: number): number {
  const strength = clamp((audioLevel - RIFT_REVERB_LEVEL_MIN) / (RIFT_REVERB_LEVEL_MAX - RIFT_REVERB_LEVEL_MIN));
  const shoutRange = RIFT_REVERB_SHOUT_MIN + strength * (RIFT_REVERB_SHOUT_MAX - RIFT_REVERB_SHOUT_MIN);
  if (strength <= 0 || distance <= shoutRange || distance >= RIFT_REVERB_CUTOFF) return 0;
  const beyondShout = clamp((distance - shoutRange) / (RIFT_REVERB_CUTOFF - shoutRange));
  return strength * (0.06 + beyondShout * 0.48);
}

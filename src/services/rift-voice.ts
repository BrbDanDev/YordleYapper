/** Voice range/effect curves shared by Rift mode and old-server fallback. */
export const RIFT_BASE_RANGE = 2300;
export const RIFT_QUIET_RANGE = 1250;
export const RIFT_SHOUT_RANGE = 2600;
export const RIFT_MAX_RANGE = 3600;
export const RIFT_SHOUT_LEVEL = 0.55;
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

/** Reverb is gated by both shout distance and loudness, then fades toward range cap. */
export function riftReverbMix(distance: number, level: number): number {
  const { range, shoutRange, loudness } = riftVoiceProfile(level);
  if (loudness <= 0 || distance <= shoutRange || distance >= range || range <= shoutRange) return 0;
  const progress = clamp((distance - shoutRange) / (range - shoutRange));
  const fadeIn = smoothstep(progress / 0.18);
  const fadeOut = 1 - smoothstep((progress - 0.2) / 0.8);
  return 0.26 * loudness * fadeIn * fadeOut;
}

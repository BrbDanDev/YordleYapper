import { riftShoutReverbMix, riftVoiceProfile, riftVoiceVolume } from '../src/services/rift-voice';

describe('Rift voice curves', () => {
  test('quiet speech has a shorter range and louder speech extends it smoothly', () => {
    const quiet = riftVoiceProfile(0.1);
    const ordinary = riftVoiceProfile(0.55);
    const shout = riftVoiceProfile(1);
    expect(quiet.range).toBeLessThan(ordinary.range);
    expect(shout.range).toBeGreaterThan(ordinary.range);
    expect(riftVoiceProfile(0.549).range).toBeLessThanOrEqual(ordinary.range);
    expect(riftVoiceVolume(quiet.range + 1, 0.1)).toBe(0);
    expect(riftVoiceVolume(quiet.range - 1, 0.1)).toBeGreaterThan(0);
  });

  test('restored receiver-level reverb activates for shouts and scales with distance', () => {
    expect(riftShoutReverbMix(3000, 0.11)).toBe(0);
    expect(riftShoutReverbMix(2599, 1)).toBe(0);
    const near = riftShoutReverbMix(2601, 1);
    const far = riftShoutReverbMix(3500, 1);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
    expect(riftShoutReverbMix(3600, 1)).toBe(0);
  });
});

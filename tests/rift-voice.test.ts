import { riftReverbMix, riftVoiceProfile, riftVoiceVolume } from '../src/services/rift-voice';

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

  test('reverb is dry inside shout range and fades in then back out for loud voices', () => {
    const soft = riftVoiceProfile(0.4);
    const loud = riftVoiceProfile(1);
    expect(riftReverbMix(loud.shoutRange - 1, 1)).toBe(0);
    const near = riftReverbMix(loud.shoutRange + 40, 1);
    const middle = riftReverbMix((loud.shoutRange + loud.range) / 2, 1);
    const far = riftReverbMix(loud.range - 1, 1);
    expect(near).toBeGreaterThan(0);
    expect(middle).toBeGreaterThan(near);
    expect(far).toBeLessThan(middle);
    expect(riftReverbMix(soft.shoutRange + 10, 0.4)).toBe(0);
  });
});

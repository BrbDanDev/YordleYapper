import { PCM_TAP_WORKLET } from '../../src/services/pcm-tap-worklet';

describe('App Audio PCM worklet', () => {
  test('every transferred chunk stays interleaved stereo after the first transfer', () => {
    const chunks: Float32Array[] = [];
    class FakeAudioWorkletProcessor {
      port = { postMessage: (data: Float32Array) => chunks.push(Float32Array.from(data)) };
      constructor(_options: unknown) {}
    }
    let Processor: any;
    const registerProcessor = (_name: string, processor: any): void => { Processor = processor; };
    new Function('AudioWorkletProcessor', 'registerProcessor', PCM_TAP_WORKLET)(FakeAudioWorkletProcessor, registerProcessor);

    const tap = new Processor({ processorOptions: { chunk: 2 } });
    tap.process([[[0.1, 0.2, 0.3, 0.4, 0.5, 0.6], [0.7, 0.8, 0.9, 1.0, 1.1, 1.2]]]);

    expect(chunks).toHaveLength(3);
    expect(chunks.map(chunk => chunk.length)).toEqual([4, 4, 4]);
    [0.3, 0.9, 0.4, 1.0].forEach((sample, i) => expect(chunks[1][i]).toBeCloseTo(sample, 6));
  });
});

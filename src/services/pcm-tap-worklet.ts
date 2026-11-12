/** AudioWorklet code that emits fixed-size interleaved stereo Float32 chunks. */
export const PCM_TAP_WORKLET = `
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
        this.buf = new Float32Array(this.n * 2);
        this.i = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

// Converts Float32 audio to 16-bit PCM in 100ms chunks (16 kHz context) for streaming transcription.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.buf = new Int16Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.size) {
        this.port.postMessage(this.buf.slice().buffer);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);

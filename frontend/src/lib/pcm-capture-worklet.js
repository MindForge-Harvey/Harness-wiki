/* Stream 16 kHz mono PCM16; output stays silent to prevent feedback. */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(9600);
    this.count = 0;
    this.ratio = sampleRate / 16000;
    this.sum = this.weight = 0;
    this.finished = false;
    this.port.onmessage = event => {
      if (event.data.type !== 'flush' || this.finished) return;
      if (this.count) this.sendAudio();
      this.finished = true;
      this.port.postMessage({ type: 'flushed' });
    };
  }
  sendAudio() {
    const pcm = new ArrayBuffer(this.count * 2);
    const view = new DataView(pcm);
    for (let i = 0; i < this.count; i++) view.setInt16(i * 2, this.samples[i], true);
    this.port.postMessage({ type: 'audio', pcm }, [pcm]);
    this.count = 0;
  }
  process(inputs) {
    if (this.finished) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      const value = channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length;
      let remaining = 1;
      // Resample 44.1/48 kHz devices while carrying state across callbacks.
      while (remaining > 1e-7) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += value * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= this.ratio - 1e-7) {
          const sample = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.samples[this.count++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
          if (this.count === this.samples.length) this.sendAudio();
          this.sum = this.weight = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);

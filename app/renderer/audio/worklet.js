/**
 * Собирает звук в куски по 200 мс и отдаёт их в основной поток.
 *
 * Живёт в аудиопотоке, поэтому здесь нельзя ничего тяжёлого: только
 * перевод float32 → int16 и подсчёт громкости для полосок.
 */

const CHUNK_SAMPLES = 3200;   // 200 мс при 16 кГц
const LEVEL_EVERY = 6;        // ~48 мс между отсчётами громкости

class Collector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
    this.peak = 0;
    this.blocks = 0;
    this.chunkPeak = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const sample = channel[i];
      const magnitude = sample < 0 ? -sample : sample;
      if (magnitude > this.peak) this.peak = magnitude;
      if (magnitude > this.chunkPeak) this.chunkPeak = magnitude;

      // Клип на границах: int16 не прощает выхода за диапазон.
      const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
      this.buffer[this.filled++] = Math.round(clamped * 32767);

      if (this.filled === CHUNK_SAMPLES) {
        const copy = this.buffer.slice();
        this.port.postMessage({ type: 'chunk', pcm: copy.buffer, peak: this.chunkPeak }, [copy.buffer]);
        this.filled = 0;
        this.chunkPeak = 0;
      }
    }

    if (++this.blocks >= LEVEL_EVERY) {
      this.port.postMessage({ type: 'level', level: this.peak });
      this.peak = 0;
      this.blocks = 0;
    }
    return true;
  }
}

registerProcessor('pastetalk-collector', Collector);

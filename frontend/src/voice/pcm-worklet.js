const PROCESSOR_NAME = 'flight-fabric-pcm-capture';
const DEFAULT_CHUNK_FRAMES = 2048;
const MIN_CHUNK_FRAMES = 128;
const MAX_CHUNK_FRAMES = 8192;

function boundedChunkFrames(value) {
  const frames = Number(value);
  if (!Number.isInteger(frames)) return DEFAULT_CHUNK_FRAMES;
  return Math.min(MAX_CHUNK_FRAMES, Math.max(MIN_CHUNK_FRAMES, frames));
}

class FlightFabricPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    this.chunkFrames = boundedChunkFrames(options.processorOptions?.chunkFrames);
    this.pending = new Float32Array(this.chunkFrames);
    this.pendingLength = 0;
    this.closed = false;

    this.port.onmessage = (event) => {
      if (event?.data?.type === 'flush') {
        this.flush(true);
        this.closed = true;
        this.port.postMessage({ type: 'flushed' });
      } else if (event?.data?.type === 'cancel') {
        this.pendingLength = 0;
        this.closed = true;
        this.port.postMessage({ type: 'cancelled' });
      }
    };
  }

  emit(frameCount) {
    if (frameCount <= 0) return;
    const samples = new Float32Array(frameCount);
    samples.set(this.pending.subarray(0, frameCount));
    this.pendingLength = 0;
    this.port.postMessage({ type: 'pcm', samples }, [samples.buffer]);
  }

  flush(includePartial) {
    if (includePartial && this.pendingLength > 0) this.emit(this.pendingLength);
    else this.pendingLength = 0;
  }

  process(inputs, outputs) {
    // Chromium requires a connected node. Keep its output silent so the
    // microphone is never played through the user's speakers.
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    if (this.closed) return false;

    const channels = inputs[0] || [];
    const frameCount = channels[0]?.length || 0;
    if (frameCount === 0) return true;

    for (let frame = 0; frame < frameCount; frame += 1) {
      let mixed = 0;
      let contributingChannels = 0;
      for (const channel of channels) {
        if (frame >= channel.length) continue;
        mixed += Number.isFinite(channel[frame]) ? channel[frame] : 0;
        contributingChannels += 1;
      }
      this.pending[this.pendingLength] = contributingChannels > 0
        ? mixed / contributingChannels
        : 0;
      this.pendingLength += 1;
      if (this.pendingLength === this.chunkFrames) this.emit(this.chunkFrames);
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, FlightFabricPcmCaptureProcessor);

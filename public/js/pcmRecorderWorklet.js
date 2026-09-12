/**
 * PCM Recorder AudioWorklet Processor for HUNTED Voice Chat
 *
 * Runs on the audio rendering thread. Accumulates the 128-sample render quanta
 * into fixed-size frames and posts each finished frame to the main thread as
 * soon as it is full, which is what makes live (rather than end-of-message)
 * transmission possible.
 *
 * Messages in:  {type: 'start'} | {type: 'stop'} | {type: 'flush'}
 * Messages out: {type: 'frame', samples: Float32Array} | {type: 'flushed'}
 */

class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = (options && options.processorOptions) || {};

    // Frame size in samples at the AudioContext's native sample rate
    this.frameSize = Math.max(128, opts.frameSize || 1024);
    this.buffer = new Float32Array(this.frameSize);
    this.offset = 0;
    this.capturing = false;

    this.port.onmessage = (event) => {
      const message = event.data;
      if (!message || !message.type) {
        return;
      }

      switch (message.type) {
        case 'start':
          // Drop anything left over from a previous transmission
          this.offset = 0;
          this.capturing = true;
          break;

        case 'stop':
          this.capturing = false;
          this.flush(true);
          break;

        case 'flush':
          this.flush(false);
          break;
      }
    };
  }

  /**
   * Emit whatever partial frame is buffered.
   * Called on stop so the tail of a transmission is not clipped.
   * @param {boolean} final - True when this is the end of a transmission
   */
  flush(final) {
    if (this.offset > 0) {
      const frame = this.buffer.slice(0, this.offset);
      this.offset = 0;
      this.port.postMessage({ type: 'frame', samples: frame, final: !!final }, [frame.buffer]);
    }

    if (final) {
      this.port.postMessage({ type: 'flushed' });
    }
  }

  process(inputs) {
    // Keep the processor alive even while idle so start/stop is instant
    if (!this.capturing) {
      return true;
    }

    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    // Mono: the mic stream is requested with channelCount 1, but be defensive
    const channel = input[0];
    if (!channel || channel.length === 0) {
      return true;
    }

    let read = 0;
    while (read < channel.length) {
      const remaining = Math.min(channel.length - read, this.frameSize - this.offset);

      this.buffer.set(channel.subarray(read, read + remaining), this.offset);
      this.offset += remaining;
      read += remaining;

      if (this.offset === this.frameSize) {
        // Copy out so the accumulation buffer can be reused, then transfer
        const frame = this.buffer.slice(0);
        this.offset = 0;
        this.port.postMessage({ type: 'frame', samples: frame }, [frame.buffer]);
      }
    }

    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);

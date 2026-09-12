/**
 * Shared audio DSP helpers for HUNTED Voice Chat
 *
 * Pure functions and small stateful helpers used by both the capture side
 * (downsampling to the wire rate) and the playback side (upsampling back to the
 * AudioContext rate). Kept dependency-free so they can be unit tested in Node.
 */

(function (root) {
  /**
   * Stateful linear resampler.
   *
   * Keeps the fractional read position and one sample of history between calls
   * so consecutive frames resample seamlessly (no clicks at frame boundaries)
   * and non-integer ratios such as 44100 -> 16000 stay in phase. Works in both
   * directions.
   */
  class LinearResampler {
    /**
     * @param {number} inputRate - Source sample rate in Hz
     * @param {number} outputRate - Destination sample rate in Hz
     */
    constructor(inputRate, outputRate) {
      this.inputRate = inputRate;
      this.outputRate = outputRate;
      this.ratio = inputRate / outputRate;
      this.reset();
    }

    /**
     * Clear the interpolation state. Call between transmissions.
     */
    reset() {
      // Fractional position inside the "extended" frame, where index 0 is the
      // sample carried over from the previous frame and index 1..n are the
      // current frame's samples.
      this.position = 1;
      this.history = 0;
    }

    /**
     * Resample one frame.
     * @param {Float32Array} frame - Input samples at inputRate
     * @returns {Float32Array} Samples at outputRate
     */
    process(frame) {
      const length = frame.length;

      if (length === 0) {
        return new Float32Array(0);
      }

      // Pass through untouched when no rate conversion is needed
      if (this.ratio === 1) {
        this.history = frame[length - 1];
        return frame;
      }

      const capacity = Math.ceil(length / this.ratio) + 2;
      const output = new Float32Array(capacity);

      let position = this.position;
      let count = 0;

      // The extended frame is [history, ...frame], so the last readable
      // position is `length`
      while (position <= length) {
        const index = Math.floor(position);
        const fraction = position - index;

        const a = index === 0 ? this.history : frame[index - 1];
        const b = frame[index];

        output[count++] = a + (b - a) * fraction;
        position += this.ratio;
      }

      // Shift the origin: this frame's last sample becomes index 0 next time
      this.history = frame[length - 1];
      this.position = position - length;

      return output.subarray(0, count);
    }
  }

  /**
   * Accumulates arbitrary-length sample blocks into fixed-size frames.
   * Used by the ScriptProcessorNode fallback path; the AudioWorklet processor
   * carries its own copy because it runs in a separate global scope.
   */
  class FrameAccumulator {
    constructor(frameSize) {
      this.frameSize = frameSize;
      this.buffer = new Float32Array(frameSize);
      this.offset = 0;
    }

    reset() {
      this.offset = 0;
    }

    /**
     * @param {Float32Array} block - Incoming samples
     * @param {Function} onFrame - Called with each complete Float32Array frame
     */
    push(block, onFrame) {
      let read = 0;

      while (read < block.length) {
        const remaining = Math.min(block.length - read, this.frameSize - this.offset);

        this.buffer.set(block.subarray(read, read + remaining), this.offset);
        this.offset += remaining;
        read += remaining;

        if (this.offset === this.frameSize) {
          this.offset = 0;
          onFrame(this.buffer.slice(0));
        }
      }
    }

    /**
     * Emit any partial frame.
     * @param {Function} onFrame - Called with the trailing Float32Array frame
     */
    flush(onFrame) {
      if (this.offset > 0) {
        const frame = this.buffer.slice(0, this.offset);
        this.offset = 0;
        onFrame(frame);
      }
    }
  }

  /**
   * Convert Float32 samples in [-1, 1] to signed 16-bit PCM.
   * @param {Float32Array} samples
   * @returns {Int16Array}
   */
  function floatToInt16(samples) {
    const output = new Int16Array(samples.length);

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
      output[i] = Math.round(clamped * 32767);
    }

    return output;
  }

  /**
   * Convert signed 16-bit PCM to Float32 samples in [-1, 1].
   * @param {Int16Array} samples
   * @returns {Float32Array}
   */
  function int16ToFloat(samples) {
    const output = new Float32Array(samples.length);

    for (let i = 0; i < samples.length; i++) {
      output[i] = samples[i] / 32767;
    }

    return output;
  }

  /**
   * Coerce whatever Socket.IO handed us into an Int16Array view.
   * Binary payloads arrive as ArrayBuffer, Uint8Array or (in Node) Buffer.
   * @param {ArrayBuffer|Uint8Array|Int16Array|ArrayBufferView} data
   * @returns {Int16Array|null} Null when the payload is not usable
   */
  function toInt16Array(data) {
    if (!data) {
      return null;
    }

    if (data instanceof Int16Array) {
      return data;
    }

    let buffer;
    let byteOffset = 0;
    let byteLength = 0;

    if (data instanceof ArrayBuffer) {
      buffer = data;
      byteLength = data.byteLength;
    } else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
      buffer = data.buffer;
      byteOffset = data.byteOffset;
      byteLength = data.byteLength;
    } else {
      return null;
    }

    // Int16Array needs an even byte length and a 2-byte aligned offset;
    // copy when the incoming view does not satisfy that
    if (byteLength < 2) {
      return null;
    }

    const usableLength = byteLength - (byteLength % 2);

    if (byteOffset % 2 !== 0) {
      const copy = new Uint8Array(usableLength);
      copy.set(new Uint8Array(buffer, byteOffset, usableLength));
      return new Int16Array(copy.buffer);
    }

    return new Int16Array(buffer, byteOffset, usableLength / 2);
  }

  const AudioDSP = {
    LinearResampler,
    FrameAccumulator,
    floatToInt16,
    int16ToFloat,
    toInt16Array
  };

  root.AudioDSP = AudioDSP;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AudioDSP;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

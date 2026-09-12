/**
 * Unit tests for the shared voice chat DSP helpers.
 * Run with: npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const { LinearResampler, FrameAccumulator, floatToInt16, int16ToFloat, toInt16Array } = require('../public/js/audioDsp');

/**
 * Generate a sine wave.
 * @param {number} length - Samples
 * @param {number} frequency - Hz
 * @param {number} sampleRate - Hz
 * @returns {Float32Array}
 */
function sine(length, frequency, sampleRate) {
  const out = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    out[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }

  return out;
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;

  chunks.forEach((chunk) => {
    out.set(chunk, offset);
    offset += chunk.length;
  });

  return out;
}

test('LinearResampler downsamples 48k -> 16k at the expected rate', () => {
  const resampler = new LinearResampler(48000, 16000);
  const input = sine(4800, 440, 48000);

  const output = resampler.process(input);

  // 3:1 decimation
  assert.ok(Math.abs(output.length - 1600) <= 1, `expected ~1600 samples, got ${output.length}`);
});

test('LinearResampler upsamples 16k -> 48k at the expected rate', () => {
  const resampler = new LinearResampler(16000, 48000);
  const input = sine(1600, 440, 16000);

  const output = resampler.process(input);

  assert.ok(Math.abs(output.length - 4800) <= 2, `expected ~4800 samples, got ${output.length}`);
});

test('LinearResampler passes audio through unchanged when rates match', () => {
  const resampler = new LinearResampler(16000, 16000);
  const input = sine(320, 440, 16000);

  const output = resampler.process(input);

  assert.deepStrictEqual(Array.from(output), Array.from(input));
});

test('LinearResampler is seamless across frame boundaries (integer ratio)', () => {
  const frameSize = 3840; // 80ms at 48 kHz
  const frames = 10;
  const signal = sine(frameSize * frames, 440, 48000);

  const chunked = new LinearResampler(48000, 16000);
  const pieces = [];

  for (let i = 0; i < frames; i++) {
    pieces.push(chunked.process(signal.subarray(i * frameSize, (i + 1) * frameSize)).slice());
  }

  const streamed = concat(pieces);
  const oneShot = new LinearResampler(48000, 16000).process(signal);

  assert.strictEqual(streamed.length, oneShot.length, 'streaming produced a different sample count');

  let maxError = 0;
  for (let i = 0; i < streamed.length; i++) {
    maxError = Math.max(maxError, Math.abs(streamed[i] - oneShot[i]));
  }

  assert.ok(maxError < 1e-5, `frame boundaries introduced error up to ${maxError}`);
});

test('LinearResampler is seamless across frame boundaries (non-integer ratio)', () => {
  const frameSize = 3528; // 80ms at 44.1 kHz
  const frames = 12;
  const signal = sine(frameSize * frames, 300, 44100);

  const chunked = new LinearResampler(44100, 16000);
  const pieces = [];

  for (let i = 0; i < frames; i++) {
    pieces.push(chunked.process(signal.subarray(i * frameSize, (i + 1) * frameSize)).slice());
  }

  const streamed = concat(pieces);
  const oneShot = new LinearResampler(44100, 16000).process(signal);

  // No drift: the totals must agree to within a sample
  assert.ok(
    Math.abs(streamed.length - oneShot.length) <= 1,
    `sample count drifted: ${streamed.length} streamed vs ${oneShot.length} in one shot`
  );

  const compare = Math.min(streamed.length, oneShot.length);
  let maxError = 0;
  for (let i = 0; i < compare; i++) {
    maxError = Math.max(maxError, Math.abs(streamed[i] - oneShot[i]));
  }

  assert.ok(maxError < 1e-4, `frame boundaries introduced error up to ${maxError}`);
});

test('LinearResampler round trip preserves a voice-band tone', () => {
  // 48k -> 16k -> 48k should still look like the original 300 Hz tone
  const signal = sine(4800, 300, 48000);

  const down = new LinearResampler(48000, 16000).process(signal);
  const up = new LinearResampler(16000, 48000).process(down);

  // Ignore the edges, where the one-sample history primes the filter
  let maxError = 0;
  for (let i = 10; i < Math.min(signal.length, up.length) - 10; i++) {
    maxError = Math.max(maxError, Math.abs(up[i] - signal[i]));
  }

  assert.ok(maxError < 0.05, `round trip error too large: ${maxError}`);
});

test('LinearResampler handles empty frames', () => {
  const resampler = new LinearResampler(48000, 16000);
  assert.strictEqual(resampler.process(new Float32Array(0)).length, 0);
});

test('floatToInt16 / int16ToFloat round trip within quantisation error', () => {
  const input = sine(1000, 440, 16000);
  const output = int16ToFloat(floatToInt16(input));

  let maxError = 0;
  for (let i = 0; i < input.length; i++) {
    maxError = Math.max(maxError, Math.abs(output[i] - input[i]));
  }

  assert.ok(maxError <= 1 / 32767, `quantisation error too large: ${maxError}`);
});

test('floatToInt16 clamps out-of-range samples', () => {
  const encoded = floatToInt16(new Float32Array([-2, -1, 0, 1, 2]));

  assert.deepStrictEqual(Array.from(encoded), [-32767, -32767, 0, 32767, 32767]);
});

test('toInt16Array accepts an ArrayBuffer', () => {
  const source = new Int16Array([1, -1, 300, -300]);
  const result = toInt16Array(source.buffer);

  assert.deepStrictEqual(Array.from(result), [1, -1, 300, -300]);
});

test('toInt16Array accepts a Uint8Array view', () => {
  const source = new Int16Array([5, -5, 1000]);
  const view = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  const result = toInt16Array(view);

  assert.deepStrictEqual(Array.from(result), [5, -5, 1000]);
});

test('toInt16Array accepts a Node Buffer, as relayed by Socket.IO', () => {
  const source = new Int16Array([7, -7, 2000]);
  const buffer = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const result = toInt16Array(buffer);

  assert.deepStrictEqual(Array.from(result), [7, -7, 2000]);
});

test('toInt16Array copes with an unaligned view', () => {
  const bytes = new Uint8Array(9);
  const aligned = new Int16Array([100, -100, 3000, -3000]);
  bytes.set(new Uint8Array(aligned.buffer), 1);

  const result = toInt16Array(new Uint8Array(bytes.buffer, 1, 8));

  assert.deepStrictEqual(Array.from(result), [100, -100, 3000, -3000]);
});

test('toInt16Array rejects unusable payloads', () => {
  assert.strictEqual(toInt16Array(null), null);
  assert.strictEqual(toInt16Array(undefined), null);
  assert.strictEqual(toInt16Array({}), null);
  assert.strictEqual(toInt16Array(new Uint8Array(1)), null, 'a single byte is not a sample');
});

test('FrameAccumulator emits fixed-size frames from 128-sample blocks', () => {
  const accumulator = new FrameAccumulator(1024);
  const frames = [];

  // 8 render quanta of 128 samples make exactly one frame
  for (let i = 0; i < 24; i++) {
    const block = new Float32Array(128).fill(i / 100);
    accumulator.push(block, (frame) => frames.push(frame));
  }

  assert.strictEqual(frames.length, 3);
  frames.forEach((frame) => assert.strictEqual(frame.length, 1024));
});

test('FrameAccumulator preserves sample order across frames', () => {
  const accumulator = new FrameAccumulator(4);
  const frames = [];

  accumulator.push(new Float32Array([1, 2, 3]), (frame) => frames.push(frame));
  accumulator.push(new Float32Array([4, 5, 6, 7, 8]), (frame) => frames.push(frame));

  assert.strictEqual(frames.length, 2);
  assert.deepStrictEqual(Array.from(frames[0]), [1, 2, 3, 4]);
  assert.deepStrictEqual(Array.from(frames[1]), [5, 6, 7, 8]);
});

test('FrameAccumulator flush emits the trailing partial frame', () => {
  const accumulator = new FrameAccumulator(1024);
  const frames = [];

  accumulator.push(new Float32Array(300).fill(0.5), (frame) => frames.push(frame));
  assert.strictEqual(frames.length, 0, 'a partial frame should not be emitted early');

  accumulator.flush((frame) => frames.push(frame));

  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].length, 300, 'the tail of a transmission must not be clipped');
});

test('FrameAccumulator flush is a no-op when nothing is buffered', () => {
  const accumulator = new FrameAccumulator(1024);
  let called = 0;

  accumulator.flush(() => called++);

  assert.strictEqual(called, 0);
});

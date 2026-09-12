/**
 * Tests for the streaming playback scheduler.
 *
 * These cover the behaviour the reported bug was about: audio must be scheduled
 * the moment a frame arrives, not held until the speaker stops talking.
 */

const test = require('node:test');
const assert = require('node:assert');

const { FakeAudioContext } = require('./helpers/fakeAudioContext');
const { floatToInt16 } = require('../public/js/audioDsp');
const AudioPlayback = require('../public/js/audioPlayback');

const WIRE_RATE = 16000;
const FRAME_MS = 80;
const FRAME_SAMPLES = (WIRE_RATE * FRAME_MS) / 1000; // 1280

/**
 * Build one PCM frame as it would arrive over the wire.
 * @param {number} samples
 * @returns {Uint8Array}
 */
function pcmFrame(samples = FRAME_SAMPLES) {
  const float = new Float32Array(samples);

  for (let i = 0; i < samples; i++) {
    float[i] = Math.sin((2 * Math.PI * 440 * i) / WIRE_RATE) * 0.5;
  }

  const pcm = floatToInt16(float);
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

function makePlayback(overrides = {}) {
  const context = new FakeAudioContext(48000);
  const playback = new AudioPlayback(context, {
    jitterBufferMs: 120,
    maxLeadMs: 1000,
    speakerTimeoutMs: 1500,
    ...overrides
  });

  return { context, playback };
}

const alice = { playerId: 'p-alice', username: 'Alice', team: 'hunter', sampleRate: WIRE_RATE };
const bob = { playerId: 'p-bob', username: 'Bob', team: 'runner', sampleRate: WIRE_RATE };

test('the first frame is scheduled immediately, not held until the end', () => {
  const { context, playback } = makePlayback();

  playback.enqueue(pcmFrame(), alice);

  assert.strictEqual(context.scheduled.length, 1, 'frame should be scheduled on arrival');
  assert.ok(
    Math.abs(context.scheduled[0].startedAt - 0.12) < 1e-9,
    `expected a 120ms jitter buffer, got ${context.scheduled[0].startedAt * 1000}ms`
  );
});

test('total latency stays within the jitter buffer regardless of message length', () => {
  const { context, playback } = makePlayback();

  // 5 seconds of speech, delivered frame by frame in real time
  const frames = Math.round(5000 / FRAME_MS);

  playback.enqueue(pcmFrame(), alice);
  const firstStart = context.scheduled[0].startedAt;

  for (let i = 1; i < frames; i++) {
    context.advance(FRAME_MS / 1000);
    playback.enqueue(pcmFrame(), alice);
  }

  // Playback of the first frame began 120ms after it arrived, and the last
  // frame is still only a jitter buffer behind the clock
  assert.ok(Math.abs(firstStart - 0.12) < 1e-9);

  const buffered = playback.getBufferedMs(alice.playerId);
  assert.ok(buffered < 200, `latency grew to ${buffered.toFixed(1)}ms over a 5s message`);
});

test('consecutive frames are scheduled back to back with no gap', () => {
  const { context, playback } = makePlayback();

  playback.enqueue(pcmFrame(), alice);
  playback.enqueue(pcmFrame(), alice);
  playback.enqueue(pcmFrame(), alice);

  assert.strictEqual(context.scheduled.length, 3);

  for (let i = 1; i < context.scheduled.length; i++) {
    const previous = context.scheduled[i - 1];
    const expected = previous.startedAt + previous.buffer.duration;

    assert.ok(
      Math.abs(context.scheduled[i].startedAt - expected) < 1e-9,
      `frame ${i} starts at ${context.scheduled[i].startedAt}, expected ${expected}`
    );
  }
});

test('frames are resampled to the context rate so buffers join sample-exactly', () => {
  const { context, playback } = makePlayback();

  playback.enqueue(pcmFrame(), alice);

  const buffer = context.scheduled[0].buffer;

  assert.strictEqual(buffer.sampleRate, 48000, 'buffer should be at the context rate');
  assert.ok(
    Math.abs(buffer.length - FRAME_SAMPLES * 3) <= 2,
    `expected ~${FRAME_SAMPLES * 3} samples at 48 kHz, got ${buffer.length}`
  );
});

test('a network stall resyncs the timeline instead of playing late', () => {
  const { context, playback } = makePlayback();

  playback.enqueue(pcmFrame(), alice);

  // Nothing arrives for two seconds: the timeline has run dry
  context.advance(2);
  playback.enqueue(pcmFrame(), alice);

  const resumed = context.scheduled[1];

  assert.ok(
    Math.abs(resumed.startedAt - (2 + 0.12)) < 1e-9,
    `expected a resync to now + jitter, got ${resumed.startedAt}`
  );
});

test('frames are dropped rather than letting latency grow without bound', () => {
  const { context, playback } = makePlayback({ maxLeadMs: 400 });

  // A burst arrives all at once with no clock movement
  for (let i = 0; i < 20; i++) {
    playback.enqueue(pcmFrame(), alice);
  }

  const buffered = playback.getBufferedMs(alice.playerId);

  assert.ok(context.scheduled.length < 20, 'some frames should have been dropped');
  assert.ok(buffered <= 500, `buffered audio should be capped, got ${buffered.toFixed(1)}ms`);
});

test('two people talking at once are mixed on independent timelines', () => {
  const { context, playback } = makePlayback();

  playback.enqueue(pcmFrame(), alice);
  playback.enqueue(pcmFrame(), bob);

  assert.strictEqual(context.scheduled.length, 2);

  // Both start at the same time rather than one queueing behind the other
  assert.ok(Math.abs(context.scheduled[0].startedAt - context.scheduled[1].startedAt) < 1e-9);

  // And through separate gain nodes
  assert.notStrictEqual(context.scheduled[0].connectedTo, context.scheduled[1].connectedTo);

  assert.strictEqual(playback.getActiveSpeakers().length, 2);
});

test('speaker start fires once per burst, not once per frame', () => {
  const { playback } = makePlayback();
  const starts = [];

  playback.onSpeakerStart((metadata) => starts.push(metadata.username));

  playback.noteSpeakerStart(alice);
  for (let i = 0; i < 10; i++) {
    playback.enqueue(pcmFrame(), alice);
  }

  assert.deepStrictEqual(starts, ['Alice']);
});

test('noteSpeakerStart marks a speaker live before any audio arrives', () => {
  const { playback } = makePlayback();

  playback.noteSpeakerStart(alice);

  assert.strictEqual(playback.isCurrentlyPlaying(), true);
  assert.deepStrictEqual(
    playback.getActiveSpeakers().map((s) => s.username),
    ['Alice']
  );
});

test('a speaker is retired only once their buffered audio has been heard', async () => {
  const { context, playback } = makePlayback({ jitterBufferMs: 20 });
  const ends = [];

  playback.onSpeakerEnd((metadata) => ends.push(metadata.username));

  playback.noteSpeakerStart(alice);
  playback.enqueue(pcmFrame(), alice);

  playback.noteSpeakerEnd(alice.playerId);

  assert.deepStrictEqual(ends, [], 'must not cut off audio that is still playing');

  // 20ms jitter + 80ms of audio + the scheduler's small margin
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.deepStrictEqual(ends, ['Alice']);
  assert.strictEqual(playback.isCurrentlyPlaying(), false);
});

test('a speaker who vanishes mid-sentence is retired by the watchdog', async () => {
  const { playback } = makePlayback({ speakerTimeoutMs: 60 });
  const ends = [];

  playback.onSpeakerEnd((metadata) => ends.push(metadata.username));

  playback.noteSpeakerStart(alice);
  playback.enqueue(pcmFrame(), alice);

  // No transmission-end event ever arrives
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.deepStrictEqual(ends, ['Alice'], 'the indicator must not stick forever');
});

test('empty and malformed frames are ignored', () => {
  const { context, playback } = makePlayback();

  playback.enqueue(new Uint8Array(0), alice);
  playback.enqueue(null, alice);
  playback.enqueue({}, alice);

  assert.strictEqual(context.scheduled.length, 0);
});

test('a frame with no playerId is ignored', () => {
  const { context, playback } = makePlayback();

  playback.enqueue(pcmFrame(), { username: 'Nobody', sampleRate: WIRE_RATE });

  assert.strictEqual(context.scheduled.length, 0);
});

test('removeSpeaker stops playback and forgets the speaker', () => {
  const { context, playback } = makePlayback();

  playback.enqueue(pcmFrame(), alice);
  const source = context.scheduled[0];

  playback.removeSpeaker(alice.playerId);

  assert.strictEqual(source.stopped, true);
  assert.strictEqual(playback.getActiveSpeakers().length, 0);
  assert.strictEqual(playback.getBufferedMs(alice.playerId), 0);
});

test('resetTimelines discards stale audio but keeps speakers registered', () => {
  const { context, playback } = makePlayback();

  playback.noteSpeakerStart(alice);
  playback.enqueue(pcmFrame(), alice);
  const source = context.scheduled[0];

  playback.resetTimelines();

  assert.strictEqual(source.stopped, true);
  assert.strictEqual(playback.getBufferedMs(alice.playerId), 0);

  // A new frame still plays, starting a fresh timeline
  context.advance(1);
  playback.enqueue(pcmFrame(), alice);

  assert.ok(Math.abs(context.scheduled[1].startedAt - 1.12) < 1e-9);
});

test('volume changes apply to the master gain', () => {
  const { playback } = makePlayback();

  playback.setVolume(0.25);
  assert.strictEqual(playback.getVolume(), 0.25);
  assert.strictEqual(playback.masterGain.gain.value, 0.25);

  playback.setVolume(5);
  assert.strictEqual(playback.getVolume(), 1, 'volume should clamp to 1');

  playback.setVolume(-1);
  assert.strictEqual(playback.getVolume(), 0, 'volume should clamp to 0');
});

test('a sender switching wire sample rate is handled', () => {
  const { context, playback } = makePlayback();

  playback.enqueue(pcmFrame(800), { ...alice, sampleRate: 8000 });
  playback.enqueue(pcmFrame(1280), { ...alice, sampleRate: 16000 });

  assert.strictEqual(context.scheduled.length, 2);
  context.scheduled.forEach((source) => {
    assert.strictEqual(source.buffer.sampleRate, 48000);
  });
});

test('stop halts everything and release tears down cleanly', () => {
  const { context, playback } = makePlayback();

  playback.enqueue(pcmFrame(), alice);
  playback.enqueue(pcmFrame(), bob);

  playback.stop();

  assert.strictEqual(playback.getActiveSpeakers().length, 0);
  context.scheduled.forEach((source) => assert.strictEqual(source.stopped, true));

  playback.release();

  assert.strictEqual(playback.audioContext, null);
});

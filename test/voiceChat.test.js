/**
 * Tests for the VoiceChat coordinator: the transmission state machine, the
 * start/stop race that used to leave the microphone live, and self-echo
 * filtering.
 */

const test = require('node:test');
const assert = require('node:assert');

const { FakeAudioContext } = require('./helpers/fakeAudioContext');
const { floatToInt16 } = require('../public/js/audioDsp');

const WIRE_RATE = 16000;

/**
 * Stand-in for AudioCapture whose microphone acquisition a test can control.
 */
class FakeAudioCapture {
  constructor(config) {
    this.config = config;
    this.prepareCalls = 0;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.released = false;
    this.streamLive = false;
    this.onFrame = null;
    this.onError = null;

    // When set, prepare() blocks on this promise
    this.prepareGate = null;
    this.prepareError = null;
  }

  async prepare() {
    this.prepareCalls++;

    if (this.prepareGate) {
      await this.prepareGate;
    }

    if (this.prepareError) {
      throw this.prepareError;
    }

    this.streamLive = true;
  }

  start(onFrame, onError) {
    this.startCalls++;
    this.onFrame = onFrame;
    this.onError = onError;
  }

  async stop() {
    this.stopCalls++;

    // Real capture flushes a trailing partial frame here
    if (this.onFrame) {
      this.onFrame(makePcm(160), { sampleRate: WIRE_RATE, final: true });
    }
  }

  scheduleIdleRelease() {}
  teardownGraph() {}
  releaseStream() {
    this.streamLive = false;
  }
  release() {
    this.released = true;
    this.streamLive = false;
  }
  isStreamLive() {
    return this.streamLive;
  }
  isRecording() {
    return this.startCalls > this.stopCalls;
  }

  /**
   * Simulate the worklet delivering a frame
   * @param {number} samples
   */
  emitFrame(samples = 1280) {
    if (this.onFrame) {
      this.onFrame(makePcm(samples), { sampleRate: WIRE_RATE });
    }
  }
}

function makePcm(samples) {
  const float = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    float[i] = Math.sin((2 * Math.PI * 300 * i) / WIRE_RATE) * 0.4;
  }
  return floatToInt16(float);
}

/**
 * Fake Socket.IO client that records everything emitted.
 */
class FakeSocket {
  constructor() {
    this.connected = true;
    this.emitted = [];
    this.volatile = {
      emit: (event, payload) => this.emit(event, payload, true)
    };
  }

  emit(event, payload, viaVolatile = false) {
    this.emitted.push({ event, payload, volatile: viaVolatile });
  }

  events(name) {
    return this.emitted.filter((entry) => entry.event === name);
  }
}

/**
 * Install just enough browser surface for voiceChat.js to load and run, then
 * return a freshly initialised VoiceChat.
 */
function setupVoiceChat(options = {}) {
  const context = new FakeAudioContext(48000);

  const listeners = {};

  global.window = {
    location: { protocol: 'https:', hostname: 'localhost' },
    innerWidth: 1280,
    AudioContext: function () {
      return context;
    }
  };

  // Node provides a read-only `navigator`, so it has to be replaced outright
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: options.userAgent || 'node-test-desktop',
      mediaDevices: { getUserMedia: async () => ({}) },
      maxTouchPoints: 0
    },
    configurable: true,
    writable: true
  });

  global.document = {
    hidden: false,
    addEventListener: (name, handler) => {
      listeners[name] = listeners[name] || [];
      listeners[name].push(handler);
    },
    removeEventListener: () => {}
  };

  const store = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => {
        store[key] = value;
      }
    },
    configurable: true,
    writable: true
  });

  global.AudioWorkletNode = function () {};

  let capture = null;
  global.AudioCapture = function (config) {
    capture = new FakeAudioCapture(config);
    return capture;
  };

  global.AudioPlayback = require('../public/js/audioPlayback');

  // Loaded fresh each time so module state does not leak between tests
  delete require.cache[require.resolve('../public/js/voiceChat')];
  const VoiceChat = require('../public/js/voiceChat');

  const socket = new FakeSocket();
  const ok = VoiceChat.init(socket, {}, { playerId: 'me', username: 'Me', team: 'hunter' });

  assert.strictEqual(ok, true, 'VoiceChat.init should succeed');

  // Voice chat starts silent and is only live on the map screen, which is what
  // opens it. Tests that care about the gate itself pass listening: false.
  if (options.listening !== false) {
    VoiceChat.setListening(true);
  }

  return { VoiceChat, socket, capture, context, listeners };
}

function audioFrames(socket) {
  return socket.events('voice_audio_chunk');
}

test('initialises with a shared AudioContext and the local player id', () => {
  const { VoiceChat, context } = setupVoiceChat();

  assert.strictEqual(VoiceChat.isInitialized, true);
  assert.strictEqual(VoiceChat.localPlayerId, 'me');
  assert.strictEqual(VoiceChat.audioContext, context);
  assert.strictEqual(VoiceChat.audioPlayback.audioContext, context, 'playback should share the context');
});

test('nothing is heard or sent while voice chat is not being listened to', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat({ listening: false });

  assert.strictEqual(VoiceChat.isListening, false, 'voice chat should start silent');

  // The status screen is up: the microphone cannot be opened from it
  await VoiceChat.startTransmission();

  assert.strictEqual(VoiceChat.state, 'idle');
  assert.strictEqual(capture.startCalls, 0);
  assert.strictEqual(socket.events('voice_transmission_start').length, 0);

  // ...and nothing anybody else says is played
  VoiceChat.handleTransmissionStarted({ playerId: 'them', username: 'Them', team: 'runner' });
  VoiceChat.handleIncomingAudio({
    playerId: 'them',
    username: 'Them',
    team: 'runner',
    audioData: makePcm(320).buffer,
    sampleRate: WIRE_RATE,
    sequenceNumber: 1
  });

  assert.strictEqual(VoiceChat.getActiveSpeakers().length, 0, 'nobody should be heard off the map');
});

test('leaving the map screen stops transmitting and drops what was queued', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat();

  await VoiceChat.startTransmission();
  assert.strictEqual(VoiceChat.state, 'transmitting');

  VoiceChat.handleIncomingAudio({
    playerId: 'them',
    username: 'Them',
    team: 'runner',
    audioData: makePcm(320).buffer,
    sampleRate: WIRE_RATE,
    sequenceNumber: 1
  });

  assert.strictEqual(VoiceChat.getActiveSpeakers().length, 1, 'they should be heard on the map');

  VoiceChat.setListening(false);
  await VoiceChat.pendingStop;

  assert.strictEqual(VoiceChat.state, 'idle');
  assert.strictEqual(capture.stopCalls, 1);
  assert.strictEqual(socket.events('voice_transmission_end').length, 1);
  assert.strictEqual(VoiceChat.getActiveSpeakers().length, 0, 'the backlog should be dropped, not saved up');
});

test('a normal press announces the start, streams frames, then announces the end', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat();

  await VoiceChat.startTransmission();

  assert.strictEqual(VoiceChat.state, 'transmitting');
  assert.strictEqual(capture.startCalls, 1);
  assert.strictEqual(socket.events('voice_transmission_start').length, 1);

  capture.emitFrame();
  capture.emitFrame();

  assert.strictEqual(audioFrames(socket).length, 2, 'frames should go out while the button is held');

  await VoiceChat.stopTransmission();

  assert.strictEqual(VoiceChat.state, 'idle');
  assert.strictEqual(capture.stopCalls, 1);
  assert.strictEqual(socket.events('voice_transmission_end').length, 1);
});

test('audio frames carry the wire sample rate and a rising sequence number', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat();

  await VoiceChat.startTransmission();
  capture.emitFrame();
  capture.emitFrame();
  capture.emitFrame();

  const frames = audioFrames(socket);

  assert.deepStrictEqual(
    frames.map((f) => f.payload.sequenceNumber),
    [1, 2, 3]
  );

  frames.forEach((frame) => {
    assert.strictEqual(frame.payload.sampleRate, WIRE_RATE);
    assert.ok(frame.payload.audioData instanceof Uint8Array, 'binary payloads must be typed arrays');
    assert.ok(frame.payload.audioData.byteLength > 0);
    assert.strictEqual(frame.volatile, true, 'audio should not be buffered for a dead socket');
  });

  await VoiceChat.stopTransmission();
});

test('the tail of a transmission is flushed before the end is announced', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat();

  await VoiceChat.startTransmission();
  capture.emitFrame();

  await VoiceChat.stopTransmission();

  const order = socket.emitted.map((entry) => entry.event);
  const lastFrame = order.lastIndexOf('voice_audio_chunk');
  const end = order.indexOf('voice_transmission_end');

  assert.strictEqual(audioFrames(socket).length, 2, 'the trailing partial frame should be sent');
  assert.ok(lastFrame < end, 'the tail frame must go out before the end event');
});

test('turning the mic off before it is ready does not leave it transmitting', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat();

  // Microphone acquisition hangs until we let it go
  let openMic;
  capture.prepareGate = new Promise((resolve) => {
    openMic = resolve;
  });

  const starting = VoiceChat.startTransmission();

  assert.strictEqual(VoiceChat.state, 'starting');

  // The user turns it straight back off before permission resolves
  await VoiceChat.stopTransmission();

  assert.strictEqual(VoiceChat.state, 'idle');

  openMic();
  await starting;

  assert.strictEqual(VoiceChat.state, 'idle', 'must not go hot-mic after an aborted start');
  assert.strictEqual(capture.startCalls, 0, 'capture should never have started');
  assert.strictEqual(socket.events('voice_transmission_start').length, 0);
  assert.strictEqual(socket.events('voice_transmission_end').length, 0, 'no start means no end');
  assert.strictEqual(audioFrames(socket).length, 0);
});

test('an aborted start does not cancel the start that replaced it', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat();

  // First attempt: the microphone hangs
  let openFirstMic;
  capture.prepareGate = new Promise((resolve) => {
    openFirstMic = resolve;
  });

  const firstAttempt = VoiceChat.startTransmission();

  // Turned off, then straight back on. The second attempt finds the
  // microphone ready.
  await VoiceChat.stopTransmission();
  capture.prepareGate = null;

  const secondAttempt = VoiceChat.startTransmission();

  // The first attempt only now discovers it was abandoned
  openFirstMic();
  await firstAttempt;
  await secondAttempt;

  assert.strictEqual(VoiceChat.state, 'transmitting', 'the live attempt must survive');
  assert.strictEqual(capture.startCalls, 1, 'only the second attempt should have started capture');
  assert.strictEqual(socket.events('voice_transmission_start').length, 1);

  await VoiceChat.stopTransmission();
});

test('a frame arriving after the microphone closes is not transmitted', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat();

  await VoiceChat.startTransmission();
  await VoiceChat.stopTransmission();

  const before = audioFrames(socket).length;

  // A stray frame from the audio thread after everything stopped
  capture.emitFrame();

  assert.strictEqual(audioFrames(socket).length, before);
});

test('a second start request while transmitting is ignored', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat();

  await VoiceChat.startTransmission();
  await VoiceChat.startTransmission();

  assert.strictEqual(capture.startCalls, 1);
  assert.strictEqual(socket.events('voice_transmission_start').length, 1);

  await VoiceChat.stopTransmission();
});

test('a stop with nothing running is a no-op', async () => {
  const { VoiceChat, socket } = setupVoiceChat();

  await VoiceChat.stopTransmission();

  assert.strictEqual(VoiceChat.state, 'idle');
  assert.strictEqual(socket.emitted.length, 0);
});

test('turning the mic straight back on keeps the control events in order', async () => {
  const { VoiceChat, socket } = setupVoiceChat();

  await VoiceChat.startTransmission();
  const firstStop = VoiceChat.stopTransmission();
  await VoiceChat.startTransmission();
  await firstStop;
  await VoiceChat.stopTransmission();

  const order = socket.emitted
    .map((entry) => entry.event)
    .filter((event) => event !== 'voice_audio_chunk');

  assert.deepStrictEqual(order, [
    'voice_transmission_start',
    'voice_transmission_end',
    'voice_transmission_start',
    'voice_transmission_end'
  ]);
});

test('the microphone stays open until it is explicitly closed', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat();

  const states = [];
  VoiceChat.onTransmissionStateChange((state) => states.push(state));

  await VoiceChat.startTransmission();
  assert.deepStrictEqual(states, ['starting', 'transmitting']);

  // The old control cut transmission off after 30 seconds, which would silently
  // mute a latched microphone. Nothing should stop it but the player.
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.strictEqual(VoiceChat.state, 'transmitting');
  assert.strictEqual(capture.stopCalls, 0);
  assert.strictEqual(socket.events('voice_transmission_end').length, 0);

  capture.emitFrame();
  assert.strictEqual(audioFrames(socket).length, 1, 'audio should still be flowing');

  await VoiceChat.stopTransmission();

  assert.strictEqual(VoiceChat.state, 'idle');
  assert.strictEqual(states[states.length - 1], 'idle', 'the button must be told it stopped');
  assert.strictEqual(socket.events('voice_transmission_end').length, 1);
});

test('closing for a reason other than a tap still notifies the button', async () => {
  const { VoiceChat, capture } = setupVoiceChat();

  const states = [];
  VoiceChat.onTransmissionStateChange((state) => states.push(state));

  await VoiceChat.startTransmission();

  // A microphone that is unplugged mid-sentence
  const unplugged = new Error('Microphone disconnected');
  unplugged.errorType = 'DeviceDisconnected';

  global.UI = { showNotification: () => {} };
  global.MicButton = { disable: () => {} };

  capture.onError(unplugged);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.strictEqual(VoiceChat.state, 'idle');
  assert.strictEqual(states[states.length - 1], 'idle');

  delete global.UI;
  delete global.MicButton;
});

test('nothing is sent while the socket is disconnected', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat();

  await VoiceChat.startTransmission();

  socket.connected = false;
  capture.emitFrame();
  capture.emitFrame();

  assert.strictEqual(audioFrames(socket).length, 0, 'stale audio must not be queued up');
  assert.strictEqual(VoiceChat.droppedFrames, 2);

  socket.connected = true;
  capture.emitFrame();

  assert.strictEqual(audioFrames(socket).length, 1);

  await VoiceChat.stopTransmission();
});

test('transmission is refused while voice chat is switched off', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat();

  VoiceChat.setEnabled(false);
  await VoiceChat.startTransmission();

  assert.strictEqual(VoiceChat.state, 'idle');
  assert.strictEqual(capture.startCalls, 0);
  assert.strictEqual(socket.events('voice_transmission_start').length, 0);
});

test('a microphone failure reports the error and leaves no transmission running', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat();

  const denied = new Error('Microphone access denied.');
  denied.errorType = 'NotAllowedError';
  capture.prepareError = denied;

  const notifications = [];
  global.UI = { showNotification: (message, level) => notifications.push({ message, level }) };
  global.MicButton = { disable: () => notifications.push({ message: 'disabled', level: 'mic' }) };

  await assert.rejects(() => VoiceChat.startTransmission());

  assert.strictEqual(VoiceChat.state, 'idle');
  assert.strictEqual(socket.events('voice_transmission_start').length, 0);
  assert.ok(
    notifications.some((entry) => entry.level === 'error'),
    'the user should be told why it failed'
  );
  assert.ok(
    notifications.some((entry) => entry.level === 'mic'),
    'the button should be disabled when permission is denied'
  );

  delete global.UI;
  delete global.MicButton;
});

test('incoming audio is played as it arrives', () => {
  const { VoiceChat, context } = setupVoiceChat();
  const pcm = makePcm(1280);

  VoiceChat.handleTransmissionStarted({ playerId: 'other', username: 'Alice', team: 'hunter' });

  assert.strictEqual(VoiceChat.getActiveSpeakers().length, 1);

  VoiceChat.handleIncomingAudio({
    playerId: 'other',
    username: 'Alice',
    team: 'hunter',
    audioData: new Uint8Array(pcm.buffer),
    sampleRate: WIRE_RATE,
    sequenceNumber: 1
  });

  assert.strictEqual(context.scheduled.length, 1, 'audio should be scheduled on arrival');
});

test('a player never hears their own transmission echoed back', () => {
  const { VoiceChat, context } = setupVoiceChat();
  const pcm = makePcm(1280);

  VoiceChat.handleTransmissionStarted({ playerId: 'me', username: 'Me', team: 'hunter' });
  VoiceChat.handleIncomingAudio({
    playerId: 'me',
    username: 'Me',
    team: 'hunter',
    audioData: new Uint8Array(pcm.buffer),
    sampleRate: WIRE_RATE
  });

  assert.strictEqual(context.scheduled.length, 0, 'own audio must not play back');
  assert.strictEqual(VoiceChat.getActiveSpeakers().length, 0, 'you are not a speaker to yourself');
});

test('incoming audio is ignored while voice chat is switched off', () => {
  const { VoiceChat, context } = setupVoiceChat();
  const pcm = makePcm(1280);

  VoiceChat.setEnabled(false);
  VoiceChat.handleIncomingAudio({
    playerId: 'other',
    username: 'Alice',
    audioData: new Uint8Array(pcm.buffer),
    sampleRate: WIRE_RATE
  });

  assert.strictEqual(context.scheduled.length, 0);
});

test('a departing player has their audio timeline dropped', () => {
  const { VoiceChat, context } = setupVoiceChat();
  const pcm = makePcm(1280);

  VoiceChat.handleIncomingAudio({
    playerId: 'other',
    username: 'Alice',
    audioData: new Uint8Array(pcm.buffer),
    sampleRate: WIRE_RATE
  });

  assert.strictEqual(context.scheduled.length, 1);

  VoiceChat.handlePlayerLeft('other');

  assert.strictEqual(context.scheduled[0].stopped, true);
  assert.strictEqual(VoiceChat.getActiveSpeakers().length, 0);
});

test('going to the background stops an active transmission', async () => {
  const { VoiceChat, socket, capture } = setupVoiceChat();

  await VoiceChat.startTransmission();

  global.document.hidden = true;
  VoiceChat.handleAppBackground();

  // stopTransmission is async; let its flush settle
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.strictEqual(VoiceChat.isAppInBackground(), true);
  assert.strictEqual(VoiceChat.state, 'idle');
  assert.strictEqual(capture.stopCalls, 1);
  assert.strictEqual(socket.events('voice_transmission_end').length, 1);

  global.document.hidden = false;
});

test('returning to the foreground discards audio that went stale while hidden', () => {
  const { VoiceChat, context } = setupVoiceChat();
  const pcm = makePcm(1280);

  VoiceChat.handleIncomingAudio({
    playerId: 'other',
    username: 'Alice',
    audioData: new Uint8Array(pcm.buffer),
    sampleRate: WIRE_RATE
  });

  const source = context.scheduled[0];

  VoiceChat.handleAppBackground();
  VoiceChat.handleAppForeground();

  assert.strictEqual(source.stopped, true);
  assert.strictEqual(VoiceChat.isAppInBackground(), false);
});

test('settings survive a round trip through localStorage', () => {
  const { VoiceChat } = setupVoiceChat();

  VoiceChat.setVolume(0.4);
  VoiceChat.setEnabled(false);

  const saved = JSON.parse(global.localStorage.getItem('huntedVoiceChatSettings'));

  assert.strictEqual(saved.volume, 0.4);
  assert.strictEqual(saved.enabled, false);
});

test('cleanup releases everything and blocks further transmission', async () => {
  const { VoiceChat, capture } = setupVoiceChat();

  await VoiceChat.startTransmission();
  VoiceChat.cleanup();

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.strictEqual(capture.released, true);
  assert.strictEqual(VoiceChat.isInitialized, false);
  assert.strictEqual(VoiceChat.audioPlayback, null);
  assert.strictEqual(VoiceChat.state, 'idle');

  await VoiceChat.startTransmission();
  assert.strictEqual(VoiceChat.state, 'idle', 'must not start after cleanup');
});

test('status reports what is actually happening', async () => {
  const { VoiceChat, capture } = setupVoiceChat();

  await VoiceChat.startTransmission();
  capture.emitFrame();

  const status = VoiceChat.getStatus();

  assert.strictEqual(status.isInitialized, true);
  assert.strictEqual(status.state, 'transmitting');
  assert.strictEqual(status.isTransmitting, true);
  assert.strictEqual(status.framesSent, 1);
  assert.strictEqual(status.micOpen, true);

  await VoiceChat.stopTransmission();
});

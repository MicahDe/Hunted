/**
 * Tests for the server-side voice relay: who receives what, the guards against
 * a flooding client, and cleanup when a speaker drops mid-sentence.
 */

const test = require('node:test');
const assert = require('node:assert');

const voiceChatHandler = require('../server/socket/voiceChatHandler');

/**
 * Records every broadcast so a test can assert on scope and payload.
 */
function createHarness({ registerPlayer = true } = {}) {
  const broadcasts = [];
  const directEmits = [];
  const handlers = {};

  const makeBroadcastOperator = (room, viaVolatile) => ({
    emit: (event, payload) => {
      broadcasts.push({ room, event, payload, volatile: viaVolatile, includesSender: false });
    },
    get volatile() {
      return makeBroadcastOperator(room, true);
    }
  });

  const socket = {
    id: 'socket-1',
    on: (event, handler) => {
      handlers[event] = handler;
    },
    emit: (event, payload) => {
      directEmits.push({ event, payload });
    },
    to: (room) => makeBroadcastOperator(room, false)
  };

  const io = {
    to: (room) => ({
      emit: (event, payload) => {
        broadcasts.push({ room, event, payload, includesSender: true });
      }
    })
  };

  const connectedPlayers = new Map();

  if (registerPlayer) {
    connectedPlayers.set('socket-1', {
      roomId: 'room-1',
      playerId: 'player-1',
      username: 'Alice',
      team: 'hunter'
    });
  }

  voiceChatHandler(io, socket, connectedPlayers);

  return {
    handlers,
    broadcasts,
    directEmits,
    connectedPlayers,
    fire: (event, payload) => handlers[event](payload),
    of: (event) => broadcasts.filter((entry) => entry.event === event)
  };
}

function pcmPayload(bytes = 3200) {
  return {
    audioData: Buffer.alloc(bytes, 1),
    sampleRate: 16000,
    sequenceNumber: 1,
    timestamp: Date.now()
  };
}

test('transmission start is announced to the room but not echoed to the sender', () => {
  const harness = createHarness();

  harness.fire('voice_transmission_start', { timestamp: Date.now() });

  const started = harness.of('voice_transmission_started');

  assert.strictEqual(started.length, 1);
  assert.strictEqual(started[0].room, 'room-1');
  assert.strictEqual(started[0].includesSender, false, 'you should not be shown as your own speaker');
  assert.deepStrictEqual(
    { playerId: started[0].payload.playerId, username: started[0].payload.username, team: started[0].payload.team },
    { playerId: 'player-1', username: 'Alice', team: 'hunter' }
  );
});

test('audio frames are relayed to the room with the sender identity and wire rate', () => {
  const harness = createHarness();

  harness.fire('voice_transmission_start', {});
  harness.fire('voice_audio_chunk', pcmPayload());

  const relayed = harness.of('voice_audio_received');

  assert.strictEqual(relayed.length, 1);
  assert.strictEqual(relayed[0].room, 'room-1');
  assert.strictEqual(relayed[0].includesSender, false);
  assert.strictEqual(relayed[0].volatile, true, 'stale audio should be dropped, not queued');
  assert.strictEqual(relayed[0].payload.username, 'Alice');
  assert.strictEqual(relayed[0].payload.sampleRate, 16000);
  assert.strictEqual(relayed[0].payload.audioData.length, 3200);
});

test('audio frames are relayed as they arrive, one broadcast each', () => {
  const harness = createHarness();

  harness.fire('voice_transmission_start', {});

  for (let i = 0; i < 12; i++) {
    harness.fire('voice_audio_chunk', { ...pcmPayload(), sequenceNumber: i + 1 });
  }

  const relayed = harness.of('voice_audio_received');

  assert.strictEqual(relayed.length, 12, 'the server must not batch or hold frames');
  assert.deepStrictEqual(
    relayed.map((entry) => entry.payload.sequenceNumber),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  );
});

test('the sample rate defaults when a client omits it', () => {
  const harness = createHarness();

  harness.fire('voice_audio_chunk', { audioData: Buffer.alloc(320, 1) });

  assert.strictEqual(harness.of('voice_audio_received')[0].payload.sampleRate, 16000);
});

test('empty, missing and oversized payloads are dropped', () => {
  const harness = createHarness();

  harness.fire('voice_audio_chunk', null);
  harness.fire('voice_audio_chunk', {});
  harness.fire('voice_audio_chunk', { audioData: Buffer.alloc(0) });
  harness.fire('voice_audio_chunk', { audioData: Buffer.alloc(128 * 1024, 1) });

  assert.strictEqual(harness.of('voice_audio_received').length, 0);
});

test('a flooding client is rate limited', () => {
  const harness = createHarness();

  for (let i = 0; i < 200; i++) {
    harness.fire('voice_audio_chunk', pcmPayload(320));
  }

  const relayed = harness.of('voice_audio_received');

  assert.ok(relayed.length <= 60, `expected at most 60 frames per second, relayed ${relayed.length}`);
  assert.ok(relayed.length > 0, 'normal traffic should still get through');
});

test('transmission end is announced once', () => {
  const harness = createHarness();

  harness.fire('voice_transmission_start', {});
  harness.fire('voice_transmission_end', {});
  harness.fire('voice_transmission_end', {});

  const ended = harness.of('voice_transmission_ended');

  assert.strictEqual(ended.length, 1, 'a duplicate end must not fire twice');
  assert.strictEqual(ended[0].payload.playerId, 'player-1');
  assert.strictEqual(ended[0].includesSender, false);
});

test('an end with no start is ignored', () => {
  const harness = createHarness();

  harness.fire('voice_transmission_end', {});

  assert.strictEqual(harness.of('voice_transmission_ended').length, 0);
});

test('dropping out mid-sentence ends the transmission for everyone else', () => {
  const harness = createHarness();

  harness.fire('voice_transmission_start', {});
  harness.fire('voice_audio_chunk', pcmPayload());

  // No end event: the player's connection just died
  harness.fire('disconnect');

  const ended = harness.of('voice_transmission_ended');

  assert.strictEqual(ended.length, 1, 'the speaker indicator would otherwise stick forever');
  assert.strictEqual(ended[0].payload.playerId, 'player-1');
});

test('disconnecting without talking broadcasts nothing', () => {
  const harness = createHarness();

  harness.fire('disconnect');

  assert.strictEqual(harness.broadcasts.length, 0);
});

test('a repeated start closes the previous transmission first', () => {
  const harness = createHarness();

  harness.fire('voice_transmission_start', {});
  harness.fire('voice_transmission_start', {});

  const order = harness.broadcasts.map((entry) => entry.event);

  assert.deepStrictEqual(order, [
    'voice_transmission_started',
    'voice_transmission_ended',
    'voice_transmission_started'
  ]);
});

test('a player who has not joined a room cannot relay anything', () => {
  const harness = createHarness({ registerPlayer: false });

  harness.fire('voice_transmission_start', {});
  harness.fire('voice_audio_chunk', pcmPayload());
  harness.fire('voice_transmission_end', {});

  assert.strictEqual(harness.broadcasts.length, 0);
  assert.deepStrictEqual(
    harness.directEmits.map((entry) => entry.event),
    ['error']
  );
});

test('audio payloads are relayed unchanged, whatever binary form they arrive in', () => {
  const harness = createHarness();
  const typed = new Uint8Array([1, 2, 3, 4, 5, 6]);

  harness.fire('voice_audio_chunk', { audioData: typed, sampleRate: 8000 });

  const relayed = harness.of('voice_audio_received')[0];

  assert.strictEqual(relayed.payload.audioData, typed, 'no copying or re-encoding');
  assert.strictEqual(relayed.payload.sampleRate, 8000);
});

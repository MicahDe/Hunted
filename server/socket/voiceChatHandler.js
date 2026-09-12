/**
 * Voice Chat Handler
 *
 * Relays walkie-talkie voice traffic between players in a room. Audio arrives
 * as small raw PCM frames many times a second while someone holds push-to-talk,
 * so this path is deliberately cheap: validate, relay, and do not log per frame.
 */

// A frame is 16-bit mono PCM. At 16 kHz, 100ms is 3200 bytes; allow generous
// headroom for a higher wire rate or longer frames, but reject anything that
// could not plausibly be one frame.
const MAX_FRAME_BYTES = 64 * 1024;

// Ceiling on frames per second from one player, so a misbehaving or modified
// client cannot flood the room.
const MAX_FRAMES_PER_SECOND = 60;

// A transmission this long was almost certainly never ended properly
const MAX_TRANSMISSION_MS = 60000;

module.exports = function (io, socket, connectedPlayers) {
  // Per-socket relay state
  const voiceState = {
    transmitting: false,
    windowStart: 0,
    framesInWindow: 0,
    staleTimer: null
  };

  /**
   * Measure a binary payload regardless of how Socket.IO delivered it
   * @param {Buffer|ArrayBuffer|ArrayBufferView} audioData
   * @returns {number} Size in bytes, or 0 if unusable
   */
  function byteLengthOf(audioData) {
    if (!audioData) {
      return 0;
    }

    if (Buffer.isBuffer(audioData)) {
      return audioData.length;
    }

    if (typeof audioData.byteLength === 'number') {
      return audioData.byteLength;
    }

    if (typeof audioData.length === 'number') {
      return audioData.length;
    }

    return 0;
  }

  /**
   * Simple fixed-window rate limit on audio frames
   * @returns {boolean} True if this frame is within the allowance
   */
  function allowFrame() {
    const now = Date.now();

    if (now - voiceState.windowStart >= 1000) {
      voiceState.windowStart = now;
      voiceState.framesInWindow = 0;
    }

    voiceState.framesInWindow++;

    return voiceState.framesInWindow <= MAX_FRAMES_PER_SECOND;
  }

  /**
   * Tell the room a player stopped talking. Safe to call more than once.
   * @param {string} reason - Why the transmission ended, for the log
   */
  function endTransmission(reason) {
    if (voiceState.staleTimer) {
      clearTimeout(voiceState.staleTimer);
      voiceState.staleTimer = null;
    }

    if (!voiceState.transmitting) {
      return;
    }

    voiceState.transmitting = false;

    const playerInfo = connectedPlayers.get(socket.id);

    if (!playerInfo) {
      return;
    }

    const { roomId, playerId, username } = playerInfo;

    console.log(`Voice transmission ended by ${username} (${playerId}) in room ${roomId} [${reason}]`);

    // Receivers finish playing whatever they have buffered, then retire the
    // speaker. The sender already knows it stopped, so it is excluded.
    socket.to(roomId).emit('voice_transmission_ended', {
      playerId,
      timestamp: Date.now()
    });
  }

  /**
   * Handle voice transmission start
   */
  socket.on('voice_transmission_start', () => {
    try {
      const playerInfo = connectedPlayers.get(socket.id);

      if (!playerInfo) {
        console.error('Voice transmission start: Player not found');
        return socket.emit('error', { message: 'Player not found' });
      }

      // A start without an end (app killed, tab closed mid-press) would leave
      // the previous speaker showing forever
      if (voiceState.transmitting) {
        endTransmission('superseded by a new transmission');
      }

      const { roomId, playerId, username, team } = playerInfo;

      voiceState.transmitting = true;

      // Backstop in case the end event never arrives
      voiceState.staleTimer = setTimeout(() => {
        voiceState.staleTimer = null;
        endTransmission('exceeded maximum duration');
      }, MAX_TRANSMISSION_MS);

      console.log(`Voice transmission started by ${username} (${playerId}) in room ${roomId}`);

      socket.to(roomId).emit('voice_transmission_started', {
        playerId,
        username,
        team,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Error handling voice transmission start:', error);
      socket.emit('error', { message: 'Failed to start voice transmission' });
    }
  });

  /**
   * Relay one audio frame to everyone else in the room
   */
  socket.on('voice_audio_chunk', (data) => {
    try {
      const playerInfo = connectedPlayers.get(socket.id);

      if (!playerInfo) {
        return;
      }

      if (!data || !data.audioData) {
        return;
      }

      const size = byteLengthOf(data.audioData);

      if (size === 0) {
        return;
      }

      if (size > MAX_FRAME_BYTES) {
        console.warn(`Dropping oversized voice frame from ${playerInfo.username}: ${size} bytes`);
        return;
      }

      if (!allowFrame()) {
        // Log once per window rather than per dropped frame
        if (voiceState.framesInWindow === MAX_FRAMES_PER_SECOND + 1) {
          console.warn(`Rate limiting voice frames from ${playerInfo.username}`);
        }
        return;
      }

      const { roomId, playerId, username, team } = playerInfo;

      // volatile: if a receiver's transport is momentarily down, drop the frame
      // instead of queueing audio that will be stale by the time it arrives
      socket.to(roomId).volatile.emit('voice_audio_received', {
        playerId,
        username,
        team,
        audioData: data.audioData,
        sampleRate: data.sampleRate || 16000,
        sequenceNumber: data.sequenceNumber || 0,
        timestamp: data.timestamp || Date.now()
      });
    } catch (error) {
      console.error('Error handling voice audio chunk:', error);
    }
  });

  /**
   * Handle voice transmission end
   */
  socket.on('voice_transmission_end', () => {
    try {
      endTransmission('released');
    } catch (error) {
      console.error('Error handling voice transmission end:', error);
    }
  });

  /**
   * If a player drops mid-sentence, close their transmission so nobody is left
   * showing as speaking forever.
   *
   * This runs before socketManager's own disconnect handler removes the player
   * from connectedPlayers, because handlers fire in registration order and the
   * voice handler is registered first.
   */
  socket.on('disconnect', () => {
    try {
      endTransmission('disconnected');
    } catch (error) {
      console.error('Error cleaning up voice transmission on disconnect:', error);
    }

    if (voiceState.staleTimer) {
      clearTimeout(voiceState.staleTimer);
      voiceState.staleTimer = null;
    }
  });
};

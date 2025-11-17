/**
 * Voice Chat Handler
 * Manages walkie-talkie style voice communication between players
 * Handles voice transmission events and broadcasts audio chunks to room members
 */

module.exports = function(io, socket, connectedPlayers) {
  
  /**
   * Handle voice transmission start
   * Validates sender and broadcasts transmission start to all players in room
   */
  socket.on('voice_transmission_start', (data) => {
    try {
      // Get player info from connected players map
      const playerInfo = connectedPlayers.get(socket.id);
      
      // Validate player is connected and in a room
      if (!playerInfo) {
        console.error('Voice transmission start: Player not found');
        return socket.emit('error', { message: 'Player not found' });
      }
      
      const { roomId, playerId, username, team } = playerInfo;
      
      console.log(`Voice transmission started by ${username} (${playerId}) in room ${roomId}`);
      
      // Broadcast to all players in room (including sender for UI feedback)
      io.to(roomId).emit('voice_transmission_started', {
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
   * Handle audio chunk transmission
   * Validates sender and broadcasts audio data to all players in room except sender
   */
  socket.on('voice_audio_chunk', (data) => {
    try {
      // Get player info from connected players map
      const playerInfo = connectedPlayers.get(socket.id);
      
      // Validate player is connected and in a room
      if (!playerInfo) {
        console.error('Voice audio chunk: Player not found');
        return;
      }
      
      const { roomId, playerId, username, team } = playerInfo;
      
      // Validate audio data exists and has content
      if (!data || !data.audioData) {
        console.error('Voice audio chunk: Missing audio data');
        return;
      }
      
      // Handle both Buffer (from Socket.IO) and typed arrays
      let audioDataSize = 0;
      if (Buffer.isBuffer(data.audioData)) {
        audioDataSize = data.audioData.length;
      } else if (data.audioData.byteLength !== undefined) {
        audioDataSize = data.audioData.byteLength;
      } else if (data.audioData.length !== undefined) {
        audioDataSize = data.audioData.length;
      }
      
      if (audioDataSize === 0) {
        console.error(`Voice audio chunk: Empty audio data from ${username}`);
        return;
      }
      
      // Log chunk info for debugging
      console.log(`Relaying audio chunk from ${username}: seq=${data.sequenceNumber}, size=${audioDataSize} bytes`);
      
      // Broadcast audio chunk to all players in room except sender
      // Socket.IO will automatically handle the binary data serialization
      socket.to(roomId).emit('voice_audio_received', {
        playerId,
        username,
        team,
        audioData: data.audioData,
        sequenceNumber: data.sequenceNumber || 0,
        timestamp: data.timestamp || Date.now()
      });
      
    } catch (error) {
      console.error('Error handling voice audio chunk:', error);
    }
  });
  
  /**
   * Handle voice transmission end
   * Validates sender and broadcasts transmission end to all players in room
   */
  socket.on('voice_transmission_end', (data) => {
    try {
      // Get player info from connected players map
      const playerInfo = connectedPlayers.get(socket.id);
      
      // Validate player is connected and in a room
      if (!playerInfo) {
        console.error('Voice transmission end: Player not found');
        return;
      }
      
      const { roomId, playerId, username } = playerInfo;
      
      console.log(`Voice transmission ended by ${username} (${playerId}) in room ${roomId}`);
      
      // Broadcast to all players in room (including sender for UI feedback)
      io.to(roomId).emit('voice_transmission_ended', {
        playerId,
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error('Error handling voice transmission end:', error);
    }
  });
  
};

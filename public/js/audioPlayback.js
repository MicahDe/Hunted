/**
 * Audio Playback Module for HUNTED Voice Chat
 * Handles audio playback queue and Web Audio API for low-latency playback
 */

class AudioPlayback {
  constructor(audioContext = null) {
    // Create or use provided AudioContext
    this.audioContext = audioContext || this.createAudioContext();
    
    // FIFO queue for audio chunks
    this.queue = [];
    
    // Playback state
    this.isPlaying = false;
    this.currentSource = null;
    
    // Volume control (0.0 to 1.0)
    this.volume = 1.0;
    this.gainNode = null;
    
    // Initialize gain node for volume control
    if (this.audioContext) {
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);
      this.gainNode.gain.value = this.volume;
    }
    
    // Callbacks
    this.onPlaybackStartCallback = null;
    this.onPlaybackEndCallback = null;
    this.onErrorCallback = null;
  }

  /**
   * Create an AudioContext with browser compatibility
   * @returns {AudioContext|null} The audio context or null if not supported
   */
  createAudioContext() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      
      if (!AudioContextClass) {
        console.error('Web Audio API is not supported in this browser');
        return null;
      }
      
      const context = new AudioContextClass();
      console.log('AudioContext created successfully');
      return context;
      
    } catch (error) {
      console.error('Failed to create AudioContext:', error);
      return null;
    }
  }

  /**
   * Enqueue an audio chunk for playback
   * @param {ArrayBuffer|Blob} audioData - The audio data to play
   * @param {Object} metadata - Optional metadata about the audio (speaker info, timestamp, etc.)
   */
  enqueue(audioData, metadata = {}) {
    if (!audioData) {
      console.warn('Attempted to enqueue null or undefined audio data');
      return;
    }

    // Add to queue with metadata
    this.queue.push({
      audioData: audioData,
      metadata: {
        playerId: metadata.playerId || null,
        username: metadata.username || 'Unknown',
        team: metadata.team || null,
        timestamp: metadata.timestamp || Date.now(),
        sequenceNumber: metadata.sequenceNumber || 0
      }
    });

    console.log(`Audio chunk enqueued. Queue size: ${this.queue.length}`);

    // Start playback if not already playing
    if (!this.isPlaying) {
      this.play();
    }
  }

  /**
   * Start playing audio from the queue
   * Processes chunks sequentially (FIFO)
   * @returns {Promise<void>}
   */
  async play() {
    // Prevent multiple simultaneous playback loops
    if (this.isPlaying) {
      return;
    }

    // Check if AudioContext is available
    if (!this.audioContext) {
      console.error('AudioContext not available for playback');
      return;
    }

    // Resume AudioContext if suspended (required by some browsers)
    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
        console.log('AudioContext resumed');
      } catch (error) {
        console.error('Failed to resume AudioContext:', error);
        return;
      }
    }

    this.isPlaying = true;

    // Process queue sequentially
    while (this.queue.length > 0) {
      const item = this.queue.shift(); // FIFO - get first item
      
      try {
        await this.playAudioChunk(item.audioData, item.metadata);
      } catch (error) {
        console.error('Error playing audio chunk:', error);
        
        // Call error callback if provided
        if (this.onErrorCallback) {
          this.onErrorCallback(error, item.metadata);
        }
        
        // Continue with next chunk instead of stopping playback
        continue;
      }
    }

    this.isPlaying = false;
    console.log('Playback queue empty');
  }

  /**
   * Play a single audio chunk
   * @param {ArrayBuffer|Blob} audioData - The audio data to play
   * @param {Object} metadata - Metadata about the audio
   * @returns {Promise<void>}
   */
  async playAudioChunk(audioData, metadata = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        // Convert Blob to ArrayBuffer if needed
        let arrayBuffer;
        if (audioData instanceof Blob) {
          arrayBuffer = await audioData.arrayBuffer();
        } else if (audioData instanceof ArrayBuffer) {
          arrayBuffer = audioData;
        } else {
          throw new Error('Invalid audio data type. Expected Blob or ArrayBuffer.');
        }

        // Validate ArrayBuffer
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
          const error = new Error('Empty or invalid audio data received');
          console.error('Playback error:', error);
          error.metadata = metadata;
          reject(error);
          return;
        }

        // Store the original size before decoding (decodeAudioData may consume the buffer)
        const originalSize = arrayBuffer.byteLength;
        
        // Decode audio data with enhanced error handling
        let audioBuffer;
        try {
          // Clone the ArrayBuffer to prevent it from being consumed/detached
          // Some browsers detach the ArrayBuffer during decodeAudioData
          const clonedBuffer = arrayBuffer.slice(0);
          audioBuffer = await this.audioContext.decodeAudioData(clonedBuffer);
        } catch (decodeError) {
          console.error('Audio decoding failed:', {
            error: decodeError,
            speaker: metadata.username,
            sequenceNumber: metadata.sequenceNumber,
            dataSize: originalSize
          });
          
          // Provide detailed error message for debugging
          const error = new Error('Failed to decode audio data. The audio format may be unsupported or corrupted.');
          error.originalError = decodeError;
          error.metadata = metadata;
          error.errorType = 'DecodingError';
          
          reject(error);
          return;
        }

        // Validate decoded audio buffer
        if (!audioBuffer || audioBuffer.length === 0) {
          const error = new Error('Decoded audio buffer is empty');
          console.error('Playback error:', error);
          error.metadata = metadata;
          reject(error);
          return;
        }

        // Create audio source
        this.currentSource = this.audioContext.createBufferSource();
        this.currentSource.buffer = audioBuffer;
        
        // Connect to gain node for volume control
        this.currentSource.connect(this.gainNode);

        // Handle playback end
        this.currentSource.onended = () => {
          console.log('Audio chunk playback completed');
          
          // Call playback end callback if provided
          if (this.onPlaybackEndCallback) {
            this.onPlaybackEndCallback(metadata);
          }
          
          this.currentSource = null;
          resolve();
        };

        // Call playback start callback if provided
        if (this.onPlaybackStartCallback) {
          this.onPlaybackStartCallback(metadata);
        }

        // Start playback
        this.currentSource.start(0);
        console.log(`Playing audio chunk from ${metadata.username || 'Unknown'} (seq: ${metadata.sequenceNumber || 'N/A'})`);

      } catch (error) {
        console.error('Unexpected error in playAudioChunk:', error);
        error.metadata = metadata;
        reject(error);
      }
    });
  }

  /**
   * Stop current playback and clear queue
   */
  stop() {
    // Stop current source if playing
    if (this.currentSource) {
      try {
        this.currentSource.stop();
        this.currentSource.disconnect();
      } catch (error) {
        // Source may already be stopped
        console.warn('Error stopping audio source:', error);
      }
      this.currentSource = null;
    }

    // Clear the queue
    this.clearQueue();

    this.isPlaying = false;
    console.log('Playback stopped');
  }

  /**
   * Set playback volume
   * @param {number} level - Volume level from 0.0 (mute) to 1.0 (full volume)
   */
  setVolume(level) {
    // Clamp volume between 0 and 1
    this.volume = Math.max(0, Math.min(1, level));
    
    // Update gain node if available
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
      console.log(`Volume set to ${(this.volume * 100).toFixed(0)}%`);
    }
  }

  /**
   * Get current volume level
   * @returns {number} Volume level from 0.0 to 1.0
   */
  getVolume() {
    return this.volume;
  }

  /**
   * Clear all queued audio chunks
   */
  clearQueue() {
    const queueSize = this.queue.length;
    this.queue = [];
    
    if (queueSize > 0) {
      console.log(`Cleared ${queueSize} audio chunks from queue`);
    }
  }

  /**
   * Get the current queue size
   * @returns {number} Number of audio chunks in queue
   */
  getQueueSize() {
    return this.queue.length;
  }

  /**
   * Check if audio is currently playing
   * @returns {boolean} True if audio is playing
   */
  isCurrentlyPlaying() {
    return this.isPlaying;
  }

  /**
   * Set callback for playback start events
   * @param {Function} callback - Called when audio chunk starts playing
   */
  onPlaybackStart(callback) {
    this.onPlaybackStartCallback = callback;
  }

  /**
   * Set callback for playback end events
   * @param {Function} callback - Called when audio chunk finishes playing
   */
  onPlaybackEnd(callback) {
    this.onPlaybackEndCallback = callback;
  }

  /**
   * Set callback for playback errors
   * @param {Function} callback - Called when playback error occurs
   */
  onError(callback) {
    this.onErrorCallback = callback;
  }

  /**
   * Release all resources
   * Should be called when audio playback is no longer needed
   */
  release() {
    // Stop any active playback
    this.stop();

    // Close AudioContext
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().then(() => {
        console.log('AudioContext closed');
      }).catch((error) => {
        console.error('Error closing AudioContext:', error);
      });
    }

    // Clear references
    this.audioContext = null;
    this.gainNode = null;
    this.currentSource = null;
    this.queue = [];
    this.onPlaybackStartCallback = null;
    this.onPlaybackEndCallback = null;
    this.onErrorCallback = null;

    console.log('Audio playback resources released');
  }

  /**
   * Pause playback (for mobile background transitions)
   * Suspends the audio context to save resources
   */
  pause() {
    if (!this.audioContext || this.audioContext.state === 'suspended') {
      return;
    }

    try {
      this.audioContext.suspend().then(() => {
        console.log('Audio playback paused (context suspended)');
      }).catch((error) => {
        console.error('Failed to suspend audio context:', error);
      });
    } catch (error) {
      console.error('Error pausing audio playback:', error);
    }
  }

  /**
   * Resume playback (for mobile foreground transitions)
   * Resumes the audio context and continues playback if there are queued chunks
   */
  resume() {
    if (!this.audioContext || this.audioContext.state !== 'suspended') {
      return;
    }

    try {
      this.audioContext.resume().then(() => {
        console.log('Audio playback resumed (context resumed)');
        
        // If there are queued chunks and not currently playing, start playback
        if (this.queue.length > 0 && !this.isPlaying) {
          console.log('Resuming playback of queued audio chunks');
          this.play();
        }
      }).catch((error) => {
        console.error('Failed to resume audio context:', error);
      });
    } catch (error) {
      console.error('Error resuming audio playback:', error);
    }
  }

  /**
   * Get AudioContext state
   * @returns {string|null} The AudioContext state or null
   */
  getContextState() {
    return this.audioContext ? this.audioContext.state : null;
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AudioPlayback;
}

/**
 * Audio Capture Module for HUNTED Voice Chat
 * Handles microphone access and audio recording using MediaRecorder API
 */

class AudioCapture {
  constructor(config = {}) {
    this.config = {
      mimeType: config.mimeType || 'audio/webm;codecs=opus',
      audioBitsPerSecond: config.audioBitsPerSecond || 32000,
      chunkInterval: config.chunkInterval || 100, // milliseconds
      ...config
    };
    
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
    this.onDataAvailableCallback = null;
    this.onErrorCallback = null;
  }

  /**
   * Detect if running on a mobile device
   * @returns {boolean} True if mobile device
   */
  detectMobileDevice() {
    const userAgent = navigator.userAgent.toLowerCase();
    const mobileKeywords = ['android', 'webos', 'iphone', 'ipad', 'ipod', 'blackberry', 'windows phone'];
    return mobileKeywords.some(keyword => userAgent.includes(keyword));
  }

  /**
   * Request microphone access from the user
   * @returns {Promise<MediaStream>} The media stream from the microphone
   * @throws {Error} If microphone access is denied or unavailable
   */
  async requestMicrophoneAccess() {
    try {
      // Check if getUserMedia is supported
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia is not supported in this browser');
      }

      // Detect mobile device for optimized constraints
      const isMobile = this.detectMobileDevice();

      // Request audio stream with optimal settings for voice
      // Use more relaxed constraints on mobile to improve compatibility
      const constraints = {
        audio: isMobile ? {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1 // Mono audio for voice
          // Don't specify sampleRate on mobile - let browser choose optimal value
        } : {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1, // Mono audio for voice
          sampleRate: 48000 // Standard sample rate
        }
      };

      console.log('Requesting microphone access with constraints:', constraints);
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log('Microphone access granted');
      
      // Set up stream ended listener for microphone disconnection
      this.setupStreamEndedListener();
      
      return this.stream;

    } catch (error) {
      console.error('Microphone access error:', error);
      
      // Provide user-friendly error messages
      let userMessage = 'Failed to access microphone';
      
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        userMessage = 'Microphone access denied. Please enable microphone permissions in your browser settings.';
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        userMessage = 'No microphone found. Please connect a microphone and try again.';
      } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
        userMessage = 'Microphone is already in use by another application.';
      } else if (error.name === 'OverconstrainedError') {
        // On mobile, try again with minimal constraints
        if (this.detectMobileDevice()) {
          console.warn('Overconstrained error on mobile, retrying with minimal constraints');
          return this.requestMicrophoneAccessFallback();
        }
        userMessage = 'Microphone does not meet the required specifications.';
      } else if (error.name === 'SecurityError') {
        userMessage = 'Microphone access blocked due to security restrictions.';
      }
      
      const enhancedError = new Error(userMessage);
      enhancedError.originalError = error;
      enhancedError.errorType = error.name;
      throw enhancedError;
    }
  }

  /**
   * Fallback microphone access with minimal constraints (for mobile compatibility)
   * @returns {Promise<MediaStream>} The media stream from the microphone
   * @throws {Error} If microphone access fails
   */
  async requestMicrophoneAccessFallback() {
    try {
      console.log('Attempting microphone access with minimal constraints (fallback)');
      
      // Use minimal constraints for maximum compatibility
      const constraints = {
        audio: true
      };

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log('Microphone access granted (fallback mode)');
      
      // Set up stream ended listener
      this.setupStreamEndedListener();
      
      return this.stream;

    } catch (error) {
      console.error('Fallback microphone access failed:', error);
      
      const enhancedError = new Error('Failed to access microphone even with minimal requirements');
      enhancedError.originalError = error;
      enhancedError.errorType = error.name;
      throw enhancedError;
    }
  }

  /**
   * Set up listener for stream ended event (microphone disconnection)
   */
  setupStreamEndedListener() {
    if (!this.stream) {
      return;
    }

    // Listen for track ended events on all audio tracks
    const audioTracks = this.stream.getAudioTracks();
    audioTracks.forEach(track => {
      track.onended = () => {
        console.warn('Microphone track ended (disconnected or revoked)');
        
        // Stop recording if active
        if (this.isRecording()) {
          this.stopRecording();
        }
        
        // Call error callback to notify VoiceChat
        if (this.onErrorCallback) {
          const error = new Error('Microphone disconnected');
          error.errorType = 'DeviceDisconnected';
          this.onErrorCallback(error);
        }
      };
    });
  }

  /**
   * Start recording audio from the microphone
   * @param {Function} onDataAvailable - Callback function called when audio chunks are available
   * @param {Function} onError - Optional callback for handling errors during recording
   * @throws {Error} If stream is not available or MediaRecorder is not supported
   */
  startRecording(onDataAvailable, onError = null) {
    if (!this.stream) {
      throw new Error('No audio stream available. Call requestMicrophoneAccess() first.');
    }

    // Check if MediaRecorder is supported
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder is not supported in this browser');
    }

    // Check if the specified MIME type is supported
    let mimeType = this.config.mimeType;
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      console.warn(`MIME type ${mimeType} not supported, trying fallback options`);
      
      // Try fallback MIME types
      const fallbackTypes = [
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
        'audio/wav'
      ];
      
      mimeType = fallbackTypes.find(type => MediaRecorder.isTypeSupported(type));
      
      if (!mimeType) {
        throw new Error('No supported audio MIME type found for recording');
      }
      
      console.log(`Using fallback MIME type: ${mimeType}`);
    }

    try {
      // Create MediaRecorder with configuration
      const options = {
        mimeType: mimeType,
        audioBitsPerSecond: this.config.audioBitsPerSecond
      };

      this.mediaRecorder = new MediaRecorder(this.stream, options);
      this.onDataAvailableCallback = onDataAvailable;
      this.onErrorCallback = onError;

      // Handle data available event - emits audio chunks
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.chunks.push(event.data);
          
          console.log(`MediaRecorder data available: ${event.data.size} bytes, type: ${event.data.type}`);
          
          // Call the callback with the audio chunk
          if (this.onDataAvailableCallback) {
            this.onDataAvailableCallback(event.data);
          }
        } else {
          console.warn('MediaRecorder emitted empty data chunk');
        }
      };

      // Handle recording errors
      this.mediaRecorder.onerror = (event) => {
        console.error('MediaRecorder error:', event.error);
        
        const errorMessage = 'Recording error: ' + (event.error?.message || 'Unknown error');
        
        if (this.onErrorCallback) {
          this.onErrorCallback(new Error(errorMessage));
        }
      };

      // Handle recording stop
      this.mediaRecorder.onstop = () => {
        console.log('Recording stopped');
      };

      // Start recording with specified chunk interval
      this.mediaRecorder.start(this.config.chunkInterval);
      console.log(`Recording started with ${this.config.chunkInterval}ms chunk interval`);

    } catch (error) {
      console.error('Failed to start recording:', error);
      throw new Error('Failed to start recording: ' + error.message);
    }
  }

  /**
   * Stop recording audio
   */
  stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      console.log('Recording stopped');
    }
    
    // Clear chunks array
    this.chunks = [];
  }

  /**
   * Release all resources (stream and recorder)
   * Should be called when audio capture is no longer needed
   */
  release() {
    // Stop recording if active
    this.stopRecording();

    // Stop all tracks in the stream
    if (this.stream) {
      this.stream.getTracks().forEach(track => {
        track.stop();
        console.log('Audio track stopped');
      });
      this.stream = null;
    }

    // Clear references
    this.mediaRecorder = null;
    this.chunks = [];
    this.onDataAvailableCallback = null;
    this.onErrorCallback = null;
    
    console.log('Audio capture resources released');
  }

  /**
   * Check if currently recording
   * @returns {boolean} True if recording is active
   */
  isRecording() {
    return this.mediaRecorder && this.mediaRecorder.state === 'recording';
  }

  /**
   * Get the current audio stream
   * @returns {MediaStream|null} The current media stream or null
   */
  getStream() {
    return this.stream;
  }

  /**
   * Get the MIME type being used for recording
   * @returns {string|null} The MIME type or null if not recording
   */
  getMimeType() {
    return this.mediaRecorder ? this.mediaRecorder.mimeType : null;
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AudioCapture;
}

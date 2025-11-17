/**
 * Voice Chat Manager for HUNTED Game
 * Central coordinator for walkie-talkie style voice communication
 * Manages audio capture, transmission, playback, and settings
 */

const VoiceChat = {
  // State management
  isEnabled: true,
  isTransmitting: false,
  isReceiving: false,
  isInitialized: false,
  
  // Volume control (0.0 to 1.0)
  volume: 1.0,
  
  // Audio components
  audioCapture: null,
  audioPlayback: null,
  
  // Socket.IO connection
  socket: null,
  
  // Game state reference
  gameState: null,
  
  // Transmission tracking
  transmissionStartTime: null,
  transmissionTimer: null,
  sequenceNumber: 0,
  currentRetryAttempt: 0,
  failedChunks: [],
  
  // Current speaker metadata
  currentSpeaker: null,
  
  // Chunk accumulation for current transmission
  incomingTransmissions: new Map(), // playerId -> {chunks: [], metadata: {}}
  
  // Configuration
  config: {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 32000,
    chunkInterval: 1000, // milliseconds - longer interval for complete audio segments
    maxTransmissionDuration: 30000, // 30 seconds
    maxQueueSize: 10, // Maximum audio chunks in queue
    retryAttempts: 3,
    retryDelay: 1000 // milliseconds
  },
  
  // Mobile-specific state
  isMobile: false,
  isInBackground: false,
  visibilityChangeHandler: null,
  audioContextResumeHandler: null,

  /**
   * Check if the browser supports required audio APIs
   * @returns {Object} Support status with details
   */
  checkBrowserSupport() {
    const support = {
      isSupported: true,
      missing: [],
      warnings: [],
      requiresHttps: false
    };

    // Check if we're on HTTPS or localhost
    const isHttps = window.location.protocol === 'https:';
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const isSecureContext = isHttps || isLocalhost;

    // Check MediaRecorder API
    if (typeof MediaRecorder === 'undefined') {
      support.isSupported = false;
      support.missing.push('MediaRecorder API');
    }

    // Check getUserMedia
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      support.isSupported = false;
      support.missing.push('getUserMedia API');
      
      // If not in secure context, that's likely why getUserMedia is unavailable
      if (!isSecureContext) {
        support.requiresHttps = true;
        support.warnings.push('getUserMedia requires HTTPS or localhost');
      }
    }

    // Check Web Audio API
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      support.isSupported = false;
      support.missing.push('Web Audio API');
    }

    // Check for Opus codec support (warning only, not blocking)
    if (typeof MediaRecorder !== 'undefined') {
      if (!MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        support.warnings.push('Opus codec not supported, will use fallback');
      }
    }

    // Log support status
    if (support.isSupported) {
      console.log('Voice chat: Browser support check passed');
      if (support.warnings.length > 0) {
        console.warn('Voice chat warnings:', support.warnings);
      }
    } else {
      console.error('Voice chat: Browser not supported. Missing:', support.missing);
      if (support.requiresHttps) {
        console.error('Voice chat: HTTPS is required for microphone access on this device');
        console.error('Current protocol:', window.location.protocol);
      }
    }

    return support;
  },

  /**
   * Initialize the voice chat system
   * @param {Object} socket - Socket.IO connection
   * @param {Object} gameState - Reference to game state
   * @returns {boolean} True if initialization successful
   */
  init(socket, gameState) {
    console.log('Initializing voice chat system...');

    // Check browser support first
    const support = this.checkBrowserSupport();
    if (!support.isSupported) {
      console.error('Voice chat cannot be initialized: Browser not supported');
      return false;
    }

    try {
      // Store references
      this.socket = socket;
      this.gameState = gameState;

      // Detect mobile device
      this.detectMobileDevice();

      // Load saved settings from localStorage
      this.loadSettings();

      // Initialize audio components
      this.audioCapture = new AudioCapture(this.config);
      this.audioPlayback = new AudioPlayback();

      // Set initial volume
      this.audioPlayback.setVolume(this.volume);

      // Set up playback callbacks
      this.audioPlayback.onPlaybackStart((metadata) => {
        this.currentSpeaker = metadata;
        this.isReceiving = true;
        console.log(`Playback started: ${metadata.username} (${metadata.team})`);
        
        // Update speaker indicator
        if (typeof SpeakerIndicator !== 'undefined' && SpeakerIndicator.show) {
          SpeakerIndicator.show(metadata);
        }
      });

      this.audioPlayback.onPlaybackEnd((metadata) => {
        this.currentSpeaker = null;
        this.isReceiving = false;
        console.log(`Playback ended: ${metadata.username}`);
        
        // Hide speaker indicator
        if (typeof SpeakerIndicator !== 'undefined' && SpeakerIndicator.hide) {
          SpeakerIndicator.hide(500);
        }
      });

      this.audioPlayback.onError((error) => {
        console.error('Playback error:', error);
        // Continue with next chunk - graceful degradation
      });

      // Set up mobile-specific handlers
      if (this.isMobile) {
        this.setupMobileOptimizations();
      }

      this.isInitialized = true;
      console.log('Voice chat system initialized successfully');
      return true;

    } catch (error) {
      console.error('Failed to initialize voice chat:', error);
      this.isInitialized = false;
      return false;
    }
  },

  /**
   * Load voice chat settings from localStorage
   */
  loadSettings() {
    try {
      const savedSettings = localStorage.getItem('huntedVoiceChatSettings');
      
      if (savedSettings) {
        const settings = JSON.parse(savedSettings);
        
        // Apply saved settings
        this.isEnabled = settings.enabled !== undefined ? settings.enabled : true;
        this.volume = settings.volume !== undefined ? settings.volume : 1.0;
        
        console.log('Voice chat settings loaded:', settings);
      } else {
        console.log('No saved voice chat settings found, using defaults');
      }
    } catch (error) {
      console.error('Failed to load voice chat settings:', error);
      // Use defaults on error
    }
  },

  /**
   * Save voice chat settings to localStorage
   */
  saveSettings() {
    try {
      const settings = {
        enabled: this.isEnabled,
        volume: this.volume,
        lastUpdated: Date.now()
      };
      
      localStorage.setItem('huntedVoiceChatSettings', JSON.stringify(settings));
      console.log('Voice chat settings saved');
    } catch (error) {
      console.error('Failed to save voice chat settings:', error);
    }
  },

  /**
   * Start voice transmission (Push-to-Talk pressed)
   * @returns {Promise<void>}
   */
  async startTransmission() {
    // Check if voice chat is enabled
    if (!this.isEnabled) {
      console.warn('Voice chat is disabled');
      return;
    }

    // Check if already transmitting
    if (this.isTransmitting) {
      console.warn('Already transmitting');
      return;
    }

    // Check if initialized
    if (!this.isInitialized) {
      console.error('Voice chat not initialized');
      return;
    }

    console.log('Starting voice transmission...');

    try {
      // Request microphone access
      await this.audioCapture.requestMicrophoneAccess();

      // Reset sequence number and failed chunks for new transmission
      this.sequenceNumber = 0;
      this.failedChunks = [];

      // Notify server that transmission is starting
      if (this.socket) {
        this.socket.emit('voice_transmission_start', {
          timestamp: Date.now()
        });
      }

      // Start recording with chunk callback
      this.audioCapture.startRecording(
        (audioChunk) => {
          // Handle each audio chunk
          this.handleAudioChunk(audioChunk);
        },
        (error) => {
          // Handle recording errors
          console.error('Recording error:', error);
          this.handleRecordingError(error);
        }
      );

      // Update state
      this.isTransmitting = true;
      this.transmissionStartTime = Date.now();

      // Set maximum transmission duration timer (30 seconds)
      this.transmissionTimer = setTimeout(() => {
        console.log('Maximum transmission duration reached, stopping...');
        this.stopTransmission();
      }, this.config.maxTransmissionDuration);

      console.log('Voice transmission started');

    } catch (error) {
      console.error('Failed to start transmission:', error);
      this.isTransmitting = false;
      
      // Handle microphone access errors with user-friendly messages
      this.handleMicrophoneError(error);
      
      // Re-throw to allow PTT button to handle it
      throw error;
    }
  },

  /**
   * Handle recording errors from MediaRecorder
   * @param {Error} error - The error that occurred
   */
  handleRecordingError(error) {
    console.error('MediaRecorder error:', error);
    
    // Stop transmission
    this.stopTransmission();
    
    // Determine error message
    let message = 'Voice recording failed';
    let shouldDisablePTT = false;
    
    if (error.errorType === 'DeviceDisconnected') {
      message = 'Microphone was disconnected during transmission. Please reconnect your microphone.';
      shouldDisablePTT = true;
    } else if (error.message) {
      message = 'Voice recording error: ' + error.message;
    }
    
    // Show notification
    this.showErrorNotification(message, null);
    
    // Disable PTT button if microphone was disconnected
    if (shouldDisablePTT && typeof PTTButton !== 'undefined') {
      PTTButton.disable();
      console.log('PTT button disabled due to microphone disconnection');
    }
  },

  /**
   * Handle microphone access errors
   * @param {Error} error - The error that occurred
   */
  handleMicrophoneError(error) {
    let message = 'Failed to access microphone';
    let helpLink = null;
    let shouldDisablePTT = false;

    // Determine error type and appropriate response
    if (error.errorType === 'NotAllowedError' || error.errorType === 'PermissionDeniedError') {
      message = 'Microphone access denied. Please enable microphone permissions in your browser settings.';
      helpLink = this.getMicrophoneHelpLink();
      shouldDisablePTT = true;
    } else if (error.errorType === 'NotFoundError' || error.errorType === 'DevicesNotFoundError') {
      message = 'No microphone found. Please connect a microphone and try again.';
      shouldDisablePTT = true;
    } else if (error.errorType === 'NotReadableError' || error.errorType === 'TrackStartError') {
      message = 'Microphone is already in use by another application. Please close other apps using the microphone.';
      shouldDisablePTT = false; // Temporary issue, don't disable permanently
    } else if (error.errorType === 'OverconstrainedError') {
      message = 'Your microphone does not meet the required specifications.';
      shouldDisablePTT = true;
    } else if (error.errorType === 'SecurityError') {
      message = 'Microphone access blocked due to security restrictions.';
      helpLink = this.getMicrophoneHelpLink();
      shouldDisablePTT = true;
    } else if (error.message) {
      message = error.message;
    }

    // Show notification to user
    this.showErrorNotification(message, helpLink);

    // Disable PTT button if necessary
    if (shouldDisablePTT && typeof PTTButton !== 'undefined') {
      PTTButton.disable();
      console.log('PTT button disabled due to microphone error');
    }
  },

  /**
   * Get browser-specific help link for microphone permissions
   * @returns {string|null} Help URL or null
   */
  getMicrophoneHelpLink() {
    const userAgent = navigator.userAgent.toLowerCase();
    
    if (userAgent.includes('chrome') && !userAgent.includes('edg')) {
      return 'https://support.google.com/chrome/answer/2693767';
    } else if (userAgent.includes('firefox')) {
      return 'https://support.mozilla.org/en-US/kb/how-manage-your-camera-and-microphone-permissions';
    } else if (userAgent.includes('safari')) {
      return 'https://support.apple.com/guide/safari/websites-ibrwe2159f50/mac';
    } else if (userAgent.includes('edg')) {
      return 'https://support.microsoft.com/en-us/microsoft-edge/windows-camera-microphone-and-privacy-a83257bc-e990-d54a-d212-b5e41beba857';
    }
    
    return null;
  },

  /**
   * Show error notification to user
   * @param {string} message - Error message to display
   * @param {string|null} helpLink - Optional help link
   */
  showErrorNotification(message, helpLink = null) {
    // Try to use game's notification system
    if (typeof UI !== 'undefined' && UI.showNotification) {
      let fullMessage = message;
      if (helpLink) {
        fullMessage += ` <a href="${helpLink}" target="_blank" rel="noopener noreferrer">Learn more</a>`;
      }
      UI.showNotification(fullMessage, 'error');
    } else {
      // Fallback to alert
      let fullMessage = message;
      if (helpLink) {
        fullMessage += '\n\nFor help, visit: ' + helpLink;
      }
      alert(fullMessage);
    }
  },

  /**
   * Handle audio chunk from MediaRecorder
   * @param {Blob} audioChunk - Audio data chunk
   */
  handleAudioChunk(audioChunk) {
    if (!this.isTransmitting || !this.socket) {
      return;
    }

    // Validate chunk has data
    if (!audioChunk || audioChunk.size === 0) {
      console.warn('Received empty audio chunk from MediaRecorder, skipping');
      return;
    }

    // Convert Blob to ArrayBuffer for transmission
    audioChunk.arrayBuffer().then((arrayBuffer) => {
      // Double-check ArrayBuffer has data
      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        console.warn('Audio chunk converted to empty ArrayBuffer, skipping');
        return;
      }

      // Increment sequence number
      this.sequenceNumber++;

      console.log(`Sending audio chunk #${this.sequenceNumber}, size: ${arrayBuffer.byteLength} bytes`);

      // Attempt to send audio chunk with retry logic
      this.sendAudioChunkWithRetry(arrayBuffer, this.sequenceNumber);

    }).catch((error) => {
      console.error('Failed to process audio chunk:', error);
    });
  },

  /**
   * Send audio chunk with retry logic
   * @param {ArrayBuffer} arrayBuffer - Audio data
   * @param {number} sequenceNumber - Chunk sequence number
   * @param {number} attempt - Current retry attempt (default 0)
   */
  sendAudioChunkWithRetry(arrayBuffer, sequenceNumber, attempt = 0) {
    if (!this.socket) {
      console.error('Socket not available for transmission');
      return;
    }

    // Final validation before sending
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      console.error(`Cannot send empty audio chunk #${sequenceNumber}`);
      return;
    }

    try {
      // Convert ArrayBuffer to Uint8Array for Socket.IO binary transmission
      // Socket.IO handles typed arrays better than raw ArrayBuffers
      const uint8Array = new Uint8Array(arrayBuffer);
      
      console.log(`Sending audio chunk #${sequenceNumber}: ${arrayBuffer.byteLength} bytes (as Uint8Array)`);
      
      // Emit audio chunk to server
      this.socket.emit('voice_audio_chunk', {
        audioData: uint8Array,
        sequenceNumber: sequenceNumber,
        timestamp: Date.now()
      }, (acknowledgment) => {
        // Success callback (if server sends acknowledgment)
        console.log(`Sent audio chunk #${sequenceNumber} (${arrayBuffer.byteLength} bytes)`);
      });

    } catch (error) {
      console.error(`Failed to send audio chunk #${sequenceNumber} (attempt ${attempt + 1}):`, error);

      // Retry logic
      if (attempt < this.config.retryAttempts) {
        console.log(`Retrying audio chunk #${sequenceNumber} (attempt ${attempt + 2}/${this.config.retryAttempts + 1})`);
        
        // Retry after delay
        setTimeout(() => {
          this.sendAudioChunkWithRetry(arrayBuffer, sequenceNumber, attempt + 1);
        }, this.config.retryDelay);
      } else {
        // Max retries reached
        console.error(`Failed to send audio chunk #${sequenceNumber} after ${this.config.retryAttempts + 1} attempts`);
        this.failedChunks.push(sequenceNumber);
        
        // If too many chunks are failing, stop transmission
        if (this.failedChunks.length >= 5) {
          console.error('Too many failed chunks, stopping transmission');
          this.handleTransmissionFailure();
        }
      }
    }
  },

  /**
   * Handle persistent transmission failures
   */
  handleTransmissionFailure() {
    console.error('Transmission failed persistently, stopping...');
    
    // Stop transmission
    this.stopTransmission();
    
    // Show error notification to user
    this.showErrorNotification(
      'Voice transmission failed due to connection issues. Please check your network and try again.',
      null
    );
    
    // Reset failed chunks counter
    this.failedChunks = [];
  },

  /**
   * Stop voice transmission (Push-to-Talk released)
   */
  stopTransmission() {
    if (!this.isTransmitting) {
      return;
    }

    console.log('Stopping voice transmission...');

    try {
      // Stop recording
      if (this.audioCapture) {
        this.audioCapture.stopRecording();
      }

      // Clear transmission timer
      if (this.transmissionTimer) {
        clearTimeout(this.transmissionTimer);
        this.transmissionTimer = null;
      }

      // Calculate transmission duration
      const duration = this.transmissionStartTime 
        ? Date.now() - this.transmissionStartTime 
        : 0;

      // Notify server that transmission has ended
      if (this.socket) {
        this.socket.emit('voice_transmission_end', {
          duration: duration,
          timestamp: Date.now()
        });
      }

      // Update state
      this.isTransmitting = false;
      this.transmissionStartTime = null;
      this.sequenceNumber = 0;

      console.log(`Voice transmission stopped (duration: ${duration}ms)`);

    } catch (error) {
      console.error('Error stopping transmission:', error);
      // Force state reset even on error
      this.isTransmitting = false;
      this.transmissionStartTime = null;
      this.transmissionTimer = null;
    }
  },

  /**
   * Handle incoming audio from another player
   * @param {Object} data - Audio data with metadata
   */
  handleIncomingAudio(data) {
    try {
      // Check if voice chat is enabled
      if (!this.isEnabled) {
        console.log('Voice chat disabled, ignoring incoming audio');
        return;
      }

      // Check if initialized
      if (!this.isInitialized || !this.audioPlayback) {
        console.warn('Voice chat not initialized, cannot play audio');
        return;
      }

      // Validate data
      if (!data || !data.audioData) {
        console.warn('Invalid audio data received');
        return;
      }

      // Convert received data to ArrayBuffer if it's a typed array
      let audioData = data.audioData;
      
      // Socket.IO may send as Uint8Array or ArrayBuffer
      // Note: Buffer is Node.js only, in browser it comes as Uint8Array or ArrayBuffer
      if (audioData instanceof Uint8Array) {
        // Convert to ArrayBuffer
        audioData = audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength);
        console.log(`Converted Uint8Array to ArrayBuffer: ${audioData.byteLength} bytes`);
      } else if (audioData instanceof ArrayBuffer) {
        console.log(`Received ArrayBuffer: ${audioData.byteLength} bytes`);
      } else if (ArrayBuffer.isView(audioData)) {
        // Handle other typed array views (Int8Array, etc.)
        audioData = audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength);
        console.log(`Converted typed array to ArrayBuffer: ${audioData.byteLength} bytes`);
      } else {
        console.error('Received audio data in unexpected format:', Object.prototype.toString.call(audioData));
        return;
      }

      // Validate we have actual data
      if (!audioData || audioData.byteLength === 0) {
        console.warn('Received empty audio data after conversion');
        return;
      }

      console.log(`Received audio chunk from ${data.username} (${data.team}): ${audioData.byteLength} bytes, seq: ${data.sequenceNumber}`);

      // Extract metadata
      const metadata = {
        playerId: data.playerId,
        username: data.username || 'Unknown',
        team: data.team || 'unknown',
        timestamp: data.timestamp || Date.now(),
        sequenceNumber: data.sequenceNumber || 0
      };

      // Accumulate chunks for this transmission
      // We'll play the complete audio when transmission ends
      if (!this.incomingTransmissions.has(data.playerId)) {
        this.incomingTransmissions.set(data.playerId, {
          chunks: [],
          metadata: metadata
        });
      }
      
      const transmission = this.incomingTransmissions.get(data.playerId);
      transmission.chunks.push(audioData);
      
      console.log(`Accumulated chunk ${data.sequenceNumber} from ${data.username} (total: ${transmission.chunks.length} chunks)`);
      
    } catch (error) {
      console.error('Error handling incoming audio:', error);
      // Graceful degradation - game continues despite voice chat error
    }
  },

  /**
   * Handle transmission ended - play accumulated audio
   * @param {Object} data - Transmission end data with playerId
   */
  handleTransmissionEnded(data) {
    try {
      if (!data || !data.playerId) {
        console.warn('Invalid transmission ended data');
        return;
      }

      const transmission = this.incomingTransmissions.get(data.playerId);
      
      if (!transmission || transmission.chunks.length === 0) {
        console.log(`No audio chunks to play for player ${data.playerId}`);
        return;
      }

      console.log(`Transmission ended from ${transmission.metadata.username}, combining ${transmission.chunks.length} chunks`);

      // Combine all chunks into a single Blob
      const combinedBlob = new Blob(transmission.chunks, { type: 'audio/webm;codecs=opus' });
      
      console.log(`Combined audio size: ${combinedBlob.size} bytes`);

      // Play the combined audio
      this.playAudioChunk(combinedBlob, transmission.metadata);

      // Clean up
      this.incomingTransmissions.delete(data.playerId);

    } catch (error) {
      console.error('Error handling transmission ended:', error);
      // Clean up even on error
      if (data && data.playerId) {
        this.incomingTransmissions.delete(data.playerId);
      }
    }
  },

  /**
   * Play an audio chunk
   * @param {ArrayBuffer|Blob} audioData - The audio data to play
   * @param {Object} metadata - Metadata about the speaker
   */
  playAudioChunk(audioData, metadata) {
    try {
      if (!this.audioPlayback) {
        console.error('Audio playback not initialized');
        return;
      }

      // Enqueue the audio chunk with metadata
      this.audioPlayback.enqueue(audioData, metadata);
      
      console.log(`Queued audio from ${metadata.username}`);
    } catch (error) {
      console.error('Failed to play audio chunk:', error);
      // Graceful degradation - continue without this chunk
    }
  },

  /**
   * Get current speaker information
   * @returns {Object|null} Current speaker metadata or null if no one is speaking
   */
  getCurrentSpeaker() {
    return this.currentSpeaker;
  },

  /**
   * Check if currently receiving audio
   * @returns {boolean} True if audio is being received/played
   */
  isCurrentlyReceiving() {
    return this.isReceiving;
  },

  /**
   * Toggle voice chat on/off
   * @returns {boolean} New enabled state
   */
  toggleVoiceChat() {
    try {
      this.isEnabled = !this.isEnabled;
      
      console.log(`Voice chat ${this.isEnabled ? 'enabled' : 'disabled'}`);

      // If disabling while transmitting, stop transmission
      if (!this.isEnabled && this.isTransmitting) {
        this.stopTransmission();
      }

      // If disabling while receiving, stop playback
      if (!this.isEnabled && this.audioPlayback) {
        this.audioPlayback.stop();
        this.currentSpeaker = null;
        this.isReceiving = false;
      }

      // Save settings
      this.saveSettings();

      return this.isEnabled;
    } catch (error) {
      console.error('Error toggling voice chat:', error);
      return this.isEnabled;
    }
  },

  /**
   * Set voice chat enabled state
   * @param {boolean} enabled - True to enable, false to disable
   */
  setEnabled(enabled) {
    try {
      if (this.isEnabled === enabled) {
        return; // No change
      }

      this.isEnabled = enabled;
      
      console.log(`Voice chat ${this.isEnabled ? 'enabled' : 'disabled'}`);

      // If disabling while transmitting, stop transmission
      if (!this.isEnabled && this.isTransmitting) {
        this.stopTransmission();
      }

      // If disabling while receiving, stop playback
      if (!this.isEnabled && this.audioPlayback) {
        this.audioPlayback.stop();
        this.currentSpeaker = null;
        this.isReceiving = false;
      }

      // Save settings
      this.saveSettings();
    } catch (error) {
      console.error('Error setting voice chat enabled state:', error);
    }
  },

  /**
   * Get voice chat enabled state
   * @returns {boolean} True if enabled
   */
  getEnabled() {
    return this.isEnabled;
  },

  /**
   * Set playback volume
   * @param {number} level - Volume level from 0.0 (mute) to 1.0 (full volume)
   */
  setVolume(level) {
    try {
      // Clamp volume between 0 and 1
      this.volume = Math.max(0, Math.min(1, level));

      // Update audio playback volume
      if (this.audioPlayback) {
        this.audioPlayback.setVolume(this.volume);
      }

      console.log(`Voice chat volume set to ${(this.volume * 100).toFixed(0)}%`);

      // Save settings
      this.saveSettings();
    } catch (error) {
      console.error('Error setting voice chat volume:', error);
    }
  },

  /**
   * Get current volume level
   * @returns {number} Volume level from 0.0 to 1.0
   */
  getVolume() {
    return this.volume;
  },

  /**
   * Get voice chat status information
   * @returns {Object} Status object with current state
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isEnabled: this.isEnabled,
      isTransmitting: this.isTransmitting,
      isReceiving: this.isReceiving,
      volume: this.volume,
      currentSpeaker: this.currentSpeaker,
      queueSize: this.audioPlayback ? this.audioPlayback.getQueueSize() : 0
    };
  },

  /**
   * Detect if running on a mobile device
   */
  detectMobileDevice() {
    // Check user agent for mobile indicators
    const userAgent = navigator.userAgent.toLowerCase();
    const mobileKeywords = ['android', 'webos', 'iphone', 'ipad', 'ipod', 'blackberry', 'windows phone'];
    const isMobileUA = mobileKeywords.some(keyword => userAgent.includes(keyword));
    
    // Check for touch support
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    
    // Check screen size (consider tablets as mobile for voice chat purposes)
    const isSmallScreen = window.innerWidth <= 1024;
    
    // Device is mobile if it has mobile UA or touch + small screen
    this.isMobile = isMobileUA || (hasTouch && isSmallScreen);
    
    console.log(`Device detected as: ${this.isMobile ? 'Mobile' : 'Desktop'}`);
    
    return this.isMobile;
  },

  /**
   * Set up mobile-specific optimizations
   */
  setupMobileOptimizations() {
    console.log('Setting up mobile optimizations...');
    
    try {
      // Handle page visibility changes (background/foreground transitions)
      this.setupVisibilityChangeHandler();
      
      // Handle audio context resume for mobile browsers
      this.setupAudioContextResumeHandler();
      
      // Adjust audio settings for mobile
      this.adjustMobileAudioSettings();
      
      console.log('Mobile optimizations configured');
    } catch (error) {
      console.error('Error setting up mobile optimizations:', error);
    }
  },

  /**
   * Set up visibility change handler for background/foreground transitions
   */
  setupVisibilityChangeHandler() {
    // Determine the correct visibility API properties
    let hidden, visibilityChange;
    if (typeof document.hidden !== 'undefined') {
      hidden = 'hidden';
      visibilityChange = 'visibilitychange';
    } else if (typeof document.msHidden !== 'undefined') {
      hidden = 'msHidden';
      visibilityChange = 'msvisibilitychange';
    } else if (typeof document.webkitHidden !== 'undefined') {
      hidden = 'webkitHidden';
      visibilityChange = 'webkitvisibilitychange';
    }
    
    if (!visibilityChange) {
      console.warn('Page Visibility API not supported');
      return;
    }
    
    // Create handler function
    this.visibilityChangeHandler = () => {
      if (document[hidden]) {
        // Page is now hidden (app went to background)
        this.handleAppBackground();
      } else {
        // Page is now visible (app came to foreground)
        this.handleAppForeground();
      }
    };
    
    // Add event listener
    document.addEventListener(visibilityChange, this.visibilityChangeHandler, false);
    console.log('Visibility change handler registered');
  },

  /**
   * Handle app going to background
   */
  handleAppBackground() {
    console.log('App went to background');
    this.isInBackground = true;
    
    // Stop any active transmission when going to background
    if (this.isTransmitting) {
      console.log('Stopping transmission due to background transition');
      this.stopTransmission();
      
      // Notify user when they return
      this.showErrorNotification(
        'Voice transmission stopped because the app went to the background.',
        null
      );
    }
    
    // Pause audio playback on mobile to save resources
    if (this.isMobile && this.audioPlayback) {
      this.audioPlayback.pause();
    }
  },

  /**
   * Handle app coming to foreground
   */
  handleAppForeground() {
    console.log('App came to foreground');
    this.isInBackground = false;
    
    // Resume audio context if needed (mobile browsers often suspend it)
    if (this.audioPlayback && this.audioPlayback.audioContext) {
      const audioContext = this.audioPlayback.audioContext;
      
      if (audioContext.state === 'suspended') {
        console.log('Resuming audio context after foreground transition');
        audioContext.resume().then(() => {
          console.log('Audio context resumed successfully');
        }).catch((error) => {
          console.error('Failed to resume audio context:', error);
        });
      }
    }
    
    // Resume audio playback if there are queued chunks
    if (this.isMobile && this.audioPlayback) {
      this.audioPlayback.resume();
    }
  },

  /**
   * Set up audio context resume handler for mobile browsers
   * Mobile browsers require user interaction to start audio context
   */
  setupAudioContextResumeHandler() {
    if (!this.audioPlayback || !this.audioPlayback.audioContext) {
      return;
    }
    
    const audioContext = this.audioPlayback.audioContext;
    
    // Create a handler to resume audio context on user interaction
    this.audioContextResumeHandler = () => {
      if (audioContext.state === 'suspended') {
        console.log('Attempting to resume audio context on user interaction');
        audioContext.resume().then(() => {
          console.log('Audio context resumed successfully');
        }).catch((error) => {
          console.error('Failed to resume audio context:', error);
        });
      }
    };
    
    // Add listeners for various user interaction events
    const interactionEvents = ['touchstart', 'touchend', 'mousedown', 'keydown'];
    interactionEvents.forEach(eventType => {
      document.addEventListener(eventType, this.audioContextResumeHandler, { once: true, passive: true });
    });
    
    console.log('Audio context resume handler registered');
  },

  /**
   * Adjust audio settings for mobile devices
   */
  adjustMobileAudioSettings() {
    // On mobile, use slightly lower bitrate to reduce bandwidth usage
    if (this.isMobile) {
      // Reduce bitrate for mobile networks (still good quality for voice)
      this.config.audioBitsPerSecond = 24000;
      
      // Slightly longer chunk interval to reduce processing overhead
      this.config.chunkInterval = 150;
      
      console.log('Audio settings adjusted for mobile:', {
        bitrate: this.config.audioBitsPerSecond,
        chunkInterval: this.config.chunkInterval
      });
    }
  },

  /**
   * Check if app is currently in background
   * @returns {boolean} True if in background
   */
  isAppInBackground() {
    return this.isInBackground;
  },

  /**
   * Clean up and release all resources
   * Should be called when voice chat is no longer needed (e.g., game end)
   */
  cleanup() {
    try {
      console.log('Cleaning up voice chat resources...');

      // Stop any active transmission
      if (this.isTransmitting) {
        this.stopTransmission();
      }

      // Release audio capture resources
      if (this.audioCapture) {
        this.audioCapture.release();
        this.audioCapture = null;
      }

      // Release audio playback resources
      if (this.audioPlayback) {
        this.audioPlayback.release();
        this.audioPlayback = null;
      }

      // Clear transmission timer
      if (this.transmissionTimer) {
        clearTimeout(this.transmissionTimer);
        this.transmissionTimer = null;
      }

      // Remove mobile-specific event listeners
      if (this.visibilityChangeHandler) {
        // Determine the correct visibility change event name
        let visibilityChange = 'visibilitychange';
        if (typeof document.msHidden !== 'undefined') {
          visibilityChange = 'msvisibilitychange';
        } else if (typeof document.webkitHidden !== 'undefined') {
          visibilityChange = 'webkitvisibilitychange';
        }
        
        document.removeEventListener(visibilityChange, this.visibilityChangeHandler);
        this.visibilityChangeHandler = null;
        console.log('Visibility change handler removed');
      }

      // Clear incoming transmissions
      if (this.incomingTransmissions) {
        this.incomingTransmissions.clear();
      }

      // Reset state
      this.isTransmitting = false;
      this.isReceiving = false;
      this.isInitialized = false;
      this.currentSpeaker = null;
      this.socket = null;
      this.gameState = null;
      this.failedChunks = [];
      this.isMobile = false;
      this.isInBackground = false;
      this.audioContextResumeHandler = null;

      console.log('Voice chat cleanup complete');
    } catch (error) {
      console.error('Error during voice chat cleanup:', error);
      // Force reset state even on error
      this.isTransmitting = false;
      this.isReceiving = false;
      this.isInitialized = false;
      this.currentSpeaker = null;
      this.socket = null;
      this.gameState = null;
      this.failedChunks = [];
      this.isMobile = false;
      this.isInBackground = false;
      this.visibilityChangeHandler = null;
      this.audioContextResumeHandler = null;
    }
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VoiceChat;
}

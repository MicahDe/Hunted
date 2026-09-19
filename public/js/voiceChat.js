/**
 * Voice Chat Manager for HUNTED Game
 *
 * Central coordinator for voice communication. The microphone is off until the
 * player turns it on, and then stays open until they turn it off again. While
 * it is open, audio streams live: small PCM frames go out every ~80ms and
 * receivers start hearing them within a few hundred milliseconds instead of
 * waiting for the speaker to finish.
 */

const VoiceChat = {
  // Settings
  isEnabled: true,
  volume: 1.0,

  // Voice chat belongs to the map screen. Everywhere else - the status screen
  // a player lands on - nobody is heard and the microphone cannot be opened,
  // so reading the game never puts you in the room's conversation.
  isListening: false,

  // Lifecycle
  isInitialized: false,

  // Transmission state machine: 'idle' | 'starting' | 'transmitting'
  state: 'idle',

  // Bumped on every start/stop request so an in-flight start can tell that the
  // microphone was turned off again, and abort instead of opening unattended.
  transmissionGeneration: 0,

  // Audio components
  audioContext: null,
  audioCapture: null,
  audioPlayback: null,

  // Socket.IO connection
  socket: null,

  // Game state reference
  gameState: null,
  localPlayerId: null,

  // Transmission tracking
  transmissionStartTime: null,
  sequenceNumber: 0,
  droppedFrames: 0,

  // True while the trailing frame of a released transmission is being flushed
  flushingTail: false,

  // Promise for an in-flight stop, so a fast re-press waits for it
  pendingStop: null,

  // Listeners
  transmissionStateListeners: [],

  // Configuration
  config: {
    // Wire format for audio frames
    targetSampleRate: 16000,
    frameMs: 80,

    // Receive-side jitter buffer; the main latency knob
    jitterBufferMs: 120,
    maxLeadMs: 1000,
    speakerTimeoutMs: 1500,

    // How long the mic stays warm after being turned off, so turning it back
    // on again is instant
    micIdleReleaseMs: 30000
  },

  // Mobile-specific state
  isMobile: false,
  isInBackground: false,
  visibilityChangeHandler: null,
  audioUnlockHandler: null,

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

    const isHttps = window.location.protocol === 'https:';
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const isSecureContext = isHttps || isLocalhost;

    // getUserMedia is the one hard requirement for talking
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      support.isSupported = false;
      support.missing.push('getUserMedia API');

      if (!isSecureContext) {
        support.requiresHttps = true;
        support.warnings.push('getUserMedia requires HTTPS or localhost');
      }
    }

    // Web Audio API is required for both capture framing and playback
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      support.isSupported = false;
      support.missing.push('Web Audio API');
    } else if (typeof AudioWorkletNode === 'undefined') {
      // Not fatal: capture falls back to ScriptProcessorNode
      support.warnings.push('AudioWorklet unavailable, using ScriptProcessor fallback');
    }

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
   * @param {Object} [playerInfo] - Local player {playerId, username, team}
   * @returns {boolean} True if initialization successful
   */
  init(socket, gameState, playerInfo = null) {
    console.log('Initializing voice chat system...');

    const support = this.checkBrowserSupport();
    if (!support.isSupported) {
      console.error('Voice chat cannot be initialized: Browser not supported');
      return false;
    }

    try {
      this.socket = socket;
      this.gameState = gameState;
      this.localPlayerId =
        (playerInfo && playerInfo.playerId) || (gameState && gameState.playerId) || null;

      this.detectMobileDevice();
      this.loadSettings();

      // Mobile bandwidth is tighter and CPU is slower, so use slightly larger
      // frames. Applied before the audio components read the config.
      if (this.isMobile) {
        this.config.frameMs = 100;
        this.config.jitterBufferMs = 160;
      }

      // One AudioContext shared by capture and playback. Mobile browsers limit
      // how many contexts a page may have, and iOS behaves better with one.
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContextClass();
      console.log(`Voice chat AudioContext: ${this.audioContext.sampleRate} Hz, state ${this.audioContext.state}`);

      this.audioCapture = new AudioCapture({
        audioContext: this.audioContext,
        targetSampleRate: this.config.targetSampleRate,
        frameMs: this.config.frameMs,
        micIdleReleaseMs: this.config.micIdleReleaseMs
      });

      this.audioPlayback = new AudioPlayback(this.audioContext, {
        jitterBufferMs: this.config.jitterBufferMs,
        maxLeadMs: this.config.maxLeadMs,
        speakerTimeoutMs: this.config.speakerTimeoutMs
      });

      this.audioPlayback.setVolume(this.volume);

      // Playback drives the speaking indicators, so they follow what is
      // actually being heard rather than flickering per network packet
      this.audioPlayback.onSpeakerStart((metadata) => {
        console.log(`Now hearing ${metadata.username} (${metadata.team})`);

        if (typeof SpeakerIndicator !== 'undefined' && SpeakerIndicator.addSpeaker) {
          SpeakerIndicator.addSpeaker(metadata);
        }

        if (typeof PlayerListIndicator !== 'undefined' && PlayerListIndicator.showSpeaking) {
          PlayerListIndicator.showSpeaking(metadata.playerId);
        }
      });

      this.audioPlayback.onSpeakerEnd((metadata) => {
        if (typeof SpeakerIndicator !== 'undefined' && SpeakerIndicator.removeSpeaker) {
          SpeakerIndicator.removeSpeaker(metadata.playerId);
        }

        if (typeof PlayerListIndicator !== 'undefined' && PlayerListIndicator.hideSpeaking) {
          PlayerListIndicator.hideSpeaking(metadata.playerId);
        }
      });

      this.audioPlayback.onError((error) => {
        console.error('Playback error:', error);
        // Graceful degradation: drop the frame and keep going
      });

      this.setupVisibilityChangeHandler();
      this.setupAudioUnlockHandler();

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
   * Tell voice chat who the local player is, so their own transmissions are not
   * played back or shown as an incoming speaker.
   * @param {string} playerId
   */
  setLocalPlayerId(playerId) {
    this.localPlayerId = playerId || null;
  },

  /**
   * Load voice chat settings from localStorage
   */
  loadSettings() {
    try {
      const savedSettings = localStorage.getItem('huntedVoiceChatSettings');

      if (savedSettings) {
        const settings = JSON.parse(savedSettings);

        this.isEnabled = settings.enabled !== undefined ? settings.enabled : true;
        this.volume = settings.volume !== undefined ? settings.volume : 1.0;

        console.log('Voice chat settings loaded:', settings);
      } else {
        console.log('No saved voice chat settings found, using defaults');
      }
    } catch (error) {
      console.error('Failed to load voice chat settings:', error);
    }
  },

  /**
   * Save voice chat settings to localStorage
   */
  saveSettings() {
    try {
      localStorage.setItem(
        'huntedVoiceChatSettings',
        JSON.stringify({
          enabled: this.isEnabled,
          volume: this.volume,
          lastUpdated: Date.now()
        })
      );
      console.log('Voice chat settings saved');
    } catch (error) {
      console.error('Failed to save voice chat settings:', error);
    }
  },

  /**
   * Register a listener for transmission state changes, so the microphone
   * button stays in sync when transmission stops for a reason other than the
   * player turning it off (backgrounding, microphone error).
   * @param {Function} listener - Called with ('idle'|'starting'|'transmitting')
   */
  onTransmissionStateChange(listener) {
    if (typeof listener === 'function') {
      this.transmissionStateListeners.push(listener);
    }
  },

  /**
   * @param {string} state
   */
  setState(state) {
    if (this.state === state) {
      return;
    }

    this.state = state;

    this.transmissionStateListeners.forEach((listener) => {
      try {
        listener(state);
      } catch (error) {
        console.error('Transmission state listener failed:', error);
      }
    });
  },

  /**
   * @returns {boolean} True while audio is being sent
   */
  get isTransmitting() {
    return this.state === 'transmitting';
  },

  /**
   * @returns {boolean} True while someone else is being heard
   */
  get isReceiving() {
    return this.audioPlayback ? this.audioPlayback.isCurrentlyPlaying() : false;
  },

  /**
   * Open the microphone and start streaming
   * @returns {Promise<void>}
   */
  async startTransmission() {
    if (!this.isEnabled) {
      console.warn('Voice chat is disabled');
      return;
    }

    if (!this.isListening) {
      console.warn('Voice chat is only live on the map screen');
      return;
    }

    if (!this.isInitialized) {
      console.error('Voice chat not initialized');
      return;
    }

    if (this.state !== 'idle') {
      console.warn(`Ignoring start request while ${this.state}`);
      return;
    }

    // Claim this attempt. stopTransmission() bumps the generation, so if the
    // user turns the microphone off again while we are still waiting for it,
    // we notice below and abort instead of transmitting unattended.
    const generation = ++this.transmissionGeneration;

    this.setState('starting');

    try {
      // Turning the microphone straight back on can land here while the
      // previous stop is still flushing its tail; let it finish so the control
      // events stay in order for receivers.
      if (this.pendingStop) {
        await this.pendingStop.catch(() => {});
      }

      await this.audioPlayback.resume();
      await this.audioCapture.prepare();

      if (generation !== this.transmissionGeneration) {
        console.log('Microphone turned off again before it was ready, aborting');

        // Whoever bumped the generation owns the state now: either a stop that
        // already set it to idle, or a newer press that is starting. Touching
        // it here would cancel that newer press.
        if (this.state === 'idle') {
          this.audioCapture.scheduleIdleRelease();
        }

        return;
      }

      this.sequenceNumber = 0;
      this.droppedFrames = 0;
      this.transmissionStartTime = Date.now();

      this.audioCapture.start(
        (frame, meta) => this.sendFrame(frame, meta),
        (error) => this.handleRecordingError(error)
      );

      // Tell the room before the first frame lands so their indicator is
      // already up when the audio starts
      this.emitToServer('voice_transmission_start', { timestamp: Date.now() });

      this.setState('transmitting');

      console.log('Voice transmission started');
    } catch (error) {
      console.error('Failed to start transmission:', error);

      // Only unwind if this attempt is still the current one
      if (generation === this.transmissionGeneration) {
        this.setState('idle');
        this.handleMicrophoneError(error);
      }

      throw error;
    }
  },

  /**
   * Stop streaming and close the microphone
   * @returns {Promise<void>}
   */
  async stopTransmission() {
    // Cancels any start that is still waiting on the microphone
    this.transmissionGeneration++;

    if (this.state === 'starting') {
      // Nothing was announced to the room yet, so nothing to unwind
      this.setState('idle');
      return;
    }

    if (this.state !== 'transmitting') {
      return;
    }

    console.log('Stopping voice transmission...');

    const duration = this.transmissionStartTime ? Date.now() - this.transmissionStartTime : 0;
    this.transmissionStartTime = null;

    // Leave the transmitting state now so the button updates immediately, but
    // keep sending until the trailing partial frame has been flushed, otherwise
    // the last few milliseconds of speech are lost.
    this.flushingTail = true;
    this.setState('idle');

    this.pendingStop = (async () => {
      try {
        await this.audioCapture.stop();
      } catch (error) {
        console.error('Error stopping capture:', error);
      } finally {
        this.flushingTail = false;
      }

      this.emitToServer('voice_transmission_end', {
        duration: duration,
        timestamp: Date.now()
      });

      console.log(
        `Voice transmission stopped (duration: ${duration}ms, ${this.sequenceNumber} frames sent` +
          (this.droppedFrames ? `, ${this.droppedFrames} dropped` : '') +
          ')'
      );
    })();

    try {
      await this.pendingStop;
    } finally {
      this.pendingStop = null;
    }
  },

  /**
   * Send one PCM frame to the server
   * @param {Int16Array} frame - 16-bit mono PCM samples
   * @param {Object} meta - {sampleRate, final}
   */
  sendFrame(frame, meta) {
    if (this.state !== 'transmitting' && !this.flushingTail) {
      return;
    }

    if (!this.socket || !frame || frame.length === 0) {
      return;
    }

    // Never queue audio for a disconnected socket: by the time it reconnects
    // the audio is stale and would replay as a burst of nonsense.
    if (this.socket.connected === false) {
      this.droppedFrames++;
      return;
    }

    this.sequenceNumber++;

    const payload = {
      audioData: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
      sampleRate: meta && meta.sampleRate ? meta.sampleRate : this.config.targetSampleRate,
      sequenceNumber: this.sequenceNumber,
      timestamp: Date.now()
    };

    // volatile drops rather than buffers if the transport is momentarily down
    const emitter = this.socket.volatile || this.socket;
    emitter.emit('voice_audio_chunk', payload);
  },

  /**
   * Emit a control event, tolerating a missing or disconnected socket
   * @param {string} event
   * @param {Object} payload
   */
  emitToServer(event, payload) {
    if (!this.socket) {
      return;
    }

    try {
      this.socket.emit(event, payload);
    } catch (error) {
      console.error(`Failed to emit ${event}:`, error);
    }
  },

  /**
   * Handle capture errors
   * @param {Error} error - The error that occurred
   */
  handleRecordingError(error) {
    console.error('Audio capture error:', error);

    const wasTransmitting = this.state === 'transmitting';
    this.stopTransmission();

    let message = 'Voice recording failed';
    let shouldDisablePTT = false;

    if (error.errorType === 'DeviceDisconnected') {
      message = 'Microphone was disconnected. Please reconnect it and try again.';
      shouldDisablePTT = true;
    } else if (error.message) {
      message = 'Voice recording error: ' + error.message;
    }

    if (wasTransmitting || shouldDisablePTT) {
      this.showErrorNotification(message, null);
    }

    if (shouldDisablePTT && typeof MicButton !== 'undefined') {
      MicButton.disable();
      console.log('Microphone button disabled due to microphone disconnection');
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

    if (error.errorType === 'NotAllowedError' || error.errorType === 'PermissionDeniedError') {
      message = 'Microphone access denied. Please enable microphone permissions in your browser settings.';
      helpLink = this.getMicrophoneHelpLink();
      shouldDisablePTT = true;
    } else if (error.errorType === 'NotFoundError' || error.errorType === 'DevicesNotFoundError') {
      message = 'No microphone found. Please connect a microphone and try again.';
      shouldDisablePTT = true;
    } else if (error.errorType === 'NotReadableError' || error.errorType === 'TrackStartError') {
      message = 'Microphone is already in use by another application. Please close other apps using the microphone.';
      shouldDisablePTT = false;
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

    this.showErrorNotification(message, helpLink);

    if (shouldDisablePTT && typeof MicButton !== 'undefined') {
      MicButton.disable();
      console.log('Microphone button disabled due to microphone error');
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
    if (typeof UI !== 'undefined' && UI.showNotification) {
      let fullMessage = message;
      if (helpLink) {
        fullMessage += ` <a href="${helpLink}" target="_blank" rel="noopener noreferrer">Learn more</a>`;
      }
      UI.showNotification(fullMessage, 'error');
    } else {
      let fullMessage = message;
      if (helpLink) {
        fullMessage += '\n\nFor help, visit: ' + helpLink;
      }
      alert(fullMessage);
    }
  },

  /**
   * True when an incoming voice event is this player's own audio echoed back
   * @param {Object} data
   * @returns {boolean}
   */
  isOwnTransmission(data) {
    return !!(data && this.localPlayerId && data.playerId === this.localPlayerId);
  },

  /**
   * Someone opened their microphone. Registers them so the indicator appears
   * immediately, before their first audio frame arrives.
   * @param {Object} data - {playerId, username, team}
   */
  handleTransmissionStarted(data) {
    if (!data || !data.playerId || this.isOwnTransmission(data)) {
      return;
    }

    if (!this.isEnabled || !this.isListening || !this.isInitialized || !this.audioPlayback) {
      return;
    }

    this.audioPlayback.noteSpeakerStart({
      playerId: data.playerId,
      username: data.username || 'Unknown',
      team: data.team || 'unknown'
    });
  },

  /**
   * Handle an incoming PCM frame from another player: schedule it for playback
   * straight away.
   * @param {Object} data - Audio frame with metadata
   */
  handleIncomingAudio(data) {
    try {
      if (!this.isEnabled || !this.isListening) {
        return;
      }

      if (!this.isInitialized || !this.audioPlayback) {
        console.warn('Voice chat not initialized, cannot play audio');
        return;
      }

      if (!data || !data.audioData || this.isOwnTransmission(data)) {
        return;
      }

      this.audioPlayback.enqueue(data.audioData, {
        playerId: data.playerId,
        username: data.username || 'Unknown',
        team: data.team || 'unknown',
        sampleRate: data.sampleRate || this.config.targetSampleRate,
        sequenceNumber: data.sequenceNumber || 0,
        timestamp: data.timestamp || Date.now()
      });
    } catch (error) {
      console.error('Error handling incoming audio:', error);
      // Graceful degradation - the game continues regardless
    }
  },

  /**
   * Someone closed their microphone. Anything already buffered keeps playing;
   * the speaker is retired once it has all been heard.
   * @param {Object} data - {playerId}
   */
  handleTransmissionEnded(data) {
    try {
      if (!data || !data.playerId || this.isOwnTransmission(data)) {
        return;
      }

      if (this.audioPlayback) {
        this.audioPlayback.noteSpeakerEnd(data.playerId);
      }
    } catch (error) {
      console.error('Error handling transmission ended:', error);
    }
  },

  /**
   * A player left the game: stop and forget their audio timeline
   * @param {string} playerId
   */
  handlePlayerLeft(playerId) {
    if (this.audioPlayback && playerId) {
      this.audioPlayback.removeSpeaker(playerId);
    }
  },

  /**
   * @returns {Object|null} Metadata for the current speaker, or null
   */
  getCurrentSpeaker() {
    const speakers = this.audioPlayback ? this.audioPlayback.getActiveSpeakers() : [];
    return speakers.length > 0 ? speakers[0] : null;
  },

  /**
   * @returns {Array<Object>} Metadata for everyone currently being heard
   */
  getActiveSpeakers() {
    return this.audioPlayback ? this.audioPlayback.getActiveSpeakers() : [];
  },

  /**
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
    this.setEnabled(!this.isEnabled);
    return this.isEnabled;
  },

  /**
   * Set voice chat enabled state
   * @param {boolean} enabled - True to enable, false to disable
   */
  setEnabled(enabled) {
    try {
      if (this.isEnabled === enabled) {
        return;
      }

      this.isEnabled = enabled;
      console.log(`Voice chat ${this.isEnabled ? 'enabled' : 'disabled'}`);

      if (!this.isEnabled) {
        this.stopTransmission();

        if (this.audioPlayback) {
          this.audioPlayback.stop();
        }

        if (this.audioCapture) {
          this.audioCapture.teardownGraph();
          this.audioCapture.releaseStream();
        }
      }

      this.updateMicAvailability();

      this.saveSettings();
    } catch (error) {
      console.error('Error setting voice chat enabled state:', error);
    }
  },

  /**
   * @returns {boolean} True if enabled
   */
  getEnabled() {
    return this.isEnabled;
  },

  /**
   * Whether this screen hears voice chat at all. The map screen does; the
   * status screen does not, so anything arriving while it is up is dropped
   * rather than queued up to play later.
   * @param {boolean} listening
   */
  setListening(listening) {
    const next = Boolean(listening);

    if (this.isListening === next) {
      return;
    }

    this.isListening = next;
    console.log(`Voice chat ${next ? 'listening' : 'silent'}`);

    if (!next) {
      this.stopTransmission();

      // Drop whatever is queued: coming back to the map should not play a
      // backlog of what was said while it was shut
      if (this.audioPlayback) {
        this.audioPlayback.stop();
      }
    }

    this.updateMicAvailability();
  },

  /**
   * The microphone can only be opened where voice chat is both switched on
   * and being listened to
   */
  updateMicAvailability() {
    if (typeof MicButton !== 'undefined' && MicButton.setAvailable) {
      MicButton.setAvailable(this.isEnabled && this.isListening);
    }
  },

  /**
   * Set playback volume
   * @param {number} level - Volume level from 0.0 (mute) to 1.0 (full volume)
   */
  setVolume(level) {
    try {
      this.volume = Math.max(0, Math.min(1, level));

      if (this.audioPlayback) {
        this.audioPlayback.setVolume(this.volume);
      }

      console.log(`Voice chat volume set to ${(this.volume * 100).toFixed(0)}%`);
      this.saveSettings();
    } catch (error) {
      console.error('Error setting voice chat volume:', error);
    }
  },

  /**
   * @returns {number} Volume level from 0.0 to 1.0
   */
  getVolume() {
    return this.volume;
  },

  /**
   * @returns {Object} Status object with current state
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isEnabled: this.isEnabled,
      state: this.state,
      isTransmitting: this.isTransmitting,
      isReceiving: this.isReceiving,
      volume: this.volume,
      currentSpeaker: this.getCurrentSpeaker(),
      activeSpeakers: this.getActiveSpeakers(),
      framesSent: this.sequenceNumber,
      framesDropped: this.droppedFrames,
      queueSize: this.audioPlayback ? this.audioPlayback.getQueueSize() : 0,
      audioContextState: this.audioContext ? this.audioContext.state : null,
      micOpen: this.audioCapture ? this.audioCapture.isStreamLive() : false
    };
  },

  /**
   * Detect if running on a mobile device
   * @returns {boolean}
   */
  detectMobileDevice() {
    const userAgent = navigator.userAgent.toLowerCase();
    const mobileKeywords = ['android', 'webos', 'iphone', 'ipad', 'ipod', 'blackberry', 'windows phone'];
    const isMobileUA = mobileKeywords.some((keyword) => userAgent.includes(keyword));

    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isSmallScreen = window.innerWidth <= 1024;

    this.isMobile = isMobileUA || (hasTouch && isSmallScreen);

    console.log(`Device detected as: ${this.isMobile ? 'Mobile' : 'Desktop'}`);

    return this.isMobile;
  },

  /**
   * Watch for the app being backgrounded
   */
  setupVisibilityChangeHandler() {
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

    this.visibilityChangeHandler = () => {
      if (document[hidden]) {
        this.handleAppBackground();
      } else {
        this.handleAppForeground();
      }
    };

    document.addEventListener(visibilityChange, this.visibilityChangeHandler, false);
    console.log('Visibility change handler registered');
  },

  /**
   * Handle app going to background
   */
  handleAppBackground() {
    console.log('App went to background');
    this.isInBackground = true;

    // Browsers throttle or suspend a hidden page, so a microphone left open
    // would send nothing useful. Close it and let the button reset.
    if (this.state !== 'idle') {
      console.log('Stopping transmission due to background transition');
      this.stopTransmission();
    }
  },

  /**
   * Handle app coming to foreground
   */
  handleAppForeground() {
    console.log('App came to foreground');
    this.isInBackground = false;

    if (this.audioPlayback) {
      // Anything scheduled while hidden is stale by now
      this.audioPlayback.resetTimelines();
      this.audioPlayback.resume();
    }
  },

  /**
   * Browsers keep an AudioContext suspended until the page sees a user gesture.
   * Keep trying on each interaction until it is actually running, so incoming
   * audio is audible even before this player has turned their microphone on.
   */
  setupAudioUnlockHandler() {
    if (!this.audioContext) {
      return;
    }

    const interactionEvents = ['touchend', 'mousedown', 'keydown'];

    this.audioUnlockHandler = () => {
      if (!this.audioContext || this.audioContext.state === 'running') {
        this.removeAudioUnlockHandler();
        return;
      }

      this.audioContext
        .resume()
        .then(() => {
          if (this.audioContext && this.audioContext.state === 'running') {
            console.log('AudioContext unlocked by user interaction');
            this.removeAudioUnlockHandler();
          }
        })
        .catch((error) => {
          console.warn('Failed to resume audio context:', error);
        });
    };

    interactionEvents.forEach((eventType) => {
      document.addEventListener(eventType, this.audioUnlockHandler, { passive: true });
    });

    console.log('Audio unlock handler registered');
  },

  removeAudioUnlockHandler() {
    if (!this.audioUnlockHandler) {
      return;
    }

    ['touchend', 'mousedown', 'keydown'].forEach((eventType) => {
      document.removeEventListener(eventType, this.audioUnlockHandler);
    });

    this.audioUnlockHandler = null;
  },

  /**
   * @returns {boolean} True if in background
   */
  isAppInBackground() {
    return this.isInBackground;
  },

  /**
   * Clean up and release all resources
   */
  cleanup() {
    try {
      console.log('Cleaning up voice chat resources...');

      if (this.state !== 'idle') {
        this.stopTransmission();
      }

      if (this.audioCapture) {
        this.audioCapture.release();
        this.audioCapture = null;
      }

      if (this.audioPlayback) {
        this.audioPlayback.release();
        this.audioPlayback = null;
      }

      if (this.audioContext && this.audioContext.state !== 'closed') {
        this.audioContext.close().catch((error) => {
          console.warn('Error closing voice chat AudioContext:', error);
        });
      }
      this.audioContext = null;

      if (this.visibilityChangeHandler) {
        let visibilityChange = 'visibilitychange';
        if (typeof document.msHidden !== 'undefined') {
          visibilityChange = 'msvisibilitychange';
        } else if (typeof document.webkitHidden !== 'undefined') {
          visibilityChange = 'webkitvisibilitychange';
        }

        document.removeEventListener(visibilityChange, this.visibilityChangeHandler);
        this.visibilityChangeHandler = null;
      }

      this.removeAudioUnlockHandler();

      this.state = 'idle';
      this.transmissionGeneration++;
      this.isInitialized = false;
      this.isListening = false;
      this.socket = null;
      this.gameState = null;
      this.localPlayerId = null;
      this.transmissionStartTime = null;
      this.sequenceNumber = 0;
      this.droppedFrames = 0;
      this.transmissionStateListeners = [];
      this.isInBackground = false;

      console.log('Voice chat cleanup complete');
    } catch (error) {
      console.error('Error during voice chat cleanup:', error);

      this.state = 'idle';
      this.isInitialized = false;
      this.socket = null;
      this.gameState = null;
    }
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VoiceChat;
}

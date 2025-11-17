/**
 * Push-to-Talk Button Controller
 * Handles PTT button interactions and visual states
 */

const PTTButton = {
  // Button element
  button: null,
  
  // State
  isActive: false,
  isDisabled: false,
  
  // Touch tracking for mobile
  touchIdentifier: null,

  /**
   * Initialize the PTT button
   */
  init() {
    console.log('Initializing PTT button...');
    
    // Get button element
    this.button = document.getElementById('ptt-btn');
    
    if (!this.button) {
      console.error('PTT button element not found');
      return false;
    }

    // Set up event listeners
    this.setupEventListeners();
    
    // Set initial state
    this.updateVisualState();
    
    console.log('PTT button initialized');
    return true;
  },

  /**
   * Set up event listeners for PTT button
   */
  setupEventListeners() {
    // Mouse events (desktop)
    this.button.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.handlePressStart();
    });

    this.button.addEventListener('mouseup', (e) => {
      e.preventDefault();
      this.handlePressEnd();
    });

    this.button.addEventListener('mouseleave', (e) => {
      // If user drags mouse off button while holding, stop transmission
      if (this.isActive) {
        this.handlePressEnd();
      }
    });

    // Touch events (mobile)
    this.button.addEventListener('touchstart', (e) => {
      e.preventDefault();
      
      // Store the first touch identifier
      if (e.changedTouches.length > 0) {
        this.touchIdentifier = e.changedTouches[0].identifier;
        this.handlePressStart();
      }
    }, { passive: false });

    this.button.addEventListener('touchend', (e) => {
      e.preventDefault();
      
      // Check if the released touch matches our stored identifier
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === this.touchIdentifier) {
          this.touchIdentifier = null;
          this.handlePressEnd();
          break;
        }
      }
    }, { passive: false });

    this.button.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      
      // Handle touch cancellation (e.g., system interruption)
      if (this.isActive) {
        this.touchIdentifier = null;
        this.handlePressEnd();
      }
    }, { passive: false });

    // Prevent context menu on long press (mobile)
    this.button.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  },

  /**
   * Handle press start (button pressed down)
   */
  handlePressStart() {
    try {
      // Don't start if disabled or already active
      if (this.isDisabled || this.isActive) {
        return;
      }

      // Check if voice chat is available
      if (typeof VoiceChat === 'undefined') {
        console.error('VoiceChat module not available');
        return;
      }

      // Check if voice chat is enabled
      if (!VoiceChat.isEnabled) {
        console.log('Voice chat is disabled');
        return;
      }

      // Check if app is in background (mobile optimization)
      if (VoiceChat.isAppInBackground && VoiceChat.isAppInBackground()) {
        console.log('Cannot start transmission while app is in background');
        return;
      }

      console.log('PTT button pressed');
      
      // Update state
      this.isActive = true;
      this.updateVisualState();

      // Start voice transmission
      VoiceChat.startTransmission().catch((error) => {
        console.error('Failed to start transmission:', error);
        
        // Show user-friendly error message
        this.handleTransmissionError(error);
        
        // Reset button state
        this.isActive = false;
        this.updateVisualState();
      });
    } catch (error) {
      console.error('Error in PTT button press start:', error);
      // Reset button state on error
      this.isActive = false;
      this.updateVisualState();
    }
  },

  /**
   * Handle press end (button released)
   */
  handlePressEnd() {
    try {
      if (!this.isActive) {
        return;
      }

      console.log('PTT button released');
      
      // Update state
      this.isActive = false;
      this.updateVisualState();

      // Check if voice chat is available
      if (typeof VoiceChat === 'undefined') {
        console.error('VoiceChat module not available');
        return;
      }

      // Stop voice transmission
      VoiceChat.stopTransmission();
    } catch (error) {
      console.error('Error in PTT button press end:', error);
      // Force reset button state on error
      this.isActive = false;
      this.updateVisualState();
    }
  },

  /**
   * Handle transmission errors
   * @param {Error} error - The error that occurred
   */
  handleTransmissionError(error) {
    let message = 'Voice transmission failed';
    
    // Provide specific error messages based on error type
    if (error.name === 'NotAllowedError') {
      message = 'Microphone access denied. Please enable microphone permissions in your browser settings.';
    } else if (error.name === 'NotFoundError') {
      message = 'No microphone found. Please connect a microphone and try again.';
    } else if (error.name === 'NotReadableError') {
      message = 'Microphone is already in use by another application.';
    } else if (error.name === 'OverconstrainedError') {
      message = 'Microphone does not meet requirements.';
    } else if (error.name === 'SecurityError') {
      message = 'Microphone access blocked for security reasons.';
    }

    // Show notification to user
    if (typeof UI !== 'undefined' && UI.showNotification) {
      UI.showNotification(message, 'error');
    } else {
      alert(message);
    }
  },

  /**
   * Update visual state of the button
   */
  updateVisualState() {
    if (!this.button) return;

    // Remove all state classes
    this.button.classList.remove('ptt-idle', 'ptt-active', 'ptt-disabled');

    // Add appropriate state class
    if (this.isDisabled) {
      this.button.classList.add('ptt-disabled');
      this.button.disabled = true;
      this.button.setAttribute('aria-disabled', 'true');
    } else if (this.isActive) {
      this.button.classList.add('ptt-active');
      this.button.disabled = false;
      this.button.setAttribute('aria-disabled', 'false');
      this.button.setAttribute('aria-pressed', 'true');
    } else {
      this.button.classList.add('ptt-idle');
      this.button.disabled = false;
      this.button.setAttribute('aria-disabled', 'false');
      this.button.setAttribute('aria-pressed', 'false');
    }
  },

  /**
   * Enable the PTT button
   */
  enable() {
    this.isDisabled = false;
    this.updateVisualState();
    console.log('PTT button enabled');
  },

  /**
   * Disable the PTT button
   */
  disable() {
    // If currently transmitting, stop first
    if (this.isActive) {
      this.handlePressEnd();
    }
    
    this.isDisabled = true;
    this.updateVisualState();
    console.log('PTT button disabled');
  },

  /**
   * Show the PTT button
   */
  show() {
    if (this.button) {
      this.button.style.display = 'flex';
    }
  },

  /**
   * Hide the PTT button
   */
  hide() {
    if (this.button) {
      this.button.style.display = 'none';
    }
  },

  /**
   * Clean up event listeners and reset state
   */
  cleanup() {
    console.log('Cleaning up PTT button...');
    
    // Stop any active transmission
    if (this.isActive) {
      this.handlePressEnd();
    }

    // Reset state
    this.isActive = false;
    this.isDisabled = false;
    this.touchIdentifier = null;

    console.log('PTT button cleanup complete');
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PTTButton;
}

/**
 * Speaker Indicator Controller
 * Manages the visual indicator showing who is currently speaking
 */

const SpeakerIndicator = {
  // DOM elements
  indicator: null,
  speakerName: null,
  speakerTeam: null,
  
  // State
  isVisible: false,
  currentSpeaker: null,
  fadeOutTimer: null,

  /**
   * Initialize the speaker indicator
   */
  init() {
    console.log('Initializing speaker indicator...');
    
    // Get DOM elements
    this.indicator = document.getElementById('speaker-indicator');
    this.speakerName = this.indicator?.querySelector('.speaker-name');
    this.speakerTeam = this.indicator?.querySelector('.speaker-team');
    
    if (!this.indicator || !this.speakerName || !this.speakerTeam) {
      console.error('Speaker indicator elements not found');
      return false;
    }

    // Ensure indicator is hidden initially
    this.hide();
    
    console.log('Speaker indicator initialized');
    return true;
  },

  /**
   * Show the speaker indicator with speaker information
   * @param {Object} metadata - Speaker metadata (username, team, playerId)
   */
  show(metadata) {
    if (!this.indicator || !metadata) {
      return;
    }

    // Clear any pending fade-out timer
    if (this.fadeOutTimer) {
      clearTimeout(this.fadeOutTimer);
      this.fadeOutTimer = null;
    }

    // Update speaker information
    this.currentSpeaker = metadata;
    
    // Update speaker name
    if (this.speakerName) {
      this.speakerName.textContent = metadata.username || 'Unknown';
    }

    // Update speaker team with appropriate styling
    if (this.speakerTeam) {
      const team = metadata.team || 'unknown';
      this.speakerTeam.textContent = team.charAt(0).toUpperCase() + team.slice(1);
      
      // Remove existing team classes
      this.speakerTeam.classList.remove('team-hunter', 'team-runner', 'team-unknown');
      
      // Add appropriate team class
      this.speakerTeam.classList.add(`team-${team}`);
    }

    // Remove hidden and fading-out classes
    this.indicator.classList.remove('hidden', 'fading-out');
    
    // Mark as visible
    this.isVisible = true;

    console.log(`Speaker indicator shown: ${metadata.username} (${metadata.team})`);
  },

  /**
   * Hide the speaker indicator with fade-out animation
   * @param {number} delay - Delay in milliseconds before hiding (default: 500ms)
   */
  hide(delay = 500) {
    if (!this.indicator || !this.isVisible) {
      return;
    }

    // Clear any existing fade-out timer
    if (this.fadeOutTimer) {
      clearTimeout(this.fadeOutTimer);
    }

    // Set fade-out timer
    this.fadeOutTimer = setTimeout(() => {
      if (!this.indicator) return;

      // Add fading-out class for animation
      this.indicator.classList.add('fading-out');

      // After animation completes, hide completely
      setTimeout(() => {
        if (!this.indicator) return;
        
        this.indicator.classList.add('hidden');
        this.indicator.classList.remove('fading-out');
        this.isVisible = false;
        this.currentSpeaker = null;
        
        console.log('Speaker indicator hidden');
      }, 500); // Match the fade-out animation duration

    }, delay);
  },

  /**
   * Update the speaker indicator when audio is received
   * Called when voice_audio_received event is triggered
   * @param {Object} data - Audio data with metadata
   */
  onAudioReceived(data) {
    if (!data) return;

    const metadata = {
      playerId: data.playerId,
      username: data.username || 'Unknown',
      team: data.team || 'unknown',
      timestamp: data.timestamp || Date.now()
    };

    // Show indicator with speaker info
    this.show(metadata);
  },

  /**
   * Handle transmission start event
   * @param {Object} data - Transmission start data
   */
  onTransmissionStarted(data) {
    if (!data) return;

    const metadata = {
      playerId: data.playerId,
      username: data.username || 'Unknown',
      team: data.team || 'unknown',
      timestamp: data.timestamp || Date.now()
    };

    // Show indicator
    this.show(metadata);
  },

  /**
   * Handle transmission end event
   * @param {Object} data - Transmission end data
   */
  onTransmissionEnded(data) {
    // Hide indicator with 500ms fade-out
    this.hide(500);
  },

  /**
   * Get current speaker information
   * @returns {Object|null} Current speaker metadata or null
   */
  getCurrentSpeaker() {
    return this.currentSpeaker;
  },

  /**
   * Check if indicator is currently visible
   * @returns {boolean} True if visible
   */
  isCurrentlyVisible() {
    return this.isVisible;
  },

  /**
   * Clean up and reset state
   */
  cleanup() {
    console.log('Cleaning up speaker indicator...');
    
    // Clear any pending timers
    if (this.fadeOutTimer) {
      clearTimeout(this.fadeOutTimer);
      this.fadeOutTimer = null;
    }

    // Hide indicator immediately
    if (this.indicator) {
      this.indicator.classList.add('hidden');
      this.indicator.classList.remove('fading-out');
    }

    // Reset state
    this.isVisible = false;
    this.currentSpeaker = null;

    console.log('Speaker indicator cleanup complete');
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SpeakerIndicator;
}

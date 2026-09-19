/**
 * Speaker Indicator Controller
 *
 * Shows who is currently being heard. Tracks a set of speakers rather than a
 * single one, because with live streaming two people can genuinely be talking
 * at the same time and their audio is mixed rather than queued.
 */

const SpeakerIndicator = {
  // DOM elements
  indicator: null,
  speakerName: null,
  speakerTeam: null,

  // playerId -> metadata, in arrival order
  speakers: new Map(),

  // State
  isVisible: false,
  fadeOutTimer: null,
  hideTimer: null,

  /**
   * Initialize the speaker indicator
   * @returns {boolean} True if the elements were found
   */
  init() {
    console.log('Initializing speaker indicator...');

    this.indicator = document.getElementById('speaker-indicator');
    this.speakerName = this.indicator ? this.indicator.querySelector('.speaker-name') : null;
    this.speakerTeam = this.indicator ? this.indicator.querySelector('.speaker-team') : null;

    if (!this.indicator || !this.speakerName || !this.speakerTeam) {
      console.error('Speaker indicator elements not found');
      return false;
    }

    this.speakers.clear();
    this.hideNow();

    console.log('Speaker indicator initialized');
    return true;
  },

  /**
   * Add a speaker and show the indicator
   * @param {Object} metadata - {playerId, username, team}
   */
  addSpeaker(metadata) {
    if (!metadata || !metadata.playerId) {
      return;
    }

    // Re-inserting moves them to the end, making them the primary speaker
    this.speakers.delete(metadata.playerId);
    this.speakers.set(metadata.playerId, {
      playerId: metadata.playerId,
      username: metadata.username || 'Unknown',
      team: metadata.team || 'unknown'
    });

    this.render();
  },

  /**
   * Remove a speaker, hiding the indicator once nobody is left
   * @param {string} playerId
   */
  removeSpeaker(playerId) {
    if (!playerId || !this.speakers.has(playerId)) {
      return;
    }

    this.speakers.delete(playerId);
    this.render();
  },

  /**
   * Remove every speaker immediately
   */
  clear() {
    this.speakers.clear();
    this.hideNow();
  },

  /**
   * Update the indicator to match the current speaker set
   */
  render() {
    if (!this.indicator) {
      return;
    }

    if (this.speakers.size === 0) {
      this.hide(400);
      return;
    }

    const speakers = Array.from(this.speakers.values());
    const primary = speakers[speakers.length - 1];

    this.clearTimers();

    if (this.speakerName) {
      if (speakers.length === 1) {
        this.speakerName.textContent = primary.username;
      } else if (speakers.length === 2) {
        // One to a line: runners who play in pairs already have an "&" in
        // their name, so "A & B" would read as more people than there are
        this.speakerName.textContent = `${speakers[0].username}\n${speakers[1].username}`;
      } else {
        this.speakerName.textContent = `${primary.username} +${speakers.length - 1}`;
      }
    }

    if (this.speakerTeam) {
      const team = speakers.length === 1 ? primary.team : 'unknown';
      const label = speakers.length === 1 ? team.charAt(0).toUpperCase() + team.slice(1) : 'Multiple';

      this.speakerTeam.textContent = label;
      this.speakerTeam.classList.remove('team-hunter', 'team-runner', 'team-unknown');
      this.speakerTeam.classList.add(`team-${team}`);
    }

    this.indicator.classList.remove('hidden', 'fading-out');
    this.isVisible = true;
  },

  /**
   * Show the indicator for a single speaker (kept for direct callers)
   * @param {Object} metadata - Speaker metadata
   */
  show(metadata) {
    this.addSpeaker(metadata);
  },

  /**
   * Hide the speaker indicator with a fade-out animation
   * @param {number} delay - Delay in milliseconds before fading out
   */
  hide(delay = 400) {
    if (!this.indicator || !this.isVisible) {
      return;
    }

    this.clearTimers();

    this.fadeOutTimer = setTimeout(() => {
      this.fadeOutTimer = null;

      if (!this.indicator) {
        return;
      }

      // Someone started talking again during the delay
      if (this.speakers.size > 0) {
        return;
      }

      this.indicator.classList.add('fading-out');

      this.hideTimer = setTimeout(() => {
        this.hideTimer = null;

        if (!this.indicator || this.speakers.size > 0) {
          return;
        }

        this.hideNow();
      }, 500); // Match the fade-out animation duration
    }, delay);
  },

  /**
   * Hide the indicator without animating
   */
  hideNow() {
    this.clearTimers();

    if (!this.indicator) {
      return;
    }

    this.indicator.classList.add('hidden');
    this.indicator.classList.remove('fading-out');
    this.isVisible = false;
  },

  clearTimers() {
    if (this.fadeOutTimer) {
      clearTimeout(this.fadeOutTimer);
      this.fadeOutTimer = null;
    }

    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  },

  /**
   * @returns {Object|null} The most recent speaker, or null
   */
  getCurrentSpeaker() {
    if (this.speakers.size === 0) {
      return null;
    }

    const speakers = Array.from(this.speakers.values());
    return speakers[speakers.length - 1];
  },

  /**
   * @returns {Array<Object>} Every speaker currently shown
   */
  getSpeakers() {
    return Array.from(this.speakers.values());
  },

  /**
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

    this.speakers.clear();
    this.hideNow();

    console.log('Speaker indicator cleanup complete');
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SpeakerIndicator;
}

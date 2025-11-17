/**
 * Player List Speaker Indicator
 * Manages microphone icons next to player names in the game menu
 */

const PlayerListIndicator = {
  // Track currently speaking players
  speakingPlayers: new Set(),

  /**
   * Initialize the player list indicator system
   */
  init() {
    console.log('Initializing player list indicator...');
    return true;
  },

  /**
   * Show speaking indicator for a player
   * @param {string} playerId - The ID of the player who is speaking
   */
  showSpeaking(playerId) {
    if (!playerId) return;

    // Add to speaking players set
    this.speakingPlayers.add(playerId);

    // Find player item in both hunter and runner lists
    const playerItems = document.querySelectorAll('.player-item');
    
    playerItems.forEach((item) => {
      // Check if this item belongs to the speaking player
      const playerIdAttr = item.getAttribute('data-player-id');
      
      if (playerIdAttr === playerId) {
        // Check if icon already exists
        if (!item.querySelector('.player-speaking-icon')) {
          // Create microphone icon
          const icon = this.createSpeakingIcon();
          
          // Insert icon at the beginning of the player item
          item.insertBefore(icon, item.firstChild);
        }
      }
    });

    console.log(`Showing speaking indicator for player: ${playerId}`);
  },

  /**
   * Hide speaking indicator for a player
   * @param {string} playerId - The ID of the player who stopped speaking
   */
  hideSpeaking(playerId) {
    if (!playerId) return;

    // Remove from speaking players set
    this.speakingPlayers.delete(playerId);

    // Find and remove icon from player item
    const playerItems = document.querySelectorAll('.player-item');
    
    playerItems.forEach((item) => {
      const playerIdAttr = item.getAttribute('data-player-id');
      
      if (playerIdAttr === playerId) {
        const icon = item.querySelector('.player-speaking-icon');
        if (icon) {
          icon.remove();
        }
      }
    });

    console.log(`Hiding speaking indicator for player: ${playerId}`);
  },

  /**
   * Create a speaking icon element
   * @returns {SVGElement} The microphone icon SVG element
   */
  createSpeakingIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'player-speaking-icon');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-label', 'Speaking');

    // Microphone path
    const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path1.setAttribute('d', 'M12 14C13.66 14 15 12.66 15 11V5C15 3.34 13.66 2 12 2C10.34 2 9 3.34 9 5V11C9 12.66 10.34 14 12 14Z');
    path1.setAttribute('fill', 'currentColor');

    // Stand path
    const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path2.setAttribute('d', 'M17 11C17 13.76 14.76 16 12 16C9.24 16 7 13.76 7 11H5C5 14.53 7.61 17.43 11 17.92V21H13V17.92C16.39 17.43 19 14.53 19 11H17Z');
    path2.setAttribute('fill', 'currentColor');

    svg.appendChild(path1);
    svg.appendChild(path2);

    return svg;
  },

  /**
   * Update player list with current speaking states
   * Called when player list is refreshed
   */
  refreshIndicators() {
    // Re-apply speaking indicators for all currently speaking players
    this.speakingPlayers.forEach((playerId) => {
      this.showSpeaking(playerId);
    });
  },

  /**
   * Clean up all speaking indicators
   */
  cleanup() {
    console.log('Cleaning up player list indicators...');
    
    // Remove all speaking indicators
    const icons = document.querySelectorAll('.player-speaking-icon');
    icons.forEach((icon) => icon.remove());

    // Clear speaking players set
    this.speakingPlayers.clear();

    console.log('Player list indicator cleanup complete');
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PlayerListIndicator;
}

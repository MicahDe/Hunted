/**
 * Game Logic for HUNTED Game
 */

const Game = {
  // Game state
  gameState: null,

  // Socket connection
  socket: null,

  // Player info
  playerInfo: null,

  // Game settings
  settings: {
    locationUpdateInterval: 30000, // 30 seconds
  },

  // Timer intervals
  timers: {
    gameTimer: null,
    locationTimer: null,
    zoneTimer: null,
  },

  // Initialize the game
  init: function (gameState, socket, initialState) {
    console.log("Initializing game with state:", initialState);
    console.log("Player is on team:", gameState.team);

    // Store references
    this.gameState = { ...initialState }; // Make sure we have the FULL game state
    this.socket = socket;
    this.playerInfo = {
      playerId: gameState.playerId,
      username: gameState.username,
      team: gameState.team,
    };

    // Set up map
    GameMap.initGameMap(initialState.centralLocation.lat, initialState.centralLocation.lng, initialState.playRadius);

    // Initialize UI
    this.initGameUI();

    // Initialize voice chat system
    this.initVoiceChat();

    // Start location timer
    this.startLocationTimer();

    if (initialState.players) {
      initialState.players.forEach((player) => {
        if (player.playerId !== this.playerInfo.playerId) {
          GameMap.updateOtherPlayerLocation(player);
        }
      })
    }

    // Initialize runner locations if available in the game state
    if (initialState.runnerLocationHistory) {
      Object.values(initialState.runnerLocationHistory).forEach((runnerData) => {
        GameMap.updateOtherPlayerLocation(runnerData);
      });
    }

    // Update targets on map
    console.log("Updating targets on map for team:", gameState.team);
    GameMap.updateTargets(initialState.targets, gameState.team);

    // Update zone status display for runners
    if (this.playerInfo && this.playerInfo.team === "runner" && initialState.targets) {
      this.updateZoneStatusDisplay(initialState.targets);
    }
  },

  // Initialize game UI
  initGameUI: function () {
    console.log("Initializing game UI with state:", this.gameState);

    // Set team display and controls
    UI.showTeamControls(this.playerInfo.team);

    // Update player lists in menu
    if (this.gameState.players) {
      UI.updateGamePlayerLists(this.gameState.players);
    }
  },

  // Initialize voice chat system
  initVoiceChat: function () {
    console.log("Initializing voice chat system...");

    // Check if voice chat modules are available
    if (typeof VoiceChat === 'undefined' || typeof PTTButton === 'undefined' || typeof SpeakerIndicator === 'undefined') {
      console.warn("Voice chat modules not available");
      return;
    }

    try {
      // Check browser support first
      const support = VoiceChat.checkBrowserSupport();
      
      if (!support.isSupported) {
        // Show notification to user about unsupported browser
        const missingFeatures = support.missing.join(', ');
        
        // Check if the issue is HTTPS requirement
        const isHttps = window.location.protocol === 'https:';
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        
        let errorMessage = `Voice chat not supported. Missing: ${missingFeatures}`;
        
        // If getUserMedia is missing and not on HTTPS, that's likely the issue
        if (support.missing.includes('getUserMedia API') && !isHttps && !isLocalhost) {
          errorMessage = 'Voice chat requires HTTPS connection. Please access the site via HTTPS to use voice features.';
        }
        
        UI.showNotification(errorMessage, 'warning');
        console.warn("Voice chat not supported:", support.missing);
        console.warn("Protocol:", window.location.protocol, "Hostname:", window.location.hostname);
        return;
      }

      // Initialize voice chat manager with socket and game state
      const voiceChatInitialized = VoiceChat.init(this.socket, this.gameState);
      
      if (!voiceChatInitialized) {
        console.warn("Voice chat initialization failed - browser may not support required features");
        UI.showNotification("Voice chat could not be initialized", "warning");
        return;
      }

      // Initialize PTT button
      PTTButton.init();

      // Initialize speaker indicator
      SpeakerIndicator.init();

      // Initialize player list indicator
      if (typeof PlayerListIndicator !== 'undefined') {
        PlayerListIndicator.init();
      }

      console.log("Voice chat system initialized successfully");
      
      // Load saved settings from localStorage (already done in VoiceChat.init)
      const status = VoiceChat.getStatus();
      console.log("Voice chat settings loaded:", {
        enabled: status.isEnabled,
        volume: status.volume
      });

    } catch (error) {
      console.error("Error initializing voice chat:", error);
      UI.showNotification("Voice chat initialization error", "error");
    }
  },

  // Start location update timer
  startLocationTimer: function () {
    // Clear existing timer
    if (this.timers.locationTimer) {
      clearInterval(this.timers.locationTimer);
    }

    // Start interval
    this.timers.locationTimer = setInterval(() => {
      // Get current location
      if (GameMap.currentLocation) {
        // Emit location update
        this.emitLocationUpdate(GameMap.currentLocation.lat, GameMap.currentLocation.lng);
      }
    }, this.settings.locationUpdateInterval);
  },

  // Emit location update to server
  emitLocationUpdate: function (lat, lng) {
    // Only send if we're in an active game
    if (!this.socket || !this.gameState) return;

    // Emit location update
    this.socket.emit("location_update", {
      lat,
      lng,
    });
  },

  // Update game state
  updateGameState: function (state) {
    console.log("Updating game state:", state);

    // Store new state
    this.gameState = { ...state };

    // Update player lists in menu
    if (state.players) {
      UI.updateGamePlayerLists(state.players);
    }

    // Update targets on map (always call this to ensure targets are properly updated)
    if (this.playerInfo) {
      GameMap.updateTargets(state.targets, this.playerInfo.team);
    }

    // Update zone status display for runners
    if (this.playerInfo && this.playerInfo.team === "runner" && state.targets) {
      this.updateZoneStatusDisplay(state.targets);
    }

    // Check for caught runners
    if (state.players) {
      // Find runners who have been caught
      const caughtRunners = state.players.filter((p) => p.team === "runner" && p.status === "caught");

      // Remove their markers from the map
      caughtRunners.forEach((runner) => {
        GameMap.removeRunnerMarker(runner.playerId);
      });
    }

    // If we're in the lobby, also update the lobby player lists
    if (window.currentScreen === "lobby-screen") {
      if (typeof updatePlayerLists === "function" && state.players) {
        updatePlayerLists(state.players);
      }
    }
  },

  // Update zone status display for runners
  updateZoneStatusDisplay: function (targets) {
    const zoneStatusElement = document.getElementById("zone-status-value");
    if (!zoneStatusElement) return;

    const zoneEnclosingElement = document.getElementById("zone-status-container");
    zoneEnclosingElement.style.display = "block";

    // Find the runner's active targets (filter by player ID and active status)
    const myTargets = targets.filter((target) => target.playerId === this.playerInfo.playerId && target.status === "active");

    if (myTargets.length === 0) {
      zoneStatusElement.textContent = "No Zone";
      zoneStatusElement.classList.remove("zone-active", "zone-inactive", "zone-countdown");
      this.updateZonesRemainingDisplay(null);
      return;
    }

    // Even if somehow there are multiple targets, just use the first one
    const target = myTargets[0];

    // Update zones remaining display
    this.updateZonesRemainingDisplay(target);

    // Target radius levels: [2000, 1000, 500, 250, 125]
    const radiusLevels = [2000, 1000, 500, 250, 125];
    const currentRadiusIndex = radiusLevels.indexOf(target.radiusLevel);
    const nextZoneNumber = currentRadiusIndex + 2; // Next zone (current is index, so +1 for next, +1 for 1-based)

    // If zone is inactive and has an activation time, show countdown with next zone
    if (target.zoneStatus === "inactive" && target.activationTime) {
      const now = Date.now();
      const timeRemaining = Math.max(0, Math.floor((target.activationTime - now) / 1000));

      if (timeRemaining > 0) {
        // Format the time as MM:SS
        const minutes = Math.floor(timeRemaining / 60);
        const seconds = timeRemaining % 60;
        const formattedTime = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

        // Show next zone with lock icon
        zoneStatusElement.textContent = `Zone ${nextZoneNumber}: 🔒 ${formattedTime}`;
        zoneStatusElement.classList.remove("zone-active");
        zoneStatusElement.classList.add("zone-countdown");

        // Start a countdown timer if we don't have one yet
        if (!this.timers.zoneTimer) {
          this.startZoneCountdown(target);
        }
        return;
      }
    }

    // If zone is active or should be active now
    if (target.zoneStatus === "active" || (target.activationTime && Date.now() > target.activationTime)) {
      const nextZoneNumber = currentRadiusIndex + 2;  // Next zone (current is index, so +1 for next, +1 for 1-based)
      zoneStatusElement.textContent = `Zone ${nextZoneNumber}: Unlocked`;
      zoneStatusElement.classList.remove("zone-inactive", "zone-countdown");
      zoneStatusElement.classList.add("zone-active");
    } else {
      zoneStatusElement.textContent = "Zone: Inactive";
      zoneStatusElement.classList.remove("zone-active", "zone-countdown");
      zoneStatusElement.classList.add("zone-inactive");
    }
  },

  // Update zones remaining display for runners
  updateZonesRemainingDisplay: function (target) {
    const zonesRemainingElement = document.getElementById("zones-remaining-value");
    const zonesRemainingContainer = document.getElementById("zones-remaining-container");
    
    if (!zonesRemainingElement || !zonesRemainingContainer) return;

    if (!target) {
      zonesRemainingContainer.style.display = "none";
      return;
    }

    // Show the container
    zonesRemainingContainer.style.display = "block";

    // Target radius levels: [2000, 1000, 500, 250, 125]
    const radiusLevels = [2000, 1000, 500, 250, 125];
    const currentRadiusIndex = radiusLevels.indexOf(target.radiusLevel);
    
    if (currentRadiusIndex === -1) {
      zonesRemainingElement.textContent = "-";
      return;
    }

    // Current zone number (1-based)
    const currentZoneNumber = currentRadiusIndex + 1;
    const totalZones = radiusLevels.length + 1;

    // Show current zone progress
    zonesRemainingElement.textContent = `Zone ${currentZoneNumber} of ${totalZones}`;
  },

  // Start zone countdown timer
  startZoneCountdown: function (target) {
    // Clear any existing timer
    if (this.timers.zoneTimer) {
      clearInterval(this.timers.zoneTimer);
    }

    // Calculate next zone number
    const radiusLevels = [2000, 1000, 500, 250, 125];
    const currentRadiusIndex = radiusLevels.indexOf(target.radiusLevel);
    const nextZoneNumber = currentRadiusIndex + 2; // Next zone (current is index, so +1 for next, +1 for 1-based)

    // Start a countdown timer
    this.timers.zoneTimer = setInterval(() => {
      const zoneStatusElement = document.getElementById("zone-status-value");
      if (!zoneStatusElement) return;

      const now = Date.now();
      const timeRemaining = Math.max(0, Math.floor((target.activationTime - now) / 1000));

      if (timeRemaining > 0) {
        // Format the time as MM:SS
        const minutes = Math.floor(timeRemaining / 60);
        const seconds = timeRemaining % 60;
        const formattedTime = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

        // Show next zone with lock icon
        zoneStatusElement.textContent = `Zone ${nextZoneNumber}: 🔒 ${formattedTime}`;
      } else {
        // Zone is now active - show the zone that just unlocked
        zoneStatusElement.textContent = `Zone ${nextZoneNumber}: Unlocked`;
        zoneStatusElement.classList.remove("zone-inactive", "zone-countdown");
        zoneStatusElement.classList.add("zone-active");

        // Clear the timer
        clearInterval(this.timers.zoneTimer);
        this.timers.zoneTimer = null;
      }
    }, 1000);
  },

  // Update team UI
  updateTeamUI: function (team) {
    // Update team display
    UI.showTeamControls(team);

    // If team changed from runner to hunter
    if (team === "hunter" && this.playerInfo.team === "runner") {
      // Show notification
      UI.showNotification("You have been caught! You are now a Hunter.", "warning");

      // Update player info
      this.playerInfo.team = "hunter";

      // Clear target displays
      Object.keys(GameMap.targetMarkers).forEach((targetId) => {
        GameMap.gameMap.removeLayer(GameMap.targetMarkers[targetId]);
        delete GameMap.targetMarkers[targetId];
      });

      Object.keys(GameMap.targetCircles).forEach((targetId) => {
        GameMap.gameMap.removeLayer(GameMap.targetCircles[targetId]);
        delete GameMap.targetCircles[targetId];
      });
    }
  },

  // End the game
  endGame: function (reason) {
    // Clear timers
    if (this.timers.zoneTimer) {
      clearInterval(this.timers.zoneTimer);
      this.timers.zoneTimer = null;
    }

    if (this.timers.locationTimer) {
      clearInterval(this.timers.locationTimer);
      this.timers.locationTimer = null;
    }

    // Stop location tracking
    GameMap.stopLocationTracking();

    // Clean up voice chat resources
    this.cleanupVoiceChat();

    // Show appropriate game over message
    let gameOverMessage;
    if (reason === "caught") {
      gameOverMessage = "Game Over! All Runners have been caught.";
    } else if (reason === "runners_won") {
      gameOverMessage = "Game Over! Runners have reached their targets.";
    } else {
      gameOverMessage = "Game Over!";
    }

    UI.showNotification(gameOverMessage, "info");
  },

  // Clean up voice chat resources
  cleanupVoiceChat: function () {
    console.log("Cleaning up voice chat...");

    try {
      // Stop any active transmission
      if (typeof VoiceChat !== 'undefined' && VoiceChat.isTransmitting) {
        VoiceChat.stopTransmission();
      }

      // Release microphone stream and clear audio queue
      if (typeof VoiceChat !== 'undefined' && VoiceChat.cleanup) {
        VoiceChat.cleanup();
      }

      // Clean up UI components
      if (typeof PTTButton !== 'undefined' && PTTButton.cleanup) {
        PTTButton.cleanup();
      }

      if (typeof SpeakerIndicator !== 'undefined' && SpeakerIndicator.cleanup) {
        SpeakerIndicator.cleanup();
      }

      if (typeof PlayerListIndicator !== 'undefined' && PlayerListIndicator.cleanup) {
        PlayerListIndicator.cleanup();
      }

      console.log("Voice chat cleanup complete");
    } catch (error) {
      console.error("Error cleaning up voice chat:", error);
      // Continue with game end even if cleanup fails
    }
  },

  // Get current game state
  getGameState: function () {
    return this.gameState;
  },
};

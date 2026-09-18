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
    locationTimer: null,
    statusTimer: null,
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

    // Draw runner trails if available in the game state
    if (initialState.runnerTrails) {
      Object.values(initialState.runnerTrails).forEach((runnerData) => {
        GameMap.updateOtherPlayerLocation(runnerData);
      });
    }

    // Update targets on map
    console.log("Updating targets on map for team:", gameState.team);
    GameMap.updateTargets(initialState.targets, gameState.team, initialState.zoneRadiusLevels);
    GameMap.setShieldStates(initialState.players);

    // Keep the game clock, zone window and shield counting down
    this.startStatusTicker();
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
    if (typeof VoiceChat === 'undefined' || typeof MicButton === 'undefined' || typeof SpeakerIndicator === 'undefined') {
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

      // Initialize voice chat manager with socket, game state and who we are
      // (the local player id lets it ignore its own transmissions echoed back)
      const voiceChatInitialized = VoiceChat.init(this.socket, this.gameState, this.playerInfo);
      
      if (!voiceChatInitialized) {
        console.warn("Voice chat initialization failed - browser may not support required features");
        UI.showNotification("Voice chat could not be initialized", "warning");
        return;
      }

      // Initialize microphone toggle
      MicButton.init();

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
      GameMap.updateTargets(state.targets, this.playerInfo.team, state.zoneRadiusLevels);
    }

    // Shields are public, so the map labels can show who still has one
    if (state.players) {
      GameMap.setShieldStates(state.players);
    }

    this.refreshStatus();

    // Runners who are out lose their runner marker
    if (state.players) {
      state.players.filter((player) => player.status === "caught").forEach((player) => GameMap.removeRunnerMarker(player.playerId));
    }

    // If we're in the lobby, also update the lobby player lists
    if (window.currentScreen === "lobby-screen") {
      if (typeof updatePlayerLists === "function" && state.players) {
        updatePlayerLists(state.players);
      }
    }
  },

  // Everything in the header runs off the game clock, so one ticker keeps the
  // countdowns honest between game states
  startStatusTicker: function () {
    if (this.timers.statusTimer) {
      clearInterval(this.timers.statusTimer);
    }

    this.refreshStatus();
    this.timers.statusTimer = setInterval(() => this.refreshStatus(), 1000);
  },

  // The runner's zone in play, if they still have one
  getMyTarget: function () {
    if (!this.gameState || !this.gameState.targets || !this.playerInfo) return null;

    return this.gameState.targets.find((target) => target.playerId === this.playerInfo.playerId && target.status === "active") || null;
  },

  // My own player row from the last game state
  getMyPlayer: function () {
    if (!this.gameState || !this.gameState.players || !this.playerInfo) return null;

    return this.gameState.players.find((player) => player.playerId === this.playerInfo.playerId) || null;
  },

  // State can arrive before the game screen has been set up, for instance when
  // the first target lands while the lobby is still showing
  refreshStatus: function () {
    if (!this.gameState || !this.playerInfo) return;

    const now = Date.now();
    const isRunner = this.playerInfo && this.playerInfo.team === "runner";

    this.updateGameClock(now);
    this.updateZoneStatusDisplay(now, isRunner);
    this.updateShieldDisplay(now, isRunner);

    // The menu's immunity countdowns only matter while someone is looking
    const menu = document.getElementById("game-menu");

    if (menu && menu.classList.contains("open")) {
      UI.refreshShieldBadges(this.gameState.players);
    }
  },

  // How much of the game is left. The last zone window closes on zero.
  updateGameClock: function (now) {
    const container = document.getElementById("game-clock-container");
    const value = document.getElementById("game-clock-value");
    if (!container || !value) return;

    if (!this.gameState.gameEndTime) {
      container.style.display = "none";
      return;
    }

    const remaining = this.gameState.gameEndTime - now;
    container.style.display = "block";
    value.textContent = zoneUtils.formatCountdown(remaining);

    // The last five minutes of the game
    value.classList.toggle("time-warning", remaining < 5 * 60 * 1000);
  },

  // The zone in play, and how long is left to capture it (or until it opens)
  updateZoneStatusDisplay: function (now, isRunner) {
    const zoneContainer = document.getElementById("zone-status-container");
    const zoneValue = document.getElementById("zone-status-value");
    const zonesContainer = document.getElementById("zones-remaining-container");
    const zonesValue = document.getElementById("zones-remaining-value");
    if (!zoneContainer || !zoneValue || !zonesContainer || !zonesValue) return;

    const target = isRunner ? this.getMyTarget() : null;

    // Hunters have no zones of their own, and neither has a runner who is out
    if (!target) {
      zoneContainer.style.display = "none";
      zonesContainer.style.display = "none";
      return;
    }

    zoneContainer.style.display = "block";
    zonesContainer.style.display = "block";
    zonesValue.textContent = `Zone ${target.zoneNumber} of ${this.gameState.zoneCount}`;

    const status = zoneUtils.zoneStatusAt(now, { openTime: target.windowOpenTime, closeTime: target.windowCloseTime });
    zoneValue.classList.remove("zone-open", "zone-locked", "zone-closing", "zone-captured");

    if (status === "locked") {
      // They captured their last zone, so this one is revealed but not yet open
      zoneValue.textContent = `Zone ${target.zoneNumber}: 🔒 ${zoneUtils.formatCountdown(target.windowOpenTime - now)}`;
      zoneValue.classList.add("zone-locked");
      return;
    }

    if (status === "open") {
      const remaining = target.windowCloseTime - now;
      zoneValue.textContent = `Zone ${target.zoneNumber}: ⏳ ${zoneUtils.formatCountdown(remaining)}`;

      // Under a minute left to reach it, with a life riding on it
      zoneValue.classList.add(remaining < 60 * 1000 ? "zone-closing" : "zone-open");
      return;
    }

    zoneValue.textContent = `Zone ${target.zoneNumber}: missed`;
    zoneValue.classList.add("zone-closing");
  },

  // Your own shield, and the immunity a catch buys you
  updateShieldDisplay: function (now, isRunner) {
    const container = document.getElementById("shield-status-container");
    const value = document.getElementById("shield-status-value");
    if (!container || !value) return;

    const player = this.getMyPlayer();

    // Nothing to show once you are out of the game or have won it
    if (!isRunner || !player || player.status === "caught" || player.status === "won") {
      container.style.display = "none";
      this.updateCaughtButton(null);
      return;
    }

    const shield = zoneUtils.shieldState({ shieldActive: player.shieldActive, immunityUntil: player.immunityUntil }, now);
    container.style.display = "block";
    value.classList.remove("shield-held", "shield-immune", "shield-spent");

    if (shield.immune) {
      value.textContent = `🛡 Immune ${zoneUtils.formatCountdown(shield.immuneMsRemaining)}`;
      value.classList.add("shield-immune");
    } else if (shield.hasShield) {
      value.textContent = "🛡 Shield";
      value.classList.add("shield-held");
    } else {
      value.textContent = "⚠ Last life";
      value.classList.add("shield-spent");
    }

    this.updateCaughtButton(shield);
  },

  // Reporting yourself caught is pointless while you are immune, and the server
  // turns it down anyway
  updateCaughtButton: function (shield) {
    const button = document.getElementById("caught-btn");
    if (!button) return;

    if (shield && shield.immune) {
      button.disabled = true;
      button.textContent = `Immune ${zoneUtils.formatCountdown(shield.immuneMsRemaining)}`;
      return;
    }

    button.disabled = false;
    button.textContent = "I've Been Caught";
  },

  // Update team UI
  updateTeamUI: function (team) {
    // Update team display
    UI.showTeamControls(team);

    // If team changed from runner to hunter
    if (team === "hunter" && this.playerInfo.team === "runner") {
      // Update player info
      this.playerInfo.team = "hunter";

      // A hunter has no zone or shield of their own left to show
      this.refreshStatus();

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
    if (this.timers.statusTimer) {
      clearInterval(this.timers.statusTimer);
      this.timers.statusTimer = null;
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
      if (typeof MicButton !== 'undefined' && MicButton.cleanup) {
        MicButton.cleanup();
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

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
    GameMap.initGameMap(
      initialState.centralLocation.lat,
      initialState.centralLocation.lng
    );

    // Calculate time remaining
    if (initialState.startTime && initialState.gameDuration) {
      const now = Date.now();
      const endTime = initialState.startTime + (initialState.gameDuration * 60 * 1000);
      const timeRemaining = Math.max(0, Math.floor((endTime - now) / 1000));
      this.gameState.timeRemaining = timeRemaining;
    }

    // Initialize UI
    UI.initialized = false; // Force UI initialization
    this.initGameUI();

    // Start timers
    this.startGameTimer();
    this.startLocationTimer();

    // Initialize runner locations if available in the game state
    if (initialState.runnerLocationHistory && gameState.team === "hunter") {
      Object.values(initialState.runnerLocationHistory).forEach(runnerData => {
        GameMap.updateRunnerLocation(runnerData);
      });
    }

    // Update targets on map
    console.log("Updating targets on map for team:", gameState.team);
    GameMap.updateTargets(initialState.targets, gameState.team);
  },

  // Initialize game UI
  initGameUI: function () {
    console.log("Initializing game UI with state:", this.gameState);
    
    // Set team display and controls
    UI.showTeamControls(this.playerInfo.team);
    
    // Update time display
    if (this.gameState.timeRemaining) {
      UI.updateTimeDisplay(this.gameState.timeRemaining);
    }
    
    // Update player lists in menu
    if (this.gameState.players) {
      UI.updateGamePlayerLists(this.gameState.players);
    }

    // Initialize player score display
    if (this.playerInfo.team === "runner") {
      // Find current player in players list to get score
      const playerInfo = this.gameState.players?.find(
        (p) => p.playerId === this.playerInfo.playerId
      );
      UI.updatePlayerScore(playerInfo ? playerInfo.score : 0);
    } else {
      // Hide score for hunters
      UI.updatePlayerScore(0);
    }

    // Set initial target distance for runners
    if (this.playerInfo.team === "runner") {
      this.updateTargetDistance();
    }
    
    // Mark UI as initialized
    UI.initialized = true;
  },

  // Start game timer
  startGameTimer: function () {
    // Clear existing timer
    if (this.timers.gameTimer) {
      clearInterval(this.timers.gameTimer);
    }

    // Set current time
    let timeRemaining = this.gameState.timeRemaining;

    // Update UI
    UI.updateTimeDisplay(timeRemaining);

    // Start interval
    this.timers.gameTimer = setInterval(() => {
      // Decrement time
      timeRemaining -= 1;

      // Update UI
      UI.updateTimeDisplay(timeRemaining);

      // Check if game is over
      if (timeRemaining <= 0) {
        this.endGame("time");
      }
    }, 1000);
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
        this.emitLocationUpdate(
          GameMap.currentLocation.lat,
          GameMap.currentLocation.lng
        );
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
    
    // If time remaining is not explicitly provided, calculate it
    if (!this.gameState.timeRemaining && this.gameState.startTime && this.gameState.gameDuration) {
      const now = Date.now();
      const endTime = this.gameState.startTime + (this.gameState.gameDuration * 60 * 1000);
      this.gameState.timeRemaining = Math.max(0, Math.floor((endTime - now) / 1000));
    }

    // Update target display for runners
    if (this.playerInfo && this.playerInfo.team === "runner") {
      this.updateTargetDistance();
      
      // Find current player in players list to get score
      const playerInfo = state.players?.find(
        (p) => p.playerId === this.playerInfo.playerId
      );
      if (playerInfo) {
        UI.updatePlayerScore(playerInfo.score || 0);
      }
    }

    // Update player lists in menu
    if (state.players) {
      UI.updateGamePlayerLists(state.players);
    }

    // Update targets on map (always call this to ensure targets are properly updated)
    if (this.playerInfo) {
      GameMap.updateTargets(state.targets, this.playerInfo.team);
    }

    // Check for caught runners
    if (state.players) {
      // Find runners who have been caught
      const caughtRunners = state.players.filter(
        (p) => p.team === "runner" && p.status === "caught"
      );

      // Remove their markers from the map
      caughtRunners.forEach((runner) => {
        GameMap.removeRunnerMarker(runner.playerId);
      });
    }
    
    // Update timer display
    if (this.gameState.timeRemaining) {
      UI.updateTimeDisplay(this.gameState.timeRemaining);
    }

    // If we're in the lobby, also update the lobby player lists
    if (window.currentScreen === "lobby-screen") {
      if (typeof updatePlayerLists === "function" && state.players) {
        updatePlayerLists(state.players);
      }
    }
  },

  // Update target distance display
  updateTargetDistance: function () {
    console.log("Updating target distance with game state:", this.gameState);
    
    if (
      !this.gameState ||
      !this.gameState.targets ||
      !GameMap.currentLocation
    ) {
      UI.updateTargetDistance(null);
      return;
    }

    const { lat, lng } = GameMap.currentLocation;

    // Find active targets for this player (not reached)
    const activeTargets = this.gameState.targets.filter(
      t => t.playerId === this.playerInfo.playerId && t.status !== 'reached'
    );
    
    console.log("Active targets:", activeTargets);

    // Calculate distance to closest target
    const closestDistance = GameMap.getClosestTargetDistance(
      lat,
      lng,
      activeTargets
    );
    
    console.log("Closest target distance:", closestDistance);

    // Update UI
    UI.updateTargetDistance(closestDistance);
  },

  // Check proximity to targets
  checkTargetProximity: function (lat, lng) {
    if (!this.gameState || !this.gameState.targets) return;

    // Update target distance display
    this.updateTargetDistance();
  },

  // Update team UI
  updateTeamUI: function (team) {
    // Update team display
    UI.showTeamControls(team);

    // If team changed from runner to hunter
    if (team === "hunter" && this.playerInfo.team === "runner") {
      // Show notification
      UI.showNotification(
        "You have been caught! You are now a Hunter.",
        "warning"
      );

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
    clearInterval(this.timers.gameTimer);
    clearInterval(this.timers.locationTimer);

    // Stop location tracking
    GameMap.stopLocationTracking();

    // Show appropriate game over message
    let gameOverMessage;
    if (reason === "time") {
      gameOverMessage = "Game Over! Time expired.";
    } else if (reason === "caught") {
      gameOverMessage = "Game Over! All Runners have been caught.";
    } else {
      gameOverMessage = "Game Over!";
    }

    UI.showNotification(gameOverMessage, "info");
  },

  // Get current game state
  getGameState: function () {
    return this.gameState;
  },

  // Clean up game
  cleanup: function () {
    // Clear timers
    clearInterval(this.timers.gameTimer);
    clearInterval(this.timers.locationTimer);
    
    // Stop location tracking
    GameMap.stopLocationTracking();
 
    // Clean up map
    GameMap.cleanup();

    // Clear game state
    this.gameState = null;
    this.socket = null;
    this.playerInfo = null;
  },
};

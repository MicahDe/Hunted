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
  init: function (playerInfo, socket, initialState) {
    // Store references
    this.playerInfo = playerInfo;
    this.socket = socket;
    this.gameState = initialState;

    // Initialize map
    GameMap.initGameMap(
      initialState.centralLocation.lat,
      initialState.centralLocation.lng
    );

    // Initialize UI
    this.initGameUI();

    // Start timers
    this.startGameTimer();
    this.startLocationTimer();

    // Update targets on map
    GameMap.updateTargets(initialState.targets, playerInfo.team);
  },

  // Initialize game UI
  initGameUI: function () {
    // Set team display
    UI.showTeamControls(this.playerInfo.team);

    // Update score display
    UI.updateScoreDisplay(
      this.gameState.scores.hunters,
      this.gameState.scores.runners
    );

    // Update time display
    UI.updateTimeDisplay(this.gameState.timeRemaining);

    // Update player lists in menu
    UI.updateGamePlayerLists(this.gameState.players);

    // Set initial target distance for runners
    if (this.playerInfo.team === "runner") {
      this.updateTargetDistance();
    }
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
    // Store new state
    this.gameState = state;

    // Update target display for runners
    if (this.playerInfo.team === "runner") {
      this.updateTargetDistance();
    }

    // Update player lists in menu
    UI.updateGamePlayerLists(state.players);

    // Update targets on map
    GameMap.updateTargets(state.targets, this.playerInfo.team);

    // Check for caught runners
    if (state.players) {
      // Find runners who have been caught
      const caughtRunners = state.players.filter(
        (p) => p.team === "hunter" && p.status === "caught"
      );

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

  // Update target distance display
  updateTargetDistance: function () {
    if (
      !this.gameState ||
      !this.gameState.targets ||
      !GameMap.currentLocation
    ) {
      UI.updateTargetDistance(null);
      return;
    }

    const { lat, lng } = GameMap.currentLocation;

    // Find active targets (not reached)
    const activeTargets = this.gameState.targets.filter((t) => !t.reachedBy);

    // Calculate distance to closest target
    const closestDistance = GameMap.getClosestTargetDistance(
      lat,
      lng,
      activeTargets
    );

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
    let winnerMessage;
    if (reason === "time") {
      // Time expired, check scores
      if (this.gameState.scores.runners > this.gameState.scores.hunters) {
        winnerMessage = "Game Over! Runners win by points.";
      } else if (
        this.gameState.scores.hunters > this.gameState.scores.runners
      ) {
        winnerMessage = "Game Over! Hunters win by points.";
      } else {
        winnerMessage = "Game Over! It's a tie.";
      }
    } else if (reason === "caught") {
      winnerMessage = "Game Over! All Runners have been caught.";
    }

    UI.showNotification(winnerMessage, "info");
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

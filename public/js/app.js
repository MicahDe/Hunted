/**
 * Main Application Logic for HUNTED Game
 */

// Global variables
let currentScreen = "splash-screen";
let socket;
let gameState = {
  roomId: null,
  playerId: null,
  username: null,
  team: null,
  isRoomCreator: false,
};

// Initialize the application
function initApp() {
  // Set up event listeners
  setupEventListeners();

  // Initialize the UI utilities
  UI.init();

  // Initialize the game map
  GameMap.init();

  // Setup Socket.IO connection
  setupSocketConnection();

  // Check for existing session
  checkExistingSession();
}

// Set up all event listeners
function setupEventListeners() {
  // Splash screen buttons
  document.getElementById("create-room-btn").addEventListener("click", () => {
    UI.showScreen("create-room-screen");
  });

  document.getElementById("join-room-btn").addEventListener("click", () => {
    UI.showScreen("join-room-screen");
  });

  // Back buttons
  document.querySelectorAll(".back-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      UI.showScreen("splash-screen");
    });
  });

  // Create room form
  document
    .getElementById("create-room-form")
    .addEventListener("submit", (e) => {
      e.preventDefault();
      createRoom();
    });

  // Join room form
  document.getElementById("join-room-form").addEventListener("submit", (e) => {
    e.preventDefault();
    joinRoom();
  });

  // Team selection buttons
  document.querySelectorAll(".team-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const parentForm = e.currentTarget.closest("form");
      const teamBtns = parentForm.querySelectorAll(".team-btn");
      teamBtns.forEach((b) => b.classList.remove("selected"));
      e.currentTarget.classList.add("selected");
    });
  });

  // Lobby controls
  document
    .getElementById("start-game-btn")
    .addEventListener("click", startGame);
  document
    .getElementById("leave-lobby-btn")
    .addEventListener("click", leaveLobby);
  document
    .getElementById("delete-lobby-btn")
    .addEventListener("click", deleteLobby);

  // Game controls
  document.getElementById("menu-btn").addEventListener("click", () => {
    document.getElementById("game-menu").classList.add("open");
  });

  document.getElementById("close-menu-btn").addEventListener("click", () => {
    document.getElementById("game-menu").classList.remove("open");
  });

  document.getElementById("center-map-btn").addEventListener("click", () => {
    GameMap.centerOnPlayer();
  });

  document
    .getElementById("center-map-runner-btn")
    .addEventListener("click", () => {
      GameMap.centerOnPlayer();
    });

  document
    .getElementById("catch-runner-btn")
    .addEventListener("click", showCatchRunnerDialog);
  document
    .getElementById("caught-btn")
    .addEventListener("click", reportSelfCaught);

  document
    .getElementById("toggle-sound-btn")
    .addEventListener("click", toggleSound);
  document
    .getElementById("leave-game-btn")
    .addEventListener("click", leaveGame);

  // Game over screen
  document
    .getElementById("new-game-btn")
    .addEventListener("click", setupNewGame);
  document
    .getElementById("return-home-btn")
    .addEventListener("click", returnToHome);

  // Handle geolocation permissions
  if ("geolocation" in navigator) {
    navigator.permissions.query({ name: "geolocation" }).then((result) => {
      if (result.state === "denied") {
        UI.showNotification(
          "Location permission is required for this game.",
          "error"
        );
      }
    });
  } else {
    UI.showNotification(
      "Geolocation is not supported by your browser.",
      "error"
    );
  }
}

// Setup Socket.IO connection
function setupSocketConnection() {
  socket = io();

  // Connection events
  socket.on("connect", () => {
    console.log("Connected to server");
  });

  socket.on("disconnect", () => {
    console.log("Disconnected from server");
    UI.showNotification(
      "Disconnected from server. Trying to reconnect...",
      "error"
    );
  });

  socket.on("connect_error", (error) => {
    console.error("Connection error:", error);
    UI.showNotification(
      "Connection error. Please check your internet connection.",
      "error"
    );
  });

  socket.on("error", (data) => {
    console.error("Socket error:", data);
    UI.showNotification(data.message || "An error occurred", "error");
  });

  // Game events
  socket.on("join_success", handleJoinSuccess);
  socket.on("game_state", handleGameState);
  socket.on("player_joined", handlePlayerJoined);
  socket.on("player_disconnected", handlePlayerDisconnected);
  socket.on("runner_location", handleRunnerLocation);
  socket.on("target_reached", handleTargetReached);
  socket.on("runner_caught", handleRunnerCaught);
  socket.on("game_over", handleGameOver);
  socket.on("room_deleted", handleRoomDeleted);
  socket.on("delete_success", handleDeleteSuccess);
  socket.on("game_started", handleGameStarted);
}

// Check for existing session
function checkExistingSession() {
  const savedSession = localStorage.getItem("huntedGameSession");

  if (savedSession) {
    try {
      const session = JSON.parse(savedSession);
      if (session.roomId && session.playerId && session.username) {
        gameState = {
          ...gameState,
          ...session,
        };

        // Attempt to rejoin the game
        UI.showLoading("Rejoining game...");

        // Emit join event with saved data
        socket.emit("join_room", {
          roomName: session.roomName,
          username: session.username,
          team: session.team,
        });
      }
    } catch (error) {
      console.error("Error parsing saved session:", error);
      localStorage.removeItem("huntedGameSession");
    }
  }
}

// Create a new room
function createRoom() {
  const roomName = document.getElementById("room-name").value.trim();
  const username = document.getElementById("creator-username").value.trim();
  const gameDuration = parseInt(document.getElementById("game-duration").value);
  const teamBtn = document.querySelector(
    "#create-room-form .team-btn.selected"
  );

  if (!roomName || !username) {
    return UI.showNotification("Room name and username are required", "error");
  }

  if (!teamBtn) {
    return UI.showNotification("Please select a team", "error");
  }

  const team = teamBtn.dataset.team;

  // Get selected location from map
  const location = GameMap.getSelectedLocation();

  if (!location) {
    return UI.showNotification(
      "Please select a starting location on the map",
      "error"
    );
  }

  // Log the selected location for debugging
  console.log("Selected location:", location);

  // Update game state
  gameState.roomName = roomName;
  gameState.username = username;
  gameState.team = team;
  gameState.isRoomCreator = true;

  // Show loading
  UI.showLoading("Creating room...");

  // Emit socket event to create room
  socket.emit("join_room", {
    roomName,
    username,
    team,
    gameDuration,
    centralLat: location.lat,
    centralLng: location.lng,
  });
}

// Join an existing room
function joinRoom() {
  const roomName = document.getElementById("join-room-name").value.trim();
  const username = document.getElementById("join-username").value.trim();
  const teamBtn = document.querySelector("#join-room-form .team-btn.selected");

  if (!roomName || !username) {
    return UI.showNotification("Room name and username are required", "error");
  }

  if (!teamBtn) {
    return UI.showNotification("Please select a team", "error");
  }

  const team = teamBtn.dataset.team;

  // Update game state
  gameState.roomName = roomName;
  gameState.username = username;
  gameState.team = team;
  gameState.isRoomCreator = false;

  // Show loading
  UI.showLoading("Joining room...");

  // Emit socket event to join room
  socket.emit("join_room", {
    roomName,
    username,
    team,
  });
}

// Handle successful join
function handleJoinSuccess(data) {
  console.log("Join success:", data);

  // Hide loading
  UI.hideLoading();

  // Update game state
  gameState.roomId = data.roomId;
  gameState.playerId = data.playerId;

  // Save session to localStorage
  saveGameSession();

  // Show lobby screen
  UI.showScreen("lobby-screen");

  // Update lobby UI with the provided game state
  if (data.gameState && data.gameState.centralLocation) {
    console.log(
      "Central location from join success:",
      data.gameState.centralLocation
    );
    // Store central location for reference
    gameState.centralLocation = data.gameState.centralLocation;
  }

  updateLobbyUI(data.gameState);

  // Show/hide host-only controls based on whether user is room creator
  document.getElementById("start-game-btn").style.display =
    gameState.isRoomCreator ? "block" : "none";
  document.getElementById("delete-lobby-btn").style.display =
    gameState.isRoomCreator ? "block" : "none";
}

// Update lobby UI with current game state
function updateLobbyUI(state) {
  if (!state) return;

  console.log("Updating lobby UI with state:", state);

  // Set room name
  document.getElementById(
    "lobby-room-name"
  ).textContent = `Room: ${gameState.roomName}`;

  // Set game duration
  document.getElementById(
    "game-duration-display"
  ).textContent = `${state.gameDuration} min`;

  // Set target count
  document.getElementById("target-count-display").textContent = state.targets
    ? state.targets.length
    : "Loading...";

  // Update player lists
  updatePlayerLists(state.players);

  // Initialize lobby map if we have the central location
  if (state.centralLocation) {
    console.log(
      "Initializing lobby map with:",
      state.centralLocation.lat,
      state.centralLocation.lng
    );

    // Store in gameState for future reference
    gameState.centralLocation = state.centralLocation;

    // Wait a small amount of time to ensure the map container is visible
    setTimeout(() => {
      GameMap.initLobbyMap(
        state.centralLocation.lat,
        state.centralLocation.lng
      );
    }, 300);
  } else if (gameState.centralLocation) {
    // Use stored central location as fallback
    console.log(
      "Using stored central location for lobby map:",
      gameState.centralLocation
    );
    setTimeout(() => {
      GameMap.initLobbyMap(
        gameState.centralLocation.lat,
        gameState.centralLocation.lng
      );
    }, 300);
  } else {
    console.warn("No central location available for lobby map");
  }
}

// Update player lists in lobby
function updatePlayerLists(players) {
  if (!players) return;

  const hunterList = document.getElementById("hunter-list");
  const runnerList = document.getElementById("runner-list");

  // Clear lists
  hunterList.innerHTML = "";
  runnerList.innerHTML = "";

  // Filter players by team
  const hunters = players.filter((p) => p.team === "hunter");
  const runners = players.filter((p) => p.team === "runner");

  // Add hunters to list
  hunters.forEach((hunter) => {
    const listItem = document.createElement("li");
    listItem.className = "player-item";
    listItem.innerHTML = `
            <img src="assets/icons/hunter.svg" alt="Hunter" class="player-avatar">
            <span class="player-name">${hunter.username}</span>
        `;
    hunterList.appendChild(listItem);
  });

  // Add runners to list
  runners.forEach((runner) => {
    const listItem = document.createElement("li");
    listItem.className = "player-item";
    listItem.innerHTML = `
            <img src="assets/icons/runner.svg" alt="Runner" class="player-avatar">
            <span class="player-name">${runner.username}</span>
        `;
    runnerList.appendChild(listItem);
  });
}

// Handle new game state
function handleGameState(state) {
  console.log("Received game state:", state);

  // Update UI based on current screen
  if (currentScreen === "lobby-screen") {
    updateLobbyUI(state);
  } else if (currentScreen === "game-screen") {
    Game.updateGameState(state);
  }

  // Check if game has already started
  if (state.status === "active" && currentScreen !== "game-screen") {
    console.log(
      "Game is active but we are not on game screen, transitioning to game UI"
    );
    startGameUI(state);
  }

  // Check if game is over
  if (state.status === "completed" && currentScreen !== "game-over-screen") {
    handleGameOver({
      winner:
        state.scores.runners > state.scores.hunters ? "runners" : "hunters",
      reason: "Game completed",
      gameState: state,
    });
  }
}

// Handle player joined event
function handlePlayerJoined(data) {
  console.log("Player joined:", data);

  // Show notification
  UI.showNotification(`${data.username} joined as ${data.team}`, "info");

  // Request updated game state
  socket.emit("get_game_state", { roomId: gameState.roomId });

  // If we're on the lobby screen, refresh the player lists immediately with this new player
  if (currentScreen === "lobby-screen") {
    // Create a temporary player entry until we get the full game state
    const tempPlayer = {
      username: data.username,
      team: data.team,
      status: "active",
    };

    // Add to the appropriate team list
    const list =
      data.team === "hunter"
        ? document.getElementById("hunter-list")
        : document.getElementById("runner-list");

    if (list) {
      const listItem = document.createElement("li");
      listItem.className = "player-item";
      listItem.innerHTML = `
                <img src="assets/icons/${data.team}.svg" alt="${data.team}" class="player-avatar">
                <span class="player-name">${data.username}</span>
            `;
      list.appendChild(listItem);
    }
  }
}

// Handle player disconnected event
function handlePlayerDisconnected(data) {
  console.log("Player disconnected:", data);

  // Show notification
  UI.showNotification(`${data.username} disconnected`, "info");

  // Request updated game state
  socket.emit("get_game_state", { roomId: gameState.roomId });
}

// Handle runner location update
function handleRunnerLocation(data) {
  console.log("Runner location update:", data);

  // Only process if we're in game screen
  if (currentScreen === "game-screen") {
    // Update runner marker on map
    GameMap.updateRunnerLocation(data);

    // Play sound effect
    if (Game.isSoundEnabled()) {
      Game.playSound("ping");
    }
  }
}

// Handle target reached event
function handleTargetReached(data) {
  console.log("Target reached:", data);

  // Show notification
  UI.showNotification(`${data.username} reached a target!`, "success");

  // Update game state
  Game.updateGameState(data.gameState);

  // Play sound effect
  if (Game.isSoundEnabled()) {
    Game.playSound("target-found");
  }
}

// Handle runner caught event
function handleRunnerCaught(data) {
  console.log("Runner caught:", data);

  // Show notification
  UI.showNotification(`${data.username} has been caught!`, "warning");

  // Check if it's the current player
  if (data.caughtPlayerId === gameState.playerId) {
    // Change team to hunter
    gameState.team = "hunter";
    saveGameSession();

    // Update UI
    Game.updateTeamUI("hunter");
  }

  // Play sound effect
  if (Game.isSoundEnabled()) {
    Game.playSound("caught");
  }

  // Request updated game state
  socket.emit("get_game_state", { roomId: gameState.roomId });
}

// Handle game over event
function handleGameOver(data) {
  console.log("Game over:", data);

  // Show game over screen
  UI.showScreen("game-over-screen");

  // Update game over UI
  updateGameOverUI(data);
}

// Update game over UI
function updateGameOverUI(data) {
  const state = data.gameState;

  // Set winner display
  const winnerDisplay = document.getElementById("winner-display");
  winnerDisplay.textContent = `Winners: ${
    data.winner === "runners" ? "Runners!" : "Hunters!"
  }`;

  // Set score displays
  document.getElementById("final-hunter-score").textContent =
    state.scores.hunters;
  document.getElementById("final-runner-score").textContent =
    state.scores.runners;

  // Set game stats
  document.getElementById(
    "final-duration"
  ).textContent = `${state.gameDuration} min`;

  // Count reached targets
  const targetsReached = state.targets.filter((t) => t.reachedBy).length;
  document.getElementById("targets-reached").textContent = targetsReached;

  // Count caught runners
  const runnersCaught = state.players.filter(
    (p) => p.team === "hunter" && p.status === "caught"
  ).length;
  document.getElementById("runners-caught").textContent = runnersCaught;
}

// Start the game
function startGame() {
  console.log("Starting game...", gameState);

  if (!gameState.isRoomCreator) {
    return UI.showNotification(
      "Only the room creator can start the game",
      "error"
    );
  }

  UI.showLoading("Starting game...");

  // Request server to start the game
  console.log("Emitting start_game event with roomId:", gameState.roomId);
  socket.emit("start_game", { roomId: gameState.roomId });
}

// Handle game started event
function handleGameStarted(data) {
  console.log("Game started:", data);

  // Hide loading
  UI.hideLoading();

  if (!data.gameState) {
    console.error("No game state received from server when starting game");
    UI.showNotification("Error starting game: No game state received", "error");
    return;
  }

  // Start game UI
  startGameUI(data.gameState);
}

// Start game UI - called when the game starts
function startGameUI(state) {
  console.log("Starting game UI with state:", state);

  // Hide loading
  UI.hideLoading();

  // Show game screen
  UI.showScreen("game-screen");

  // Initialize the game
  if (!Game || !Game.init) {
    console.error("Game object or init method not found!");
    UI.showNotification("Error initializing game", "error");
    return;
  }

  try {
    Game.init(gameState, socket, state);
    UI.showNotification("Game started!", "success");
  } catch (error) {
    console.error("Error initializing game:", error);
    UI.showNotification("Error initializing game: " + error.message, "error");
  }
}

// Delete the lobby
function deleteLobby() {
  if (!gameState.isRoomCreator) {
    return UI.showNotification(
      "Only the room creator can delete the lobby",
      "error"
    );
  }

  // Confirm deletion
  if (
    confirm(
      "Are you sure you want to delete this lobby? All players will be disconnected."
    )
  ) {
    UI.showLoading("Deleting lobby...");

    // Emit delete room event
    socket.emit("delete_room", { roomId: gameState.roomId });
  }
}

// Leave the lobby
function leaveLobby() {
  // Clear game state
  resetGameState();

  // Disconnect socket
  socket.disconnect();

  // Reconnect socket for future games
  socket.connect();

  // Go back to splash screen
  UI.showScreen("splash-screen");
}

// Show dialog to catch a runner
function showCatchRunnerDialog() {
  // Get active runners
  const state = Game.getGameState();
  if (!state || !state.players) return;

  const runners = state.players.filter(
    (p) => p.team === "runner" && p.status === "active"
  );

  if (runners.length === 0) {
    return UI.showNotification("No active runners to catch", "info");
  }

  // Create a simple dialog
  const dialogHTML = `
        <div class="menu-section">
            <h4>Select Runner to Catch</h4>
            <div class="menu-options">
                ${runners
                  .map(
                    (runner) => `
                    <button class="menu-option-btn catch-runner-option" data-player-id="${runner.playerId}">
                        ${runner.username}
                    </button>
                `
                  )
                  .join("")}
                <button class="menu-option-btn" id="cancel-catch">Cancel</button>
            </div>
        </div>
    `;

  // Create overlay
  const overlay = document.createElement("div");
  overlay.className = "loading-overlay show";
  overlay.innerHTML = `
        <div class="game-menu" style="position: relative; right: 0; width: 80%; max-width: 300px; border-radius: var(--border-radius-lg);">
            <div class="menu-header">
                <h3>Catch Runner</h3>
                <button class="close-btn" id="close-catch-dialog">×</button>
            </div>
            <div class="menu-content">
                ${dialogHTML}
            </div>
        </div>
    `;

  document.body.appendChild(overlay);

  // Add event listeners
  document
    .getElementById("close-catch-dialog")
    .addEventListener("click", () => {
      document.body.removeChild(overlay);
    });

  document.getElementById("cancel-catch").addEventListener("click", () => {
    document.body.removeChild(overlay);
  });

  // Add event listeners to runner options
  document.querySelectorAll(".catch-runner-option").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const playerId = e.currentTarget.dataset.playerId;
      catchRunner(playerId);
      document.body.removeChild(overlay);
    });
  });
}

// Catch a runner
function catchRunner(playerId) {
  // Emit event to server
  socket.emit("player_caught", {
    caughtPlayerId: playerId,
  });
}

// Report self as caught
function reportSelfCaught() {
  // Create confirm dialog
  if (
    confirm(
      "Are you sure you want to report yourself as caught? This cannot be undone."
    )
  ) {
    // Emit event to server
    socket.emit("player_caught", {
      caughtPlayerId: gameState.playerId,
    });
  }
}

// Toggle sound
function toggleSound() {
  Game.toggleSound();
}

// Leave the game
function leaveGame() {
  // Create confirm dialog
  if (
    confirm(
      "Are you sure you want to leave the game? Your progress will be lost."
    )
  ) {
    // Clear game state
    resetGameState();

    // Disconnect socket
    socket.disconnect();

    // Reconnect socket for future games
    socket.connect();

    // Go back to splash screen
    UI.showScreen("splash-screen");
  }
}

// Setup a new game after game over
function setupNewGame() {
  // Clear game state but keep username
  const username = gameState.username;
  resetGameState();
  gameState.username = username;

  // Go to create room screen
  UI.showScreen("create-room-screen");

  // Pre-fill username
  document.getElementById("creator-username").value = username;
}

// Return to home screen after game over
function returnToHome() {
  // Clear game state
  resetGameState();

  // Go back to splash screen
  UI.showScreen("splash-screen");
}

// Handle room deleted event
function handleRoomDeleted(data) {
  console.log("Room deleted:", data);

  // Show notification
  UI.showNotification("The room has been deleted by the host", "warning");

  // Clear game state
  resetGameState();

  // Go back to splash screen
  UI.showScreen("splash-screen");
}

// Handle delete success event
function handleDeleteSuccess(data) {
  console.log("Delete success:", data);

  // Hide loading
  UI.hideLoading();

  // Show notification
  UI.showNotification("Room deleted successfully", "success");

  // Clear game state
  resetGameState();

  // Go back to splash screen
  UI.showScreen("splash-screen");
}

// Reset game state
function resetGameState() {
  // Save username for convenience
  const username = gameState.username;

  // Reset game state
  gameState = {
    roomId: null,
    playerId: null,
    username,
    team: null,
    isRoomCreator: false,
  };

  // Clear session storage
  localStorage.removeItem("huntedGameSession");
}

// Save game session to localStorage
function saveGameSession() {
  localStorage.setItem("huntedGameSession", JSON.stringify(gameState));
}

// Get current game state - utility function accessible to other modules
window.Game = window.Game || {};
window.Game.getGameState = function () {
  return gameState;
};

// Initialize app when DOM is loaded
document.addEventListener("DOMContentLoaded", initApp);

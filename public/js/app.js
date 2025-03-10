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
  document
    .getElementById("return-game-btn")
    .addEventListener("click", returnToGame);

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
    .getElementById("caught-btn")
    .addEventListener("click", reportSelfCaught);

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
    UI.hideLoading();
    UI.showNotification(
      "Disconnected from server. Trying to reconnect...",
      "error"
    );
  });

  socket.on("connect_error", (error) => {
    console.error("Connection error:", error);
    UI.hideLoading();
    UI.showNotification(
      "Connection error. Please check your internet connection.",
      "error"
    );
  });

  socket.on("error", (data) => {
    console.error("Socket error:", data);
    UI.hideLoading();
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
        
        // If the game was active before reload, request the game state
        // The handleGameState function will redirect to the game screen if needed
        if (session.gameStatus === "active") {
          console.log("Game was active, requesting current state");
          socket.emit("resync_game_state", { roomId: session.roomId });
        }
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
  socket.emit("create_room",{
    roomName,
    username,
    team,
    gameDuration,
    centralLat: location.lat,
    centralLng: location.lng,
  });

  socket.on("room_created", (data) => {
    console.log("Room created:", data);

    socket.emit("join_room", {
      roomName: data.roomName,
      username,
      team,
    });
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
  currentScreen = "lobby-screen";

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
  const roomNameElement = document.getElementById("lobby-room-name");
  roomNameElement.textContent = `Room: ${state.roomName}`;

  // Update player lists
  if (state.players) {
    updatePlayerLists(state.players);
  }

  // Update game settings
  const durationElement = document.getElementById("game-duration-display");
  if (durationElement) {
    durationElement.textContent = `${state.gameDuration} min`;
  }

  const targetCountElement = document.getElementById("target-count-display");
  if (targetCountElement && state.targets) {
    targetCountElement.textContent = `${state.targets.length}`;
  }

  // Update lobby map
  if (state.centralLocation) {
    GameMap.initLobbyMap(state.centralLocation.lat, state.centralLocation.lng);
  }
  
  // Show/hide buttons based on game status
  const startGameBtn = document.getElementById("start-game-btn");
  const returnGameBtn = document.getElementById("return-game-btn");
  
  if (state.status === "active") {
    startGameBtn.style.display = "none";
    returnGameBtn.style.display = "block";
  } else {
    startGameBtn.style.display = gameState.isRoomCreator ? "block" : "none";
    returnGameBtn.style.display = "none";
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

  // Update game status in our local state
  gameState.gameStatus = state.status;
  saveGameSession();

  // Update UI based on current screen
  if (currentScreen === "lobby-screen") {
    updateLobbyUI(state);
  } else if (currentScreen === "game-screen") {
    Game.updateGameState(state);
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

  if (gameState.roomId) {
    // Request updated game state
    socket.emit("resync_game_state", { roomId: gameState.roomId });
  }
}

// Handle player disconnected event
function handlePlayerDisconnected(data) {
  console.log("Player disconnected:", data);

  // Show notification
  UI.showNotification(`${data.username} disconnected`, "info");

  // Request updated game state
  socket.emit("resync_game_state", { roomId: gameState.roomId });
}

// Handle runner location update
function handleRunnerLocation(data) {
  console.log("Runner location:", data);

  // Only process if we're in game screen
  if (currentScreen === "game-screen") {
    // Update runner marker on map
    GameMap.updateRunnerLocation(data);
  }
}

// Handle target reached event
function handleTargetReached(data) {
  console.log("Target reached:", data);

  // Show notification
  UI.showNotification(`${data.username} reached a target!`, "success");

  // Update game state
  Game.updateGameState(data.gameState);
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

  // Request updated game state
  socket.emit("resync_game_state", { roomId: gameState.roomId });
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
  
  // Update current screen variable
  currentScreen = "game-screen";
  
  // Update game state with game status
  gameState.gameStatus = state.status;
  
  // Save session to localStorage with updated status
  saveGameSession();

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

  // Hide loading indicator
  UI.hideLoading();

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

// Function to return to an active game from the lobby
function returnToGame() {
  // Show game screen
  UI.showScreen("game-screen");
  
  // Update current screen variable
  currentScreen = "game-screen";
  
  // Request the latest game state
  socket.emit("resync_game_state", { roomId: gameState.roomId });
}

// Initialize app when DOM is loaded
document.addEventListener("DOMContentLoaded", initApp);

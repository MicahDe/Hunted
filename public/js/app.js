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

function initApp() {
  setupAllEventListeners();
  UI.init();
  GameMap.init();
  setupSocketConnection();
  checkForExistingSession();
}

function setupAllEventListeners() {
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
      uekg;
    });
  });

  // Create room form
  document.getElementById("create-room-form").addEventListener("submit", (e) => {
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
  document.getElementById("start-game-btn").addEventListener("click", startGame);
  document.getElementById("leave-lobby-btn").addEventListener("click", leaveLobby);
  document.getElementById("delete-lobby-btn").addEventListener("click", deleteLobby);
  document.getElementById("return-game-btn").addEventListener("click", returnToActiveGame);

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

  document.getElementById("center-map-runner-btn").addEventListener("click", () => {
    GameMap.centerOnPlayer();
  });

  document.getElementById("caught-btn").addEventListener("click", reportSelfCaught);

  document.getElementById("leave-game-btn").addEventListener("click", leaveGame);

  // Game over screen
  document.getElementById("new-game-btn").addEventListener("click", setupNewGame);
  document.getElementById("return-home-btn").addEventListener("click", returnToHome);

  // Handle geolocation permissions
  if ("geolocation" in navigator) {
    navigator.permissions.query({ name: "geolocation" }).then((result) => {
      if (result.state === "denied") {
        UI.showNotification("Location permission is required for this game.", "error");
      }
    });
  } else {
    UI.showNotification("Geolocation is not supported by your browser.", "error");
  }
}

// Setup Socket.IO connection
function setupSocketConnection() {
  socket = io();

  // Connection events
  socket.on("connect", () => {
    console.log("Connected to server");
    localStorage.removeItem("reloadAttempts");
  });

  socket.on("disconnect", (reason) => {
    const reloadAttempts = parseInt(localStorage.getItem("reloadAttempts")) || 0;

    if (reloadAttempts < 3) {
      UI.showLoading("Attempting to reconnect...");
      localStorage.setItem("reloadAttempts", (reloadAttempts + 1).toString());
      window.location.reload();
    } else {
      console.log("Disconnected from server", reason);
      UI.hideLoading();
      UI.showNotification("Disconnected from server. Please refresh the page.", "error");
      localStorage.removeItem("reloadAttempts");
    }
  });

  socket.on("connect_error", (error) => {
    console.error("Connection error:", error);
    UI.hideLoading();
    UI.showNotification("Connection error. Please check your internet connection.", "error");
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
  socket.on("new_target", handleNewTarget);
  socket.on("target_radius_update", handleTargetRadiusUpdate);
  socket.on("zone_activated", handleZoneActivated);
  socket.on("runner_won", handleRunnerWon);
}

// Check for existing session
function checkForExistingSession() {
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
  const zoneActivationDelay = parseInt(document.getElementById("zone-activation-delay").value);
  const playRadius = parseInt(document.getElementById("play-radius").value);
  const teamBtn = document.querySelector("#create-room-form .team-btn.selected");

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
    return UI.showNotification("Please select a starting location on the map", "error");
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
  socket.emit("create_room", {
    roomName,
    username,
    team,
    zoneActivationDelay,
    playRadius,
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

  // If game is active, go directly to game screen
  if (data.gameState && data.gameState.status === "active") {
    startGameUI(data.gameState);
    return;
  }

  // Show lobby screen
  UI.showScreen("lobby-screen");
  currentScreen = "lobby-screen";

  // Update lobby UI with the provided game state
  if (data.gameState && data.gameState.centralLocation) {
    console.log("Central location from join success:", data.gameState.centralLocation);
    // Store central location for reference
    gameState.centralLocation = data.gameState.centralLocation;
  }

  updateLobbyUI(data.gameState);

  // Show/hide host-only controls based on whether user is room creator
  document.getElementById("start-game-btn").style.display = gameState.isRoomCreator ? "block" : "none";
  document.getElementById("delete-lobby-btn").style.display = gameState.isRoomCreator ? "block" : "none";
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
  const zoneDelayElement = document.getElementById("zone-activation-delay-display");
  if (zoneDelayElement) {
    zoneDelayElement.textContent = `${state.zoneActivationDelay} sec`;
  }

  // Update play radius display
  const playRadiusElement = document.getElementById("play-radius-display");
  if (playRadiusElement && state.playRadius) {
    // Convert meters to kilometers for display
    const radiusInKm = (state.playRadius / 1000).toFixed(1);
    playRadiusElement.textContent = `${radiusInKm}km radius`;
  }

  // Update lobby map only if the player is a hunter
  if (state.centralLocation && gameState.team === "hunter") {
    GameMap.initLobbyMap(state.centralLocation.lat, state.centralLocation.lng, state.playRadius);
    // Hide runner message
    const runnerMessage = document.getElementById("runner-map-message");
    if (runnerMessage) {
      runnerMessage.style.display = "none";
    }
  } else {
    // Hide the lobby map container for runners
    const mapContainer = document.getElementById("lobby-map");
    if (mapContainer) {
      mapContainer.style.display = "none";
    }
    // Show runner message
    const runnerMessage = document.getElementById("runner-map-message");
    if (runnerMessage) {
      runnerMessage.style.display = "block";
    }
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
    if (!Game.gameState) {
      // Game not initialized yet, do full initialization
      Game.init(gameState, socket, state);
    } else {
      // Ensure we always update the game state
      Game.updateGameState(state);
    }
  }

  if (state.status === "completed" && currentScreen !== "game-over-screen") {
    handleGameOver({
      gameState: state,
    });
  }
}

function handlePlayerJoined(data) {
  console.log("Player joined:", data);

  // Show notification
  UI.showNotification(`${data.username} joined as ${data.team}`, "info");

  if (gameState.roomId) {
    // Request updated game state
    socket.emit("resync_game_state", { roomId: gameState.roomId });
  }
}

function handlePlayerDisconnected(data) {
  console.log("Player disconnected:", data);
  UI.showNotification(`${data.username} disconnected`, "info");
  socket.emit("resync_game_state", { roomId: gameState.roomId });
}

function handleRunnerLocation(data) {
  if (currentScreen === "game-screen") {
    // Update player marker on map
    GameMap.updateOtherPlayerLocation(data);
  }
}

// Handle target reached event
function handleTargetReached(data) {
  console.log("Target reached:", data);
  UI.showNotification(`${data.username} reached a target!`, "success");
  Game.updateGameState(data.gameState);
}

// Handle new target event
function handleNewTarget(data) {
  console.log("New target received:", data);
  if (data.target) {
    UI.showNotification("New target available!", "info");
    Game.updateGameState(data.gameState);
  }
}

// Handle target radius update event
function handleTargetRadiusUpdate(data) {
  console.log("Target radius updated:", data);

  // Display the points earned notification if points were earned
  if (data.pointsValue && data.earnedPoints) {
    UI.showNotification(`You earned ${data.earnedPoints} points! Target is getting smaller!`, "success");
  } else {
    UI.showNotification("Zone captured! New zone has been revealed...", "info");
  }

  // Update game state
  Game.updateGameState(data.gameState);
}

function handleRunnerCaught(data) {
  console.log("Runner caught:", data);
  UI.showNotification(`${data.username} has been caught!`, "warning");

  // Check if we're the caught player
  if (data.caughtPlayerId === gameState.playerId) {
    // Change our team to hunter
    gameState.team = "hunter";
    saveGameSession();
    Game.updateTeamUI("hunter");
  }

  socket.emit("resync_game_state", { roomId: gameState.roomId });
}

function handleGameOver(data) {
  console.log("Game over:", data);
  UI.showScreen("game-over-screen");
  updateGameOverUI(data);
}

function updateGameOverUI(data) {
  const state = data.gameState;

  // Set game stats
  document.getElementById("final-duration").textContent = `${state.gameDuration} min`;

  // Count reached targets
  const targetsReached = state.targets.filter((t) => t.reachedBy).length;
  document.getElementById("targets-reached").textContent = targetsReached;

  // Count caught runners
  const runnersCaught = state.players.filter((p) => p.team === "runner" && p.status === "caught").length;
  document.getElementById("runners-caught").textContent = runnersCaught;

  // Populate all player scores
  const allPlayerScoresList = document.getElementById("all-player-scores-list");
  if (allPlayerScoresList) {
    allPlayerScoresList.innerHTML = "";

    // Sort all players by score (highest first)
    const allPlayers = [...state.players].sort((a, b) => (b.score || 0) - (a.score || 0));

    if (allPlayers.length === 0) {
      // No players in the game (shouldn't happen)
      const noPlayers = document.createElement("div");
      noPlayers.textContent = "No players in this game";
      allPlayerScoresList.appendChild(noPlayers);
    } else {
      // Add each player's score
      allPlayers.forEach((player) => {
        const scoreItem = document.createElement("div");
        scoreItem.className = `player-score-item ${player.team}`;

        // Left side: player name and team
        const playerInfo = document.createElement("div");
        playerInfo.className = "player-info";

        const playerName = document.createElement("span");
        playerName.className = "player-name";
        playerName.textContent = player.username;

        const playerTeam = document.createElement("span");
        playerTeam.className = "player-team";
        playerTeam.textContent = `(${player.team})`;

        playerInfo.appendChild(playerName);
        playerInfo.appendChild(playerTeam);

        // Right side: player score
        const playerScore = document.createElement("span");
        playerScore.className = "player-score";
        playerScore.textContent = player.score || 0;

        scoreItem.appendChild(playerInfo);
        scoreItem.appendChild(playerScore);
        allPlayerScoresList.appendChild(scoreItem);
      });
    }
  }
}

function startGame() {
  console.log("Starting game...", gameState);

  if (!gameState.isRoomCreator) {
    return UI.showNotification("Only the room creator can start the game", "error");
  }

  UI.showLoading("Starting game...");

  // Request server to start the game
  console.log("Emitting start_game event with roomId:", gameState.roomId);
  socket.emit("start_game", { roomId: gameState.roomId });
}

// We have received the game start event from the server
function handleGameStarted(data) {
  console.log("Game started:", data);
  UI.hideLoading();
  if (!data.gameState) {
    console.error("No game state received from server when starting game");
    UI.showNotification("Error starting game: No game state received", "error");
    return;
  }
  startGameUI(data.gameState);
}

function startGameUI(state) {
  console.log("Starting game UI with state:", state);
  UI.hideLoading();
  UI.showScreen("game-screen");
  currentScreen = "game-screen";
  gameState.gameStatus = state.status;
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

function deleteLobby() {
  if (!gameState.isRoomCreator) {
    return UI.showNotification("Only the room creator can delete the lobby", "error");
  }

  if (confirm("Are you sure you want to delete this lobby? All players will be disconnected.")) {
    UI.showLoading("Deleting lobby...");
    socket.emit("delete_room", { roomId: gameState.roomId });
  }
}

function leaveLobby() {
  resetGameState();
  socket.disconnect();

  // Reconnect socket for future games
  socket.connect();
  UI.showScreen("splash-screen");
}

function reportSelfCaught() {
  if (confirm("Are you sure you want to report yourself as caught? This cannot be undone.")) {
    socket.emit("player_caught", {
      caughtPlayerId: gameState.playerId,
    });
  }
}

function leaveGame() {
  if (confirm("Are you sure you want to leave the game? Your progress will be lost.")) {
    resetGameState();
    socket.disconnect();

    // Reconnect socket for future games
    socket.connect();
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
  resetGameState();
  UI.showScreen("splash-screen");
}

function handleRoomDeleted(data) {
  console.log("Room deleted:", data);
  UI.hideLoading();
  UI.showNotification("The room has been deleted by the host", "warning");
  resetGameState();
  UI.showScreen("splash-screen");
}

function handleDeleteSuccess(data) {
  console.log("Delete success:", data);
  UI.hideLoading();
  UI.showNotification("Room deleted successfully", "success");
  resetGameState();
  UI.showScreen("splash-screen");
}

function resetGameState() {
  // Save username for convenience
  const username = gameState.username;

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
function returnToActiveGame() {
  UI.showScreen("game-screen");
  currentScreen = "game-screen";
  // Request the latest game state
  socket.emit("resync_game_state", { roomId: gameState.roomId });
}

// Handle zone activated event
function handleZoneActivated(data) {
  console.log("Zone activated:", data);
  UI.showNotification("A zone has been activated! You can now capture it.", "success");

  // Update game state with the latest data
  Game.updateGameState(data.gameState);
}

// Handle runner won event
function handleRunnerWon(data) {
  console.log("Runner won:", data);
  UI.showNotification(`${data.username} has reached their target and won!`, "success");

  // Request updated game state
  socket.emit("resync_game_state", { roomId: gameState.roomId });
}

document.addEventListener("DOMContentLoaded", initApp);

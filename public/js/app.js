/**
 * Main Application Logic for HUNTED Game
 */

// Global variables. The screen on show is tracked by UI.showScreen as
// window.currentScreen.
let socket;
let gameState = {
  roomId: null,
  playerId: null,
  username: null,
  team: null,
  isRoomCreator: false,
};

// Whether the server has this connection down as being in our room. It goes
// false whenever the connection drops, and true again once we have rejoined,
// so nothing is sent for a room the server doesn't know we are in yet.
let roomJoined = false;

// A create or join the server hasn't answered yet, so a second tap can't send
// another
let requestInFlight = false;

// A catch report the server hasn't answered yet
let catchReportPending = false;

function initApp() {
  setupAllEventListeners();
  UI.init();
  GameMap.init();
  restoreSession();
  setupSocketConnection();
}

// Is this device in a room the server knows about, right now?
function isInRoom() {
  return Boolean(socket && socket.connected && roomJoined);
}

// Game code sends pings through this, so it only does so while we are in
window.isInRoom = isInRoom;

function hasSession() {
  return Boolean(gameState.roomId && gameState.playerId);
}

// A game being played is shown on two screens: the status screen, which tells
// you everything but where anything is, and the map, which pings your location
function inGameScreen(screen = window.currentScreen) {
  return screen === "status-screen" || screen === "game-screen";
}

function setupAllEventListeners() {
  // Splash screen buttons
  document.getElementById("create-room-btn").addEventListener("click", () => {
    UI.showScreen("create-room-screen");
  });

  document.getElementById("join-room-btn").addEventListener("click", () => {
    UI.showScreen("join-room-screen");
  });

  document.getElementById("help-btn").addEventListener("click", () => {
    window.location.href = "help.html";
  });

  // Back buttons. The replay screen goes back to the game over screen, not home.
  document.querySelectorAll(".back-btn:not(.replay-back)").forEach((btn) => {
    btn.addEventListener("click", () => {
      UI.showScreen("splash-screen");
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
  document.getElementById("lobby-help-btn").addEventListener("click", () => {
    window.location.href = "help.html";
  });
  document.getElementById("leave-lobby-btn").addEventListener("click", leaveLobby);
  document.getElementById("delete-lobby-btn").addEventListener("click", deleteLobby);
  document.getElementById("return-game-btn").addEventListener("click", returnToActiveGame);

  // The host's remove buttons live inside the player lists, which are rebuilt
  // on every update
  ["hunter-list", "runner-list"].forEach((listId) => {
    document.getElementById(listId).addEventListener("click", (e) => {
      const button = e.target.closest(".remove-player-btn");

      if (button) {
        removePlayer(button.dataset.playerId, button.dataset.username);
      }
    });
  });

  // Game controls. The menu opens from the status screen and the map alike.
  ["menu-btn", "status-menu-btn"].forEach((id) => {
    document.getElementById(id).addEventListener("click", () => {
      document.getElementById("game-menu").classList.add("open");
      // Update voice chat settings display when menu opens
      updateVoiceChatSettingsDisplay();
    });
  });

  // The map is the only screen that shares where you are, so it is opened by
  // hand rather than being where a game drops you
  document.getElementById("open-map-btn").addEventListener("click", () => {
    Game.openMap();
  });

  document.getElementById("close-map-btn").addEventListener("click", () => {
    Game.closeMap();
  });

  document.getElementById("close-menu-btn").addEventListener("click", () => {
    document.getElementById("game-menu").classList.remove("open");
  });

  // Voice chat settings controls
  document.getElementById("voice-chat-toggle").addEventListener("change", (e) => {
    if (typeof VoiceChat !== 'undefined') {
      VoiceChat.setEnabled(e.target.checked);
      console.log(`Voice chat ${e.target.checked ? 'enabled' : 'disabled'}`);
    }
  });

  document.getElementById("voice-volume").addEventListener("input", (e) => {
    const volumePercent = parseInt(e.target.value);
    const volumeLevel = volumePercent / 100;

    if (typeof VoiceChat !== 'undefined') {
      VoiceChat.setVolume(volumeLevel);
    }

    // Update volume display
    document.getElementById("voice-volume-value").textContent = `${volumePercent}%`;
  });

  document.getElementById("center-map-btn").addEventListener("click", () => {
    GameMap.centerOnPlayer();
  });

  document.getElementById("center-map-runner-btn").addEventListener("click", () => {
    GameMap.centerOnPlayer();
  });

  // Spell out the zone windows, and when shields run out, as the host picks a
  // game length, zone lock and how long shields last
  document.getElementById("game-duration").addEventListener("input", () => {
    UI.updateZoneWindowHint();
    UI.updateShieldZonesHint();
  });

  document.getElementById("zone-lock").addEventListener("input", () => {
    UI.updateZoneWindowHint();
  });

  document.getElementById("shield-zones").addEventListener("input", () => {
    UI.updateShieldZonesHint();
  });

  ["caught-btn", "status-caught-btn"].forEach((id) => {
    document.getElementById(id).addEventListener("click", reportSelfCaught);
  });

  document.getElementById("leave-game-btn").addEventListener("click", leaveGame);

  // Game over screen
  document.getElementById("replay-map-btn").addEventListener("click", openGameReplay);
  document.getElementById("new-game-btn").addEventListener("click", setupNewGame);
  document.getElementById("return-home-btn").addEventListener("click", returnToHome);

  document.getElementById("replay-back-btn").addEventListener("click", () => {
    UI.showScreen("game-over-screen");
  });

  // Handle geolocation permissions
  if ("geolocation" in navigator) {
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions
        .query({ name: "geolocation" })
        .then((result) => {
          if (result.state === "denied") {
            UI.showNotification("Location permission is required for this game.", "error");
          }
        })
        .catch(() => {});
    }
  } else {
    UI.showNotification("Geolocation is not supported by your browser.", "error");
  }
}

// Setup Socket.IO connection. A dropped connection is left to Socket.IO to
// bring back - it keeps retrying on its own - and we rejoin our room each time
// it does. Nobody is taken out of a game for losing signal or closing the app.
function setupSocketConnection() {
  socket = io();

  // Connection events
  socket.on("connect", () => {
    console.log("Connected to server");
    UI.setConnectionStatus("connected");

    if (hasSession()) {
      socket.emit("rejoin_room", { roomId: gameState.roomId, playerId: gameState.playerId });
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("Disconnected from server", reason);
    roomJoined = false;

    // A create or join still waiting on its answer went down with the
    // connection, so let it be tried again
    if (requestInFlight) {
      requestInFlight = false;
      UI.hideLoading();
      UI.showNotification("The connection dropped before the server answered. Try again.", "warning");
    }

    // We hung up on purpose
    if (reason === "io client disconnect") {
      return;
    }

    // The server hung up on us, and Socket.IO only retries by itself for
    // connections that dropped
    if (reason === "io server disconnect") {
      socket.connect();
    }

    UI.setConnectionStatus("reconnecting");
  });

  socket.on("connect_error", (error) => {
    console.error("Connection error:", error);
    UI.hideLoading();
    UI.setConnectionStatus("offline");
  });

  socket.on("error", (data) => {
    console.error("Socket error:", data);
    requestInFlight = false;
    UI.hideLoading();
    UI.showNotification((data && data.message) || "An error occurred", "error");
  });

  // Game events
  socket.on("join_success", handleJoinSuccess);
  socket.on("rejoin_failed", handleRejoinFailed);
  socket.on("game_state", handleGameState);
  socket.on("player_joined", handlePlayerJoined);
  socket.on("player_left", handlePlayerLeft);
  socket.on("player_disconnected", handlePlayerDisconnected);
  socket.on("removed_from_room", handleRemovedFromRoom);
  socket.on("runner_location", handleRunnerLocation);
  socket.on("target_reached", handleTargetReached);
  socket.on("runner_caught", handleRunnerCaught);
  socket.on("game_over", handleGameOver);
  socket.on("room_deleted", handleRoomDeleted);
  socket.on("delete_success", handleDeleteSuccess);
  socket.on("game_started", handleGameStarted);
  socket.on("new_target", handleNewTarget);
  socket.on("zone_captured", handleZoneCaptured);
  socket.on("shield_lost", handleShieldLost);
  socket.on("shields_expired", handleShieldsExpired);
  socket.on("catch_rejected", handleCatchRejected);
  socket.on("runner_won", handleRunnerWon);
  socket.on("game_review", handleGameReview);

  // Voice chat events
  socket.on("voice_transmission_started", handleVoiceTransmissionStarted);
  socket.on("voice_audio_received", handleVoiceAudioReceived);
  socket.on("voice_transmission_ended", handleVoiceTransmissionEnded);
}

// Pick up a game this device was in before it was reloaded or closed. The
// connect handler asks the server to put us back in the room.
function restoreSession() {
  const savedSession = localStorage.getItem("huntedGameSession");

  if (!savedSession) {
    return;
  }

  try {
    const session = JSON.parse(savedSession);

    if (session.roomId && session.playerId && session.username) {
      gameState = {
        ...gameState,
        ...session,
      };

      UI.showLoading("Rejoining game...");
    }
  } catch (error) {
    console.error("Error parsing saved session:", error);
    localStorage.removeItem("huntedGameSession");
  }
}

// Hold off a second create or join until the first is answered - or until it
// plainly never will be, alongside the loading overlay giving up on it
let requestTimer = null;

function beginRequest() {
  requestInFlight = true;
  clearTimeout(requestTimer);
  requestTimer = setTimeout(() => {
    requestInFlight = false;
  }, 20000);
}

// Actions that change the game need the server to hear them now, not whenever
// the connection comes back
function requireConnection() {
  if (socket && socket.connected) {
    return true;
  }

  UI.showNotification("You're offline. Wait for the connection to come back and try again.", "warning");
  return false;
}

// Create a new room
function createRoom() {
  if (requestInFlight || !requireConnection()) return;

  const roomName = document.getElementById("room-name").value.trim();
  const username = document.getElementById("creator-username").value.trim();
  const gameDuration = parseInt(document.getElementById("game-duration").value);
  const zoneLock = parseInt(document.getElementById("zone-lock").value);
  const catchImmunity = parseInt(document.getElementById("catch-immunity").value);
  const shieldZones = parseInt(document.getElementById("shield-zones").value);
  const invisibility = parseInt(document.getElementById("invisibility").value);
  const targetRadius = parseInt(document.getElementById("target-radius").value);
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

  gameState.username = username;
  beginRequest();
  UI.showLoading("Creating room...");

  // The server creates the room and puts us in it as the host in one go, and
  // answers with join_success
  socket.emit("create_room", {
    roomName,
    username,
    team,
    gameDuration,
    zoneLock,
    catchImmunity,
    shieldZones,
    invisibility,
    targetRadius,
    centralLat: location.lat,
    centralLng: location.lng,
  });
}

// Join an existing room
function joinRoom() {
  if (requestInFlight || !requireConnection()) return;

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

  gameState.username = username;
  beginRequest();
  UI.showLoading("Joining room...");

  socket.emit("join_room", {
    roomName,
    username,
    team,
  });
}

// We are in a room: newly created, joined from the form, or rejoined after a
// reload or a dropped connection
function handleJoinSuccess(data) {
  console.log("Join success:", data);

  requestInFlight = false;
  UI.hideLoading();

  const state = data.gameState;

  if (!state) {
    return UI.showNotification("Could not load the room", "error");
  }

  gameState.roomId = data.roomId;
  gameState.playerId = data.playerId;
  gameState.roomName = state.roomName;
  roomJoined = true;

  syncMyPlayer(state);
  showRoom(state);

  // Back from a dropped connection mid-game: let the server know where we are
  // straight away rather than on the next GPS fix
  if (state.status === "active" && GameMap.currentLocation) {
    Game.emitLocationUpdate(GameMap.currentLocation.lat, GameMap.currentLocation.lng);
  }
}

// The room or our place in it is gone - deleted, or we left it on another
// device - so the saved session is no use any more
function handleRejoinFailed(data) {
  console.log("Rejoin failed:", data);
  leaveRoomLocally((data && data.message) || "That game could not be found.", "warning");
}

// Keep what we know about ourselves in step with the server. Our team can
// change while the app is closed (miss a zone and you are a hunter), and the
// host can change when a host leaves.
function syncMyPlayer(state) {
  const me = (state.players || []).find((player) => player.playerId === gameState.playerId);

  if (me) {
    gameState.username = me.username;
    gameState.team = me.team;
  }

  gameState.isRoomCreator = Boolean(state.hostPlayerId) && state.hostPlayerId === gameState.playerId;
  gameState.gameStatus = state.status;
  saveGameSession();
}

// Show whichever screen the room's state calls for
function showRoom(state) {
  const screen = window.currentScreen;

  if (state.status === "active") {
    if (inGameScreen(screen) && Game.isRunning(state.roomId)) {
      Game.updateGameState(state);
    } else {
      startGameUI(state, { resumed: true });
    }
    return;
  }

  if (state.status === "completed") {
    // Someone looking over the results or the replay stays where they are
    if (screen !== "game-over-screen" && screen !== "replay-screen") {
      handleGameOver({ gameState: state });
    }
    return;
  }

  UI.showScreen("lobby-screen");
  updateLobbyUI(state);
}

// Update lobby UI with current game state
function updateLobbyUI(state) {
  if (!state) return;

  // Set room name
  const roomNameElement = document.getElementById("lobby-room-name");
  roomNameElement.textContent = `Room: ${state.roomName}`;

  // Update player lists
  if (state.players) {
    updatePlayerLists(state.players);
  }

  // Update game settings
  const durationElement = document.getElementById("game-duration-display");
  if (durationElement && state.gameDuration) {
    durationElement.textContent = `${state.gameDuration} min`;
  }

  // One zone window per zone, so the last zone is capturable in the final stretch
  const windowElement = document.getElementById("zone-window-display");
  if (windowElement && state.zoneCount && state.zoneWindowMs) {
    windowElement.textContent = `${state.zoneCount} zones, ${Math.round(state.zoneWindowMs / 60000)} min each`;
  }

  // Each zone is locked for the start of its window
  const lockElement = document.getElementById("zone-lock-display");
  if (lockElement && state.zoneLockMs != null) {
    lockElement.textContent = state.zoneLockMs > 0 ? `First ${state.zoneLockMs / 60000} min of each` : "None";
  }

  const immunityElement = document.getElementById("catch-immunity-display");
  if (immunityElement && state.catchImmunity != null) {
    immunityElement.textContent = state.catchImmunity > 0 ? `${state.catchImmunity} min` : "None";
  }

  // How long shields last, and what keeping one until they run out earns
  const shieldsLast = state.shieldZones != null && state.zoneCount && state.shieldZones < state.zoneCount;

  const shieldZonesElement = document.getElementById("shield-zones-display");
  if (shieldZonesElement && state.shieldZones != null) {
    shieldZonesElement.textContent = !state.shieldZones ? "None" : shieldsLast ? `First ${state.shieldZones} zone${state.shieldZones === 1 ? "" : "s"}` : "Whole game";
  }

  const invisibilityElement = document.getElementById("invisibility-display");
  if (invisibilityElement && state.invisibility != null) {
    invisibilityElement.textContent = shieldsLast && state.invisibility > 0 ? `${state.invisibility} min` : "None";
  }

  const shieldNote = document.getElementById("shield-rules-note");
  if (shieldNote && state.shieldZones != null) {
    shieldNote.textContent = UI.shieldRulesText(state);
  }

  // Where the final zone might be hidden
  const targetRadiusElement = document.getElementById("target-radius-display");
  if (targetRadiusElement && state.targetRadius) {
    targetRadiusElement.textContent = `${state.targetRadius}m radius`;
  }

  const isHunter = gameState.team === "hunter";
  const mapContainer = document.getElementById("lobby-map");
  const hunterMessage = document.getElementById("hunter-map-message");
  const runnerMessage = document.getElementById("runner-map-message");

  // Only hunters are shown the target area
  if (hunterMessage) hunterMessage.style.display = isHunter ? "block" : "none";
  if (runnerMessage) runnerMessage.style.display = isHunter ? "none" : "block";
  if (mapContainer) mapContainer.style.display = isHunter ? "" : "none";

  if (isHunter && state.centralLocation) {
    GameMap.initLobbyMap(state.centralLocation.lat, state.centralLocation.lng, state.targetRadius);
  }

  // Host-only controls follow whoever is host right now
  const isHost = gameState.isRoomCreator;
  const isActive = state.status === "active";

  document.getElementById("start-game-btn").style.display = isHost && !isActive ? "block" : "none";
  document.getElementById("delete-lobby-btn").style.display = isHost && !isActive ? "block" : "none";
  document.getElementById("return-game-btn").style.display = isActive ? "block" : "none";
}

// Update player lists in lobby
function updatePlayerLists(players) {
  if (!players) return;

  const hunterList = document.getElementById("hunter-list");
  const runnerList = document.getElementById("runner-list");

  // Clear lists
  hunterList.innerHTML = "";
  runnerList.innerHTML = "";

  const present = players.filter((p) => !p.leftAt);

  present.filter((p) => p.team === "hunter").forEach((player) => hunterList.appendChild(lobbyPlayerItem(player)));
  present.filter((p) => p.team === "runner").forEach((player) => runnerList.appendChild(lobbyPlayerItem(player)));

  [hunterList, runnerList].forEach((list) => {
    if (!list.children.length) {
      const empty = document.createElement("li");
      empty.className = "player-list-empty";
      empty.textContent = "Nobody yet";
      list.appendChild(empty);
    }
  });
}

// One player in the lobby: who they are, whether they are the host or you, and
// whether their app is open. Names go in as text, never as HTML.
function lobbyPlayerItem(player) {
  const isMe = player.playerId === gameState.playerId;
  const item = document.createElement("li");
  item.className = `player-item lobby-player${player.connected === false ? " away" : ""}`;
  item.setAttribute("data-player-id", player.playerId);

  const avatar = document.createElement("img");
  avatar.className = "player-avatar";
  avatar.src = `assets/icons/${player.team === "runner" ? "runner" : "hunter"}.svg`;
  avatar.alt = player.team === "runner" ? "Runner" : "Hunter";

  const details = document.createElement("div");
  details.className = "player-details";

  const name = document.createElement("span");
  name.className = "player-name";
  name.textContent = player.username;

  const tags = [];
  if (player.isHost) tags.push("host");
  if (isMe) tags.push("you");
  if (player.connected === false) tags.push("away");

  details.appendChild(name);

  if (tags.length) {
    const tagLine = document.createElement("span");
    tagLine.className = "player-tags";
    tagLine.textContent = tags.join(" · ");
    details.appendChild(tagLine);
  }

  item.append(avatar, details);

  // The host can take anyone else out of the lobby
  if (gameState.isRoomCreator && !isMe) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-player-btn";
    remove.dataset.playerId = player.playerId;
    remove.dataset.username = player.username;
    remove.setAttribute("aria-label", `Remove ${player.username}`);
    remove.textContent = "×";
    item.appendChild(remove);
  }

  return item;
}

// Handle new game state
function handleGameState(state) {
  // Anything for a room we are no longer in is old news
  if (!state || state.roomId !== gameState.roomId) {
    return;
  }

  console.log("Received game state:", state);

  syncMyPlayer(state);

  const screen = window.currentScreen;

  if (state.status === "completed") {
    if (screen !== "game-over-screen" && screen !== "replay-screen") {
      handleGameOver({ gameState: state });
    }
    return;
  }

  // The game started while we weren't listening, so go straight to it
  if (state.status === "active" && screen === "lobby-screen") {
    startGameUI(state);
    return;
  }

  if (screen === "lobby-screen") {
    updateLobbyUI(state);
  } else if (inGameScreen(screen)) {
    if (!Game.isRunning(state.roomId)) {
      // Game not initialized yet, do full initialization
      Game.init(gameState, socket, state);
    } else {
      Game.updateGameState(state);
    }
  }
}

// Only somebody joining for the first time is announced. Players coming back
// after a dropped connection reappear quietly.
function handlePlayerJoined(data) {
  console.log("Player joined:", data);

  const team = data.team === "runner" ? "a Runner" : "a Hunter";
  UI.showNotification(`${data.username} joined as ${team}`, "info");
}

// Somebody left on purpose (or the host took them out of the lobby). The new
// player lists arrive in a game_state of their own.
function handlePlayerLeft(data) {
  console.log("Player left:", data);

  const where = inGameScreen() ? "the game" : "the lobby";
  UI.showNotification(data.removed ? `${data.username} was removed from the lobby` : `${data.username} left ${where}`, "info");

  if (data.newHostId && data.newHostId === gameState.playerId) {
    UI.showNotification("You're the host now", "success");
  }

  if (typeof VoiceChat !== "undefined" && VoiceChat.handlePlayerLeft) {
    VoiceChat.handlePlayerLeft(data.playerId);
  }
}

// Somebody's app closed or lost signal. They are still in the game - this is
// only so their voice doesn't hang - and the lobby shows them as away.
function handlePlayerDisconnected(data) {
  console.log("Player disconnected:", data);

  // Stop and forget any voice audio still queued for them
  if (typeof VoiceChat !== "undefined" && VoiceChat.handlePlayerLeft) {
    VoiceChat.handlePlayerLeft(data.playerId);
  }
}

// The host took us out of the lobby, or we left on another device
function handleRemovedFromRoom(data) {
  console.log("Removed from room:", data);
  leaveRoomLocally((data && data.message) || "You are no longer in that room.", "warning");
}

function handleRunnerLocation(data) {
  if (Game.mapOpen) {
    // Update player marker on map
    GameMap.updateOtherPlayerLocation(data);
  }
}

// Handle target reached event
function handleTargetReached(data) {
  console.log("Target reached:", data);
  UI.showNotification("You reached your final target. You win!", "success");
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

// A zone was captured inside its window, revealing the next one
function handleZoneCaptured(data) {
  console.log("Zone captured:", data);

  const opensIn = zoneUtils.formatCountdown(data.windowOpenTime - Date.now());
  UI.showNotification(`Zone ${data.capturedZoneNumber} captured! Zone ${data.zoneNumber} opens in ${opensIn}.`, "success");

  Game.updateGameState(data.gameState);
}

// Shields are public, so everyone hears when one is spent on a catch
function handleShieldLost(data) {
  console.log("Shield lost:", data);

  if (data.playerId === gameState.playerId) {
    catchReportPending = false;
    const immuneFor = data.immunityUntil ? ` You are immune for ${zoneUtils.formatCountdown(data.immunityUntil - Date.now())}.` : "";
    UI.showNotification(`Your shield took the catch. Get caught again and you are out.${immuneFor}`, "warning");
  } else {
    UI.showNotification(`${data.username} lost their shield to a catch.`, "info");
  }

  socket.emit("resync_game_state", { roomId: gameState.roomId });
}

// Shields ran out for everyone still holding one, and each of them has gone
// invisible for keeping it that long
function handleShieldsExpired(data) {
  console.log("Shields expired:", data);

  const keepers = data.players || [];
  const keptMine = keepers.some((player) => player.playerId === gameState.playerId);
  const invisibleFor = data.invisibleUntil ? zoneUtils.formatCountdown(data.invisibleUntil - Date.now()) : null;

  if (keptMine) {
    UI.showNotification(invisibleFor ? `Shields are down. You kept yours, so you're invisible for ${invisibleFor} - nobody can see where you are.` : "Shields are down. Getting caught now puts you out.", "success");
  } else {
    // "Ruby", "Ruby and Rita", "Ruby, Rita and Sam"
    const usernames = keepers.map((player) => player.username);
    const names = usernames.length > 1 ? `${usernames.slice(0, -1).join(", ")} and ${usernames[usernames.length - 1]}` : usernames[0];
    UI.showNotification(invisibleFor ? `Shields are down. ${names} kept theirs and ${keepers.length === 1 ? "is" : "are"} invisible for ${invisibleFor}.` : `Shields are down. ${names} lost theirs.`, "info");
  }

  socket.emit("resync_game_state", { roomId: gameState.roomId });
}

// The server turned down a catch because that runner is still immune
function handleCatchRejected(data) {
  console.log("Catch rejected:", data);
  catchReportPending = false;
  UI.showNotification(`${data.username} is immune for another ${zoneUtils.formatCountdown(data.immunityUntil - Date.now())}.`, "warning");
}

function handleRunnerCaught(data) {
  console.log("Runner caught:", data);

  const isMe = data.caughtPlayerId === gameState.playerId;
  const missedZone = data.reason === "missed_zone";

  if (isMe) {
    catchReportPending = false;
    UI.showNotification(missedZone ? `You missed zone ${data.zoneNumber}. You are a Hunter now.` : "You have been caught! You are now a Hunter.", "warning");

    // Change our team to hunter
    gameState.team = "hunter";
    saveGameSession();
    Game.updateTeamUI("hunter");
  } else {
    UI.showNotification(missedZone ? `${data.username} missed zone ${data.zoneNumber} and is out!` : `${data.username} has been caught!`, "warning");
  }

  socket.emit("resync_game_state", { roomId: gameState.roomId });
}

function handleGameOver(data) {
  console.log("Game over:", data);

  const state = data && data.gameState;

  if (state && state.roomId && state.roomId !== gameState.roomId) {
    return;
  }

  // No more pings, GPS or voice once the game is done
  Game.stop();

  if (state) {
    gameState.gameStatus = state.status;
    saveGameSession();
  }

  document.getElementById("game-menu").classList.remove("open");
  UI.hideLoading();
  UI.showScreen("game-over-screen");
  updateGameOverUI(data);
}

// The order players are listed in after the game: home first, then those still
// out there when the clock stopped, then everyone who went out, then hunters
const OUTCOME_ORDER = ["won", "out_of_time", "running", "caught", "missed_zone", "left", "hunter"];

function updateGameOverUI(data) {
  const state = data.gameState;
  if (!state) return;

  const players = state.players || [];
  const home = players.filter((player) => player.outcome === "won");

  // A runner who left went out as surely as one who was caught. A hunter who
  // left never had a race to lose.
  const out = players.filter((player) => player.outcome === "caught" || player.outcome === "missed_zone" || (player.outcome === "left" && player.colorIndex != null));

  // Who won, said plainly
  const headline = document.getElementById("game-over-headline");
  if (headline) {
    headline.textContent = home.length > 0 ? `${home.length === 1 ? `${home[0].username} made it home` : `${home.length} Runners made it home`}` : "The Hunters took the lot";
  }

  document.getElementById("final-duration").textContent = `${state.gameDuration} min`;
  document.getElementById("runners-home").textContent = home.length;
  document.getElementById("runners-out").textContent = out.length;

  // How everyone finished
  const list = document.getElementById("player-outcome-list");
  if (!list) return;

  list.innerHTML = "";

  if (players.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "No players in this game";
    list.appendChild(empty);
    return;
  }

  [...players]
    .sort((a, b) => OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome) || a.username.localeCompare(b.username))
    .forEach((player) => {
      const outcome = UI.outcomeLabel(player.outcome);

      const row = document.createElement("div");
      row.className = `player-outcome-item ${outcome.state}`;

      const name = document.createElement("span");
      name.className = "player-name";

      // Runners keep the colour their trail had, so the replay map reads across
      if (player.colorIndex != null) {
        const swatch = document.createElement("span");
        swatch.className = "player-color";
        swatch.style.setProperty("--runner-color", GameMap.runnerColor(player.colorIndex));
        name.appendChild(swatch);
      }

      name.appendChild(document.createTextNode(player.username));

      const result = document.createElement("span");
      result.className = "player-outcome";
      result.textContent = outcome.text;

      // Whether each runner managed to hang on to their shield
      const shieldText = UI.shieldOutcomeText(player, state);
      if (shieldText) {
        const shield = document.createElement("span");
        shield.className = `player-outcome-shield ${player.shieldLostReason === "caught" ? "lost" : "kept"}`;
        shield.textContent = shieldText;
        result.appendChild(shield);
      }

      row.append(name, result);
      list.appendChild(row);
    });
}

// Look back over the game: everyone's trails, and the final zone revealed
function openGameReplay() {
  if (!gameState.roomId) {
    return UI.showNotification("There is no game to look back on", "warning");
  }

  if (!requireConnection()) return;

  UI.showLoading("Loading the game...");
  socket.emit("request_game_review", { roomId: gameState.roomId });
}

function handleGameReview(review) {
  console.log("Game review:", review);
  UI.hideLoading();
  UI.showScreen("replay-screen");

  GameMap.renderReview(review);
  updateReplayLegend(review);
}

function updateReplayLegend(review) {
  const legend = document.getElementById("replay-legend");
  if (!legend) return;

  legend.innerHTML = "";

  // Only the runners left a trail worth a legend entry
  (review.players || [])
    .filter((player) => player.colorIndex != null)
    .sort((a, b) => a.colorIndex - b.colorIndex)
    .forEach((player) => {
      const outcome = UI.outcomeLabel(player.outcome);

      const row = document.createElement("span");
      row.className = `replay-legend-item ${outcome.state}`;

      const swatch = document.createElement("span");
      swatch.className = "player-color";
      swatch.style.setProperty("--runner-color", GameMap.runnerColor(player.colorIndex));

      row.appendChild(swatch);
      row.appendChild(document.createTextNode(`${player.username} - ${outcome.text}`));
      legend.appendChild(row);
    });
}

function startGame() {
  if (!gameState.isRoomCreator) {
    return UI.showNotification("Only the host can start the game", "error");
  }

  if (!requireConnection()) return;

  UI.showLoading("Starting game...");
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

  // Already playing it (a second tap on Start was answered with the game)
  if (inGameScreen() && Game.isRunning(data.gameState.roomId)) {
    return Game.updateGameState(data.gameState);
  }

  syncMyPlayer(data.gameState);
  startGameUI(data.gameState);
}

// resumed: coming back to a game already under way, rather than it starting
function startGameUI(state, { resumed = false } = {}) {
  console.log("Starting game UI with state:", state);
  UI.hideLoading();

  // Every game opens on the status screen. Opening the map is a choice, since
  // it is what pings your location.
  UI.showScreen("status-screen");
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
    UI.showNotification(resumed ? "Back in the game" : "Game started!", "success");
  } catch (error) {
    console.error("Error initializing game:", error);
    UI.showNotification("Error initializing game: " + error.message, "error");
  }
}

function deleteLobby() {
  if (!gameState.isRoomCreator) {
    return UI.showNotification("Only the host can delete the lobby", "error");
  }

  if (!requireConnection()) return;

  if (confirm("Are you sure you want to delete this lobby? Everyone in it will be sent back to the start.")) {
    UI.showLoading("Deleting lobby...");
    socket.emit("delete_room", { roomId: gameState.roomId });
  }
}

// The host takes someone out of the lobby
function removePlayer(playerId, username) {
  if (!gameState.isRoomCreator || !playerId) return;
  if (!requireConnection()) return;

  if (confirm(`Remove ${username} from the lobby?`)) {
    socket.emit("remove_player", { playerId });
  }
}

// Ask the server to take us out of the room, and only forget it once the
// server has. Closing the app is always the way to step away without leaving.
function requestLeave(onLeft) {
  if (!requireConnection()) return;

  UI.showLoading("Leaving...");

  socket.timeout(8000).emit("leave_room", {}, (err, response) => {
    UI.hideLoading();

    if (err || !response || !response.ok) {
      return UI.showNotification((response && response.message) || "Couldn't reach the server to leave. Try again.", "error");
    }

    onLeft();
  });
}

function leaveLobby() {
  if (!requireConnection()) return;

  if (gameState.isRoomCreator) {
    const others = document.querySelectorAll("#lobby-screen .lobby-player").length - 1;
    const message = others > 0 ? "Leave the lobby? Someone else will become the host." : "Leave the lobby? You're the only one in it, so it will be closed.";

    if (!confirm(message)) return;
  }

  requestLeave(() => leaveRoomLocally());
}

function reportSelfCaught() {
  if (catchReportPending || !requireConnection()) return;

  if (confirm("Are you sure you want to report yourself as caught? This cannot be undone.")) {
    // One report at a time: a second tap on a slow connection would count as
    // a second catch
    catchReportPending = true;
    setTimeout(() => {
      catchReportPending = false;
    }, 10000);

    socket.emit("player_caught", {
      caughtPlayerId: gameState.playerId,
    });
  }
}

function leaveGame() {
  if (!requireConnection()) return;

  const player = Game.getMyPlayer();
  const stillRunning = gameState.team === "runner" && player && player.status !== "won" && player.status !== "caught";

  const message = stillRunning
    ? "Leave the game? You will be out, and this can't be undone.\n\nTo take a break without leaving, just close the app - you stay in the game."
    : "Leave the game?\n\nTo take a break without leaving, just close the app - you stay in the game.";

  if (confirm(message)) {
    requestLeave(() => leaveRoomLocally());
  }
}

// Setup a new game after game over
function setupNewGame() {
  detachFromFinishedGame();

  // Go to create room screen, with the username still filled in
  UI.showScreen("create-room-screen");
}

// Return to home screen after game over
function returnToHome() {
  detachFromFinishedGame();
  UI.showScreen("splash-screen");
}

// The game is over, so there is nothing to change on the server: just stop
// listening to the room
function detachFromFinishedGame() {
  if (socket && socket.connected) {
    socket.emit("leave_room", {});
  }

  leaveRoomLocally(null);
}

function handleRoomDeleted(data) {
  console.log("Room deleted:", data);
  leaveRoomLocally("The room has been deleted by the host", "warning");
}

function handleDeleteSuccess(data) {
  console.log("Delete success:", data);
  leaveRoomLocally("Room deleted", "success");
}

// Forget the room on this device and go back to the start
function leaveRoomLocally(message, type = "info") {
  Game.stop();
  resetGameState();
  requestInFlight = false;
  UI.hideLoading();
  document.getElementById("game-menu").classList.remove("open");

  if (window.currentScreen !== "create-room-screen") {
    UI.showScreen("splash-screen");
  }

  if (message) {
    UI.showNotification(message, type);
  }
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

  roomJoined = false;
  catchReportPending = false;

  // Clear session storage
  localStorage.removeItem("huntedGameSession");
}

// Save game session to localStorage
function saveGameSession() {
  if (!hasSession()) return;

  localStorage.setItem("huntedGameSession", JSON.stringify(gameState));
}

// Get current game state - utility function accessible to other modules
window.Game = window.Game || {};
window.Game.getGameState = function () {
  return gameState;
};

// Function to return to an active game from the lobby
function returnToActiveGame() {
  UI.showScreen("status-screen");
  // Request the latest game state
  socket.emit("resync_game_state", { roomId: gameState.roomId });
}

// Handle runner won event
function handleRunnerWon(data) {
  console.log("Runner won:", data);

  // The winner already heard about it as target_reached
  if (data.playerId !== gameState.playerId) {
    UI.showNotification(`${data.username} has reached their target and won!`, "success");
  }

  socket.emit("resync_game_state", { roomId: gameState.roomId });
}

// Handle voice transmission started event
// VoiceChat owns the speaker indicators, so they follow what is actually heard
function handleVoiceTransmissionStarted(data) {
  try {
    if (typeof VoiceChat !== "undefined" && VoiceChat.handleTransmissionStarted) {
      VoiceChat.handleTransmissionStarted(data);
    }
  } catch (error) {
    console.error("Error handling voice transmission started:", error);
    // Game continues despite voice chat error
  }
}

// Handle an incoming audio frame. These arrive many times a second while
// someone is talking, so this path stays quiet and does no per-frame UI work.
function handleVoiceAudioReceived(data) {
  try {
    if (typeof VoiceChat !== "undefined" && VoiceChat.handleIncomingAudio) {
      VoiceChat.handleIncomingAudio(data);
    }
  } catch (error) {
    console.error("Error handling voice audio received:", error);
    // Game continues despite voice chat error
  }
}

// Handle voice transmission ended event
function handleVoiceTransmissionEnded(data) {
  try {
    if (typeof VoiceChat !== "undefined" && VoiceChat.handleTransmissionEnded) {
      VoiceChat.handleTransmissionEnded(data);
    }
  } catch (error) {
    console.error("Error handling voice transmission ended:", error);
    // Game continues despite voice chat error
  }
}

// Update voice chat settings display when menu opens
function updateVoiceChatSettingsDisplay() {
  try {
    if (typeof VoiceChat === 'undefined') {
      console.warn('VoiceChat not available');
      return;
    }

    // Get current settings from VoiceChat
    const isEnabled = VoiceChat.getEnabled();
    const volume = VoiceChat.getVolume();
    const volumePercent = Math.round(volume * 100);

    // Update toggle switch
    const toggleElement = document.getElementById('voice-chat-toggle');
    if (toggleElement) {
      toggleElement.checked = isEnabled;
    }

    // Update volume slider and display
    const volumeSlider = document.getElementById('voice-volume');
    const volumeDisplay = document.getElementById('voice-volume-value');

    if (volumeSlider) {
      volumeSlider.value = volumePercent;
    }

    if (volumeDisplay) {
      volumeDisplay.textContent = `${volumePercent}%`;
    }

    console.log('Voice chat settings display updated:', { isEnabled, volumePercent });
  } catch (error) {
    console.error('Error updating voice chat settings display:', error);
  }
}

document.addEventListener("DOMContentLoaded", initApp);

/**
 * UI Utilities for HUNTED Game
 */

const UI = {
  // Initialize the UI
  init: function () {
    // Set up screen transitions
    this.setupScreenTransitions();

    // Set up notification system
    this.setupNotifications();
  },

  // Set up screen transitions
  setupScreenTransitions: function () {
    // Set initial screen
    window.currentScreen = "splash-screen";
  },

  // Show a specific screen
  showScreen: function (screenId) {
    // Hide all screens
    const screens = document.querySelectorAll(".screen");
    screens.forEach((screen) => {
      screen.classList.remove("active");
    });

    // Show the requested screen
    const screen = document.getElementById(screenId);
    if (screen) {
      screen.classList.add("active");
      window.currentScreen = screenId;

      // Fire screen-specific init
      switch (screenId) {
        case "create-room-screen":
          this.initCreateRoomScreen();
          break;
        case "join-room-screen":
          this.initJoinRoomScreen();
          break;
        case "lobby-screen":
          // The lobby map will be initialized by updateLobbyUI in app.js
          // This separation ensures we have the correct data when showing the map
          break;
        case "game-screen":
          // Game screen is initialized by Game.init()
          break;
        case "game-over-screen":
          // Any game-over-specific initialization
          break;
      }
    }
  },

  // Initialize the create room screen
  initCreateRoomScreen: function () {
    // If user has played before, pre-fill the username
    const username = gameState.username;
    if (username) {
      document.getElementById("creator-username").value = username;
    }

    // Reset form fields
    document.getElementById("room-name").value = "";
    document.getElementById("game-duration").value = 60;

    // Reset team selection
    const teamBtns = document.querySelectorAll("#create-room-form .team-btn");
    teamBtns.forEach((btn) => {
      btn.classList.remove("selected");
    });
    document
      .querySelector("#create-room-form .hunter-team")
      .classList.add("selected");

    // Short delay to ensure the screen is fully visible before initializing the map
    // This is crucial because Leaflet needs a visible container to initialize properly
    setTimeout(() => {
      // Initialize the setup map
      GameMap.initSetupMap();
    }, 100);
  },

  // Initialize the join room screen
  initJoinRoomScreen: function () {
    // If user has played before, pre-fill the username
    const username = gameState.username;
    if (username) {
      document.getElementById("join-username").value = username;
    }

    // Reset form fields
    document.getElementById("join-room-name").value = "";

    // Reset team selection
    const teamBtns = document.querySelectorAll("#join-room-form .team-btn");
    teamBtns.forEach((btn) => {
      btn.classList.remove("selected");
    });
    document
      .querySelector("#join-room-form .hunter-team")
      .classList.add("selected");
  },

  // Set up notification system
  setupNotifications: function () {
    this.notificationContainer = document.getElementById(
      "notification-container"
    );
  },

  // Show a notification
  showNotification: function (message, type = "info") {
    // Create notification element
    const notification = document.createElement("div");
    notification.className = `notification ${type}`;
    notification.textContent = message;

    // Add to container
    this.notificationContainer.appendChild(notification);

    // Animate in
    setTimeout(() => {
      notification.classList.add("show");
    }, 10);

    // Automatically remove after delay
    setTimeout(() => {
      notification.classList.remove("show");
      setTimeout(() => {
        this.notificationContainer.removeChild(notification);
      }, 300);
    }, 5000);
  },

  // Show loading overlay
  showLoading: function (message = "Loading...") {
    const loadingOverlay = document.getElementById("loading-overlay");
    const loadingMessage = document.getElementById("loading-message");

    loadingMessage.textContent = message;
    loadingOverlay.classList.add("show");
  },

  // Hide loading overlay
  hideLoading: function () {
    const loadingOverlay = document.getElementById("loading-overlay");
    loadingOverlay.classList.remove("show");
  },

  // Update time display in game
  updateTimeDisplay: function (seconds) {
    const timeElement = document.getElementById("time-value");
    if (!timeElement) return;

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    timeElement.textContent = `${minutes
      .toString()
      .padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;

    // Add warning class if time is running low (less than 5 minutes)
    if (seconds < 300) {
      timeElement.classList.add("time-warning");
    } else {
      timeElement.classList.remove("time-warning");
    }
  },

  // Update player score display
  updatePlayerScore: function (score) {
    const scoreElement = document.getElementById("score-value");
    const scoreContainer = document.getElementById("player-score-container");
    
    if (!scoreElement || !scoreContainer) return;
    
    // Update score value
    scoreElement.textContent = score || 0;
    
    // Show/hide score based on if player is a runner
    if (gameState.team === "runner") {
      scoreContainer.style.display = "block";
    } else {
      scoreContainer.style.display = "none";
    }
  },

  // Update player lists in game menu
  updateGamePlayerLists: function (players) {
    if (!players) return;

    const hunterList = document.getElementById("game-hunter-list");
    const runnerList = document.getElementById("game-runner-list");

    if (!hunterList || !runnerList) return;

    // Clear lists
    hunterList.innerHTML = "";
    runnerList.innerHTML = "";

    // Filter and sort players by team
    const hunters = players.filter((p) => p.team === "hunter");
    const runners = players.filter((p) => p.team === "runner");

    // Add hunters to list
    hunters.forEach((hunter) => {
      const listItem = document.createElement("li");
      listItem.className = "player-item";
      listItem.innerHTML = `
                <span class="player-name">${hunter.username}</span>
                ${
                  hunter.status === "caught"
                    ? '<span class="player-status caught">Caught</span>'
                    : ""
                }
            `;
      hunterList.appendChild(listItem);
    });

    // Add runners to list
    runners.forEach((runner) => {
      const listItem = document.createElement("li");
      listItem.className = "player-item";
      listItem.innerHTML = `
                <span class="player-name">${runner.username}</span>
                ${
                  runner.status === "caught"
                    ? '<span class="player-status caught">Caught</span>'
                    : `<span class="player-status score">${runner.score || 0}</span>`
                }
            `;
      runnerList.appendChild(listItem);
    });
  },

  // Show team controls based on player's team
  showTeamControls: function (team) {
    const hunterControls = document.getElementById("hunter-controls");
    const runnerControls = document.getElementById("runner-controls");

    if (team === "hunter") {
      hunterControls.style.display = "flex";
      runnerControls.style.display = "none";
    } else {
      hunterControls.style.display = "none";
      runnerControls.style.display = "flex";
    }

    // Update team indicator
    const teamValue = document.getElementById("team-value");
    if (teamValue) {
      teamValue.textContent = team.charAt(0).toUpperCase() + team.slice(1);
      teamValue.className =
        team === "hunter" ? "hunter-team-text" : "runner-team-text";
    }
  },
};

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

      // Every screen opens at its top. #app can't be scrolled by the user, but
      // a phone bringing a focused text box into view can still nudge it, and
      // would leave the next screen's header cut off with no way back.
      const app = document.getElementById("app");
      if (app) app.scrollTop = 0;
      screen.scrollTop = 0;

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
    document.getElementById("catch-immunity").value = 3;
    this.updateZoneWindowHint();

    // Reset team selection
    const teamBtns = document.querySelectorAll("#create-room-form .team-btn");
    teamBtns.forEach((btn) => {
      btn.classList.remove("selected");
    });
    document.querySelector("#create-room-form .hunter-team").classList.add("selected");

    // Short delay to ensure the screen is fully visible before initializing the map
    // This is crucial because Leaflet needs a visible container to initialize properly
    setTimeout(() => {
      // Initialize the setup map
      GameMap.initSetupMap();
    }, 100);
  },

  // Spell out what the chosen game duration means for the zone windows: a 60
  // minute game over six zones opens a zone every 10 minutes
  updateZoneWindowHint: function () {
    const durationInput = document.getElementById("game-duration");
    const hint = document.getElementById("zone-window-hint");
    if (!durationInput || !hint) return;

    const zoneCount = zoneUtils.DEFAULT_RADIUS_LEVELS.length;
    const duration = parseInt(durationInput.value, 10);

    if (!Number.isFinite(duration) || duration <= 0) {
      hint.textContent = `Split evenly into ${zoneCount} zone windows`;
      return;
    }

    const windowMinutes = Math.round(zoneUtils.zoneWindowMs(duration, zoneCount) / 60000);
    hint.textContent = `${zoneCount} zones, one capturable every ${windowMinutes} min`;
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
    document.querySelector("#join-room-form .hunter-team").classList.add("selected");
  },

  // Set up notification system
  setupNotifications: function () {
    this.notificationContainer = document.getElementById("notification-container");
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

  // Show loading overlay. It covers the whole screen, so it never stays up
  // forever waiting on an answer that got lost.
  showLoading: function (message = "Loading...", timeoutMs = 20000) {
    const loadingOverlay = document.getElementById("loading-overlay");
    const loadingMessage = document.getElementById("loading-message");

    loadingMessage.textContent = message;
    loadingOverlay.classList.add("show");

    clearTimeout(this.loadingTimer);
    this.loadingTimer = setTimeout(() => {
      if (loadingOverlay.classList.contains("show")) {
        this.hideLoading();
        this.showNotification("The server is taking a while to answer. Check your connection and try again.", "warning");
      }
    }, timeoutMs);
  },

  // Hide loading overlay
  hideLoading: function () {
    const loadingOverlay = document.getElementById("loading-overlay");
    loadingOverlay.classList.remove("show");
    clearTimeout(this.loadingTimer);
  },

  // A strip across the top while the connection is down. The game carries on
  // underneath: nothing is lost, and we rejoin as soon as it is back.
  setConnectionStatus: function (status) {
    const banner = document.getElementById("connection-banner");
    if (!banner) return;

    if (status === "connected") {
      banner.classList.remove("show");
      return;
    }

    banner.textContent = status === "offline" ? "Can't reach the server - retrying..." : "Connection lost - reconnecting...";
    banner.classList.add("show");
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

    // Filter and sort players by team. Anyone who left the game is gone from
    // the lists; the results at the end still show how they finished.
    const present = players.filter((p) => !p.leftAt);
    const hunters = present.filter((p) => p.team === "hunter");
    const runners = present.filter((p) => p.team === "runner");

    // Add hunters to list. Runners who went out are hunters now, so say how.
    hunters.forEach((hunter) => {
      const listItem = document.createElement("li");
      listItem.className = "player-item team-hunter";
      listItem.setAttribute("data-player-id", hunter.playerId);

      listItem.appendChild(this.textSpan("player-name", hunter.username));

      if (hunter.status === "caught") {
        listItem.appendChild(this.textSpan("player-status caught", hunter.eliminationReason === "missed_zone" ? "Missed zone" : "Caught"));
      }

      hunterList.appendChild(listItem);
    });

    // Add runners to list, with the shield each of them has left
    runners.forEach((runner) => {
      const listItem = document.createElement("li");
      listItem.className = "player-item team-runner";
      listItem.setAttribute("data-player-id", runner.playerId);

      const name = this.textSpan("player-name", runner.username);
      const swatch = document.createElement("span");
      swatch.className = "player-color";
      swatch.style.setProperty("--runner-color", GameMap.runnerColor(runner.colorIndex));
      name.prepend(swatch);

      listItem.appendChild(name);

      if (runner.status === "won") {
        listItem.appendChild(this.textSpan("player-status won", "Won"));
      } else {
        const badge = this.shieldBadgeContent(runner);
        listItem.appendChild(this.textSpan(`player-shield ${badge.state}`, badge.text));
      }

      runnerList.appendChild(listItem);
    });

    // Refresh player list indicators if available
    if (typeof PlayerListIndicator !== "undefined" && PlayerListIndicator.refreshIndicators) {
      PlayerListIndicator.refreshIndicators();
    }
  },

  // Player names are only ever put on the page as text
  textSpan: function (className, text) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    return span;
  },

  // How a player's game ended, in words, shared by the scoreboard and the
  // replay map so they never disagree
  outcomeLabel: function (outcome) {
    switch (outcome) {
      case "won":
        return { text: "Made it home", state: "won" };
      case "caught":
        return { text: "Caught", state: "out" };
      case "missed_zone":
        return { text: "Missed a zone", state: "out" };
      case "out_of_time":
        return { text: "Ran out of time", state: "timeout" };
      case "left":
        return { text: "Left the game", state: "left" };
      case "hunter":
        return { text: "Hunter", state: "hunter" };
      default:
        return { text: "Still running", state: "running" };
    }
  },

  // A runner's shield, as everyone else sees it: still held, spent, or holding
  // off catches for a little longer
  shieldBadgeContent: function (runner) {
    const shield = zoneUtils.shieldState({ shieldActive: runner.shieldActive, immunityUntil: runner.immunityUntil }, Date.now());

    if (shield.immune) {
      return { state: "immune", text: `🛡 Immune ${zoneUtils.formatCountdown(shield.immuneMsRemaining)}` };
    }

    if (shield.hasShield) {
      return { state: "held", text: "🛡 Shield" };
    }

    return { state: "spent", text: "⚠ Last life" };
  },

  // Keep immunity countdowns in the menu ticking without rebuilding the lists
  refreshShieldBadges: function (players) {
    (players || []).forEach((player) => {
      const item = document.querySelector(`#game-runner-list .player-item[data-player-id="${player.playerId}"]`);
      const element = item && item.querySelector(".player-shield");

      if (!element) return;

      const badge = this.shieldBadgeContent(player);
      element.className = `player-shield ${badge.state}`;
      element.textContent = badge.text;
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
  },
};

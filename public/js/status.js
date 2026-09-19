/**
 * Status Screen for HUNTED Game
 *
 * Everything worth knowing about the game that isn't where anything is: the
 * clocks, your own zone and shield, and how everybody else is doing. It is the
 * screen a player lands on, and reading it costs them nothing - the map is
 * what pings your location, so a Runner can keep an eye on the game without
 * telling the Hunters where they are.
 *
 * Nothing here says where a zone, a Runner or a Hunter is. Zones are only ever
 * named by number.
 */

const StatusScreen = {
  // Redraw the lot. Called every second while this screen is showing, so it
  // stays honest between game states as the countdowns run down.
  update: function (state, playerInfo) {
    if (!state || !playerInfo) return;

    const now = Date.now();

    this.updateRoom(state);
    this.updateClock(state, now);
    this.updateYou(state, playerInfo, now);
    this.updatePlayers(state, playerInfo);
  },

  updateRoom: function (state) {
    const name = document.getElementById("status-room-name");
    if (name) name.textContent = state.roomName ? `Room: ${state.roomName}` : "";
  },

  // The clocks everybody shares: the game, the zone window it is in, and when
  // shields run out
  updateClock: function (state, now) {
    const clock = document.getElementById("status-game-clock");

    if (clock) {
      const remaining = state.gameEndTime ? state.gameEndTime - now : null;
      clock.textContent = remaining == null ? "--:--" : zoneUtils.formatCountdown(remaining);
      clock.classList.toggle("time-warning", remaining != null && remaining < 5 * 60 * 1000);
    }

    const zoneWindow = document.getElementById("status-zone-window");

    if (zoneWindow) {
      zoneWindow.textContent = this.zoneWindowText(state, now);
    }

    // Shields that last the whole game, or none at all, have no deadline
    const shieldItem = document.getElementById("status-shield-deadline-item");
    const shieldValue = document.getElementById("status-shield-deadline");

    if (shieldItem && shieldValue) {
      if (!state.shieldDeadline) {
        shieldItem.style.display = "none";
      } else {
        shieldItem.style.display = "";
        const remaining = state.shieldDeadline - now;
        shieldValue.textContent = remaining > 0 ? zoneUtils.formatCountdown(remaining) : "Shields are down";
      }
    }
  },

  // Which zone the game clock is on, and how long is left of its lock or its
  // window. The same for everyone, whatever zone they have reached themselves.
  zoneWindowText: function (state, now) {
    if (!state.gameStartTime || !state.zoneWindowMs || !state.zoneCount) {
      return "-";
    }

    const zoneIndex = zoneUtils.currentZoneIndex(now, state.gameStartTime, state.zoneWindowMs, state.zoneCount);

    if (zoneIndex >= state.zoneCount) {
      return "The last zone has closed";
    }

    const window = zoneUtils.zoneWindow(zoneIndex, state.gameStartTime, state.zoneWindowMs, state.zoneLockMs || 0);
    const status = zoneUtils.zoneStatusAt(now, window);
    const zoneLabel = `Zone ${zoneIndex + 1}/${state.zoneCount}`;

    if (status === "locked") {
      return `${zoneLabel} · locked ${zoneUtils.formatCountdown(window.openTime - now)}`;
    }

    return `${zoneLabel} · open ${zoneUtils.formatCountdown(window.closeTime - now)}`;
  },

  // Your own game: which side you are on, the zone you are racing for, and
  // what is left of your shield
  updateYou: function (state, playerInfo, now) {
    const me = (state.players || []).find((player) => player.playerId === playerInfo.playerId) || null;
    const team = (me && me.team) || playerInfo.team;
    const isRunner = team === "runner";

    const teamValue = document.getElementById("status-your-team");
    if (teamValue) {
      teamValue.textContent = isRunner ? "Runner" : "Hunter";
      teamValue.className = `status-value ${isRunner ? "status-runner" : "status-hunter"}`;
    }

    const zoneItem = document.getElementById("status-your-zone-item");
    const zoneValue = document.getElementById("status-your-zone");

    if (zoneItem && zoneValue) {
      const zone = this.yourZone(state, playerInfo, me, isRunner, now);
      zoneItem.style.display = zone ? "" : "none";

      if (zone) {
        zoneValue.textContent = zone.text;
        zoneValue.className = `status-value ${zone.state}`;
      }
    }

    const shieldItem = document.getElementById("status-your-shield-item");
    const shieldValue = document.getElementById("status-your-shield");

    if (shieldItem && shieldValue) {
      const showShield = isRunner && me && me.status !== "caught" && me.status !== "won";
      shieldItem.style.display = showShield ? "" : "none";

      if (showShield) {
        const badge = UI.shieldBadgeContent(me);
        shieldValue.textContent = badge.text;
        shieldValue.className = `status-value player-shield ${badge.state}`;
      }
    }

    const note = document.getElementById("status-your-note");
    if (note) note.textContent = this.yourNote(me, isRunner);
  },

  // The zone you are on, from your own targets - which nobody else is sent
  yourZone: function (state, playerInfo, me, isRunner, now) {
    if (!isRunner) return null;

    if (me && me.status === "won") {
      return { text: "🏁 Made it home", state: "zone-captured" };
    }

    const target = (state.targets || []).find((item) => item.playerId === playerInfo.playerId && item.status === "active");

    if (!target) return null;

    const label = `Zone ${target.zoneNumber}/${state.zoneCount}`;
    const status = zoneUtils.zoneStatusAt(now, { openTime: target.windowOpenTime, closeTime: target.windowCloseTime });

    if (status === "locked") {
      return { text: `${label} 🔒 ${zoneUtils.formatCountdown(target.windowOpenTime - now)}`, state: "zone-locked" };
    }

    if (status === "open") {
      const remaining = target.windowCloseTime - now;
      return { text: `${label} ⏳ ${zoneUtils.formatCountdown(remaining)}`, state: remaining < 60 * 1000 ? "zone-closing" : "zone-open" };
    }

    return { text: `${label} ⏳ missed`, state: "zone-closing" };
  },

  yourNote: function (me, isRunner) {
    if (!isRunner) {
      return "Open the map to see where Runners have been seen, and to share where you are.";
    }

    if (me && me.status === "won") {
      return "You're home. Nothing you do now shares where you are.";
    }

    return "Your zone can only be captured from inside it, with the map open. Nothing on this screen pings your location.";
  },

  // Everyone else's game, in the same two columns as the lobby
  updatePlayers: function (state, playerInfo) {
    const hunterList = document.getElementById("status-hunter-list");
    const runnerList = document.getElementById("status-runner-list");

    if (!hunterList || !runnerList) return;

    hunterList.innerHTML = "";
    runnerList.innerHTML = "";

    // Anyone who left the game is gone from the lists; the results at the end
    // still show how they finished
    const present = (state.players || []).filter((player) => !player.leftAt);

    present.filter((player) => player.team === "hunter").forEach((player) => hunterList.appendChild(this.playerRow(player, state, playerInfo)));
    present.filter((player) => player.team === "runner").forEach((player) => runnerList.appendChild(this.playerRow(player, state, playerInfo)));

    [hunterList, runnerList].forEach((list) => {
      if (!list.children.length) {
        const empty = document.createElement("li");
        empty.className = "player-list-empty";
        empty.textContent = "Nobody yet";
        list.appendChild(empty);
      }
    });
  },

  // One player: who they are, how far they have got, and what their shield is
  // doing. Names go in as text, never as HTML.
  playerRow: function (player, state, playerInfo) {
    const item = document.createElement("li");
    item.className = `player-item status-player${player.connected === false ? " away" : ""}`;
    item.setAttribute("data-player-id", player.playerId);

    const details = document.createElement("div");
    details.className = "player-details";

    const name = document.createElement("span");
    name.className = "player-name";

    // Runners wear the colour their marker and trail have on the map
    if (player.team === "runner" && player.colorIndex != null) {
      const swatch = document.createElement("span");
      swatch.className = "player-color";
      swatch.style.setProperty("--runner-color", GameMap.runnerColor(player.colorIndex));
      name.appendChild(swatch);
    }

    name.appendChild(document.createTextNode(player.username));
    details.appendChild(name);

    const tags = [];
    if (player.playerId === playerInfo.playerId) tags.push("you");
    if (player.isHost) tags.push("host");
    if (player.connected === false) tags.push("away");

    const line = [this.progressText(player, state), tags.length ? tags.join(" · ") : null].filter(Boolean).join(" · ");

    if (line) {
      const progress = document.createElement("span");
      progress.className = "player-tags";
      progress.textContent = line;
      details.appendChild(progress);
    }

    item.appendChild(details);

    // Shields are public, so everyone can see who still has one, who is
    // briefly immune, and who is invisible
    if (player.team === "runner") {
      const badge = player.status === "won" ? { state: "won", text: "🏁 Home" } : UI.shieldBadgeContent(player);
      item.appendChild(UI.textSpan(`player-shield ${badge.state}`, badge.text));
    }

    return item;
  },

  // How far a player has got, in zone numbers only - never where those zones
  // are. Runners who went out are hunters now, so say how they went.
  progressText: function (player, state) {
    const zoneCount = state.zoneCount || zoneUtils.DEFAULT_RADIUS_LEVELS.length;
    const captured = player.zonesCaptured || 0;
    const capturedText = `${captured}/${zoneCount} captured`;

    if (player.team === "runner") {
      if (player.status === "won") {
        return "Captured every zone";
      }

      return player.currentZone ? `On zone ${player.currentZone} · ${capturedText}` : "No zone yet";
    }

    if (player.status === "caught") {
      const how = player.eliminationReason === "missed_zone" ? "Missed a zone" : "Caught";
      return `Out: ${how} · ${capturedText}`;
    }

    return "Hunting";
  },
};

// Export for use in other modules
if (typeof module !== "undefined" && module.exports) {
  module.exports = StatusScreen;
}

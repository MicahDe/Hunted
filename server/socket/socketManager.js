const { v4: uuidv4 } = require("uuid");
const geoUtils = require("../../shared/utils/geoUtils");
const trailUtils = require("../../shared/utils/trailUtils");
const zoneUtils = require("../../shared/utils/zoneUtils");
const config = require("../config/default");
const voiceChatHandler = require("./voiceChatHandler");

module.exports = function (io, db) {
  // Which room and player each open connection belongs to. A player can have
  // more than one (a phone that reconnected before the old connection timed
  // out, say), and none at all while their app is closed - which is not the
  // same as leaving.
  const connectedPlayers = new Map();

  // Changes to a room are made one at a time. The handlers are async and every
  // database call yields, so without this two requests racing each other - a
  // join sent twice over a flaky connection, a catch landing on the same tick
  // as a missed zone - could both act on the same stale read.
  const roomLocks = new Map();

  function withRoomLock(key, task) {
    const previous = roomLocks.get(key) || Promise.resolve();
    const run = previous.then(() => task());
    const tail = run.catch(() => {});

    roomLocks.set(key, tail);
    tail.then(() => {
      if (roomLocks.get(key) === tail) {
        roomLocks.delete(key);
      }
    });

    return run;
  }

  // Zone windows close on the game clock whether or not anyone has their app
  // open, so the server drives them rather than waiting for the next ping. A
  // slow tick is never overlapped by the next one, or a runner could be
  // charged twice for the same missed window.
  let processingSchedules = false;

  const scheduleTimer = setInterval(() => {
    if (processingSchedules) {
      return;
    }

    processingSchedules = true;
    processZoneSchedules()
      .catch((error) => console.error("Error processing zone schedules:", error))
      .finally(() => {
        processingSchedules = false;
      });
  }, config.game.scheduleTickInterval);

  // Never hold the process open for the tick
  if (scheduleTimer.unref) {
    scheduleTimer.unref();
  }

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Initialize voice chat handler for this socket connection
    voiceChatHandler(io, socket, connectedPlayers);

    // Create a room, with its creator in it as the host. Doing both in one step
    // means there is no second request to go missing or be sent twice.
    socket.on("create_room", async (data = {}) => {
      try {
        const roomName = cleanName(data.roomName);
        const username = cleanName(data.username);
        const problem = nameProblem(roomName, username);

        if (problem) {
          return socket.emit("error", { message: problem });
        }

        const centralLat = coordinate(data.centralLat, 90);
        const centralLng = coordinate(data.centralLng, 180);

        if (centralLat === null || centralLng === null) {
          return socket.emit("error", { message: "Tap the map to set the middle of the target area" });
        }

        // Two creates for the same name are settled one after the other
        await withRoomLock(`create:${roomName.toLowerCase()}`, async () => {
          if (await getRoom(roomName)) {
            return socket.emit("error", { message: `A room called "${roomName}" already exists. Pick a different name.` });
          }

          const roomId = uuidv4();
          const playerId = uuidv4();
          const team = data.team === "runner" ? "runner" : "hunter";

          await createRoom(roomId, roomName, playerId, {
            gameDuration: data.gameDuration,
            catchImmunity: data.catchImmunity,
            zoneLock: data.zoneLock,
            shieldZones: data.shieldZones,
            invisibility: data.invisibility,
            centralLat,
            centralLng,
            targetRadius: data.targetRadius,
          });
          await createPlayer(playerId, roomId, username, team);

          await withRoomLock(roomId, () => enterRoom(socket, roomId, playerId, { isNew: true }));
        });
      } catch (error) {
        console.error("Error creating room:", error);
        socket.emit("error", { message: "Failed to create room" });
      }
    });

    // Join a room by name, from the join form
    socket.on("join_room", async (data = {}) => {
      try {
        const roomName = cleanName(data.roomName);
        const username = cleanName(data.username);
        const problem = nameProblem(roomName, username);

        if (problem) {
          return socket.emit("error", { message: problem });
        }

        const found = await getRoom(roomName);

        if (!found) {
          return socket.emit("error", { message: `There's no room called "${roomName}". Check the name with your host.` });
        }

        const team = data.team === "runner" ? "runner" : "hunter";
        await withRoomLock(found.room_id, () => joinByName(socket, found.room_id, username, team));
      } catch (error) {
        console.error("Error joining room:", error);
        socket.emit("error", { message: "Failed to join room" });
      }
    });

    // Pick up where a saved session left off: after a reload, a dropped
    // connection, or the app being closed and opened again
    socket.on("rejoin_room", async (data = {}) => {
      try {
        const { roomId, playerId } = data;

        if (typeof roomId !== "string" || typeof playerId !== "string") {
          return socket.emit("rejoin_failed", { message: "That game could not be found." });
        }

        await withRoomLock(roomId, async () => {
          const room = await getRoomById(roomId);

          if (!room) {
            return socket.emit("rejoin_failed", { message: "That room no longer exists." });
          }

          const player = await getPlayerById(playerId);

          if (!player || player.room_id !== roomId || player.left_at) {
            return socket.emit("rejoin_failed", { message: "You're no longer in that room." });
          }

          // Mid-game nothing about them has changed for anyone else. In the
          // lobby everyone sees them come back from being away.
          await enterRoom(socket, roomId, playerId, { isNew: false, broadcast: room.status === "lobby" });
        });
      } catch (error) {
        console.error("Error rejoining room:", error);
        socket.emit("error", { message: "Failed to rejoin the game" });
      }
    });

    // Leave on purpose, as opposed to just closing the app. The client waits on
    // the acknowledgement before it forgets the room.
    socket.on("leave_room", async (data, ack) => {
      const reply = typeof ack === "function" ? ack : typeof data === "function" ? data : () => {};

      try {
        const info = connectedPlayers.get(socket.id);

        if (!info) {
          return reply({ ok: true });
        }

        await withRoomLock(info.roomId, () => leaveRoom(socket));
        reply({ ok: true });
      } catch (error) {
        console.error("Error leaving room:", error);
        reply({ ok: false, message: "Failed to leave the room" });
      }
    });

    // The host can take someone out of the lobby - a player who is not coming,
    // or a name that was typed wrong
    socket.on("remove_player", async (data = {}) => {
      try {
        const info = connectedPlayers.get(socket.id);

        if (!info) {
          return socket.emit("error", { message: "Player not found" });
        }

        await withRoomLock(info.roomId, async () => {
          const room = await getRoomById(info.roomId);

          if (!room || !isHost(room, info.playerId)) {
            return socket.emit("error", { message: "Only the host can remove players" });
          }

          if (room.status !== "lobby") {
            return socket.emit("error", { message: "Players can only be removed before the game starts" });
          }

          const player = await getPlayerById(data.playerId);

          if (!player || player.room_id !== room.room_id) {
            return socket.emit("error", { message: "That player isn't in this room" });
          }

          if (player.player_id === info.playerId) {
            return socket.emit("error", { message: "Use Leave Lobby to leave the room yourself" });
          }

          await deletePlayer(player.player_id);

          detachPlayer(player.player_id, "removed_from_room", { message: "The host removed you from the lobby." });

          io.to(room.room_id).emit("player_left", {
            playerId: player.player_id,
            username: player.username,
            removed: true,
            timestamp: Date.now(),
          });

          await broadcastGameState(room.room_id);
        });
      } catch (error) {
        console.error("Error removing player:", error);
        socket.emit("error", { message: "Failed to remove that player" });
      }
    });

    // Handle delete room
    socket.on("delete_room", async (data = {}) => {
      try {
        const info = connectedPlayers.get(socket.id);

        if (!info) {
          console.log(`Player not found for socket ID: ${socket.id}`);
          return socket.emit("error", { message: "Player not found" });
        }

        const roomId = info.roomId;

        await withRoomLock(roomId, async () => {
          const room = await getRoomById(roomId);

          if (!room) {
            console.log(`Room not found with ID: ${roomId}`);
            return socket.emit("error", { message: "Room not found" });
          }

          if (!isHost(room, info.playerId)) {
            return socket.emit("error", { message: "Only the host can delete the lobby" });
          }

          if (room.status === "active") {
            return socket.emit("error", { message: "The game is running, so the room can't be deleted now" });
          }

          // Everyone else hears about it; the host gets their own confirmation
          socket.to(roomId).emit("room_deleted", {
            roomId,
            message: "Room has been deleted by the host",
          });

          await deleteRoom(roomId);

          connectedPlayers.forEach((player, socketId) => {
            if (player.roomId === roomId) {
              const playerSocket = io.sockets.sockets.get(socketId);
              if (playerSocket) {
                playerSocket.leave(roomId);
              }
              connectedPlayers.delete(socketId);
            }
          });

          socket.emit("delete_success", {
            message: "Room deleted successfully",
          });
        });
      } catch (error) {
        console.error("Error deleting room:", error);
        socket.emit("error", { message: "Failed to delete room" });
      }
    });

    // Handle start game
    socket.on("start_game", async () => {
      try {
        const info = connectedPlayers.get(socket.id);

        if (!info) {
          console.error("Player not found when starting game");
          return socket.emit("error", { message: "Player not found" });
        }

        await withRoomLock(info.roomId, () => startGame(socket, info));
      } catch (error) {
        console.error("Error starting game:", error);
        socket.emit("error", { message: "Failed to start game" });
      }
    });

    // Handle location updates
    socket.on("location_update", async (data = {}) => {
      try {
        const info = connectedPlayers.get(socket.id);

        // A ping that arrives before a reconnecting phone has rejoined its room
        // has nowhere to go. The next one will, so there is nothing to report.
        if (!info) {
          return;
        }

        const lat = coordinate(data.lat, 90);
        const lng = coordinate(data.lng, 180);

        if (lat === null || lng === null) {
          return;
        }

        await withRoomLock(info.roomId, () => handleLocation(socket, lat, lng));
      } catch (error) {
        console.error("Error handling location update:", error);
      }
    });

    // Handle player caught event
    socket.on("player_caught", async (data = {}) => {
      try {
        const info = connectedPlayers.get(socket.id);

        if (!info) {
          return socket.emit("error", { message: "Player not found" });
        }

        await withRoomLock(info.roomId, () => reportCatch(socket, info, data.caughtPlayerId));
      } catch (error) {
        console.error("Error handling caught player:", error);
      }
    });

    // Closing the app, losing signal or the phone going to sleep all end up
    // here. None of them take a player out of the game: they are just away
    // until they reconnect.
    socket.on("disconnect", async () => {
      console.log(`Socket disconnected: ${socket.id}`);

      try {
        const info = connectedPlayers.get(socket.id);

        if (!info) {
          return;
        }

        connectedPlayers.delete(socket.id);

        // Still here on another connection, so nobody needs telling
        if (isPlayerConnected(info.playerId)) {
          return;
        }

        io.to(info.roomId).emit("player_disconnected", {
          playerId: info.playerId,
          username: info.username,
          timestamp: Date.now(),
        });

        // The lobby shows who is actually here
        const room = await getRoomById(info.roomId);

        if (room && room.status === "lobby") {
          await broadcastGameState(info.roomId);
        }
      } catch (error) {
        console.error("Error handling disconnect:", error);
      }
    });

    // A look back over the game once it is done: where everyone went, how they
    // finished, and where the final zone was hiding all along
    socket.on("request_game_review", async (data) => {
      try {
        const playerInfo = connectedPlayers.get(socket.id);
        const roomId = (data && data.roomId) || (playerInfo && playerInfo.roomId);

        if (!roomId) {
          return socket.emit("error", { message: "Player not found" });
        }

        const review = await buildGameReview(roomId);

        if (!review) {
          return socket.emit("error", { message: "There is no game to look back on yet" });
        }

        socket.emit("game_review", review);
      } catch (error) {
        console.error("Error building game review:", error);
        socket.emit("error", { message: "Failed to load the game review" });
      }
    });

    socket.on("resync_game_state", async () => {
      try {
        const playerInfo = connectedPlayers.get(socket.id);

        // Not in a room (yet): a reconnecting phone rejoins by itself
        if (!playerInfo) {
          return;
        }

        // Get game state specific to this player, for the room they are in
        // rather than whichever one the client last thought it was in
        const gameState = await getGameState(playerInfo.roomId, playerInfo.playerId);

        if (gameState) {
          socket.emit("game_state", gameState);
        }
      } catch (error) {
        console.error("Error getting game state:", error);
        socket.emit("error", { message: "Failed to get game state" });
      }
    });
  });

  // A latitude or longitude, or null for anything that isn't one. Number()
  // alone would read a missing value as 0, which is a real place.
  function coordinate(value, limit) {
    if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) {
      return null;
    }

    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
  }

  // Names come from a text box, so tidy the whitespace people leave in them
  function cleanName(value) {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  }

  function nameProblem(roomName, username) {
    if (!roomName || !username) {
      return "Room name and username are required";
    }

    if (roomName.length > config.security.maxRoomNameLength) {
      return `Room names can be at most ${config.security.maxRoomNameLength} characters`;
    }

    if (username.length > config.security.maxUsernameLength) {
      return `Usernames can be at most ${config.security.maxUsernameLength} characters`;
    }

    return null;
  }

  // Rooms made before the server kept track of a host let anyone in them host
  function isHost(room, playerId) {
    return !room.host_player_id || room.host_player_id === playerId;
  }

  // Is this player here on any connection other than the one given?
  function isPlayerConnected(playerId, exceptSocketId = null) {
    for (const [socketId, info] of connectedPlayers.entries()) {
      if (info.playerId === playerId && socketId !== exceptSocketId) {
        return true;
      }
    }

    return false;
  }

  // Tie a connection to a player in a room. A connection is only ever in one
  // room, so anything it was in before is left first.
  function attachSocket(socket, room, player) {
    const previous = connectedPlayers.get(socket.id);

    if (previous && previous.roomId !== room.room_id) {
      connectedPlayers.delete(socket.id);
      socket.leave(previous.roomId);

      if (!isPlayerConnected(previous.playerId)) {
        io.to(previous.roomId).emit("player_disconnected", {
          playerId: previous.playerId,
          username: previous.username,
          timestamp: Date.now(),
        });
      }
    }

    socket.join(room.room_id);
    connectedPlayers.set(socket.id, {
      roomId: room.room_id,
      playerId: player.player_id,
      username: player.username,
      team: player.team,
    });
  }

  // Cut every connection a player has to their room, telling each why
  function detachPlayer(playerId, event, payload) {
    connectedPlayers.forEach((info, socketId) => {
      if (info.playerId !== playerId) {
        return;
      }

      connectedPlayers.delete(socketId);

      const playerSocket = io.sockets.sockets.get(socketId);

      if (playerSocket) {
        playerSocket.leave(info.roomId);

        if (event) {
          playerSocket.emit(event, payload);
        }
      }
    });
  }

  // Put a connection in the room as the given player and bring everyone up to
  // date. Only a player joining for the first time is announced; somebody
  // coming back after a dropped connection just quietly reappears.
  async function enterRoom(socket, roomId, playerId, { isNew, broadcast = true }) {
    const room = await getRoomById(roomId);
    const player = await getPlayerById(playerId);

    attachSocket(socket, room, player);

    const gameState = await getGameState(roomId, playerId);

    socket.emit("join_success", {
      roomId,
      playerId,
      gameState,
    });

    if (isNew) {
      socket.to(roomId).emit("player_joined", {
        playerId,
        username: player.username,
        team: player.team,
        timestamp: Date.now(),
      });
    }

    if (broadcast) {
      await broadcastGameState(roomId, socket.id);
    }
  }

  // The join form. A name already in the room is that player coming back -
  // unless they are plainly still here on another phone, in which case it is
  // somebody else who happened to pick the same name.
  async function joinByName(socket, roomId, username, team) {
    const room = await getRoomById(roomId);

    if (!room) {
      return socket.emit("error", { message: "Room not found" });
    }

    const existing = await getPlayer(roomId, username);

    if (existing) {
      const alreadyThisSocket = connectedPlayers.get(socket.id)?.playerId === existing.player_id;

      if (!alreadyThisSocket && isPlayerConnected(existing.player_id, socket.id)) {
        return socket.emit("error", {
          message: `Someone called "${existing.username}" is already in this room. Pick a different name - or if that's you on another phone, close the app there first.`,
        });
      }

      if (room.status === "lobby") {
        // Nothing has started, so they can come back on whichever team they chose
        await updatePlayerTeam(existing.player_id, team);

        if (existing.status !== "won" && existing.status !== "caught") {
          await updatePlayerStatus(existing.player_id, "lobby");
        }
      }

      // Once the game is running their team is whatever the game made it: a
      // runner who went out is a hunter now, whatever they picked
      await clearLeft(existing.player_id);

      return enterRoom(socket, roomId, existing.player_id, { isNew: false });
    }

    if (room.status === "completed") {
      return socket.emit("error", { message: "That game has already finished." });
    }

    // Joining a game under way gets a shield only if everyone else still has
    // theirs. In the lobby it makes no odds: the game hands them out at the start.
    const playerId = uuidv4();
    const hasShield = room.status !== "active" || shieldAvailable(roomSchedule(room), Date.now());
    await createPlayer(playerId, roomId, username, team, hasShield);

    // A room from before hosts were tracked gets its first player as host
    if (!room.host_player_id) {
      await setRoomHost(roomId, playerId);
    }

    return enterRoom(socket, roomId, playerId, { isNew: true });
  }

  // Leaving on purpose. Before the game starts that is simply gone from the
  // room. Mid-game a runner forfeits, since nobody should be left hunting a
  // runner who has gone home, and after the game there is nothing to change.
  async function leaveRoom(socket) {
    const info = connectedPlayers.get(socket.id);

    if (!info) {
      return;
    }

    const { roomId, playerId } = info;
    const room = await getRoomById(roomId);
    const player = await getPlayerById(playerId);

    connectedPlayers.delete(socket.id);
    socket.leave(roomId);

    // Once the game is over there is nothing left to change: they have just
    // stopped looking at the results
    if (!room || !player || room.status === "completed") {
      return;
    }

    // Any other phone the player has open in the room goes with them
    detachPlayer(playerId, "removed_from_room", { message: "You left this room on another device." });

    if (room.status === "lobby") {
      await deletePlayer(playerId);
    } else {
      await markLeft(playerId);

      if (player.team === "runner" && player.status !== "won" && player.status !== "caught") {
        await eliminatePlayer(playerId, "left");
      }
    }

    const newHostId = isHost(room, playerId) ? await handOverHost(room, playerId) : null;

    io.to(roomId).emit("player_left", {
      playerId,
      username: player.username,
      newHostId,
      timestamp: Date.now(),
    });

    // A lobby nobody is left in is finished with, and its name is free again
    if (room.status === "lobby" && (await getRoomPlayers(roomId)).length === 0) {
      console.log(`Room ${roomId} is empty, deleting it`);
      await deleteRoom(roomId);
      return;
    }

    await broadcastGameState(roomId);

    if (room.status === "active") {
      await checkForGameOver(roomId);
    }
  }

  // The host has gone, so hand the room to whoever has been in it longest,
  // preferring someone who is actually here
  async function handOverHost(room, leavingPlayerId) {
    const candidates = (await getRoomPlayers(room.room_id)).filter((player) => player.player_id !== leavingPlayerId && !player.left_at);
    const next = candidates.find((player) => isPlayerConnected(player.player_id)) || candidates[0] || null;

    await setRoomHost(room.room_id, next ? next.player_id : null);

    return next ? next.player_id : null;
  }

  async function startGame(socket, info) {
    const room = await getRoomById(info.roomId);

    if (!room) {
      return socket.emit("error", { message: "Room not found" });
    }

    if (!isHost(room, info.playerId)) {
      return socket.emit("error", { message: "Only the host can start the game" });
    }

    // A second tap on Start, or one that was held up by a bad connection, must
    // not restart a game that is already running: that would hide a new final
    // zone that none of the runners' zones lead to
    if (room.status === "active") {
      return socket.emit("game_started", { gameState: await getGameState(room.room_id, info.playerId) });
    }

    if (room.status !== "lobby") {
      return socket.emit("error", { message: "That game has already finished." });
    }

    const runners = await getTeamPlayers(room.room_id, "runner");

    if (runners.length === 0) {
      return socket.emit("error", { message: "At least one Runner has to join before the game can start." });
    }

    // Start the game clock and hide the final zone somewhere in the target
    // area. Both have to be settled before any zones are generated.
    console.log("Starting the game clock for room:", room.room_id);
    await startRoom(room, Date.now());

    // Everyone starts the game with a shield - unless the host set up a game
    // without them
    const hasShield = roomSchedule(room).shieldZones > 0;

    // Every runner gets their first zone now, whether or not their app is open:
    // their first zone window is already running
    for (const runner of runners) {
      await updatePlayerStatus(runner.player_id, "active");
      await resetShield(runner.player_id, hasShield);
      await generateTargetForPlayer(room.room_id, runner.player_id);
    }

    // Notify all players in room, each with their own view of the game
    console.log("Notifying all players in room about game start");
    await broadcastToPlayers(room.room_id, "game_started", (gameState) => ({ gameState }));
  }

  async function handleLocation(socket, lat, lng) {
    // Re-read under the room lock: the player may have left, or gone out and
    // become a hunter, while this ping was waiting
    const info = connectedPlayers.get(socket.id);

    if (!info) {
      return;
    }

    const { roomId, playerId, username, team } = info;
    const room = await getRoomById(roomId);

    // Locations only count while the game is being played
    if (!room || room.status !== "active") {
      return;
    }

    // A runner who has made it home stays on the map where they finished.
    // Sharing where they are now would only show everyone where the final zone
    // is, since that is where they are standing.
    const player = await getPlayerById(playerId);

    if (!player || player.status === "won") {
      return;
    }

    const now = Date.now();

    if (team === "hunter") {
      await updatePlayerLocation(playerId, lat, lng);

      io.to(roomId).emit("runner_location", {
        playerId,
        username,
        team: "hunter",
        location: { lat, lng },
        lastPingTime: now,
        trail: null,
      });
      return;
    }

    // Runners leave a trail, and might just have captured their zone
    await storeLocationHistory(playerId, roomId, lat, lng);

    // A runner who kept their shield until it ran out is invisible for a spell
    // afterwards. Their pings still capture zones and still go in the history
    // for the end of game replay, but the location everyone else is shown stays
    // where they were last seen before it began.
    const schedule = roomSchedule(room);

    if (!isInvisible(player, schedule, now)) {
      await updatePlayerLocation(playerId, lat, lng);

      io.to(roomId).emit("runner_location", {
        playerId,
        username,
        team: "runner",
        location: { lat, lng },
        lastPingTime: now,
        colorIndex: getRunnerColorIndexes(await getRoomPlayers(roomId))[playerId],
        trail: await getRunnerTrail(playerId, { lat, lng, timestamp: now }, hiddenPeriods(player, schedule)),
      });
    }

    const targetResult = await checkTargetDiscovery(roomId, playerId, lat, lng);

    if (!targetResult) {
      return;
    }

    console.log(`Target result for ${playerId}:`, targetResult);

    // Case 1: Player captured their final zone and won
    if (targetResult.reachedTarget) {
      console.log(`Player ${playerId} reached target ${targetResult.reachedTarget.targetId}`);

      // The room hears about it as runner_won; this is the winner's own copy
      socket.emit("target_reached", {
        targetId: targetResult.reachedTarget.targetId,
        location: targetResult.reachedTarget.location,
        playerId,
        username,
        gameState: await getGameState(roomId, playerId),
      });
    }
    // Case 2: Player captured the zone, so the next one is revealed
    else if (targetResult.updatedTarget) {
      console.log(`Player ${playerId} captured zone ${targetResult.updatedTarget.capturedZoneNumber}, revealing the next one`);

      socket.emit("zone_captured", {
        targetId: targetResult.updatedTarget.targetId,
        location: targetResult.updatedTarget.location,
        radiusLevel: targetResult.updatedTarget.radiusLevel,
        zoneNumber: targetResult.updatedTarget.zoneNumber,
        capturedZoneNumber: targetResult.updatedTarget.capturedZoneNumber,
        zoneStatus: targetResult.updatedTarget.zoneStatus,
        windowOpenTime: targetResult.updatedTarget.windowOpenTime,
        windowCloseTime: targetResult.updatedTarget.windowCloseTime,
        gameState: await getGameState(roomId, playerId),
      });
    }
    // Case 3: New target was generated for player
    else if (targetResult.isNew && targetResult.target) {
      console.log(`New target ${targetResult.target.targetId} generated for player ${playerId}`);

      socket.emit("new_target", {
        target: targetResult.target,
        gameState: await getGameState(roomId, playerId),
      });
    }
  }

  // A runner reports themselves caught. Hunters could report catches too, but
  // nobody can report a runner in another room, or another runner.
  async function reportCatch(socket, info, caughtPlayerId) {
    const room = await getRoomById(info.roomId);

    if (!room) {
      return socket.emit("error", { message: "Room not found" });
    }

    if (room.status !== "active") {
      return socket.emit("error", { message: "The game isn't running" });
    }

    const caughtPlayer = await getPlayerById(caughtPlayerId);

    if (!caughtPlayer || caughtPlayer.room_id !== room.room_id || caughtPlayer.team !== "runner") {
      return socket.emit("error", { message: "That player is not a runner" });
    }

    const reporter = await getPlayerById(info.playerId);

    if (!reporter || (reporter.player_id !== caughtPlayer.player_id && reporter.team !== "hunter")) {
      return socket.emit("error", { message: "Only a hunter or the runner themselves can report a catch" });
    }

    // A runner whose shield just took a catch is briefly safe, so the hunter
    // who caught them can't immediately catch them again
    const shield = zoneUtils.shieldState({ shieldActive: caughtPlayer.shield_active, immunityUntil: caughtPlayer.immunity_until }, Date.now());

    if (shield.immune) {
      return socket.emit("catch_rejected", {
        playerId: caughtPlayerId,
        username: caughtPlayer.username,
        immunityUntil: caughtPlayer.immunity_until,
      });
    }

    // The first catch costs the shield, the second puts them out
    await applyStrike(room.room_id, caughtPlayerId, "caught", roomSchedule(room));

    await broadcastGameState(room.room_id);
    await checkForGameOver(room.room_id);
  }

  // Database helper functions
  async function deleteRoom(roomId) {
    console.log(`Starting deleteRoom function for roomId: ${roomId}`);
    return new Promise((resolve, reject) => {
      // Delete players first due to foreign key constraints
      console.log(`Deleting players for roomId: ${roomId}`);
      db.run("DELETE FROM players WHERE room_id = ?", [roomId], function (err) {
        if (err) {
          console.error("Error deleting players:", err);
          return reject(err);
        }
        console.log(`Successfully deleted players for roomId: ${roomId}`);

        // Delete targets
        console.log(`Deleting targets for roomId: ${roomId}`);
        db.run("DELETE FROM targets WHERE room_id = ?", [roomId], function (err) {
          if (err) {
            console.error("Error deleting targets:", err);
            return reject(err);
          }
          console.log(`Successfully deleted targets for roomId: ${roomId}`);

          db.run("DELETE FROM location_history WHERE room_id = ?", [roomId], function (err) {
            if (err) {
              console.error("Error deleting location history:", err);
              return reject(err);
            }

            // Delete room
            console.log(`Deleting room with roomId: ${roomId}`);
            db.run("DELETE FROM rooms WHERE room_id = ?", [roomId], function (err) {
              if (err) {
                console.error("Error deleting room:", err);
                return reject(err);
              }
              console.log(`Successfully deleted room with roomId: ${roomId}`);
              resolve();
            });
          });
        });
      });
    });
  }

  // Room names are typed on phones, so "park" finds the room called "Park"
  async function getRoom(roomName) {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM rooms WHERE room_name = ? COLLATE NOCASE ORDER BY start_time DESC LIMIT 1", [roomName], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });
  }

  async function setRoomHost(roomId, playerId) {
    return runSql("UPDATE rooms SET host_player_id = ? WHERE room_id = ?", [playerId, roomId]);
  }

  // Gone from the lobby altogether, as if they had never joined
  async function deletePlayer(playerId) {
    await runSql("DELETE FROM targets WHERE player_id = ?", [playerId]);
    await runSql("DELETE FROM location_history WHERE player_id = ?", [playerId]);
    return runSql("DELETE FROM players WHERE player_id = ?", [playerId]);
  }

  // Left a game that is under way. Their row stays so the results and the
  // replay still show how their game went.
  async function markLeft(playerId) {
    return runSql("UPDATE players SET left_at = ? WHERE player_id = ?", [Date.now(), playerId]);
  }

  async function clearLeft(playerId) {
    return runSql("UPDATE players SET left_at = NULL WHERE player_id = ?", [playerId]);
  }

  function runSql(sql, params) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) reject(err);
        resolve(this.changes);
      });
    });
  }

  async function getRoomById(roomId) {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM rooms WHERE room_id = ?", [roomId], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });
  }

  async function createRoom(roomId, roomName, hostPlayerId, settings) {
    const gameDuration = clamp(settings.gameDuration, 6, 240, config.game.defaultGameDuration);
    const catchImmunity = clamp(settings.catchImmunity, 0, 30, config.game.defaultCatchImmunity);
    const zoneLock = clamp(settings.zoneLock, 0, 30, config.game.defaultZoneLock);
    const shieldZones = clamp(settings.shieldZones, 0, config.game.targetRadiusLevels.length, config.game.defaultShieldZones);
    const invisibility = clamp(settings.invisibility, 0, 30, config.game.defaultInvisibility);
    const targetRadius = clamp(settings.targetRadius, 100, 5000, config.game.defaultTargetAreaRadius);

    await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO rooms (room_id, room_name, host_player_id, game_duration, catch_immunity, zone_lock, shield_zones, invisibility, central_lat, central_lng, target_radius, start_time, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [roomId, roomName, hostPlayerId, gameDuration, catchImmunity, zoneLock, shieldZones, invisibility, settings.centralLat, settings.centralLng, targetRadius, Date.now(), "lobby"],
        function (err) {
          if (err) reject(err);
          resolve(this.lastID);
        },
      );
    });

    return { gameDuration, catchImmunity, zoneLock, shieldZones, invisibility };
  }

  // Set the game running, and with it the clock every zone window is measured
  // from and the one final zone every runner is racing for. The hunters pick
  // the area, never the zone, and nobody is told where it landed until the game
  // is over.
  async function startRoom(room, gameStartTime) {
    const finalZone = geoUtils.generateRandomPoint(room.central_lat, room.central_lng, room.target_radius || config.game.defaultTargetAreaRadius);

    return new Promise((resolve, reject) => {
      db.run("UPDATE rooms SET status = 'active', game_start_time = ?, final_lat = ?, final_lng = ?, end_time = NULL WHERE room_id = ?", [gameStartTime, finalZone.lat, finalZone.lng, room.room_id], function (err) {
        if (err) reject(err);
        resolve(this.changes);
      });
    });
  }

  function clamp(value, min, max, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, Math.round(number)));
  }

  // The same name typed with different capitals is the same player
  async function getPlayer(roomId, username) {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM players WHERE room_id = ? AND username = ? COLLATE NOCASE ORDER BY rowid LIMIT 1", [roomId, username], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });
  }

  async function getPlayerById(playerId) {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM players WHERE player_id = ?", [playerId], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });
  }

  async function createPlayer(playerId, roomId, username, team, hasShield = true) {
    return new Promise((resolve, reject) => {
      db.run("INSERT INTO players (player_id, room_id, username, team, status, shield_active, last_ping_time) VALUES (?, ?, ?, ?, ?, ?, ?)", [playerId, roomId, username, team, "active", hasShield ? 1 : 0, Date.now()], function (err) {
        if (err) reject(err);
        resolve(this.lastID);
      });
    });
  }

  async function updatePlayerStatus(playerId, status) {
    return new Promise((resolve, reject) => {
      db.run("UPDATE players SET status = ? WHERE player_id = ?", [status, playerId], function (err) {
        if (err) reject(err);
        resolve(this.changes);
      });
    });
  }

  async function updatePlayerTeam(playerId, team) {
    return new Promise((resolve, reject) => {
      db.run("UPDATE players SET team = ? WHERE player_id = ?", [team, playerId], function (err) {
        if (err) reject(err);
        resolve(this.changes);
      });
    });
  }

  // Everyone goes into the game with a fresh shield (if the game has them) and
  // no leftover immunity
  async function resetShield(playerId, hasShield) {
    return new Promise((resolve, reject) => {
      db.run("UPDATE players SET shield_active = ?, shield_lost_at = NULL, shield_lost_reason = NULL, immunity_until = NULL, elimination_reason = NULL WHERE player_id = ?", [hasShield ? 1 : 0, playerId], function (err) {
        if (err) reject(err);
        resolve(this.changes);
      });
    });
  }

  // Take a runner's one shield: spent on a catch, which also buys them a
  // spell of immunity, or run out along with everybody else's
  async function spendShield(playerId, reason, immunityUntil) {
    return new Promise((resolve, reject) => {
      db.run("UPDATE players SET shield_active = 0, shield_lost_at = ?, shield_lost_reason = ?, immunity_until = ? WHERE player_id = ?", [Date.now(), reason, immunityUntil, playerId], function (err) {
        if (err) reject(err);
        resolve(this.changes);
      });
    });
  }

  // Out of the game, and onto the hunters' team
  async function eliminatePlayer(playerId, reason) {
    return new Promise((resolve, reject) => {
      db.run("UPDATE players SET status = 'caught', team = 'hunter', elimination_reason = ?, immunity_until = NULL WHERE player_id = ?", [reason, playerId], function (err) {
        if (err) reject(err);
        resolve(this.changes);
      });
    });
  }

  async function updatePlayerLocation(playerId, lat, lng) {
    return new Promise((resolve, reject) => {
      db.run("UPDATE players SET last_lat = ?, last_lng = ?, last_ping_time = ? WHERE player_id = ?", [lat, lng, Date.now(), playerId], function (err) {
        if (err) reject(err);
        resolve(this.changes);
      });
    });
  }

  // Store location history point
  async function storeLocationHistory(playerId, roomId, lat, lng) {
    const timestamp = Date.now();

    // Only store a point if it's significantly different from the last one
    // or if enough time has passed (at least 10 seconds)
    const lastPoint = await getLastLocationHistoryPoint(playerId);

    if (lastPoint) {
      // If less than 10 seconds have passed and location hasn't changed significantly, don't store
      const timeDiff = timestamp - lastPoint.timestamp;
      const distanceChanged = geoUtils.calculateDistance(lat, lng, lastPoint.lat, lastPoint.lng);

      if (timeDiff < 10000 && distanceChanged < 5) {
        return; // Don't store if not enough change
      }
    }

    return new Promise((resolve, reject) => {
      db.run("INSERT INTO location_history (player_id, room_id, lat, lng, timestamp) VALUES (?, ?, ?, ?, ?)", [playerId, roomId, lat, lng, timestamp], function (err) {
        if (err) reject(err);
        resolve(this.lastID);
      });
    });
  }

  // Get the last location history point for a player
  async function getLastLocationHistoryPoint(playerId) {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM location_history WHERE player_id = ? ORDER BY timestamp DESC LIMIT 1", [playerId], function (err, row) {
        if (err) reject(err);
        resolve(row);
      });
    });
  }

  // Get a runner's trail (sightings and heading) over the configured window.
  // latestPing is their most recent location, which history may have skipped as too close to the last point.
  // Nothing from inside hidden (see hiddenPeriods) is included.
  async function getRunnerTrail(playerId, latestPing, hidden = []) {
    const now = Date.now();
    const since = now - config.game.trail.windowMs;

    const rows = await new Promise((resolve, reject) => {
      db.all("SELECT lat, lng, timestamp FROM location_history WHERE player_id = ? AND timestamp > ? ORDER BY timestamp ASC", [playerId, since], function (err, rows) {
        if (err) reject(err);
        resolve(rows || []);
      });
    });

    // End the trail exactly where the runner's marker is
    const lastRow = rows[rows.length - 1];
    if (latestPing && latestPing.lat != null && latestPing.lng != null && (!lastRow || (latestPing.timestamp > lastRow.timestamp && (latestPing.lat !== lastRow.lat || latestPing.lng !== lastRow.lng)))) {
      rows.push(latestPing);
    }

    return trailUtils.buildTrail(rows, now, config.game.trail, hidden);
  }

  // How far each player has got, in zone numbers alone - never where their
  // zones are. A runner's zone only moves on when they capture the one before,
  // so the zone they are on says how many they have captured. Safe for
  // everybody to see: it says who is ahead, not where anyone is.
  async function getRoomZoneProgress(roomId, schedule) {
    const rows = await new Promise((resolve, reject) => {
      db.all("SELECT player_id, zone_index, status FROM targets WHERE room_id = ? ORDER BY rowid", [roomId], (err, result) => {
        if (err) reject(err);
        resolve(result || []);
      });
    });

    const progress = {};

    rows.forEach((row) => {
      const zoneIndex = row.zone_index || 0;
      const reached = row.status === "reached";

      progress[row.player_id] = {
        zonesCaptured: reached ? schedule.zoneCount : zoneIndex,
        currentZone: reached ? null : zoneIndex + 1,
      };
    });

    return progress;
  }

  // All players in a room, in the order they joined
  async function getRoomPlayers(roomId) {
    return new Promise((resolve, reject) => {
      db.all("SELECT * FROM players WHERE room_id = ? ORDER BY rowid", [roomId], (err, rows) => {
        if (err) reject(err);
        resolve(rows || []);
      });
    });
  }

  // Each runner's map colour slot, numbered in the order they joined. Caught runners keep their
  // slot so nobody else's colour changes mid-game. Takes players in join order (see getRoomPlayers).
  function getRunnerColorIndexes(players) {
    const indexes = {};
    players
      .filter((player) => player.team === "runner" || player.status === "caught")
      .forEach((player, index) => {
        indexes[player.player_id] = index;
      });
    return indexes;
  }

  async function getTeamPlayers(roomId, team, status = null) {
    return new Promise((resolve, reject) => {
      let query = "SELECT * FROM players WHERE room_id = ? AND team = ?";
      let params = [roomId, team];

      if (status) {
        query += " AND status = ?";
        params.push(status);
      }

      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        resolve(rows || []);
      });
    });
  }

  async function updateRoomStatus(roomId, status) {
    return new Promise((resolve, reject) => {
      db.run("UPDATE rooms SET status = ?, end_time = ? WHERE room_id = ?", [status, Date.now(), roomId], function (err) {
        if (err) reject(err);
        resolve(this.changes);
      });
    });
  }

  // Everything the zone clock needs from a room row
  function roomSchedule(room) {
    const radiusLevels = config.game.targetRadiusLevels;
    const zoneCount = radiusLevels.length;
    const gameDuration = room.game_duration || config.game.defaultGameDuration;
    const windowMs = zoneUtils.zoneWindowMs(gameDuration, zoneCount);
    const lockMs = zoneUtils.zoneLockMs(room.zone_lock == null ? config.game.defaultZoneLock : room.zone_lock, windowMs);
    const catchImmunity = room.catch_immunity == null ? config.game.defaultCatchImmunity : room.catch_immunity;
    const shieldZones = Math.min(zoneCount, room.shield_zones == null ? config.game.defaultShieldZones : room.shield_zones);
    const invisibility = room.invisibility == null ? config.game.defaultInvisibility : room.invisibility;

    // Null until the game is started. A room from before zone windows existed
    // has no clock either, and is left alone rather than being judged against
    // windows that were never running.
    const gameStartTime = room.game_start_time || null;

    return {
      radiusLevels,
      zoneOverhang: config.game.zoneOverhang,
      zoneCount,
      gameDuration,
      windowMs,
      lockMs,
      gameStartTime,
      gameEndTime: gameStartTime ? zoneUtils.gameEndTime(gameStartTime, windowMs, zoneCount) : null,
      catchImmunity,
      immunityMs: catchImmunity * 60 * 1000,
      shieldZones,
      shieldDeadline: zoneUtils.shieldDeadline(gameStartTime, windowMs, zoneCount, shieldZones),
      invisibility,
      invisibilityMs: invisibility * 60 * 1000,
    };
  }

  // Whether a runner joining now is given a shield: not in a game played
  // without them, nor once they have run out for everybody else
  function shieldAvailable(schedule, now) {
    return schedule.shieldZones > 0 && !(schedule.shieldDeadline && now >= schedule.shieldDeadline);
  }

  // The spell a runner spends invisible for keeping their shield until it ran
  // out, or null if they didn't earn one. One still holding a shield past the
  // deadline has earned it too - the schedule tick just hasn't taken it yet.
  function invisibilityOf(player, schedule) {
    if (player.team !== "runner" || !schedule.shieldDeadline || schedule.invisibilityMs <= 0) {
      return null;
    }

    if (player.shield_lost_reason !== "expired" && !player.shield_active) {
      return null;
    }

    return { start: schedule.shieldDeadline, end: schedule.shieldDeadline + schedule.invisibilityMs };
  }

  function isInvisible(player, schedule, now) {
    const period = invisibilityOf(player, schedule);
    return Boolean(period) && now >= period.start && now < period.end;
  }

  // What to leave out of a runner's live trail, so nobody can work out where
  // they went while invisible once they reappear
  function hiddenPeriods(player, schedule) {
    const period = invisibilityOf(player, schedule);
    return period ? [period] : [];
  }

  // Which zone's window a runner lost their shield in, for the results
  function shieldLostZone(player, schedule) {
    if (!player.shield_lost_at || !schedule.gameStartTime) {
      return null;
    }

    return Math.min(schedule.zoneCount, zoneUtils.currentZoneIndex(player.shield_lost_at, schedule.gameStartTime, schedule.windowMs, schedule.zoneCount) + 1);
  }

  // Zone windows run on the game clock, so they have to close on their own: a
  // runner with their app shut still misses a zone, and a server that was down
  // over a boundary still catches up on it when it comes back.
  async function processZoneSchedules() {
    const rooms = await getActiveRooms();

    for (const { room_id } of rooms) {
      await withRoomLock(room_id, () => processRoomSchedule(room_id));
    }
  }

  async function processRoomSchedule(roomId) {
    // Read fresh under the lock: the game may have just ended
    const room = await getRoomById(roomId);

    if (!room || room.status !== "active") {
      return;
    }

    const schedule = roomSchedule(room);

    if (!schedule.gameStartTime) {
      return;
    }

    const runners = await getTeamPlayers(room.room_id, "runner");
    let changed = false;

    for (const runner of runners) {
      if (runner.status === "won" || runner.status === "caught") {
        continue;
      }

      const missed = await checkForMissedZone(room, schedule, runner);
      changed = changed || missed;
    }

    // Shields run out after the zones they cover. Anyone who missed the last of
    // those zones went out over it just above, so only runners still in the
    // game are left holding one.
    if (schedule.shieldDeadline && Date.now() >= schedule.shieldDeadline) {
      const expired = await expireShields(room, schedule);
      changed = changed || expired;
    }

    if (Date.now() >= schedule.gameEndTime) {
      await endGameOnTime(room);
    } else if (changed) {
      await broadcastGameState(room.room_id);
      await checkForGameOver(room.room_id);
    }
  }

  // Every runner still holding a shield loses it together. Having kept it that
  // long, each of them goes invisible for a spell (see invisibilityOf).
  async function expireShields(room, schedule) {
    const holders = (await getTeamPlayers(room.room_id, "runner")).filter((runner) => runner.shield_active && runner.status !== "won" && runner.status !== "caught");

    if (holders.length === 0) {
      return false;
    }

    for (const runner of holders) {
      await spendShield(runner.player_id, "expired", null);
    }

    console.log(`Shields ran out in room ${room.room_id} for ${holders.length} runner(s)`);

    io.to(room.room_id).emit("shields_expired", {
      zoneNumber: schedule.shieldZones,
      invisibleUntil: schedule.invisibilityMs > 0 ? schedule.shieldDeadline + schedule.invisibilityMs : null,
      players: holders.map((runner) => ({ playerId: runner.player_id, username: runner.username })),
      timestamp: Date.now(),
    });

    return true;
  }

  // A runner still on a zone whose window the clock has passed never pinged
  // inside it in time, and that puts them out - shield or no shield
  async function checkForMissedZone(room, schedule, runner) {
    const target = await getActiveTarget(room.room_id, runner.player_id);

    if (!target) {
      return false;
    }

    const clockIndex = zoneUtils.currentZoneIndex(Date.now(), schedule.gameStartTime, schedule.windowMs, schedule.zoneCount);
    const zoneIndex = target.zone_index || 0;

    if (zoneIndex >= clockIndex) {
      return false;
    }

    const missedZoneNumber = zoneIndex + 1;
    console.log(`Runner ${runner.player_id} missed zone ${missedZoneNumber}`);

    await applyStrike(room.room_id, runner.player_id, "missed_zone", schedule, missedZoneNumber);
    return true;
  }

  // A shield only ever stands between a runner and a hunter: their first catch
  // costs them the shield if they still have one. A catch without one, or a
  // missed zone whatever they are holding, puts them out of the game and onto
  // the hunters' team.
  async function applyStrike(roomId, playerId, reason, schedule, zoneNumber = null) {
    const player = await getPlayerById(playerId);

    if (!player || player.team !== "runner" || player.status === "won" || player.status === "caught") {
      return null;
    }

    const now = Date.now();

    if (reason === "caught" && player.shield_active) {
      // Losing the shield to a catch also buys a spell of immunity, so the
      // hunter who just caught them can't simply catch them again
      const immunityUntil = schedule.immunityMs > 0 ? now + schedule.immunityMs : null;
      await spendShield(playerId, reason, immunityUntil);

      io.to(roomId).emit("shield_lost", {
        playerId,
        username: player.username,
        reason,
        zoneNumber,
        immunityUntil,
        timestamp: now,
      });

      return { outcome: "shield_lost", immunityUntil };
    }

    await eliminatePlayer(playerId, reason);

    // Their open connection should ping as a hunter from now on too
    connectedPlayers.forEach((info) => {
      if (info.playerId === playerId) {
        info.team = "hunter";
      }
    });

    io.to(roomId).emit("runner_caught", {
      caughtPlayerId: playerId,
      username: player.username,
      reason,
      zoneNumber,
      timestamp: now,
    });

    return { outcome: "eliminated" };
  }

  // Move a runner on to the given zone, locked until its window's lock runs out
  async function moveTargetToZone(target, zoneIndex, schedule) {
    const window = zoneUtils.zoneWindow(zoneIndex, schedule.gameStartTime, schedule.windowMs, schedule.lockMs);
    const radiusLevel = schedule.radiusLevels[zoneIndex];

    await new Promise((resolve, reject) => {
      db.run(
        "UPDATE targets SET radius_level = ?, zone_index = ?, zone_status = ?, activation_time = ?, window_close_time = ? WHERE target_id = ?",
        [radiusLevel, zoneIndex, zoneUtils.zoneStatusAt(Date.now(), window), window.openTime, window.closeTime, target.target_id],
        function (err) {
          if (err) reject(err);
          resolve(this.changes);
        },
      );
    });

    // Keep the row we were handed in step with the database
    target.radius_level = radiusLevel;
    target.zone_index = zoneIndex;
    target.activation_time = window.openTime;
    target.window_close_time = window.closeTime;
  }

  // The clock has run out on the final zone's window
  async function endGameOnTime(room) {
    console.log(`Game clock finished for room ${room.room_id}`);
    await updateRoomStatus(room.room_id, "completed");

    io.to(room.room_id).emit("game_over", {
      reason: "Time is up - the final zone has closed",
      gameState: await getGameState(room.room_id),
    });
  }

  // The game is over once every runner is out or has won
  async function checkForGameOver(roomId) {
    const room = await getRoomById(roomId);

    // Only a game still being played can end, and only once
    if (!room || room.status !== "active") {
      return false;
    }

    const runners = await getTeamPlayers(roomId, "runner");
    const stillRunning = runners.filter((runner) => runner.status !== "won" && runner.status !== "caught");

    if (stillRunning.length > 0) {
      return false;
    }

    await updateRoomStatus(roomId, "completed");

    io.to(roomId).emit("game_over", {
      reason: "All runners have been caught or reached their targets",
      gameState: await getGameState(roomId),
    });

    return true;
  }

  // Each player gets their own view of the state, since a runner's zones are
  // theirs alone and hunters are shown none at all
  async function broadcastGameState(roomId, exceptSocketId = null) {
    await broadcastToPlayers(roomId, "game_state", (gameState) => gameState, exceptSocketId);
  }

  async function broadcastToPlayers(roomId, event, payloadFor, exceptSocketId = null) {
    const states = new Map();

    for (const [socketId, info] of [...connectedPlayers.entries()]) {
      if (info.roomId !== roomId || socketId === exceptSocketId) {
        continue;
      }

      const playerSocket = io.sockets.sockets.get(socketId);

      if (!playerSocket) {
        continue;
      }

      if (!states.has(info.playerId)) {
        states.set(info.playerId, await getGameState(roomId, info.playerId));
      }

      playerSocket.emit(event, payloadFor(states.get(info.playerId)));
    }
  }

  async function getActiveRooms() {
    return new Promise((resolve, reject) => {
      db.all("SELECT * FROM rooms WHERE status = 'active'", (err, rows) => {
        if (err) reject(err);
        resolve(rows || []);
      });
    });
  }

  // How a player's game went, in one word, for the scoreboard and the replay
  function playerOutcome(player, room) {
    if (player.status === "won") {
      return "won";
    }

    if (player.status === "caught") {
      if (player.elimination_reason === "missed_zone" || player.elimination_reason === "left") {
        return player.elimination_reason;
      }

      return "caught";
    }

    if (player.left_at) {
      return "left";
    }

    if (player.team !== "runner") {
      return "hunter";
    }

    // Still a runner when the clock ran out: they never made it home
    return room.status === "completed" ? "out_of_time" : "running";
  }

  // Everything worth looking back on once the game is over
  async function buildGameReview(roomId) {
    const room = await getRoomById(roomId);

    if (!room) {
      return null;
    }

    const schedule = roomSchedule(room);

    // Nothing to look back on until the game has actually been played
    if (!schedule.gameStartTime) {
      return null;
    }

    const players = await getRoomPlayers(roomId);
    const colorIndexes = getRunnerColorIndexes(players);
    const endTime = room.end_time || Date.now();
    const trails = {};

    for (const player of players) {
      // Only players who ran leave a trail behind them
      if (colorIndexes[player.player_id] === undefined) {
        continue;
      }

      const trail = await getReviewTrail(player.player_id, schedule.gameStartTime, endTime);

      if (trail.sightings.length === 0) {
        continue;
      }

      trails[player.player_id] = {
        playerId: player.player_id,
        username: player.username,
        colorIndex: colorIndexes[player.player_id],
        trail,
      };
    }

    return {
      roomName: room.room_name,
      status: room.status,
      gameDuration: schedule.gameDuration,
      gameStartTime: schedule.gameStartTime,
      endTime,
      targetArea: {
        lat: room.central_lat,
        lng: room.central_lng,
        radius: room.target_radius || config.game.defaultTargetAreaRadius,
      },

      // Still a secret if somehow the game is not over yet
      finalZone: room.status === "completed" ? finalZoneOf(room, schedule) : null,
      players: players.map((player) => ({
        playerId: player.player_id,
        username: player.username,
        team: player.team,
        status: player.status,
        outcome: playerOutcome(player, room),
        shieldActive: Boolean(player.shield_active),
        colorIndex: colorIndexes[player.player_id] ?? null,
        location: player.last_lat != null && player.last_lng != null ? { lat: player.last_lat, lng: player.last_lng } : null,
        lastPingTime: player.last_ping_time,
      })),
      trails,
    };
  }

  // A runner's whole game rather than the last hour, and in more detail than
  // the live map keeps: nobody is chasing anybody any more
  async function getReviewTrail(playerId, from, to) {
    const rows = await new Promise((resolve, reject) => {
      db.all("SELECT lat, lng, timestamp FROM location_history WHERE player_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp ASC", [playerId, from, to], function (err, result) {
        if (err) reject(err);
        resolve(result || []);
      });
    });

    return trailUtils.buildTrail(rows, to, { ...config.game.trail, ...config.game.trail.review, windowMs: Math.max(1, to - from) });
  }

  // The one zone every runner in the game is racing for
  function finalZoneOf(room, schedule) {
    if (room.final_lat == null || room.final_lng == null) {
      return null;
    }

    return {
      lat: room.final_lat,
      lng: room.final_lng,
      radius: schedule.radiusLevels[schedule.zoneCount - 1],
    };
  }

  async function getPlayerTargets(roomId, playerId) {
    return new Promise((resolve, reject) => {
      db.all("SELECT * FROM targets WHERE room_id = ? AND player_id = ?", [roomId, playerId], (err, rows) => {
        if (err) reject(err);
        resolve(rows || []);
      });
    });
  }

  // A runner only ever has one zone in play at a time
  async function getActiveTarget(roomId, playerId) {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM targets WHERE room_id = ? AND player_id = ? AND status = 'active' ORDER BY rowid LIMIT 1", [roomId, playerId], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });
  }

  // The window a target's current zone can be captured in
  function targetWindow(target) {
    return { openTime: target.activation_time, closeTime: target.window_close_time };
  }

  // One zone from a runner's chain, as {lat, lng, radius}
  function targetZone(target, zoneIndex) {
    try {
      const zones = JSON.parse(target.zones || "[]");
      return zones[zoneIndex] || null;
    } catch (error) {
      console.error(`Could not read the zone chain of target ${target.target_id}`, error);
      return null;
    }
  }

  // What a runner is told about their hunt: the circle they are on now, and
  // nothing about where it is closing in on
  function formatTarget(target) {
    const window = targetWindow(target);
    const zoneIndex = target.zone_index || 0;
    const zone = targetZone(target, zoneIndex);

    return {
      targetId: target.target_id,
      playerId: target.player_id,
      location: zone ? { lat: zone.lat, lng: zone.lng } : null,
      radiusLevel: target.radius_level,
      zoneIndex,
      zoneNumber: zoneIndex + 1,
      status: target.status,
      zoneStatus: zoneUtils.zoneStatusAt(Date.now(), window),
      windowOpenTime: window.openTime,
      windowCloseTime: window.closeTime,
      reachedAt: target.reached_at,
    };
  }

  async function getGameState(roomId, requestingPlayerId = null) {
    try {
      console.log(`Getting game state for room: ${roomId}`);

      // Get room details
      const room = await getRoomById(roomId);

      if (!room) {
        console.error(`Room ${roomId} not found when getting game state`);
        return null;
      }

      // Get all players in the room
      const players = await getRoomPlayers(roomId);
      const runnerColorIndexes = getRunnerColorIndexes(players);
      const schedule = roomSchedule(room);
      const zoneProgress = await getRoomZoneProgress(roomId, schedule);

      // Get trails for all runners
      const runnerTrails = {};
      const runnerPlayers = players.filter((player) => player.team === "runner");

      for (const runner of runnerPlayers) {
        const trail = await getRunnerTrail(runner.player_id, { lat: runner.last_lat, lng: runner.last_lng, timestamp: runner.last_ping_time }, hiddenPeriods(runner, schedule));
        if (trail.sightings.length > 0) {
          runnerTrails[runner.player_id] = {
            playerId: runner.player_id,
            username: runner.username,
            team: "runner",
            location: {
              lat: runner.last_lat,
              lng: runner.last_lng,
            },
            lastPingTime: runner.last_ping_time,
            colorIndex: runnerColorIndexes[runner.player_id],
            trail,
          };
        }
      }

      // A runner's zones are theirs alone, and hunters are told nothing about
      // where anybody's zones are: their whole job is to work it out
      const requestingPlayer = requestingPlayerId ? players.find((player) => player.player_id === requestingPlayerId) : null;
      const targets = requestingPlayer && requestingPlayer.team === "runner" ? await getPlayerTargets(roomId, requestingPlayerId) : [];

      // Format targets for client
      const formattedTargets = targets.map(formatTarget);

      // Format players for client. Shields are public: hunters can see who still
      // has one, who is briefly immune after spending theirs, and who is
      // invisible for having kept theirs - though not where they are.
      const formattedPlayers = players.map((player) => ({
        playerId: player.player_id,
        roomId: player.room_id,
        username: player.username,
        team: player.team,
        status: player.status,
        outcome: playerOutcome(player, room),
        shieldActive: Boolean(player.shield_active),
        shieldLostReason: player.shield_lost_reason || null,
        shieldLostZone: shieldLostZone(player, schedule),
        immunityUntil: player.immunity_until || null,
        invisibleUntil: player.shield_lost_reason === "expired" ? invisibilityOf(player, schedule)?.end || null : null,
        eliminationReason: player.elimination_reason || null,
        isHost: player.player_id === room.host_player_id,

        // How far they have got: which zone they are on, and how many they
        // have captured. Numbers only - where those zones are stays private
        // to the runner they belong to.
        currentZone: zoneProgress[player.player_id]?.currentZone ?? null,
        zonesCaptured: zoneProgress[player.player_id]?.zonesCaptured ?? null,

        // Whether their app is open right now. Closing it is not leaving.
        connected: isPlayerConnected(player.player_id),

        // Left the game part way through, so no longer in the player lists
        leftAt: player.left_at || null,
        location: {
          lat: player.last_lat,
          lng: player.last_lng,
        },
        lastPingTime: player.last_ping_time,
        colorIndex: runnerColorIndexes[player.player_id] ?? null,
      }));

      // Construct game state
      const gameState = {
        roomId: room.room_id,
        roomName: room.room_name,
        hostPlayerId: room.host_player_id || null,
        targetRadius: room.target_radius,
        gameDuration: schedule.gameDuration,
        catchImmunity: schedule.catchImmunity,
        shieldZones: schedule.shieldZones,
        shieldDeadline: schedule.shieldDeadline,
        invisibility: schedule.invisibility,
        zoneCount: schedule.zoneCount,
        zoneWindowMs: schedule.windowMs,
        zoneLockMs: schedule.lockMs,
        zoneRadiusLevels: schedule.radiusLevels,
        gameStartTime: schedule.gameStartTime,
        gameEndTime: schedule.gameEndTime,

        // Where everyone was racing to, kept back until the game is over
        finalZone: room.status === "completed" ? finalZoneOf(room, schedule) : null,
        centralLocation: {
          lat: room.central_lat,
          lng: room.central_lng,
        },
        startTime: room.start_time,
        endTime: room.end_time,
        status: room.status,
        players: formattedPlayers,
        targets: formattedTargets,
        runnerTrails: runnerTrails,
      };

      return gameState;
    } catch (error) {
      console.error("Error getting game state:", error);
      return null;
    }
  }
  // Has this runner's ping captured the zone they're on?
  //
  // A zone can only be captured inside its own window: being in the right place
  // at the wrong time counts for nothing. Windows that close with the zone still
  // uncaptured are handled by the schedule tick, not here.
  async function checkTargetDiscovery(roomId, playerId, lat, lng) {
    console.log(`Checking zone capture for room ${roomId}, player ${playerId}`);

    const room = await getRoomById(roomId);

    if (!room) {
      console.error(`Room ${roomId} not found when checking zone capture`);
      return null;
    }

    const schedule = roomSchedule(room);

    // Zones only mean anything once the game clock is running
    if (!schedule.gameStartTime) {
      return null;
    }

    const target = await getActiveTarget(roomId, playerId);

    // No zone in play yet - a runner who joined mid-game, say - so give them
    // whichever zone the clock is on
    if (!target) {
      console.log(`No zone in play for player ${playerId}, generating one`);
      const newTarget = await generateTargetForPlayer(roomId, playerId);

      return newTarget ? { isNew: true, target: newTarget } : null;
    }

    const zoneIndex = target.zone_index || 0;
    const zoneStatus = zoneUtils.zoneStatusAt(Date.now(), targetWindow(target));

    if (zoneStatus !== "open") {
      console.log(`Zone ${zoneIndex + 1} for player ${playerId} is ${zoneStatus}, nothing to capture`);
      return null;
    }

    const zone = targetZone(target, zoneIndex);
    const isInZone = zone != null && geoUtils.calculateDistance(lat, lng, zone.lat, zone.lng) <= zone.radius;
    console.log(`Zone ${zoneIndex + 1} (${target.radius_level}m) is open, player inside: ${isInZone}`);

    if (!isInZone) {
      return null;
    }

    // The last zone is the runner's final target, so capturing it wins them the game
    if (zoneIndex >= schedule.zoneCount - 1) {
      return await reachFinalTarget(roomId, playerId, target);
    }

    // Capturing a zone reveals the next one straight away so the runner can
    // start moving, though it stays locked until its own window's lock runs out
    const nextIndex = zoneIndex + 1;
    await moveTargetToZone(target, nextIndex, schedule);

    const nextWindow = zoneUtils.zoneWindow(nextIndex, schedule.gameStartTime, schedule.windowMs, schedule.lockMs);

    const nextZone = targetZone(target, nextIndex);

    return {
      updatedTarget: {
        targetId: target.target_id,
        location: nextZone ? { lat: nextZone.lat, lng: nextZone.lng } : null,
        radiusLevel: schedule.radiusLevels[nextIndex],
        capturedZoneNumber: zoneIndex + 1,
        zoneNumber: nextIndex + 1,
        zoneStatus: zoneUtils.zoneStatusAt(Date.now(), nextWindow),
        windowOpenTime: nextWindow.openTime,
        windowCloseTime: nextWindow.closeTime,
      },
    };
  }

  // The runner captured the final zone, which is their target reached and won
  async function reachFinalTarget(roomId, playerId, target) {
    console.log(`Player ${playerId} reached their final target ${target.target_id}`);

    await new Promise((resolve, reject) => {
      db.run("UPDATE targets SET status = 'reached', reached_at = ? WHERE target_id = ?", [Date.now(), target.target_id], function (err) {
        if (err) reject(err);
        resolve(this.changes);
      });
    });

    await updatePlayerStatus(playerId, "won");

    const player = await getPlayerById(playerId);
    const gameOver = await checkForGameOver(roomId);

    if (!gameOver) {
      // Just this runner's victory - the rest are still out there
      io.to(roomId).emit("runner_won", {
        playerId,
        username: player.username,
        targetId: target.target_id,
        timestamp: Date.now(),
      });
    }

    return {
      reachedTarget: {
        targetId: target.target_id,
        location: {
          lat: target.lat,
          lng: target.lng,
        },
      },
    };
  }

  // Give a runner their hidden final target, revealed to them one zone at a time
  async function generateTargetForPlayer(roomId, playerId) {
    console.log(`Generating target for player ${playerId} in room ${roomId}`);

    // Check if player has already won
    const player = await getPlayerById(playerId);

    if (player && player.status === "won") {
      console.log(`Player ${playerId} has already won, not generating new target`);
      return null;
    }

    const room = await getRoomById(roomId);

    if (!room) {
      console.error(`Room ${roomId} not found when generating target`);
      return null;
    }

    // If the player already has a zone in play, don't generate more
    const existingTarget = await getActiveTarget(roomId, playerId);

    if (existingTarget) {
      console.log(`Player ${playerId} already has a target`);
      return formatTarget(existingTarget);
    }

    const schedule = roomSchedule(room);

    // Zone windows are measured from the start of the game, so there is nothing
    // to hand out until it has started
    if (!schedule.gameStartTime) {
      console.log(`Room ${roomId} has not started, not generating a target`);
      return null;
    }

    if (room.final_lat == null || room.final_lng == null) {
      console.error(`Room ${roomId} has no final zone yet`);
      return null;
    }

    // Everyone is racing for the same final zone, but by their own route in:
    // each runner gets their own chain of zones closing in on it
    const zones = geoUtils.generateZoneChain(room.final_lat, room.final_lng, schedule.radiusLevels, schedule.zoneOverhang);

    // Start on whatever zone the clock is on, so a runner who joins late isn't
    // handed a window that closed before they arrived
    const zoneIndex = Math.min(schedule.zoneCount - 1, zoneUtils.currentZoneIndex(Date.now(), schedule.gameStartTime, schedule.windowMs, schedule.zoneCount));
    const window = zoneUtils.zoneWindow(zoneIndex, schedule.gameStartTime, schedule.windowMs, schedule.lockMs);
    const targetId = uuidv4();

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO targets 
        (target_id, room_id, player_id, lat, lng, radius_level, zone_index, zones, status, zone_status, activation_time, window_close_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [targetId, roomId, playerId, room.final_lat, room.final_lng, schedule.radiusLevels[zoneIndex], zoneIndex, JSON.stringify(zones), zoneUtils.zoneStatusAt(Date.now(), window), window.openTime, window.closeTime],
        function (err) {
          if (err) reject(err);
          resolve(this.lastID);
        },
      );
    });

    console.log(`Created new target ${targetId} for player ${playerId} at zone ${zoneIndex + 1}`);

    return formatTarget(await getActiveTarget(roomId, playerId));
  }

  // Exposed so tests can drive the zone clock without waiting on the timer
  return { processZoneSchedules };
};

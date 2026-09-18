const { v4: uuidv4 } = require("uuid");
const geoUtils = require("../../shared/utils/geoUtils");
const trailUtils = require("../../shared/utils/trailUtils");
const zoneUtils = require("../../shared/utils/zoneUtils");
const config = require("../config/default");
const voiceChatHandler = require("./voiceChatHandler");

module.exports = function (io, db) {
  // Track connected users
  const connectedPlayers = new Map();

  // Zone windows close on the game clock whether or not anyone has their app
  // open, so the server drives them rather than waiting for the next ping
  const scheduleTimer = setInterval(() => {
    processZoneSchedules().catch((error) => console.error("Error processing zone schedules:", error));
  }, config.game.scheduleTickInterval);

  // Never hold the process open for the tick
  if (scheduleTimer.unref) {
    scheduleTimer.unref();
  }

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Initialize voice chat handler for this socket connection
    voiceChatHandler(io, socket, connectedPlayers);

    // Create a room
    socket.on("create_room", async (data) => {
      try {
        const { roomName, username, team, gameDuration, catchImmunity, targetRadius, centralLat, centralLng } = data;
        let roomId;

        // Create new room
        roomId = uuidv4();
        const settings = await createRoom(roomId, roomName, { gameDuration, catchImmunity, centralLat, centralLng, targetRadius });

        return socket.emit("room_created", {
          roomId,
          roomName,
          gameDuration: settings.gameDuration,
          catchImmunity: settings.catchImmunity,
          targetRadius,
          centralLat,
          centralLng,
        });
      } catch (error) {
        console.error("Error creating room:", error);
        socket.emit("error", { message: "Failed to create room" });
      }
    });

    // Join a room
    socket.on("join_room", async (data) => {
      try {
        const { roomName, username, team } = data;
        let roomId, playerId;

        // Check if room exists
        const room = await getRoom(roomName);
        let playerTeam = team;

        if (room) {
          roomId = room.room_id;

          // Check if player exists in this room
          const player = await getPlayer(roomId, username);

          if (player) {
            // Player exists, reconnect
            playerId = player.player_id;

            // A runner who was caught is a hunter now, whatever team their saved
            // session still thinks they are on
            playerTeam = player.team;

            // Update player status only if they haven't won or been caught
            if (player.status !== "won" && player.status !== "caught") {
              await updatePlayerStatus(playerId, "lobby");
            }
          } else {
            // New player joining existing room
            playerId = uuidv4();
            await createPlayer(playerId, roomId, username, team);
          }
        } else {
          return socket.emit("error", { message: "Room not found" });
        }

        // Join socket room
        socket.join(roomId);

        // Track player in connected players
        connectedPlayers.set(socket.id, { roomId, playerId, username, team: playerTeam });

        // Send initial game state
        const gameState = await getGameState(roomId, playerId);
        socket.emit("game_state", gameState);

        // Notify room about new player
        io.to(roomId).emit("player_joined", {
          playerId: playerId,
          username,
          team: playerTeam,
          timestamp: Date.now(),
        });

        // Bring everyone else's state up to date with their own view of it
        await broadcastGameState(roomId);

        // Return player and room info
        socket.emit("join_success", {
          roomId,
          playerId,
          gameState,
        });
      } catch (error) {
        console.error("Error joining room:", error);
        socket.emit("error", { message: "Failed to join room" });
      }
    });

    // Handle delete room
    socket.on("delete_room", async (data) => {
      try {
        const { roomId } = data;
        console.log(`Attempting to delete room with ID: ${roomId}`);
        const playerInfo = connectedPlayers.get(socket.id);

        if (!playerInfo) {
          console.log(`Player not found for socket ID: ${socket.id}`);
          return socket.emit("error", { message: "Player not found" });
        }

        // Verify player is the room creator
        const room = await new Promise((resolve, reject) => {
          db.get("SELECT * FROM rooms WHERE room_id = ?", [roomId], (err, row) => {
            if (err) reject(err);
            resolve(row);
          });
        });

        if (!room) {
          console.log(`Room not found with ID: ${roomId}`);
          return socket.emit("error", { message: "Room not found" });
        }

        // Get all players in the room
        const playersInRoom = [];
        connectedPlayers.forEach((player, socketId) => {
          if (player.roomId === roomId) {
            playersInRoom.push({
              socketId,
              playerId: player.playerId,
            });
          }
        });

        // Notify all players in the room
        io.to(roomId).emit("room_deleted", {
          roomId,
          message: "Room has been deleted by the host",
        });

        // Delete room from database
        await deleteRoom(roomId);

        // Disconnect all players from the room
        playersInRoom.forEach((player) => {
          const playerSocket = io.sockets.sockets.get(player.socketId);
          if (playerSocket) {
            playerSocket.leave(roomId);
            connectedPlayers.delete(player.socketId);
          }
        });

        // Confirm deletion to the host
        socket.emit("delete_success", {
          message: "Room deleted successfully",
        });
      } catch (error) {
        console.error("Error deleting room:", error);
        socket.emit("error", { message: "Failed to delete room" });
      }
    });

    // Handle start game
    socket.on("start_game", async (data) => {
      try {
        console.log("Received start_game event:", data);
        const { roomId } = data;
        const playerInfo = connectedPlayers.get(socket.id);

        if (!playerInfo) {
          console.error("Player not found when starting game");
          return socket.emit("error", { message: "Player not found" });
        }

        const room = await getRoomById(roomId);

        if (!room) {
          return socket.emit("error", { message: "Room not found" });
        }

        // Start the game clock and hide the final zone somewhere in the play
        // area. Both have to be settled before any targets are generated.
        console.log("Starting the game clock for room:", roomId);
        await startRoom(room, Date.now());

        // Generate targets for all runners in the room. Runners who haven't
        // pinged yet still get one - their first zone window is already running.
        const runners = await getTeamPlayers(roomId, "runner");
        console.log(`Found ${runners.length} runners for initial target generation`);

        for (const runner of runners) {
          // Everyone starts the game playing, with a full shield
          await updatePlayerStatus(runner.player_id, "active");
          await resetShield(runner.player_id);

          // Generate a target for this runner
          const target = await generateTargetForPlayer(roomId, runner.player_id);

          if (target) {
            console.log(`Generated initial target for runner ${runner.player_id}`);

            // Find the socket for this player
            for (const [socketId, info] of connectedPlayers.entries()) {
              if (info.playerId === runner.player_id) {
                const playerSocket = io.sockets.sockets.get(socketId);
                if (playerSocket) {
                  // Notify player of their new target
                  playerSocket.emit("new_target", {
                    target,
                    gameState: await getGameState(roomId, runner.player_id),
                  });
                  break;
                }
              }
            }
          }
        }

        // Notify all players in room, each with their own view of the game
        console.log("Notifying all players in room about game start");
        await broadcastToPlayers(roomId, "game_started", (gameState) => ({ gameState }));
      } catch (error) {
        console.error("Error starting game:", error);
        socket.emit("error", { message: "Failed to start game" });
      }
    });

    // Handle location updates
    socket.on("location_update", async (data) => {
      try {
        const { lat, lng } = data;
        const playerInfo = connectedPlayers.get(socket.id);

        if (!playerInfo) {
          return socket.emit("error", { message: "Player not found" });
        }

        const { roomId, playerId, username, team } = playerInfo;
        const now = Date.now();

        // Update player location in database
        await updatePlayerLocation(playerId, lat, lng);

        // If player is runner, store location history and broadcast to hunters
        if (team === "runner") {
          // Store location in history
          await storeLocationHistory(playerId, roomId, lat, lng);

          // Broadcast runner location to all players in the room
          const locationData = {
            playerId,
            username,
            team: "runner",
            location: {
              lat,
              lng,
            },
            lastPingTime: now,
            colorIndex: getRunnerColorIndexes(await getRoomPlayers(roomId))[playerId],
            trail: await getRunnerTrail(playerId, { lat, lng, timestamp: now }),
          };

          io.to(roomId).emit("runner_location", locationData);

          // Check for target discovery for runners
          console.log(`Checking target discovery for runner ${playerId} at location ${lat}, ${lng}`);

          const targetResult = await checkTargetDiscovery(roomId, playerId, lat, lng);

          if (targetResult) {
            console.log(`Target result for ${playerId}:`, targetResult);

            // Get player info
            const playerData = await getPlayerById(playerId);

            // Handle different target results

            // Case 1: Player captured their final zone and won
            if (targetResult.reachedTarget) {
              console.log(`Player ${playerId} reached target ${targetResult.reachedTarget.targetId}`);

              // The room hears about it as runner_won; this is the winner's own copy
              socket.emit("target_reached", {
                targetId: targetResult.reachedTarget.targetId,
                location: targetResult.reachedTarget.location,
                playerId,
                username: playerData.username,
                gameState: await getGameState(roomId, playerId),
              });
            }
            // Case 2: Player captured the zone, so the next one is revealed
            else if (targetResult.updatedTarget) {
              console.log(`Player ${playerId} captured zone ${targetResult.updatedTarget.capturedZoneNumber}, revealing the next one`);

              // Notify just this player about the captured zone
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

              // Notify just this player about the new target
              socket.emit("new_target", {
                target: targetResult.target,
                gameState: await getGameState(roomId, playerId),
              });
            }
          }
        } else if (team === "hunter") {
          const locationData = {
            playerId,
            username,
            team: "hunter",
            location: {
              lat,
              lng,
            },
            lastPingTime: now,
            trail: null,
          };

          io.to(roomId).emit("runner_location", locationData);
        }
      } catch (error) {
        console.error("Error handling location update:", error);
        socket.emit("error", { message: "Error updating location" });
      }
    });

    // Handle player caught event
    socket.on("player_caught", async (data) => {
      try {
        const { caughtPlayerId } = data;
        const playerInfo = connectedPlayers.get(socket.id);

        if (!playerInfo) {
          return socket.emit("error", { message: "Player not found" });
        }

        const { roomId } = playerInfo;
        const room = await getRoomById(roomId);

        if (!room) {
          return socket.emit("error", { message: "Room not found" });
        }

        const caughtPlayer = await getPlayerById(caughtPlayerId);

        if (!caughtPlayer || caughtPlayer.team !== "runner") {
          return socket.emit("error", { message: "That player is not a runner" });
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
        await applyStrike(roomId, caughtPlayerId, "caught", roomSchedule(room));

        await broadcastGameState(roomId);
        await checkForGameOver(roomId);
      } catch (error) {
        console.error("Error handling caught player:", error);
      }
    });

    // Handle disconnect
    socket.on("disconnect", async () => {
      const playerInfo = connectedPlayers.get(socket.id);

      if (playerInfo) {
        const { roomId, playerId } = playerInfo;

        // Remove from connected players
        connectedPlayers.delete(socket.id);

        // Notify room
        io.to(roomId).emit("player_disconnected", {
          playerId,
          username: playerInfo.username,
          timestamp: Date.now(),
        });
      }

      console.log(`Socket disconnected: ${socket.id}`);
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

    socket.on("resync_game_state", async (data) => {
      try {
        const { roomId } = data;
        console.log(`Fetching game state for room: ${roomId}`);

        const playerInfo = connectedPlayers.get(socket.id);
        if (!playerInfo) {
          return socket.emit("error", { message: "Player not found" });
        }

        // Get game state specific to this player
        const gameState = await getGameState(roomId, playerInfo.playerId);
        socket.emit("game_state", gameState);
      } catch (error) {
        console.error("Error getting game state:", error);
        socket.emit("error", { message: "Failed to get game state" });
      }
    });
  });

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
  }

  async function getRoom(roomName) {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM rooms WHERE room_name = ?", [roomName], (err, row) => {
        if (err) reject(err);
        resolve(row);
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

  async function createRoom(roomId, roomName, settings) {
    const gameDuration = clamp(settings.gameDuration, 6, 240, config.game.defaultGameDuration);
    const catchImmunity = clamp(settings.catchImmunity, 0, 30, config.game.defaultCatchImmunity);

    await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO rooms (room_id, room_name, game_duration, catch_immunity, central_lat, central_lng, target_radius, start_time, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [roomId, roomName, gameDuration, catchImmunity, settings.centralLat, settings.centralLng, settings.targetRadius, Date.now(), "lobby"],
        function (err) {
          if (err) reject(err);
          resolve(this.lastID);
        },
      );
    });

    return { gameDuration, catchImmunity };
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

  async function getPlayer(roomId, username) {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM players WHERE room_id = ? AND username = ?", [roomId, username], (err, row) => {
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

  async function createPlayer(playerId, roomId, username, team) {
    return new Promise((resolve, reject) => {
      db.run("INSERT INTO players (player_id, room_id, username, team, status, shield_active, last_ping_time) VALUES (?, ?, ?, ?, ?, 1, ?)", [playerId, roomId, username, team, "active", Date.now()], function (err) {
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

  // Everyone goes into the game with a full shield and no leftover immunity
  async function resetShield(playerId) {
    return new Promise((resolve, reject) => {
      db.run("UPDATE players SET shield_active = 1, shield_lost_at = NULL, shield_lost_reason = NULL, immunity_until = NULL, elimination_reason = NULL WHERE player_id = ?", [playerId], function (err) {
        if (err) reject(err);
        resolve(this.changes);
      });
    });
  }

  // Spend a runner's one shield. A catch also buys them a spell of immunity;
  // a missed zone doesn't.
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
  async function getRunnerTrail(playerId, latestPing) {
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

    return trailUtils.buildTrail(rows, now, config.game.trail);
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
    const catchImmunity = room.catch_immunity == null ? config.game.defaultCatchImmunity : room.catch_immunity;

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
      gameStartTime,
      gameEndTime: gameStartTime ? zoneUtils.gameEndTime(gameStartTime, windowMs, zoneCount) : null,
      catchImmunity,
      immunityMs: catchImmunity * 60 * 1000,
    };
  }

  // Zone windows run on the game clock, so they have to close on their own: a
  // runner with their app shut still misses a zone, and a server that was down
  // over a boundary still catches up on it when it comes back.
  async function processZoneSchedules() {
    const rooms = await getActiveRooms();

    for (const room of rooms) {
      const schedule = roomSchedule(room);

      if (!schedule.gameStartTime) {
        continue;
      }

      const runners = await getTeamPlayers(room.room_id, "runner");
      let changed = false;

      for (const runner of runners) {
        if (runner.status === "won" || runner.status === "caught") {
          continue;
        }

        const advanced = await advanceRunnerZones(room, schedule, runner);
        changed = changed || advanced;
      }

      if (Date.now() >= schedule.gameEndTime) {
        await endGameOnTime(room);
      } else if (changed) {
        await broadcastGameState(room.room_id);
        await checkForGameOver(room.room_id);
      }
    }
  }

  // Walk a runner up to the zone the clock is on, taking a life for every window
  // that closed with its zone still uncaptured
  async function advanceRunnerZones(room, schedule, runner) {
    const target = await getActiveTarget(room.room_id, runner.player_id);

    if (!target) {
      return false;
    }

    const clockIndex = zoneUtils.currentZoneIndex(Date.now(), schedule.gameStartTime, schedule.windowMs, schedule.zoneCount);
    let zoneIndex = target.zone_index || 0;
    let changed = false;

    while (zoneIndex < clockIndex) {
      // This zone's window has closed and the runner never pinged inside it
      const missedZoneNumber = zoneIndex + 1;
      console.log(`Runner ${runner.player_id} missed zone ${missedZoneNumber}`);

      const strike = await applyStrike(room.room_id, runner.player_id, "missed_zone", schedule, missedZoneNumber);
      changed = true;
      zoneIndex += 1;

      if (strike && strike.outcome === "eliminated") {
        return changed;
      }

      // The clock has run out, so there is no further zone to move on to
      if (zoneIndex >= schedule.zoneCount) {
        break;
      }

      await moveTargetToZone(target, zoneIndex, schedule);

      emitToPlayer(runner.player_id, "zone_missed", {
        missedZoneNumber,
        zoneNumber: zoneIndex + 1,
        targetId: target.target_id,
        timestamp: Date.now(),
      });
    }

    return changed;
  }

  // A catch or a missed zone costs a runner their shield - the one dog's life
  // they share between the two. The second of either puts them out of the game
  // and onto the hunters' team.
  async function applyStrike(roomId, playerId, reason, schedule, zoneNumber = null) {
    const player = await getPlayerById(playerId);

    if (!player || player.team !== "runner" || player.status === "won" || player.status === "caught") {
      return null;
    }

    const now = Date.now();

    if (player.shield_active) {
      // Losing the shield to a catch also buys a spell of immunity, so the
      // hunter who just caught them can't simply catch them again
      const immunityUntil = reason === "caught" && schedule.immunityMs > 0 ? now + schedule.immunityMs : null;
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

  // Move a runner on to the given zone, locked until that zone's window opens
  async function moveTargetToZone(target, zoneIndex, schedule) {
    const window = zoneUtils.zoneWindow(zoneIndex, schedule.gameStartTime, schedule.windowMs);
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
  async function broadcastGameState(roomId) {
    await broadcastToPlayers(roomId, "game_state", (gameState) => gameState);
  }

  async function broadcastToPlayers(roomId, event, payloadFor) {
    const states = new Map();

    for (const [socketId, info] of connectedPlayers.entries()) {
      if (info.roomId !== roomId) {
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

  // Send an event to a player's open connections, if they have any
  function emitToPlayer(playerId, event, payload) {
    connectedPlayers.forEach((info, socketId) => {
      if (info.playerId !== playerId) {
        return;
      }

      const playerSocket = io.sockets.sockets.get(socketId);

      if (playerSocket) {
        playerSocket.emit(event, payload);
      }
    });
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
      return player.elimination_reason === "missed_zone" ? "missed_zone" : "caught";
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

      // Get trails for all runners
      const runnerTrails = {};
      const runnerPlayers = players.filter((player) => player.team === "runner");

      for (const runner of runnerPlayers) {
        const trail = await getRunnerTrail(runner.player_id, { lat: runner.last_lat, lng: runner.last_lng, timestamp: runner.last_ping_time });
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
      // has one, and who is briefly immune after spending theirs.
      const formattedPlayers = players.map((player) => ({
        playerId: player.player_id,
        roomId: player.room_id,
        username: player.username,
        team: player.team,
        status: player.status,
        outcome: playerOutcome(player, room),
        shieldActive: Boolean(player.shield_active),
        shieldLostReason: player.shield_lost_reason || null,
        immunityUntil: player.immunity_until || null,
        eliminationReason: player.elimination_reason || null,
        location: {
          lat: player.last_lat,
          lng: player.last_lng,
        },
        lastPingTime: player.last_ping_time,
        colorIndex: runnerColorIndexes[player.player_id] ?? null,
      }));

      const schedule = roomSchedule(room);

      // Construct game state
      const gameState = {
        roomId: room.room_id,
        roomName: room.room_name,
        targetRadius: room.target_radius,
        gameDuration: schedule.gameDuration,
        catchImmunity: schedule.catchImmunity,
        zoneCount: schedule.zoneCount,
        zoneWindowMs: schedule.windowMs,
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
    // start moving, though it stays locked until its own window opens
    const nextIndex = zoneIndex + 1;
    await moveTargetToZone(target, nextIndex, schedule);

    const nextWindow = zoneUtils.zoneWindow(nextIndex, schedule.gameStartTime, schedule.windowMs);

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
    const window = zoneUtils.zoneWindow(zoneIndex, schedule.gameStartTime, schedule.windowMs);
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

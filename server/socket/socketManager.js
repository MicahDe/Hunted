const { v4: uuidv4 } = require("uuid");
const geoUtils = require("../utils/geoUtils");

module.exports = function (io, db) {
  // Track connected users
  const connectedPlayers = new Map();

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Create or join a room
    socket.on("join_room", async (data) => {
      try {
        const { roomName, username, team } = data;
        let roomId, playerId;

        // Check if room exists
        const room = await getRoom(roomName);

        if (room) {
          roomId = room.room_id;

          // Check if player exists in this room
          const player = await getPlayer(roomId, username);

          if (player) {
            // Player exists, reconnect
            playerId = player.player_id;

            // Update player status
            await updatePlayerStatus(playerId, "active");
          } else {
            // New player joining existing room
            playerId = uuidv4();
            await createPlayer(playerId, roomId, username, team);
          }
        } else {
          // Create new room
          roomId = uuidv4();
          await createRoom(
            roomId,
            roomName,
            data.gameDuration,
            data.centralLat,
            data.centralLng
          );

          // Create first player
          playerId = uuidv4();
          await createPlayer(playerId, roomId, username, team);
        }

        // Join socket room
        socket.join(roomId);

        // Track player in connected players
        connectedPlayers.set(socket.id, { roomId, playerId, username, team });

        // Send initial game state
        const gameState = await getGameState(roomId);
        socket.emit("game_state", gameState);

        // Notify room about new player
        io.to(roomId).emit("player_joined", {
          playerId: playerId,
          username,
          team,
          timestamp: Date.now(),
        });

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
        const playerInfo = connectedPlayers.get(socket.id);

        if (!playerInfo) {
          return socket.emit("error", { message: "Player not found" });
        }

        // Verify player is the room creator
        const room = await getRoom(roomId);
        if (!room) {
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

        // Update room status to active
        console.log("Updating room status to active for room:", roomId);
        await updateRoomStatus(roomId, "active");

        // Get updated game state
        const gameState = await getGameState(roomId);
        console.log(
          "Game state after starting:",
          gameState ? "Retrieved successfully" : "Failed to retrieve"
        );

        // Notify all players in room
        console.log("Notifying all players in room about game start");
        io.to(roomId).emit("game_started", {
          gameState,
        });
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

        // Update player location in database
        await updatePlayerLocation(playerId, lat, lng);

        // If player is runner, broadcast to hunters
        if (team === "runner") {
          // Get all hunters in the room
          const hunters = await getTeamPlayers(roomId, "hunter");

          // Broadcast runner location to all hunters in the room
          const locationData = {
            playerId,
            username,
            lat,
            lng,
            timestamp: Date.now(),
          };

          hunters.forEach((hunter) => {
            socket.to(hunter.player_id).emit("runner_location", locationData);
          });

          // Check if runner reached any targets
          const reachedTarget = await checkTargetDiscovery(
            roomId,
            playerId,
            lat,
            lng
          );

          if (reachedTarget) {
            // Update game state and notify all players
            const gameState = await getGameState(roomId);
            io.to(roomId).emit("target_reached", {
              playerId,
              username,
              target: reachedTarget,
              gameState,
            });
          }
        }
      } catch (error) {
        console.error("Error updating location:", error);
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

        // Update caught player status
        await updatePlayerStatus(caughtPlayerId, "caught");

        // Change team to hunter
        await updatePlayerTeam(caughtPlayerId, "hunter");

        // Get player info
        const caughtPlayer = await getPlayerById(caughtPlayerId);

        // Notify all players in room
        io.to(roomId).emit("runner_caught", {
          caughtPlayerId,
          username: caughtPlayer.username,
          timestamp: Date.now(),
        });

        // Check if all runners are caught
        const activeRunners = await getTeamPlayers(roomId, "runner", "active");

        if (activeRunners.length === 0) {
          // Game over - hunters win
          await updateRoomStatus(roomId, "completed");

          // Get final game state
          const gameState = await getGameState(roomId);

          // Notify all players
          io.to(roomId).emit("game_over", {
            winner: "hunters",
            reason: "All runners caught",
            gameState,
          });
        }
      } catch (error) {
        console.error("Error handling caught player:", error);
      }
    });

    // Handle disconnect
    socket.on("disconnect", async () => {
      const playerInfo = connectedPlayers.get(socket.id);

      if (playerInfo) {
        const { roomId, playerId } = playerInfo;

        // Update player status to inactive
        await updatePlayerStatus(playerId, "inactive");

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
  });

  // Database helper functions
  async function deleteRoom(roomId) {
    return new Promise((resolve, reject) => {
      // Delete players first due to foreign key constraints
      db.run("DELETE FROM players WHERE room_id = ?", [roomId], function (err) {
        if (err) {
          console.error("Error deleting players:", err);
          return reject(err);
        }

        // Delete targets
        db.run(
          "DELETE FROM targets WHERE room_id = ?",
          [roomId],
          function (err) {
            if (err) {
              console.error("Error deleting targets:", err);
              return reject(err);
            }

            // Delete room
            db.run(
              "DELETE FROM rooms WHERE room_id = ?",
              [roomId],
              function (err) {
                if (err) {
                  console.error("Error deleting room:", err);
                  return reject(err);
                }

                resolve();
              }
            );
          }
        );
      });
    });
  }

  async function getRoom(roomName) {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM rooms WHERE room_name = ?",
        [roomName],
        (err, row) => {
          if (err) reject(err);
          resolve(row);
        }
      );
    });
  }

  async function createRoom(
    roomId,
    roomName,
    gameDuration,
    centralLat,
    centralLng
  ) {
    return new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO rooms (room_id, room_name, game_duration, central_lat, central_lng, start_time, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          roomId,
          roomName,
          gameDuration,
          centralLat,
          centralLng,
          Date.now(),
          "active",
        ],
        function (err) {
          if (err) reject(err);
          resolve(this.lastID);
        }
      );
    });
  }

  async function getPlayer(roomId, username) {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM players WHERE room_id = ? AND username = ?",
        [roomId, username],
        (err, row) => {
          if (err) reject(err);
          resolve(row);
        }
      );
    });
  }

  async function getPlayerById(playerId) {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM players WHERE player_id = ?",
        [playerId],
        (err, row) => {
          if (err) reject(err);
          resolve(row);
        }
      );
    });
  }

  async function createPlayer(playerId, roomId, username, team) {
    return new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO players (player_id, room_id, username, team, status, last_ping_time) VALUES (?, ?, ?, ?, ?, ?)",
        [playerId, roomId, username, team, "active", Date.now()],
        function (err) {
          if (err) reject(err);
          resolve(this.lastID);
        }
      );
    });
  }

  async function updatePlayerStatus(playerId, status) {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE players SET status = ? WHERE player_id = ?",
        [status, playerId],
        function (err) {
          if (err) reject(err);
          resolve(this.changes);
        }
      );
    });
  }

  async function updatePlayerTeam(playerId, team) {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE players SET team = ? WHERE player_id = ?",
        [team, playerId],
        function (err) {
          if (err) reject(err);
          resolve(this.changes);
        }
      );
    });
  }

  async function updatePlayerLocation(playerId, lat, lng) {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE players SET last_lat = ?, last_lng = ?, last_ping_time = ? WHERE player_id = ?",
        [lat, lng, Date.now(), playerId],
        function (err) {
          if (err) reject(err);
          resolve(this.changes);
        }
      );
    });
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
      db.run(
        "UPDATE rooms SET status = ?, end_time = ? WHERE room_id = ?",
        [status, Date.now(), roomId],
        function (err) {
          if (err) reject(err);
          resolve(this.changes);
        }
      );
    });
  }

  async function getGameState(roomId) {
    // Get room info
    const room = await new Promise((resolve, reject) => {
      db.get("SELECT * FROM rooms WHERE room_id = ?", [roomId], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });

    if (!room) return null;

    // Get all players
    const players = await new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM players WHERE room_id = ?",
        [roomId],
        (err, rows) => {
          if (err) reject(err);
          resolve(rows || []);
        }
      );
    });

    // Get all targets
    const targets = await new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM targets WHERE room_id = ?",
        [roomId],
        (err, rows) => {
          if (err) reject(err);
          resolve(rows || []);
        }
      );
    });

    // Calculate team scores
    const teamScores = {
      runners: 0,
      hunters: 0,
    };

    targets.forEach((target) => {
      if (target.reached_by) {
        // Find player who reached target
        const player = players.find((p) => p.player_id === target.reached_by);
        if (player && player.team === "runner") {
          teamScores.runners += target.points_value;
        }
      }
    });

    // Check if game time has expired
    const now = Date.now();
    const gameTimeExpired =
      room.start_time + room.game_duration * 60 * 1000 < now;

    // Determine game status
    let gameStatus = room.status;

    if (gameStatus === "active" && gameTimeExpired) {
      gameStatus = "completed";
      // Update room status
      await updateRoomStatus(roomId, "completed");
    }

    // Prepare game state object
    return {
      roomId: room.room_id,
      roomName: room.room_name,
      startTime: room.start_time,
      endTime: room.end_time,
      gameDuration: room.game_duration,
      centralLocation: {
        lat: room.central_lat,
        lng: room.central_lng,
      },
      status: gameStatus,
      players: players.map((p) => ({
        playerId: p.player_id,
        username: p.username,
        team: p.team,
        status: p.status,
        lastLocation:
          p.last_lat && p.last_lng
            ? {
                lat: p.last_lat,
                lng: p.last_lng,
              }
            : null,
        lastPing: p.last_ping_time,
      })),
      targets: targets.map((t) => ({
        targetId: t.target_id,
        location: {
          lat: t.lat,
          lng: t.lng,
        },
        radiusLevel: t.radius_level,
        reachedBy: t.reached_by,
        pointsValue: t.points_value,
      })),
      scores: teamScores,
      timeRemaining: gameTimeExpired
        ? 0
        : (room.start_time + room.game_duration * 60 * 1000 - now) / 1000,
    };
  }

  async function checkTargetDiscovery(roomId, playerId, lat, lng) {
    // Get targets for this room
    const targets = await new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM targets WHERE room_id = ? AND reached_by IS NULL",
        [roomId],
        (err, rows) => {
          if (err) reject(err);
          resolve(rows || []);
        }
      );
    });

    // Check if player is in range of any targets
    for (const target of targets) {
      const distance = geoUtils.calculateDistance(
        lat,
        lng,
        target.lat,
        target.lng
      );

      // Calculate radius in meters based on radius level
      let radius;
      switch (target.radius_level) {
        case 2000:
          radius = 2000;
          break;
        case 1000:
          radius = 1000;
          break;
        case 500:
          radius = 500;
          break;
        case 250:
          radius = 250;
          break;
        case 125:
          radius = 125;
          break;
        default:
          radius = 2000;
      }

      if (distance <= radius) {
        // Player is in range of this target
        // If smallest radius (125m), mark as reached
        if (target.radius_level === 125) {
          // Update target as reached
          await new Promise((resolve, reject) => {
            db.run(
              "UPDATE targets SET reached_by = ? WHERE target_id = ?",
              [playerId, target.target_id],
              function (err) {
                if (err) reject(err);
                resolve(this.changes);
              }
            );
          });

          return {
            targetId: target.target_id,
            location: {
              lat: target.lat,
              lng: target.lng,
            },
            pointsValue: target.points_value,
          };
        }
        // If larger radius, create smaller radius target
        else {
          // Calculate new radius level
          let newRadiusLevel;
          switch (target.radius_level) {
            case 2000:
              newRadiusLevel = 1000;
              break;
            case 1000:
              newRadiusLevel = 500;
              break;
            case 500:
              newRadiusLevel = 250;
              break;
            case 250:
              newRadiusLevel = 125;
              break;
            default:
              newRadiusLevel = 1000;
          }

          // Generate offset for inner circle (not centered)
          const { offsetLat, offsetLng } = geoUtils.generateRandomOffset(
            target.lat,
            target.lng,
            target.radius_level,
            newRadiusLevel
          );

          // Create new target with smaller radius
          const newTargetId = uuidv4();
          await new Promise((resolve, reject) => {
            db.run(
              "INSERT INTO targets (target_id, room_id, lat, lng, radius_level, points_value) VALUES (?, ?, ?, ?, ?, ?)",
              [
                newTargetId,
                roomId,
                offsetLat,
                offsetLng,
                newRadiusLevel,
                target.points_value + 10,
              ],
              function (err) {
                if (err) reject(err);
                resolve(this.lastID);
              }
            );
          });

          // Delete old target
          await new Promise((resolve, reject) => {
            db.run(
              "DELETE FROM targets WHERE target_id = ?",
              [target.target_id],
              function (err) {
                if (err) reject(err);
                resolve(this.changes);
              }
            );
          });

          // Return new target info
          return {
            targetId: newTargetId,
            location: {
              lat: offsetLat,
              lng: offsetLng,
            },
            radiusLevel: newRadiusLevel,
            pointsValue: target.points_value + 10,
          };
        }
      }
    }

    return null;
  }
};

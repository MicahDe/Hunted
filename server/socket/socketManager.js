const { v4: uuidv4 } = require("uuid");
const geoUtils = require("../utils/geoUtils");
const config = require("../config/default");

module.exports = function (io, db) {
  // Track connected users
  const connectedPlayers = new Map();

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Create a room
    socket.on("create_room", async (data) => {
      try {
        const { roomName, username, team, gameDuration, centralLat, centralLng } = data;
        let roomId;

        // Create new room
        roomId = uuidv4();
        await createRoom(
          roomId,
          roomName,
          data.gameDuration,
          data.centralLat,
          data.centralLng
        );

        return socket.emit("room_created", {
          roomId,
          roomName,
          gameDuration,
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

        if (room) {
          roomId = room.room_id;

          // Check if player exists in this room
          const player = await getPlayer(roomId, username);

          if (player) {
            // Player exists, reconnect
            playerId = player.player_id;

            // Update player status
            await updatePlayerStatus(playerId, "lobby");
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
        connectedPlayers.set(socket.id, { roomId, playerId, username, team });

        // Send initial game state
        const gameState = await getGameState(roomId, playerId);
        socket.emit("game_state", gameState);

        // Notify room about new player
        io.to(roomId).emit("player_joined", {
          playerId: playerId,
          username,
          team,
          timestamp: Date.now(),
        });
        
        // Broadcast updated game state to all clients in the room
        io.to(roomId).emit("game_state", gameState);

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

        // If player is runner, store location history and broadcast to hunters
        if (team === "runner") {
          // Store location in history
          await storeLocationHistory(playerId, roomId, lat, lng);
          
          // Get location history for this player
          const locationHistory = await getPlayerLocationHistory(playerId);

          // Get all hunters in the room
          const hunters = await getTeamPlayers(roomId, "hunter");

          // Broadcast runner location to all hunters in the room
          const locationData = {
            playerId,
            username,
            lat,
            lng,
            timestamp: Date.now(),
            locationHistory: locationHistory // Include history
          };

          // Instead of trying to send to each hunter by player_id (which is not a socket ID),
          // broadcast to the whole room. Clients will filter based on their team.
          io.to(roomId).emit("runner_location", locationData);

          // Check for target discovery for runners
          console.log(`Checking target discovery for runner ${playerId} at location ${lat}, ${lng}`);
          
          const targetResult = await checkTargetDiscovery(
            roomId,
            playerId,
            lat,
            lng
          );

          if (targetResult) {
            console.log(`Target result for ${playerId}:`, targetResult);
            
            // Get player info
            const playerData = await getPlayerById(playerId);
            
            // Handle different target results
            
            // Case 1: Player reached a target (smallest radius)
            if (targetResult.reachedTarget) {
              console.log(`Player ${playerId} reached target ${targetResult.reachedTarget.targetId}`);
              
              // Notify room of target reached
              io.to(roomId).emit("target_reached", {
                targetId: targetResult.reachedTarget.targetId,
                location: targetResult.reachedTarget.location,
                pointsValue: targetResult.reachedTarget.pointsValue,
                playerId,
                username: playerData.username,
                gameState: await getGameState(roomId),
              });
              
              // If a new target was also generated, notify just this player
              if (targetResult.newTarget) {
                console.log(`Sending new target ${targetResult.newTarget.targetId} to player ${playerId}`);
                socket.emit("new_target", {
                  target: targetResult.newTarget,
                  gameState: await getGameState(roomId),
                });
              }
            }
            // Case 2: Player entered a larger radius, target updated with smaller radius
            else if (targetResult.updatedTarget) {
              console.log(`Player ${playerId} entered target radius, updating to smaller radius`);
              
              // Notify just this player about the radius update
              socket.emit("target_radius_update", {
                targetId: targetResult.updatedTarget.targetId,
                location: targetResult.updatedTarget.location,
                radiusLevel: targetResult.updatedTarget.radiusLevel,
                pointsValue: targetResult.updatedTarget.pointsValue,
                earnedPoints: targetResult.updatedTarget.earnedPoints,
                gameState: await getGameState(roomId),
              });
            }
            // Case 3: New target was generated for player
            else if (targetResult.isNew && targetResult.target) {
              console.log(`New target ${targetResult.target.targetId} generated for player ${playerId}`);
              
              // Notify just this player about the new target
              socket.emit("new_target", {
                target: targetResult.target,
                gameState: await getGameState(roomId),
              });
            }
          }
          
          // If player has no active targets and is far from other targets,
          // generate a new one
          else if (targetResult === null) {
            const activeTargets = await new Promise((resolve, reject) => {
              db.all(
                "SELECT * FROM targets WHERE room_id = ? AND player_id = ? AND status = 'active'",
                [roomId, playerId],
                (err, rows) => {
                  if (err) reject(err);
                  resolve(rows || []);
                }
              );
            });
            
            // If player has no active targets, generate one
            if (activeTargets.length === 0) {
              console.log(`Player ${playerId} has no active targets, generating one`);
              const newTarget = await generateTargetForPlayer(roomId, playerId, lat, lng);
              
              if (newTarget) {
                console.log(`New target ${newTarget.targetId} generated for player ${playerId}`);
                
                // Notify just this player about the new target
                socket.emit("new_target", {
                  target: newTarget,
                  gameState: await getGameState(roomId),
                });
              }
            }
          }
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

    // Handle target request
    socket.on("request_target", async (data) => {
      try {
        const playerInfo = connectedPlayers.get(socket.id);
        if (!playerInfo) {
          return socket.emit("error", { message: "Player not found" });
        }

        const { roomId, playerId, team } = playerInfo;
        
        // Only runners can request targets
        if (team !== "runner") {
          return socket.emit("error", { message: "Only runners can request targets" });
        }
        
        console.log(`Player ${playerId} is requesting a target`);
        
        // Check if player already has active targets
        const activeTargets = await new Promise((resolve, reject) => {
          db.all(
            "SELECT * FROM targets WHERE room_id = ? AND player_id = ? AND status = 'active'",
            [roomId, playerId],
            (err, rows) => {
              if (err) reject(err);
              resolve(rows || []);
            }
          );
        });
        
        // If player already has a target, just return the current game state
        if (activeTargets.length > 0) {
          console.log(`Player ${playerId} already has ${activeTargets.length} active targets`);
          const gameState = await getGameState(roomId, playerId);
          return socket.emit("game_state", gameState);
        }
        
        // Get player's location for target generation
        const player = await getPlayerById(playerId);
        if (!player.last_lat || !player.last_lng) {
          return socket.emit("error", { message: "No location data available. Move around to get a target." });
        }
        
        // Generate a new target for the player
        const newTarget = await generateTargetForPlayer(
          roomId, 
          playerId, 
          player.last_lat, 
          player.last_lng
        );
        
        if (newTarget) {
          console.log(`Generated new target for player ${playerId}:`, newTarget);
          
          // Send the new target to the player
          socket.emit("new_target", {
            target: newTarget,
            gameState: await getGameState(roomId, playerId),
          });
        } else {
          socket.emit("error", { message: "Failed to generate target" });
        }
      } catch (error) {
        console.error("Error handling target request:", error);
        socket.emit("error", { message: "Error processing target request" });
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
        db.run(
          "DELETE FROM targets WHERE room_id = ?",
          [roomId],
          function (err) {
            if (err) {
              console.error("Error deleting targets:", err);
              return reject(err);
            }
            console.log(`Successfully deleted targets for roomId: ${roomId}`);

            // Delete room
            console.log(`Deleting room with roomId: ${roomId}`);
            db.run(
              "DELETE FROM rooms WHERE room_id = ?",
              [roomId],
              function (err) {
                if (err) {
                  console.error("Error deleting room:", err);
                  return reject(err);
                }
                console.log(`Successfully deleted room with roomId: ${roomId}`);
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
          "lobby",
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
      db.run(
        "INSERT INTO location_history (player_id, room_id, lat, lng, timestamp) VALUES (?, ?, ?, ?, ?)",
        [playerId, roomId, lat, lng, timestamp],
        function (err) {
          if (err) reject(err);
          resolve(this.lastID);
        }
      );
    });
  }

  // Get the last location history point for a player
  async function getLastLocationHistoryPoint(playerId) {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM location_history WHERE player_id = ? ORDER BY timestamp DESC LIMIT 1",
        [playerId],
        function (err, row) {
          if (err) reject(err);
          resolve(row);
        }
      );
    });
  }

  // Get location history for a player (last 30 minutes)
  async function getPlayerLocationHistory(playerId) {
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT lat, lng, timestamp FROM location_history WHERE player_id = ? AND timestamp > ? ORDER BY timestamp ASC",
        [playerId, thirtyMinutesAgo],
        function (err, rows) {
          if (err) reject(err);
          resolve(rows || []);
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

  async function getGameState(roomId, requestingPlayerId = null) {
    try {
      // Get room details
      const room = await new Promise((resolve, reject) => {
        db.get(
          "SELECT * FROM rooms WHERE room_id = ?",
          [roomId],
          (err, row) => {
            if (err) reject(err);
            resolve(row);
          }
        );
      });

      if (!room) {
        return null;
      }

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
      
      // Get location history for all runners
      const runnerLocationHistory = {};
      const runnerPlayers = players.filter(player => player.team === 'runner');
      
      // Get location history for each runner
      for (const runner of runnerPlayers) {
        const history = await getPlayerLocationHistory(runner.player_id);
        if (history && history.length > 0) {
          runnerLocationHistory[runner.player_id] = {
            playerId: runner.player_id,
            username: runner.username,
            lat: runner.last_lat,
            lng: runner.last_lng,
            timestamp: runner.last_ping_time,
            locationHistory: history
          };
        }
      }

      // Get all targets for this room
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

      // Format targets for client
      const formattedTargets = targets.map((target) => ({
        targetId: target.target_id,
        playerId: target.player_id,
        location: {
          lat: target.lat,
          lng: target.lng,
        },
        radiusLevel: target.radius_level,
        pointsValue: target.points_value,
        status: target.status,
        reachedBy: target.player_id,
        reachedAt: target.reached_at,
      }));

      // Format players for client
      const formattedPlayers = players.map((player) => ({
        playerId: player.player_id,
        roomId: player.room_id,
        username: player.username,
        team: player.team,
        status: player.status,
        location: {
          lat: player.last_lat,
          lng: player.last_lng,
        },
        lastPingTime: player.last_ping_time,
      }));

      // Calculate scores for all players
      for (const player of formattedPlayers) {
        // Get all target discoveries for this player
        const discoveries = await new Promise((resolve, reject) => {
          db.all(
            "SELECT * FROM target_discoveries WHERE player_id = ?",
            [player.playerId],
            (err, rows) => {
              if (err) reject(err);
              resolve(rows || []);
            }
          );
        });
        
        // Sum up points earned
        player.score = discoveries.reduce((sum, discovery) => sum + discovery.points_earned, 0);
      }

      // Create game state object
      const gameState = {
        roomId: room.room_id,
        roomName: room.room_name,
        gameDuration: room.game_duration,
        centralLocation: {
          lat: room.central_lat,
          lng: room.central_lng,
        },
        startTime: room.start_time,
        endTime: room.end_time,
        status: room.status,
        players: formattedPlayers,
        targets: formattedTargets,
        runnerLocationHistory: runnerLocationHistory
      };

      return gameState;
    } catch (error) {
      console.error("Error getting game state:", error);
      return null;
    }
  }

  async function checkTargetDiscovery(roomId, playerId, lat, lng) {
    console.log(`Checking target discovery for room ${roomId}, player ${playerId}`);
    
    // Get player's active targets
    const targets = await new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM targets WHERE room_id = ? AND player_id = ? AND status = 'active'",
        [roomId, playerId],
        (err, rows) => {
          if (err) reject(err);
          resolve(rows || []);
        }
      );
    });
    
    console.log(`Found ${targets.length} active targets for player ${playerId}`);
    
    // If no targets, generate one
    if (targets.length === 0) {
      console.log(`No active targets for player ${playerId}, generating new target`);
      const newTarget = await generateTargetForPlayer(roomId, playerId, lat, lng);
      if (newTarget) {
        console.log(`Generated new target for player ${playerId}:`, newTarget);
        return {
          isNew: true,
          target: newTarget
        };
      }
      return null;
    }

    // Check if player is in range of any of their targets
    for (const target of targets) {
      const distance = geoUtils.calculateDistance(
        lat,
        lng,
        target.lat,
        target.lng
      );
      
      console.log(`Target ${target.target_id}: distance=${distance}m, radius=${target.radius_level}m`);

      // Check if player is within the target's radius
      if (distance <= target.radius_level) {
        console.log(`Player is in range of target ${target.target_id} (distance: ${distance}m, radius: ${target.radius_level}m)`);
        
        // If smallest radius (200m), mark as reached
        if (target.radius_level === config.game.targetRadiusLevels[config.game.targetRadiusLevels.length - 1]) {
          console.log(`Target reached - smallest radius (${target.radius_level}m)`);
          
          // Update target as reached
          await new Promise((resolve, reject) => {
            db.run(
              "UPDATE targets SET status = 'reached', reached_at = ? WHERE target_id = ?",
              [Date.now(), target.target_id],
              function (err) {
                if (err) reject(err);
                resolve(this.changes);
              }
            );
          });

          // Generate a new target for the player
          const newTarget = await generateTargetForPlayer(roomId, playerId, lat, lng);
          
          // Return both the reached target and the new target
          return {
            reachedTarget: {
              targetId: target.target_id,
              location: {
                lat: target.lat,
                lng: target.lng,
              },
              pointsValue: target.points_value,
            },
            newTarget: newTarget
          };
        }
        // If larger radius, create smaller radius target (narrowing the search)
        else {
          console.log(`Creating smaller radius target for ${target.target_id}`);
          
          // Find the current radius level index
          const currentRadiusIndex = config.game.targetRadiusLevels.indexOf(target.radius_level);
          
          // If not found (shouldn't happen), use default next radius
          if (currentRadiusIndex === -1) {
            console.error(`Invalid radius level ${target.radius_level}`);
            return null;
          }
          
          // Get next smaller radius
          const newRadiusLevel = config.game.targetRadiusLevels[currentRadiusIndex + 1];
          console.log(`New radius level: ${newRadiusLevel}m (was ${target.radius_level}m)`);
          
          // Award points to the player for discovering this radius level
          // Points awarded equal to the current radius level
          const earnedPoints = target.points_value;
          console.log(`Player ${playerId} awarded ${earnedPoints} points for discovering ${target.radius_level}m radius level`);
          
          // Calculate new points for next radius level
          const newPointsValue = target.points_value + config.game.additionalPointsPerCircle;
          
          // Get the player to find their team
          const player = await getPlayerById(playerId);
          if (!player) {
            console.error(`Player ${playerId} not found when awarding points`);
            return null;
          }
          
          // Only runners should get points
          if (player.team === "runner") {
            // Record that points were awarded for this target discovery
            // Store in the database that this player discovered this target at this radius level
            await new Promise((resolve, reject) => {
              db.run(
                `INSERT INTO target_discoveries 
                (player_id, target_id, radius_level, points_earned, discovery_time)
                VALUES (?, ?, ?, ?, ?)`,
                [playerId, target.target_id, target.radius_level, earnedPoints, Date.now()],
                function(err) {
                  if (err) {
                    console.error("Error recording target discovery:", err);
                    reject(err);
                  }
                  resolve(this.lastID);
                }
              );
            }).catch(err => {
              console.error("Failed to record target discovery:", err);
              // Continue even if recording fails - don't block the player
            });
          }
          
          // Update target with smaller radius and more points
          await new Promise((resolve, reject) => {
            db.run(
              "UPDATE targets SET radius_level = ?, points_value = ? WHERE target_id = ?",
              [newRadiusLevel, newPointsValue, target.target_id],
              function (err) {
                if (err) reject(err);
                resolve(this.changes);
              }
            );
          });
          
          // Return updated target with new radius
          return {
            updatedTarget: {
              targetId: target.target_id,
              location: {
                lat: target.lat,
                lng: target.lng,
              },
              radiusLevel: newRadiusLevel,
              pointsValue: newPointsValue,
              earnedPoints: earnedPoints,
            }
          };
        }
      }
    }

    // If no targets were reached but player has no active targets,
    // generate a new one
    if (targets.length === 0) {
      const newTarget = await generateTargetForPlayer(roomId, playerId, lat, lng);
      if (newTarget) {
        return {
          isNew: true,
          target: newTarget
        };
      }
    }

    return null;
  }

  async function generateTargetForPlayer(roomId, playerId, playerLat, playerLng) {
    console.log(`Generating target for player ${playerId} in room ${roomId}`);
    
    // Get room info for central location and game boundary
    const room = await new Promise((resolve, reject) => {
      db.get("SELECT * FROM rooms WHERE room_id = ?", [roomId], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });
    
    if (!room) {
      console.error(`Room ${roomId} not found when generating target`);
      return null;
    }
    
    // Calculate distance from center to determine if player is near boundary
    const distanceFromCenter = geoUtils.calculateDistance(
      playerLat, 
      playerLng, 
      room.central_lat, 
      room.central_lng
    );
    
    // Check if there are already active targets for this player
    const existingTargets = await new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM targets WHERE room_id = ? AND player_id = ? AND status = 'active'",
        [roomId, playerId],
        (err, rows) => {
          if (err) reject(err);
          resolve(rows || []);
        }
      );
    });
    
    // If player already has active targets, don't generate more
    if (existingTargets.length > 0) {
      console.log(`Player ${playerId} already has ${existingTargets.length} active targets`);
      return existingTargets[0];
    }
    
    // Generate a new target position - biased away from player and toward center
    // if player is near boundary
    let targetLat, targetLng, radius;
    
    // Maximum play area radius in meters
    const maxRadius = config.game.defaultPlayAreaRadius;
    
    // If player is within 25% of boundary, try to generate targets toward center
    const isBiasTowardCenter = distanceFromCenter > (maxRadius * 0.75);
    
    if (isBiasTowardCenter) {
      console.log(`Player is near boundary, biasing target toward center`);
      // Generate position between player and center
      const bearing = geoUtils.calculateBearing(
        playerLat, 
        playerLng, 
        room.central_lat, 
        room.central_lng
      );
      
      // Calculate a random distance (1000m to 1500m) from player toward center
      const distance = Math.random() * 500 + 1000;
      const targetPos = geoUtils.calculateDestination(
        playerLat, 
        playerLng, 
        bearing, 
        distance
      );
      
      targetLat = targetPos.lat;
      targetLng = targetPos.lng;
    } else {
      // Generate a random position within 1500m of player
      // but at least 500m away
      const minDistance = 500;
      const maxDistance = 1500;
      const angle = Math.random() * 2 * Math.PI;
      const distance = minDistance + Math.random() * (maxDistance - minDistance);
      
      const targetPos = geoUtils.calculateDestination(
        playerLat, 
        playerLng, 
        angle, 
        distance
      );
      
      targetLat = targetPos.lat;
      targetLng = targetPos.lng;
    }
    
    // Check if the target is within the play area
    const distanceTargetFromCenter = geoUtils.calculateDistance(
      targetLat, 
      targetLng, 
      room.central_lat, 
      room.central_lng
    );
    
    // If target is outside play area, adjust it
    if (distanceTargetFromCenter > maxRadius) {
      console.log(`Target would be outside play area, adjusting`);
      // Calculate bearing from center to target
      const bearingFromCenter = geoUtils.calculateBearing(
        room.central_lat, 
        room.central_lng, 
        targetLat, 
        targetLng
      );
      
      // Place target at boundary minus 100m for safety
      const adjustedTargetPos = geoUtils.calculateDestination(
        room.central_lat, 
        room.central_lng, 
        bearingFromCenter, 
        maxRadius - 100
      );
      
      targetLat = adjustedTargetPos.lat;
      targetLng = adjustedTargetPos.lng;
    }
    
    // Create target with initial radius
    const targetId = uuidv4();
    const initialRadius = config.game.targetRadiusLevels[0]; // Largest radius
    const pointsValue = config.game.baseTargetPoints;
    
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO targets 
        (target_id, room_id, player_id, lat, lng, radius_level, points_value, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
        [targetId, roomId, playerId, targetLat, targetLng, initialRadius, pointsValue],
        function (err) {
          if (err) reject(err);
          resolve(this.lastID);
        }
      );
    });
    
    console.log(`Created new target ${targetId} for player ${playerId} at ${targetLat}, ${targetLng}`);
    
    // Return the created target
    return {
      targetId,
      location: {
        lat: targetLat,
        lng: targetLng,
      },
      radiusLevel: initialRadius,
      pointsValue
    };
  }
};

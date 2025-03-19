const { v4: uuidv4 } = require("uuid");
const geoUtils = require("../../shared/utils/geoUtils");
const config = require("../config/default");

module.exports = function (io, db) {
  // Track connected users
  const connectedPlayers = new Map();

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Create a room
    socket.on("create_room", async (data) => {
      try {
        const { roomName, username, team, zoneActivationDelay, playRadius, centralLat, centralLng } = data;
        let roomId;

        // Create new room
        roomId = uuidv4();
        await createRoom(
          roomId,
          roomName,
          data.zoneActivationDelay,
          data.centralLat,
          data.centralLng,
          data.playRadius
        );

        return socket.emit("room_created", {
          roomId,
          roomName,
          zoneActivationDelay,
          playRadius,
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

        // Generate targets for all runners in the room
        const runners = await getTeamPlayers(roomId, "runner");
        console.log(`Found ${runners.length} runners for initial target generation`);
        
        for (const runner of runners) {
          // Skip runners with no location data
          if (!runner.last_lat || !runner.last_lng) {
            continue;
          }
          
          // Generate a target for this runner
          const target = await generateTargetForPlayer(
            roomId,
            runner.player_id,
            runner.last_lat,
            runner.last_lng
          );
          
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
                    gameState: await getGameState(roomId, runner.player_id)
                  });
                  break;
                }
              }
            }
          }
        }

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
                playerId,
                username: playerData.username,
                gameState: await getGameState(roomId),
              });
            }
            // Case 2: Player entered a larger radius, target updated with smaller radius
            else if (targetResult.updatedTarget) {
              console.log(`Player ${playerId} entered target radius, updating to smaller radius`);
              
              // Notify just this player about the radius update
              socket.emit("target_radius_update", {
                targetId: targetResult.updatedTarget.targetId,
                location: targetResult.updatedTarget.location,
                radiusLevel: targetResult.updatedTarget.radiusLevel,
                zoneStatus: targetResult.updatedTarget.zoneStatus,
                activationTime: targetResult.updatedTarget.activationTime,
                gameState: await getGameState(roomId, playerId),
              });
            }
            // Case 3: Zone was activated
            else if (targetResult.zoneActivated) {
              console.log(`Zone ${targetResult.zoneActivated.targetId} activated for player ${playerId}`);
              
              // Notify just this player about the zone activation
              socket.emit("zone_activated", {
                targetId: targetResult.zoneActivated.targetId,
                location: targetResult.zoneActivated.location,
                radiusLevel: targetResult.zoneActivated.radiusLevel,
                gameState: await getGameState(roomId, playerId),
              });
            }
            // Case 4: New target was generated for player
            else if (targetResult.isNew && targetResult.target) {
              console.log(`New target ${targetResult.target.targetId} generated for player ${playerId}`);
              
              // Notify just this player about the new target
              socket.emit("new_target", {
                target: targetResult.target,
                gameState: await getGameState(roomId, playerId),
              });
            }
          }
          
          // If player has no active targets, generate one
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
                  gameState: await getGameState(roomId, playerId),
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

        // Check if all runners are caught or have reached their target
        const activeRunners = await getTeamPlayers(roomId, "runner", "active");

        if (activeRunners.length === 0) {
          // Game over - all runners have been caught or reached their target
          await updateRoomStatus(roomId, "completed");

          // Get final game state
          const gameState = await getGameState(roomId);

          // Notify all players
          io.to(roomId).emit("game_over", {
            reason: "All runners have been caught or reached their targets",
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
    zoneActivationDelay,
    centralLat,
    centralLng,
    playRadius
  ) {
    return new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO rooms (room_id, room_name, zone_activation_delay, central_lat, central_lng, play_radius, start_time, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          roomId,
          roomName,
          zoneActivationDelay,
          centralLat,
          centralLng,
          playRadius,
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
      console.log(`Getting game state for room: ${roomId}`);
      
      // Get room details
      const room = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM rooms WHERE room_id = ?", [roomId], (err, row) => {
          if (err) reject(err);
          resolve(row);
        });
      });

      if (!room) {
        console.error(`Room ${roomId} not found when getting game state`);
        return null;
      }

      // Get all players in the room
      const players = await new Promise((resolve, reject) => {
        db.all("SELECT * FROM players WHERE room_id = ?", [roomId], (err, rows) => {
          if (err) reject(err);
          resolve(rows || []);
        });
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
      let targets;
      
      if (requestingPlayerId) {
        // If a player ID is provided, only get their targets
        targets = await new Promise((resolve, reject) => {
          db.all(
            "SELECT * FROM targets WHERE room_id = ? AND player_id = ?",
            [roomId, requestingPlayerId],
            (err, rows) => {
              if (err) reject(err);
              resolve(rows || []);
            }
          );
        });
      } else {
        // Get all targets
        targets = await new Promise((resolve, reject) => {
          db.all(
            "SELECT * FROM targets WHERE room_id = ?",
            [roomId],
            (err, rows) => {
              if (err) reject(err);
              resolve(rows || []);
            }
          );
        });
      }

      // Format targets for client
      const formattedTargets = targets.map((target) => ({
        targetId: target.target_id,
        playerId: target.player_id,
        location: {
          lat: target.lat,
          lng: target.lng,
        },
        radiusLevel: target.radius_level,
        status: target.status,
        zoneStatus: target.zone_status || 'inactive',
        activationTime: target.activation_time,
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

      // Construct game state
      const gameState = {
        roomId: room.room_id,
        roomName: room.room_name,
        zoneActivationDelay: room.zone_activation_delay,
        playRadius: room.play_radius,
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
      // Get all possible radius levels from config
      const allRadiusLevels = config.game.targetRadiusLevels;
      
      // Check if player is within any of the nested target circles
      const isInTargetArea = geoUtils.isPlayerInNestedTargetArea(
        lat,
        lng,
        target.lat,
        target.lng,
        target.radius_level,
        allRadiusLevels
      );
      
      console.log(`Target ${target.target_id}: isInTargetArea=${isInTargetArea}, current radius=${target.radius_level}m`);

      // Check zone activation status
      const currentTime = Date.now();
      const isZoneActive = target.zone_status === 'active' || 
                          (target.activation_time && currentTime > target.activation_time);
      
      console.log(`Zone status: ${target.zone_status}, active: ${isZoneActive}`);
      
      // If zone was inactive but should be active now, update it
      if (target.zone_status === 'inactive' && currentTime > target.activation_time) {
        await new Promise((resolve, reject) => {
          db.run(
            "UPDATE targets SET zone_status = 'active' WHERE target_id = ?",
            [target.target_id],
            function (err) {
              if (err) reject(err);
              resolve(this.changes);
            }
          );
        });
        
        // Return the zone activation event
        return {
          zoneActivated: {
            targetId: target.target_id,
            location: {
              lat: target.lat,
              lng: target.lng,
            },
            radiusLevel: target.radius_level
          }
        };
      }

      // Check if player is within the target's area and zone is active
      if (isInTargetArea && isZoneActive) {
        console.log(`Player is in range of target ${target.target_id} (current radius: ${target.radius_level}m)`);
        
        // If smallest radius (125m), mark as reached
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

          // Update player status to indicate they've won
          await updatePlayerStatus(playerId, 'won');
          
          // Get player info
          const player = await getPlayerById(playerId);

          // Check if all runners have either been caught or reached their target
          const activeRunners = await new Promise((resolve, reject) => {
            db.all(
              "SELECT * FROM players WHERE room_id = ? AND team = 'runner' AND status = 'active'",
              [roomId],
              (err, rows) => {
                if (err) reject(err);
                resolve(rows || []);
              }
            );
          });
          
          // If no active runners left, game is over
          if (activeRunners.length === 0) {
            // Game over - update room status
            await updateRoomStatus(roomId, "completed");
            
            // Get final game state
            const gameState = await getGameState(roomId);
            
            // Notify all players of game completion
            io.to(roomId).emit("game_over", {
              reason: "All runners have either been caught or reached their targets",
              gameState
            });
          } else {
            // Just notify about this runner's victory
            io.to(roomId).emit("runner_won", {
              playerId,
              username: player.username,
              targetId: target.target_id,
              timestamp: Date.now()
            });
          }

          // Return the reached target
          return {
            reachedTarget: {
              targetId: target.target_id,
              location: {
                lat: target.lat,
                lng: target.lng,
              }
            }
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
          
          // Calculate activation time for the new zone
          const room = await new Promise((resolve, reject) => {
            db.get("SELECT * FROM rooms WHERE room_id = ?", [roomId], (err, row) => {
              if (err) reject(err);
              resolve(row);
            });
          });
          
          const activationTime = Date.now() + (room.zone_activation_delay * 1000);
          
          // Update target with smaller radius and inactive status
          await new Promise((resolve, reject) => {
            db.run(
              "UPDATE targets SET radius_level = ?, zone_status = 'inactive', activation_time = ? WHERE target_id = ?",
              [newRadiusLevel, activationTime, target.target_id],
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
              zoneStatus: 'inactive',
              activationTime: activationTime
            }
          };
        }
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

    // Check if there are already active targets for this player
    const existingTargets = await new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM targets WHERE room_id = ? AND player_id = ? AND status != 'reached'",
        [roomId, playerId],
        (err, rows) => {
          if (err) reject(err);
          resolve(rows || []);
        }
      );
    });
    
    // If player already has a target, don't generate more
    if (existingTargets.length > 0) {
      console.log(`Player ${playerId} already has a target`);
      return existingTargets[0];
    }
    
    // Generate a new target position - biased away from player and toward center
    // if player is near boundary
    let targetLat, targetLng;
    
    // Maximum play area radius in meters
    const maxRadius = room.play_radius || config.game.defaultPlayAreaRadius;
    
    // Generate a random position within the play area
    const angle = Math.random() * 360; // 0-360 degrees
    const distance = Math.random() * maxRadius; // 0-maxRadius
    
    const targetPos = geoUtils.calculateDestination(
      room.central_lat, 
      room.central_lng,
      angle, 
      distance
    );
    
    targetLat = targetPos.lat;
    targetLng = targetPos.lng;
    
    // Create target with initial radius
    const targetId = uuidv4();
    const initialRadius = config.game.targetRadiusLevels[0]; // Largest radius
    const activationTime = Date.now() + (room.zone_activation_delay * 1000); // Convert to milliseconds
    
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO targets 
        (target_id, room_id, player_id, lat, lng, radius_level, status, zone_status, activation_time)
        VALUES (?, ?, ?, ?, ?, ?, 'active', 'inactive', ?)`,
        [targetId, roomId, playerId, targetLat, targetLng, initialRadius, activationTime],
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
      zoneStatus: 'inactive',
      activationTime: activationTime
    };
  }
};

const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const geoUtils = require("../utils/geoUtils");

// Get database from server.js
const db = require("../server").db;

// Get room details
router.get("/rooms/:roomId", (req, res) => {
  const { roomId } = req.params;

  db.get("SELECT * FROM rooms WHERE room_id = ?", [roomId], (err, room) => {
    if (err) {
      return res.status(500).json({ error: "Database error" });
    }

    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    res.json({
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
    });
  });
});

// Create new room
router.post("/rooms", (req, res) => {
  const { roomName, gameDuration, centralLat, centralLng } = req.body;

  if (!roomName || !gameDuration || !centralLat || !centralLng) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Check if room name already exists
  db.get(
    "SELECT * FROM rooms WHERE room_name = ?",
    [roomName],
    (err, existingRoom) => {
      if (err) {
        return res.status(500).json({ error: "Database error" });
      }

      if (existingRoom) {
        return res.status(409).json({ error: "Room name already exists" });
      }

      const roomId = uuidv4();
      const startTime = Date.now();

      // Create new room
      db.run(
        "INSERT INTO rooms (room_id, room_name, game_duration, central_lat, central_lng, start_time, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          roomId,
          roomName,
          gameDuration,
          centralLat,
          centralLng,
          startTime,
          "lobby",
        ],
        function (err) {
          if (err) {
            return res.status(500).json({ error: "Failed to create room" });
          }

          // Generate initial targets for the room (5-10 targets)
          const targetCount = Math.floor(Math.random() * 6) + 5;
          const playAreaRadius = 5000; // 5km

          const targets = geoUtils.generateTargets(
            centralLat,
            centralLng,
            playAreaRadius,
            targetCount
          );

          // Create targets in database
          const targetInsertPromises = targets.map((target) => {
            return new Promise((resolve, reject) => {
              const targetId = uuidv4();
              db.run(
                "INSERT INTO targets (target_id, room_id, lat, lng, radius_level, points_value) VALUES (?, ?, ?, ?, ?, ?)",
                [targetId, roomId, target.lat, target.lng, 2000, 10], // Initial radius 2km
                function (err) {
                  if (err) reject(err);
                  resolve();
                }
              );
            });
          });

          Promise.all(targetInsertPromises)
            .then(() => {
              res.status(201).json({
                roomId,
                roomName,
                gameDuration,
                centralLocation: {
                  lat: centralLat,
                  lng: centralLng,
                },
                startTime,
                targetCount,
              });
            })
            .catch((err) => {
              console.error("Error creating targets:", err);
              res.status(500).json({ error: "Failed to create targets" });
            });
        }
      );
    }
  );
});

// Join existing room
router.post("/rooms/:roomId/join", (req, res) => {
  const { roomId } = req.params;
  const { username, team } = req.body;

  if (!username || !team) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Check if room exists
  db.get("SELECT * FROM rooms WHERE room_id = ?", [roomId], (err, room) => {
    if (err) {
      return res.status(500).json({ error: "Database error" });
    }

    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    // Check if username is already taken in this room
    db.get(
      "SELECT * FROM players WHERE room_id = ? AND username = ?",
      [roomId, username],
      (err, existingPlayer) => {
        if (err) {
          return res.status(500).json({ error: "Database error" });
        }

        if (existingPlayer) {
          // Player exists, check if it's the same person rejoining
          return res.json({
            playerId: existingPlayer.player_id,
            username: existingPlayer.username,
            team: existingPlayer.team,
            message: "Rejoined room",
          });
        }

        const playerId = uuidv4();

        // Create new player
        db.run(
          "INSERT INTO players (player_id, room_id, username, team, status, last_ping_time) VALUES (?, ?, ?, ?, ?, ?)",
          [playerId, roomId, username, team, "active", Date.now()],
          function (err) {
            if (err) {
              return res.status(500).json({ error: "Failed to join room" });
            }

            res.status(201).json({
              playerId,
              roomId,
              username,
              team,
              message: "Joined room",
            });
          }
        );
      }
    );
  });
});

// Get current game state
router.get("/rooms/:roomId/state", (req, res) => {
  const { roomId } = req.params;

  // Get room info
  db.get("SELECT * FROM rooms WHERE room_id = ?", [roomId], (err, room) => {
    if (err) {
      return res.status(500).json({ error: "Database error" });
    }

    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    // Get all players
    db.all(
      "SELECT * FROM players WHERE room_id = ?",
      [roomId],
      (err, players) => {
        if (err) {
          return res.status(500).json({ error: "Database error" });
        }

        // Get all targets
        db.all(
          "SELECT * FROM targets WHERE room_id = ?",
          [roomId],
          (err, targets) => {
            if (err) {
              return res.status(500).json({ error: "Database error" });
            }

            // Calculate team scores
            const teamScores = {
              runners: 0,
              hunters: 0,
            };

            targets.forEach((target) => {
              if (target.reached_by) {
                // Find player who reached target
                const player = players.find(
                  (p) => p.player_id === target.reached_by
                );
                if (player && player.team === "runner") {
                  teamScores.runners += target.points_value;
                }
              }
            });

            // Check if game time has expired
            const now = Date.now();
            const gameTimeExpired =
              room.start_time + room.game_duration * 60 * 1000 < now;

            res.json({
              roomId: room.room_id,
              roomName: room.room_name,
              startTime: room.start_time,
              endTime: room.end_time,
              gameDuration: room.game_duration,
              centralLocation: {
                lat: room.central_lat,
                lng: room.central_lng,
              },
              status: room.status,
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
                : (room.start_time + room.game_duration * 60 * 1000 - now) /
                  1000,
            });
          }
        );
      }
    );
  });
});

// Report player caught
router.post("/players/:playerId/caught", (req, res) => {
  const { playerId } = req.params;
  const { reportingPlayerId } = req.body;

  if (!reportingPlayerId) {
    return res.status(400).json({ error: "Missing reporting player ID" });
  }

  // Verify reporting player is a hunter
  db.get(
    "SELECT * FROM players WHERE player_id = ?",
    [reportingPlayerId],
    (err, hunter) => {
      if (err) {
        return res.status(500).json({ error: "Database error" });
      }

      if (!hunter || hunter.team !== "hunter") {
        return res
          .status(403)
          .json({ error: "Only hunters can report catches" });
      }

      // Verify caught player is a runner
      db.get(
        "SELECT * FROM players WHERE player_id = ?",
        [playerId],
        (err, runner) => {
          if (err) {
            return res.status(500).json({ error: "Database error" });
          }

          if (!runner) {
            return res.status(404).json({ error: "Player not found: " + playerId });
          }

          if (runner.team !== "runner") {
            return res.status(400).json({ error: "Player is not a runner: " + playerId });
          }

          if (runner.status === "caught") {
            return res.status(400).json({ error: "Player already caught: " + playerId });
          }

          // Update player status
          db.run(
            "UPDATE players SET status = ?, team = ? WHERE player_id = ?",
            ["caught", "hunter", playerId],
            function (err) {
              if (err) {
                return res
                  .status(500)
                  .json({ error: "Failed to update player status" });
              }

              res.json({
                message: "Player caught successfully",
                playerId,
                newStatus: "caught",
                newTeam: "hunter",
              });
            }
          );
        }
      );
    }
  );
});

module.exports = router;

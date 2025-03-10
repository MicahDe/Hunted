/**
 * Room model for HUNTED Game
 */

const { v4: uuidv4 } = require("uuid");
const { dbUtils } = require("../utils/database");
const config = require("../config/default");
const geoUtils = require("../utils/geoUtils");

class Room {
  /**
   * Create a new room
   * @param {Object} roomData - Room data
   * @param {string} roomData.roomName - Name of the room
   * @param {number} roomData.gameDuration - Duration of the game in minutes
   * @param {number} roomData.centralLat - Latitude of central point
   * @param {number} roomData.centralLng - Longitude of central point
   * @returns {Promise<Object>} Created room
   */
  static async create(roomData) {
    const { roomName, gameDuration, centralLat, centralLng } = roomData;

    // Validate input
    if (!roomName || !gameDuration || !centralLat || !centralLng) {
      throw new Error("Missing required fields");
    }

    // Validate room name length
    if (roomName.length > config.security.maxRoomNameLength) {
      throw new Error(
        `Room name must be ${config.security.maxRoomNameLength} characters or less`
      );
    }

    // Check if room name already exists
    const existingRoom = await dbUtils.get(
      "SELECT * FROM rooms WHERE room_name = ?",
      [roomName]
    );
    if (existingRoom) {
      throw new Error("Room name already exists");
    }

    // Generate room ID
    const roomId = uuidv4();
    const startTime = Date.now();

    // Create room in database
    await dbUtils.run(
      "INSERT INTO rooms (room_id, room_name, game_duration, central_lat, central_lng, start_time, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        roomId,
        roomName,
        gameDuration,
        centralLat,
        centralLng,
        startTime,
        "lobby",
      ]
    );

    // Generate targets for the room
    await this.generateTargets(roomId, centralLat, centralLng);

    // Get created room
    return this.getById(roomId);
  }

  /**
   * Get a room by ID
   * @param {string} roomId - Room ID
   * @returns {Promise<Object>} Room
   */
  static async getById(roomId) {
    return dbUtils.get("SELECT * FROM rooms WHERE room_id = ?", [roomId]);
  }

  /**
   * Get a room by name
   * @param {string} roomName - Room name
   * @returns {Promise<Object>} Room
   */
  static async getByName(roomName) {
    return dbUtils.get("SELECT * FROM rooms WHERE room_name = ?", [roomName]);
  }

  /**
   * Update room status
   * @param {string} roomId - Room ID
   * @param {string} status - New status ('lobby', 'active', 'completed')
   * @returns {Promise<Object>} Updated room
   */
  static async updateStatus(roomId, status) {
    // Validate status
    if (!["lobby", "active", "completed"].includes(status)) {
      throw new Error("Invalid status");
    }

    // Update status in database
    await dbUtils.run("UPDATE rooms SET status = ? WHERE room_id = ?", [
      status,
      roomId,
    ]);

    // If status is completed, set end time
    if (status === "completed") {
      await dbUtils.run("UPDATE rooms SET end_time = ? WHERE room_id = ?", [
        Date.now(),
        roomId,
      ]);
    }

    // If status is active, set start time
    if (status === "active") {
      await dbUtils.run("UPDATE rooms SET start_time = ? WHERE room_id = ?", [
        Date.now(),
        roomId,
      ]);
    }

    // Get updated room
    return this.getById(roomId);
  }

  /**
   * Generate targets for a room
   * @param {string} roomId - Room ID
   * @param {number} centralLat - Latitude of central point
   * @param {number} centralLng - Longitude of central point
   * @returns {Promise<Array>} Generated targets
   */
  static async generateTargets(roomId, centralLat, centralLng) {
    // Determine number of targets
    const targetCount = Math.floor(
      Math.random() * (config.game.maxTargets - config.game.minTargets + 1) +
        config.game.minTargets
    );

    // Generate target positions
    const playAreaRadius = config.game.defaultPlayAreaRadius;
    const targets = geoUtils.generateTargets(
      centralLat,
      centralLng,
      playAreaRadius,
      targetCount
    );

    // Insert targets into database
    const targetInsertPromises = targets.map((target) => {
      const targetId = uuidv4();
      return dbUtils.run(
        "INSERT INTO targets (target_id, room_id, lat, lng, radius_level, points_value) VALUES (?, ?, ?, ?, ?, ?)",
        [
          targetId,
          roomId,
          target.lat,
          target.lng,
          config.game.targetRadiusLevels[0],
          config.game.baseTargetPoints,
        ]
      );
    });

    await Promise.all(targetInsertPromises);

    // Get created targets
    return this.getTargets(roomId);
  }

  /**
   * Get targets for a room
   * @param {string} roomId - Room ID
   * @returns {Promise<Array>} Targets
   */
  static async getTargets(roomId) {
    return dbUtils.all("SELECT * FROM targets WHERE room_id = ?", [roomId]);
  }

  /**
   * Get all players in a room
   * @param {string} roomId - Room ID
   * @returns {Promise<Array>} Players
   */
  static async getPlayers(roomId) {
    return dbUtils.all("SELECT * FROM players WHERE room_id = ?", [roomId]);
  }

  /**
   * Get active runners in a room
   * @param {string} roomId - Room ID
   * @returns {Promise<Array>} Active runners
   */
  static async getActiveRunners(roomId) {
    return dbUtils.all(
      "SELECT * FROM players WHERE room_id = ? AND team = ? AND status = ?",
      [roomId, "runner", "active"]
    );
  }

  /**
   * Get game state for a room
   * @param {string} roomId - Room ID
   * @returns {Promise<Object>} Game state
   */
  static async getGameState(roomId) {
    try {
      // Get room info
      const room = await this.getById(roomId);
      if (!room) return null;

      // Get all players
      const players = await this.getPlayers(roomId);

      // Get all targets
      const targets = await this.getTargets(roomId);

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

      // Count number of players in each team
      const runnersCount = players.filter(p => p.team === "runner").length;
      const huntersCount = players.filter(p => p.team === "hunter").length;

      // Check if game time has expired
      const now = Date.now();
      const gameTimeExpired =
        room.start_time + room.game_duration * 60 * 1000 < now;

      // Determine game status
      let gameStatus = room.status;

      if (gameStatus === "active" && gameTimeExpired) {
        gameStatus = "completed";
        // Update room status
        await this.updateStatus(roomId, "completed");
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
        scores: {
          runners: teamScores.runners,
          hunters: teamScores.hunters,
          runnersCount: runnersCount,
          huntersCount: huntersCount
        },
        timeRemaining: gameTimeExpired
          ? 0
          : (room.start_time + room.game_duration * 60 * 1000 - now) / 1000,
      };
    } catch (error) {
      console.error("Error getting game state:", error);
      return null;
    }
  }
}

module.exports = Room;

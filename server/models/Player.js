/**
 * Player model for HUNTED Game
 */

const { v4: uuidv4 } = require("uuid");
const { dbUtils } = require("../utils/database");
const config = require("../config/default");

class Player {
  /**
   * Create a new player
   * @param {Object} playerData - Player data
   * @param {string} playerData.roomId - Room ID
   * @param {string} playerData.username - Player username
   * @param {string} playerData.team - Player team ('hunter' or 'runner')
   * @returns {Promise<Object>} Created player
   */
  static async create(playerData) {
    const { roomId, username, team } = playerData;

    // Validate input
    if (!roomId || !username || !team) {
      throw new Error("Missing required fields");
    }

    // Validate username length
    if (username.length > config.security.maxUsernameLength) {
      throw new Error(
        `Username must be ${config.security.maxUsernameLength} characters or less`
      );
    }

    // Validate team
    if (!["hunter", "runner"].includes(team)) {
      throw new Error("Invalid team");
    }

    // Check if username is already taken in this room
    const existingPlayer = await this.getByRoomAndUsername(roomId, username);
    if (existingPlayer) {
      return existingPlayer; // Return existing player for reconnection
    }

    // Generate player ID
    const playerId = uuidv4();

    // Create player in database
    await dbUtils.run(
      "INSERT INTO players (player_id, room_id, username, team, status, last_ping_time) VALUES (?, ?, ?, ?, ?, ?)",
      [playerId, roomId, username, team, "active", Date.now()]
    );

    // Get created player
    return this.getById(playerId);
  }

  /**
   * Get a player by ID
   * @param {string} playerId - Player ID
   * @returns {Promise<Object>} Player
   */
  static async getById(playerId) {
    return dbUtils.get("SELECT * FROM players WHERE player_id = ?", [playerId]);
  }

  /**
   * Get a player by room ID and username
   * @param {string} roomId - Room ID
   * @param {string} username - Player username
   * @returns {Promise<Object>} Player
   */
  static async getByRoomAndUsername(roomId, username) {
    return dbUtils.get(
      "SELECT * FROM players WHERE room_id = ? AND username = ?",
      [roomId, username]
    );
  }

  /**
   * Update player status
   * @param {string} playerId - Player ID
   * @param {string} status - New status ('active', 'inactive', 'caught')
   * @returns {Promise<Object>} Updated player
   */
  static async updateStatus(playerId, status) {
    // Validate status
    if (!["active", "inactive", "caught"].includes(status)) {
      throw new Error("Invalid status");
    }

    // Update status in database
    await dbUtils.run("UPDATE players SET status = ? WHERE player_id = ?", [
      status,
      playerId,
    ]);

    // Get updated player
    return this.getById(playerId);
  }

  /**
   * Update player team
   * @param {string} playerId - Player ID
   * @param {string} team - New team ('hunter' or 'runner')
   * @returns {Promise<Object>} Updated player
   */
  static async updateTeam(playerId, team) {
    // Validate team
    if (!["hunter", "runner"].includes(team)) {
      throw new Error("Invalid team");
    }

    // Update team in database
    await dbUtils.run("UPDATE players SET team = ? WHERE player_id = ?", [
      team,
      playerId,
    ]);

    // Get updated player
    return this.getById(playerId);
  }

  /**
   * Update player location
   * @param {string} playerId - Player ID
   * @param {number} lat - Latitude
   * @param {number} lng - Longitude
   * @returns {Promise<Object>} Updated player
   */
  static async updateLocation(playerId, lat, lng) {
    // Validate input
    if (!lat || !lng) {
      throw new Error("Missing location coordinates");
    }

    // Update location in database
    await dbUtils.run(
      "UPDATE players SET last_lat = ?, last_lng = ?, last_ping_time = ? WHERE player_id = ?",
      [lat, lng, Date.now(), playerId]
    );

    // Get updated player
    return this.getById(playerId);
  }

  /**
   * Get players by team
   * @param {string} roomId - Room ID
   * @param {string} team - Team ('hunter' or 'runner')
   * @param {string} [status] - Filter by status ('active', 'inactive', 'caught')
   * @returns {Promise<Array>} Players
   */
  static async getByTeam(roomId, team, status = null) {
    let query = "SELECT * FROM players WHERE room_id = ? AND team = ?";
    let params = [roomId, team];

    if (status) {
      query += " AND status = ?";
      params.push(status);
    }

    return dbUtils.all(query, params);
  }

  /**
   * Get all players in a room
   * @param {string} roomId - Room ID
   * @returns {Promise<Array>} Players
   */
  static async getByRoom(roomId) {
    return dbUtils.all("SELECT * FROM players WHERE room_id = ?", [roomId]);
  }

  /**
   * Catch a runner (change to hunter team)
   * @param {string} playerId - Player ID of the caught runner
   * @returns {Promise<Object>} Updated player
   */
  static async catchRunner(playerId) {
    // Get player
    const player = await this.getById(playerId);

    // Validate player
    if (!player) {
      throw new Error("Player not found");
    }

    // Validate player is a runner
    if (player.team !== "runner") {
      throw new Error("Player is not a runner");
    }

    // Update player status to caught
    await this.updateStatus(playerId, "caught");

    // Update player team to hunter
    await this.updateTeam(playerId, "hunter");

    // Get updated player
    return this.getById(playerId);
  }
}

module.exports = Player;

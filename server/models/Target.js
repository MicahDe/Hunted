/**
 * Target model for HUNTED Game
 */

const { v4: uuidv4 } = require("uuid");
const { dbUtils } = require("../utils/database");
const config = require("../config/default");
const geoUtils = require("../utils/geoUtils");

class Target {
  /**
   * Create a new target
   * @param {Object} targetData - Target data
   * @param {string} targetData.roomId - Room ID
   * @param {number} targetData.lat - Latitude
   * @param {number} targetData.lng - Longitude
   * @param {number} targetData.radiusLevel - Radius level in meters
   * @param {number} targetData.pointsValue - Points value
   * @returns {Promise<Object>} Created target
   */
  static async create(targetData) {
    const { roomId, lat, lng, radiusLevel, pointsValue } = targetData;

    // Validate input
    if (!roomId || lat === undefined || lng === undefined || !radiusLevel) {
      throw new Error("Missing required fields");
    }

    // Generate target ID
    const targetId = uuidv4();

    // Create target in database
    await dbUtils.run(
      "INSERT INTO targets (target_id, room_id, lat, lng, radius_level, points_value) VALUES (?, ?, ?, ?, ?, ?)",
      [
        targetId,
        roomId,
        lat,
        lng,
        radiusLevel,
        pointsValue || config.game.baseTargetPoints,
      ]
    );

    // Get created target
    return this.getById(targetId);
  }

  /**
   * Get a target by ID
   * @param {string} targetId - Target ID
   * @returns {Promise<Object>} Target
   */
  static async getById(targetId) {
    return dbUtils.get("SELECT * FROM targets WHERE target_id = ?", [targetId]);
  }

  /**
   * Get targets by room
   * @param {string} roomId - Room ID
   * @returns {Promise<Array>} Targets
   */
  static async getByRoom(roomId) {
    return dbUtils.all("SELECT * FROM targets WHERE room_id = ?", [roomId]);
  }

  /**
   * Get active targets (not reached yet) by room
   * @param {string} roomId - Room ID
   * @returns {Promise<Array>} Active targets
   */
  static async getActiveByRoom(roomId) {
    return dbUtils.all(
      "SELECT * FROM targets WHERE room_id = ? AND reached_by IS NULL",
      [roomId]
    );
  }

  /**
   * Mark target as reached by player
   * @param {string} targetId - Target ID
   * @param {string} playerId - Player ID
   * @returns {Promise<Object>} Updated target
   */
  static async markAsReached(targetId, playerId) {
    // Update target in database
    await dbUtils.run("UPDATE targets SET reached_by = ? WHERE target_id = ?", [
      playerId,
      targetId,
    ]);

    // Get updated target
    return this.getById(targetId);
  }

  /**
   * Delete a target
   * @param {string} targetId - Target ID
   * @returns {Promise<boolean>} Success
   */
  static async delete(targetId) {
    const result = await dbUtils.run(
      "DELETE FROM targets WHERE target_id = ?",
      [targetId]
    );

    return result.changes > 0;
  }

  /**
   * Check if a player has reached a target
   * @param {string} roomId - Room ID
   * @param {string} playerId - Player ID
   * @param {number} lat - Player latitude
   * @param {number} lng - Player longitude
   * @returns {Promise<Object|null>} Target info if reached, null otherwise
   */
  static async checkTargetReached(roomId, playerId, lat, lng) {
    // Get active targets for this room
    const targets = await this.getActiveByRoom(roomId);

    // Check if player is in range of any targets
    for (const target of targets) {
      const distance = geoUtils.calculateDistance(
        lat,
        lng,
        target.lat,
        target.lng
      );

      // Check if player is within radius
      if (distance <= target.radius_level) {
        // If smallest radius (125m), mark as reached
        if (
          target.radius_level ===
          config.game.targetRadiusLevels[
            config.game.targetRadiusLevels.length - 1
          ]
        ) {
          // Update target as reached
          await this.markAsReached(target.target_id, playerId);

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
          // Find current radius level index
          const currentRadiusIndex = config.game.targetRadiusLevels.indexOf(
            target.radius_level
          );

          // Get next smaller radius level
          const nextRadiusLevel =
            config.game.targetRadiusLevels[currentRadiusIndex + 1];

          // Generate offset for inner circle (not centered)
          const { offsetLat, offsetLng } = geoUtils.generateRandomOffset(
            target.lat,
            target.lng,
            target.radius_level,
            nextRadiusLevel
          );

          // Calculate new points value
          const newPointsValue = Math.round(
            target.points_value * config.game.targetPointsMultiplier
          );

          // Create new target with smaller radius
          const newTarget = await this.create({
            roomId,
            lat: offsetLat,
            lng: offsetLng,
            radiusLevel: nextRadiusLevel,
            pointsValue: newPointsValue,
          });

          // Delete old target
          await this.delete(target.target_id);

          // Return new target info
          return {
            targetId: newTarget.target_id,
            location: {
              lat: newTarget.lat,
              lng: newTarget.lng,
            },
            radiusLevel: newTarget.radius_level,
            pointsValue: newTarget.points_value,
          };
        }
      }
    }

    return null;
  }
}

module.exports = Target;

/**
 * Player Controller for HUNTED Game
 */

const Player = require("../models/Player");

const playerController = {
  /**
   * Get a player by ID
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getPlayerById: async (req, res) => {
    try {
      const { playerId } = req.params;

      // Get player
      const player = await Player.getById(playerId);

      if (!player) {
        return res.status(404).json({ error: "Player not found" });
      }

      res.json({
        playerId: player.player_id,
        username: player.username,
        team: player.team,
        status: player.status,
        lastLocation:
          player.last_lat && player.last_lng
            ? {
                lat: player.last_lat,
                lng: player.last_lng,
              }
            : null,
        lastPing: player.last_ping_time,
      });
    } catch (error) {
      console.error("Error getting player:", error);
      res.status(500).json({ error: "Failed to get player" });
    }
  },

  /**
   * Update player team
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  updatePlayerTeam: async (req, res) => {
    try {
      const { playerId } = req.params;
      const { team } = req.body;

      if (!team) {
        return res.status(400).json({ error: "Missing team" });
      }

      // Update player team
      const player = await Player.updateTeam(playerId, team);

      if (!player) {
        return res.status(404).json({ error: "Player not found" });
      }

      res.json({
        message: "Team updated successfully",
        player: {
          playerId: player.player_id,
          username: player.username,
          team: player.team,
          status: player.status,
        },
      });
    } catch (error) {
      console.error("Error updating player team:", error);

      if (error.message === "Invalid team") {
        return res.status(400).json({ error: error.message });
      }

      res.status(500).json({ error: "Failed to update player team" });
    }
  },

  /**
   * Update player status
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  updatePlayerStatus: async (req, res) => {
    try {
      const { playerId } = req.params;
      const { status } = req.body;

      if (!status) {
        return res.status(400).json({ error: "Missing status" });
      }

      // Update player status
      const player = await Player.updateStatus(playerId, status);

      if (!player) {
        return res.status(404).json({ error: "Player not found" });
      }

      res.json({
        message: "Status updated successfully",
        player: {
          playerId: player.player_id,
          username: player.username,
          team: player.team,
          status: player.status,
        },
      });
    } catch (error) {
      console.error("Error updating player status:", error);

      if (error.message === "Invalid status") {
        return res.status(400).json({ error: error.message });
      }

      res.status(500).json({ error: "Failed to update player status" });
    }
  },

  /**
   * Get active hunters
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getActiveHunters: async (req, res) => {
    try {
      const { roomId } = req.params;

      // Get active hunters
      const hunters = await Player.getByTeam(roomId, "hunter", "active");

      res.json({
        hunters: hunters.map((h) => ({
          playerId: h.player_id,
          username: h.username,
          status: h.status,
          lastLocation:
            h.last_lat && h.last_lng
              ? {
                  lat: h.last_lat,
                  lng: h.last_lng,
                }
              : null,
          lastPing: h.last_ping_time,
        })),
      });
    } catch (error) {
      console.error("Error getting active hunters:", error);
      res.status(500).json({ error: "Failed to get active hunters" });
    }
  },

  /**
   * Get active runners
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getActiveRunners: async (req, res) => {
    try {
      const { roomId } = req.params;

      // Get active runners
      const runners = await Player.getByTeam(roomId, "runner", "active");

      res.json({
        runners: runners.map((r) => ({
          playerId: r.player_id,
          username: r.username,
          status: r.status,
          lastLocation:
            r.last_lat && r.last_lng
              ? {
                  lat: r.last_lat,
                  lng: r.last_lng,
                }
              : null,
          lastPing: r.last_ping_time,
        })),
      });
    } catch (error) {
      console.error("Error getting active runners:", error);
      res.status(500).json({ error: "Failed to get active runners" });
    }
  },
};

module.exports = playerController;

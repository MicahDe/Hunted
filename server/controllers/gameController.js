/**
 * Game Controller for HUNTED Game
 */

const Room = require("../models/Room");
const Player = require("../models/Player");
const Target = require("../models/Target");

const gameController = {
  /**
   * Get current game state
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getGameState: async (req, res) => {
    try {
      const { roomId } = req.params;

      // Get game state
      const gameState = await Room.getGameState(roomId);

      if (!gameState) {
        return res.status(404).json({ error: "Room not found" });
      }

      res.json(gameState);
    } catch (error) {
      console.error("Error getting game state:", error);
      res.status(500).json({ error: "Failed to get game state" });
    }
  },

  /**
   * Start the game
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  startGame: async (req, res) => {
    try {
      const { roomId } = req.params;

      // Update room status to active
      const room = await Room.updateStatus(roomId, "active");

      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }

      // Get updated game state
      const gameState = await Room.getGameState(roomId);

      res.json({
        message: "Game started",
        gameState,
      });
    } catch (error) {
      console.error("Error starting game:", error);
      res.status(500).json({ error: "Failed to start game" });
    }
  },

  /**
   * End the game
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  endGame: async (req, res) => {
    try {
      const { roomId } = req.params;

      // Update room status to completed
      const room = await Room.updateStatus(roomId, "completed");

      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }

      // Get updated game state
      const gameState = await Room.getGameState(roomId);

      res.json({
        message: "Game ended",
        gameState,
      });
    } catch (error) {
      console.error("Error ending game:", error);
      res.status(500).json({ error: "Failed to end game" });
    }
  },

  /**
   * Report player caught
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  reportPlayerCaught: async (req, res) => {
    try {
      const { playerId } = req.params;
      const { reportingPlayerId } = req.body;

      if (!reportingPlayerId) {
        return res.status(400).json({ error: "Missing reporting player ID" });
      }

      // Get reporting player
      const reporter = await Player.getById(reportingPlayerId);

      // Verify reporting player is a hunter
      if (!reporter || reporter.team !== "hunter") {
        return res
          .status(403)
          .json({ error: "Only hunters can report catches" });
      }

      // Get the runner being caught
      const runner = await Player.getById(playerId);

      // Verify runner exists and is on runner team
      if (!runner) {
        return res.status(404).json({ error: "Player not found: " + playerId });
      }

      if (runner.team !== "runner") {
        return res.status(400).json({ error: "Player is not a runner: " + playerId });
      }

      if (runner.status === "caught") {
        return res.status(400).json({ error: "Player already caught: " + playerId });
      }

      // Catch the runner (updates status and team)
      const caughtPlayer = await Player.catchRunner(playerId);

      // Check if all runners are caught
      const activeRunners = await Room.getActiveRunners(runner.room_id);

      let gameOver = false;
      if (activeRunners.length === 0) {
        // All runners caught, game over
        await Room.updateStatus(runner.room_id, "completed");
        gameOver = true;
      }

      // Get updated game state
      const gameState = await Room.getGameState(runner.room_id);

      res.json({
        message: "Player caught successfully",
        player: {
          playerId: caughtPlayer.player_id,
          username: caughtPlayer.username,
          newStatus: "caught",
          newTeam: "hunter",
        },
        gameOver,
        gameState,
      });
    } catch (error) {
      console.error("Error reporting player caught:", error);
      res.status(500).json({ error: "Failed to report player caught" });
    }
  },

  /**
   * Update player location
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  updatePlayerLocation: async (req, res) => {
    try {
      const { playerId } = req.params;
      const { lat, lng } = req.body;

      if (!lat || !lng) {
        return res.status(400).json({ error: "Missing location coordinates" });
      }

      // Update player location
      const player = await Player.updateLocation(playerId, lat, lng);

      if (!player) {
        return res.status(404).json({ error: "Player not found: " + playerId });
      }

      // If player is runner, check if they reached any targets
      let targetReached = null;

      if (player.team === "runner" && player.status === "active") {
        targetReached = await Target.checkTargetReached(
          player.room_id,
          player.player_id,
          lat,
          lng
        );
      }

      res.json({
        message: "Location updated",
        player: {
          playerId: player.player_id,
          username: player.username,
          location: {
            lat: player.last_lat,
            lng: player.last_lng,
          },
          lastPing: player.last_ping_time,
        },
        targetReached,
      });
    } catch (error) {
      console.error("Error updating player location:", error);
      res.status(500).json({ error: "Failed to update location" });
    }
  },
};

module.exports = gameController;

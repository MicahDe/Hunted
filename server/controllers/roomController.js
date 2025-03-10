/**
 * Room Controller for HUNTED Game
 */

const Room = require("../models/Room");
const Player = require("../models/Player");

const roomController = {
  /**
   * Create a new room
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  createRoom: async (req, res) => {
    try {
      const { roomName, gameDuration, centralLat, centralLng } = req.body;

      // Validate input
      if (!roomName || !gameDuration || !centralLat || !centralLng) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Create room
      const room = await Room.create({
        roomName,
        gameDuration,
        centralLat,
        centralLng,
      });

      res.status(201).json({
        message: "Room created successfully",
        room: {
          roomId: room.room_id,
          roomName: room.room_name,
          gameDuration: room.game_duration,
          centralLocation: {
            lat: room.central_lat,
            lng: room.central_lng,
          },
          startTime: room.start_time,
          status: room.status,
        },
      });
    } catch (error) {
      console.error("Error creating room:", error);

      if (error.message === "Room name already exists") {
        return res.status(409).json({ error: error.message });
      }

      res.status(500).json({ error: "Failed to create room" });
    }
  },

  /**
   * Get a room by ID
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getRoomById: async (req, res) => {
    try {
      const { roomId } = req.params;

      // Get room
      const room = await Room.getById(roomId);

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
    } catch (error) {
      console.error("Error getting room:", error);
      res.status(500).json({ error: "Failed to get room" });
    }
  },

  /**
   * Get a room by name
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getRoomByName: async (req, res) => {
    try {
      const { roomName } = req.params;

      // Get room
      const room = await Room.getByName(roomName);

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
    } catch (error) {
      console.error("Error getting room:", error);
      res.status(500).json({ error: "Failed to get room" });
    }
  },

  /**
   * Join an existing room
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  joinRoom: async (req, res) => {
    try {
      const { roomId } = req.params;
      const { username, team } = req.body;

      // Validate input
      if (!username || !team) {
        return res.status(400).json({ error: "Missing username or team" });
      }

      // Check if room exists
      const room = await Room.getById(roomId);

      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }

      // Create or reconnect player
      const player = await Player.create({
        roomId,
        username,
        team,
      });

      // Check if this is a new player or rejoining
      const isNewPlayer = player.created_at === player.last_ping_time;

      res.status(isNewPlayer ? 201 : 200).json({
        message: isNewPlayer ? "Joined room" : "Rejoined room",
        player: {
          playerId: player.player_id,
          username: player.username,
          team: player.team,
          status: player.status,
        },
        room: {
          roomId: room.room_id,
          roomName: room.room_name,
          status: room.status,
        },
      });
    } catch (error) {
      console.error("Error joining room:", error);
      res.status(500).json({ error: "Failed to join room" });
    }
  },

  /**
   * Get all players in a room
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getRoomPlayers: async (req, res) => {
    try {
      const { roomId } = req.params;

      // Check if room exists
      const room = await Room.getById(roomId);

      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }

      // Get players
      const players = await Player.getByRoom(roomId);

      res.json({
        roomId,
        players: players.map((p) => ({
          playerId: p.player_id,
          username: p.username,
          team: p.team,
          status: p.status,
          lastPing: p.last_ping_time,
        })),
      });
    } catch (error) {
      console.error("Error getting room players:", error);
      res.status(500).json({ error: "Failed to get room players" });
    }
  },

  /**
   * Get all targets in a room
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getRoomTargets: async (req, res) => {
    try {
      const { roomId } = req.params;

      // Check if room exists
      const room = await Room.getById(roomId);

      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }

      // Get targets
      const targets = await Room.getTargets(roomId);

      res.json({
        roomId,
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
      });
    } catch (error) {
      console.error("Error getting room targets:", error);
      res.status(500).json({ error: "Failed to get room targets" });
    }
  },
};

module.exports = roomController;

/**
 * Default configuration for HUNTED Game
 */

module.exports = {
  // Server config
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || "localhost",
  },

  // Database config
  database: {
    path: process.env.DB_PATH || "../database/hunted.db",
  },

  // Game config
  game: {
    // Default play area radius in meters
    defaultPlayAreaRadius: 5000,

    // Default game duration in minutes
    defaultGameDuration: 60,

    // Default number of targets per game
    minTargets: 5,
    maxTargets: 10,

    // Target radius levels in meters
    targetRadiusLevels: [2000, 1000, 500, 250, 125],

    // Base points per target
    baseTargetPoints: 10,

    // Additional points per inner circle
    targetPointsMultiplier: 1.5,

    // Location update interval in milliseconds
    locationUpdateInterval: 30000,

    // Location update throttle in milliseconds (prevent abuse)
    locationUpdateThrottle: 5000,
  },

  // Security config
  security: {
    // Maximum username length
    maxUsernameLength: 20,

    // Maximum room name length
    maxRoomNameLength: 30,
  },
};

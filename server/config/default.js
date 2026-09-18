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

    // Default game duration in minutes. The game is split into one equal zone
    // window per radius level, so 60 minutes over 6 zones gives a zone every 10
    // minutes: zone 1 from 0-10, zone 2 from 10-20, the last from 50-60.
    defaultGameDuration: 60,

    // Zone radii in meters, one per zone, largest first. Each is roughly two
    // thirds of the one before, closing from a first zone a runner has to walk
    // across to a final zone they have to stand in.
    targetRadiusLevels: [750, 500, 350, 240, 160, 110],

    // How long a runner is safe from being caught after a catch takes their
    // shield, in minutes. Configurable per room at setup.
    defaultCatchImmunity: 3,

    // How often the server checks rooms for zone windows closing
    scheduleTickInterval: 1000,

    // Base points per target
    baseTargetPoints: 2,

    // Additional points per each inner circle
    additionalPointsPerCircle: 1,

    // Location update interval in milliseconds
    locationUpdateInterval: 30000,

    // Location update throttle in milliseconds (prevent abuse)
    locationUpdateThrottle: 10000,

    // Runner trails shown on other players' maps (see shared/utils/trailUtils.js)
    trail: {
      // How far back trails go - roughly the length of a game.
      // If modifying this, also modify TRAIL_WINDOW_MS in map.js
      windowMs: 60 * 60 * 1000,

      // A longer gap between pings means the runner closed the app.
      // Must stay comfortably above the 30s location timer an open app pings on.
      sightingGapMs: 90 * 1000,

      // Pings closer than this to the last kept point are treated as GPS jitter or loitering
      minStepMeters: 25,

      // Route detail kept within each sighting
      simplifyToleranceMeters: 12,
      maxPointsPerSighting: 4,

      // Only show a direction arrow if the runner covered this distance within headingMaxAgeMs
      headingMinDistanceMeters: 40,
      headingMaxAgeMs: 2 * 60 * 1000,

      // The end of game replay covers the whole game and keeps more of the
      // route, since nobody is being chased any more
      review: {
        minStepMeters: 15,
        simplifyToleranceMeters: 8,
        maxPointsPerSighting: 12,
      },
    },
  },

  // Security config
  security: {
    // Maximum username length
    maxUsernameLength: 20,

    // Maximum room name length
    maxRoomNameLength: 30,
  },
};

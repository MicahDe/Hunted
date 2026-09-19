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
    // Default target area radius in meters. The target area is only a
    // constraint on where the final zone is hidden - it does not bound the
    // zones, the players, or how far the game ranges.
    defaultTargetAreaRadius: 400,

    // Default game duration in minutes. The game is split into one equal zone
    // window per radius level, so 60 minutes over 6 zones gives a zone every 10
    // minutes: zone 1's window is 0-10, zone 2's 10-20, the last one's 50-60.
    defaultGameDuration: 60,

    // How long each zone is locked at the start of its window, in minutes, so
    // with the defaults zone 1 is capturable from minute 3-10, zone 2 from
    // 13-20 and the last from 53-60. Stops runners capturing zone 1 the moment
    // the game starts, or two zones back to back across a window boundary.
    // Configurable per room at setup, and never more than half a window (see
    // zoneUtils.zoneLockMs).
    defaultZoneLock: 3,

    // Zone radii in meters, one per zone, largest first, closing from a first
    // zone a runner has to walk across to a final zone they have to stand in
    targetRadiusLevels: [800, 625, 490, 365, 240, 140],

    // How far a zone may hang outside the one it sits in, as a fraction of its
    // own radius. At 0 the circles nest exactly, which makes them easy to
    // intersect and pin down; a little slack keeps a runner's picture
    // approximate. See geoUtils.generateZoneChain.
    zoneOverhang: 0.1,

    // How long a runner is safe from being caught after a catch takes their
    // shield, in minutes. Configurable per room at setup.
    defaultCatchImmunity: 3,

    // How many zones shields last. When the last of them closes - minute 20
    // with the defaults - every runner still holding one loses it. 0 means no
    // shields at all, and one per zone means they last the whole game.
    // Configurable per room at setup.
    defaultShieldZones: 2,

    // How long a runner who kept their shield until it ran out goes invisible
    // for, in minutes: their location is not shared with anyone. With the
    // defaults that covers zone 3's lock, so they can get into position for it
    // unseen. Configurable per room at setup.
    defaultInvisibility: 3,

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
    // Maximum username length. Runners often play in pairs, so this leaves
    // room for "Christopher & Alexandra".
    maxUsernameLength: 24,

    // Maximum room name length
    maxRoomNameLength: 30,
  },
};

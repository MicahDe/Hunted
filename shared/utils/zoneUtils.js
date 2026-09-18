/**
 * Zone scheduling and shield state for HUNTED Game
 *
 * Zones run on the game clock rather than on each runner's own progress: the
 * game is split into one equal window per zone, so in a 60 minute game with six
 * zones, zone 1 is capturable from minute 0 to 10, zone 2 from 10 to 20, and the
 * final zone from 50 to 60. A runner who doesn't ping inside a zone before its
 * window closes loses a life, and the whole field moves on to the next zone
 * together.
 *
 * Every runner starts with one shield - a dog's life shared between missing a
 * zone and being caught. The first of either costs the shield; the second puts
 * them out. Spending the shield on a catch also buys a short immunity so the
 * hunter who just caught them can't immediately catch them again.
 */

// The client's copy of the zone settings, for screens shown before any game
// state has arrived. Kept in step with the server's config by a test.
const DEFAULT_RADIUS_LEVELS = [800, 625, 490, 365, 240, 140];
const DEFAULT_ZONE_OVERHANG = 0.1;

// Zone windows are sized from the game duration, so every game ends on the
// close of the final zone's window.
function zoneWindowMs(gameDurationMinutes, zoneCount) {
  return Math.floor((gameDurationMinutes * 60 * 1000) / zoneCount);
}

/**
 * The window a zone owns
 * @param {number} zoneIndex - 0-based zone index
 * @param {number} gameStartTime - When the game started, in milliseconds
 * @param {number} windowMs - Length of a single zone window (see zoneWindowMs)
 * @returns {{openTime: number, closeTime: number}}
 */
function zoneWindow(zoneIndex, gameStartTime, windowMs) {
  const openTime = gameStartTime + zoneIndex * windowMs;
  return { openTime, closeTime: openTime + windowMs };
}

/**
 * Which zone window the clock is in
 * @returns {number} 0-based zone index, or zoneCount once the game clock has run out
 */
function currentZoneIndex(now, gameStartTime, windowMs, zoneCount) {
  if (now < gameStartTime) {
    return 0;
  }

  return Math.min(zoneCount, Math.floor((now - gameStartTime) / windowMs));
}

// The game ends when the final zone's window closes
function gameEndTime(gameStartTime, windowMs, zoneCount) {
  return gameStartTime + windowMs * zoneCount;
}

/**
 * Where a zone is in its window
 * @returns {"locked"|"open"|"closed"} Locked before the window opens, open while
 *   it can be captured, closed once the window has passed
 */
function zoneStatusAt(now, window) {
  if (now < window.openTime) {
    return "locked";
  }

  return now < window.closeTime ? "open" : "closed";
}

/**
 * A runner's shield and immunity at a point in time
 * @param {{shieldActive: boolean|number, immunityUntil: number|null}} player
 * @param {number} now - Current time in milliseconds
 * @returns {{hasShield: boolean, immune: boolean, immuneMsRemaining: number}}
 */
function shieldState(player, now) {
  const immuneMsRemaining = player && player.immunityUntil ? Math.max(0, player.immunityUntil - now) : 0;

  return {
    hasShield: Boolean(player && player.shieldActive),
    immune: immuneMsRemaining > 0,
    immuneMsRemaining,
  };
}

// Countdowns throughout the game UI read as MM:SS
function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

const zoneUtils = {
  DEFAULT_RADIUS_LEVELS,
  DEFAULT_ZONE_OVERHANG,
  zoneWindowMs,
  zoneWindow,
  currentZoneIndex,
  gameEndTime,
  zoneStatusAt,
  shieldState,
  formatCountdown,
};

if (typeof module !== "undefined" && module.exports) {
  // Node.js environment
  module.exports = zoneUtils;
} else if (typeof window !== "undefined") {
  // Browser environment
  window.zoneUtils = zoneUtils;
}

/**
 * Zone scheduling and shield state for HUNTED Game
 *
 * Zones run on the game clock rather than on each runner's own progress: the
 * game is split into one equal window per zone, and each window opens with a
 * spell where its zone is locked. So in a 60 minute game with six zones and a
 * 3 minute lock, zone 1 is capturable from minute 3 to 10, zone 2 from 13 to
 * 20, and the final zone from 53 to 60. The lock stops a runner capturing zone
 * 1 the moment the game starts, or two zones back to back across a window
 * boundary. A runner who doesn't ping inside a zone before its window closes
 * is out, and the rest of the field moves on to the next zone together.
 *
 * Every runner starts with one shield, which only ever stands between them and
 * a hunter: the first catch costs the shield, the second puts them out. Spending
 * it also buys a short immunity so the hunter who just caught them can't
 * immediately catch them again. Shields only last the first few zones (two by
 * default). When the last of those closes, every runner still holding one
 * loses it - and for having kept it that long, goes invisible for a spell.
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
 * How long each zone stays locked at the start of its window. Never more than
 * half the window, so a short game still leaves each zone open for at least as
 * long as it was locked, and always whole minutes so it reads cleanly.
 * @param {number} lockMinutes - The lock the host asked for
 * @param {number} windowMs - Length of a single zone window (see zoneWindowMs)
 */
function zoneLockMs(lockMinutes, windowMs) {
  const requested = Math.max(0, Number(lockMinutes) || 0) * 60 * 1000;
  const cap = Math.floor(windowMs / 2 / (60 * 1000)) * 60 * 1000;

  return Math.min(requested, cap);
}

/**
 * The part of its window a zone can be captured in: from the end of the lock
 * to the end of the window
 * @param {number} zoneIndex - 0-based zone index
 * @param {number} gameStartTime - When the game started, in milliseconds
 * @param {number} windowMs - Length of a single zone window (see zoneWindowMs)
 * @param {number} [lockMs] - How long the zone is locked first (see zoneLockMs)
 * @returns {{openTime: number, closeTime: number}}
 */
function zoneWindow(zoneIndex, gameStartTime, windowMs, lockMs = 0) {
  const windowStart = gameStartTime + zoneIndex * windowMs;
  return { openTime: windowStart + lockMs, closeTime: windowStart + windowMs };
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
 * @returns {"locked"|"open"|"closed"} Locked until its lock runs out, open while
 *   it can be captured, closed once the window has passed
 */
function zoneStatusAt(now, window) {
  if (now < window.openTime) {
    return "locked";
  }

  return now < window.closeTime ? "open" : "closed";
}

/**
 * When every runner's shield runs out: the close of the last zone window it
 * covers, so with the default of two zones in a 60 minute game, minute 20
 * @param {number} shieldZones - How many zones shields last
 * @returns {number|null} Null when shields never run out mid-game - there are
 *   none at all, they last every zone, or the game hasn't started
 */
function shieldDeadline(gameStartTime, windowMs, zoneCount, shieldZones) {
  if (!gameStartTime || !(shieldZones > 0) || shieldZones >= zoneCount) {
    return null;
  }

  return gameStartTime + shieldZones * windowMs;
}

/**
 * A runner's shield, immunity and invisibility at a point in time
 * @param {{shieldActive: boolean|number, immunityUntil: number|null, invisibleUntil?: number|null}} player
 * @param {number} now - Current time in milliseconds
 * @returns {{hasShield: boolean, immune: boolean, immuneMsRemaining: number, invisible: boolean, invisibleMsRemaining: number}}
 */
function shieldState(player, now) {
  const immuneMsRemaining = player && player.immunityUntil ? Math.max(0, player.immunityUntil - now) : 0;
  const invisibleMsRemaining = player && player.invisibleUntil ? Math.max(0, player.invisibleUntil - now) : 0;

  return {
    hasShield: Boolean(player && player.shieldActive),
    immune: immuneMsRemaining > 0,
    immuneMsRemaining,
    invisible: invisibleMsRemaining > 0,
    invisibleMsRemaining,
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
  zoneLockMs,
  zoneWindow,
  currentZoneIndex,
  gameEndTime,
  zoneStatusAt,
  shieldDeadline,
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

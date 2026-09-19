/**
 * Tests for the zone clock.
 *
 * Zones used to unlock on a per-runner delay; now they run on the game clock, so
 * a 60 minute game over six zones gives zone 1 the window from minute 0-10 and
 * the final zone 50-60, each locked for the start of its window. These tests
 * pin down that arithmetic, including the boundaries either side of a window,
 * since a zone closing is what puts a runner out, and when shields run out.
 */

const test = require("node:test");
const assert = require("node:assert");

const zoneUtils = require("../shared/utils/zoneUtils");
const config = require("../server/config/default");

const START = 1_800_000_000_000;
const MINUTE = 60 * 1000;
const ZONE_COUNT = 6;
const WINDOW = zoneUtils.zoneWindowMs(60, ZONE_COUNT);

test("a 60 minute game over six zones gives a zone every 10 minutes", () => {
  assert.strictEqual(WINDOW, 10 * MINUTE);
});

test("zone windows always cover the whole game, whatever its length", () => {
  const window = zoneUtils.zoneWindowMs(30, ZONE_COUNT);

  assert.strictEqual(window, 5 * MINUTE);
  assert.strictEqual(zoneUtils.gameEndTime(START, window, ZONE_COUNT), START + 30 * MINUTE);
});

test("the shipped radius ladder has one zone per window", () => {
  assert.strictEqual(config.game.targetRadiusLevels.length, ZONE_COUNT);

  // The client draws zones before its first game state arrives, so its copy of
  // the ladder has to match the server's
  assert.deepStrictEqual(zoneUtils.DEFAULT_RADIUS_LEVELS, config.game.targetRadiusLevels);

  // Each zone is inside the one before it
  const descending = [...config.game.targetRadiusLevels].sort((a, b) => b - a);
  assert.deepStrictEqual(config.game.targetRadiusLevels, descending);
});

test("zone 1 runs from minute 0 to 10 and the final zone from 50 to 60", () => {
  const first = zoneUtils.zoneWindow(0, START, WINDOW);
  const last = zoneUtils.zoneWindow(ZONE_COUNT - 1, START, WINDOW);

  assert.strictEqual(first.openTime, START);
  assert.strictEqual(first.closeTime, START + 10 * MINUTE);
  assert.strictEqual(last.openTime, START + 50 * MINUTE);
  assert.strictEqual(last.closeTime, START + 60 * MINUTE);
});

test("the clock reports the zone whose window is running", () => {
  const at = (minutes) => zoneUtils.currentZoneIndex(START + minutes * MINUTE, START, WINDOW, ZONE_COUNT);

  assert.strictEqual(at(0), 0);
  assert.strictEqual(at(9.99), 0);
  assert.strictEqual(at(10), 1);
  assert.strictEqual(at(55), 5);
});

test("the clock stops at the end of the final window rather than running on", () => {
  const at = (minutes) => zoneUtils.currentZoneIndex(START + minutes * MINUTE, START, WINDOW, ZONE_COUNT);

  // Zone count, not a seventh zone: the game is over
  assert.strictEqual(at(60), ZONE_COUNT);
  assert.strictEqual(at(180), ZONE_COUNT);
  assert.strictEqual(zoneUtils.gameEndTime(START, WINDOW, ZONE_COUNT), START + 60 * MINUTE);
});

test("a game state from before kick-off sits on the first zone", () => {
  assert.strictEqual(zoneUtils.currentZoneIndex(START - MINUTE, START, WINDOW, ZONE_COUNT), 0);
});

test("with a 3 minute lock, zone 1 opens at minute 3, zone 2 at 13 and zone 3 at 23", () => {
  const lock = zoneUtils.zoneLockMs(3, WINDOW);
  assert.strictEqual(lock, 3 * MINUTE);

  const windows = [0, 1, 2, ZONE_COUNT - 1].map((index) => zoneUtils.zoneWindow(index, START, WINDOW, lock));
  const minutes = windows.map((window) => [(window.openTime - START) / MINUTE, (window.closeTime - START) / MINUTE]);

  assert.deepStrictEqual(minutes, [
    [3, 10],
    [13, 20],
    [23, 30],
    [53, 60],
  ]);
});

test("the lock doesn't move when a window closes, or when the game ends", () => {
  const lock = zoneUtils.zoneLockMs(3, WINDOW);
  const at = (minutes) => zoneUtils.currentZoneIndex(START + minutes * MINUTE, START, WINDOW, ZONE_COUNT);

  // Zone 2's window starts at minute 10, locked or not
  assert.strictEqual(at(10), 1);
  assert.strictEqual(zoneUtils.zoneStatusAt(START + 10 * MINUTE, zoneUtils.zoneWindow(1, START, WINDOW, lock)), "locked");
  assert.strictEqual(zoneUtils.gameEndTime(START, WINDOW, ZONE_COUNT), START + 60 * MINUTE);
});

test("two zones can't be captured back to back across a window boundary", () => {
  const lock = zoneUtils.zoneLockMs(3, WINDOW);
  const zone2 = zoneUtils.zoneWindow(1, START, WINDOW, lock);
  const zone3 = zoneUtils.zoneWindow(2, START, WINDOW, lock);

  // The last moment zone 2 is open and the first moment zone 3 is are a full lock apart
  assert.strictEqual(zone3.openTime - zone2.closeTime, 3 * MINUTE);
  assert.strictEqual(zoneUtils.zoneStatusAt(zone2.closeTime, zone3), "locked");
});

test("no lock leaves each zone open for its whole window", () => {
  const window = zoneUtils.zoneWindow(2, START, WINDOW, zoneUtils.zoneLockMs(0, WINDOW));

  assert.strictEqual(window.openTime, START + 20 * MINUTE);
  assert.strictEqual(window.closeTime, START + 30 * MINUTE);

  // And leaving the lock out altogether is the same as no lock
  assert.deepStrictEqual(zoneUtils.zoneWindow(2, START, WINDOW), window);
});

test("a zone is never locked for more than half its window", () => {
  // A 30 minute game has 5 minute windows, so a 3 minute lock is cut to 2
  assert.strictEqual(zoneUtils.zoneLockMs(3, zoneUtils.zoneWindowMs(30, ZONE_COUNT)), 2 * MINUTE);

  // A 6 minute test game has 1 minute windows, which leaves no room for a lock
  assert.strictEqual(zoneUtils.zoneLockMs(3, zoneUtils.zoneWindowMs(6, ZONE_COUNT)), 0);

  // Plenty of room in a long game
  assert.strictEqual(zoneUtils.zoneLockMs(3, zoneUtils.zoneWindowMs(120, ZONE_COUNT)), 3 * MINUTE);
});

test("a zone is locked before its window, open during it and closed after", () => {
  const window = zoneUtils.zoneWindow(2, START, WINDOW, 3 * MINUTE);

  assert.strictEqual(zoneUtils.zoneStatusAt(START, window), "locked");
  assert.strictEqual(zoneUtils.zoneStatusAt(window.openTime - 1, window), "locked");
  assert.strictEqual(zoneUtils.zoneStatusAt(window.openTime, window), "open");
  assert.strictEqual(zoneUtils.zoneStatusAt(window.closeTime - 1, window), "open");
  assert.strictEqual(zoneUtils.zoneStatusAt(window.closeTime, window), "closed");
});

test("shield state reads as shielded, immune or neither", () => {
  const shielded = zoneUtils.shieldState({ shieldActive: 1, immunityUntil: null }, START);
  assert.deepStrictEqual(shielded, { hasShield: true, immune: false, immuneMsRemaining: 0, invisible: false, invisibleMsRemaining: 0 });

  const immune = zoneUtils.shieldState({ shieldActive: 0, immunityUntil: START + 2 * MINUTE }, START);
  assert.strictEqual(immune.hasShield, false);
  assert.strictEqual(immune.immune, true);
  assert.strictEqual(immune.immuneMsRemaining, 2 * MINUTE);

  // Immunity that has run out is not immunity
  const expired = zoneUtils.shieldState({ shieldActive: 0, immunityUntil: START - 1 }, START);
  assert.strictEqual(expired.immune, false);
  assert.strictEqual(expired.immuneMsRemaining, 0);
});

test("a runner who kept their shield reads as invisible until their spell runs out", () => {
  const invisible = zoneUtils.shieldState({ shieldActive: 0, immunityUntil: null, invisibleUntil: START + 3 * MINUTE }, START);
  assert.strictEqual(invisible.hasShield, false);
  assert.strictEqual(invisible.invisible, true);
  assert.strictEqual(invisible.invisibleMsRemaining, 3 * MINUTE);

  const visibleAgain = zoneUtils.shieldState({ shieldActive: 0, immunityUntil: null, invisibleUntil: START }, START);
  assert.strictEqual(visibleAgain.invisible, false);
});

test("shields run out when the last zone they cover closes", () => {
  // The default two zones in a 60 minute game: minute 20
  assert.strictEqual(zoneUtils.shieldDeadline(START, WINDOW, ZONE_COUNT, 2), START + 20 * MINUTE);
  assert.strictEqual(zoneUtils.shieldDeadline(START, WINDOW, ZONE_COUNT, 2), zoneUtils.zoneWindow(1, START, WINDOW).closeTime);
  assert.strictEqual(zoneUtils.shieldDeadline(START, WINDOW, ZONE_COUNT, 5), START + 50 * MINUTE);
});

test("shields never run out mid-game when there are none, or they cover every zone", () => {
  assert.strictEqual(zoneUtils.shieldDeadline(START, WINDOW, ZONE_COUNT, 0), null);
  assert.strictEqual(zoneUtils.shieldDeadline(START, WINDOW, ZONE_COUNT, ZONE_COUNT), null);
  assert.strictEqual(zoneUtils.shieldDeadline(null, WINDOW, ZONE_COUNT, 2), null, "nor before the game has started");
});

test("countdowns read as MM:SS and never go negative", () => {
  assert.strictEqual(zoneUtils.formatCountdown(0), "00:00");
  assert.strictEqual(zoneUtils.formatCountdown(-5000), "00:00");
  assert.strictEqual(zoneUtils.formatCountdown(65 * 1000), "01:05");
  assert.strictEqual(zoneUtils.formatCountdown(10 * MINUTE), "10:00");
});

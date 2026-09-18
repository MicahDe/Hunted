/**
 * Tests for the zone clock.
 *
 * Zones used to unlock on a per-runner delay; now they run on the game clock, so
 * a 60 minute game over six zones puts zone 1 in minutes 0-10 and the final zone
 * in minutes 50-60. These tests pin down that arithmetic, including the
 * boundaries either side of a window, since a zone closing is what costs a
 * runner a life.
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

test("a zone is locked before its window, open during it and closed after", () => {
  const window = zoneUtils.zoneWindow(2, START, WINDOW);

  assert.strictEqual(zoneUtils.zoneStatusAt(START, window), "locked");
  assert.strictEqual(zoneUtils.zoneStatusAt(window.openTime - 1, window), "locked");
  assert.strictEqual(zoneUtils.zoneStatusAt(window.openTime, window), "open");
  assert.strictEqual(zoneUtils.zoneStatusAt(window.closeTime - 1, window), "open");
  assert.strictEqual(zoneUtils.zoneStatusAt(window.closeTime, window), "closed");
});

test("shield state reads as shielded, immune or neither", () => {
  const shielded = zoneUtils.shieldState({ shieldActive: 1, immunityUntil: null }, START);
  assert.deepStrictEqual(shielded, { hasShield: true, immune: false, immuneMsRemaining: 0 });

  const immune = zoneUtils.shieldState({ shieldActive: 0, immunityUntil: START + 2 * MINUTE }, START);
  assert.strictEqual(immune.hasShield, false);
  assert.strictEqual(immune.immune, true);
  assert.strictEqual(immune.immuneMsRemaining, 2 * MINUTE);

  // Immunity that has run out is not immunity
  const expired = zoneUtils.shieldState({ shieldActive: 0, immunityUntil: START - 1 }, START);
  assert.strictEqual(expired.immune, false);
  assert.strictEqual(expired.immuneMsRemaining, 0);
});

test("countdowns read as MM:SS and never go negative", () => {
  assert.strictEqual(zoneUtils.formatCountdown(0), "00:00");
  assert.strictEqual(zoneUtils.formatCountdown(-5000), "00:00");
  assert.strictEqual(zoneUtils.formatCountdown(65 * 1000), "01:05");
  assert.strictEqual(zoneUtils.formatCountdown(10 * MINUTE), "10:00");
});

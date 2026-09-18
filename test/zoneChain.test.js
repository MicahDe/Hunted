/**
 * Tests for the chain of zones each runner is given.
 *
 * Every runner in a game is racing for the same final zone, so the chain is
 * what keeps their hunts different from each other. Two things have to hold at
 * once: every zone contains the next, so what a runner learns only narrows and
 * never contradicts itself, and two runners chasing the same final zone are
 * shown different circles on the way in.
 */

const test = require("node:test");
const assert = require("node:assert");

const geoUtils = require("../shared/utils/geoUtils");
const config = require("../server/config/default");

const LEVELS = config.game.targetRadiusLevels;
const FINAL = { lat: 53.3672, lng: -1.4986 };

function chain() {
  return geoUtils.generateZoneChain(FINAL.lat, FINAL.lng, LEVELS);
}

test("the chain has one zone per radius level, largest first", () => {
  const zones = chain();

  assert.strictEqual(zones.length, LEVELS.length);
  assert.deepStrictEqual(
    zones.map((zone) => zone.radius),
    LEVELS,
  );
});

test("the last zone is the final zone itself", () => {
  const zones = chain();
  const last = zones[zones.length - 1];

  assert.strictEqual(last.lat, FINAL.lat);
  assert.strictEqual(last.lng, FINAL.lng);
  assert.strictEqual(last.radius, LEVELS[LEVELS.length - 1]);
});

test("every zone contains the one inside it, over and over", () => {
  // Random offsets, so this is worth checking across many chains
  for (let attempt = 0; attempt < 500; attempt++) {
    const zones = chain();

    for (let i = 0; i < zones.length - 1; i++) {
      const gap = geoUtils.calculateDistance(zones[i].lat, zones[i].lng, zones[i + 1].lat, zones[i + 1].lng);

      assert.ok(gap <= zones[i].radius - zones[i + 1].radius + 0.001, `zone ${i + 1} does not contain zone ${i + 2}`);
    }
  }
});

test("every zone contains the final zone, so the hunt never misleads", () => {
  for (let attempt = 0; attempt < 500; attempt++) {
    for (const zone of chain()) {
      const gap = geoUtils.calculateDistance(zone.lat, zone.lng, FINAL.lat, FINAL.lng);

      assert.ok(gap <= zone.radius - LEVELS[LEVELS.length - 1] + 0.001, `a ${zone.radius}m zone left the final zone outside it`);
    }
  }
});

test("two runners racing for the same final zone are shown different circles", () => {
  const mine = chain();
  const theirs = chain();

  const different = mine.some((zone, index) => geoUtils.calculateDistance(zone.lat, zone.lng, theirs[index].lat, theirs[index].lng) > 1);

  assert.ok(different, "two chains to the same final zone came out identical");
});

test("the zones spread out enough to be worth walking between", () => {
  // Averaged over many chains, the first zone should sit well off the final one
  let total = 0;
  const attempts = 500;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const first = chain()[0];
    total += geoUtils.calculateDistance(first.lat, first.lng, FINAL.lat, FINAL.lng);
  }

  const average = total / attempts;
  assert.ok(average > 100, `first zones sat only ${average.toFixed(0)}m off the final zone on average`);
});

/**
 * Tests for the chain of zones each runner is given.
 *
 * Every runner in a game is racing for the same final zone, so the chain is
 * what keeps their hunts different from each other. Two things have to hold at
 * once: the zones close in on the final zone, so what a runner learns narrows
 * rather than wanders, and two runners chasing the same final zone are shown
 * different circles on the way in.
 *
 * How tightly they nest is deliberately tunable. At zero overhang each zone
 * holds the one inside it exactly; with slack a zone may hang over its parent's
 * edge, which keeps the circles from being a solvable puzzle - but only ever by
 * as much as the setting allows.
 */

const test = require("node:test");
const assert = require("node:assert");

const geoUtils = require("../shared/utils/geoUtils");
const zoneUtils = require("../shared/utils/zoneUtils");
const config = require("../server/config/default");

const LEVELS = config.game.targetRadiusLevels;
const OVERHANG = config.game.zoneOverhang;
const FINAL = { lat: 53.3672, lng: -1.4986 };

function chain(overhang = OVERHANG) {
  return geoUtils.generateZoneChain(FINAL.lat, FINAL.lng, LEVELS, overhang);
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

test("with no overhang every zone contains the one inside it, over and over", () => {
  // Random offsets, so this is worth checking across many chains
  for (let attempt = 0; attempt < 500; attempt++) {
    const zones = chain(0);

    for (let i = 0; i < zones.length - 1; i++) {
      const gap = geoUtils.calculateDistance(zones[i].lat, zones[i].lng, zones[i + 1].lat, zones[i + 1].lng);

      assert.ok(gap <= zones[i].radius - zones[i + 1].radius + 0.001, `zone ${i + 1} does not contain zone ${i + 2}`);
    }
  }
});

test("with no overhang every zone contains the final zone", () => {
  for (let attempt = 0; attempt < 500; attempt++) {
    for (const zone of chain(0)) {
      const gap = geoUtils.calculateDistance(zone.lat, zone.lng, FINAL.lat, FINAL.lng);

      assert.ok(gap <= zone.radius - LEVELS[LEVELS.length - 1] + 0.001, `a ${zone.radius}m zone left the final zone outside it`);
    }
  }
});

test("a zone never hangs further outside its parent than the overhang allows", () => {
  for (const overhang of [0.05, config.game.zoneOverhang, 0.25]) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const zones = chain(overhang);

      for (let i = 0; i < zones.length - 1; i++) {
        const gap = geoUtils.calculateDistance(zones[i].lat, zones[i].lng, zones[i + 1].lat, zones[i + 1].lng);
        const allowed = zones[i].radius - zones[i + 1].radius + overhang * zones[i + 1].radius;

        assert.ok(gap <= allowed + 0.001, `zone ${i + 2} hung ${Math.round(gap - allowed)}m further out than ${overhang} allows`);
      }
    }
  }
});

test("the slack compounds no further than the worst case says it can", () => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const zones = chain();

    zones.forEach((zone, index) => {
      const gap = geoUtils.calculateDistance(zone.lat, zone.lng, FINAL.lat, FINAL.lng);

      assert.ok(gap <= geoUtils.maxZoneDrift(index, LEVELS, OVERHANG) + 0.001, `zone ${index + 1} drifted further from the final zone than it should be able to`);
    });
  }
});

test("some overhang actually loosens the nesting, and none leaves it exact", () => {
  const hangsOut = (overhang) => {
    let loose = 0;

    for (let attempt = 0; attempt < 300; attempt++) {
      const zones = chain(overhang);

      const anyLoose = zones.slice(0, -1).some((zone, i) => geoUtils.calculateDistance(zone.lat, zone.lng, zones[i + 1].lat, zones[i + 1].lng) > zone.radius - zones[i + 1].radius + 1);

      if (anyLoose) loose++;
    }

    return loose;
  };

  assert.strictEqual(hangsOut(0), 0, "zero overhang should nest the zones exactly");
  assert.ok(hangsOut(0.2) > 30, "a fifth of a zone's radius of slack should show up regularly");
});

test("two runners racing for the same final zone are shown different circles", () => {
  const mine = chain();
  const theirs = chain();

  const different = mine.some((zone, index) => geoUtils.calculateDistance(zone.lat, zone.lng, theirs[index].lat, theirs[index].lng) > 1);

  assert.ok(different, "two chains to the same final zone came out identical");
});

test("the zone ladder and its slack match what the client draws with", () => {
  assert.deepStrictEqual(zoneUtils.DEFAULT_RADIUS_LEVELS, LEVELS);
  assert.strictEqual(zoneUtils.DEFAULT_ZONE_OVERHANG, OVERHANG);
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

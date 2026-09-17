/**
 * Tests for runner trail building.
 *
 * The trail replaced a "last 5 pings" breadcrumb list, which lost everything
 * but the last minute or two whenever a runner kept the app open. These tests
 * pin down that the whole game's history survives as a few sightings, that
 * each sighting stays small, and that the direction arrow only appears when
 * the runner is actually moving.
 */

const test = require('node:test');
const assert = require('node:assert');

const { buildTrail } = require('../shared/utils/trailUtils');
const geoUtils = require('../shared/utils/geoUtils');
const config = require('../server/config/default');

const options = config.game.trail;
const ORIGIN = { lat: 51.5074, lng: -0.1278 };
const START = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * Converts metres east/north of the origin into a stored history row.
 */
function ping(east, north, timestamp) {
  return {
    lat: ORIGIN.lat + north / 111195,
    lng: ORIGIN.lng + east / (111195 * Math.cos((ORIGIN.lat * Math.PI) / 180)),
    timestamp,
  };
}

/**
 * Pings every few seconds while moving in a straight line, with optional GPS
 * jitter from a seeded generator so the tests are repeatable.
 */
function walk({ from, to, startAt, durationMs, everyMs = 3 * SECOND, jitter = 0, seed = 1 }) {
  let state = seed;
  const noise = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return (state / 4294967296 - 0.5) * 2 * jitter;
  };

  const rows = [];
  for (let elapsed = 0; elapsed <= durationMs; elapsed += everyMs) {
    const f = durationMs === 0 ? 1 : elapsed / durationMs;
    rows.push(ping(from[0] + (to[0] - from[0]) * f + noise(), from[1] + (to[1] - from[1]) * f + noise(), startAt + elapsed));
  }
  return rows;
}

function lastOf(rows) {
  return rows[rows.length - 1];
}

function metresBetween([lat1, lng1], row) {
  return geoUtils.calculateDistance(lat1, lng1, row.lat, row.lng);
}

test('returns no sightings and no heading when there is no history', () => {
  assert.deepStrictEqual(buildTrail([], START, options), { sightings: [], heading: null });
});

test('keeps a whole game of history and drops anything older than the window', () => {
  const tooOld = walk({ from: [0, 0], to: [100, 0], startAt: START, durationMs: MINUTE });
  const early = walk({ from: [300, 0], to: [400, 0], startAt: START + 10 * MINUTE, durationMs: MINUTE });
  const recent = walk({ from: [600, 0], to: [700, 0], startAt: START + 60 * MINUTE, durationMs: MINUTE });
  const now = START + 61 * MINUTE + 30 * SECOND;

  const { sightings } = buildTrail([...tooOld, ...early, ...recent], now, options);

  assert.deepStrictEqual(
    sightings.map((s) => [s.start, s.end]),
    [
      [early[0].timestamp, lastOf(early).timestamp],
      [recent[0].timestamp, lastOf(recent).timestamp],
    ],
  );
});

test('starts a new sighting when the runner goes quiet, but not between regular pings', () => {
  // An open app pings at least every 30 seconds even when standing still
  const open = walk({ from: [0, 0], to: [200, 0], startAt: START, durationMs: 4 * MINUTE, everyMs: 30 * SECOND });
  const reopened = walk({ from: [500, 0], to: [600, 0], startAt: lastOf(open).timestamp + options.sightingGapMs + SECOND, durationMs: MINUTE });

  const { sightings } = buildTrail([...open, ...reopened], lastOf(reopened).timestamp, options);

  assert.strictEqual(sightings.length, 2);
});

test('collapses a runner loitering in one spot to where they were last seen', () => {
  const loitering = walk({ from: [0, 0], to: [0, 0], startAt: START, durationMs: 3 * MINUTE, jitter: 8 });

  const { sightings } = buildTrail(loitering, lastOf(loitering).timestamp, options);

  assert.strictEqual(sightings.length, 1);
  assert.strictEqual(sightings[0].points.length, 1);
  assert.ok(metresBetween(sightings[0].points[0], lastOf(loitering)) < 2);
});

test('keeps a long winding sighting within the point budget, from where it started to where it ended', () => {
  const zigzag = [];
  for (let leg = 0; leg < 8; leg++) {
    const startAt = START + leg * MINUTE;
    const east = leg * 80;
    zigzag.push(...walk({ from: [east, leg % 2 ? 150 : 0], to: [east + 80, leg % 2 ? 0 : 150], startAt, durationMs: MINUTE - 3 * SECOND, jitter: 4, seed: leg + 1 }));
  }

  const { sightings } = buildTrail(zigzag, lastOf(zigzag).timestamp, options);
  const points = sightings[0].points;

  assert.strictEqual(sightings.length, 1);
  assert.ok(points.length >= 2 && points.length <= options.maxPointsPerSighting, `got ${points.length} points`);
  assert.ok(metresBetween(points[0], zigzag[0]) < 2);
  assert.ok(metresBetween(points[points.length - 1], lastOf(zigzag)) < 2);
});

test('keeps the corner when a runner turns', () => {
  const north = walk({ from: [0, 0], to: [0, 200], startAt: START, durationMs: 2 * MINUTE, jitter: 3 });
  const east = walk({ from: [0, 200], to: [200, 200], startAt: lastOf(north).timestamp + 3 * SECOND, durationMs: 2 * MINUTE, jitter: 3, seed: 2 });

  const { sightings } = buildTrail([...north, ...east], lastOf(east).timestamp, options);
  const corner = ping(0, 200, 0);

  assert.ok(
    sightings[0].points.some((point) => metresBetween(point, corner) < 25),
    `no point near the corner in ${JSON.stringify(sightings[0].points)}`,
  );
});

test('points the direction arrow the way the runner is walking', () => {
  const heading = (from, to) => buildTrail(walk({ from, to, startAt: START, durationMs: MINUTE, jitter: 3 }), START + MINUTE, options).heading;

  assert.ok(Math.abs(heading([0, 0], [80, 0]) - 90) <= 10);
  assert.ok(Math.abs(heading([0, 0], [0, -80]) - 180) <= 10);
});

test('shows no direction arrow while the runner stands still', () => {
  const loitering = walk({ from: [0, 0], to: [0, 0], startAt: START, durationMs: 3 * MINUTE, jitter: 8 });

  assert.strictEqual(buildTrail(loitering, lastOf(loitering).timestamp, options).heading, null);
});

test('shows no direction arrow when the movement was too slow to be a real heading', () => {
  const drifting = walk({ from: [0, 0], to: [45, 0], startAt: START, durationMs: 6 * MINUTE, everyMs: 30 * SECOND });

  assert.strictEqual(buildTrail(drifting, lastOf(drifting).timestamp, options).heading, null);
});

test('takes the direction from the latest sighting only', () => {
  const walking = walk({ from: [0, 0], to: [300, 0], startAt: START, durationMs: 3 * MINUTE });
  const hiding = walk({ from: [300, 50], to: [300, 50], startAt: START + 10 * MINUTE, durationMs: MINUTE, jitter: 5 });

  assert.strictEqual(buildTrail([...walking, ...hiding], lastOf(hiding).timestamp, options).heading, null);
});

test('accepts history in any order', () => {
  const rows = walk({ from: [0, 0], to: [200, 100], startAt: START, durationMs: 3 * MINUTE, jitter: 4 });
  const now = lastOf(rows).timestamp;

  assert.deepStrictEqual(buildTrail([...rows].reverse(), now, options), buildTrail(rows, now, options));
});

test('sends coordinates as compact [lat, lng] pairs rounded to about a metre', () => {
  const rows = walk({ from: [0, 0], to: [200, 0], startAt: START, durationMs: 2 * MINUTE });

  for (const [lat, lng] of buildTrail(rows, lastOf(rows).timestamp, options).sightings[0].points) {
    assert.strictEqual(lat, Number(lat.toFixed(5)));
    assert.strictEqual(lng, Number(lng.toFixed(5)));
  }
});

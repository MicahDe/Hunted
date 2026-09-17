/**
 * Runner trail building for HUNTED Game
 *
 * Runners only ping while their app is open, so their location history is a
 * series of short "sightings" separated by gaps where the route is unknown.
 * Each sighting is collapsed to a handful of points so other players see the
 * overall path (and which way the runner is heading) without every GPS ping.
 */

const geoUtils = require("./geoUtils");

// Metres per degree of latitude on a spherical Earth
const METERS_PER_DEGREE = 111195;

// 5 decimal places is ~1m, which keeps the payload small
const COORDINATE_DECIMALS = 5;

/**
 * Build a runner's trail from their stored location history
 * @param {Array<{lat: number, lng: number, timestamp: number}>} rows - Location history, in any order
 * @param {number} now - Current time in milliseconds
 * @param {Object} options - Trail settings (see config.game.trail)
 * @returns {{sightings: Array<{start: number, end: number, points: Array<[number, number]>}>, heading: number|null}}
 *   Sightings oldest first, each with 1 to maxPointsPerSighting [lat, lng] points, plus the bearing
 *   (0-359) the runner was last moving in, or null if they weren't moving
 */
function buildTrail(rows, now, options) {
  const { windowMs, sightingGapMs, minStepMeters, simplifyToleranceMeters, maxPointsPerSighting, headingMinDistanceMeters, headingMaxAgeMs } = options;

  const points = rows.filter((row) => row.timestamp > now - windowMs).sort((a, b) => a.timestamp - b.timestamp);

  // Split into sightings wherever the runner went quiet
  const groups = [];
  for (const point of points) {
    const group = groups[groups.length - 1];
    if (!group || point.timestamp - group[group.length - 1].timestamp > sightingGapMs) {
      groups.push([point]);
    } else {
      group.push(point);
    }
  }

  const sightings = groups.map((group) => ({
    start: group[0].timestamp,
    end: group[group.length - 1].timestamp,
    points: simplify(thin(group, minStepMeters), simplifyToleranceMeters, maxPointsPerSighting).map(roundPoint),
  }));

  const latest = groups[groups.length - 1];
  const heading = latest ? calculateHeading(latest, headingMinDistanceMeters, headingMaxAgeMs) : null;

  return { sightings, heading };
}

// Drop pings within minStepMeters of the last kept one, which collapses GPS jitter and loitering.
// The final ping is always kept because it is where the runner was last seen.
function thin(points, minStepMeters) {
  const last = points[points.length - 1];
  if (points.length === 1) return [last];

  const kept = [points[0]];
  for (const point of points.slice(1, -1)) {
    if (distance(point, kept[kept.length - 1]) >= minStepMeters) {
      kept.push(point);
    }
  }

  if (distance(last, kept[kept.length - 1]) >= minStepMeters) {
    kept.push(last);
  } else if (kept.length > 1) {
    kept[kept.length - 1] = last;
  } else {
    // Never moved far from where the sighting started
    return [last];
  }

  return kept;
}

// Douglas-Peucker simplification that refines the worst-fitting segment first,
// so it can also stop once it reaches the point budget
function simplify(points, toleranceMeters, maxPoints) {
  if (points.length <= 2) return points;

  const keep = [0, points.length - 1];

  while (keep.length < maxPoints) {
    let worst = null;

    for (let i = 0; i < keep.length - 1; i++) {
      const from = keep[i];
      const to = keep[i + 1];

      for (let j = from + 1; j < to; j++) {
        const offset = distanceFromSegment(points[j], points[from], points[to]);
        if (!worst || offset > worst.offset) {
          worst = { index: j, offset };
        }
      }
    }

    if (!worst || worst.offset <= toleranceMeters) break;

    keep.push(worst.index);
    keep.sort((a, b) => a - b);
  }

  return keep.map((index) => points[index]);
}

// Bearing over the most recent stretch of real movement, or null if the runner hasn't moved
function calculateHeading(points, minDistanceMeters, maxAgeMs) {
  const last = points[points.length - 1];

  for (let i = points.length - 2; i >= 0; i--) {
    const earlier = points[i];
    if (last.timestamp - earlier.timestamp > maxAgeMs) break;

    if (distance(earlier, last) >= minDistanceMeters) {
      return Math.round(geoUtils.calculateBearing(earlier.lat, earlier.lng, last.lat, last.lng)) % 360;
    }
  }

  return null;
}

function distance(a, b) {
  return geoUtils.calculateDistance(a.lat, a.lng, b.lat, b.lng);
}

// Shortest distance in metres from a point to the segment between two others.
// Uses a flat projection, which is accurate over the few hundred metres a sighting covers.
function distanceFromSegment(point, from, to) {
  const p = toLocalMeters(point, from);
  const end = toLocalMeters(to, from);
  const lengthSquared = end.x * end.x + end.y * end.y;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (p.x * end.x + p.y * end.y) / lengthSquared));

  return Math.hypot(p.x - t * end.x, p.y - t * end.y);
}

function toLocalMeters(point, origin) {
  return {
    x: (point.lng - origin.lng) * METERS_PER_DEGREE * Math.cos((origin.lat * Math.PI) / 180),
    y: (point.lat - origin.lat) * METERS_PER_DEGREE,
  };
}

function roundPoint(point) {
  return [Number(point.lat.toFixed(COORDINATE_DECIMALS)), Number(point.lng.toFixed(COORDINATE_DECIMALS))];
}

module.exports = {
  buildTrail,
};

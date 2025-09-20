/**
 * Utility functions for geographic calculations
 */

// Earth radius in meters
const EARTH_RADIUS = 6371000;

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - Latitude of first point in degrees
 * @param {number} lng1 - Longitude of first point in degrees
 * @param {number} lat2 - Latitude of second point in degrees
 * @param {number} lng2 - Longitude of second point in degrees
 * @returns {number} Distance in meters
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
  // Convert to radians
  const rlat1 = (lat1 * Math.PI) / 180;
  const rlng1 = (lng1 * Math.PI) / 180;
  const rlat2 = (lat2 * Math.PI) / 180;
  const rlng2 = (lng2 * Math.PI) / 180;

  // Haversine formula
  const dLat = rlat2 - rlat1;
  const dLng = rlng2 - rlng1;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rlat1) * Math.cos(rlat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = EARTH_RADIUS * c;

  return distance;
}

/**
 * Generate random coordinates within specified radius
 * @param {number} centerLat - Center latitude in degrees
 * @param {number} centerLng - Center longitude in degrees
 * @param {number} radius - Radius in meters
 * @returns {Object} Object with lat and lng properties
 */
function generateRandomPoint(centerLat, centerLng, radius) {
  // Convert radius from meters to degrees
  const radiusInDegrees = radius / 111000;

  // Generate random angle in radians
  const u = Math.random();
  const v = Math.random();
  const w = radiusInDegrees * Math.sqrt(u);
  const t = 2 * Math.PI * v;
  const x = w * Math.cos(t);
  const y = w * Math.sin(t);

  // Adjust the x-coordinate for the shrinking of the east-west distances
  const new_x = x / Math.cos(centerLat * (Math.PI / 180));

  // Calculate new position
  const newLat = centerLat + y;
  const newLng = centerLng + new_x;

  return {
    lat: newLat,
    lng: newLng,
  };
}

/**
 * Generate random offset for inner circle within outer circle
 * @param {number} centerLat - Center latitude of outer circle in degrees
 * @param {number} centerLng - Center longitude of outer circle in degrees
 * @param {number} outerRadius - Radius of outer circle in meters
 * @param {number} innerRadius - Radius of inner circle in meters
 * @returns {Object} Object with offsetLat and offsetLng properties
 */
function generateRandomOffset(centerLat, centerLng, outerRadius, innerRadius) {
  // Maximum allowed offset to keep inner circle completely within outer circle
  const maxOffset = outerRadius - innerRadius;

  // Generate random distance within max offset
  const offsetDistance = Math.random() * maxOffset;

  // Generate random angle
  const angle = Math.random() * 2 * Math.PI;

  // Calculate offset in lat/lng
  const latOffset = (offsetDistance / EARTH_RADIUS) * (180 / Math.PI);
  const lngOffset = (offsetDistance / (EARTH_RADIUS * Math.cos((centerLat * Math.PI) / 180))) * (180 / Math.PI);

  // Calculate new center point
  const offsetLat = centerLat + latOffset * Math.cos(angle);
  const offsetLng = centerLng + lngOffset * Math.sin(angle);

  return {
    offsetLat,
    offsetLng,
  };
}

/**
 * Generate multiple target points within a play area
 * @param {number} centerLat - Center latitude of play area in degrees
 * @param {number} centerLng - Center longitude of play area in degrees
 * @param {number} playAreaRadius - Radius of play area in meters
 * @param {number} count - Number of targets to generate
 * @returns {Array} Array of objects with lat, lng properties
 */
function generateTargets(centerLat, centerLng, playAreaRadius, count) {
  const targets = [];

  for (let i = 0; i < count; i++) {
    // Generate random point within play area
    const target = generateRandomPoint(centerLat, centerLng, playAreaRadius);
    targets.push(target);
  }

  return targets;
}

/**
 * Check if point is within circle
 * @param {number} pointLat - Point latitude in degrees
 * @param {number} pointLng - Point longitude in degrees
 * @param {number} circleLat - Circle center latitude in degrees
 * @param {number} circleLng - Circle center longitude in degrees
 * @param {number} radius - Circle radius in meters
 * @returns {boolean} True if point is within circle
 */
function isPointInCircle(pointLat, pointLng, circleLat, circleLng, radius) {
  const distance = calculateDistance(pointLat, pointLng, circleLat, circleLng);
  return distance <= radius;
}

/**
 * Calculate bearing between two points
 * @param {number} lat1 - Latitude of first point in degrees
 * @param {number} lng1 - Longitude of first point in degrees
 * @param {number} lat2 - Latitude of second point in degrees
 * @param {number} lng2 - Longitude of second point in degrees
 * @returns {number} Bearing in degrees (0-360)
 */
function calculateBearing(lat1, lng1, lat2, lng2) {
  // Convert to radians
  const rlat1 = (lat1 * Math.PI) / 180;
  const rlng1 = (lng1 * Math.PI) / 180;
  const rlat2 = (lat2 * Math.PI) / 180;
  const rlng2 = (lng2 * Math.PI) / 180;

  // Calculate bearing
  const y = Math.sin(rlng2 - rlng1) * Math.cos(rlat2);
  const x = Math.cos(rlat1) * Math.sin(rlat2) - Math.sin(rlat1) * Math.cos(rlat2) * Math.cos(rlng2 - rlng1);
  let bearing = (Math.atan2(y, x) * 180) / Math.PI;

  // Normalize to 0-360
  bearing = (bearing + 360) % 360;

  return bearing;
}

/**
 * Calculate destination point given starting point, bearing and distance
 * @param {number} lat - Starting latitude in degrees
 * @param {number} lng - Starting longitude in degrees
 * @param {number} bearing - Bearing in degrees (0-360)
 * @param {number} distance - Distance in meters
 * @returns {Object} Object with lat and lng properties of destination point
 */
function calculateDestination(lat, lng, bearing, distance) {
  // Convert to radians
  const rlat = (lat * Math.PI) / 180;
  const rlng = (lng * Math.PI) / 180;
  const rbearing = (bearing * Math.PI) / 180;

  // Angular distance
  const angularDistance = distance / EARTH_RADIUS;

  // Calculate destination latitude
  const rlat2 = Math.asin(Math.sin(rlat) * Math.cos(angularDistance) + Math.cos(rlat) * Math.sin(angularDistance) * Math.cos(rbearing));

  // Calculate destination longitude
  const rlng2 = rlng + Math.atan2(Math.sin(rbearing) * Math.sin(angularDistance) * Math.cos(rlat), Math.cos(angularDistance) - Math.sin(rlat) * Math.sin(rlat2));

  // Convert back to degrees
  const lat2 = (rlat2 * 180) / Math.PI;
  const lng2 = (rlng2 * 180) / Math.PI;

  return {
    lat: lat2,
    lng: lng2,
  };
}

/**
 * Calculate position for an internally tangent circle
 * @param {number} outerRadius - Radius of outer circle in meters
 * @param {number} innerRadius - Radius of inner circle in meters
 * @param {number} innerLat - Latitude of inner circle center in degrees
 * @param {number} innerLng - Longitude of inner circle center in degrees
 * @returns {Object} Object with lat and lng properties of outer circle center
 */
function calculateInternallyTangentCirclePosition(outerRadius, innerRadius, innerLat, innerLng) {
  // Calculate the distance between centers (difference of radii for internally tangent circles)
  const distanceBetweenCenters = outerRadius - innerRadius;

  // Create a hash by combining the values of lat, lng and innerRadius
  const hashValue = innerLat * 1000000 + innerLng * 10000 + innerRadius;
  // Use a simple transformative function to generate an angle between 0 and 2π
  const deterministicAngle = ((hashValue * 9973) % 628) / 100; // 9973 is a prime number, mod 628 then divide by 100 to get 0-6.28

  // Calculate the new position
  const outerLat = innerLat + (distanceBetweenCenters * Math.sin(deterministicAngle)) / 111320; // Approx meters per degree latitude
  const outerLng = innerLng + (distanceBetweenCenters * Math.cos(deterministicAngle)) / (111320 * Math.cos((innerLat * Math.PI) / 180)); // Adjust for longitude

  return { lat: outerLat, lng: outerLng };
}

/**
 * Generate positions for nested internally tangent circles
 * @param {number} targetLat - Latitude of target (innermost circle) in degrees
 * @param {number} targetLng - Longitude of target (innermost circle) in degrees
 * @param {Array} radiusLevels - Array of radius levels in meters, from smallest to largest
 * @returns {Array} Array of objects with lat, lng, and radius properties
 */
function generateNestedCirclePositions(targetLat, targetLng, radiusLevels) {
  // Sort radius levels in ascending order (smallest to largest)
  const sortedRadii = [...radiusLevels].sort((a, b) => a - b);

  // Initialize with the smallest circle at the target location
  const positions = [
    {
      lat: targetLat,
      lng: targetLng,
      radius: sortedRadii[0],
    },
  ];

  // Generate positions for larger circles
  for (let i = 1; i < sortedRadii.length; i++) {
    const innerCircle = positions[i - 1];
    const newPosition = calculateInternallyTangentCirclePosition(sortedRadii[i], innerCircle.radius, innerCircle.lat, innerCircle.lng);

    positions.push({
      lat: newPosition.lat,
      lng: newPosition.lng,
      radius: sortedRadii[i],
    });
  }

  return positions;
}

/**
 * Check if a player is within any of the nested target circles
 * @param {number} playerLat - Player latitude in degrees
 * @param {number} playerLng - Player longitude in degrees
 * @param {number} targetLat - Target latitude in degrees
 * @param {number} targetLng - Target longitude in degrees
 * @param {number} targetRadius - Current target radius level in meters
 * @param {Array} radiusLevels - Array of all possible radius levels in meters
 * @returns {boolean} True if player is within any of the nested circles
 */
function isPlayerInNestedTargetArea(playerLat, playerLng, targetLat, targetLng, targetRadius, radiusLevels) {
  // Filter radius levels to only include those less than or equal to the current target radius
  const activeRadiusLevels = radiusLevels.filter((r) => r <= targetRadius);

  // Generate positions for all nested circles
  const circlePositions = generateNestedCirclePositions(targetLat, targetLng, activeRadiusLevels);

  // Check if player is within any of the circles
  for (const position of circlePositions) {
    const distanceToCircle = calculateDistance(playerLat, playerLng, position.lat, position.lng);
    if (distanceToCircle <= position.radius) {
      return true;
    }
  }

  return false;
}

if (typeof module !== "undefined" && module.exports) {
  // Node.js environment
  module.exports = {
    calculateDistance,
    generateRandomPoint,
    generateRandomOffset,
    generateTargets,
    isPointInCircle,
    calculateBearing,
    calculateDestination,
    calculateInternallyTangentCirclePosition,
    generateNestedCirclePositions,
    isPlayerInNestedTargetArea,
  };
} else if (typeof window !== "undefined") {
  // Browser environment
  window.geoUtils = {
    calculateDistance,
    generateRandomPoint,
    generateRandomOffset,
    generateTargets,
    isPointInCircle,
    calculateBearing,
    calculateDestination,
    calculateInternallyTangentCirclePosition,
    generateNestedCirclePositions,
    isPlayerInNestedTargetArea,
  };
}

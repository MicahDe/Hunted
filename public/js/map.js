/**
 * Map Utilities for HUNTED Game
 * Uses Leaflet.js with OpenStreetMap
 */

const GameMap = {
  // Map instances
  setupMap: null, // Map for room setup
  gameMap: null, // Map for gameplay

  // Map markers and features
  playerMarker: null,
  selectedLocationMarker: null,
  runnerMarkers: {},
  targetMarkers: {},
  targetCircles: {},
  boundaryCircle: null,

  // Store current location
  currentLocation: null,
  selectedLocation: null,

  // Watch position ID
  watchPositionId: null,

  // Map icons
  icons: {
    hunter: null,
    runner: null,
    target: null,
    player: null,
  },

  // Initialize maps
  init: function () {
    // Create custom icons
    this.createIcons();
  },

  // Create custom icons for map markers
  createIcons: function () {
    // Player icon is customized based on current location
    this.icons.player = L.divIcon({
      className: "map-marker-player",
      html: `<div class="map-marker-player-inner"></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    // Hunter icon
    this.icons.hunter = L.divIcon({
      className: "map-marker-hunter",
      html: `<img src="assets/icons/hunter.svg" alt="Hunter">`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });

    // Runner icon
    this.icons.runner = L.divIcon({
      className: "map-marker-runner",
      html: `<img src="assets/icons/runner.svg" alt="Runner">`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });

    // Target icon
    this.icons.target = L.divIcon({
      className: "map-marker-target",
      html: `<img src="assets/icons/target.svg" alt="Target">`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });
  },

  // Initialize the setup map
  initSetupMap: function () {
    // Get map container
    const mapContainer = document.getElementById("setup-map");
    if (!mapContainer) return;

    // If map already exists, remove it
    if (this.setupMap) {
      this.setupMap.remove();
      this.setupMap = null;
    }

    // Create map with default view (will be updated with current location)
    this.setupMap = L.map("setup-map", {
      zoomControl: false,
      attributionControl: false,
    }).setView([40.7128, -74.006], 13); // Default view (NYC) to ensure map renders

    // Add OpenStreetMap tiles
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.setupMap);

    // Add zoom control to top right
    L.control
      .zoom({
        position: "topright",
      })
      .addTo(this.setupMap);

    // Add attribution control
    L.control
      .attribution({
        position: "bottomright",
      })
      .addTo(this.setupMap);

    // Force map to update its size (important when map container was initially hidden)
    setTimeout(() => {
      this.setupMap.invalidateSize();
    }, 100);

    // Get current location and center map
    this.getCurrentLocation(
      (position) => {
        const { latitude, longitude } = position.coords;

        // Set view to current location
        this.setupMap.setView([latitude, longitude], 13);

        // Add marker for current location
        if (this.selectedLocationMarker) {
          this.setupMap.removeLayer(this.selectedLocationMarker);
        }

        this.selectedLocationMarker = L.marker([latitude, longitude], {
          draggable: false,
        }).addTo(this.setupMap);

        // Store selected location
        this.selectedLocation = {
          lat: latitude,
          lng: longitude,
        };

        // Update selected location display
        this.updateSelectedLocationDisplay();
      },
      (error) => {
        // Handle errors by showing a default view
        console.error("Error getting location for setup map:", error);
        // Default location is already set, just make sure we have a marker
        this.selectedLocation = {
          lat: 40.7128,
          lng: -74.006,
        };

        this.selectedLocationMarker = L.marker([40.7128, -74.006], {
          draggable: false,
        }).addTo(this.setupMap);

        this.updateSelectedLocationDisplay();
        UI.showNotification(
          "Could not get your location. Please click on the map to set a starting point.",
          "warning"
        );
      }
    );

    // Handle map clicks for selecting location
    this.setupMap.on("click", (e) => {
      const { lat, lng } = e.latlng;

      // Update marker position
      if (this.selectedLocationMarker) {
        this.selectedLocationMarker.setLatLng([lat, lng]);
      } else {
        this.selectedLocationMarker = L.marker([lat, lng], {
          draggable: false,
        }).addTo(this.setupMap);
      }

      // Store selected location
      this.selectedLocation = {
        lat: lat,
        lng: lng,
      };

      // Update selected location display
      this.updateSelectedLocationDisplay();
    });
  },

  // Update selected location display
  updateSelectedLocationDisplay: function () {
    const locationDisplay = document.getElementById("selected-location");
    if (!locationDisplay) return;

    if (this.selectedLocation) {
      locationDisplay.textContent = `Lat: ${this.selectedLocation.lat.toFixed(
        6
      )}, Lng: ${this.selectedLocation.lng.toFixed(6)}`;
    } else {
      locationDisplay.textContent = "";
    }
  },

  // Get selected location
  getSelectedLocation: function () {
    return this.selectedLocation;
  },

  // Initialize the game map
  initGameMap: function (centerLat, centerLng, boundaries) {
    // Get map container
    const mapContainer = document.getElementById("game-map");
    if (!mapContainer) return;

    // If map already exists, remove it
    if (this.gameMap) {
      this.gameMap.remove();
      this.gameMap = null;
    }

    // Clear all markers and features
    this.playerMarker = null;
    this.runnerMarkers = {};
    this.targetMarkers = {};
    this.targetCircles = {};
    this.boundaryCircle = null;

    // Create map
    this.gameMap = L.map("game-map", {
      zoomControl: false,
    });

    // Add OpenStreetMap tiles
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.gameMap);

    // Add zoom control to top right
    L.control
      .zoom({
        position: "topright",
      })
      .addTo(this.gameMap);

    // Set default view based on provided center
    this.gameMap.setView([centerLat, centerLng], 14);

    // Add game boundary circle (5km radius)
    this.boundaryCircle = L.circle([centerLat, centerLng], {
      radius: 5000,
      color: "#2a3990",
      fillColor: "#2a3990",
      fillOpacity: 0.1,
      weight: 2,
      dashArray: "5, 10",
    }).addTo(this.gameMap);

    // Start tracking player location
    this.startLocationTracking();
  },

  // Start tracking player location
  startLocationTracking: function () {
    // First get initial position
    this.getCurrentLocation((position) => {
      this.updatePlayerLocation(position);

      // Then start watching position
      this.watchPositionId = navigator.geolocation.watchPosition(
        this.updatePlayerLocation.bind(this),
        this.handleLocationError.bind(this),
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 5000,
        }
      );
    });
  },

  // Stop tracking player location
  stopLocationTracking: function () {
    if (this.watchPositionId) {
      navigator.geolocation.clearWatch(this.watchPositionId);
      this.watchPositionId = null;
    }
  },

  // Get current location (one-time)
  getCurrentLocation: function (callback, errorCallback) {
    if ("geolocation" in navigator) {
      // Add a timeout to handle slow geolocation responses
      const locationTimeout = setTimeout(() => {
        UI.showNotification(
          "Location request is taking longer than expected. You can click the map to set a location manually.",
          "info"
        );
      }, 3000);

      navigator.geolocation.getCurrentPosition(
        (position) => {
          clearTimeout(locationTimeout);
          callback(position);
        },
        (error) => {
          clearTimeout(locationTimeout);
          if (errorCallback) {
            errorCallback(error);
          } else {
            this.handleLocationError(error);
          }
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 10000, // Increased timeout to 10 seconds
        }
      );
    } else {
      UI.showNotification(
        "Geolocation is not supported by your browser. Please click on the map to set a location.",
        "error"
      );
      if (errorCallback) {
        errorCallback(new Error("Geolocation not supported"));
      }
    }
  },

  // Initialize the lobby map
  initLobbyMap: function (centerLat, centerLng) {
    console.log(
      "Initializing lobby map with coordinates:",
      centerLat,
      centerLng
    );

    // Get map container
    const mapContainer = document.getElementById("lobby-map");
    if (!mapContainer) {
      console.error("Lobby map container not found!");
      return;
    }

    // If map already exists, remove it
    if (this.lobbyMap) {
      this.lobbyMap.remove();
      this.lobbyMap = null;
    }

    // Ensure the container is visible and has dimensions
    if (mapContainer.offsetHeight === 0) {
      console.warn("Lobby map container has zero height!");
      mapContainer.style.height = "180px"; // Force height if not set
    }

    // Create map with default view first
    this.lobbyMap = L.map("lobby-map", {
      zoomControl: false,
      attributionControl: true,
    }).setView([40.7128, -74.006], 11); // Default view to ensure initialization

    // Add OpenStreetMap tiles
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.lobbyMap);

    // Force map to update size
    this.lobbyMap.invalidateSize();

    // Now set the correct view
    this.lobbyMap.setView([centerLat, centerLng], 11);

    // Add center marker
    L.marker([centerLat, centerLng]).addTo(this.lobbyMap);

    // Add game boundary circle (5km radius)
    L.circle([centerLat, centerLng], {
      radius: 5000,
      color: "#2a3990",
      fillColor: "#2a3990",
      fillOpacity: 0.1,
      weight: 2,
      dashArray: "5, 10",
    }).addTo(this.lobbyMap);

    // Disable interactions for simplicity
    this.lobbyMap.dragging.disable();
    this.lobbyMap.touchZoom.disable();
    this.lobbyMap.doubleClickZoom.disable();
    this.lobbyMap.scrollWheelZoom.disable();

    // Force map to update size again after a delay
    setTimeout(() => {
      this.lobbyMap.invalidateSize();
    }, 300);
  },

  // Update player's location on map
  updatePlayerLocation: function (position) {
    if (!this.gameMap) return;

    const { latitude, longitude, accuracy } = position.coords;

    // Store current location
    this.currentLocation = {
      lat: latitude,
      lng: longitude,
      accuracy: accuracy,
    };

    // Check if player marker exists
    if (this.playerMarker) {
      // Update marker position
      this.playerMarker.setLatLng([latitude, longitude]);
    } else {
      // Create player marker
      this.playerMarker = L.marker([latitude, longitude], {
        icon: this.icons.player,
        zIndexOffset: 1000, // Make sure player is on top
      }).addTo(this.gameMap);

      // Add accuracy circle
      this.playerAccuracyCircle = L.circle([latitude, longitude], {
        radius: accuracy,
        color: "#4cc9f0",
        fillColor: "#4cc9f0",
        fillOpacity: 0.2,
        weight: 1,
      }).addTo(this.gameMap);

      // Center map on player
      this.gameMap.setView([latitude, longitude], 16);
    }

    // Update accuracy circle
    if (this.playerAccuracyCircle) {
      this.playerAccuracyCircle.setLatLng([latitude, longitude]);
      this.playerAccuracyCircle.setRadius(accuracy);
    }

    // If player is a runner, check for targets
    if (gameState.team === "runner") {
      Game.checkTargetProximity(latitude, longitude);
    }

    // Emit location update to server
    Game.emitLocationUpdate(latitude, longitude);
  },

  // Handle location errors
  handleLocationError: function (error) {
    console.error("Geolocation error:", error);

    let message;
    switch (error.code) {
      case error.PERMISSION_DENIED:
        message =
          "Location access was denied. Please enable location services for this game.";
        break;
      case error.POSITION_UNAVAILABLE:
        message =
          "Location information is unavailable. Please check your GPS signal.";
        break;
      case error.TIMEOUT:
        message = "Location request timed out. Please try again.";
        break;
      default:
        message = "An unknown error occurred while getting location.";
    }

    UI.showNotification(message, "error");
  },

  // Center map on player
  centerOnPlayer: function () {
    if (!this.gameMap || !this.currentLocation) return;

    this.gameMap.setView(
      [this.currentLocation.lat, this.currentLocation.lng],
      16
    );
  },

  // Update runner location on map (for hunters)
  updateRunnerLocation: function (data) {
    if (!this.gameMap || gameState.team !== "hunter") return;

    const { playerId, username, lat, lng, timestamp } = data;

    // Check if marker exists
    if (this.runnerMarkers[playerId]) {
      // Update marker position
      this.runnerMarkers[playerId].setLatLng([lat, lng]);

      // Update popup content
      const popupContent = `
              <div class="map-player-popup map-player-popup-runner">
                  <strong>${username}</strong><br>
                  Last seen: ${this.formatTimestamp(timestamp)}
              </div>
          `;
      this.runnerMarkers[playerId].getPopup().setContent(popupContent);
    } else {
      // Create new marker
      this.runnerMarkers[playerId] = L.marker([lat, lng], {
        icon: this.icons.runner,
      }).addTo(this.gameMap);

      // Add popup
      const popupContent = `
              <div class="map-player-popup map-player-popup-runner">
                  <strong>${username}</strong><br>
                  Last seen: ${this.formatTimestamp(timestamp)}
              </div>
          `;
      this.runnerMarkers[playerId].bindPopup(popupContent);
    }
  },

  // Update targets on map
  updateTargets: function (targets, playerTeam) {
    if (!this.gameMap) return;

    // Keep track of existing targets
    const existingTargetIds = Object.keys(this.targetMarkers);
    const updatedTargetIds = [];

    // Process each target
    targets.forEach((target) => {
      // Add to updated list
      updatedTargetIds.push(target.targetId);

      // For runners, only show targets that are not reached
      // For hunters, don't show targets at all
      if (
        playerTeam === "hunter" ||
        (target.reachedBy && target.reachedBy !== gameState.playerId)
      ) {
        return;
      }

      // Check if target marker exists
      if (this.targetMarkers[target.targetId]) {
        // Update marker position
        this.targetMarkers[target.targetId].setLatLng([
          target.location.lat,
          target.location.lng,
        ]);
      } else {
        // Only create marker for runner
        if (playerTeam === "runner") {
          // Create new marker
          this.targetMarkers[target.targetId] = L.marker(
            [target.location.lat, target.location.lng],
            {
              icon: this.icons.target,
            }
          ).addTo(this.gameMap);

          // Add popup
          const popupContent = `
                      <div class="map-player-popup">
                          <strong>Target</strong><br>
                          Points: ${target.pointsValue}
                      </div>
                  `;
          this.targetMarkers[target.targetId].bindPopup(popupContent);
        }
      }

      // Check if target circle exists
      if (this.targetCircles[target.targetId]) {
        // Update circle position and radius
        this.targetCircles[target.targetId].setLatLng([
          target.location.lat,
          target.location.lng,
        ]);
        this.targetCircles[target.targetId].setRadius(target.radiusLevel);
      } else {
        // Only create circle for runner
        if (playerTeam === "runner") {
          // Create new circle
          this.targetCircles[target.targetId] = L.circle(
            [target.location.lat, target.location.lng],
            {
              radius: target.radiusLevel,
              color: "#ef7d54",
              fillColor: "#ef7d54",
              fillOpacity: 0.1,
              weight: 2,
              dashArray: "5, 5",
              className: "map-circle-target",
            }
          ).addTo(this.gameMap);
        }
      }
    });

    // Remove targets that are no longer active
    existingTargetIds.forEach((targetId) => {
      if (!updatedTargetIds.includes(targetId)) {
        // Remove marker and circle
        if (this.targetMarkers[targetId]) {
          this.gameMap.removeLayer(this.targetMarkers[targetId]);
          delete this.targetMarkers[targetId];
        }

        if (this.targetCircles[targetId]) {
          this.gameMap.removeLayer(this.targetCircles[targetId]);
          delete this.targetCircles[targetId];
        }
      }
    });
  },

  // Remove a runner marker
  removeRunnerMarker: function (playerId) {
    if (this.runnerMarkers[playerId]) {
      this.gameMap.removeLayer(this.runnerMarkers[playerId]);
      delete this.runnerMarkers[playerId];
    }
  },

  // Format timestamp relative to now
  formatTimestamp: function (timestamp) {
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 60000) {
      // Less than a minute
      return "Just now";
    } else if (diff < 3600000) {
      // Less than an hour
      const minutes = Math.floor(diff / 60000);
      return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
    } else {
      // Format as time
      const date = new Date(timestamp);
      return date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  },

  // Calculate distance between two points
  calculateDistance: function (lat1, lng1, lat2, lng2) {
    // Haversine formula
    const R = 6371e3; // Earth radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
  },

  // Get closest target and distance to it
  getClosestTargetDistance: function (lat, lng, targets) {
    if (!targets || targets.length === 0) return null;

    let closestDistance = Infinity;

    targets.forEach((target) => {
      // Skip reached targets
      if (target.reachedBy) return;

      const distance = this.calculateDistance(
        lat,
        lng,
        target.location.lat,
        target.location.lng
      );

      if (distance < closestDistance) {
        closestDistance = distance;
      }
    });

    return closestDistance === Infinity ? null : closestDistance;
  },

  // Clean up map resources
  cleanup: function () {
    // Stop location tracking
    this.stopLocationTracking();

    // Clean up maps
    if (this.setupMap) {
      this.setupMap.remove();
      this.setupMap = null;
    }

    if (this.gameMap) {
      this.gameMap.remove();
      this.gameMap = null;
    }

    // Clear all markers and circles
    this.playerMarker = null;
    this.selectedLocationMarker = null;
    this.runnerMarkers = {};
    this.targetMarkers = {};
    this.targetCircles = {};
    this.boundaryCircle = null;
  },
};

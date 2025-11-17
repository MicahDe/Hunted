/**
 * Map Utilities for HUNTED Game
 * Uses Leaflet.js with OpenStreetMap
 */

const GameMap = {
  // Map instances
  setupMap: null, // Map for room setup
  gameMap: null, // Map for gameplay
  lobbyMap: null, // Map for lobby screen

  // Map markers and features
  playerMarker: null,
  playerLabel: null,
  selectedLocationMarker: null,
  runnerMarkers: {},
  runnerLabels: {},
  runnerHistoryMarkers: {},
  runnerHistoryLines: {},
  targetMarkers: {},
  targetCircles: {},
  boundaryCircle: null,

  // Store current location
  currentLocation: null,
  selectedLocation: null,

  // Watch position ID
  watchPositionId: null,

  // Timer for updating labels
  labelUpdateTimer: null,

  // Runner data cache to enable label updates
  runnerDataCache: {},

  // Map icons
  icons: {
    runner: null,
    hunter: null,
    target: null,
    player: null,
    selfLocation: null,
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
      html: `<img src="assets/icons/self-location.svg" alt="Self Location">`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });

    // Runner icon
    this.icons.runner = L.divIcon({
      className: "map-marker-runner",
      html: `<img src="assets/icons/runner.svg" alt="Runner">`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });

    // Hunter icon
    this.icons.hunter = L.divIcon({
      className: "map-marker-hunter",
      html: `<img src="assets/icons/hunter.svg" alt="Hunter">`,
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
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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
        UI.showNotification("Could not get your location. Please click on the map to set a starting point.", "warning");
      },
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
      locationDisplay.textContent = `Lat: ${this.selectedLocation.lat.toFixed(6)}, Lng: ${this.selectedLocation.lng.toFixed(6)}`;
    } else {
      locationDisplay.textContent = "";
    }
  },

  // Get selected location
  getSelectedLocation: function () {
    return this.selectedLocation;
  },

  // Initialize the game map
  initGameMap: function (centerLat, centerLng, playAreaRadius = 5000) {
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
    this.playerLabel = null;
    this.selectedLocationMarker = null;
    this.runnerMarkers = {};
    this.runnerLabels = {};
    this.runnerHistoryMarkers = {};
    this.runnerHistoryLines = {};
    this.targetMarkers = {};
    this.targetCircles = {};
    this.boundaryCircle = null;
    this.runnerDataCache = {};

    // Clear any existing timer
    if (this.labelUpdateTimer) {
      clearInterval(this.labelUpdateTimer);
      this.labelUpdateTimer = null;
    }

    // Create map
    this.gameMap = L.map("game-map", {
      zoomControl: false,
      attributionControl: false,
    });

    // Add OpenStreetMap tiles
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy;<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy;Micah De Silva',
    }).addTo(this.gameMap);

    // Add zoom control to top right
    L.control
      .zoom({
        position: "topright",
      })
      .addTo(this.gameMap);

    // Set default view based on provided center
    this.gameMap.setView([centerLat, centerLng], 14);

    // Add game boundary circle
    if (gameState.team === "hunter") {
      this.boundaryCircle = L.circle([centerLat, centerLng], {
        radius: playAreaRadius,
        color: "#2a3990",
        fillColor: "#ffffff",
        fillOpacity: 0.1,
        weight: 2,
        dashArray: "5, 10",
      }).addTo(this.gameMap);
    }

    // Start tracking player location
    this.startLocationTracking();

    // Start timer to update runner labels
    this.startLabelUpdateTimer();
  },

  // Start tracking player location
  startLocationTracking: function () {
    // First get initial position
    this.getCurrentLocation((position) => {
      this.updatePlayerLocation(position);

      // Then start watching position
      this.watchPositionId = navigator.geolocation.watchPosition(this.updatePlayerLocation.bind(this), this.handleLocationError.bind(this), {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 5000,
      });
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
        UI.showNotification("Location request is taking longer than expected. You can click the map to set a location manually.", "info");
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
        },
      );
    } else {
      UI.showNotification("Geolocation is not supported by your browser. Please click on the map to set a location.", "error");
      if (errorCallback) {
        errorCallback(new Error("Geolocation not supported"));
      }
    }
  },

  // Initialize the lobby map
  initLobbyMap: function (centerLat, centerLng, playAreaRadius = 5000) {
    console.log("Initializing lobby map with coordinates:", centerLat, centerLng);

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
      attributionControl: false,
    }).setView([40.7128, -74.006], 11); // Default view to ensure initialization

    // Add OpenStreetMap tiles
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.lobbyMap);

    // Force map to update size
    this.lobbyMap.invalidateSize();

    // Now set the correct view
    this.lobbyMap.setView([centerLat, centerLng], 11);

    // Add center marker
    L.marker([centerLat, centerLng]).addTo(this.lobbyMap);

    // Add game boundary circle
    L.circle([centerLat, centerLng], {
      radius: playAreaRadius,
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
      
      // Update label position
      if (this.playerLabel) {
        this.playerLabel.setLatLng([latitude, longitude]);
      }
    } else {
      // Create player marker
      this.playerMarker = L.marker([latitude, longitude], {
        icon: this.icons.player,
        zIndexOffset: 1000, // Make sure player is on top
      }).addTo(this.gameMap);

      // Create player label beneath the marker
      this.playerLabel = L.marker([latitude, longitude], {
        icon: L.divIcon({
          className: "player-label-container",
          html: `<div class="player-label">You</div>`,
          iconSize: [80, 40],
          iconAnchor: [40, -15],
        }),
        zIndexOffset: 1000,
      }).addTo(this.gameMap);

      // Center map on player
      this.gameMap.setView([latitude, longitude], 16);
    }

    // Update accuracy circle
    /*if (this.playerAccuracyCircle) {
      this.playerAccuracyCircle.setLatLng([latitude, longitude]);
      this.playerAccuracyCircle.setRadius(accuracy);
    }*/

    // Emit location update to server
    Game.emitLocationUpdate(latitude, longitude);
  },

  // Handle location errors
  handleLocationError: function (error) {
    console.error("Geolocation error:", error);

    let message;
    switch (error.code) {
      case error.PERMISSION_DENIED:
        message = "Location access was denied. Please enable location services for this game.";
        break;
      case error.POSITION_UNAVAILABLE:
        message = "Location information is unavailable. Please check your GPS signal.";
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

    this.gameMap.setView([this.currentLocation.lat, this.currentLocation.lng], 16);
  },

  updateOtherPlayerLocation: function (player) {
    if (!this.gameMap) return;
    if (player.playerId === gameState.playerId) return;

    const { playerId, roomId, username, team, status, location, lastPingTime, locationHistory } = player;
    const lat = location?.lat;
    const lng = location?.lng;

    if (!lat || !lng) return;

    // Select icon based on team
    const playerIcon = team === "hunter" ? this.icons.hunter : this.icons.runner;
    const popupClass = team === "hunter" ? "map-player-popup-hunter" : "map-player-popup-runner";

    // Calculate time elapsed since last update
    const currentTime = Date.now();
    const timeElapsed = (currentTime - lastPingTime) / 1000; // in seconds

    // Calculate opacity based on time elapsed (5 mins = 300 seconds)
    // Opacity ranges from 1.0 (fresh) to 0.8 (5 mins old)
    const mainMarkerOpacity = Math.max(0.8, 1 - (timeElapsed / 300) * 0.2);

    // Format the time elapsed for display
    const timeElapsedText = this.formatTimeElapsed(timeElapsed);

    // Check if marker exists
    if (this.runnerMarkers[playerId]) {
      // Update marker position
      this.runnerMarkers[playerId].setLatLng([lat, lng]);

      // Update marker icon (in case team changed)
      this.runnerMarkers[playerId].setIcon(playerIcon);

      // Update marker opacity
      this.runnerMarkers[playerId].setOpacity(mainMarkerOpacity);

      // Ensure marker is on top
      this.runnerMarkers[playerId].setZIndexOffset(1000);

      // Update popup content
      const popupContent = `
              <div class="map-player-popup ${popupClass}">
                  <strong>${username}</strong><br>
                  Last seen: ${timeElapsedText} ago
              </div>
          `;
      this.runnerMarkers[playerId].getPopup().setContent(popupContent);

      // Update label content
      if (this.runnerLabels[playerId]) {
        // Create a new divIcon with updated content
        const updatedIcon = L.divIcon({
          className: "runner-label-container",
          html: `<div class="runner-label">${username}: ${timeElapsedText} ago</div>`,
          iconSize: [100, 40],
          iconAnchor: [50, -15],
        });

        // Set the new icon on the marker
        this.runnerLabels[playerId].setIcon(updatedIcon);
        this.runnerLabels[playerId].setLatLng([lat, lng]);

        // Ensure label is on top
        this.runnerLabels[playerId].setZIndexOffset(1000);
      }
    } else {
      // Create new marker with opacity based on time elapsed
      this.runnerMarkers[playerId] = L.marker([lat, lng], {
        icon: playerIcon,
        opacity: mainMarkerOpacity,
        zIndexOffset: 1000, // Ensure it's on top of history markers
      }).addTo(this.gameMap);

      // Add popup
      const popupContent = `
              <div class="map-player-popup ${popupClass}">
                  <strong>${username}</strong><br>
                  Last seen: ${timeElapsedText} ago
              </div>
          `;
      this.runnerMarkers[playerId].bindPopup(popupContent);

      // Add label beneath the marker
      this.runnerLabels = this.runnerLabels || {};
      this.runnerLabels[playerId] = L.marker([lat, lng], {
        icon: L.divIcon({
          className: "runner-label-container",
          html: `<div class="runner-label">${username}: ${timeElapsedText} ago</div>`,
          iconSize: [100, 40],
          iconAnchor: [50, -15],
        }),
        zIndexOffset: 1000, // Ensure it's on top of history markers
      }).addTo(this.gameMap);
    }

    // Handle historical location trail
    if (locationHistory && locationHistory.length > 0) {
      this.updateRunnerHistoryTrail(playerId, locationHistory, lat, lng, lastPingTime, username);
    }
  },

  // Update runner location on map (for hunters)
  updateRunnerLocation: function (data) {
    // if (!this.gameMap || gameState.team !== "hunter") return;

    // Don't show ourselves
    if (data.playerId === gameState.playerId) return;

    // Handle both old and new data formats
    const playerId = data.playerId;
    const username = data.username;
    const lat = data.lat || data.location?.lat;
    const lng = data.lng || data.location?.lng;
    const timestamp = data.timestamp || data.lastPingTime;
    const locationHistory = data.locationHistory;

    if (!lat || !lng) return;

    // Store data in cache for later updates
    this.runnerDataCache[playerId] = {
      username,
      lat,
      lng,
      timestamp,
      locationHistory,
    };

    // Calculate time elapsed since last update
    const currentTime = Date.now();
    const timeElapsed = (currentTime - timestamp) / 1000; // in seconds

    // Calculate opacity based on time elapsed (5 mins = 300 seconds)
    // Opacity ranges from 1.0 (fresh) to 0.8 (5 mins old)
    const mainMarkerOpacity = Math.max(0.8, 1 - (timeElapsed / 300) * 0.2);

    // Format the time elapsed for display
    const timeElapsedText = this.formatTimeElapsed(timeElapsed);

    // Check if marker exists
    if (this.runnerMarkers[playerId]) {
      // Update marker position
      this.runnerMarkers[playerId].setLatLng([lat, lng]);

      // Update marker opacity
      this.runnerMarkers[playerId].setOpacity(mainMarkerOpacity);

      // Ensure marker is on top
      this.runnerMarkers[playerId].setZIndexOffset(1000);

      // Update popup content
      const popupContent = `
              <div class="map-player-popup map-player-popup-runner">
                  <strong>${username}</strong><br>
                  Last seen: ${timeElapsedText} ago
              </div>
          `;
      this.runnerMarkers[playerId].getPopup().setContent(popupContent);

      // Update label content
      if (this.runnerLabels[playerId]) {
        // Create a new divIcon with updated content
        const updatedIcon = L.divIcon({
          className: "runner-label-container",
          html: `<div class="runner-label">${username}: ${timeElapsedText} ago</div>`,
          iconSize: [100, 40],
          iconAnchor: [50, -15],
        });

        // Set the new icon on the marker
        this.runnerLabels[playerId].setIcon(updatedIcon);
        this.runnerLabels[playerId].setLatLng([lat, lng]);

        // Ensure label is on top
        this.runnerLabels[playerId].setZIndexOffset(1000);
      }
    } else {
      // Create new marker with opacity based on time elapsed
      this.runnerMarkers[playerId] = L.marker([lat, lng], {
        icon: this.icons.runner,
        opacity: mainMarkerOpacity,
        zIndexOffset: 1000, // Ensure it's on top of history markers
      }).addTo(this.gameMap);

      // Add popup
      const popupContent = `
              <div class="map-player-popup map-player-popup-runner">
                  <strong>${username}</strong><br>
                  Last seen: ${timeElapsedText} ago
              </div>
          `;
      this.runnerMarkers[playerId].bindPopup(popupContent);

      // Add label beneath the marker
      this.runnerLabels = this.runnerLabels || {};
      this.runnerLabels[playerId] = L.marker([lat, lng], {
        icon: L.divIcon({
          className: "runner-label-container",
          html: `<div class="runner-label">${username}: ${timeElapsedText} ago</div>`,
          iconSize: [100, 40],
          iconAnchor: [50, -15],
        }),
        zIndexOffset: 1000, // Ensure it's on top of history markers
      }).addTo(this.gameMap);
    }

    // Handle historical location trail
    if (locationHistory && locationHistory.length > 0/* && gameState.team !== "hunter"*/) {
      this.updateRunnerHistoryTrail(playerId, locationHistory, lat, lng, timestamp, username);
    }
  },

  // Update the runner's historical location trail
  updateRunnerHistoryTrail: function (playerId, locationHistory, currentLat, currentLng, currentTimestamp, username) {
    const currentTime = Date.now();

    // Remove old history markers and polylines if they exist
    if (this.runnerHistoryMarkers && this.runnerHistoryMarkers[playerId]) {
      this.runnerHistoryMarkers[playerId].forEach((marker) => {
        this.gameMap.removeLayer(marker);
      });
    }

    if (this.runnerHistoryLines && this.runnerHistoryLines[playerId]) {
      this.gameMap.removeLayer(this.runnerHistoryLines[playerId]);
    }

    // Initialize arrays for this player if they don't exist
    this.runnerHistoryMarkers = this.runnerHistoryMarkers || {};
    this.runnerHistoryLines = this.runnerHistoryLines || {};
    this.runnerHistoryMarkers[playerId] = [];

    // Location history is limited to 20 points from the server
    // Create all points including current location
    const allPoints = [...locationHistory, { lat: currentLat, lng: currentLng, timestamp: currentTimestamp }];

    // Prepare line coordinates and create history markers
    const lineCoordinates = [];

    // Process points from oldest to newest so newer points are added later (and thus on top)
    allPoints.forEach((point, index) => {
      if (index === allPoints.length - 1) return; // Skip current position, already has main marker

      const { lat, lng, timestamp } = point;
      lineCoordinates.push([lat, lng]);

      // Calculate time elapsed for this point (convert to seconds)
      const timeElapsed = (currentTime - timestamp) / 1000;

      // Calculate opacity based on time elapsed (30 mins = 1800 seconds)
      // Opacity ranges from 0.8 (fresh) to 0.4 (30 mins old)
      const opacity = Math.max(0.4, 0.8 - (timeElapsed / 1800) * 0.4);

      // Only create history markers if they're still visible
      if (opacity > 0.05) {
        // Format timestamp for display
        const timeElapsedText = this.formatTimeElapsed(timeElapsed);

        // Create mini runner icon for history point
        const historyIcon = L.divIcon({
          className: "history-marker",
          html: `
            <div class="history-marker-runner" style="opacity: ${opacity}">
              <img src="assets/icons/runner.svg" alt="Runner">
            </div>
            <div class="history-marker-label" style="opacity: ${opacity}">${username}: ${timeElapsedText} ago</div>
          `,
          iconSize: [50, 30],
          iconAnchor: [25, 15],
        });

        // Calculate z-index based on timestamp - newer points get higher z-index
        // Normalize to a reasonable range: 100-500 (Leaflet default z-index for markers is 300)
        const zIndexOffset = Math.floor((timestamp - (currentTime - 1800000)) / 3600);

        // Create marker
        const marker = L.marker([lat, lng], {
          icon: historyIcon,
          opacity: 1, // We control opacity within the icon HTML
          zIndexOffset: zIndexOffset, // Set z-index based on timestamp
        }).addTo(this.gameMap);

        // Add small tooltip with more info
        marker.bindTooltip(`${username}<br>${timeElapsedText} ago`, {
          permanent: false,
          direction: "top",
          opacity: opacity,
        });

        this.runnerHistoryMarkers[playerId].push(marker);
      }
    });

    // Add current location to line
    lineCoordinates.push([currentLat, currentLng]);

    // Create gradient polyline for the history trail
    if (lineCoordinates.length > 1) {
      this.runnerHistoryLines[playerId] = this.createGradientLine(
        lineCoordinates,
        allPoints.map((p) => p.timestamp),
      ).addTo(this.gameMap);
    }
  },

  // Create a polyline with gradient opacity based on timestamp
  createGradientLine: function (coordinates, timestamps) {
    const currentTime = Date.now();

    // Create line segments with varying opacity
    const lineSegments = [];
    for (let i = 0; i < coordinates.length - 1; i++) {
      // Calculate average time elapsed for this segment
      const avgTimestamp = (timestamps[i] + timestamps[i + 1]) / 2;
      const timeElapsed = (currentTime - avgTimestamp) / 1000; // in seconds

      // Calculate opacity based on time elapsed (30 mins = 1800 seconds)
      // Opacity ranges from 0.8 (fresh) to 0.5 (30 mins old)
      const opacity = Math.max(0.5, 0.8 - (timeElapsed / 1800) * 0.3);

      // Only add line segment if it's still above 50% opacity
      if (opacity > 0.5) {
        lineSegments.push({
          coords: [coordinates[i], coordinates[i + 1]],
          opacity: opacity,
          timestamp: avgTimestamp,
        });
      }
    }

    // Sort segments by timestamp so newer lines are added last (and appear on top)
    lineSegments.sort((a, b) => a.timestamp - b.timestamp);

    // Create a feature group to hold all line segments
    const lineGroup = L.featureGroup();

    // Add each line segment with its calculated opacity
    lineSegments.forEach((segment) => {
      const line = L.polyline(segment.coords, {
        color: "#ff6b6b",
        weight: 3,
        opacity: segment.opacity,
        dashArray: "5, 5",
      });

      lineGroup.addLayer(line);
    });

    return lineGroup;
  },

  // Format time elapsed for display
  formatTimeElapsed: function (seconds) {
    if (seconds < 60) {
      return `${Math.floor(seconds)}s`;
    } else if (seconds < 3600) {
      return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    }
  },

  // Update targets on map
  updateTargets: function (targets, playerTeam) {
    if (!this.gameMap) return;
    if (playerTeam === "hunter") {
      console.log("Skipping targets for hunter");
      return;
    }

    console.log("Updating targets for player team:", playerTeam);
    console.log("Available targets:", targets);

    // Clear all existing target markers and circles first
    Object.keys(this.targetMarkers).forEach((targetId) => {
      if (this.targetMarkers[targetId]) {
        this.gameMap.removeLayer(this.targetMarkers[targetId]);
        delete this.targetMarkers[targetId];
      }
    });

    Object.keys(this.targetCircles).forEach((targetId) => {
      if (this.targetCircles[targetId]) {
        this.gameMap.removeLayer(this.targetCircles[targetId]);
        delete this.targetCircles[targetId];
      }
    });

    // Only process targets for current player and with active status
    const myActiveTargets = targets.filter((target) => target.playerId === gameState.playerId && target.status !== "reached");

    console.log(`Found ${myActiveTargets.length} active targets for current player`);

    // For runners, we should only have at most one active target
    if (myActiveTargets.length > 0) {
      // If somehow there are multiple targets, just use the first one
      const target = myActiveTargets[0];
      console.log("Processing target:", target);

      // Only create circles for runner
      if (playerTeam === "runner") {
        // Create a feature group to hold all circles
        this.targetCircles[target.targetId] = L.featureGroup().addTo(this.gameMap);

        // Get radius levels from the game config
        const radiusLevels = [2000, 1000, 500, 250, 125]; // Should really be getting this from config.game.targetRadiusLevels

        // Generate positions for nested circles
        const circlePositions = geoUtils.generateNestedCirclePositions(target.location.lat, target.location.lng, radiusLevels);

        // Determine if the zone is active
        const isActive = target.zoneStatus === "active" || (target.activationTime && Date.now() > target.activationTime);

        // Create each circle at its calculated position
        circlePositions.forEach((position, index) => {
          if (position.radius !== target.radiusLevel) {
            return;
          }

          // Use different colors for active vs inactive zones
          const circleColor = isActive ? "#4caf50" : "#ef7d54";
          const fillOpacity = 0.3;
          const dashArray = isActive ? null : "5, 5";

          // Create circle with the specified radius at the calculated position
          const circle = L.circle([position.lat, position.lng], {
            radius: position.radius,
            color: circleColor,
            fillColor: circleColor,
            fillOpacity: fillOpacity,
            weight: 2,
            dashArray: dashArray,
            className: `map-circle-target map-circle-target-level-${position.radius} ${isActive ? "active-zone" : "inactive-zone"}`,
          });

          // Add the circle to the feature group
          this.targetCircles[target.targetId].addLayer(circle);
        });
      }
    }
  },

  // Remove a runner marker
  removeRunnerMarker: function (playerId) {
    if (this.runnerMarkers[playerId]) {
      this.gameMap.removeLayer(this.runnerMarkers[playerId]);
      delete this.runnerMarkers[playerId];
    }
  },

  // Calculate distance between two points
  calculateDistance: function (lat1, lng1, lat2, lng2) {
    // Use the shared geoUtils function
    return geoUtils.calculateDistance(lat1, lng1, lat2, lng2);
  },

  // Start timer to update runner labels
  startLabelUpdateTimer: function () {
    // Clear any existing timer
    if (this.labelUpdateTimer) {
      clearInterval(this.labelUpdateTimer);
    }

    // Start new timer - update every 10 seconds
    this.labelUpdateTimer = setInterval(() => {
      this.updateAllRunnerLabels();
    }, 10000);
  },

  // Update all runner labels with current time differences
  updateAllRunnerLabels: function () {
    const currentTime = Date.now();

    // Only do this for hunters
    if (gameState.team !== "hunter") return;

    // Update main runner markers
    Object.keys(this.runnerDataCache).forEach((playerId) => {
      const data = this.runnerDataCache[playerId];
      if (!data) return;

      const { username, timestamp } = data;

      // Calculate new time elapsed
      const timeElapsed = (currentTime - timestamp) / 1000;
      const timeElapsedText = this.formatTimeElapsed(timeElapsed);

      // Update main marker opacity
      const mainMarkerOpacity = Math.max(0.8, 1 - (timeElapsed / 300) * 0.2);

      // Update main marker if it exists
      if (this.runnerMarkers[playerId]) {
        // Update opacity
        this.runnerMarkers[playerId].setOpacity(mainMarkerOpacity);

        // Update popup
        const popupContent = `
          <div class="map-player-popup map-player-popup-runner">
            <strong>${username}</strong><br>
            Last seen: ${timeElapsedText} ago
          </div>
        `;

        // Check if popup exists before updating
        const popup = this.runnerMarkers[playerId].getPopup();
        if (popup) {
          popup.setContent(popupContent);
        }
      }

      // Update label
      if (this.runnerLabels[playerId]) {
        const updatedIcon = L.divIcon({
          className: "runner-label-container",
          html: `<div class="runner-label">${username}: ${timeElapsedText} ago</div>`,
          iconSize: [100, 40],
          iconAnchor: [50, -15],
        });

        this.runnerLabels[playerId].setIcon(updatedIcon);
      }

      // Update history markers
      if (data.locationHistory && this.runnerHistoryMarkers[playerId]) {
        this.updateHistoryMarkerLabels(playerId, data.locationHistory, username);
      }
    });
  },

  // Update history marker labels
  updateHistoryMarkerLabels: function (playerId, locationHistory, username) {
    const currentTime = Date.now();
    const markers = this.runnerHistoryMarkers[playerId];

    // Skip if no markers
    if (!markers || !markers.length) return;

    // We can't easily map markers back to their original points
    // since they're just in an array, so we'll update all of them
    // with recalculated opacity and time text
    locationHistory.forEach((point, index) => {
      if (index >= markers.length) return;

      const marker = markers[index];
      const { timestamp } = point;

      // Calculate time elapsed
      const timeElapsed = (currentTime - timestamp) / 1000;
      const timeElapsedText = this.formatTimeElapsed(timeElapsed);

      // Calculate opacity
      const opacity = Math.max(0.4, 0.8 - (timeElapsed / 1800) * 0.4);

      // Update icon
      if (opacity > 0.05) {
        const historyIcon = L.divIcon({
          className: "history-marker",
          html: `
            <div class="history-marker-runner" style="opacity: ${opacity}">
              <img src="assets/icons/runner.svg" alt="Runner">
            </div>
            <div class="history-marker-label" style="opacity: ${opacity}">${username}: ${timeElapsedText} ago</div>
          `,
          iconSize: [50, 30],
          iconAnchor: [25, 15],
        });

        marker.setIcon(historyIcon);

        // Update tooltip
        marker.unbindTooltip();
        marker.bindTooltip(`${username}<br>${timeElapsedText} ago`, {
          permanent: false,
          direction: "top",
          opacity: opacity,
        });
      }
    });
  },
};

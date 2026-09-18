/**
 * Map Utilities for HUNTED Game
 * Uses Leaflet.js with OpenStreetMap
 */

// How long runner trails take to fade out. Should match config.game.trail.windowMs on the server
const TRAIL_WINDOW_MS = 60 * 60 * 1000;

// How many of a runner's previous sightings get a permanent "ago" label (the rest show it when tapped)
const LABELLED_SIGHTINGS = 3;

// Sighting labels overlap into noise when zoomed out further than this
const MIN_TRAIL_LABEL_ZOOM = 14;

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
  runnerTrails: {},
  targetCircles: {},
  boundaryCircle: null,

  // Store current location
  currentLocation: null,
  selectedLocation: null,

  // Watch position ID
  watchPositionId: null,

  // Timer for updating labels
  labelUpdateTimer: null,

  // Latest details of other players, so labels can update between pings
  playerDataCache: {},

  // Shield and immunity per player, from the last game state
  shieldStates: {},

  // The map on the end of game replay screen
  reviewMap: null,

  // Runner map colours, read from variables.css
  runnerColors: [],

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

    // Keep the runner palette in one place (variables.css)
    const styles = getComputedStyle(document.documentElement);
    for (let slot = 1; styles.getPropertyValue(`--runner-color-${slot}`).trim(); slot++) {
      this.runnerColors.push(styles.getPropertyValue(`--runner-color-${slot}`).trim());
    }
  },

  // A runner's map colour for their colour slot. Colours repeat once every one is in use.
  runnerColor: function (colorIndex) {
    if (colorIndex == null || this.runnerColors.length === 0) {
      return getComputedStyle(document.documentElement).getPropertyValue("--color-runner").trim();
    }
    return this.runnerColors[colorIndex % this.runnerColors.length];
  },

  // Create custom icons for map markers
  createIcons: function () {
    // Your own location: a precise point with a live pulse, so it never reads as a team marker
    this.icons.player = L.divIcon({
      className: "map-marker-player",
      html: `<span class="player-dot-pulse"></span><span class="player-dot"></span>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
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
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
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
  initGameMap: function (centerLat, centerLng, targetAreaRadius) {
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
    this.runnerTrails = {};
    this.targetCircles = {};
    this.boundaryCircle = null;
    this.playerDataCache = {};

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
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.gameMap);

    // Add zoom control to top right
    L.control
      .zoom({
        position: "topright",
      })
      .addTo(this.gameMap);

    // Add attribution control (OpenStreetMap's licence requires the credit to be visible)
    L.control
      .attribution({
        position: "bottomright",
      })
      .addTo(this.gameMap);

    // Hide trail sighting labels when zoomed out
    const updateTrailLabelVisibility = () => {
      mapContainer.classList.toggle("trail-labels-hidden", this.gameMap.getZoom() < MIN_TRAIL_LABEL_ZOOM);
    };
    this.gameMap.on("zoomend", updateTrailLabelVisibility);

    // Set default view based on provided center
    this.gameMap.setView([centerLat, centerLng], 14);
    updateTrailLabelVisibility();

    // Add game boundary circle
    if (gameState.team === "hunter") {
      this.boundaryCircle = L.circle([centerLat, centerLng], {
        radius: targetAreaRadius,
        color: "#999999", // Light enough to see on the dark map
        fillColor: "#ffffff",
        fillOpacity: 0.04,
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
  initLobbyMap: function (centerLat, centerLng, targetAreaRadius) {
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
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.lobbyMap);

    // Add attribution control (OpenStreetMap's licence requires the credit to be visible)
    L.control
      .attribution({
        position: "bottomright",
      })
      .addTo(this.lobbyMap);

    // Force map to update size
    this.lobbyMap.invalidateSize();

    // Now set the correct view
    this.lobbyMap.setView([centerLat, centerLng], 11);

    // Add center marker
    L.marker([centerLat, centerLng]).addTo(this.lobbyMap);

    // Add game boundary circle
    L.circle([centerLat, centerLng], {
      radius: targetAreaRadius,
      color: "#999999", // Light enough to see on the dark map
      fillColor: "#ffffff",
      fillOpacity: 0.04,
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

  // Show another player's marker, and a runner's trail when one is included
  updateOtherPlayerLocation: function (player) {
    if (!this.gameMap) return;
    if (player.playerId === gameState.playerId) return;

    const { playerId, username, team, location, lastPingTime, colorIndex, trail } = player;
    const lat = location?.lat;
    const lng = location?.lng;

    if (!lat || !lng) return;

    // Cache what the label timer needs to keep "ago" times counting up between pings
    this.playerDataCache[playerId] = { playerId, username, team, lastPingTime, colorIndex, location: { lat, lng } };

    // Select icon based on team
    const playerIcon = team === "hunter" ? this.icons.hunter : this.icons.runner;

    if (this.runnerMarkers[playerId]) {
      this.runnerMarkers[playerId].setLatLng([lat, lng]);

      // Update marker icon (in case team changed)
      this.runnerMarkers[playerId].setIcon(playerIcon);

      this.runnerLabels[playerId].setLatLng([lat, lng]);
    } else {
      this.runnerMarkers[playerId] = L.marker([lat, lng], {
        icon: playerIcon,
        zIndexOffset: 1000, // Keep players above trails
      })
        .bindPopup("")
        .addTo(this.gameMap);

      // Add label beneath the marker
      this.runnerLabels[playerId] = L.marker([lat, lng], {
        icon: L.divIcon({
          className: "runner-label-container",
          html: `<div class="runner-label"></div>`,
          iconSize: [100, 40],
          iconAnchor: [50, -15],
        }),
        zIndexOffset: 1000,
        interactive: false,
      }).addTo(this.gameMap);
    }

    // Runners' markers and labels wear their own colour, matching their trail
    const color = team === "runner" ? this.runnerColor(colorIndex) : null;
    [this.runnerMarkers[playerId].getElement(), this.runnerLabels[playerId].getElement()].forEach((element) => {
      if (!element) return;
      if (color) {
        element.style.setProperty("--runner-color", color);
      } else {
        element.style.removeProperty("--runner-color");
      }
    });

    // Only runners leave a trail, so a caught runner who is now a hunter loses theirs
    if (team !== "runner") {
      this.removeRunnerTrail(playerId);
    } else if (trail) {
      this.renderRunnerTrail(playerId, trail);
    }

    this.refreshPlayerTimes(playerId);
  },

  // Draw a runner's trail: one short line per sighting (while their app was open),
  // dotted links between sightings, and an arrow showing which way they were last moving
  renderRunnerTrail: function (playerId, trail) {
    this.removeRunnerTrail(playerId);

    const player = this.playerDataCache[playerId];
    if (!player || trail.sightings.length === 0) return;

    const layer = L.layerGroup().addTo(this.gameMap);
    const lastIndex = trail.sightings.length - 1;
    const color = this.runnerColor(player.colorIndex);

    const sightings = trail.sightings.map((sighting, index) => {
      const drawn = { end: sighting.end };
      const endPoint = sighting.points[sighting.points.length - 1];

      // Where the runner went while their app was closed is unknown
      if (index > 0) {
        const previous = trail.sightings[index - 1].points;
        drawn.gap = L.polyline([previous[previous.length - 1], sighting.points[0]], {
          className: "trail-gap",
          color,
          weight: 3,
          dashArray: "1, 8",
          interactive: false,
        }).addTo(layer);
      }

      if (sighting.points.length > 1) {
        // White casing keeps the line visible over roads and water
        drawn.casing = L.polyline(sighting.points, {
          className: "trail-line-casing",
          weight: 7,
          interactive: false,
        }).addTo(layer);

        drawn.line = L.polyline(sighting.points, {
          className: "trail-line",
          color,
          weight: 4,
          interactive: false,
        }).addTo(layer);
      }

      // The latest sighting ends at the runner's marker, so only earlier ones get a dot
      if (index < lastIndex) {
        drawn.dot = L.circleMarker(endPoint, {
          className: "trail-sighting-dot",
          fillColor: color,
          radius: 5,
          weight: 2,
        })
          .bindTooltip("", { direction: "top" })
          .addTo(layer);

        // Label only the most recent sightings; older ones show their time when tapped
        if (index >= lastIndex - LABELLED_SIGHTINGS) {
          drawn.label = L.marker(endPoint, {
            icon: L.divIcon({
              className: "trail-sighting-label-container",
              html: `<div class="trail-sighting-label" style="--runner-color: ${color}"></div>`,
              iconSize: [60, 16],
              iconAnchor: [-8, 8],
            }),
            interactive: false,
          }).addTo(layer);
        }
      }

      return drawn;
    });

    if (trail.heading !== null) {
      L.marker([player.location.lat, player.location.lng], {
        icon: L.divIcon({
          className: "trail-heading-container",
          html: `<div class="trail-heading" style="transform: rotate(${trail.heading}deg); --runner-color: ${color}"><div class="trail-heading-arrow"></div></div>`,
          iconSize: [80, 80],
          iconAnchor: [40, 40],
        }),
        interactive: false,
        zIndexOffset: 900, // Just beneath the runner's marker
      }).addTo(layer);
    }

    this.runnerTrails[playerId] = { layer, sightings };
  },

  // Remove a runner's trail from the map
  removeRunnerTrail: function (playerId) {
    if (this.runnerTrails[playerId]) {
      this.gameMap.removeLayer(this.runnerTrails[playerId].layer);
      delete this.runnerTrails[playerId];
    }
  },

  // Update everything about a player that depends on how long ago they were seen
  refreshPlayerTimes: function (playerId) {
    const player = this.playerDataCache[playerId];
    const marker = this.runnerMarkers[playerId];
    if (!player || !marker) return;

    const secondsAgo = this.secondsSince(player.lastPingTime);
    const timeAgo = this.formatTimeElapsed(secondsAgo);

    // Opacity ranges from 1.0 (fresh) to 0.8 (5 mins old)
    marker.setOpacity(Math.max(0.8, 1 - (secondsAgo / 300) * 0.2));
    marker.getPopup().setContent(this.playerPopupContent(player, timeAgo));
    const shield = this.shieldLabel(playerId);
    this.setLabelText(this.runnerLabels[playerId], `${player.username}${shield ? shield.badge : ""}: ${timeAgo} ago`);

    const trail = this.runnerTrails[playerId];
    if (!trail) return;

    trail.sightings.forEach((sighting) => {
      const opacity = this.trailOpacity(sighting.end);
      const sightingAgo = `${this.formatTimeAgoShort(this.secondsSince(sighting.end))} ago`;

      if (sighting.casing) sighting.casing.setStyle({ opacity: opacity * 0.8 });
      if (sighting.line) sighting.line.setStyle({ opacity });
      if (sighting.gap) sighting.gap.setStyle({ opacity: opacity * 0.7 });
      if (sighting.dot) {
        sighting.dot.setStyle({ opacity, fillOpacity: opacity });
        sighting.dot.setTooltipContent(this.textElement(`${player.username}: ${sightingAgo}`));
      }
      this.setLabelText(sighting.label, sightingAgo);
    });
  },

  // Trails fade from 1.0 when fresh to 0.45 at the end of the trail window
  trailOpacity: function (timestamp) {
    const age = Math.min(1, (this.secondsSince(timestamp) * 1000) / TRAIL_WINDOW_MS);
    return 1 - age * 0.55;
  },

  // Set the text of a label marker created with a single inner div
  setLabelText: function (labelMarker, text) {
    const element = labelMarker?.getElement()?.firstElementChild;
    if (element) {
      element.textContent = text;
    }
  },

  // Wrap text in an element so player names are never parsed as HTML
  textElement: function (text) {
    const element = document.createElement("span");
    element.textContent = text;
    return element;
  },

  playerPopupContent: function (player, timeAgo) {
    const popup = document.createElement("div");
    popup.className = `map-player-popup ${player.team === "hunter" ? "map-player-popup-hunter" : "map-player-popup-runner"}`;

    const name = document.createElement("strong");
    name.textContent = player.username;

    popup.append(name, document.createElement("br"), `Last seen: ${timeAgo} ago`);

    const shield = this.shieldLabel(player.playerId);

    if (shield) {
      popup.append(document.createElement("br"), shield.detail);
    }

    return popup;
  },

  // Seconds since a server timestamp, never negative if the phone's clock is slightly ahead
  secondsSince: function (timestamp) {
    return Math.max(0, (Date.now() - timestamp) / 1000);
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

  // Compact version for trail labels, e.g. "12m"
  formatTimeAgoShort: function (seconds) {
    if (seconds < 60) {
      return `${Math.floor(seconds)}s`;
    } else if (seconds < 3600) {
      return `${Math.floor(seconds / 60)}m`;
    } else {
      return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    }
  },

  // Draw the zone a runner is on. The server sends the circle itself - where it
  // sits is the whole puzzle, so the client is never told what it is closing in
  // on, and hunters are sent no zones at all.
  updateTargets: function (targets, playerTeam) {
    if (!this.gameMap) return;

    // Clear any zone already drawn
    Object.keys(this.targetCircles).forEach((targetId) => {
      this.gameMap.removeLayer(this.targetCircles[targetId]);
      delete this.targetCircles[targetId];
    });

    if (playerTeam !== "runner") return;

    const zone = (targets || []).find((target) => target.playerId === gameState.playerId && target.status === "active" && target.location);

    if (!zone) return;

    // A zone can only be captured inside its own window, so its colour says
    // whether it is worth running for right now
    const zoneStatus = zone.zoneStatus || "open";
    const isOpen = zoneStatus === "open";
    const circleColor = isOpen ? "#4caf50" : zoneStatus === "locked" ? "#ffeb3b" : "#ef7d54";

    this.targetCircles[zone.targetId] = L.circle([zone.location.lat, zone.location.lng], {
      radius: zone.radiusLevel,
      color: circleColor,
      fillColor: circleColor,
      fillOpacity: 0.12, // A heavier fill muddies the dark map and hides trails
      weight: 2,
      dashArray: isOpen ? null : "5, 5",
      className: `map-circle-target map-circle-zone-${zoneStatus}`,
    }).addTo(this.gameMap);
  },

  // Shields are public, so the map can show who still has one and who is
  // currently immune. Called whenever a new game state arrives.
  setShieldStates: function (players) {
    this.shieldStates = {};

    (players || []).forEach((player) => {
      this.shieldStates[player.playerId] = {
        team: player.team,
        status: player.status,
        shieldActive: player.shieldActive,
        immunityUntil: player.immunityUntil,
      };
    });

    Object.keys(this.playerDataCache).forEach((playerId) => this.refreshPlayerTimes(playerId));
  },

  // How a runner's shield reads right now: a badge for their label, and a line
  // for their popup
  shieldLabel: function (playerId) {
    const player = this.shieldStates[playerId];

    if (!player || player.team !== "runner" || player.status === "won") {
      return null;
    }

    const shield = zoneUtils.shieldState({ shieldActive: player.shieldActive, immunityUntil: player.immunityUntil }, Date.now());

    if (shield.immune) {
      return { badge: " ⏱", detail: `Immune for ${zoneUtils.formatCountdown(shield.immuneMsRemaining)}` };
    }

    if (shield.hasShield) {
      return { badge: " 🛡", detail: "Shield intact" };
    }

    return { badge: "", detail: "No shield - one more and they are out" };
  },

  // The whole game on one map, once it is over: where every runner was seen,
  // how each of them finished, and the final zone everyone was racing for.
  // Drawn in the same language as the live map - solid where a runner was
  // seen, dotted where their app was shut - but frozen, with nothing fading.
  renderReview: function (review) {
    const container = document.getElementById("replay-map");
    if (!container) return;

    if (this.reviewMap) {
      this.reviewMap.remove();
      this.reviewMap = null;
    }

    this.reviewMap = L.map("replay-map", {
      zoomControl: false,
      attributionControl: false,
    });

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.reviewMap);

    L.control.zoom({ position: "topright" }).addTo(this.reviewMap);
    L.control.attribution({ position: "bottomright" }).addTo(this.reviewMap);
    L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(this.reviewMap);

    const points = [];

    // The area the hunters picked, and never saw inside
    if (review.targetArea) {
      L.circle([review.targetArea.lat, review.targetArea.lng], {
        radius: review.targetArea.radius,
        color: "#999999",
        fillColor: "#ffffff",
        fillOpacity: 0.04,
        weight: 2,
        dashArray: "5, 10",
        interactive: false,
      }).addTo(this.reviewMap);
    }

    // No more secrets
    if (review.finalZone) {
      L.circle([review.finalZone.lat, review.finalZone.lng], {
        radius: review.finalZone.radius,
        color: "#4caf50",
        fillColor: "#4caf50",
        fillOpacity: 0.2,
        weight: 2,
      }).addTo(this.reviewMap);

      L.marker([review.finalZone.lat, review.finalZone.lng], {
        icon: L.divIcon({
          className: "review-label-container",
          html: this.reviewLabel("Final zone", null),
          iconSize: [120, 18],
          iconAnchor: [60, -8],
        }),
        interactive: false,
      }).addTo(this.reviewMap);

      points.push([review.finalZone.lat, review.finalZone.lng]);
    }

    const outcomes = {};
    (review.players || []).forEach((player) => {
      outcomes[player.playerId] = player.outcome;
    });

    Object.values(review.trails || {}).forEach((runner, index) => {
      this.renderReviewTrail(runner, outcomes[runner.playerId], review.gameStartTime, index).forEach((point) => points.push(point));
    });

    if (points.length > 0) {
      this.reviewMap.fitBounds(L.latLngBounds(points).pad(0.2));
    } else if (review.targetArea) {
      this.reviewMap.setView([review.targetArea.lat, review.targetArea.lng], 14);
    }

    // Leaflet needs telling once the screen it sits on is actually visible
    setTimeout(() => this.reviewMap && this.reviewMap.invalidateSize(), 100);
  },

  // One runner's whole game, in their colour. The label index stacks the end
  // labels, since runners tend to finish in much the same place.
  renderReviewTrail: function (runner, outcome, gameStartTime, labelIndex = 0) {
    const color = this.runnerColor(runner.colorIndex);
    const sightings = (runner.trail && runner.trail.sightings) || [];
    const points = [];

    sightings.forEach((sighting, index) => {
      sighting.points.forEach((point) => points.push(point));

      // Where they went with the app shut is still anyone's guess
      if (index > 0) {
        const previous = sightings[index - 1].points;
        L.polyline([previous[previous.length - 1], sighting.points[0]], {
          className: "trail-gap",
          color,
          weight: 3,
          dashArray: "1, 8",
          interactive: false,
        }).addTo(this.reviewMap);
      }

      if (sighting.points.length > 1) {
        L.polyline(sighting.points, {
          className: "trail-line-casing",
          weight: 7,
          interactive: false,
        }).addTo(this.reviewMap);

        L.polyline(sighting.points, {
          className: "trail-line",
          color,
          weight: 4,
          interactive: false,
        }).addTo(this.reviewMap);
      }

      // Tap a dot to see how far into the game they were standing there
      L.circleMarker(sighting.points[sighting.points.length - 1], {
        className: "trail-sighting-dot",
        fillColor: color,
        radius: 4,
        weight: 2,
      })
        .bindTooltip(`${runner.username}: ${this.minutesInto(sighting.end, gameStartTime)}`, { direction: "top" })
        .addTo(this.reviewMap);
    });

    // Where their game ended
    const last = points[points.length - 1];

    if (last) {
      L.marker(last, {
        icon: L.divIcon({
          className: "review-label-container",
          html: this.reviewLabel(runner.username, outcome, color),
          iconSize: [140, 18],
          iconAnchor: [70, -8 - labelIndex * 20],
        }),
        interactive: false,
        zIndexOffset: 900,
      }).addTo(this.reviewMap);
    }

    return points;
  },

  // Player names are never parsed as HTML, on the replay map either
  reviewLabel: function (name, outcome, color) {
    const label = document.createElement("div");
    label.className = "review-label";

    if (color) {
      label.style.setProperty("--runner-color", color);
    }

    const outcomeText = outcome && typeof UI !== "undefined" && UI.outcomeLabel ? UI.outcomeLabel(outcome).text : null;
    label.textContent = outcomeText ? `${name} - ${outcomeText}` : name;

    return label;
  },

  // How far into the game something happened, for the replay
  minutesInto: function (timestamp, gameStartTime) {
    if (!gameStartTime) {
      return this.formatTimeElapsed(this.secondsSince(timestamp)) + " ago";
    }

    const minutes = Math.max(0, Math.round((timestamp - gameStartTime) / 60000));
    return `${minutes} min in`;
  },

  // Remove a player's marker, label and trail
  removeRunnerMarker: function (playerId) {
    if (this.runnerMarkers[playerId]) {
      this.gameMap.removeLayer(this.runnerMarkers[playerId]);
      delete this.runnerMarkers[playerId];
    }

    if (this.runnerLabels[playerId]) {
      this.gameMap.removeLayer(this.runnerLabels[playerId]);
      delete this.runnerLabels[playerId];
    }

    this.removeRunnerTrail(playerId);
    delete this.playerDataCache[playerId];
  },

  // Calculate distance between two points
  calculateDistance: function (lat1, lng1, lat2, lng2) {
    // Use the shared geoUtils function
    return geoUtils.calculateDistance(lat1, lng1, lat2, lng2);
  },

  // Start timer to keep "ago" labels and trail fading up to date between pings
  startLabelUpdateTimer: function () {
    // Clear any existing timer
    if (this.labelUpdateTimer) {
      clearInterval(this.labelUpdateTimer);
    }

    this.labelUpdateTimer = setInterval(() => {
      Object.keys(this.playerDataCache).forEach((playerId) => this.refreshPlayerTimes(playerId));
    }, 5000);
  },
};

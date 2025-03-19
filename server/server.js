const express = require("express");
const http = require("http");
const path = require("path");
const socketIO = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");

// Initialize express app
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));
app.use('/shared', express.static(path.join(__dirname, "../shared")));

// Database setup
const dbPath = path.join(__dirname, "../database/hunted.db");
const dbDir = path.dirname(dbPath);

// Create database directory if it doesn't exist
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Error opening database", err);
  } else {
    console.log("Connected to SQLite database");
    initDatabase();
  }
});

// Initialize database tables
function initDatabase() {
  db.serialize(() => {
    // Rooms table
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
            room_id TEXT PRIMARY KEY,
            room_name TEXT UNIQUE,
            zone_activation_delay INTEGER,
            central_lat REAL,
            central_lng REAL,
            play_radius INTEGER DEFAULT 5000,
            start_time INTEGER,
            end_time INTEGER,
            status TEXT
        )`);

    // Players table
    db.run(`CREATE TABLE IF NOT EXISTS players (
            player_id TEXT PRIMARY KEY,
            room_id TEXT,
            username TEXT,
            team TEXT,
            status TEXT,
            last_lat REAL,
            last_lng REAL,
            last_ping_time INTEGER,
            FOREIGN KEY (room_id) REFERENCES rooms (room_id)
        )`);

    // Targets table
    db.run(`CREATE TABLE IF NOT EXISTS targets (
            target_id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL,
            player_id TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            radius_level INTEGER NOT NULL,
            points_value INTEGER,
            status TEXT DEFAULT 'active',
            zone_status TEXT DEFAULT 'inactive',
            activation_time INTEGER,
            created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
            reached_at INTEGER,
            FOREIGN KEY(room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
            FOREIGN KEY(player_id) REFERENCES players(player_id)
        )`);
    
    // Target discoveries table to track points earned
    db.run(`CREATE TABLE IF NOT EXISTS target_discoveries (
            discovery_id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            radius_level INTEGER NOT NULL,
            points_earned INTEGER NOT NULL,
            discovery_time INTEGER NOT NULL,
            FOREIGN KEY(player_id) REFERENCES players(player_id) ON DELETE CASCADE,
            FOREIGN KEY(target_id) REFERENCES targets(target_id) ON DELETE CASCADE
        )`);

    // Location history table to track player movement
    db.run(`CREATE TABLE IF NOT EXISTS location_history (
            history_id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            room_id TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            timestamp INTEGER NOT NULL,
            FOREIGN KEY(player_id) REFERENCES players(player_id) ON DELETE CASCADE,
            FOREIGN KEY(room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
        )`);
  });
}

// API Routes
const apiRouter = require("./routes/api");
app.use("/api", apiRouter);

// Socket.IO Connection
const socketManager = require("./socket/socketManager");
socketManager(io, db);

// Catch-all route to serve the main application
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access the game at http://localhost:${PORT}`);
});

// Handle server shutdown
process.on("SIGINT", () => {
  console.log("Closing database connection...");
  db.close();
  process.exit(0);
});

module.exports = { app, server, db };

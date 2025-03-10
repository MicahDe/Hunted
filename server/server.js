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
            game_duration INTEGER,
            central_lat REAL,
            central_lng REAL,
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
            room_id TEXT,
            lat REAL,
            lng REAL,
            radius_level INTEGER,
            reached_by TEXT,
            points_value INTEGER,
            FOREIGN KEY (room_id) REFERENCES rooms (room_id),
            FOREIGN KEY (reached_by) REFERENCES players (player_id)
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

const express = require("express");
const http = require("http");
const path = require("path");
const socketIO = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const { initDatabase } = require("./db/schema");

// Initialize express app
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));
app.use("/shared", express.static(path.join(__dirname, "../shared")));

// Database setup. DB_PATH lets a test run point the server at a throwaway
// database rather than the real one.
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, "../database/hunted.db");
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
    initDatabase(db);
  }
});

// API Routes
const apiRouter = require("./routes/api");
app.use("/api", apiRouter);

// Socket.IO Connection
const socketManager = require("./socket/socketManager");
socketManager(io, db);

// Serve help page
app.get("/help.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/help.html"));
});

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

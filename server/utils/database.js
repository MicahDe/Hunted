/**
 * Database utilities for HUNTED Game
 */

const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const config = require("../config/default");

// Create database connection
const dbPath = path.join(__dirname, config.database.path);
const dbDir = path.dirname(dbPath);

// Create database directory if it doesn't exist
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize database connection
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
          room_id TEXT NOT NULL,
          player_id TEXT NOT NULL,
          lat REAL NOT NULL,
          lng REAL NOT NULL,
          radius_level INTEGER NOT NULL,
          points_value INTEGER NOT NULL,
          status TEXT DEFAULT 'active',
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
  });
}

// Database helper functions
const dbUtils = {
  // Get a single row
  get: (query, params) => {
    return new Promise((resolve, reject) => {
      db.get(query, params, (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });
  },

  // Get multiple rows
  all: (query, params) => {
    return new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        resolve(rows || []);
      });
    });
  },

  // Run a query (insert, update, delete)
  run: (query, params) => {
    return new Promise((resolve, reject) => {
      db.run(query, params, function (err) {
        if (err) reject(err);
        resolve({
          lastID: this.lastID,
          changes: this.changes,
        });
      });
    });
  },

  // Run multiple queries in a transaction
  transaction: (queries) => {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        const results = [];
        let error = null;

        for (const { query, params } of queries) {
          if (error) continue;

          db.run(query, params, function (err) {
            if (err) {
              error = err;
              return;
            }

            results.push({
              lastID: this.lastID,
              changes: this.changes,
            });
          });
        }

        if (error) {
          db.run("ROLLBACK");
          reject(error);
        } else {
          db.run("COMMIT");
          resolve(results);
        }
      });
    });
  },
};

// Handle server shutdown - close database
process.on("SIGINT", () => {
  console.log("Closing database connection...");
  db.close();
  process.exit(0);
});

module.exports = {
  db,
  dbUtils,
}; 
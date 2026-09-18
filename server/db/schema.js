/**
 * Database schema for HUNTED Game
 *
 * Kept apart from server startup so tests can build the same tables against an
 * in-memory database.
 */

// Initialize database tables
function initDatabase(db) {
  db.serialize(() => {
    // Rooms table
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
            room_id TEXT PRIMARY KEY,
            room_name TEXT UNIQUE,
            game_duration INTEGER,
            catch_immunity INTEGER,
            game_start_time INTEGER,
            central_lat REAL,
            central_lng REAL,
            play_radius INTEGER DEFAULT 5000,
            start_time INTEGER,
            end_time INTEGER,
            status TEXT
        )`);

    // Players table. Every runner starts with one shield, spent by the first
    // catch or missed zone window; the second of either puts them out.
    db.run(`CREATE TABLE IF NOT EXISTS players (
            player_id TEXT PRIMARY KEY,
            room_id TEXT,
            username TEXT,
            team TEXT,
            status TEXT,
            shield_active INTEGER DEFAULT 1,
            shield_lost_at INTEGER,
            shield_lost_reason TEXT,
            immunity_until INTEGER,
            elimination_reason TEXT,
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
            zone_index INTEGER DEFAULT 0,
            points_value INTEGER,
            status TEXT DEFAULT 'active',
            zone_status TEXT DEFAULT 'inactive',
            activation_time INTEGER,
            window_close_time INTEGER,
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

    // Runner trails are read on every runner ping
    db.run(`CREATE INDEX IF NOT EXISTS idx_location_history_player_time ON location_history (player_id, timestamp)`);

    // Databases created before zone windows and shields existed are missing
    // those columns, and CREATE TABLE IF NOT EXISTS won't add them
    addMissingColumns(db, "rooms", {
      game_duration: "INTEGER",
      catch_immunity: "INTEGER",
      game_start_time: "INTEGER",
    });

    addMissingColumns(db, "players", {
      shield_active: "INTEGER DEFAULT 1",
      shield_lost_at: "INTEGER",
      shield_lost_reason: "TEXT",
      immunity_until: "INTEGER",
      elimination_reason: "TEXT",
    });

    addMissingColumns(db, "targets", {
      zone_index: "INTEGER DEFAULT 0",
      window_close_time: "INTEGER",
    });
  });
}

// Add any of the given columns that the table doesn't already have
function addMissingColumns(db, table, columns) {
  db.all(`PRAGMA table_info(${table})`, (err, rows) => {
    if (err) {
      console.error(`Error reading columns of ${table}`, err);
      return;
    }

    const existing = new Set((rows || []).map((row) => row.name));

    Object.entries(columns)
      .filter(([name]) => !existing.has(name))
      .forEach(([name, definition]) => {
        db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`, (alterErr) => {
          if (alterErr) {
            console.error(`Error adding ${table}.${name}`, alterErr);
          } else {
            console.log(`Added missing column ${table}.${name}`);
          }
        });
      });
  });
}

module.exports = { initDatabase };

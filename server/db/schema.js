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
            host_player_id TEXT,
            game_duration INTEGER,
            catch_immunity INTEGER,
            zone_lock INTEGER,
            shield_zones INTEGER,
            invisibility INTEGER,
            game_start_time INTEGER,
            final_lat REAL,
            final_lng REAL,
            central_lat REAL,
            central_lng REAL,
            target_radius INTEGER DEFAULT 500,
            start_time INTEGER,
            end_time INTEGER,
            status TEXT
        )`);

    // Players table. Every runner starts with one shield, spent by their first
    // catch or lost when shields run out (shield_lost_reason 'caught' or
    // 'expired'); a second catch, or any missed zone window, puts them out.
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
            left_at INTEGER,
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
            zones TEXT,
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

    // Databases created before zone windows, shields and the target area
    // existed are missing those columns, and CREATE TABLE IF NOT EXISTS won't
    // bring them up to date
    migrateColumns(db, "rooms", {
      // The circle the host draws only says where the final zone may be hidden
      renames: { play_radius: "target_radius" },
      columns: {
        game_duration: "INTEGER",
        catch_immunity: "INTEGER",
        zone_lock: "INTEGER",
        shield_zones: "INTEGER",
        invisibility: "INTEGER",
        game_start_time: "INTEGER",
        final_lat: "REAL",
        final_lng: "REAL",
        host_player_id: "TEXT",
      },
    });

    migrateColumns(db, "players", {
      columns: {
        shield_active: "INTEGER DEFAULT 1",
        shield_lost_at: "INTEGER",
        shield_lost_reason: "TEXT",
        immunity_until: "INTEGER",
        elimination_reason: "TEXT",
        left_at: "INTEGER",
      },
    });

    migrateColumns(db, "targets", {
      columns: {
        zone_index: "INTEGER DEFAULT 0",
        zones: "TEXT",
        window_close_time: "INTEGER",
      },
    });
  });
}

/**
 * Bring an existing table up to date from one read of its columns
 *
 * Renames run first, so a column that is only missing because it was renamed
 * keeps the data it already had rather than being added back empty.
 */
function migrateColumns(db, table, { renames = {}, columns = {} }) {
  db.all(`PRAGMA table_info(${table})`, (err, rows) => {
    if (err) {
      console.error(`Error reading columns of ${table}`, err);
      return;
    }

    const existing = new Set((rows || []).map((row) => row.name));

    Object.entries(renames)
      .filter(([from, to]) => existing.has(from) && !existing.has(to))
      .forEach(([from, to]) => {
        existing.delete(from);
        existing.add(to);

        db.run(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`, (alterErr) => {
          if (alterErr) {
            console.error(`Error renaming ${table}.${from} to ${to}`, alterErr);
          } else {
            console.log(`Renamed column ${table}.${from} to ${to}`);
          }
        });
      });

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

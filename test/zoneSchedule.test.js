/**
 * Tests for zone windows and shields, driven through the real socket handlers
 * against an in-memory database.
 *
 * The rules being pinned down: a zone can only be captured inside its own
 * window, and not until the lock at the start of that window has run out; a
 * window that closes uncaptured puts the runner out, shield or no shield. The
 * shield only stands between a runner and a hunter: the first catch costs it,
 * the second puts them out, and spending it buys a spell of immunity which the
 * server, not the client, has to enforce. Shields run out for everyone after
 * the first few zones, and anyone still holding one then goes invisible for a
 * spell - their location kept from everybody, by the server.
 */

const test = require("node:test");
const assert = require("node:assert");
const sqlite3 = require("sqlite3");

const socketManager = require("../server/socket/socketManager");
const { initDatabase } = require("../server/db/schema");
const zoneUtils = require("../shared/utils/zoneUtils");
const geoUtils = require("../shared/utils/geoUtils");
const config = require("../server/config/default");

const MINUTE = 60 * 1000;
const ZONE_COUNT = config.game.targetRadiusLevels.length;
const CENTRE = { lat: 51.5074, lng: -0.1278 };

/**
 * A room mid-game, with the given players connected.
 *
 * Time is moved by rewriting the room's start time rather than by waiting, so a
 * test can put the clock 25 minutes into a 60 minute game.
 */
async function createGame({ runners = ["Ruby"], hunters = ["Hank"], gameDuration = 60, zoneLock = 3, catchImmunity = 3, shieldZones = 2, invisibility = 3 } = {}) {
  const db = new sqlite3.Database(":memory:");
  initDatabase(db);

  const broadcasts = [];
  const sockets = new Map();

  const io = {
    on: (event, handler) => {
      io.connectionHandler = handler;
    },
    to: (room) => ({
      emit: (event, payload) => broadcasts.push({ room, event, payload }),
    }),
    sockets: { sockets },
  };

  const manager = socketManager(io, db);

  const connect = (id) => {
    const handlers = {};
    const socket = {
      id,
      emitted: [],
      on: (event, handler) => {
        handlers[event] = handler;
      },
      emit: (event, payload) => socket.emitted.push({ event, payload }),
      join: () => {},
      leave: () => {},
      to: (room) => ({
        emit: (event, payload) => broadcasts.push({ room, event, payload, except: id }),
      }),
      fire: (event, payload) => handlers[event](payload),
      received: (event) => socket.emitted.filter((entry) => entry.event === event),
      lastState: () => {
        const states = socket.emitted.filter((entry) => entry.event === "game_state");
        return states.length ? states[states.length - 1].payload : null;
      },
    };

    sockets.set(id, socket);
    io.connectionHandler(socket);

    return socket;
  };

  const run = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });

  const get = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

  // The host creates the room, then everyone joins it
  const host = connect("socket-host");
  host.fire("create_room", {
    roomName: "test-room",
    username: hunters[0],
    team: "hunter",
    gameDuration,
    zoneLock,
    catchImmunity,
    shieldZones,
    invisibility,
    targetRadius: 500,
    centralLat: CENTRE.lat,
    centralLng: CENTRE.lng,
  });

  await waitFor(async () => await get("SELECT room_id FROM rooms WHERE room_name = 'test-room'"), "the room to be created");

  const roomId = (await get("SELECT room_id FROM rooms WHERE room_name = 'test-room'")).room_id;
  const players = {};

  for (const [index, username] of [...hunters, ...runners].entries()) {
    const socket = index === 0 ? host : connect(`socket-${username}`);
    const team = hunters.includes(username) ? "hunter" : "runner";

    socket.fire("join_room", { roomName: "test-room", username, team });
    await waitFor(async () => await get("SELECT player_id FROM players WHERE room_id = ? AND username = ?", [roomId, username]), `${username} to join`);

    const row = await get("SELECT * FROM players WHERE room_id = ? AND username = ?", [roomId, username]);
    players[username] = { socket, playerId: row.player_id };
  }

  host.fire("start_game", { roomId });

  // Targets are generated one database round trip at a time
  await waitFor(async () => {
    const row = await get("SELECT COUNT(*) AS count FROM targets WHERE room_id = ?", [roomId]);
    return row.count === runners.length;
  }, "runners to be given their first zone");

  return {
    db,
    roomId,
    players,
    broadcasts,
    manager,
    connect,
    run,
    get,
    player: (username) => get("SELECT * FROM players WHERE room_id = ? AND username = ?", [roomId, username]),
    target: (username) => get("SELECT * FROM targets WHERE room_id = ? AND player_id = ?", [roomId, players[username].playerId]),
    room: () => get("SELECT * FROM rooms WHERE room_id = ?", [roomId]),
    of: (event) => broadcasts.filter((entry) => entry.event === event),

    // Wind the game clock forward by moving its start time into the past
    setElapsed: async (minutes) => {
      await run("UPDATE rooms SET game_start_time = ? WHERE room_id = ?", [Date.now() - minutes * MINUTE, roomId]);
      const room = await get("SELECT * FROM rooms WHERE room_id = ?", [roomId]);
      const windowMs = zoneUtils.zoneWindowMs(room.game_duration, ZONE_COUNT);
      const lockMs = zoneUtils.zoneLockMs(room.zone_lock, windowMs);

      // Targets carry their own window, so move those with the clock
      const targets = await new Promise((resolve, reject) => {
        db.all("SELECT * FROM targets WHERE room_id = ?", [roomId], (err, rows) => (err ? reject(err) : resolve(rows || [])));
      });

      for (const target of targets) {
        const window = zoneUtils.zoneWindow(target.zone_index || 0, room.game_start_time, windowMs, lockMs);
        await run("UPDATE targets SET activation_time = ?, window_close_time = ? WHERE target_id = ?", [window.openTime, window.closeTime, target.target_id]);
      }
    },

    // Ping from the middle of the zone the runner is on. The zones are allowed
    // to hang outside each other, so their own centre is the one point that is
    // certainly inside.
    pingInsideZone: async (username) => {
      const target = await get("SELECT * FROM targets WHERE room_id = ? AND player_id = ?", [roomId, players[username].playerId]);
      const zone = JSON.parse(target.zones)[target.zone_index || 0];

      players[username].socket.fire("location_update", { lat: zone.lat, lng: zone.lng });
      await settle();
    },
  };
}

// The handlers are async all the way down and sqlite calls back off the thread
// pool, so let their database work finish
function settle(ms = 40) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait for a condition the handlers reach in their own time
async function waitFor(condition, description, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }

    await settle(5);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

test("every runner is racing for the same final zone, by their own route in", async () => {
  const game = await createGame({ runners: ["Ruby", "Sam"] });

  const room = await game.room();
  const ruby = JSON.parse((await game.target("Ruby")).zones);
  const sam = JSON.parse((await game.target("Sam")).zones);

  // The final zone is the room's, and it is the same one for both of them
  assert.deepStrictEqual(ruby[ZONE_COUNT - 1], sam[ZONE_COUNT - 1]);
  assert.strictEqual(ruby[ZONE_COUNT - 1].lat, room.final_lat);
  assert.strictEqual(ruby[ZONE_COUNT - 1].lng, room.final_lng);

  // The way in is not
  const gap = geoUtils.calculateDistance(ruby[0].lat, ruby[0].lng, sam[0].lat, sam[0].lng);
  assert.ok(gap > 1, "both runners were shown the same first zone");
});

test("the host picks the target area, and the game hides the final zone inside it", async () => {
  const game = await createGame();
  const room = await game.room();

  assert.ok(room.final_lat != null && room.final_lng != null, "the game should have hidden a final zone");

  const fromCentre = geoUtils.calculateDistance(room.final_lat, room.final_lng, CENTRE.lat, CENTRE.lng);
  assert.ok(fromCentre <= room.target_radius + 1, `the final zone landed ${fromCentre.toFixed(0)}m out, beyond the target area`);
});

test("hunters are told nothing about anyone's zones", async () => {
  const game = await createGame();

  game.players.Hank.socket.fire("resync_game_state", { roomId: game.roomId });
  await settle();

  const hunterState = game.players.Hank.socket.lastState();
  assert.deepStrictEqual(hunterState.targets, [], "a hunter's state should carry no zones at all");
  assert.strictEqual(hunterState.finalZone, null, "a hunter should not be told the final zone mid-game");

  // The runner's own state carries one zone, and it is a circle, not the answer
  game.players.Ruby.socket.fire("resync_game_state", { roomId: game.roomId });
  await settle();

  const runnerState = game.players.Ruby.socket.lastState();
  assert.strictEqual(runnerState.targets.length, 1);
  assert.strictEqual(runnerState.targets[0].zoneNumber, 1);
  assert.strictEqual(runnerState.finalZone, null, "not even the runner is told where it ends");

  const zones = JSON.parse((await game.target("Ruby")).zones);
  assert.deepStrictEqual(runnerState.targets[0].location, { lat: zones[0].lat, lng: zones[0].lng });
});

test("the final zone is revealed to everyone once the game is over", async () => {
  const game = await createGame();

  await game.setElapsed(61);
  await game.manager.processZoneSchedules();
  await settle();

  const room = await game.room();
  const over = game.of("game_over");
  assert.strictEqual(over.length, 1);
  assert.deepStrictEqual(over[0].payload.gameState.finalZone, {
    lat: room.final_lat,
    lng: room.final_lng,
    radius: config.game.targetRadiusLevels[ZONE_COUNT - 1],
  });
});

test("a runner has to be inside their own zone, not just near the final one", async () => {
  const game = await createGame();
  await game.setElapsed(4);

  const zones = JSON.parse((await game.target("Ruby")).zones);
  const outside = geoUtils.calculateDestination(zones[0].lat, zones[0].lng, 90, zones[0].radius + 100);

  game.players.Ruby.socket.fire("location_update", { lat: outside.lat, lng: outside.lng });
  await settle();
  assert.strictEqual((await game.target("Ruby")).zone_index, 0, "a ping outside the zone captures nothing");

  game.players.Ruby.socket.fire("location_update", { lat: zones[0].lat, lng: zones[0].lng });
  await settle();
  assert.strictEqual((await game.target("Ruby")).zone_index, 1, "a ping inside it captures the zone");
});

test("every runner starts the game with a shield and zone 1 locked for the first 3 minutes", async () => {
  const game = await createGame();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.shield_active, 1);
  assert.strictEqual(runner.immunity_until, null);

  const room = await game.room();
  const target = await game.target("Ruby");
  assert.strictEqual(target.zone_index, 0);
  assert.strictEqual(target.radius_level, config.game.targetRadiusLevels[0]);
  assert.strictEqual(target.activation_time, room.game_start_time + 3 * MINUTE, "zone 1 opens at minute 3");
  assert.strictEqual(target.window_close_time, room.game_start_time + 10 * MINUTE, "and closes at minute 10");
  assert.strictEqual(zoneUtils.zoneStatusAt(Date.now(), { openTime: target.activation_time, closeTime: target.window_close_time }), "locked");
});

test("zone 1 can't be captured the moment the game starts, only once its lock runs out", async () => {
  const game = await createGame();

  await game.pingInsideZone("Ruby");
  assert.strictEqual((await game.target("Ruby")).zone_index, 0, "standing in zone 1 at kick-off captures nothing");
  assert.strictEqual(game.players.Ruby.socket.received("zone_captured").length, 0);

  await game.setElapsed(3);
  await game.pingInsideZone("Ruby");
  assert.strictEqual((await game.target("Ruby")).zone_index, 1, "at minute 3 it can be captured");
});

test("zones 2 and 3 can't be captured one straight after the other", async () => {
  // Shields that last the whole game, so none run out at minute 20
  const game = await createGame({ shieldZones: ZONE_COUNT });

  await game.setElapsed(4);
  await game.pingInsideZone("Ruby");

  // Capture zone 2 in the last minute of its window, then walk into zone 3
  await game.setElapsed(19);
  await game.pingInsideZone("Ruby");
  assert.strictEqual((await game.target("Ruby")).zone_index, 2);

  // Zone 3's window has started, but it is still locked
  await game.setElapsed(21);
  await game.manager.processZoneSchedules();
  await game.pingInsideZone("Ruby");
  assert.strictEqual((await game.target("Ruby")).zone_index, 2, "zone 3 is locked until minute 23");
  assert.strictEqual((await game.player("Ruby")).shield_active, 1, "waiting out a lock costs nothing");

  await game.setElapsed(23);
  await game.pingInsideZone("Ruby");
  assert.strictEqual((await game.target("Ruby")).zone_index, 3);
});

test("the host's zone lock is kept with the room and sent to everyone", async () => {
  const game = await createGame({ zoneLock: 5 });
  assert.strictEqual((await game.room()).zone_lock, 5);

  game.players.Hank.socket.fire("resync_game_state", { roomId: game.roomId });
  await settle();
  assert.strictEqual(game.players.Hank.socket.lastState().zoneLockMs, 5 * MINUTE);
});

test("a lock longer than half a window is cut down to half", async () => {
  // 30 minute game, so 5 minute windows
  const game = await createGame({ gameDuration: 30, zoneLock: 4 });
  const room = await game.room();
  const target = await game.target("Ruby");

  assert.strictEqual(target.activation_time, room.game_start_time + 2 * MINUTE);

  game.players.Hank.socket.fire("resync_game_state", { roomId: game.roomId });
  await settle();
  assert.strictEqual(game.players.Hank.socket.lastState().zoneLockMs, 2 * MINUTE);
});

test("with no zone lock, zone 1 is open from the start", async () => {
  const game = await createGame({ zoneLock: 0 });

  await game.pingInsideZone("Ruby");
  assert.strictEqual((await game.target("Ruby")).zone_index, 1);
});

test("capturing a zone in its window reveals the next one, locked until its own window", async () => {
  const game = await createGame();

  await game.setElapsed(4);
  await game.pingInsideZone("Ruby");

  const target = await game.target("Ruby");
  assert.strictEqual(target.zone_index, 1, "the next zone should be revealed straight away");
  assert.strictEqual(target.radius_level, config.game.targetRadiusLevels[1]);
  assert.strictEqual(zoneUtils.zoneStatusAt(Date.now(), { openTime: target.activation_time, closeTime: target.window_close_time }), "locked", "zone 2 is not capturable until minute 13");

  const captured = game.players.Ruby.socket.received("zone_captured");
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].payload.capturedZoneNumber, 1);
  assert.strictEqual(captured[0].payload.zoneNumber, 2);
});

test("being in the right place at the wrong time captures nothing", async () => {
  const game = await createGame();

  // Capture zone 1, then sit inside zone 2 before its window opens
  await game.setElapsed(4);
  await game.pingInsideZone("Ruby");
  await game.pingInsideZone("Ruby");

  const target = await game.target("Ruby");
  assert.strictEqual(target.zone_index, 1, "a locked zone cannot be captured early");
});

test("a zone window closing uncaptured puts a runner out, even with their shield", async () => {
  const game = await createGame();

  await game.setElapsed(11);
  await game.manager.processZoneSchedules();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.team, "hunter", "the shield only covers catches");
  assert.strictEqual(runner.status, "caught");
  assert.strictEqual(runner.elimination_reason, "missed_zone");

  // The shield was never spent - it just didn't come into it
  assert.strictEqual(runner.shield_active, 1);
  assert.strictEqual(runner.shield_lost_reason, null);
  assert.strictEqual(game.of("shield_lost").length, 0);

  const caught = game.of("runner_caught");
  assert.strictEqual(caught.length, 1);
  assert.strictEqual(caught[0].payload.reason, "missed_zone");
  assert.strictEqual(caught[0].payload.zoneNumber, 1);
});

test("a runner who has lost their shield to a catch is put out by a missed zone too", async () => {
  const game = await createGame();

  game.players.Ruby.socket.fire("player_caught", { caughtPlayerId: game.players.Ruby.playerId });
  await settle();

  await game.setElapsed(11);
  await game.manager.processZoneSchedules();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.team, "hunter");
  assert.strictEqual(runner.elimination_reason, "missed_zone");
});

test("a runner who captured their zone keeps their shield when the window rolls over", async () => {
  const game = await createGame();

  await game.setElapsed(4);
  await game.pingInsideZone("Ruby");
  await game.setElapsed(11);
  await game.manager.processZoneSchedules();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.shield_active, 1, "capturing zone 1 in time should cost nothing");

  const target = await game.target("Ruby");
  assert.strictEqual(target.zone_index, 1, "they stay on the zone they were already shown");
});

test("a window missed while the server was down still puts the runner out when it comes back", async () => {
  const game = await createGame();

  // Two windows pass before the schedule is next processed
  await game.setElapsed(25);
  await game.manager.processZoneSchedules();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.team, "hunter");
  assert.strictEqual(runner.status, "caught");
  assert.strictEqual(runner.elimination_reason, "missed_zone");
  assert.strictEqual(runner.shield_lost_reason, null, "going out over zone 1 isn't keeping a shield until it ran out");
  assert.strictEqual(game.of("runner_caught").length, 1, "they only go out once");
  assert.strictEqual(game.of("shields_expired").length, 0);
});

test("the first catch takes the shield and buys immunity", async () => {
  const game = await createGame({ catchImmunity: 3 });
  const before = Date.now();

  game.players.Ruby.socket.fire("player_caught", { caughtPlayerId: game.players.Ruby.playerId });
  await settle();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.shield_active, 0);
  assert.strictEqual(runner.shield_lost_reason, "caught");
  assert.strictEqual(runner.team, "runner", "a shielded runner survives being caught");
  assert.ok(runner.immunity_until >= before + 3 * MINUTE, "they should be immune for the configured three minutes");

  const lost = game.of("shield_lost");
  assert.strictEqual(lost.length, 1);
  assert.strictEqual(lost[0].payload.reason, "caught");
});

test("catching an immune runner is refused", async () => {
  const game = await createGame({ catchImmunity: 3 });

  game.players.Ruby.socket.fire("player_caught", { caughtPlayerId: game.players.Ruby.playerId });
  await settle();

  game.players.Hank.socket.fire("player_caught", { caughtPlayerId: game.players.Ruby.playerId });
  await settle();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.team, "runner", "immunity should hold off a second catch");

  const rejected = game.players.Hank.socket.received("catch_rejected");
  assert.strictEqual(rejected.length, 1);
  assert.strictEqual(rejected[0].payload.username, "Ruby");
});

test("a catch once immunity has run out puts the runner out", async () => {
  const game = await createGame({ catchImmunity: 3 });

  game.players.Ruby.socket.fire("player_caught", { caughtPlayerId: game.players.Ruby.playerId });
  await settle();

  // Their immunity expires
  await game.run("UPDATE players SET immunity_until = ? WHERE player_id = ?", [Date.now() - 1, game.players.Ruby.playerId]);

  game.players.Hank.socket.fire("player_caught", { caughtPlayerId: game.players.Ruby.playerId });
  await settle();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.team, "hunter");
  assert.strictEqual(runner.elimination_reason, "caught");
});

test("the last runner going out ends the game", async () => {
  const game = await createGame();

  game.players.Ruby.socket.fire("player_caught", { caughtPlayerId: game.players.Ruby.playerId });
  await settle();
  await game.run("UPDATE players SET immunity_until = NULL WHERE player_id = ?", [game.players.Ruby.playerId]);
  game.players.Hank.socket.fire("player_caught", { caughtPlayerId: game.players.Ruby.playerId });
  await settle();

  assert.strictEqual(game.of("game_over").length, 1);
  assert.strictEqual((await game.room()).status, "completed");
});

test("capturing the final zone in its window wins the game", async () => {
  const game = await createGame();

  // Put the runner on the final zone, with its window open
  await game.run("UPDATE targets SET zone_index = ?, radius_level = ? WHERE player_id = ?", [ZONE_COUNT - 1, config.game.targetRadiusLevels[ZONE_COUNT - 1], game.players.Ruby.playerId]);
  await game.setElapsed(55);

  await game.pingInsideZone("Ruby");

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.status, "won");

  const target = await game.target("Ruby");
  assert.strictEqual(target.status, "reached");
  assert.ok(target.reached_at);
});

test("one runner winning doesn't end the game while others are still running", async () => {
  const game = await createGame({ runners: ["Ruby", "Sam"] });

  // Ruby is on the final zone with its window open; Sam is nowhere near
  await game.run("UPDATE targets SET zone_index = ?, radius_level = ? WHERE player_id = ?", [ZONE_COUNT - 1, config.game.targetRadiusLevels[ZONE_COUNT - 1], game.players.Ruby.playerId]);
  await game.setElapsed(55);
  await game.pingInsideZone("Ruby");

  assert.strictEqual((await game.player("Ruby")).status, "won");
  assert.strictEqual((await game.room()).status, "active", "Sam is still out there, so the game goes on");
  assert.strictEqual(game.of("game_over").length, 0);
  assert.strictEqual(game.of("runner_won").length, 1);

  // Once the last runner still running goes out, it is over
  game.players.Sam.socket.fire("player_caught", { caughtPlayerId: game.players.Sam.playerId });
  await settle();
  await game.run("UPDATE players SET immunity_until = NULL WHERE player_id = ?", [game.players.Sam.playerId]);
  game.players.Hank.socket.fire("player_caught", { caughtPlayerId: game.players.Sam.playerId });
  await settle();

  assert.strictEqual((await game.room()).status, "completed");
  assert.strictEqual(game.of("game_over").length, 1);
});

test("a runner who has won stays where they finished, rather than giving the final zone away", async () => {
  const game = await createGame({ runners: ["Ruby", "Sam"] });

  await game.run("UPDATE targets SET zone_index = ?, radius_level = ? WHERE player_id = ?", [ZONE_COUNT - 1, config.game.targetRadiusLevels[ZONE_COUNT - 1], game.players.Ruby.playerId]);
  await game.setElapsed(55);
  await game.pingInsideZone("Ruby");

  const finished = await game.player("Ruby");
  const sightings = game.of("runner_location").filter((entry) => entry.payload.playerId === game.players.Ruby.playerId).length;

  // Ruby wanders off after winning
  game.players.Ruby.socket.fire("location_update", { lat: CENTRE.lat + 0.01, lng: CENTRE.lng + 0.01 });
  await settle();

  const after = await game.player("Ruby");
  assert.strictEqual(after.last_lat, finished.last_lat, "their position stays where they won");
  assert.strictEqual(after.last_lng, finished.last_lng);
  assert.strictEqual(game.of("runner_location").filter((entry) => entry.payload.playerId === game.players.Ruby.playerId).length, sightings, "nobody is sent where they are now");
});

test("the game ends when the clock runs out, and stragglers miss the final zone on the way", async () => {
  // Shields that last the whole game, which still can't save a missed zone
  const game = await createGame({ shieldZones: ZONE_COUNT });

  // Capture every zone but the last, so only the final window is missed
  await game.run("UPDATE targets SET zone_index = ?, radius_level = ? WHERE player_id = ?", [ZONE_COUNT - 1, config.game.targetRadiusLevels[ZONE_COUNT - 1], game.players.Ruby.playerId]);
  await game.setElapsed(61);
  await game.manager.processZoneSchedules();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.status, "caught", "the final window closed uncaptured");
  assert.strictEqual(runner.elimination_reason, "missed_zone");
  assert.strictEqual((await game.target("Ruby")).status, "active", "their final target was never reached");

  const over = game.of("game_over");
  assert.strictEqual(over.length, 1);
  assert.strictEqual((await game.room()).status, "completed");
});

// Capture zones 1 and 2 inside their windows, which leaves the clock at minute
// 14 and each runner on zone 3 - the shape of a game where they are still
// holding their shield when shields run out at minute 20
async function captureFirstTwoZones(game, ...usernames) {
  await game.setElapsed(4);
  for (const username of usernames) await game.pingInsideZone(username);

  await game.setElapsed(14);
  for (const username of usernames) await game.pingInsideZone(username);
}

// A point the given distance and bearing from the middle of the target area
function awayFromCentre(bearing, metres) {
  return geoUtils.calculateDestination(CENTRE.lat, CENTRE.lng, bearing, metres);
}

test("shields run out for everyone still holding one when zone 2 closes", async () => {
  const game = await createGame({ runners: ["Ruby", "Sam"] });
  await captureFirstTwoZones(game, "Ruby", "Sam");

  // Sam is caught during zone 2, so has no shield left to keep. Everyone can
  // see where he lost it - checked now, since winding the clock on moves the
  // game's start and with it which window the catch looks to have been in.
  game.players.Sam.socket.fire("player_caught", { caughtPlayerId: game.players.Sam.playerId });
  await settle();

  game.players.Hank.socket.fire("resync_game_state", { roomId: game.roomId });
  await settle();
  assert.strictEqual(game.players.Hank.socket.lastState().players.find((player) => player.username === "Sam").shieldLostZone, 2);

  await game.setElapsed(19);
  await game.manager.processZoneSchedules();
  assert.strictEqual((await game.player("Ruby")).shield_active, 1, "shields hold until zone 2 closes");
  assert.strictEqual(game.of("shields_expired").length, 0);

  await game.setElapsed(20);
  await game.manager.processZoneSchedules();

  const ruby = await game.player("Ruby");
  assert.strictEqual(ruby.shield_active, 0);
  assert.strictEqual(ruby.shield_lost_reason, "expired");
  assert.strictEqual(ruby.immunity_until, null, "running out buys no immunity");
  assert.strictEqual(ruby.team, "runner", "and costs them nothing else");
  assert.strictEqual(ruby.status, "active");
  assert.strictEqual((await game.player("Sam")).shield_lost_reason, "caught");

  const room = await game.room();
  const expired = game.of("shields_expired");
  assert.strictEqual(expired.length, 1);
  assert.strictEqual(expired[0].payload.zoneNumber, 2);
  assert.deepStrictEqual(expired[0].payload.players, [{ playerId: game.players.Ruby.playerId, username: "Ruby" }], "only the runner who kept theirs goes invisible");
  assert.strictEqual(expired[0].payload.invisibleUntil, room.game_start_time + 23 * MINUTE);

  // It only happens once
  await game.manager.processZoneSchedules();
  assert.strictEqual(game.of("shields_expired").length, 1);

  // Everyone is told who is invisible, and who lost their shield where
  game.players.Hank.socket.fire("resync_game_state", { roomId: game.roomId });
  await settle();

  const state = game.players.Hank.socket.lastState();
  const rubyState = state.players.find((player) => player.username === "Ruby");
  const samState = state.players.find((player) => player.username === "Sam");
  assert.strictEqual(state.shieldZones, 2);
  assert.strictEqual(state.shieldDeadline, room.game_start_time + 20 * MINUTE);
  assert.strictEqual(state.invisibility, 3);
  assert.strictEqual(rubyState.shieldLostReason, "expired");
  assert.strictEqual(rubyState.invisibleUntil, room.game_start_time + 23 * MINUTE);
  assert.strictEqual(samState.shieldLostReason, "caught");
  assert.strictEqual(samState.invisibleUntil, null);
});

test("a runner who kept their shield can capture zones while invisible, without anyone seeing where", async () => {
  // Invisible from minute 20 to 25, and zone 3 opens at 23
  const game = await createGame({ invisibility: 5 });
  await captureFirstTwoZones(game, "Ruby");
  const lastSeen = await game.player("Ruby");

  await game.setElapsed(20);
  await game.manager.processZoneSchedules();

  const sightings = () => game.of("runner_location").filter((entry) => entry.payload.playerId === game.players.Ruby.playerId).length;
  const before = sightings();

  await game.setElapsed(24);
  await game.pingInsideZone("Ruby");

  assert.strictEqual((await game.target("Ruby")).zone_index, 3, "the ping still captured zone 3");
  assert.strictEqual(game.players.Ruby.socket.received("zone_captured").length, 3);
  assert.strictEqual(sightings(), before, "nobody is sent where they are");

  const after = await game.player("Ruby");
  assert.strictEqual(after.last_lat, lastSeen.last_lat, "the location everyone is shown stays where they were last seen");
  assert.strictEqual(after.last_lng, lastSeen.last_lng);
  assert.strictEqual(after.last_ping_time, lastSeen.last_ping_time);

  game.players.Hank.socket.fire("resync_game_state", { roomId: game.roomId });
  await settle();

  const rubyState = game.players.Hank.socket.lastState().players.find((player) => player.username === "Ruby");
  assert.deepStrictEqual(rubyState.location, { lat: lastSeen.last_lat, lng: lastSeen.last_lng });
});

test("once invisibility is over a runner is seen again, with a gap in their trail where they were invisible", async () => {
  const game = await createGame();
  await captureFirstTwoZones(game, "Ruby");

  await game.setElapsed(20);
  await game.manager.processZoneSchedules();
  await game.setElapsed(24);

  // Lay out Ruby's history on the clock: seen at minutes 18 and 19, then
  // somewhere else entirely at 21 and 22 while invisible
  const start = (await game.room()).game_start_time;
  const rubyId = game.players.Ruby.playerId;
  const seen = [awayFromCentre(0, 300), awayFromCentre(0, 350)];
  const hidden = [awayFromCentre(180, 300), awayFromCentre(180, 350)];

  await game.run("DELETE FROM location_history WHERE player_id = ?", [rubyId]);
  for (const [point, minute] of [
    [seen[0], 18],
    [seen[1], 19],
    [hidden[0], 21],
    [hidden[1], 22],
  ]) {
    await game.run("INSERT INTO location_history (player_id, room_id, lat, lng, timestamp) VALUES (?, ?, ?, ?, ?)", [rubyId, game.roomId, point.lat, point.lng, start + minute * MINUTE]);
  }
  await game.run("UPDATE players SET last_lat = ?, last_lng = ?, last_ping_time = ? WHERE player_id = ?", [seen[1].lat, seen[1].lng, start + 19 * MINUTE, rubyId]);

  const now = awayFromCentre(90, 300);
  game.players.Ruby.socket.fire("location_update", { lat: now.lat, lng: now.lng });
  await settle();

  const shared = game.of("runner_location").filter((entry) => entry.payload.playerId === rubyId);
  const latest = shared[shared.length - 1].payload;
  assert.deepStrictEqual(latest.location, { lat: now.lat, lng: now.lng }, "they are shown where they are again");

  const points = latest.trail.sightings.flatMap((sighting) => sighting.points);
  const nearest = (point) => Math.min(...points.map(([lat, lng]) => geoUtils.calculateDistance(lat, lng, point.lat, point.lng)));

  assert.ok(nearest(seen[0]) < 5, "where they were seen before is still on the trail");
  assert.ok(nearest(now) < 5);
  for (const point of hidden) {
    assert.ok(nearest(point) > 100, "nothing from while they were invisible is on the trail");
  }
  assert.ok(latest.trail.sightings.length >= 2, "the trail breaks across the invisible spell");
});

test("hunters are never invisible, even though nobody took a shield off them", async () => {
  const game = await createGame();
  await captureFirstTwoZones(game, "Ruby");

  await game.setElapsed(21);
  await game.manager.processZoneSchedules();

  const spot = awayFromCentre(45, 200);
  game.players.Hank.socket.fire("location_update", { lat: spot.lat, lng: spot.lng });
  await settle();

  const hank = game.of("runner_location").filter((entry) => entry.payload.playerId === game.players.Hank.playerId);
  assert.strictEqual(hank.length, 1);
  assert.deepStrictEqual(hank[0].payload.location, { lat: spot.lat, lng: spot.lng });
});

test("with invisibility off, a runner who kept their shield just loses it", async () => {
  const game = await createGame({ invisibility: 0 });
  await captureFirstTwoZones(game, "Ruby");
  const sightings = () => game.of("runner_location").filter((entry) => entry.payload.playerId === game.players.Ruby.playerId).length;

  await game.setElapsed(21);
  await game.manager.processZoneSchedules();

  assert.strictEqual((await game.player("Ruby")).shield_lost_reason, "expired");
  assert.strictEqual(game.of("shields_expired")[0].payload.invisibleUntil, null);

  const before = sightings();
  const spot = awayFromCentre(45, 200);
  game.players.Ruby.socket.fire("location_update", { lat: spot.lat, lng: spot.lng });
  await settle();

  assert.strictEqual(sightings(), before + 1, "their ping is shared as usual");
});

test("getting caught after shields have run out puts a runner out", async () => {
  const game = await createGame();
  await captureFirstTwoZones(game, "Ruby");

  await game.setElapsed(21);
  await game.manager.processZoneSchedules();

  // Invisible, but found anyway
  game.players.Hank.socket.fire("player_caught", { caughtPlayerId: game.players.Ruby.playerId });
  await settle();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.team, "hunter");
  assert.strictEqual(runner.elimination_reason, "caught");
});

test("a runner joining a game under way gets a shield only while everyone else still has theirs", async () => {
  const game = await createGame();

  await game.setElapsed(5);
  const early = game.connect("socket-Early");
  early.fire("join_room", { roomName: "test-room", username: "Early", team: "runner" });
  await settle();
  assert.strictEqual((await game.player("Early")).shield_active, 1);

  await game.setElapsed(21);
  const late = game.connect("socket-Late");
  late.fire("join_room", { roomName: "test-room", username: "Late", team: "runner" });
  await settle();
  assert.strictEqual((await game.player("Late")).shield_active, 0, "shields have already run out");
});

test("with shields set to none, runners start without one and a single catch puts them out", async () => {
  const game = await createGame({ shieldZones: 0 });

  assert.strictEqual((await game.player("Ruby")).shield_active, 0);

  game.players.Hank.socket.fire("player_caught", { caughtPlayerId: game.players.Ruby.playerId });
  await settle();

  assert.strictEqual((await game.player("Ruby")).team, "hunter");
  assert.strictEqual(game.of("shields_expired").length, 0);
});

test("with shields covering every zone, they never run out", async () => {
  const game = await createGame({ shieldZones: ZONE_COUNT });

  // Keep Ruby on the zone the clock is on, well past where shields usually end
  await game.run("UPDATE targets SET zone_index = 4, radius_level = ? WHERE player_id = ?", [config.game.targetRadiusLevels[4], game.players.Ruby.playerId]);
  await game.setElapsed(45);
  await game.manager.processZoneSchedules();

  assert.strictEqual((await game.player("Ruby")).shield_active, 1);
  assert.strictEqual(game.of("shields_expired").length, 0);
});

test("the host's shield settings are kept with the room, and kept sensible", async () => {
  const game = await createGame({ shieldZones: 3, invisibility: 5 });
  const room = await game.room();
  assert.strictEqual(room.shield_zones, 3);
  assert.strictEqual(room.invisibility, 5);

  game.players.Hank.socket.fire("resync_game_state", { roomId: game.roomId });
  await settle();
  assert.strictEqual(game.players.Hank.socket.lastState().shieldDeadline, room.game_start_time + 30 * MINUTE);

  const extreme = await createGame({ shieldZones: 99, invisibility: -4 });
  const extremeRoom = await extreme.room();
  assert.strictEqual(extremeRoom.shield_zones, ZONE_COUNT, "no more zones than the game has");
  assert.strictEqual(extremeRoom.invisibility, 0);
});

test("how far every runner has got is public, but never where their zones are", async () => {
  const game = await createGame({ runners: ["Ruby", "Sam"] });

  // Four minutes in, zone 1's lock is up and Ruby captures it
  await game.setElapsed(4);
  await game.pingInsideZone("Ruby");

  game.players.Hank.socket.fire("resync_game_state", { roomId: game.roomId });
  await settle();

  const state = game.players.Hank.socket.lastState();
  const of = (username) => state.players.find((player) => player.username === username);

  assert.strictEqual(of("Ruby").zonesCaptured, 1, "Ruby captured zone 1");
  assert.strictEqual(of("Ruby").currentZone, 2, "which puts her on zone 2");
  assert.strictEqual(of("Sam").zonesCaptured, 0, "Sam is still on his first");
  assert.strictEqual(of("Sam").currentZone, 1);

  // Hunters have zones of neither their own nor anybody else's
  assert.strictEqual(of("Hank").zonesCaptured, null);
  assert.strictEqual(of("Hank").currentZone, null);
  assert.deepStrictEqual(state.targets, [], "a hunter is sent no zones at all");

  // Nothing in a player row says where anyone's zones are
  state.players.forEach((player) => {
    assert.ok(!("zones" in player) && !("target" in player), `${player.username} should carry no zone of their own`);
  });

  // A runner is sent the same progress for everyone, and zones only for themselves
  game.players.Sam.socket.fire("resync_game_state", { roomId: game.roomId });
  await settle();

  const samState = game.players.Sam.socket.lastState();
  assert.strictEqual(samState.players.find((player) => player.username === "Ruby").zonesCaptured, 1);
  assert.strictEqual(samState.targets.length, 1);
  assert.strictEqual(samState.targets[0].playerId, game.players.Sam.playerId, "only his own zone");
});

test("a runner who captured the final zone shows every zone captured", async () => {
  const game = await createGame({ runners: ["Ruby"] });

  // On the last zone, inside its window
  await game.run("UPDATE targets SET zone_index = ?, radius_level = ? WHERE player_id = ?", [ZONE_COUNT - 1, config.game.targetRadiusLevels[ZONE_COUNT - 1], game.players.Ruby.playerId]);
  await game.setElapsed(55);
  await game.pingInsideZone("Ruby");

  game.players.Hank.socket.fire("resync_game_state", { roomId: game.roomId });
  await settle();

  const ruby = game.players.Hank.socket.lastState().players.find((player) => player.username === "Ruby");

  assert.strictEqual(ruby.status, "won");
  assert.strictEqual(ruby.zonesCaptured, ZONE_COUNT);
  assert.strictEqual(ruby.currentZone, null, "there is no next zone to be on");
});

/**
 * Tests for zone windows and shields, driven through the real socket handlers
 * against an in-memory database.
 *
 * The rules being pinned down: a zone can only be captured inside its own
 * window, and not until the lock at the start of that window has run out; a
 * window that closes uncaptured costs the runner their shield, and a
 * catch costs the same single shield - so the second of either, in any order,
 * puts a runner out. Spending the shield on a catch also buys a spell of
 * immunity, which the server, not the client, has to enforce.
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
async function createGame({ runners = ["Ruby"], hunters = ["Hank"], gameDuration = 60, zoneLock = 3, catchImmunity = 3 } = {}) {
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
  const game = await createGame();

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

test("a zone window closing uncaptured costs the shield, not the game", async () => {
  const game = await createGame();

  await game.setElapsed(11);
  await game.manager.processZoneSchedules();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.shield_active, 0, "the missed zone should have taken the shield");
  assert.strictEqual(runner.shield_lost_reason, "missed_zone");
  assert.strictEqual(runner.team, "runner", "they are still in the game");
  assert.strictEqual(runner.status, "active");

  // A missed zone is not a catch, so it buys no immunity
  assert.strictEqual(runner.immunity_until, null);

  const lost = game.of("shield_lost");
  assert.strictEqual(lost.length, 1);
  assert.strictEqual(lost[0].payload.reason, "missed_zone");
  assert.strictEqual(lost[0].payload.zoneNumber, 1);

  // They are moved on to the zone the clock is now on, so they can keep playing
  const target = await game.target("Ruby");
  assert.strictEqual(target.zone_index, 1);
  assert.strictEqual(target.radius_level, config.game.targetRadiusLevels[1]);

  // Which is still in its lock, and they are told when it opens
  const room = await game.room();
  assert.strictEqual(target.activation_time, room.game_start_time + 13 * MINUTE);

  const missed = game.players.Ruby.socket.received("zone_missed");
  assert.strictEqual(missed.length, 1);
  assert.strictEqual(missed[0].payload.windowOpenTime, target.activation_time);
});

test("a second missed zone puts a runner out and onto the hunters", async () => {
  const game = await createGame();

  await game.setElapsed(11);
  await game.manager.processZoneSchedules();

  await game.setElapsed(21);
  await game.manager.processZoneSchedules();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.team, "hunter");
  assert.strictEqual(runner.status, "caught");
  assert.strictEqual(runner.elimination_reason, "missed_zone");

  const caught = game.of("runner_caught");
  assert.strictEqual(caught.length, 1);
  assert.strictEqual(caught[0].payload.reason, "missed_zone");
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

test("windows missed while the server was down are caught up one life at a time", async () => {
  const game = await createGame();

  // Two windows pass before the schedule is next processed
  await game.setElapsed(25);
  await game.manager.processZoneSchedules();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.team, "hunter", "two missed windows is two strikes");
  assert.strictEqual(runner.status, "caught");
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

test("the shield is shared: a missed zone then a catch puts a runner out", async () => {
  const game = await createGame();

  await game.setElapsed(11);
  await game.manager.processZoneSchedules();

  game.players.Ruby.socket.fire("player_caught", { caughtPlayerId: game.players.Ruby.playerId });
  await settle();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.team, "hunter", "the shield was already spent on the missed zone");
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

test("the game ends when the clock runs out, and stragglers lose a life on the way", async () => {
  const game = await createGame();

  // Capture every zone but the last, so only the final window is missed
  await game.run("UPDATE targets SET zone_index = ?, radius_level = ? WHERE player_id = ?", [ZONE_COUNT - 1, config.game.targetRadiusLevels[ZONE_COUNT - 1], game.players.Ruby.playerId]);
  await game.setElapsed(61);
  await game.manager.processZoneSchedules();

  const runner = await game.player("Ruby");
  assert.strictEqual(runner.shield_active, 0, "the final window closed uncaptured");

  // A shield saves them from becoming a hunter, but it cannot win them the
  // game: only capturing the final zone inside its window does that
  assert.strictEqual(runner.team, "runner");
  assert.strictEqual(runner.status, "active");
  assert.notStrictEqual(runner.status, "won");
  assert.strictEqual((await game.target("Ruby")).status, "active", "their final target was never reached");

  const over = game.of("game_over");
  assert.strictEqual(over.length, 1);
  assert.strictEqual((await game.room()).status, "completed");
});

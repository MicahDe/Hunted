/**
 * Tests for getting into, out of and back into a room, driven through the real
 * socket handlers against an in-memory database.
 *
 * The rules being pinned down: a player is only ever in a room once, however
 * many times their join is sent; closing the app (a dropped connection) never
 * takes anyone out of a room, but leaving on purpose does; and the host is
 * whoever the server says it is, handed on when the host leaves.
 */

const test = require("node:test");
const assert = require("node:assert");
const sqlite3 = require("sqlite3");

const socketManager = require("../server/socket/socketManager");
const { initDatabase } = require("../server/db/schema");
const config = require("../server/config/default");

const MINUTE = 60 * 1000;
const CENTRE = { lat: 51.5074, lng: -0.1278 };

/**
 * A server with the real handlers, and a stand-in for Socket.IO that delivers
 * room broadcasts to whichever sockets are in the room at the time, so a test
 * can tell who heard what.
 */
function createServer() {
  const db = new sqlite3.Database(":memory:");
  initDatabase(db);

  const sockets = new Map();
  const rooms = new Map();
  let connections = 0;

  const deliver = (room, event, payload, exceptId = null) => {
    [...(rooms.get(room) || [])].forEach((id) => {
      if (id !== exceptId && sockets.has(id)) {
        sockets.get(id).emitted.push({ event, payload });
      }
    });
  };

  const io = {
    on: (event, handler) => {
      io.connectionHandler = handler;
    },
    to: (room) => ({ emit: (event, payload) => deliver(room, event, payload) }),
    sockets: { sockets },
  };

  const manager = socketManager(io, db);

  // A phone's connection. fire() runs the handlers for an event and resolves
  // once they have finished.
  const connect = (name = "phone") => {
    const handlers = {};
    const id = `${name}-${++connections}`;

    const socket = {
      id,
      emitted: [],
      on: (event, handler) => {
        (handlers[event] = handlers[event] || []).push(handler);
      },
      emit: (event, payload) => socket.emitted.push({ event, payload }),
      join: (room) => {
        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(id);
      },
      leave: (room) => {
        if (rooms.has(room)) rooms.get(room).delete(id);
      },
      to: (room) => ({
        emit: (event, payload) => deliver(room, event, payload, id),
        volatile: { emit: (event, payload) => deliver(room, event, payload, id) },
      }),
      fire: (event, payload, ack) => Promise.all((handlers[event] || []).map((handler) => handler(payload, ack))),

      // The connection drops: the app was closed, or lost signal
      drop: async () => {
        sockets.delete(id);
        rooms.forEach((members) => members.delete(id));
        await socket.fire("disconnect", "transport close");
      },

      received: (event) => socket.emitted.filter((entry) => entry.event === event).map((entry) => entry.payload),
      last: (event) => {
        const all = socket.received(event);
        return all.length ? all[all.length - 1] : null;
      },
      clear: () => {
        socket.emitted = [];
      },
    };

    sockets.set(id, socket);
    io.connectionHandler(socket);

    return socket;
  };

  const all = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });

  const get = async (sql, params = []) => (await all(sql, params))[0];

  const run = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, (err) => (err ? reject(err) : resolve()));
    });

  const server = {
    db,
    manager,
    connect,
    all,
    get,
    run,

    room: (name) => get("SELECT * FROM rooms WHERE room_name = ?", [name]),
    players: (roomId) => all("SELECT * FROM players WHERE room_id = ? ORDER BY rowid", [roomId]),

    // What a phone does when the host fills in the create form
    create: async (socket, roomName, username, overrides = {}) => {
      await socket.fire("create_room", {
        roomName,
        username,
        team: "hunter",
        gameDuration: 60,
        catchImmunity: 3,
        targetRadius: 400,
        centralLat: CENTRE.lat,
        centralLng: CENTRE.lng,
        ...overrides,
      });
      return socket.last("join_success");
    },

    join: async (socket, roomName, username, team = "hunter") => {
      await socket.fire("join_room", { roomName, username, team });
      return socket.last("join_success");
    },

    // What a reloaded or reconnected phone sends from its saved session
    rejoin: async (socket, session) => {
      await socket.fire("rejoin_room", { roomId: session.roomId, playerId: session.playerId });
      return socket.last("join_success");
    },

    leave: (socket) =>
      new Promise((resolve) => {
        socket.fire("leave_room", {}, resolve);
      }),
  };

  return server;
}

// Names of everyone in a player list
const names = (state) => state.players.map((player) => player.username).sort();

test("creating a room puts its creator in it as the host, once", async () => {
  const server = createServer();
  const host = server.connect("host");

  const joined = await server.create(host, "Park", "Micah");

  assert.ok(joined, "the creator should be put straight into the room");
  assert.deepStrictEqual(names(joined.gameState), ["Micah"]);
  assert.strictEqual(joined.gameState.hostPlayerId, joined.playerId);
  assert.strictEqual(joined.gameState.status, "lobby");

  const room = await server.room("Park");
  assert.strictEqual((await server.players(room.room_id)).length, 1);
});

test("creating a room twice over a flaky connection makes one room with one host", async () => {
  const server = createServer();
  const host = server.connect("host");

  // Both taps reach the server at once
  await Promise.all([server.create(host, "Park", "Micah"), server.create(host, "Park", "Micah")]);

  const room = await server.room("Park");
  const players = await server.players(room.room_id);
  assert.deepStrictEqual(
    players.map((player) => player.username),
    ["Micah"],
    "the host must not be in their own room twice",
  );
  assert.strictEqual(host.received("join_success").length, 1);

  const errors = host.received("error");
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /already exists/);
});

test("a room name that is taken is refused with a clear message, whatever its capitals", async () => {
  const server = createServer();
  await server.create(server.connect("host"), "Park", "Micah");

  const other = server.connect("other");
  await server.create(other, "park", "Sam");

  assert.strictEqual(other.last("join_success"), null);
  assert.match(other.last("error").message, /A room called "park" already exists/);
});

test("a join sent twice at once makes one player, not two", async () => {
  const server = createServer();
  await server.create(server.connect("host"), "Park", "Micah");

  const ruby = server.connect("ruby");
  await Promise.all([server.join(ruby, "Park", "Ruby", "runner"), server.join(ruby, "Park", "Ruby", "runner")]);

  const room = await server.room("Park");
  const rubies = (await server.players(room.room_id)).filter((player) => player.username === "Ruby");
  assert.strictEqual(rubies.length, 1, "the same join twice must not duplicate the player");
});

test("the same name with different capitals and spacing is the same player", async () => {
  const server = createServer();
  await server.create(server.connect("host"), "Park", "Micah");

  const phone = server.connect("ruby");
  const first = await server.join(phone, "Park", "Ruby", "runner");
  await phone.drop();

  const again = server.connect("ruby-again");
  const second = await server.join(again, " park ", "  ruby ", "runner");

  assert.strictEqual(second.playerId, first.playerId);
  assert.deepStrictEqual(names(second.gameState), ["Micah", "Ruby"]);
});

test("new players are announced, but players coming back are not", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  const ruby = server.connect("ruby");
  const session = await server.join(ruby, "Park", "Ruby", "runner");
  assert.strictEqual(host.received("player_joined").length, 1);
  assert.strictEqual(ruby.received("player_joined").length, 0, "nobody is told they joined themselves");

  await ruby.drop();
  await server.rejoin(server.connect("ruby"), session);
  assert.strictEqual(host.received("player_joined").length, 1, "a reconnect is not a new player");
});

test("leaving the lobby takes the player out of the room", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  const sam = server.connect("sam");
  await server.join(sam, "Park", "Sam", "runner");
  host.clear();

  const reply = await server.leave(sam);
  assert.deepStrictEqual(reply, { ok: true });

  const room = await server.room("Park");
  assert.deepStrictEqual(
    (await server.players(room.room_id)).map((player) => player.username),
    ["Micah"],
  );

  assert.strictEqual(host.last("player_left").username, "Sam");
  assert.deepStrictEqual(names(host.last("game_state")), ["Micah"], "everyone else's lobby drops them");

  // Nothing more from the room reaches the phone that left
  sam.clear();
  await server.join(server.connect("late"), "Park", "Late");
  assert.strictEqual(sam.emitted.length, 0);
});

test("a player who left can join again, once, on whichever team they choose", async () => {
  const server = createServer();
  await server.create(server.connect("host"), "Park", "Micah");

  const sam = server.connect("sam");
  await server.join(sam, "Park", "Sam", "runner");
  await server.leave(sam);

  const back = await server.join(sam, "Park", "Sam", "hunter");
  assert.deepStrictEqual(names(back.gameState), ["Micah", "Sam"]);
  assert.strictEqual(back.gameState.players.find((player) => player.username === "Sam").team, "hunter");
});

test("closing the app keeps a player in the lobby, shown as away until they are back", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  const ruby = server.connect("ruby");
  const session = await server.join(ruby, "Park", "Ruby", "runner");

  await ruby.drop();

  const room = await server.room("Park");
  assert.strictEqual((await server.players(room.room_id)).length, 2, "a dropped connection is not leaving");

  const away = host.last("game_state").players.find((player) => player.username === "Ruby");
  assert.strictEqual(away.connected, false);

  // The app is opened again, with its saved session
  const back = await server.rejoin(server.connect("ruby"), session);
  assert.strictEqual(back.playerId, session.playerId);

  const here = host.last("game_state").players.find((player) => player.username === "Ruby");
  assert.strictEqual(here.connected, true);
  assert.strictEqual((await server.players(room.room_id)).length, 2);
});

test("a name someone is still using is not handed to somebody else", async () => {
  const server = createServer();
  await server.create(server.connect("host"), "Park", "Micah");

  const ruby = server.connect("ruby");
  const real = await server.join(ruby, "Park", "Ruby", "runner");

  const imposter = server.connect("imposter");
  await server.join(imposter, "Park", "Ruby", "hunter");

  assert.strictEqual(imposter.last("join_success"), null);
  assert.match(imposter.last("error").message, /already in this room/);

  const player = (await server.players(real.gameState.roomId)).find((row) => row.player_id === real.playerId);
  assert.strictEqual(player.team, "runner", "the real Ruby's team is untouched");
});

test("a player whose app is closed can take their name back from another phone", async () => {
  const server = createServer();
  await server.create(server.connect("host"), "Park", "Micah");

  const oldPhone = server.connect("ruby");
  const first = await server.join(oldPhone, "Park", "Ruby", "runner");
  await oldPhone.drop();

  const newPhone = server.connect("ruby-new");
  const second = await server.join(newPhone, "Park", "Ruby", "runner");
  assert.strictEqual(second.playerId, first.playerId);
});

test("the host leaving hands the room to the next player", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  const sam = server.connect("sam");
  const samJoin = await server.join(sam, "Park", "Sam", "runner");

  await server.leave(host);

  assert.strictEqual(sam.last("player_left").newHostId, samJoin.playerId);
  assert.strictEqual(sam.last("game_state").hostPlayerId, samJoin.playerId);

  // And the new host can do host things
  const ruby = server.connect("ruby");
  await server.join(ruby, "Park", "Ruby", "runner");
  await sam.fire("start_game", {});
  assert.strictEqual(sam.received("game_started").length, 1);
});

test("the host prefers to hand over to someone who is actually here", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  const away = server.connect("away");
  await server.join(away, "Park", "Away");
  await away.drop();

  const sam = server.connect("sam");
  const samJoin = await server.join(sam, "Park", "Sam");

  await server.leave(host);
  assert.strictEqual(sam.last("game_state").hostPlayerId, samJoin.playerId);
});

test("the last player leaving a lobby closes it, and frees its name", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  await server.leave(host);
  assert.strictEqual(await server.room("Park"), undefined);

  const again = await server.create(server.connect("host2"), "Park", "Micah");
  assert.ok(again, "the name can be used again");
});

test("only the host can start the game", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  const ruby = server.connect("ruby");
  await server.join(ruby, "Park", "Ruby", "runner");

  await ruby.fire("start_game", {});
  assert.match(ruby.last("error").message, /Only the host/);
  assert.strictEqual((await server.room("Park")).status, "lobby");
});

test("a game can't start without a runner", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  await host.fire("start_game", {});
  assert.match(host.last("error").message, /At least one Runner/);
  assert.strictEqual((await server.room("Park")).status, "lobby");
});

test("a second tap on Start doesn't restart the game", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");
  await server.join(server.connect("ruby"), "Park", "Ruby", "runner");

  await host.fire("start_game", {});
  const started = await server.room("Park");

  await host.fire("start_game", {});
  const after = await server.room("Park");

  assert.strictEqual(after.game_start_time, started.game_start_time, "the clock must not restart");
  assert.strictEqual(after.final_lat, started.final_lat, "the final zone must not move");
  assert.strictEqual(after.final_lng, started.final_lng);

  const targets = await server.all("SELECT * FROM targets WHERE room_id = ?", [started.room_id]);
  assert.strictEqual(targets.length, 1);
  assert.strictEqual(host.received("game_started").length, 2, "the second tap is simply shown the game");
});

test("the host can take a player out of the lobby", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  const ghost = server.connect("ghost");
  const ghostJoin = await server.join(ghost, "Park", "Ghost", "runner");

  await host.fire("remove_player", { playerId: ghostJoin.playerId });

  assert.deepStrictEqual(names(host.last("game_state")), ["Micah"]);
  assert.ok(ghost.last("removed_from_room"), "the removed player is told");

  // Nobody else can
  const ruby = server.connect("ruby");
  const rubyJoin = await server.join(ruby, "Park", "Ruby", "runner");
  const sam = server.connect("sam");
  await server.join(sam, "Park", "Sam");
  await sam.fire("remove_player", { playerId: rubyJoin.playerId });

  assert.match(sam.last("error").message, /Only the host/);
  assert.deepStrictEqual(names(host.last("game_state")), ["Micah", "Ruby", "Sam"]);
});

test("rejoining a room that has been deleted fails cleanly", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  const ruby = server.connect("ruby");
  const session = await server.join(ruby, "Park", "Ruby", "runner");

  await host.fire("delete_room", {});
  assert.ok(ruby.last("room_deleted"));
  assert.ok(host.last("delete_success"));
  assert.strictEqual(host.received("room_deleted").length, 0, "the host is not told twice");

  const phone = server.connect("ruby-later");
  await server.rejoin(phone, session);
  assert.strictEqual(phone.last("join_success"), null);
  assert.match(phone.last("rejoin_failed").message, /no longer exists/);
});

test("rejoining after leaving on another phone fails cleanly", async () => {
  const server = createServer();
  await server.create(server.connect("host"), "Park", "Micah");

  const ruby = server.connect("ruby");
  const session = await server.join(ruby, "Park", "Ruby", "runner");
  await server.leave(ruby);

  const phone = server.connect("ruby-later");
  await server.rejoin(phone, session);
  assert.match(phone.last("rejoin_failed").message, /no longer in that room/);
});

test("joining another room leaves the first one behind", async () => {
  const server = createServer();
  await server.create(server.connect("host-a"), "First", "Alice");
  await server.create(server.connect("host-b"), "Second", "Bob");

  const ruby = server.connect("ruby");
  await server.join(ruby, "First", "Ruby", "runner");
  await server.join(ruby, "Second", "Ruby", "runner");
  ruby.clear();

  // Something happens in the first room
  await server.join(server.connect("late"), "First", "Late");
  assert.strictEqual(ruby.emitted.length, 0, "a phone only hears the room it is in");
});

test("a runner leaving mid-game forfeits, and the last one out ends the game", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  const ruby = server.connect("ruby");
  const rubyJoin = await server.join(ruby, "Park", "Ruby", "runner");
  await host.fire("start_game", {});

  await server.leave(ruby);

  const player = await server.get("SELECT * FROM players WHERE player_id = ?", [rubyJoin.playerId]);
  assert.strictEqual(player.status, "caught");
  assert.strictEqual(player.elimination_reason, "left");
  assert.ok(player.left_at);

  const over = host.last("game_over");
  assert.ok(over, "with no runners left the game is over");
  assert.strictEqual(over.gameState.players.find((row) => row.playerId === rubyJoin.playerId).outcome, "left");
});

test("closing the app mid-game changes nothing", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  const ruby = server.connect("ruby");
  const session = await server.join(ruby, "Park", "Ruby", "runner");
  await host.fire("start_game", {});

  await ruby.drop();

  const player = await server.get("SELECT * FROM players WHERE player_id = ?", [session.playerId]);
  assert.strictEqual(player.team, "runner");
  assert.strictEqual(player.status, "active");
  assert.strictEqual(player.left_at, null);
  assert.strictEqual(host.received("game_over").length, 0);

  const back = await server.rejoin(server.connect("ruby"), session);
  assert.strictEqual(back.gameState.status, "active");
  assert.strictEqual(back.gameState.targets.length, 1, "their zone is still waiting for them");
});

test("a runner who went out while their app was closed comes back as a hunter", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  const ruby = server.connect("ruby");
  const session = await server.join(ruby, "Park", "Ruby", "runner");
  await server.join(server.connect("sam"), "Park", "Sam", "runner");
  await host.fire("start_game", {});
  await ruby.drop();

  // Two windows go by with Ruby's app shut
  const room = await server.room("Park");
  await server.run("UPDATE rooms SET game_start_time = ? WHERE room_id = ?", [Date.now() - 25 * MINUTE, room.room_id]);
  await server.run("UPDATE targets SET activation_time = ?, window_close_time = ? WHERE room_id = ?", [Date.now() - 25 * MINUTE, Date.now() - 15 * MINUTE, room.room_id]);
  await server.manager.processZoneSchedules();

  const back = await server.rejoin(server.connect("ruby"), session);
  const me = back.gameState.players.find((player) => player.playerId === session.playerId);
  assert.strictEqual(me.team, "hunter");
  assert.strictEqual(me.outcome, "missed_zone");
  assert.deepStrictEqual(back.gameState.targets, [], "a hunter is shown no zones");
});

test("new players can't join a finished game, but its players can come back to the results", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  const ruby = server.connect("ruby");
  const session = await server.join(ruby, "Park", "Ruby", "runner");
  await host.fire("start_game", {});

  const room = await server.room("Park");
  await server.run("UPDATE rooms SET status = 'completed' WHERE room_id = ?", [room.room_id]);

  const stranger = server.connect("stranger");
  await server.join(stranger, "Park", "Stranger", "runner");
  assert.match(stranger.last("error").message, /already finished/);

  const back = await server.rejoin(server.connect("ruby"), session);
  assert.strictEqual(back.gameState.status, "completed");
});

test("a runner can only report themselves caught, and only in their own room", async () => {
  const server = createServer();
  const host = server.connect("host");
  await server.create(host, "Park", "Micah");

  const ruby = server.connect("ruby");
  const rubyJoin = await server.join(ruby, "Park", "Ruby", "runner");
  const sam = server.connect("sam");
  await server.join(sam, "Park", "Sam", "runner");
  await host.fire("start_game", {});

  // Sam tries to get Ruby caught
  await sam.fire("player_caught", { caughtPlayerId: rubyJoin.playerId });
  assert.match(sam.last("error").message, /Only a hunter or the runner themselves/);

  // A hunter in another room tries it too
  const outsider = server.connect("outsider");
  await server.create(outsider, "Elsewhere", "Olly");
  await outsider.fire("player_caught", { caughtPlayerId: rubyJoin.playerId });

  const player = await server.get("SELECT * FROM players WHERE player_id = ?", [rubyJoin.playerId]);
  assert.strictEqual(player.shield_active, 1, "nobody else's report counts");
});

test("a catch can't be reported before the game starts", async () => {
  const server = createServer();
  await server.create(server.connect("host"), "Park", "Micah");

  const ruby = server.connect("ruby");
  const rubyJoin = await server.join(ruby, "Park", "Ruby", "runner");

  await ruby.fire("player_caught", { caughtPlayerId: rubyJoin.playerId });
  assert.match(ruby.last("error").message, /isn't running/);
});

test("a ping from a phone that hasn't rejoined yet is ignored quietly", async () => {
  const server = createServer();
  const phone = server.connect("phone");

  await phone.fire("location_update", { lat: CENTRE.lat, lng: CENTRE.lng });
  assert.strictEqual(phone.received("error").length, 0, "a ping during a reconnect is not an error to show anyone");
});

test("names and room names are checked on the server", async () => {
  const server = createServer();
  const phone = server.connect("phone");

  await server.create(phone, "   ", "Micah");
  assert.match(phone.last("error").message, /required/);

  await server.create(phone, "Park", "x".repeat(config.security.maxUsernameLength + 1));
  assert.match(phone.last("error").message, /at most/);

  await server.create(phone, "Park", "Micah", { centralLat: null });
  assert.match(phone.last("error").message, /target area/);

  assert.strictEqual(await server.room("Park"), undefined);
});

test("player names are stored as typed, so the page can show them as text", async () => {
  const server = createServer();
  await server.create(server.connect("host"), "Park", "Micah");

  const joined = await server.join(server.connect("odd"), "Park", "<b>Bold</b>", "runner");
  assert.ok(joined.gameState.players.some((player) => player.username === "<b>Bold</b>"));
});

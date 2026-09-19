/**
 * Tests for the status screen: the screen a player lands on, which tells them
 * everything about the game except where anything is.
 *
 * The rules being pinned down: the clocks and everybody's progress are there
 * to read, and none of it - not a zone, not a player - carries a location. A
 * Runner can watch the game without the map, which is the only thing that
 * pings where they are.
 */

const test = require("node:test");
const assert = require("node:assert");

const zoneUtils = require("../shared/utils/zoneUtils");

const MINUTE = 60 * 1000;
const ZONE_COUNT = zoneUtils.DEFAULT_RADIUS_LEVELS.length;

// A place with digits distinctive enough to spot anywhere in the rendered text
const CENTRE = { lat: 51.5074, lng: -0.1278 };

/** The bits of a DOM element the status screen touches. */
class FakeElement {
  constructor(tag = "div", id = "") {
    this.tagName = tag;
    this.id = id;
    this.className = "";
    this.textContent = "";
    this.children = [];
    this.attributes = {};
    this.classes = new Set();
    this.style = {
      setProperty: (name, value) => {
        this.style[name] = value;
      },
    };

    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)),
    };
  }

  set innerHTML(value) {
    assert.strictEqual(value, "", "only clearing is supported");
    this.children = [];
  }

  get innerHTML() {
    return "";
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  prepend(child) {
    this.children.unshift(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  /** Everything this element and its children read as, top to bottom */
  text() {
    return [this.textContent, ...this.children.map((child) => (child.text ? child.text() : child.textContent))].join(" ").trim();
  }
}

const SCREEN_IDS = [
  "status-room-name",
  "status-game-clock",
  "status-zone-window",
  "status-shield-deadline-item",
  "status-shield-deadline",
  "status-your-team",
  "status-your-zone-item",
  "status-your-zone",
  "status-your-shield-item",
  "status-your-shield",
  "status-your-note",
  "status-hunter-list",
  "status-runner-list",
];

/** The status screen's markup, plus the globals it reads. */
function setupScreen() {
  const elements = new Map(SCREEN_IDS.map((id) => [id, new FakeElement("div", id)]));

  global.document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (value) => ({ textContent: String(value) }),
  };

  global.zoneUtils = zoneUtils;
  global.GameMap = { runnerColor: (index) => `colour-${index}` };

  delete require.cache[require.resolve("../public/js/ui")];
  global.UI = require("../public/js/ui");

  delete require.cache[require.resolve("../public/js/status")];
  const StatusScreen = require("../public/js/status");

  return {
    StatusScreen,
    at: (id) => elements.get(id),
    // Every word on the screen, so a test can check what is not on it
    allText: () => [...elements.values()].map((element) => element.text()).join(" | "),
  };
}

/**
 * A game in progress: 60 minutes over six zones, 3 minute lock, shields
 * lasting two zones. `elapsed` winds the clock on.
 */
function gameState({ elapsed = 4 * MINUTE, players = [], targets = null } = {}) {
  const windowMs = zoneUtils.zoneWindowMs(60, ZONE_COUNT);
  const gameStartTime = Date.now() - elapsed;

  return {
    roomId: "room-1",
    roomName: "test-room",
    zoneCount: ZONE_COUNT,
    zoneWindowMs: windowMs,
    zoneLockMs: 3 * MINUTE,
    gameStartTime,
    gameEndTime: zoneUtils.gameEndTime(gameStartTime, windowMs, ZONE_COUNT),
    shieldDeadline: zoneUtils.shieldDeadline(gameStartTime, windowMs, ZONE_COUNT, 2),
    centralLocation: CENTRE,
    targetRadius: 400,
    players,
    targets:
      targets === null
        ? [
            {
              targetId: "target-1",
              playerId: "ruby",
              location: { lat: CENTRE.lat, lng: CENTRE.lng },
              radiusLevel: 800,
              zoneNumber: 1,
              status: "active",
              windowOpenTime: gameStartTime + 3 * MINUTE,
              windowCloseTime: gameStartTime + windowMs,
            },
          ]
        : targets,
  };
}

function runner(overrides = {}) {
  return {
    playerId: "ruby",
    username: "Ruby",
    team: "runner",
    status: "active",
    shieldActive: true,
    immunityUntil: null,
    invisibleUntil: null,
    colorIndex: 0,
    connected: true,
    currentZone: 1,
    zonesCaptured: 0,
    location: { lat: CENTRE.lat, lng: CENTRE.lng },
    lastPingTime: Date.now(),
    ...overrides,
  };
}

function hunter(overrides = {}) {
  return {
    playerId: "hank",
    username: "Hank",
    team: "hunter",
    status: "active",
    shieldActive: false,
    colorIndex: null,
    connected: true,
    currentZone: null,
    zonesCaptured: null,
    location: { lat: CENTRE.lat, lng: CENTRE.lng },
    lastPingTime: Date.now(),
    ...overrides,
  };
}

test("nothing on the screen says where anybody or anything is", () => {
  const screen = setupScreen();
  const state = gameState({ players: [runner(), hunter()] });

  screen.StatusScreen.update(state, { playerId: "ruby", username: "Ruby", team: "runner" });

  const text = screen.allText();

  // The state it was given is full of coordinates; none of them reach the page
  ["51.5", "-0.12", "0.1278", "5074"].forEach((fragment) => {
    assert.ok(!text.includes(fragment), `the screen should not print ${fragment}: ${text}`);
  });

  // Zones are named by number, and by nothing else
  assert.ok(!text.includes("800"), "a zone's size gives away how close it is drawn");
});

test("the clocks count down: the game, the zone window and the shields", () => {
  const screen = setupScreen();

  // Four minutes into a 60 minute game, so zone 1 is open with 6 to run
  screen.StatusScreen.update(gameState({ players: [runner()] }), { playerId: "ruby", team: "runner" });

  assert.match(screen.at("status-game-clock").textContent, /^5[56]:\d\d$/, "56 minutes of the game left");
  assert.match(screen.at("status-zone-window").textContent, /^Zone 1\/6 · open 0[56]:\d\d$/);
  assert.match(screen.at("status-shield-deadline").textContent, /^1[56]:\d\d$/, "shields run out when zone 2 closes");

  // A minute in, zone 1 is still locked
  screen.StatusScreen.update(gameState({ elapsed: MINUTE, players: [runner()] }), { playerId: "ruby", team: "runner" });
  assert.match(screen.at("status-zone-window").textContent, /^Zone 1\/6 · locked 0[12]:\d\d$/);
});

test("shields that never run out mid-game leave the deadline off the screen", () => {
  const screen = setupScreen();
  const state = gameState({ players: [runner()] });
  state.shieldDeadline = null;

  screen.StatusScreen.update(state, { playerId: "ruby", team: "runner" });

  assert.strictEqual(screen.at("status-shield-deadline-item").style.display, "none");
});

test("a runner sees the zone they are on and what is left of their shield", () => {
  const screen = setupScreen();

  screen.StatusScreen.update(gameState({ players: [runner()] }), { playerId: "ruby", team: "runner" });

  assert.strictEqual(screen.at("status-your-team").textContent, "Runner");
  assert.match(screen.at("status-your-zone").textContent, /^Zone 1\/6 ⏳ 0[56]:\d\d$/);
  assert.strictEqual(screen.at("status-your-shield").textContent, "🛡 Shield");

  // Immunity and invisibility count down in the same place
  const immune = runner({ shieldActive: false, immunityUntil: Date.now() + 2 * MINUTE });
  screen.StatusScreen.update(gameState({ players: [immune] }), { playerId: "ruby", team: "runner" });
  assert.match(screen.at("status-your-shield").textContent, /^🛡 Immune 0[12]:\d\d$/);

  const invisible = runner({ shieldActive: false, invisibleUntil: Date.now() + 90 * 1000 });
  screen.StatusScreen.update(gameState({ players: [invisible] }), { playerId: "ruby", team: "runner" });
  assert.match(screen.at("status-your-shield").textContent, /^👻 Invisible 0[12]:\d\d$/);
});

test("a hunter has no zone or shield of their own to show", () => {
  const screen = setupScreen();

  screen.StatusScreen.update(gameState({ players: [runner(), hunter()], targets: [] }), { playerId: "hank", team: "hunter" });

  assert.strictEqual(screen.at("status-your-team").textContent, "Hunter");
  assert.strictEqual(screen.at("status-your-zone-item").style.display, "none");
  assert.strictEqual(screen.at("status-your-shield-item").style.display, "none");
});

test("every player is listed with how far they have got and their shield", () => {
  const screen = setupScreen();

  const players = [
    runner({ currentZone: 3, zonesCaptured: 2 }),
    runner({ playerId: "sam", username: "Sam", colorIndex: 1, shieldActive: false, currentZone: 1, zonesCaptured: 0 }),
    runner({ playerId: "tess", username: "Tess", colorIndex: 2, status: "won", zonesCaptured: ZONE_COUNT, currentZone: null }),
    hunter(),
    hunter({ playerId: "pat", username: "Pat", status: "caught", eliminationReason: "missed_zone", zonesCaptured: 1, colorIndex: 3 }),
  ];

  screen.StatusScreen.update(gameState({ players }), { playerId: "ruby", team: "runner" });

  const runners = screen.at("status-runner-list").text();
  assert.ok(runners.includes("On zone 3 · 2/6 captured"), runners);
  assert.ok(runners.includes("🛡 Shield"), "Ruby still has hers");
  assert.ok(runners.includes("⚠ Last life"), "Sam has spent his");
  assert.ok(runners.includes("🏁 Home"), "Tess is home");
  assert.ok(runners.includes("you"), "you are marked in the list");

  const hunters = screen.at("status-hunter-list").text();
  assert.ok(hunters.includes("Hunting"), hunters);
  assert.ok(hunters.includes("Out: Missed a zone · 1/6 captured"), "a runner who went out says how");
});

test("players who left the game are off the lists, and empty lists say so", () => {
  const screen = setupScreen();
  const players = [runner({ leftAt: Date.now() }), hunter()];

  screen.StatusScreen.update(gameState({ players }), { playerId: "hank", team: "hunter" });

  assert.ok(!screen.at("status-runner-list").text().includes("Ruby"));
  assert.strictEqual(screen.at("status-runner-list").text(), "Nobody yet");
});

test("the screen reads the same before the game clock has anything to say", () => {
  const screen = setupScreen();
  const state = gameState({ players: [runner()] });
  state.gameStartTime = null;
  state.gameEndTime = null;

  screen.StatusScreen.update(state, { playerId: "ruby", team: "runner" });

  assert.strictEqual(screen.at("status-game-clock").textContent, "--:--");
  assert.strictEqual(screen.at("status-zone-window").textContent, "-");
});

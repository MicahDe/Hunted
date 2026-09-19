## Rooms and the Game Lifecycle

Everything runs over Socket.IO (`server/socket/socketManager.js`). The server is
the only judge of who is in which room, who the host is, and where the game
clock is; the client keeps a session in `localStorage` so it can find its way
back after a reload or a dropped connection.

### Getting into a room

- **`create_room`** creates the room and puts its creator in it as the host
  (`rooms.host_player_id`) in one step, answering with `join_success`. A name
  already taken (ignoring capitals) is refused.
- **`join_room`** joins by room name and username from the join form. A
  username already in the room is that player coming back - unless they are
  still connected on another phone, in which case the name is refused. In the
  lobby a returning player can switch team; once the game is running their
  team is whatever the game has made it.
- **`rejoin_room`** is what a client sends from its saved session every time
  its socket connects: on page load, and after Socket.IO reconnects by itself.
  It fails with `rejoin_failed` if the room or the player's place in it has
  gone, and the client forgets the session.

Only a player joining for the first time is announced (`player_joined`).

### Connections versus players

`connectedPlayers` maps each open socket to its room and player. A player can
have more than one socket (a phone that reconnected before the server noticed
the old connection was dead) or none at all (app closed). **A dropped
connection never removes a player**; in the lobby it just shows them as away
(`connected: false` in the game state).

### Leaving

- **`leave_room`** (acknowledged, so the client only forgets the room once the
  server has) removes the player from a lobby entirely, forfeits a runner who
  is still in a running game (`status = 'caught'`, `elimination_reason =
  'left'`, `left_at` set), and changes nothing once the game is over. A host
  who leaves hands the room on; the last player out of a lobby closes it.
- **`remove_player`** lets the host take someone out of the lobby.
- **`delete_room`** lets the host delete a room that isn't mid-game.

### Starting and ending

- **`start_game`** is host only, needs at least one runner, and only starts a
  room that is still in the lobby. It starts the game clock, hides the final
  zone in the target area, gives every runner their zone chain and a full
  shield, and sends each player `game_started` with their own view of the game.
- The server ticks every second (`processZoneSchedules`), charging a life for
  every zone window that closes uncaptured and ending the game when the final
  window closes. Runners capture zones and win through `location_update`, and
  report catches through `player_caught`.
- The game also ends as soon as every runner has won or is out.

### One change at a time

Every change to a room runs through `withRoomLock(roomId, ...)`, so requests
that race each other - a join sent twice over a flaky connection, a catch on
the same tick as a missed window - are applied one after the other rather than
both acting on the same stale read.

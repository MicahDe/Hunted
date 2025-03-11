## Game Implementation and Start Game Flow

When the host clicks the "Start Game" button, the following sequence of events occurs:

### 1. Client-Side Initiates Game Start
In `app.js`, the `startGame()` function:
- Verifies the user is the room creator
- Shows a loading indicator
- Emits a `start_game` socket event to the server with the roomId

### 2. Server-Side Processing
In `socketManager.js`, when the server receives the `start_game` event:
- It verifies the player exists
- Updates the room status to "active" in the database via `updateRoomStatus()`
- Sets the current time as the start time
- Retrieves the complete game state via `getGameState()`
- Broadcasts a `game_started` event to all players in the room with the game state

### 3. Client-Side Game Initialization
When clients receive the `game_started` event:
- The `handleGameStarted()` function processes the event
- Calls `startGameUI()` which:
  - Shows the game screen
  - Updates local game state
  - Saves the session to localStorage
  - Initializes the Game object by calling `Game.init()`

### 4. Game Object Initialization
The `Game.init()` function in `game.js`:
- Stores references to player info, socket, and game state
- Initializes the game map centered on the game's location
- Initializes the UI with team-specific controls via `initGameUI()`
- Starts two timers:
  - Game timer: counts down game time and ends game when time expires
  - Location timer: periodically sends player location updates to the server
- Updates targets on the map based on player team

### 5. Team-Specific Features
- For runners: Shows target distances and allows them to collect targets
- For hunters: Shows runner locations when they're detected

This implementation creates a real-time location-based game where:
- Runners try to reach targets to score points
- Hunters try to catch runners
- The game state (player positions, scores, targets) is synchronized across all clients
- The game ends when either time runs out or all runners are caught

When the timer expires, the server updates the room status to "completed" and the game ends.

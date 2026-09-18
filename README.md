# HUNTED - GPS-Based Pursuit Game

HUNTED is a real-time, location-based mobile web game where players are divided into two teams: Hunters and Runners. Runners must navigate to target locations to score points while evading Hunters, who track and attempt to catch them.

## Features

- **Real-time location tracking** - Hunters can track Runners' locations in real-time
- **Zone windows** - each zone is capturable only during its own slot of the game clock
- **Shields** - one shared life per Runner, spent by a missed zone or a catch
- **Target discovery** - Runners navigate to targets with progressively narrowing circles
- **Team-based gameplay** - Join as either a Hunter or Runner
- **Room-based system** - Create or join game rooms with friends
- **Responsive design** - Works on all mobile devices
- **PWA support** - Can be installed as a Progressive Web App
- **OpenStreetMap integration** - Uses open-source mapping

## Game Mechanics

### Teams

- **Hunters**: Track and intercept Runners by taking their photo. Must keep the app open at all times to share their location.
- **Runners**: Navigate through progressively smaller zones to reach their unique final target while evading capture. Each zone has to be captured within its window, and every Runner carries one shield between them.

### How the Game Works

**Play Area Setup:**
- Hunters select a central location for the play area (typically the starting location)
- Each Runner gets a unique final target zone, randomly placed within a radius of the central location
- This makes the game about staying hidden nearby rather than traveling long distances

**Zone Windows:**
- The game duration is split evenly into one window per zone, so a 60 minute game over six zones opens a zone every 10 minutes: zone 1 from minute 0-10, zone 2 from 10-20, and the final zone from 50-60
- A zone can only be captured while its window is running, and only with the app open from inside the zone
- Capturing a zone early reveals the next one straight away so Runners can start moving, but it stays **locked** until its own window opens
- A window that closes with the zone uncaptured costs the Runner a shield, and they move on to the next zone with everyone else
- The game ends when the final zone's window closes

**Shields:**
- Every Runner starts with one shield - a dog's life
- The shield is shared between the two ways of going out: missing a zone window and being caught
- The first of either takes the shield; the second, whichever it is, puts the Runner out and onto the Hunters' team
- A shield spent on a catch also makes that Runner immune to being caught for a few minutes (configurable at setup, three by default), giving them a chance to get clear
- Shields are public: the menu player list and the map show who still has one and who is currently immune

**For Runners:**
- Navigate through a series of nested zones that progressively reveal your final target
- The header shows the zone you are on, the countdown to its window opening or closing, your shield, and how long is left in the game
- Your location pings to Hunters every 30 seconds while the app is open
- You can see where other Runners and Hunters have pinged on the map
- **Strategy:** Capture a zone early in its window and you get the next zone revealed while you still have time to walk to it
- **Warning:** Laying low is how you miss a window - keep an eye on the countdown

**For Hunters:**
- Keep your app open at all times to share your location and coordinate with your team
- Track Runner locations in real-time as they ping
- Follow each Runner's trail from the last hour, including which way they were last heading
- Catch Runners by taking their photo (share proof in your group chat!)
- A Runner's first catch only takes their shield and leaves them briefly immune, so check the player list for who still has one
- Runners who go out - caught or timed out on a zone - become Hunters, growing your team

### Winning

- **Runners win individually:** Each Runner who captures their final zone within its window is marked as having "won" - multiple Runners can win!
- **Hunters win as a team:** If all Runners are out before any reach their final target, Hunters win together
- **The clock:** When the final zone's window closes the game is over, and any Runner still short of their target has run out of road

## Installation and Setup

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- An internet-connected device with GPS capabilities

### Setup

1. Clone the repository

   ```
   git clone https://github.com/yourusername/hunted-game.git
   cd hunted-game
   ```

2. Install dependencies

   ```
   npm install
   ```

3. Start the server

   ```
   npm start
   ```

4. Open in browser
   ```
   http://localhost:3000
   ```

### For External Access

To allow other devices to connect to your server over the internet, you'll need to:

1. Set up port forwarding on your router to port 3000
2. Use a service like ngrok or localtunnel
3. Or deploy to a hosting service like Heroku, Render, or Vercel

## Technologies Used

- **Frontend**: HTML5, CSS3, JavaScript, Leaflet.js (OpenStreetMap)
- **Backend**: Node.js, Express.js, Socket.IO
- **Database**: SQLite
- **Geolocation**: HTML5 Geolocation API

## Safety Considerations

- All players must observe traffic laws and safety regulations
- The game should only be played in public spaces (no trespassing)
- Runners are caught by Hunters taking their photo (not physical contact)
- Respect others' privacy when taking photos - keep them within your game group
- Consider weather conditions and player fitness levels
- Ensure players have communication methods for emergencies
- Stay aware of your surroundings at all times

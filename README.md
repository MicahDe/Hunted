# HUNTED - GPS-Based Pursuit Game

HUNTED is a real-time, location-based mobile web game where players are divided into two teams: Hunters and Runners. Runners must navigate to target locations to score points while evading Hunters, who track and attempt to catch them.

## Features

- **Real-time location tracking** - Hunters can track Runners' locations in real-time
- **Target discovery** - Runners navigate to targets with progressively narrowing circles
- **Team-based gameplay** - Join as either a Hunter or Runner
- **Room-based system** - Create or join game rooms with friends
- **Responsive design** - Works on all mobile devices
- **PWA support** - Can be installed as a Progressive Web App
- **OpenStreetMap integration** - Uses open-source mapping

## Game Mechanics

### Teams

- **Hunters**: Track and intercept Runners by taking their photo. Must keep the app open at all times to share their location.
- **Runners**: Navigate through progressively smaller zones to reach their unique final target while evading capture.

### How the Game Works

**Play Area Setup:**
- Hunters select a central location for the play area (typically the starting location)
- Each Runner gets a unique final target zone, randomly placed within a radius of the central location
- This makes the game about staying hidden nearby rather than traveling long distances

**For Runners:**
- Navigate through a series of nested zones that progressively reveal your final target
- When a new zone first appears, it starts **locked** for a short configurable time
- Once unlocked, you can capture it to reveal the next zone (which will also start locked)
- A countdown shows when the current zone unlocks, and progress indicators show zones remaining
- Your location pings to Hunters every 30 seconds while the app is open
- You can see where other Runners and Hunters have pinged on the map
- **Strategy:** If you're already in a locked zone, lay low and wait before reopening the app to capture it
- **Warning:** Taking too long between pings gives Hunters time to catch other Runners, who then join the hunt for you

**For Hunters:**
- Keep your app open at all times to share your location and coordinate with your team
- Track Runner locations in real-time as they ping
- See the location history of all Runners on your map
- Catch Runners by taking their photo (share proof in your group chat!)
- Caught Runners become Hunters, growing your team

### Winning

- **Runners win individually:** Each Runner who reaches their final target zone is marked as having "won" - multiple Runners can win!
- **Hunters win as a team:** If all Runners are caught before any reach their final target, Hunters win together

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

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

- **Hunters**: Track and intercept Runners
- **Runners**: Navigate to target locations while evading capture

### Basic Setup

- Play area: Approximately 5km radius from a central point
- Duration: User-defined time limit set at start of game
- Players needed: Minimum 4 (2 per team initially)

### Location Tracking

- Runners must use the webapp to view their target locations
- Each time a Runner opens the webapp, their location is pinged to Hunters
- While the webapp remains open, location pings continue every 30 seconds
- Hunters can track Runners' locations in real-time on their devices

### Target Discovery

1. Runners initially see a 2km radius circle containing their target
2. Upon entering this circle, a 1km radius circle appears
3. The circle continues to halve (500m, 250m, 125m)
4. Target is considered reached when a Runner enters the 125m circle
5. Inner circles aren't centered within outer circles - requires checking the app

### Catching Mechanics

- Hunters catch Runners by physically tagging them
- If one Runner is caught, they become a Hunter
- Caught Runners join the pursuit as Hunters

### Scoring & Winning

- Teams earn points for each target location reached
- When time expires, the team with the most points wins
- If all Runners are caught before time expires, Hunters win

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
- Consider weather conditions and player fitness levels
- Ensure players have communication methods for emergencies

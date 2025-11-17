# Design Document

## Overview

The walkie-talkie voice communication feature will enable real-time push-to-talk voice transmission between players in the HUNTED game. The system leverages the existing Socket.IO infrastructure for audio streaming, using the browser's MediaRecorder API for audio capture and the Web Audio API for playback. The design prioritizes low latency, cross-browser compatibility, and seamless integration with the existing game architecture.

## Architecture

### High-Level Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Client A      │         │   Server        │         │   Client B      │
│  (Transmitter)  │         │  (Socket.IO)    │         │   (Receiver)    │
└─────────────────┘         └─────────────────┘         └─────────────────┘
        │                           │                           │
        │  1. Press PTT             │                           │
        ├──────────────────────────>│                           │
        │                           │                           │
        │  2. Audio Chunks          │                           │
        ├──────────────────────────>│                           │
        │                           │  3. Broadcast Audio       │
        │                           ├──────────────────────────>│
        │                           │                           │
        │  4. Release PTT           │                           │
        ├──────────────────────────>│                           │
        │                           │  5. End Transmission      │
        │                           ├──────────────────────────>│
```

### Component Architecture

The voice chat system consists of three main layers:

1. **Client Layer** (Browser)
   - UI Components (PTT button, indicators)
   - Audio Capture Module (MediaRecorder)
   - Audio Playback Module (Web Audio API)
   - Voice Chat Manager (coordination)

2. **Transport Layer** (Socket.IO)
   - Real-time bidirectional communication
   - Audio chunk streaming
   - Transmission state synchronization

3. **Server Layer** (Node.js)
   - Audio relay/broadcast
   - Room-based routing
   - Connection management

## Components and Interfaces

### 1. Voice Chat Manager (`public/js/voiceChat.js`)

Central coordinator for all voice chat functionality.

```javascript
const VoiceChat = {
  // State
  isEnabled: true,
  isTransmitting: false,
  isReceiving: false,
  volume: 1.0,
  
  // Audio components
  mediaRecorder: null,
  audioContext: null,
  audioQueue: [],
  
  // Configuration
  config: {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 32000,
    chunkInterval: 100, // ms
    maxTransmissionDuration: 30000 // ms
  },
  
  // Methods
  init(socket, gameState): void
  startTransmission(): Promise<void>
  stopTransmission(): void
  handleIncomingAudio(data): void
  playAudioChunk(chunk): void
  toggleVoiceChat(): void
  setVolume(level): void
  checkBrowserSupport(): boolean
}
```

**Key Responsibilities:**
- Initialize audio capture and playback systems
- Manage transmission state
- Queue and play incoming audio
- Handle browser compatibility
- Persist user settings

### 2. Audio Capture Module

Handles microphone access and audio recording.

```javascript
class AudioCapture {
  constructor(config) {
    this.config = config;
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
  }
  
  async requestMicrophoneAccess(): Promise<MediaStream>
  startRecording(onDataAvailable): void
  stopRecording(): void
  release(): void
}
```

**Technical Details:**
- Uses `navigator.mediaDevices.getUserMedia()` for microphone access
- MediaRecorder with Opus codec for efficient compression
- Emits audio chunks every 100ms via `ondataavailable` event
- Automatic gain control and noise suppression enabled

### 3. Audio Playback Module

Manages audio playback queue and Web Audio API.

```javascript
class AudioPlayback {
  constructor(audioContext) {
    this.audioContext = audioContext;
    this.queue = [];
    this.isPlaying = false;
    this.currentSource = null;
  }
  
  enqueue(audioData, metadata): void
  async play(): Promise<void>
  stop(): void
  setVolume(level): void
  clearQueue(): void
}
```

**Technical Details:**
- Uses Web Audio API for low-latency playback
- Maintains FIFO queue for sequential playback
- Decodes audio chunks using `audioContext.decodeAudioData()`
- Prevents overlapping transmissions

### 4. UI Components

#### PTT Button Component

```html
<button id="ptt-btn" class="ptt-button">
  <svg class="mic-icon"><!-- Microphone SVG --></svg>
  <span class="ptt-label">Push to Talk</span>
</button>
```

**States:**
- Idle: Default state, ready for transmission
- Active: User is holding button, transmitting
- Disabled: Voice chat disabled or unsupported

#### Speaker Indicator Component

```html
<div id="speaker-indicator" class="speaker-indicator hidden">
  <svg class="speaker-icon"><!-- Speaker wave SVG --></svg>
  <span class="speaker-name"></span>
  <span class="speaker-team"></span>
</div>
```

**Behavior:**
- Appears when audio is being received
- Shows transmitter's name and team
- Animated wave effect during playback

#### Voice Chat Settings (in Game Menu)

```html
<div class="voice-chat-settings">
  <div class="setting-row">
    <label>Voice Chat</label>
    <toggle id="voice-chat-toggle"></toggle>
  </div>
  <div class="setting-row">
    <label>Volume</label>
    <input type="range" id="voice-volume" min="0" max="100" value="100">
  </div>
</div>
```

### 5. Server-Side Handler (`server/socket/voiceChatHandler.js`)

Manages voice transmission routing and broadcasting.

```javascript
module.exports = function(io, socket, connectedPlayers) {
  // Handle voice transmission start
  socket.on('voice_transmission_start', (data) => {
    const playerInfo = connectedPlayers.get(socket.id);
    if (!playerInfo) return;
    
    // Broadcast to all players in room
    io.to(playerInfo.roomId).emit('voice_transmission_started', {
      playerId: playerInfo.playerId,
      username: playerInfo.username,
      team: playerInfo.team,
      timestamp: Date.now()
    });
  });
  
  // Handle audio chunks
  socket.on('voice_audio_chunk', (data) => {
    const playerInfo = connectedPlayers.get(socket.id);
    if (!playerInfo) return;
    
    // Broadcast audio to all players except sender
    socket.to(playerInfo.roomId).emit('voice_audio_received', {
      playerId: playerInfo.playerId,
      username: playerInfo.username,
      team: playerInfo.team,
      audioData: data.audioData,
      timestamp: Date.now()
    });
  });
  
  // Handle transmission end
  socket.on('voice_transmission_end', (data) => {
    const playerInfo = connectedPlayers.get(socket.id);
    if (!playerInfo) return;
    
    io.to(playerInfo.roomId).emit('voice_transmission_ended', {
      playerId: playerInfo.playerId,
      timestamp: Date.now()
    });
  });
};
```

## Data Models

### Voice Transmission Event

```javascript
{
  playerId: string,        // UUID of transmitting player
  username: string,        // Display name
  team: string,           // 'hunter' or 'runner'
  timestamp: number       // Unix timestamp in milliseconds
}
```

### Audio Chunk Data

```javascript
{
  playerId: string,        // UUID of transmitting player
  username: string,        // Display name
  team: string,           // 'hunter' or 'runner'
  audioData: ArrayBuffer, // Encoded audio data (Opus in WebM)
  timestamp: number,      // Unix timestamp in milliseconds
  sequenceNumber: number  // Chunk sequence for ordering
}
```

### Voice Chat Settings

```javascript
{
  enabled: boolean,       // Voice chat on/off
  volume: number,        // 0.0 to 1.0
  lastUpdated: number    // Timestamp of last settings change
}
```

Stored in `localStorage` as:
```javascript
localStorage.setItem('huntedVoiceChatSettings', JSON.stringify(settings));
```

## Error Handling

### Microphone Access Errors

**Scenario:** User denies microphone permission or device not available

**Handling:**
1. Catch `getUserMedia()` rejection
2. Display user-friendly notification: "Microphone access required for voice chat"
3. Hide PTT button or show disabled state
4. Log error details to console for debugging
5. Provide link to browser settings help

```javascript
try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
} catch (error) {
  if (error.name === 'NotAllowedError') {
    UI.showNotification('Microphone access denied. Enable in browser settings.', 'error');
  } else if (error.name === 'NotFoundError') {
    UI.showNotification('No microphone found. Please connect a microphone.', 'error');
  }
  VoiceChat.disablePTT();
}
```

### Audio Encoding Errors

**Scenario:** MediaRecorder fails to encode audio

**Handling:**
1. Catch MediaRecorder error event
2. Stop current transmission
3. Notify user: "Voice transmission failed"
4. Reset recorder state
5. Allow retry

### Network Transmission Errors

**Scenario:** Socket.IO fails to send audio chunk

**Handling:**
1. Implement retry logic (max 3 attempts)
2. If all retries fail, stop transmission
3. Notify user: "Connection issue. Voice transmission stopped."
4. Continue normal game operation

### Audio Playback Errors

**Scenario:** Audio decoding or playback fails

**Handling:**
1. Catch `decodeAudioData()` errors
2. Skip failed chunk
3. Continue with next chunk in queue
4. Log error for debugging
5. No user notification (graceful degradation)

### Browser Compatibility Errors

**Scenario:** Browser doesn't support required APIs

**Handling:**
1. Check for API support on initialization
2. If unsupported, hide voice chat UI completely
3. Display one-time notification: "Voice chat not supported in this browser"
4. Game continues without voice features

```javascript
checkBrowserSupport() {
  const hasMediaRecorder = typeof MediaRecorder !== 'undefined';
  const hasGetUserMedia = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  const hasAudioContext = typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';
  
  return hasMediaRecorder && hasGetUserMedia && hasAudioContext;
}
```

## Testing Strategy

### Unit Tests

**Audio Capture Module:**
- Test microphone permission request flow
- Test recording start/stop
- Test chunk emission timing
- Mock MediaRecorder API

**Audio Playback Module:**
- Test queue management (enqueue, dequeue)
- Test sequential playback
- Test volume control
- Mock Web Audio API

**Voice Chat Manager:**
- Test state transitions (idle → transmitting → idle)
- Test settings persistence
- Test enable/disable toggle

### Integration Tests

**Client-Server Communication:**
- Test audio chunk transmission via Socket.IO
- Test broadcast to multiple clients
- Test room-based routing
- Use Socket.IO test utilities

**End-to-End Flow:**
- Test complete transmission cycle (press → record → send → receive → play)
- Test multiple simultaneous users
- Test transmission interruption handling

### Browser Compatibility Tests

**Manual Testing Matrix:**
- Chrome (desktop & mobile)
- Firefox (desktop & mobile)
- Safari (desktop & iOS)
- Edge (desktop)

**Test Cases:**
- Microphone access on each browser
- Audio encoding format compatibility
- Playback quality and latency
- UI rendering and interactions

### Performance Tests

**Metrics to Monitor:**
- Audio chunk transmission latency (target: <200ms)
- Memory usage during extended transmission
- CPU usage during recording and playback
- Network bandwidth consumption

**Load Testing:**
- Test with 10+ simultaneous players
- Test with multiple concurrent transmissions
- Test with poor network conditions (throttling)

### User Acceptance Testing

**Scenarios:**
- Hunter coordinates with team during chase
- Runner listens to hunter communications
- Player adjusts volume during gameplay
- Player disables voice chat mid-game
- Player experiences microphone disconnection

## Performance Considerations

### Audio Compression

- Use Opus codec (best compression for voice)
- Target bitrate: 32 kbps (balance quality/bandwidth)
- Chunk size: 100ms intervals (low latency)

### Network Optimization

- Audio chunks are small (~400 bytes per 100ms at 32kbps)
- No server-side storage (relay only)
- Binary data transmission (ArrayBuffer)

### Memory Management

- Limit audio queue size (max 10 chunks)
- Release MediaStream when not transmitting
- Clean up AudioContext resources on disconnect

### Mobile Considerations

- Test battery impact during extended use
- Optimize for mobile network conditions
- Handle background/foreground transitions
- Respect mobile browser audio policies

## Security Considerations

### Privacy

- No server-side recording or storage of audio
- Audio transmitted only to players in same room
- Clear visual indicators when transmitting

### Abuse Prevention

- Maximum transmission duration (30 seconds)
- Cooldown period between transmissions (1 second)
- Server-side rate limiting on audio events

### Data Validation

- Validate audio chunk size on server
- Verify sender is in the room
- Sanitize metadata (username, team)

## Integration Points

### Existing Game Systems

**Socket.IO Integration:**
- Add voice chat event handlers to `socketManager.js`
- Use existing room-based broadcasting
- Leverage connected players map

**UI Integration:**
- Add PTT button to game screen
- Add speaker indicator overlay
- Add settings to game menu
- Use existing notification system

**Game State Integration:**
- Access player info (username, team) from game state
- Respect game status (only allow in active games)
- Handle player disconnections

### File Structure

```
public/
  js/
    voiceChat.js          (new - main voice chat module)
    audioCapture.js       (new - recording logic)
    audioPlayback.js      (new - playback logic)
    app.js                (modified - initialize voice chat)
    game.js               (modified - integrate PTT button)
    ui.js                 (modified - add voice chat UI)
  css/
    voiceChat.css         (new - voice chat styles)
    main.css              (modified - import voiceChat.css)
  assets/
    icons/
      microphone.svg      (new - PTT button icon)
      speaker-wave.svg    (new - speaker indicator icon)

server/
  socket/
    socketManager.js      (modified - import voice chat handler)
    voiceChatHandler.js   (new - voice chat events)
```

## Browser Compatibility Matrix

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| MediaRecorder | ✅ | ✅ | ✅ (14.1+) | ✅ |
| getUserMedia | ✅ | ✅ | ✅ | ✅ |
| Web Audio API | ✅ | ✅ | ✅ | ✅ |
| Opus Codec | ✅ | ✅ | ✅ (14.1+) | ✅ |
| Mobile Support | ✅ | ✅ | ✅ (iOS 14.3+) | ✅ |

**Fallback Strategy:**
- If Opus not supported, try AAC codec
- If MediaRecorder not supported, disable feature
- Display clear browser upgrade message if needed

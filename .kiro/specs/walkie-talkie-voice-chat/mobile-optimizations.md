# Mobile-Specific Optimizations for Voice Chat

## Overview

This document describes the mobile-specific optimizations implemented for the walkie-talkie voice chat feature in the HUNTED game. These optimizations ensure reliable voice communication on mobile devices (iOS and Android) while handling platform-specific constraints and policies.

## Implemented Optimizations

### 1. Touch Event Handling

**Location:** `public/js/pttButton.js`

**Features:**
- Full touch event support (touchstart, touchend, touchcancel)
- Touch identifier tracking to handle multi-touch scenarios
- Context menu prevention on long press
- Proper event handling for touch cancellation (system interruptions)
- Background state checking to prevent transmission when app is backgrounded

**Implementation Details:**
```javascript
// Touch events with passive: false to allow preventDefault
button.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (e.changedTouches.length > 0) {
    this.touchIdentifier = e.changedTouches[0].identifier;
    this.handlePressStart();
  }
}, { passive: false });

button.addEventListener('touchend', (e) => {
  e.preventDefault();
  for (let i = 0; i < e.changedTouches.length; i++) {
    if (e.changedTouches[i].identifier === this.touchIdentifier) {
      this.touchIdentifier = null;
      this.handlePressEnd();
      break;
    }
  }
}, { passive: false });
```

### 2. Mobile Browser Audio Policies

**Location:** `public/js/audioCapture.js`, `public/js/voiceChat.js`

**Features:**
- Relaxed audio constraints for mobile devices (no fixed sample rate)
- Fallback mechanism for overconstrained errors
- Audio context resume on user interaction (required by mobile browsers)
- Minimal constraints fallback for maximum compatibility

**Implementation Details:**
```javascript
// Mobile-optimized constraints
const constraints = {
  audio: isMobile ? {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1
    // No sampleRate specified - let browser choose
  } : {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48000
  }
};

// Fallback for overconstrained errors
async requestMicrophoneAccessFallback() {
  const constraints = { audio: true };
  return await navigator.mediaDevices.getUserMedia(constraints);
}
```

**Audio Context Resume:**
- Automatically resumes audio context on user interaction
- Handles suspended state after page visibility changes
- Registers one-time event listeners for touch/click events

### 3. Touch Target Optimization

**Location:** `public/css/voiceChat.css`

**Features:**
- Minimum 70x70px touch targets (exceeds WCAG 44x44px minimum)
- Responsive sizing for different screen sizes
- Extra padding for better touch area
- iOS-specific optimizations (tap highlight, text selection prevention)
- Android-specific touch action optimization

**Implementation Details:**
```css
/* Minimum touch target size */
@media (pointer: coarse) {
  .ptt-button {
    min-width: 70px;
    min-height: 70px;
    padding: 18px 22px;
  }
}

/* iOS optimizations */
@supports (-webkit-touch-callout: none) {
  .ptt-button {
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
}
```

**Responsive Breakpoints:**
- Desktop (1025px+): 100x100px button
- Tablet (769-1024px): 90x90px button
- Mobile (481-768px): 70x70px button
- Small mobile (≤480px): 60x60px button
- Landscape mobile (≤500px height): 50x50px button, label hidden

### 4. Background/Foreground Transition Handling

**Location:** `public/js/voiceChat.js`

**Features:**
- Page Visibility API integration
- Automatic transmission stop when app goes to background
- Audio context suspension/resumption
- Audio playback pause/resume
- User notification when transmission is interrupted

**Implementation Details:**
```javascript
setupVisibilityChangeHandler() {
  // Detect correct visibility API
  let hidden, visibilityChange;
  if (typeof document.hidden !== 'undefined') {
    hidden = 'hidden';
    visibilityChange = 'visibilitychange';
  } else if (typeof document.msHidden !== 'undefined') {
    hidden = 'msHidden';
    visibilityChange = 'msvisibilitychange';
  } else if (typeof document.webkitHidden !== 'undefined') {
    hidden = 'webkitHidden';
    visibilityChange = 'webkitvisibilitychange';
  }
  
  this.visibilityChangeHandler = () => {
    if (document[hidden]) {
      this.handleAppBackground();
    } else {
      this.handleAppForeground();
    }
  };
  
  document.addEventListener(visibilityChange, this.visibilityChangeHandler);
}

handleAppBackground() {
  this.isInBackground = true;
  
  // Stop active transmission
  if (this.isTransmitting) {
    this.stopTransmission();
    this.showErrorNotification(
      'Voice transmission stopped because the app went to the background.'
    );
  }
  
  // Pause audio playback to save resources
  if (this.isMobile && this.audioPlayback) {
    this.audioPlayback.pause();
  }
}

handleAppForeground() {
  this.isInBackground = false;
  
  // Resume audio context
  if (this.audioPlayback?.audioContext?.state === 'suspended') {
    this.audioPlayback.audioContext.resume();
  }
  
  // Resume audio playback
  if (this.isMobile && this.audioPlayback) {
    this.audioPlayback.resume();
  }
}
```

**Audio Playback Pause/Resume:**
```javascript
// In audioPlayback.js
pause() {
  if (this.audioContext && this.audioContext.state !== 'suspended') {
    this.audioContext.suspend();
  }
}

resume() {
  if (this.audioContext && this.audioContext.state === 'suspended') {
    this.audioContext.resume().then(() => {
      // Resume playback of queued chunks
      if (this.queue.length > 0 && !this.isPlaying) {
        this.play();
      }
    });
  }
}
```

### 5. Mobile-Specific Audio Settings

**Location:** `public/js/voiceChat.js`

**Features:**
- Reduced bitrate for mobile networks (24kbps vs 32kbps)
- Longer chunk interval to reduce processing overhead (150ms vs 100ms)
- Automatic detection and configuration

**Implementation Details:**
```javascript
adjustMobileAudioSettings() {
  if (this.isMobile) {
    // Reduce bitrate for mobile networks
    this.config.audioBitsPerSecond = 24000;
    
    // Slightly longer chunk interval
    this.config.chunkInterval = 150;
    
    console.log('Audio settings adjusted for mobile:', {
      bitrate: this.config.audioBitsPerSecond,
      chunkInterval: this.config.chunkInterval
    });
  }
}
```

### 6. Mobile Device Detection

**Location:** `public/js/voiceChat.js`, `public/js/audioCapture.js`

**Features:**
- User agent detection for mobile keywords
- Touch support detection
- Screen size consideration
- Consistent detection across modules

**Implementation Details:**
```javascript
detectMobileDevice() {
  const userAgent = navigator.userAgent.toLowerCase();
  const mobileKeywords = ['android', 'webos', 'iphone', 'ipad', 'ipod', 'blackberry', 'windows phone'];
  const isMobileUA = mobileKeywords.some(keyword => userAgent.includes(keyword));
  
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isSmallScreen = window.innerWidth <= 1024;
  
  this.isMobile = isMobileUA || (hasTouch && isSmallScreen);
  return this.isMobile;
}
```

## Testing

### Test Page

A comprehensive mobile test page has been created at `public/js/mobile-voice-chat-test.html` that includes:

- Device information display
- Browser API support detection
- Interactive microphone access test
- Background transition monitoring
- Touch event verification
- Real-time console logging

### Manual Testing Checklist

- [ ] Test PTT button on iOS Safari
- [ ] Test PTT button on Android Chrome
- [ ] Test microphone permission flow on mobile
- [ ] Test background/foreground transitions
- [ ] Test audio playback after returning from background
- [ ] Test touch events with multiple fingers
- [ ] Test in landscape and portrait orientations
- [ ] Test with poor network conditions
- [ ] Test with Bluetooth headset
- [ ] Test with wired headphones

### Known Platform Behaviors

**iOS Safari:**
- Requires user interaction to start audio context
- Suspends audio context when app goes to background
- May require HTTPS for microphone access
- Strict autoplay policies

**Android Chrome:**
- More permissive audio policies
- Better background audio support
- May show persistent notification during microphone use

**General Mobile:**
- First microphone access requires user gesture
- Audio context may be suspended by system
- Background apps may have limited audio capabilities
- Network conditions can vary significantly

## Performance Considerations

### Battery Impact
- Audio context suspended when app is backgrounded
- Reduced bitrate on mobile (24kbps vs 32kbps)
- Longer chunk intervals reduce CPU usage

### Network Optimization
- Lower bitrate for mobile networks
- Chunk-based transmission reduces latency
- Failed chunk retry logic prevents data loss

### Memory Management
- Audio queue size limited to 10 chunks
- Streams released when not in use
- Event listeners properly cleaned up

## Browser Compatibility

| Feature | iOS Safari | Android Chrome | Android Firefox |
|---------|-----------|----------------|-----------------|
| Touch Events | ✅ | ✅ | ✅ |
| getUserMedia | ✅ (14.3+) | ✅ | ✅ |
| MediaRecorder | ✅ (14.1+) | ✅ | ✅ |
| Web Audio API | ✅ | ✅ | ✅ |
| Opus Codec | ✅ (14.1+) | ✅ | ✅ |
| Page Visibility | ✅ | ✅ | ✅ |
| Background Audio | ⚠️ Limited | ✅ | ✅ |

## Future Enhancements

Potential improvements for mobile experience:

1. **Haptic Feedback:** Add vibration on PTT press/release
2. **Network Quality Indicator:** Show connection quality to user
3. **Adaptive Bitrate:** Automatically adjust based on network conditions
4. **Wake Lock API:** Prevent screen from sleeping during active game
5. **Service Worker:** Enable offline capabilities and background sync
6. **Push Notifications:** Notify users of voice messages when app is closed

## References

- [MDN: Touch Events](https://developer.mozilla.org/en-US/docs/Web/API/Touch_events)
- [MDN: Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- [MDN: MediaDevices.getUserMedia()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [Web Audio API on Mobile](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices)
- [WCAG Touch Target Size](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html)

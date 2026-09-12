/**
 * Push-to-Talk Button Controller
 *
 * Owns the "is the user holding the button" question and nothing else. The
 * actual transmission state lives in VoiceChat and is mirrored back here, so
 * the button cannot get stuck looking live when transmission has already
 * stopped (time limit reached, app backgrounded, microphone error).
 *
 * Pointer Events are used in preference to separate mouse and touch handlers:
 * pointer capture means a press that starts on the button always ends on the
 * button, even if the finger slides off or the browser interrupts the gesture.
 */

const PTTButton = {
  // Button element
  button: null,

  // Is the user currently holding the button down
  isPressed: false,

  // Hard-disabled (microphone unavailable or permission denied)
  isDisabled: false,

  // Soft-disabled (voice chat switched off in settings)
  isAvailable: true,

  // Mirrored from VoiceChat: 'idle' | 'starting' | 'transmitting'
  transmissionState: 'idle',

  // Active pointer, so a second finger cannot end someone else's press
  pointerId: null,

  // Bumped on every press, so a late failure from an earlier press cannot
  // cancel the press the user is currently holding
  pressGeneration: 0,

  // Bound handlers, kept so cleanup() can remove them
  handlers: null,

  /**
   * Initialize the PTT button
   * @returns {boolean} True if the button was found and wired up
   */
  init() {
    console.log('Initializing PTT button...');

    this.button = document.getElementById('ptt-btn');

    if (!this.button) {
      console.error('PTT button element not found');
      return false;
    }

    // Re-initialising (for example on rejoin) must not stack listeners
    this.removeEventListeners();

    this.isPressed = false;
    this.pointerId = null;
    this.transmissionState = 'idle';

    this.setupEventListeners();

    // Follow VoiceChat so the button reflects reality rather than intent
    if (typeof VoiceChat !== 'undefined') {
      if (VoiceChat.onTransmissionStateChange) {
        VoiceChat.onTransmissionStateChange((state) => {
          this.transmissionState = state;

          // Transmission ended on its own while the button is still held
          if (state === 'idle' && this.isPressed) {
            this.isPressed = false;
            this.releasePointer();
          }

          this.updateVisualState();
        });
      }

      this.isAvailable = VoiceChat.getEnabled ? VoiceChat.getEnabled() : true;
    }

    this.updateVisualState();

    console.log('PTT button initialized');
    return true;
  },

  /**
   * Set up event listeners for PTT button
   */
  setupEventListeners() {
    const button = this.button;

    const handlers = {
      pointerdown: (event) => {
        // Primary button / first finger only
        if (event.button !== undefined && event.button !== 0) {
          return;
        }

        if (this.pointerId !== null) {
          return;
        }

        event.preventDefault();

        this.pointerId = event.pointerId;

        // Capture routes every later event for this pointer to the button, so a
        // finger sliding off or a release outside still ends the press here
        if (button.setPointerCapture) {
          try {
            button.setPointerCapture(event.pointerId);
          } catch (error) {
            // Capture is best-effort; the document fallback below covers it
          }
        }

        this.handlePressStart();

        // The press was refused (button disabled, voice chat off, app in the
        // background). Let the pointer go, or the next press is ignored too.
        if (!this.isPressed) {
          this.releasePointer();
        }
      },

      pointerup: (event) => {
        if (event.pointerId !== this.pointerId) {
          return;
        }

        event.preventDefault();
        this.handlePressEnd();
      },

      pointercancel: (event) => {
        if (event.pointerId !== this.pointerId) {
          return;
        }

        this.handlePressEnd();
      },

      lostpointercapture: (event) => {
        // Fires if the browser takes the pointer away mid-gesture
        if (event.pointerId === this.pointerId) {
          this.handlePressEnd();
        }
      },

      contextmenu: (event) => {
        // Long press on mobile would otherwise pop the context menu
        event.preventDefault();
      },

      keydown: (event) => {
        if (event.key !== ' ' && event.key !== 'Enter' && event.code !== 'Space') {
          return;
        }

        // Holding a key fires keydown repeatedly
        if (event.repeat || this.isPressed) {
          event.preventDefault();
          return;
        }

        event.preventDefault();
        this.handlePressStart();
      },

      keyup: (event) => {
        if (event.key !== ' ' && event.key !== 'Enter' && event.code !== 'Space') {
          return;
        }

        event.preventDefault();
        this.handlePressEnd();
      },

      // A click is synthesised after keyboard activation; swallow it so it
      // cannot trigger anything else
      click: (event) => {
        event.preventDefault();
      }
    };

    // Anything that takes focus or attention away from the page must end the
    // press, otherwise the microphone stays live with no button held
    const globalHandlers = {
      blur: () => {
        if (this.isPressed) {
          console.log('Window lost focus, releasing push-to-talk');
          this.handlePressEnd();
        }
      },

      visibilitychange: () => {
        if (document.hidden && this.isPressed) {
          console.log('Page hidden, releasing push-to-talk');
          this.handlePressEnd();
        }
      }
    };

    if (typeof window.PointerEvent !== 'undefined') {
      button.addEventListener('pointerdown', handlers.pointerdown);
      button.addEventListener('pointerup', handlers.pointerup);
      button.addEventListener('pointercancel', handlers.pointercancel);
      button.addEventListener('lostpointercapture', handlers.lostpointercapture);
    } else {
      // Fallback for browsers without Pointer Events
      handlers.mousedown = (event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        this.handlePressStart();
      };
      handlers.mouseup = (event) => {
        event.preventDefault();
        this.handlePressEnd();
      };
      handlers.mouseleave = () => {
        this.handlePressEnd();
      };
      handlers.touchstart = (event) => {
        event.preventDefault();
        this.handlePressStart();
      };
      handlers.touchend = (event) => {
        event.preventDefault();
        this.handlePressEnd();
      };
      handlers.touchcancel = () => {
        this.handlePressEnd();
      };

      button.addEventListener('mousedown', handlers.mousedown);
      button.addEventListener('mouseup', handlers.mouseup);
      button.addEventListener('mouseleave', handlers.mouseleave);
      button.addEventListener('touchstart', handlers.touchstart, { passive: false });
      button.addEventListener('touchend', handlers.touchend, { passive: false });
      button.addEventListener('touchcancel', handlers.touchcancel);
    }

    button.addEventListener('contextmenu', handlers.contextmenu);
    button.addEventListener('keydown', handlers.keydown);
    button.addEventListener('keyup', handlers.keyup);
    button.addEventListener('click', handlers.click);

    window.addEventListener('blur', globalHandlers.blur);
    document.addEventListener('visibilitychange', globalHandlers.visibilitychange);

    this.handlers = { button: handlers, global: globalHandlers };
  },

  /**
   * Remove every listener registered by setupEventListeners
   */
  removeEventListeners() {
    if (!this.handlers || !this.button) {
      return;
    }

    const { button: handlers, global: globalHandlers } = this.handlers;

    Object.keys(handlers).forEach((eventName) => {
      this.button.removeEventListener(eventName, handlers[eventName]);
    });

    window.removeEventListener('blur', globalHandlers.blur);
    document.removeEventListener('visibilitychange', globalHandlers.visibilitychange);

    this.handlers = null;
  },

  releasePointer() {
    if (this.pointerId !== null && this.button && this.button.releasePointerCapture) {
      try {
        if (!this.button.hasPointerCapture || this.button.hasPointerCapture(this.pointerId)) {
          this.button.releasePointerCapture(this.pointerId);
        }
      } catch (error) {
        // Capture may already have been lost
      }
    }

    this.pointerId = null;
  },

  /**
   * Handle press start (button pressed down)
   */
  handlePressStart() {
    try {
      if (this.isDisabled || !this.isAvailable || this.isPressed) {
        return;
      }

      if (typeof VoiceChat === 'undefined') {
        console.error('VoiceChat module not available');
        return;
      }

      if (!VoiceChat.isEnabled) {
        console.log('Voice chat is disabled');
        return;
      }

      if (VoiceChat.isAppInBackground && VoiceChat.isAppInBackground()) {
        console.log('Cannot start transmission while app is in background');
        return;
      }

      console.log('PTT button pressed');

      const generation = ++this.pressGeneration;

      this.isPressed = true;
      this.updateVisualState();

      // startTransmission resolves once audio is actually flowing; it aborts by
      // itself if handlePressEnd runs first
      Promise.resolve(VoiceChat.startTransmission()).catch((error) => {
        console.error('Failed to start transmission:', error);

        if (generation !== this.pressGeneration) {
          return;
        }

        this.handleTransmissionError(error);

        this.isPressed = false;
        this.releasePointer();
        this.updateVisualState();
      });
    } catch (error) {
      console.error('Error in PTT button press start:', error);

      this.isPressed = false;
      this.releasePointer();
      this.updateVisualState();
    }
  },

  /**
   * Handle press end (button released)
   */
  handlePressEnd() {
    try {
      this.releasePointer();

      if (!this.isPressed) {
        return;
      }

      console.log('PTT button released');

      this.isPressed = false;
      this.updateVisualState();

      if (typeof VoiceChat === 'undefined') {
        console.error('VoiceChat module not available');
        return;
      }

      // Safe to call even if the transmission never got as far as starting
      Promise.resolve(VoiceChat.stopTransmission()).catch((error) => {
        console.error('Failed to stop transmission cleanly:', error);
      });
    } catch (error) {
      console.error('Error in PTT button press end:', error);

      this.isPressed = false;
      this.updateVisualState();
    }
  },

  /**
   * Handle transmission errors
   * @param {Error} error - The error that occurred
   */
  handleTransmissionError(error) {
    // VoiceChat already surfaces microphone problems with a help link, so only
    // report anything it did not recognise
    if (error && (error.errorType || error.name)) {
      return;
    }

    const message = 'Voice transmission failed';

    if (typeof UI !== 'undefined' && UI.showNotification) {
      UI.showNotification(message, 'error');
    } else {
      console.error(message, error);
    }
  },

  /**
   * Update visual state of the button
   */
  updateVisualState() {
    if (!this.button) {
      return;
    }

    this.button.classList.remove('ptt-idle', 'ptt-active', 'ptt-connecting', 'ptt-disabled');

    const unusable = this.isDisabled || !this.isAvailable;

    if (unusable) {
      this.button.classList.add('ptt-disabled');
      this.button.disabled = true;
      this.button.setAttribute('aria-disabled', 'true');
      this.button.setAttribute('aria-pressed', 'false');
      return;
    }

    this.button.disabled = false;
    this.button.setAttribute('aria-disabled', 'false');

    if (this.transmissionState === 'transmitting') {
      this.button.classList.add('ptt-active');
      this.button.setAttribute('aria-pressed', 'true');
    } else if (this.isPressed) {
      // Held, but the microphone is not streaming yet
      this.button.classList.add('ptt-connecting');
      this.button.setAttribute('aria-pressed', 'true');
    } else {
      this.button.classList.add('ptt-idle');
      this.button.setAttribute('aria-pressed', 'false');
    }
  },

  /**
   * Enable the PTT button after a recoverable error
   */
  enable() {
    this.isDisabled = false;
    this.updateVisualState();
    console.log('PTT button enabled');
  },

  /**
   * Hard-disable the PTT button (no usable microphone)
   */
  disable() {
    if (this.isPressed) {
      this.handlePressEnd();
    }

    this.isDisabled = true;
    this.updateVisualState();
    console.log('PTT button disabled');
  },

  /**
   * Reflect the voice chat on/off setting
   * @param {boolean} available
   */
  setAvailable(available) {
    if (!available && this.isPressed) {
      this.handlePressEnd();
    }

    this.isAvailable = !!available;
    this.updateVisualState();
  },

  /**
   * Show the PTT button
   */
  show() {
    if (this.button) {
      this.button.style.display = 'flex';
    }
  },

  /**
   * Hide the PTT button
   */
  hide() {
    if (this.button) {
      this.button.style.display = 'none';
    }
  },

  /**
   * @returns {boolean} True while the user is holding the button
   */
  isCurrentlyPressed() {
    return this.isPressed;
  },

  /**
   * Clean up event listeners and reset state
   */
  cleanup() {
    console.log('Cleaning up PTT button...');

    if (this.isPressed) {
      this.handlePressEnd();
    }

    this.removeEventListeners();

    this.isPressed = false;
    this.isDisabled = false;
    this.isAvailable = true;
    this.transmissionState = 'idle';
    this.pointerId = null;

    console.log('PTT button cleanup complete');
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PTTButton;
}

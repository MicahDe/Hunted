/**
 * Microphone Toggle Button
 *
 * Tap to open the microphone, tap again to close it. The mic starts closed and
 * only ever opens because someone tapped this button.
 *
 * A `click` listener is used rather than raw pointer events on purpose: the
 * browser already decides what counts as a tap, so a thumb that drifts a few
 * pixels still registers, and Enter/Space on a focused <button> come through
 * the same path for free. The previous hold-to-talk control could not tolerate
 * that drift, because any movement let the browser reclaim the touch as a pan
 * and cancel the press.
 *
 * The live state is mirrored from VoiceChat rather than tracked here, so the
 * button cannot claim to be open after transmission has stopped for some other
 * reason (app backgrounded, microphone error, connection lost).
 */

const MicButton = {
  // Button element
  button: null,

  // Label element, so the wording can follow the state
  label: null,

  // Hard-disabled (microphone unavailable or permission denied)
  isDisabled: false,

  // Soft-disabled (voice chat switched off in settings)
  isAvailable: true,

  // Mirrored from VoiceChat: 'idle' | 'starting' | 'transmitting'
  transmissionState: 'idle',

  // Guards against a second tap landing while the first is still opening
  isBusy: false,

  // Bound handlers, kept so cleanup() can remove them
  handlers: null,

  /**
   * Initialize the microphone button
   * @returns {boolean} True if the button was found and wired up
   */
  init() {
    console.log('Initializing microphone button...');

    this.button = document.getElementById('mic-btn');

    if (!this.button) {
      console.error('Microphone button element not found');
      return false;
    }

    this.label = this.button.querySelector('.mic-label');

    // Re-initialising (for example on rejoin) must not stack listeners
    this.removeEventListeners();

    this.isBusy = false;
    this.transmissionState = 'idle';

    this.setupEventListeners();

    // Follow VoiceChat so the button reflects reality rather than intent
    if (typeof VoiceChat !== 'undefined') {
      if (VoiceChat.onTransmissionStateChange) {
        VoiceChat.onTransmissionStateChange((state) => {
          this.transmissionState = state;
          this.updateVisualState();
        });
      }

      this.isAvailable = VoiceChat.getEnabled ? VoiceChat.getEnabled() : true;
      this.transmissionState = VoiceChat.state || 'idle';
    }

    this.updateVisualState();

    console.log('Microphone button initialized');
    return true;
  },

  /**
   * Set up event listeners
   */
  setupEventListeners() {
    const handlers = {
      click: (event) => {
        event.preventDefault();
        this.toggle();
      },

      // Long press on mobile would otherwise pop the context menu
      contextmenu: (event) => {
        event.preventDefault();
      }
    };

    this.button.addEventListener('click', handlers.click);
    this.button.addEventListener('contextmenu', handlers.contextmenu);

    this.handlers = handlers;
  },

  /**
   * Remove every listener registered by setupEventListeners
   */
  removeEventListeners() {
    if (!this.handlers || !this.button) {
      return;
    }

    Object.keys(this.handlers).forEach((eventName) => {
      this.button.removeEventListener(eventName, this.handlers[eventName]);
    });

    this.handlers = null;
  },

  /**
   * @returns {boolean} True when the microphone is open or opening
   */
  isLive() {
    return this.transmissionState !== 'idle';
  },

  /**
   * Open the microphone if it is closed, close it if it is open
   */
  toggle() {
    try {
      if (this.isDisabled || !this.isAvailable) {
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

      // Ignore taps that land while a previous one is still being acted on,
      // otherwise a double tap can leave the button and the microphone
      // disagreeing about who is live
      if (this.isBusy) {
        return;
      }

      if (this.isLive()) {
        this.close();
      } else {
        this.open();
      }
    } catch (error) {
      console.error('Error toggling microphone:', error);
      this.isBusy = false;
      this.updateVisualState();
    }
  },

  /**
   * Open the microphone
   */
  open() {
    if (VoiceChat.isAppInBackground && VoiceChat.isAppInBackground()) {
      console.log('Cannot open the microphone while the app is in the background');
      return;
    }

    console.log('Microphone turned on');

    this.isBusy = true;
    this.updateVisualState();

    Promise.resolve(VoiceChat.startTransmission())
      .catch((error) => {
        console.error('Failed to open the microphone:', error);
        this.handleTransmissionError(error);
      })
      .finally(() => {
        this.isBusy = false;
        this.updateVisualState();
      });
  },

  /**
   * Close the microphone
   */
  close() {
    console.log('Microphone turned off');

    this.isBusy = true;
    this.updateVisualState();

    Promise.resolve(VoiceChat.stopTransmission())
      .catch((error) => {
        console.error('Failed to close the microphone cleanly:', error);
      })
      .finally(() => {
        this.isBusy = false;
        this.updateVisualState();
      });
  },

  /**
   * Close the microphone without going through the toggle guards
   */
  forceClose() {
    if (typeof VoiceChat === 'undefined' || !this.isLive()) {
      return;
    }

    Promise.resolve(VoiceChat.stopTransmission()).catch((error) => {
      console.error('Failed to close the microphone:', error);
    });
  },

  /**
   * Handle errors raised while opening the microphone
   * @param {Error} error - The error that occurred
   */
  handleTransmissionError(error) {
    // VoiceChat already surfaces microphone problems with a help link, so only
    // report anything it did not recognise
    if (error && (error.errorType || error.name)) {
      return;
    }

    const message = 'Could not turn the microphone on';

    if (typeof UI !== 'undefined' && UI.showNotification) {
      UI.showNotification(message, 'error');
    } else {
      console.error(message, error);
    }
  },

  /**
   * Update the button to match the current state
   */
  updateVisualState() {
    if (!this.button) {
      return;
    }

    this.button.classList.remove('mic-off', 'mic-live', 'mic-connecting', 'mic-disabled');

    if (this.isDisabled || !this.isAvailable) {
      this.button.classList.add('mic-disabled');
      this.button.disabled = true;
      this.button.setAttribute('aria-disabled', 'true');
      this.button.setAttribute('aria-pressed', 'false');
      this.button.setAttribute('aria-label', 'Microphone unavailable');
      this.setLabel('Mic Off');
      return;
    }

    this.button.disabled = false;
    this.button.setAttribute('aria-disabled', 'false');

    if (this.transmissionState === 'transmitting') {
      this.button.classList.add('mic-live');
      this.button.setAttribute('aria-pressed', 'true');
      this.button.setAttribute('aria-label', 'Turn microphone off');
      this.setLabel('Live');
    } else if (this.transmissionState === 'starting' || this.isBusy) {
      this.button.classList.add('mic-connecting');
      this.button.setAttribute('aria-pressed', 'true');
      this.button.setAttribute('aria-label', 'Turning microphone on');
      this.setLabel('Starting');
    } else {
      this.button.classList.add('mic-off');
      this.button.setAttribute('aria-pressed', 'false');
      this.button.setAttribute('aria-label', 'Turn microphone on');
      this.setLabel('Mic Off');
    }
  },

  /**
   * @param {string} text
   */
  setLabel(text) {
    if (this.label && this.label.textContent !== text) {
      this.label.textContent = text;
    }
  },

  /**
   * Enable the button after a recoverable error
   */
  enable() {
    this.isDisabled = false;
    this.updateVisualState();
    console.log('Microphone button enabled');
  },

  /**
   * Hard-disable the button (no usable microphone)
   */
  disable() {
    this.forceClose();
    this.isDisabled = true;
    this.updateVisualState();
    console.log('Microphone button disabled');
  },

  /**
   * Reflect the voice chat on/off setting
   * @param {boolean} available
   */
  setAvailable(available) {
    if (!available) {
      this.forceClose();
    }

    this.isAvailable = !!available;
    this.updateVisualState();
  },

  /**
   * Show the button
   */
  show() {
    if (this.button) {
      this.button.style.display = 'flex';
    }
  },

  /**
   * Hide the button
   */
  hide() {
    if (this.button) {
      this.button.style.display = 'none';
    }
  },

  /**
   * Clean up event listeners and reset state
   */
  cleanup() {
    console.log('Cleaning up microphone button...');

    this.forceClose();
    this.removeEventListeners();

    this.isDisabled = false;
    this.isAvailable = true;
    this.isBusy = false;
    this.transmissionState = 'idle';

    console.log('Microphone button cleanup complete');
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MicButton;
}

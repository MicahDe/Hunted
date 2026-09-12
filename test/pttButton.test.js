/**
 * Tests for the push-to-talk button: press/release bookkeeping, the paths that
 * used to leave the microphone live (pointer taken away, window blurred, page
 * hidden), and keeping the visuals in step with the real transmission state.
 */

const test = require('node:test');
const assert = require('node:assert');

/**
 * Tiny stand-in for a DOM element with the bits the controller touches.
 */
class FakeElement {
  constructor(id) {
    this.id = id;
    this.listeners = {};
    this.classList = new FakeClassList();
    this.attributes = {};
    this.style = {};
    this.disabled = false;
    this.captured = null;
  }

  addEventListener(name, handler) {
    this.listeners[name] = this.listeners[name] || [];
    this.listeners[name].push(handler);
  }

  removeEventListener(name, handler) {
    if (!this.listeners[name]) {
      return;
    }
    this.listeners[name] = this.listeners[name].filter((entry) => entry !== handler);
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  setPointerCapture(pointerId) {
    this.captured = pointerId;
  }

  releasePointerCapture(pointerId) {
    if (this.captured === pointerId) {
      this.captured = null;
    }
  }

  hasPointerCapture(pointerId) {
    return this.captured === pointerId;
  }

  /**
   * Dispatch an event to every registered listener.
   * @param {string} name
   * @param {Object} event
   */
  fire(name, event = {}) {
    const base = { preventDefault: () => {}, stopPropagation: () => {} };
    (this.listeners[name] || []).forEach((handler) => handler({ ...base, ...event }));
  }

  countListeners(name) {
    return (this.listeners[name] || []).length;
  }
}

class FakeClassList {
  constructor() {
    this.classes = new Set();
  }

  add(...names) {
    names.forEach((name) => this.classes.add(name));
  }

  remove(...names) {
    names.forEach((name) => this.classes.delete(name));
  }

  contains(name) {
    return this.classes.has(name);
  }
}

/**
 * Install a fake DOM plus a VoiceChat stub, then load a fresh PTTButton.
 */
function setup({ enabled = true, inBackground = false, startRejects = null } = {}) {
  const button = new FakeElement('ptt-btn');
  const documentListeners = {};
  const windowListeners = {};

  global.window = {
    PointerEvent: function () {},
    addEventListener: (name, handler) => {
      windowListeners[name] = windowListeners[name] || [];
      windowListeners[name].push(handler);
    },
    removeEventListener: (name, handler) => {
      if (windowListeners[name]) {
        windowListeners[name] = windowListeners[name].filter((entry) => entry !== handler);
      }
    }
  };

  global.document = {
    hidden: false,
    getElementById: (id) => (id === 'ptt-btn' ? button : null),
    addEventListener: (name, handler) => {
      documentListeners[name] = documentListeners[name] || [];
      documentListeners[name].push(handler);
    },
    removeEventListener: (name, handler) => {
      if (documentListeners[name]) {
        documentListeners[name] = documentListeners[name].filter((entry) => entry !== handler);
      }
    }
  };

  const calls = { start: 0, stop: 0 };
  let stateListener = null;

  const VoiceChat = {
    isEnabled: enabled,
    getEnabled: () => enabled,
    isAppInBackground: () => inBackground,
    onTransmissionStateChange: (listener) => {
      stateListener = listener;
    },
    startTransmission: async () => {
      calls.start++;
      if (startRejects) {
        throw startRejects;
      }
      // The real one awaits the microphone before audio flows, so report the
      // transmitting state a tick later rather than synchronously
      await Promise.resolve();
      if (stateListener) {
        stateListener('transmitting');
      }
    },
    stopTransmission: async () => {
      calls.stop++;
      if (stateListener) {
        stateListener('idle');
      }
    }
  };

  global.VoiceChat = VoiceChat;

  delete require.cache[require.resolve('../public/js/pttButton')];
  const PTTButton = require('../public/js/pttButton');

  assert.strictEqual(PTTButton.init(), true);

  return {
    PTTButton,
    button,
    calls,
    fireWindow: (name, event = {}) => (windowListeners[name] || []).forEach((h) => h(event)),
    fireDocument: (name, event = {}) => (documentListeners[name] || []).forEach((h) => h(event)),
    setTransmissionState: (state) => stateListener && stateListener(state)
  };
}

/** Let the async start/stop promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('starts idle and enabled', () => {
  const { button } = setup();

  assert.strictEqual(button.classList.contains('ptt-idle'), true);
  assert.strictEqual(button.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(button.disabled, false);
});

test('a press starts transmission and a release stops it', async () => {
  const { button, calls, PTTButton } = setup();

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  assert.strictEqual(calls.start, 1);
  assert.strictEqual(PTTButton.isCurrentlyPressed(), true);
  assert.strictEqual(button.classList.contains('ptt-active'), true);
  assert.strictEqual(button.getAttribute('aria-pressed'), 'true');

  button.fire('pointerup', { pointerId: 1 });
  await settle();

  assert.strictEqual(calls.stop, 1);
  assert.strictEqual(PTTButton.isCurrentlyPressed(), false);
  assert.strictEqual(button.classList.contains('ptt-idle'), true);
});

test('the button shows a connecting state until audio is actually flowing', async () => {
  const { button } = setup();

  // Before the state listener reports 'transmitting'
  button.fire('pointerdown', { pointerId: 1, button: 0 });

  assert.strictEqual(button.classList.contains('ptt-connecting'), true);
  assert.strictEqual(button.classList.contains('ptt-active'), false);

  await settle();

  assert.strictEqual(button.classList.contains('ptt-active'), true);
});

test('the pointer is captured so a finger sliding off still ends the press', async () => {
  const { button, calls } = setup();

  button.fire('pointerdown', { pointerId: 7, button: 0 });
  await settle();

  assert.strictEqual(button.captured, 7, 'pointer should be captured');

  button.fire('pointerup', { pointerId: 7 });
  await settle();

  assert.strictEqual(calls.stop, 1);
  assert.strictEqual(button.captured, null, 'capture should be released');
});

test('a second finger cannot end the first press', async () => {
  const { button, calls, PTTButton } = setup();

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  button.fire('pointerdown', { pointerId: 2, button: 0 });
  button.fire('pointerup', { pointerId: 2 });
  await settle();

  assert.strictEqual(calls.start, 1);
  assert.strictEqual(calls.stop, 0);
  assert.strictEqual(PTTButton.isCurrentlyPressed(), true);

  button.fire('pointerup', { pointerId: 1 });
  await settle();

  assert.strictEqual(calls.stop, 1);
});

test('a cancelled gesture releases the microphone', async () => {
  const { button, calls, PTTButton } = setup();

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  // The browser interrupts the gesture (incoming call, system gesture)
  button.fire('pointercancel', { pointerId: 1 });
  await settle();

  assert.strictEqual(calls.stop, 1);
  assert.strictEqual(PTTButton.isCurrentlyPressed(), false);
});

test('losing pointer capture releases the microphone', async () => {
  const { button, calls } = setup();

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  button.fire('lostpointercapture', { pointerId: 1 });
  await settle();

  assert.strictEqual(calls.stop, 1);
});

test('the window losing focus releases the microphone', async () => {
  const { button, calls, fireWindow, PTTButton } = setup();

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  fireWindow('blur');
  await settle();

  assert.strictEqual(calls.stop, 1);
  assert.strictEqual(PTTButton.isCurrentlyPressed(), false);
});

test('the page being hidden releases the microphone', async () => {
  const { button, calls, fireDocument } = setup();

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  global.document.hidden = true;
  fireDocument('visibilitychange');
  await settle();

  assert.strictEqual(calls.stop, 1);

  global.document.hidden = false;
});

test('right-click does not transmit', async () => {
  const { button, calls } = setup();

  button.fire('pointerdown', { pointerId: 1, button: 2 });
  await settle();

  assert.strictEqual(calls.start, 0);
});

test('space and enter work as hold-to-talk', async () => {
  const { button, calls, PTTButton } = setup();

  button.fire('keydown', { key: ' ', code: 'Space', repeat: false });
  await settle();

  assert.strictEqual(calls.start, 1);

  // Key repeat must not restart the transmission
  button.fire('keydown', { key: ' ', code: 'Space', repeat: true });
  await settle();

  assert.strictEqual(calls.start, 1);

  button.fire('keyup', { key: ' ', code: 'Space' });
  await settle();

  assert.strictEqual(calls.stop, 1);
  assert.strictEqual(PTTButton.isCurrentlyPressed(), false);
});

test('unrelated keys are ignored', async () => {
  const { button, calls } = setup();

  button.fire('keydown', { key: 'a', code: 'KeyA' });
  button.fire('keyup', { key: 'a', code: 'KeyA' });
  await settle();

  assert.strictEqual(calls.start, 0);
  assert.strictEqual(calls.stop, 0);
});

test('transmission stopping on its own resets the button even while held', async () => {
  const { button, setTransmissionState, PTTButton } = setup();

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  assert.strictEqual(button.classList.contains('ptt-active'), true);

  // The 30 second hold limit fires while the finger is still down
  setTransmissionState('idle');

  assert.strictEqual(PTTButton.isCurrentlyPressed(), false);
  assert.strictEqual(button.classList.contains('ptt-idle'), true);
  assert.strictEqual(button.captured, null);
});

test('a failed start resets the button and clears the capture', async () => {
  const failure = new Error('no microphone');
  const { button, PTTButton } = setup({ startRejects: failure });

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  assert.strictEqual(PTTButton.isCurrentlyPressed(), false);
  assert.strictEqual(button.classList.contains('ptt-idle'), true);
  assert.strictEqual(button.captured, null);
});

test('a late failure from an old press does not cancel the current one', async () => {
  const { button, PTTButton } = setup();

  // Make the next start fail slowly, the one after that succeed
  let failSlowly;
  let calls = 0;
  VoiceChat.startTransmission = async () => {
    calls++;
    if (calls === 1) {
      await new Promise((resolve) => {
        failSlowly = resolve;
      });
      throw new Error('microphone gave up');
    }
  };

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  button.fire('pointerup', { pointerId: 1 });
  await settle();

  // Second press, which the user is still holding
  button.fire('pointerdown', { pointerId: 2, button: 0 });
  await settle();

  assert.strictEqual(PTTButton.isCurrentlyPressed(), true);

  // Now the first press finally reports its failure
  failSlowly();
  await settle();
  await settle();

  assert.strictEqual(PTTButton.isCurrentlyPressed(), true, 'the held press must survive');
});

test('a disabled button does not transmit', async () => {
  const { button, calls, PTTButton } = setup();

  PTTButton.disable();

  assert.strictEqual(button.classList.contains('ptt-disabled'), true);
  assert.strictEqual(button.disabled, true);
  assert.strictEqual(button.getAttribute('aria-disabled'), 'true');

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  assert.strictEqual(calls.start, 0);

  PTTButton.enable();
  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  assert.strictEqual(calls.start, 1);
});

test('switching voice chat off soft-disables the button', async () => {
  const { button, calls, PTTButton } = setup();

  PTTButton.setAvailable(false);

  assert.strictEqual(button.classList.contains('ptt-disabled'), true);

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  assert.strictEqual(calls.start, 0);

  PTTButton.setAvailable(true);

  assert.strictEqual(button.classList.contains('ptt-idle'), true);
});

test('switching voice chat off while held releases the microphone', async () => {
  const { button, calls, PTTButton } = setup();

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  PTTButton.setAvailable(false);
  await settle();

  assert.strictEqual(calls.stop, 1);
  assert.strictEqual(PTTButton.isCurrentlyPressed(), false);
});

test('the button refuses to transmit while the app is backgrounded', async () => {
  const { button, calls } = setup({ inBackground: true });

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  assert.strictEqual(calls.start, 0);
});

test('re-initialising does not stack duplicate listeners', () => {
  const { button, PTTButton } = setup();

  const before = button.countListeners('pointerdown');

  PTTButton.init();

  assert.strictEqual(button.countListeners('pointerdown'), before, 'listeners must not accumulate');
});

test('cleanup releases a held button and removes listeners', async () => {
  const { button, calls, PTTButton } = setup();

  button.fire('pointerdown', { pointerId: 1, button: 0 });
  await settle();

  PTTButton.cleanup();
  await settle();

  assert.strictEqual(calls.stop, 1);
  assert.strictEqual(button.countListeners('pointerdown'), 0);
  assert.strictEqual(PTTButton.isCurrentlyPressed(), false);
});

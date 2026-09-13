/**
 * Tests for the microphone toggle button.
 *
 * The control it replaced was hold-to-talk, which dropped the transmission if
 * the user's thumb drifted while pressing. These tests pin down that a tap
 * toggles, that the button always reflects the real transmission state, and
 * that the microphone starts and ends up closed.
 */

const test = require('node:test');
const assert = require('node:assert');

/**
 * Tiny stand-in for a DOM element with the bits the controller touches.
 */
class FakeElement {
  constructor(id, className = '') {
    this.id = id;
    this.listeners = {};
    this.classList = new FakeClassList(className);
    this.attributes = {};
    this.style = {};
    this.disabled = false;
    this.textContent = '';
    this.children = [];
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

  querySelector(selector) {
    const wanted = selector.replace('.', '');
    return this.children.find((child) => child.classList.contains(wanted)) || null;
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
  constructor(initial = '') {
    this.classes = new Set(initial.split(' ').filter(Boolean));
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
 * Install a fake DOM plus a VoiceChat stub, then load a fresh MicButton.
 */
function setup({ enabled = true, inBackground = false, startRejects = null, startDelayed = false } = {}) {
  const button = new FakeElement('mic-btn');
  const label = new FakeElement('', 'mic-label');
  button.children.push(label);

  global.window = { addEventListener: () => {}, removeEventListener: () => {} };
  global.document = {
    hidden: false,
    getElementById: (id) => (id === 'mic-btn' ? button : null),
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const calls = { start: 0, stop: 0 };
  let stateListener = null;
  let releaseStart = null;

  const VoiceChat = {
    state: 'idle',
    isEnabled: enabled,
    getEnabled: () => enabled,
    isAppInBackground: () => inBackground,
    onTransmissionStateChange: (listener) => {
      stateListener = listener;
    },
    setState(state) {
      this.state = state;
      if (stateListener) {
        stateListener(state);
      }
    },
    startTransmission: async () => {
      calls.start++;
      VoiceChat.setState('starting');

      if (startDelayed) {
        await new Promise((resolve) => {
          releaseStart = resolve;
        });
      } else {
        await Promise.resolve();
      }

      if (startRejects) {
        VoiceChat.setState('idle');
        throw startRejects;
      }

      VoiceChat.setState('transmitting');
    },
    stopTransmission: async () => {
      calls.stop++;
      await Promise.resolve();
      VoiceChat.setState('idle');
    }
  };

  global.VoiceChat = VoiceChat;

  delete require.cache[require.resolve('../public/js/micButton')];
  const MicButton = require('../public/js/micButton');

  assert.strictEqual(MicButton.init(), true);

  return {
    MicButton,
    VoiceChat,
    button,
    label,
    calls,
    finishStart: () => releaseStart && releaseStart()
  };
}

/** Let the async start/stop promises settle. */
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test('the microphone starts off', () => {
  const { button, label, MicButton } = setup();

  assert.strictEqual(button.classList.contains('mic-off'), true);
  assert.strictEqual(button.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(button.getAttribute('aria-label'), 'Turn microphone on');
  assert.strictEqual(label.textContent, 'Mic Off');
  assert.strictEqual(MicButton.isLive(), false);
});

test('a tap turns the microphone on, and another turns it off', async () => {
  const { button, label, calls, MicButton } = setup();

  button.fire('click');
  await settle();

  assert.strictEqual(calls.start, 1);
  assert.strictEqual(MicButton.isLive(), true);
  assert.strictEqual(button.classList.contains('mic-live'), true);
  assert.strictEqual(button.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(button.getAttribute('aria-label'), 'Turn microphone off');
  assert.strictEqual(label.textContent, 'Live');

  button.fire('click');
  await settle();

  assert.strictEqual(calls.stop, 1);
  assert.strictEqual(calls.start, 1, 'the second tap must not start another transmission');
  assert.strictEqual(MicButton.isLive(), false);
  assert.strictEqual(button.classList.contains('mic-off'), true);
  assert.strictEqual(label.textContent, 'Mic Off');
});

test('the microphone stays on across many taps of other things', async () => {
  const { button, calls } = setup();

  button.fire('click');
  await settle();

  // Nothing else should be able to close it
  button.fire('contextmenu');
  await settle();

  assert.strictEqual(calls.stop, 0);
  assert.strictEqual(button.classList.contains('mic-live'), true);
});

test('the button shows a connecting state until the microphone is really open', async () => {
  const { button, label, finishStart } = setup({ startDelayed: true });

  button.fire('click');
  await settle();

  assert.strictEqual(button.classList.contains('mic-connecting'), true);
  assert.strictEqual(button.classList.contains('mic-live'), false);
  assert.strictEqual(label.textContent, 'Starting');

  finishStart();
  await settle();

  assert.strictEqual(button.classList.contains('mic-live'), true);
  assert.strictEqual(label.textContent, 'Live');
});

test('a second tap while still opening is ignored', async () => {
  const { button, calls, finishStart } = setup({ startDelayed: true });

  button.fire('click');
  await settle();

  button.fire('click');
  button.fire('click');
  await settle();

  assert.strictEqual(calls.start, 1);
  assert.strictEqual(calls.stop, 0, 'an impatient double tap must not close it again');

  finishStart();
  await settle();

  assert.strictEqual(button.classList.contains('mic-live'), true);
});

test('transmission stopping on its own resets the button', async () => {
  const { button, label, VoiceChat, MicButton } = setup();

  button.fire('click');
  await settle();

  assert.strictEqual(button.classList.contains('mic-live'), true);

  // Something else closed the microphone: a device error, or backgrounding
  VoiceChat.setState('idle');

  assert.strictEqual(MicButton.isLive(), false);
  assert.strictEqual(button.classList.contains('mic-off'), true);
  assert.strictEqual(label.textContent, 'Mic Off');
});

test('a failed start leaves the button off', async () => {
  const failure = new Error('no microphone');
  const { button, label, MicButton } = setup({ startRejects: failure });

  button.fire('click');
  await settle();

  assert.strictEqual(MicButton.isLive(), false);
  assert.strictEqual(button.classList.contains('mic-off'), true);
  assert.strictEqual(label.textContent, 'Mic Off');
});

test('the microphone cannot be opened while the app is in the background', async () => {
  const { button, calls } = setup({ inBackground: true });

  button.fire('click');
  await settle();

  assert.strictEqual(calls.start, 0);
  assert.strictEqual(button.classList.contains('mic-off'), true);
});

test('a disabled button does nothing, and works again once enabled', async () => {
  const { button, calls, MicButton } = setup();

  MicButton.disable();

  assert.strictEqual(button.classList.contains('mic-disabled'), true);
  assert.strictEqual(button.disabled, true);
  assert.strictEqual(button.getAttribute('aria-disabled'), 'true');

  button.fire('click');
  await settle();

  assert.strictEqual(calls.start, 0);

  MicButton.enable();
  button.fire('click');
  await settle();

  assert.strictEqual(calls.start, 1);
});

test('disabling while live closes the microphone', async () => {
  const { button, calls, MicButton } = setup();

  button.fire('click');
  await settle();

  MicButton.disable();
  await settle();

  assert.strictEqual(calls.stop, 1);
  assert.strictEqual(MicButton.isLive(), false);
});

test('switching voice chat off soft-disables the button and closes the microphone', async () => {
  const { button, calls, MicButton } = setup();

  button.fire('click');
  await settle();

  MicButton.setAvailable(false);
  await settle();

  assert.strictEqual(calls.stop, 1);
  assert.strictEqual(button.classList.contains('mic-disabled'), true);

  button.fire('click');
  await settle();

  assert.strictEqual(calls.start, 1, 'no new transmission while voice chat is off');

  MicButton.setAvailable(true);

  assert.strictEqual(button.classList.contains('mic-off'), true);

  button.fire('click');
  await settle();

  assert.strictEqual(calls.start, 2, 'the button must work again after being re-enabled');
});

test('re-initialising does not stack duplicate listeners', () => {
  const { button, MicButton } = setup();

  const before = button.countListeners('click');

  MicButton.init();

  assert.strictEqual(button.countListeners('click'), before);
});

test('re-initialising adopts the transmission state already in progress', () => {
  const { VoiceChat, button, MicButton } = setup();

  VoiceChat.state = 'transmitting';
  MicButton.init();

  assert.strictEqual(MicButton.isLive(), true);
  assert.strictEqual(button.classList.contains('mic-live'), true);
});

test('cleanup closes the microphone and removes listeners', async () => {
  const { button, calls, MicButton } = setup();

  button.fire('click');
  await settle();

  MicButton.cleanup();
  await settle();

  assert.strictEqual(calls.stop, 1);
  assert.strictEqual(button.countListeners('click'), 0);
  assert.strictEqual(MicButton.isLive(), false);
});
